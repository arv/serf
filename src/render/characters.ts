import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import {
  bowInHand,
  crudeBlade,
  hatchet,
  katanaBlade,
  lathe,
  mesh,
  quiver,
  yariSpear,
} from './models';
import { palette } from './palette';
import { THEME } from './medieval';

/**
 * Skinned-character pipeline: Quaternius Universal Base Characters (CC0)
 * animated by the Universal Animation Library (CC0). The base body is a
 * mannequin, so each unit kind is dressed at clone time with "clothing
 * shells" — copies of the body's skinned mesh filtered to the triangles
 * whose skin weights belong to torso/arm/thigh bones, inflated slightly
 * along their normals, and tinted per kind. The shells share the skeleton,
 * so the kimono deforms perfectly with every animation. Hats, weapons and
 * armor are rigid props parented to bones.
 */

// The ?v= busts stale HTTP caches when the assets are re-processed.
const CHARACTER_URL = '/models/character/Superhero_Male_FullBody.gltf?v=2';
const ANIMATIONS_URL = '/models/UAL1_Standard.glb?v=2';

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

const CLIP_NAMES: Record<AnimKey, string> = {
  idle: 'Idle_Loop',
  walk: 'Walk_Loop',
  jog: 'Jog_Fwd_Loop',
  attack: 'Sword_Attack',
  shoot: 'Spell_Simple_Shoot',
  // The UAL has no tool clips — the sword swing stands in for all work.
  work: 'Sword_Attack',
  pickaxe: 'Sword_Attack',
  hammer: 'Sword_Attack',
  dig: 'Sword_Attack',
  tend: 'Sword_Attack',
  draw: 'Sword_Attack',
  carry: 'Walk_Loop',
  carryIdle: 'Idle_Loop',
  death: 'Death01', // absent from the UAL: the renderer tips the body instead
};

// --- KayKit path (medieval theme) ------------------------------------------
// Adventurers 2.0 characters + Character Animations 1.1 (both CC0, both on
// the same Rig_Medium skeleton, so library clips drive every character
// directly). Weapons are pack props dropped into the rig's handslot bones.

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

/** Bones whose triangles make up the kimono shell (knee-length, sleeved). */
const ROBE_BONES = new Set([
  'pelvis',
  'spine_01',
  'spine_02',
  'spine_03',
  'clavicle_l',
  'clavicle_r',
  'upperarm_l',
  'upperarm_r',
  'thigh_l',
  'thigh_r',
]);
/** Bones for the obi sash band around the waist. */
const SASH_BONES = new Set(['pelvis']);

interface Wardrobe {
  robe: number;
  sash: number;
  kasa?: boolean;
  headband?: number;
  topknot?: boolean;
  armored?: boolean;
  scale?: number;
  tool?: (hand: THREE.Group) => void;
  back?: (torso: THREE.Group) => void;
  /** Soldiers jog; villagers walk. */
  jog?: boolean;
  /** Ranged units loose arrows instead of swinging. */
  ranged?: boolean;
}

const WARDROBES = new Map<number, Wardrobe>([
  [1, { robe: 0xe6d9b5, sash: 0xc86428 }],
  [2, { robe: 0xd8a868, sash: 0x6b8f3f, kasa: true, tool: hatchet }],
  [3, {
    robe: 0x6e88d0,
    sash: 0x2c3550,
    armored: true,
    topknot: true,
    jog: true,
    tool: (h) => katanaBlade(h),
  }],
  [4, { robe: 0xefe3cc, sash: 0x4a5f8e, headband: 0x4a5f8e, jog: true, tool: yariSpear }],
  [5, {
    robe: 0x7fae4a,
    sash: 0x3d5427,
    kasa: true,
    jog: true,
    ranged: true,
    tool: bowInHand(0xb8985a),
    back: quiver,
  }],
  [6, { robe: 0x5d636e, sash: 0x3a3f47, headband: 0xd85a4a, jog: true, tool: crudeBlade }],
  [7, {
    robe: 0x5d636e,
    sash: 0x3a3f47,
    headband: 0xd85a4a,
    jog: true,
    ranged: true,
    tool: bowInHand(palette.wood),
    back: quiver,
  }],
  [8, {
    robe: 0x4a5364,
    sash: 0x2a2f38,
    armored: true,
    topknot: true,
    jog: true,
    scale: 1.15,
    tool: (h) => katanaBlade(h, true),
  }],
]);

/** World-space height of a villager; matches the old procedural people. */
// Oversized on purpose — RTS readability: Warcraft-style units read at
// village zoom, true-scale people vanish.
const TARGET_HEIGHT = 1.22;

interface CharacterAssets {
  /** Dressed template scene per unit kind, cloned per unit. */
  base: THREE.Group;
  clips: Map<AnimKey, THREE.AnimationClip>;
  /** Uniform scale applied to the wrapper to hit TARGET_HEIGHT. */
  scale: number;
  /** Vertical offset that puts the feet at y=0 (in model units). */
  footY: number;
}

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

let assets: CharacterAssets | null = null;

/** Dominant-bone name per vertex, from the 4-influence skin attributes. */
function dominantBones(geo: THREE.BufferGeometry, bones: THREE.Bone[]): string[] {
  const idx = geo.getAttribute('skinIndex');
  const wgt = geo.getAttribute('skinWeight');
  const out: string[] = [];
  for (let v = 0; v < idx.count; v++) {
    let best = 0;
    let bestW = -1;
    for (let k = 0; k < 4; k++) {
      const w = wgt.getComponent(v, k);
      if (w > bestW) {
        bestW = w;
        best = idx.getComponent(v, k);
      }
    }
    out.push(bones[best]?.name ?? '');
  }
  return out;
}

/**
 * Cut a clothing shell out of the body mesh: keep triangles fully owned by
 * `keep` bones, push vertices out along their normals so the cloth sits on
 * top of the skin.
 */
function shellGeometry(
  body: THREE.SkinnedMesh,
  keep: Set<string>,
  inflate: number,
): THREE.BufferGeometry {
  const src = body.geometry;
  const owner = dominantBones(src, body.skeleton.bones);
  const geo = src.clone();
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  for (let v = 0; v < pos.count; v++) {
    pos.setXYZ(
      v,
      pos.getX(v) + nrm.getX(v) * inflate,
      pos.getY(v) + nrm.getY(v) * inflate,
      pos.getZ(v) + nrm.getZ(v) * inflate,
    );
  }
  const srcIndex = src.getIndex();
  const kept: number[] = [];
  if (srcIndex) {
    for (let t = 0; t < srcIndex.count; t += 3) {
      const a = srcIndex.getX(t);
      const b = srcIndex.getX(t + 1);
      const c = srcIndex.getX(t + 2);
      if (keep.has(owner[a]!) && keep.has(owner[b]!) && keep.has(owner[c]!)) {
        kept.push(a, b, c);
      }
    }
  }
  geo.setIndex(kept);
  return geo;
}

const clothMaterials = new Map<number, THREE.MeshStandardMaterial>();
function clothMaterial(color: number): THREE.MeshStandardMaterial {
  let m = clothMaterials.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0 });
    clothMaterials.set(color, m);
  }
  return m;
}

// --- Rigid props, sized in world units and counter-scaled onto bones -------

function kasaHat(): THREE.Group {
  const g = new THREE.Group();
  if (THEME === 'medieval') {
    // Round-brimmed peasant hat instead of the conical kasa.
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
  const hat = lathe(
    [
      [0.19, 0.0],
      [0.12, 0.05],
      [0.045, 0.1],
      [0.0, 0.11],
    ],
    0xc9a86a,
    12,
  );
  g.add(hat);
  return g;
}

function topknotHair(): THREE.Group {
  const g = new THREE.Group();
  const knot = mesh(new THREE.SphereGeometry(0.035, 6, 5), 0x241a12);
  knot.scale.y = 1.4;
  knot.position.y = 0.03;
  g.add(knot);
  return g;
}

function headbandProp(color: number): THREE.Group {
  const g = new THREE.Group();
  const band = mesh(new THREE.TorusGeometry(0.088, 0.014, 5, 12), color);
  band.rotation.x = Math.PI / 2;
  band.rotation.z = 0.06; // a touch of rake so it reads as tied cloth
  g.add(band);
  return g;
}

function armorPlates(robe: number): THREE.Group {
  const g = new THREE.Group();
  const dark = new THREE.Color(robe).multiplyScalar(0.7).getHex();
  // Lacquered dō: two stacked breast bands.
  for (const [y, r] of [
    [0.02, 0.155],
    [0.09, 0.15],
  ] as const) {
    const band = mesh(new THREE.CylinderGeometry(r, r * 1.04, 0.07, 10), dark);
    band.scale.z = 0.78;
    band.position.y = y;
    g.add(band);
  }
  // Sode shoulder guards.
  for (const side of [-1, 1] as const) {
    const sode = lathe(
      [
        [0.085, -0.05],
        [0.075, 0.0],
        [0.045, 0.04],
      ],
      dark,
      8,
    );
    sode.position.set(side * 0.17, 0.13, 0);
    sode.rotation.z = side * -0.5;
    g.add(sode);
  }
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
): { group: THREE.Group; visual: CharacterVisual } | null {
  if (!kkAssets) return null;
  const look = kindCode === 2 ? PROF_LOOKS.get(profession) : undefined;
  const spec = look?.spec ?? KK_SPECS.get(kindCode) ?? KK_SPECS.get(1)!;
  const char = kkAssets.chars.get(spec.file);
  if (!char) return null;
  const root = skeletonClone(char.scene);

  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) && !(o instanceof THREE.SkinnedMesh)) return;
    if (spec.hide?.includes(o.name)) o.visible = false;
    if (spec.tint !== undefined) {
      const m = o.material as THREE.MeshStandardMaterial;
      const key = `${spec.file}:${o.name}:${spec.tint}`;
      let tinted = kkTintMaterials.get(key);
      if (!tinted) {
        tinted = m.clone();
        tinted.color.set(spec.tint);
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
      const hat = kasaHat();
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
 * Load the character + animation library once. Returns null (and the
 * renderer falls back to procedural people) if the assets can't load.
 */
export async function loadCharacterAssets(): Promise<boolean> {
  if (THEME === 'medieval') return loadKayKitCharacters();
  try {
    const loader = new GLTFLoader();
    const [charGltf, animGltf] = await Promise.all([
      loader.loadAsync(CHARACTER_URL),
      loader.loadAsync(ANIMATIONS_URL),
    ]);

    const base = charGltf.scene;
    // Comic-book shading: drop the heavy normal/roughness maps, matte finish.
    base.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.SkinnedMesh) {
        o.castShadow = true;
        const m = o.material as THREE.MeshStandardMaterial;
        if (m && m.isMeshStandardMaterial) {
          m.normalMap = null;
          m.roughnessMap = null;
          m.roughness = 0.95;
          m.metalness = 0;
          m.needsUpdate = true;
        }
      }
    });

    // The body is the biggest skinned mesh; cut the clothing shells from it.
    let body: THREE.SkinnedMesh | null = null;
    base.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh) {
        const count = o.geometry.getAttribute('position').count;
        if (!body || count > body.geometry.getAttribute('position').count) body = o;
      }
    });
    if (!body) return false;
    const bodyMesh: THREE.SkinnedMesh = body;

    // Hide the default hairstyle: our kinds bring topknots, kasa, headbands.
    base.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.SkinnedMesh) {
        const m = o.material as THREE.Material;
        if (m?.name?.toLowerCase().includes('hair')) o.visible = false;
      }
    });

    const robeGeo = shellGeometry(bodyMesh, ROBE_BONES, 0.02);
    const sashGeo = shellGeometry(bodyMesh, SASH_BONES, 0.032);
    const robeShell = new THREE.SkinnedMesh(robeGeo, clothMaterial(0xffffff));
    robeShell.name = 'robeShell';
    const sashShell = new THREE.SkinnedMesh(sashGeo, clothMaterial(0xffffff));
    sashShell.name = 'sashShell';
    for (const shell of [robeShell, sashShell]) {
      shell.castShadow = true;
      shell.bind(bodyMesh.skeleton, bodyMesh.bindMatrix);
      bodyMesh.parent!.add(shell);
    }

    // Normalize: feet on y=0, TARGET_HEIGHT tall.
    const bbox = new THREE.Box3().setFromObject(base);
    const height = bbox.max.y - bbox.min.y;
    const clips = new Map<AnimKey, THREE.AnimationClip>();
    for (const key of Object.keys(CLIP_NAMES) as AnimKey[]) {
      const clip = THREE.AnimationClip.findByName(animGltf.animations, CLIP_NAMES[key]);
      if (clip) clips.set(key, clip);
    }
    if (clips.size === 0) return false;

    assets = { base, clips, scale: TARGET_HEIGHT / height, footY: -bbox.min.y };
    return true;
  } catch (err) {
    console.warn('[characters] falling back to procedural people:', err);
    return false;
  }
}

export function charactersReady(): boolean {
  return assets !== null || kkAssets !== null;
}

function attachToBone(
  root: THREE.Object3D,
  boneName: string,
  prop: THREE.Group,
  scale: number,
  offset: [number, number, number],
  rotation?: [number, number, number],
): void {
  const bone = root.getObjectByName(boneName);
  if (!bone) return;
  const holder = new THREE.Group();
  // Props are authored in world units; bones live in model units.
  holder.scale.setScalar(1 / scale);
  holder.position.set(...offset);
  if (rotation) holder.rotation.set(...rotation);
  holder.add(prop);
  bone.add(holder);
}

/**
 * A dressed, animated character for one unit. Returns null until assets
 * are loaded (callers fall back to the procedural person).
 */
export function makeCharacter(
  kindCode: number,
  profession = 0,
): { group: THREE.Group; visual: CharacterVisual } | null {
  if (kkAssets) return makeKayKitCharacter(kindCode, profession);
  if (!assets) return null;
  const wardrobe = WARDROBES.get(kindCode) ?? WARDROBES.get(1)!;
  const root = skeletonClone(assets.base);

  // Tint the clothing shells for this kind.
  root.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh) {
      if (o.name === 'robeShell') o.material = clothMaterial(wardrobe.robe);
      if (o.name === 'sashShell') o.material = clothMaterial(wardrobe.sash);
    }
  });

  const s = assets.scale * (wardrobe.scale ?? 1);

  // Rigid props on bones. Offsets are in model units (bone space).
  if (wardrobe.tool) {
    const hand = new THREE.Group();
    wardrobe.tool(hand);
    attachToBone(root, 'hand_r', hand, s, [0, 0.05, 0.02]);
  }
  if (wardrobe.kasa) attachToBone(root, 'Head', kasaHat(), s, [0, 0.14, 0]);
  // Topknots are a Japan-theme read; medieval soldiers go bareheaded.
  if (wardrobe.topknot && THEME !== 'medieval') {
    attachToBone(root, 'Head', topknotHair(), s, [0, 0.15, -0.02]);
  }
  if (wardrobe.headband) {
    attachToBone(root, 'Head', headbandProp(wardrobe.headband), s, [0, 0.035, 0]);
  }
  if (wardrobe.armored) attachToBone(root, 'spine_03', armorPlates(wardrobe.robe), s, [0, 0, 0]);
  if (wardrobe.back) {
    const back = new THREE.Group();
    wardrobe.back(back);
    back.position.y = -0.3; // quiver builder targets a torso group's chest
    attachToBone(root, 'spine_03', back, s, [0, 0, 0]);
  }

  const inner = new THREE.Group();
  inner.position.y = assets.footY * s;
  inner.scale.setScalar(s);
  inner.add(root);
  const group = new THREE.Group();
  group.add(inner);

  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<AnimKey, THREE.AnimationAction>();
  for (const [key, clip] of assets.clips) {
    const action = mixer.clipAction(clip);
    if (key === 'death') {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    } else if (key !== 'idle' && key !== 'walk' && key !== 'jog') {
      action.setLoop(THREE.LoopRepeat, Infinity);
    }
    actions.set(key, action);
  }

  return {
    group,
    visual: {
      mixer,
      actions,
      current: null,
      jog: wardrobe.jog ?? false,
      ranged: wardrobe.ranged ?? false,
      toolKind: 0,
    },
  };
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
