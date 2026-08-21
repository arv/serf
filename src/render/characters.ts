import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { lathe } from './models';
import { loadGltfRetry } from './assets';
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
  | 'throw'
  | 'work'
  | 'pickaxe'
  | 'hammer'
  | 'dig'
  | 'tend'
  | 'draw'
  | 'fish'
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
  // From RPG Tools Bits (CC0) rather than the character packs — the one
  // pack Kay ships a fishing rod in. Line, floater and hook included.
  'tools/fishing_rod',
  // Also RPG Tools Bits: real hammer and pickaxe hand tools. The comment
  // over the procedural props ("the free packs ship no hammer/pickaxe")
  // stopped being true when this pack arrived; the modeled ones swap in
  // and the procedural builds stay as the not-yet-loaded fallback.
  'tools/hammer',
  'tools/pickaxe',
];

const KK_CLIP_NAMES: Record<AnimKey, string> = {
  idle: 'Idle_A',
  walk: 'Walking_A',
  jog: 'Running_A',
  attack: 'Melee_1H_Attack_Chop',
  shoot: 'Ranged_Bow_Draw',
  // The levy on a tower roof: an overhand lob, empty-handed. The pack's
  // one throw, and it reads as a stone going over the parapet where the
  // bow draw read as a man miming an archer he is not.
  throw: 'Throw',
  // Real tool loops per work site.
  work: 'Chopping',
  pickaxe: 'Pickaxing',
  hammer: 'Hammering',
  dig: 'Digging',
  tend: 'Working_A',
  // Hand-over-hand reeling doubles as cranking the well bucket up.
  draw: 'Fishing_Reeling',
  // The patient hold, rod out over the water — the actual fisherman.
  fish: 'Fishing_Idle',
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
  /** The right-hand prop is a work tool, not a standing weapon: hidden
   * except while performing this WORK.* kind. */
  rightWorkKind?: number;
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
    // The Mage, bare-headed: under the wizard hat it is a hooded work
    // smock — the closest thing the pack has to a laborer. The Barbarian
    // it replaces read as a shirtless warrior hauling lumber. The pack
    // axe stays in the kit but only for the chop — a laborer walks
    // empty-handed (a builder marching around armed read as a raid), and
    // the modeled axe beats any procedural stand-in while he swings.
    file: 'Mage',
    hide: ['Mage_Hat'],
    right: 'axe_1handed',
    // The axe loads blade-backwards in the grip; spin it to face the swing.
    rightRot: [0, Math.PI, 0],
    rightWorkKind: 1, // WORK.chop
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

/**
 * World-space height of a villager, in tiles; matches the procedural people.
 *
 * Still oversized on purpose — RTS readability: Warcraft-style units read at
 * village zoom where true-scale people vanish. But 1.22 was oversized past
 * the point of reading as people at all. Measured against the buildings they
 * work in, a villager stood exactly as tall as a mine or a quarry, four
 * fifths the height of a weaponsmith, and better than half a house; the pack
 * authors its buildings squat to sit on hex tiles, and makeGlbBuilding sizes
 * them by footprint, so the village could not meet him halfway.
 *
 * At 0.85 the same buildings come out near their real proportions — a house
 * about 2.7 villagers, the guard tower 3.4, the castle 6.6 — while a unit is
 * still most of a tile tall and picking is positional anyway, so nothing got
 * harder to click.
 *
 * Exported because things that must sit on top of a villager (the hp bar) or
 * scale with his body (the de-overlap radius) have to move when this does.
 */
export const TARGET_HEIGHT = 0.85;

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

function peasantHat(bandColor?: number): THREE.Group {
  const g = new THREE.Group();
  // Peasant straw hat: a wide thin brim that sags at the edge, a low
  // rounded crown, and a dark band where they meet. The crown seat stays
  // wider than the chibi skull (~0.30 world at the seat) so the hair
  // mostly tucks under instead of shearing through the brim ring.
  const straw = 0xd3ab5c;
  const hat = lathe(
    [
      [0.172, 0.0],
      [0.167, 0.012],
      [0.12, 0.03],
      [0.115, 0.042],
      [0.098, 0.095],
      [0.05, 0.118],
      [0.0, 0.125],
    ],
    straw,
    16,
  );
  // The band takes the seat's color when one is given — the farmer's
  // tunic mostly hides under the brim from the game camera, so the hat
  // itself joins the heraldry.
  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(0.117, 0.12, 0.022, 16),
    new THREE.MeshLambertMaterial({ color: bandColor ?? 0x7a5636 }),
  );
  band.position.y = 0.045;
  g.add(hat, band);
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
  {
    const loader = new GLTFLoader();
    const chars = new Map<string, KKCharacter>();
    const clips = new Map<string, THREE.AnimationClip>();
    const props = new Map<string, THREE.Group>();
    await Promise.all([
      ...KK_CHARACTER_FILES.map(async (f) => {
        const gltf = await loadGltfRetry(loader, `${KK_DIR}${f}.glb`);
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
        const gltf = await loadGltfRetry(loader, `${KK_DIR}Rig_Medium_${f}.glb`);
        for (const clip of gltf.animations) clips.set(clip.name, clip);
      }),
      ...KK_PROP_FILES.map(async (f) => {
        const gltf = await loadGltfRetry(loader, `${KK_DIR}${f}.gltf`);
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
  }
}

const kkTintMaterials = new Map<string, THREE.MeshStandardMaterial>();

// --- Swappable work tools ------------------------------------------------
// Authored in world units: grip at the origin, handle up +Y, head at the
// top — the same frame the pack's axe sits in after its fix-up. The hammer
// and pickaxe are modeled now (RPG Tools Bits, see packToolProp); the
// procedural builds below remain as their pre-load fallbacks and the spade
// as the farmer's own tool.

const toolMesh = (geo: THREE.BufferGeometry, color: number): THREE.Mesh => {
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
  m.castShadow = true;
  return m;
};

// Tool proportions follow the pack's chibi exaggeration: the KayKit axe is
// nearly half a body tall with a fist-sized head, and the first draft of
// these (0.3-unit twigs) disappeared in hand next to it.
function malletProp(): THREE.Group {
  const g = new THREE.Group();
  const handle = toolMesh(new THREE.CylinderGeometry(0.022, 0.028, 0.44, 6), 0x8a6a42);
  handle.position.y = 0.18;
  const head = toolMesh(new THREE.CylinderGeometry(0.085, 0.085, 0.22, 8), 0x6b4e2e);
  head.rotation.z = Math.PI / 2;
  head.position.y = 0.4;
  const band = toolMesh(new THREE.CylinderGeometry(0.088, 0.088, 0.03, 8), 0x77848e);
  band.rotation.z = Math.PI / 2;
  band.position.y = 0.4;
  g.add(handle, head, band);
  return g;
}

function pickaxeProp(): THREE.Group {
  const g = new THREE.Group();
  const handle = toolMesh(new THREE.CylinderGeometry(0.022, 0.028, 0.48, 6), 0x8a6a42);
  handle.position.y = 0.2;
  const collar = toolMesh(new THREE.BoxGeometry(0.08, 0.06, 0.06), 0x5c666e);
  collar.position.y = 0.44;
  g.add(handle, collar);
  for (const side of [-1, 1]) {
    const spike = toolMesh(new THREE.ConeGeometry(0.05, 0.3, 6), 0x77848e);
    // Head spikes run across the swing plane, tips drooping slightly.
    spike.rotation.z = -side * (Math.PI / 2 + 0.22);
    spike.position.set(side * 0.16, 0.42, 0);
    g.add(spike);
  }
  return g;
}

function spadeProp(): THREE.Group {
  // Same frame as every tool: grip at the origin, haft up +Y, business
  // end at the top. The blade-down experiment put the blade at the sky in
  // the dig loop — the handslot points +Y at the ground mid-stroke.
  // The blade is one extruded spade profile — shoulders at the socket, a
  // rounded taper to the point. The box-plus-pyramid attempt read as a
  // sideways spearhead the moment the camera saw it edge-on.
  const g = new THREE.Group();
  const handle = toolMesh(new THREE.CylinderGeometry(0.024, 0.03, 0.42, 6), 0x8a6a42);
  handle.position.y = 0.21;
  const profile = new THREE.Shape();
  profile.moveTo(-0.085, 0);
  profile.lineTo(-0.095, 0.09);
  profile.quadraticCurveTo(-0.075, 0.2, 0, 0.25);
  profile.quadraticCurveTo(0.075, 0.2, 0.095, 0.09);
  profile.lineTo(0.085, 0);
  profile.closePath();
  const blade = toolMesh(
    new THREE.ExtrudeGeometry(profile, { depth: 0.028, bevelEnabled: false }),
    0x8b95a0,
  );
  blade.position.set(0, 0.41, -0.014);
  const grip = toolMesh(new THREE.CylinderGeometry(0.022, 0.022, 0.13, 6), 0x6b4e2e);
  grip.rotation.z = Math.PI / 2;
  grip.position.y = -0.02;
  g.add(handle, blade, grip);
  return g;
}

function fishingPoleProp(): THREE.Group {
  // The RPG Tools Bits rod: grip at the origin, rod up +Y with a built-in
  // forward sweep toward +z, line + floater + hook hanging off the tip
  // node. Source scale puts the tip at y=2.37 — scale it to the same
  // over-half-a-body length the other tools wear.
  const rod = kkAssets!.props.get('tools/fishing_rod')!.clone();
  const s = 0.36;
  rod.scale.setScalar(s);
  // The authored line stops 1.94 under the tip, which at this scale
  // strands the hook chest-high over the pier. Stretch the line node (its
  // mesh hangs from the tip) and counter-scale the floater and hook it
  // carries so they keep their shape while riding down to the water.
  const K = 1.8;
  const line = rod.getObjectByName('fishing_rod_line');
  if (line) {
    line.scale.y *= K;
    // By name, not "all children": if the loader ever splits the line
    // node's own mesh into a child primitive, a blanket counter-scale
    // would catch it and cancel the stretch.
    for (const name of ['fishing_rod_floater', 'fishing_rod_hook']) {
      const o = rod.getObjectByName(name);
      if (o) o.scale.y /= K;
    }
  }
  // The relaxed gripPose that suits the swung tools lays a rod tip-down.
  // Cancel it (inverse rotation, hence the reversed order) back to the
  // bare handslot axis, then a modest forward pitch — the rod's own sweep
  // does the rest, and the hanging line stays near plumb.
  const tilt = new THREE.Group();
  tilt.rotation.x = 0.5;
  tilt.add(rod);
  const wrap = new THREE.Group();
  wrap.rotation.order = 'ZYX';
  wrap.rotation.set(-0.35, 0, 0.55);
  wrap.add(tilt);
  return wrap;
}

/** Relaxed grip: mid-haft, head tipped out and a touch forward. Tools sat
 * grip-at-end pointing straight down the idle arm, which parked the spade
 * blade at the ankle and read as dropped rather than held; these angles
 * were tuned live in the fitting room and still swing true in the work
 * loops. */
function gripPose<T extends THREE.Object3D>(tool: T): T {
  tool.position.y = -0.14;
  tool.rotation.set(0.35, 0, -0.55);
  return tool;
}

/**
 * A pack tool sized into the procedural props' frame: grip at the origin,
 * handle up +Y, and `height` world units tall — the same over-half-a-body
 * exaggeration the hand-built ones wear, so a swap changes the silhouette
 * and nothing else. Falls back to the procedural build until the pack is
 * in (or if a file ever goes missing).
 */
function packToolProp(prop: string, height: number, fallback: () => THREE.Group): THREE.Group {
  const src = kkAssets?.props.get(prop);
  if (!src) return fallback();
  const tool = src.clone();
  const bb = new THREE.Box3().setFromObject(tool);
  const h = Math.max(bb.max.y - bb.min.y, 1e-6);
  const g = new THREE.Group();
  g.scale.setScalar(height / h);
  g.add(tool);
  return g;
}

const WORK_TOOLS: Record<number, () => THREE.Group> = {
  3: () => packToolProp('tools/hammer', 0.52, malletProp), // WORK.hammer
  2: () => packToolProp('tools/pickaxe', 0.58, pickaxeProp), // WORK.pickaxe
  4: spadeProp, // WORK.dig
  6: () => new THREE.Group(), // WORK.draw — bare hands on the well crank
  7: fishingPoleProp, // WORK.fish
};

/** setWorkTool sentinel: hands are full (carrying goods) — no tool shows,
 * not even the profession's carried one. */
export const TOOL_STOWED = -1;

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
  if (workKind === TOOL_STOWED) {
    if (visual.defaultTool) visual.defaultTool.visible = false;
    return;
  }
  const make = WORK_TOOLS[workKind];
  // A default tool that already matches the work keeps its place (the
  // farmer digs with the spade he carries).
  const covered = make && visual.defaultTool?.userData.workKind === workKind;
  if (make && !covered) {
    visual.toolCustom.add(make());
    if (visual.defaultTool) visual.defaultTool.visible = false;
  } else if (visual.defaultTool) {
    const d = visual.defaultTool.userData;
    visual.defaultTool.visible = !d.workOnly || workKind === d.workKind;
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
      tool: () => packToolProp('tools/pickaxe', 0.58, pickaxeProp),
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

  // Faction cloth: only the torso and cape take the seat's color — the
  // same four the buildings' team-color slot uses — worn strong, like a
  // tabard. Skin, hair, leather and steel keep the pack's own palette;
  // tinting the whole body just washed every kind into the same olive
  // mush and left faction identity to, of all things, hair color.
  // Bandits keep their grim stock look.
  const faction = factionTint(owner);
  const CLOTH = /_(Body|Cape)$/;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) && !(o instanceof THREE.SkinnedMesh)) return;
    if (spec.hide?.includes(o.name)) o.visible = false;
    const clothFaction = CLOTH.test(o.name) ? faction : undefined;
    if (spec.tint !== undefined || clothFaction !== undefined) {
      const m = o.material as THREE.MeshStandardMaterial;
      const key = `${spec.file}:${o.name}:${spec.tint ?? 'x'}:${clothFaction ?? 'x'}`;
      let tinted = kkTintMaterials.get(key);
      if (!tinted) {
        tinted = m.clone();
        if (spec.tint !== undefined) tinted.color.set(spec.tint);
        // The color multiplies the painted texture, and the cloth regions
        // are mid-brown — a straight faction multiplier goes swampy. Lift
        // it toward white so the cloth reads as dyed, not stained.
        if (clothFaction !== undefined) {
          // Two hands on the dye vat: the multiplier alone goes swampy
          // (cloth texels are mid-brown, and green x brown is bog), while
          // a touch of emissive restores the saturation multiply loses.
          // Together they read as dyed cloth under the same sun.
          tinted.color.lerp(new THREE.Color(clothFaction), 0.9).lerp(new THREE.Color(0xffffff), 0.12);
          tinted.emissive.set(clothFaction).multiplyScalar(0.22);
        }
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
  if (rightHand && spec.rightWorkKind !== undefined) {
    rightHand.inst.userData.workKind = spec.rightWorkKind;
    rightHand.inst.userData.workOnly = true;
    rightHand.inst.visible = false;
  }
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
    toolCustom = gripPose(new THREE.Group());
    toolAnchor.add(toolCustom);
    if (look?.tool) {
      // The profession's own tool: carried at rest like a soldier carries
      // a sword, worked with on site, and stowed only while the hands are
      // full of goods (TOOL_STOWED).
      proceduralTool = gripPose(look.tool());
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
      const hat = peasantHat(faction);
      // Sized against the measured skull: crown tops out ~0.56 above the
      // head bone and spans ~0.32 wide (world units) — the old 1.9/0.12
      // hat sat entirely inside the head.
      hat.scale.setScalar(2.35);
      hat.position.y = 0.41;
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
