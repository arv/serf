import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { lathe } from './models';
import { factionTint } from './factionPalette';

/**
 * Skinned-character pipeline: KayKit Adventurers 2.0 characters animated by
 * the KayKit Character Animations library (both CC0, both on the same
 * Rig_Medium skeleton, so library clips drive every character directly).
 * Weapons are pack props dropped into the rig's handslot bones. When the
 * assets can't load, callers fall back to the procedural people in
 * models.ts.
 */

export type AnimKey =
  | 'idle'
  | 'walk'
  | 'jog'
  | 'attack'
  | 'shoot'
  | 'work'
  | 'pickaxe'
  | 'hammer'
  | 'dig'
  | 'tend'
  | 'draw'
  | 'carry'
  | 'carryIdle'
  | 'death';

const KK_DIR = '/models/kaykit/';
const KK_CHARACTER_FILES = ['Knight', 'Barbarian', 'Rogue', 'Rogue_Hooded', 'Mage', 'Ranger'];
const KK_ANIMATION_FILES = ['MovementBasic', 'General', 'CombatMelee', 'CombatRanged', 'Tools'];
const KK_PROP_FILES = [
  'sword_1handed',
  'shield_badge',
  'axe_1handed',
  'axe_2handed',
  'staff',
  'bow_withString',
  'dagger',
  'quiver',
];

const KK_CLIP_NAMES: Record<AnimKey, string> = {
  idle: 'Idle_A',
  walk: 'Walking_A',
  jog: 'Running_A',
  attack: 'Melee_1H_Attack_Chop',
  shoot: 'Ranged_Bow_Draw',
  // Real tool loops per work site.
  work: 'Chopping',
  pickaxe: 'Pickaxing',
  hammer: 'Hammering',
  dig: 'Digging',
  tend: 'Working_A',
  // Hand-over-hand reeling doubles as cranking the well bucket up.
  draw: 'Fishing_Reeling',
  // Composited at load: gait legs + holding-pose arms.
  carry: 'Carry_Walk',
  carryIdle: 'Carry_Idle',
  death: 'Death_A',
};

interface KKSpec {
  file: string;
  /** Mesh names to hide (capes, hats) so kinds read apart. */
  hide?: string[];
  right?: string;
  /** Euler fix-up for right-hand props that load facing the wrong way. */
  rightRot?: [number, number, number];
  left?: string;
  /** Prop strapped to the chest (quivers). */
  back?: string;
  /** Multiplies the texture — bandits go grim. */
  tint?: number;
  scale?: number;
  jog?: boolean;
  ranged?: boolean;
  attackClip?: string;
}

const KK_SPECS = new Map<number, KKSpec>([
  [1, { file: 'Rogue', hide: ['Rogue_Cape'] }],
  [2, {
    file: 'Barbarian',
    hide: ['Barbarian_BearHat'],
    right: 'axe_1handed',
    // The axe loads blade-backwards in the grip; spin it to face the swing.
    rightRot: [0, Math.PI, 0],
  }],
  [3, { file: 'Knight', right: 'sword_1handed', left: 'shield_badge', jog: true }],
  [4, {
    file: 'Knight',
    hide: ['Knight_Cape', 'Knight_HelmetVisor'],
    right: 'staff',
    jog: true,
    attackClip: 'Melee_1H_Attack_Stab',
  }],
  [5, { file: 'Ranger', right: 'bow_withString', jog: true, ranged: true }],
  [6, { file: 'Rogue', tint: 0x7c8290, right: 'dagger', jog: true }],
  [7, {
    file: 'Rogue_Hooded',
    tint: 0x7c8290,
    right: 'bow_withString',
    back: 'quiver',
    jog: true,
    ranged: true,
  }],
  [8, {
    file: 'Barbarian',
    tint: 0x94848c,
    right: 'axe_2handed',
    scale: 1.18,
    jog: true,
    attackClip: 'Melee_2H_Attack_Chop',
  }],
]);

interface KKCharacter {
  scene: THREE.Group;
  scale: number;
  footY: number;
}

interface KKAssets {
  chars: Map<string, KKCharacter>;
  clips: Map<string, THREE.AnimationClip>;
  props: Map<string, THREE.Group>;
}

let kkAssets: KKAssets | null = null;

/** World-space height of a villager; matches the procedural people. */
// Oversized on purpose — RTS readability: Warcraft-style units read at
// village zoom, true-scale people vanish.
const TARGET_HEIGHT = 1.22;

export interface CharacterVisual {
  mixer: THREE.AnimationMixer;
  actions: Map<AnimKey, THREE.AnimationAction>;
  current: AnimKey | null;
  jog: boolean;
  ranged: boolean;
  /** World-unit holder on the chest bone: carried goods parented here ride
   * the walk animation (bob, sway) instead of floating rigidly. */
  carryAnchor?: THREE.Group;
  /** World-unit holder in the right hand for swappable work tools. */
  toolAnchor?: THREE.Group;
  /** Sub-group of toolAnchor holding the currently swapped-in work tool. */
  toolCustom?: THREE.Group;
  /** The wardrobe's own hand prop (axe, sword, the farmer's spade...),
   * hidden while a work tool is swapped in. */
  defaultTool?: THREE.Object3D;
  /** WORK.* currently equipped via setWorkTool (0 = the default prop). */
  toolKind: number;
}

// --- Rigid props, sized in world units and counter-scaled onto bones -------

function peasantHat(): THREE.Group {
  const g = new THREE.Group();
  // Round-brimmed straw peasant hat.
  const hat = lathe(
    [
      [0.16, 0.0],
      [0.15, 0.025],
      [0.09, 0.035],
      [0.075, 0.09],
      [0.0, 0.105],
    ],
    0x9a7748,
    12,
  );
  g.add(hat);
  return g;
}

/** Matte, shadow-casting setup shared by every loaded KayKit scene. */
function prepKayKitScene(scene: THREE.Group): void {
  scene.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.SkinnedMesh) {
      o.castShadow = true;
      const m = o.material as THREE.MeshStandardMaterial;
      if (m?.isMeshStandardMaterial) {
        m.roughness = 0.95;
        m.metalness = 0;
      }
    }
  });
}

async function loadKayKitCharacters(): Promise<boolean> {
  try {
    const loader = new GLTFLoader();
    const chars = new Map<string, KKCharacter>();
    const clips = new Map<string, THREE.AnimationClip>();
    const props = new Map<string, THREE.Group>();
    await Promise.all([
      ...KK_CHARACTER_FILES.map(async (f) => {
        const gltf = await loader.loadAsync(`${KK_DIR}${f}.glb`);
        prepKayKitScene(gltf.scene);
        const bbox = new THREE.Box3().setFromObject(gltf.scene);
        const height = bbox.max.y - bbox.min.y;
        chars.set(f, {
          scene: gltf.scene,
          scale: TARGET_HEIGHT / height,
          footY: -bbox.min.y,
        });
      }),
      ...KK_ANIMATION_FILES.map(async (f) => {
        const gltf = await loader.loadAsync(`${KK_DIR}Rig_Medium_${f}.glb`);
        for (const clip of gltf.animations) clips.set(clip.name, clip);
      }),
      ...KK_PROP_FILES.map(async (f) => {
        const gltf = await loader.loadAsync(`${KK_DIR}${f}.gltf`);
        prepKayKitScene(gltf.scene);
        props.set(f, gltf.scene);
      }),
    ]);
    // The pack has no carry-walk, so composite one: legs and hips from the
    // gait, arms frozen in the two-handed holding pose — carriers actually
    // hold their load instead of pumping their arms through it.
    const ARM_BONES = /upperarm|lowerarm|wrist|hand|handslot/;
    const composite = (
      baseName: string,
      holdName: string,
      name: string,
    ): THREE.AnimationClip | null => {
      const base = clips.get(baseName);
      const hold = clips.get(holdName);
      if (!base || !hold) return null;
      const legTracks = base.tracks.filter((t) => !ARM_BONES.test(t.name));
      const armTracks = hold.tracks
        .filter((t) => ARM_BONES.test(t.name))
        .map((t) => {
          // A single static key: the pose's first frame, held.
          const size = t.getValueSize();
          const Track = t.constructor as new (
            name: string,
            times: number[],
            values: ArrayLike<number>,
          ) => THREE.KeyframeTrack;
          return new Track(t.name, [0], t.values.slice(0, size));
        });
      const clip = new THREE.AnimationClip(name, base.duration, [...legTracks, ...armTracks]);
      clips.set(name, clip);
      return clip;
    };
    composite('Walking_A', 'Holding_B', 'Carry_Walk');
    composite('Idle_A', 'Holding_B', 'Carry_Idle');

    kkAssets = { chars, clips, props };
    return true;
  } catch (err) {
    console.warn('[characters] KayKit assets failed; procedural people:', err);
    return false;
  }
}

const kkTintMaterials = new Map<string, THREE.MeshStandardMaterial>();

// --- Swappable work tools (the free packs ship no hammer/pickaxe) --------
// Authored in world units: grip at the origin, handle up +Y, head at the
// top — the same frame the pack's axe sits in after its fix-up.

const toolMesh = (geo: THREE.BufferGeometry, color: number): THREE.Mesh => {
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
  m.castShadow = true;
  return m;
};

function malletProp(): THREE.Group {
  const g = new THREE.Group();
  const handle = toolMesh(new THREE.CylinderGeometry(0.016, 0.02, 0.3, 6), 0x8a6a42);
  handle.position.y = 0.12;
  const head = toolMesh(new THREE.CylinderGeometry(0.05, 0.05, 0.13, 8), 0x6b4e2e);
  head.rotation.z = Math.PI / 2;
  head.position.y = 0.27;
  g.add(handle, head);
  return g;
}

function pickaxeProp(): THREE.Group {
  const g = new THREE.Group();
  const handle = toolMesh(new THREE.CylinderGeometry(0.016, 0.02, 0.34, 6), 0x8a6a42);
  handle.position.y = 0.14;
  g.add(handle);
  for (const side of [-1, 1]) {
    const spike = toolMesh(new THREE.ConeGeometry(0.028, 0.17, 6), 0x77848e);
    // Head spikes run across the swing plane, tips drooping slightly.
    spike.rotation.z = -side * (Math.PI / 2 + 0.22);
    spike.position.set(side * 0.08, 0.3, 0);
    g.add(spike);
  }
  return g;
}

function spadeProp(): THREE.Group {
  const g = new THREE.Group();
  const handle = toolMesh(new THREE.CylinderGeometry(0.014, 0.016, 0.34, 6), 0x8a6a42);
  handle.position.y = 0.14;
  const blade = toolMesh(new THREE.BoxGeometry(0.09, 0.12, 0.015), 0x8b95a0);
  blade.position.y = 0.34;
  g.add(handle, blade);
  return g;
}

const WORK_TOOLS: Record<number, () => THREE.Group> = {
  3: malletProp, // WORK.hammer
  2: pickaxeProp, // WORK.pickaxe
  4: spadeProp, // WORK.dig
  6: () => new THREE.Group(), // WORK.draw — bare hands on the well crank
};

/**
 * Equip the right tool for a work animation: mallet for building and
 * smithing, pickaxe at the rock faces, spade in the fields. Kind 0 (or an
 * unmapped kind) restores the wardrobe's own prop. No-op for characters
 * without a tool anchor (the procedural fallback).
 */
export function setWorkTool(visual: CharacterVisual, workKind: number): void {
  if (!visual.toolCustom || visual.toolKind === workKind) return;
  visual.toolKind = workKind;
  visual.toolCustom.clear();
  const make = WORK_TOOLS[workKind];
  // A default tool that already matches the work keeps its place (the
  // farmer digs with the spade he carries).
  const covered = make && visual.defaultTool?.userData.workKind === workKind;
  if (make && !covered) {
    visual.toolCustom.add(make());
    if (visual.defaultTool) visual.defaultTool.visible = false;
  } else if (visual.defaultTool) {
    visual.defaultTool.visible = true;
  }
}

/** Workplace looks layered over the worker kind (profession byte). */
interface ProfLook {
  spec: KKSpec;
  /** Permanent carried tool + the WORK.* it already covers. */
  tool?: () => THREE.Group;
  toolWorkKind?: number;
  strawHat?: boolean;
}

const PROF_LOOKS = new Map<number, ProfLook>([
  // Farmer: sun-worn tan leathers, straw hat, spade in hand.
  [
    1,
    {
      spec: { file: 'Rogue', hide: ['Rogue_Cape'], tint: 0xc9a86a },
      tool: spadeProp,
      toolWorkKind: 4, // WORK.dig
      strawHat: true,
    },
  ],
  // Miner: dust-grey barbarian with his pickaxe over the shoulder.
  [
    2,
    {
      spec: { file: 'Barbarian', hide: ['Barbarian_BearHat'], tint: 0x9b9084 },
      tool: pickaxeProp,
      toolWorkKind: 2, // WORK.pickaxe
    },
  ],
]);

function makeKayKitCharacter(
  kindCode: number,
  profession = 0,
  owner = 0,
): { group: THREE.Group; visual: CharacterVisual } | null {
  if (!kkAssets) return null;
  const look = kindCode === 2 ? PROF_LOOKS.get(profession) : undefined;
  const spec = look?.spec ?? KK_SPECS.get(kindCode) ?? KK_SPECS.get(1)!;
  const char = kkAssets.chars.get(spec.file);
  if (!char) return null;
  const root = skeletonClone(char.scene);

  // Faction cloth: lerp the kit toward the seat's color, the same four the
  // buildings' team-color slot uses, so a rival's serfs and their mill
  // read as one side. Bandits keep their grim stock look.
  const faction = factionTint(owner);
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) && !(o instanceof THREE.SkinnedMesh)) return;
    if (spec.hide?.includes(o.name)) o.visible = false;
    if (spec.tint !== undefined || faction !== undefined) {
      const m = o.material as THREE.MeshStandardMaterial;
      const key = `${spec.file}:${o.name}:${spec.tint ?? 'x'}:${faction ?? 'x'}`;
      let tinted = kkTintMaterials.get(key);
      if (!tinted) {
        tinted = m.clone();
        if (spec.tint !== undefined) tinted.color.set(spec.tint);
        if (faction !== undefined) tinted.color.lerp(new THREE.Color(faction), 0.55);
        kkTintMaterials.set(key, tinted);
      }
      o.material = tinted;
    }
  });

  // Pack props are authored for the rig's handslot bones — identity drop-in.
  const slot = (
    bone: string,
    file: string | undefined,
    offset?: [number, number, number],
    rot?: [number, number, number],
  ) => {
    if (!file) return;
    const prop = kkAssets!.props.get(file);
    // GLTFLoader sanitizes node names ('handslot.r' loads as 'handslotr'),
    // so look up both spellings.
    const anchor =
      root.getObjectByName(bone) ?? root.getObjectByName(bone.replace(/[^\w-]/g, ''));
    if (!prop || !anchor) {
      console.warn(`[characters] slot miss: prop=${file}:${!!prop} bone=${bone}:${!!anchor}`);
      return;
    }
    const inst = prop.clone();
    if (offset) inst.position.set(...offset);
    if (rot) inst.rotation.set(...rot);
    anchor.add(inst);
    return { inst, anchor };
  };
  const rightHand = slot('handslot.r', spec.right, undefined, spec.rightRot);
  slot('handslot.l', spec.left);
  slot('chest', spec.back, [0, 0, -0.14]);

  const s = char.scale * (spec.scale ?? 1);

  // Carried goods anchor: on the chest bone (so loads bob and sway with
  // the gait), counter-scaled back to world units, held out in front at
  // arms' reach — same bone-space frame the quiver back-attach uses.
  let carryAnchor: THREE.Group | undefined;
  const chest = root.getObjectByName('chest');
  if (chest) {
    carryAnchor = new THREE.Group();
    carryAnchor.scale.setScalar(1 / s);
    carryAnchor.position.set(0, 0.02, 0.22);
    chest.add(carryAnchor);
  }

  // Work-tool anchor in the right hand, counter-scaled to world units so
  // the procedural mallet/pickaxe/spade drop in at their authored size.
  let toolAnchor: THREE.Group | undefined;
  let toolCustom: THREE.Group | undefined;
  let proceduralTool: THREE.Object3D | undefined;
  const hand =
    root.getObjectByName('handslot.r') ?? root.getObjectByName('handslotr');
  if (hand) {
    toolAnchor = new THREE.Group();
    toolAnchor.scale.setScalar(1 / s);
    hand.add(toolAnchor);
    toolCustom = new THREE.Group();
    toolAnchor.add(toolCustom);
    if (look?.tool) {
      // The profession's own tool: carried everywhere, worked with on site.
      proceduralTool = look.tool();
      proceduralTool.userData.workKind = look.toolWorkKind ?? 0;
      toolAnchor.add(proceduralTool);
    }
  }

  if (look?.strawHat) {
    // Straw hat on the head bone, counter-scaled and sized for the big
    // KayKit skull.
    const head = root.getObjectByName('head');
    if (head) {
      const holder = new THREE.Group();
      holder.scale.setScalar(1 / s);
      const hat = peasantHat();
      hat.scale.setScalar(1.9);
      hat.position.y = 0.12;
      holder.add(hat);
      head.add(holder);
    }
  }

  const inner = new THREE.Group();
  inner.position.y = char.footY * s;
  inner.scale.setScalar(s);
  inner.add(root);
  const group = new THREE.Group();
  group.add(inner);

  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<AnimKey, THREE.AnimationAction>();
  for (const key of Object.keys(KK_CLIP_NAMES) as AnimKey[]) {
    const name = key === 'attack' && spec.attackClip ? spec.attackClip : KK_CLIP_NAMES[key];
    const clip = kkAssets.clips.get(name);
    if (!clip) continue;
    const action = mixer.clipAction(clip);
    if (key === 'death') {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true; // hold the final crumpled pose
    }
    actions.set(key, action);
  }

  return {
    group,
    visual: {
      mixer,
      actions,
      current: null,
      jog: spec.jog ?? false,
      ranged: spec.ranged ?? false,
      carryAnchor,
      toolAnchor,
      toolCustom,
      defaultTool: proceduralTool ?? rightHand?.inst,
      toolKind: 0,
    },
  };
}

/**
 * Load the character + animation library once. Resolves false (and the
 * renderer falls back to procedural people) if the assets can't load.
 */
export async function loadCharacterAssets(): Promise<boolean> {
  return loadKayKitCharacters();
}

export function charactersReady(): boolean {
  return kkAssets !== null;
}

/**
 * A dressed, animated character for one unit. Returns null until assets
 * are loaded (callers fall back to the procedural person).
 */
export function makeCharacter(
  kindCode: number,
  profession = 0,
  owner = 0,
): { group: THREE.Group; visual: CharacterVisual } | null {
  return makeKayKitCharacter(kindCode, profession, owner);
}

/** Crossfade to the clip for this key; no-op when already playing it. */
export function playAnimation(visual: CharacterVisual, key: AnimKey, offset: number): void {
  if (visual.current === key) return;
  const next = visual.actions.get(key) ?? visual.actions.get('idle');
  if (!next) return;
  const prev = visual.current ? visual.actions.get(visual.current) : undefined;
  next.reset();
  // Desync the crowd: start loops at a per-unit offset.
  next.time = offset * next.getClip().duration;
  next.play();
  if (prev && prev !== next) prev.crossFadeTo(next, 0.16, false);
  visual.current = key;
}
