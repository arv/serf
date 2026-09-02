import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {clone as skeletonClone} from 'three/addons/utils/SkeletonUtils.js';
import type {Enum} from '../shared/enum.ts';
import {clamp} from '../shared/math';
import {UNIT_DEFS} from '../sim/defs/units';
import * as AnimKeyNs from './animKeyEnum.ts';
import {loadGltfRetry} from './assets';
import {factionTint} from './factionPalette';
import {lathe} from './models';
import {goodColors} from './palette';
export type AnimKey = Enum<typeof AnimKeyNs>;
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum.ts';
import * as GaitNs from './gaitEnum.ts';
export type Gait = Enum<typeof GaitNs>;

/**
 * Skinned-character pipeline: KayKit Adventurers 2.0 characters animated by
 * the KayKit Character Animations library (both CC0, both on the same
 * Rig_Medium skeleton, so library clips drive every character directly).
 * Weapons are pack props dropped into the rig's handslot bones. When the
 * assets can't load, callers fall back to the procedural people in
 * models.ts.
 */

const KK_DIR = '/models/kaykit/';
const KK_CHARACTER_FILES = [
  'Knight',
  'Barbarian',
  'Rogue',
  'Rogue_Hooded',
  'Mage',
  'Ranger',
];
const KK_ANIMATION_FILES = [
  'MovementBasic',
  'General',
  'CombatMelee',
  'CombatRanged',
  'Tools',
];
const KK_PROP_FILES = [
  'sword_1handed',
  'shield_badge',
  'axe_1handed',
  'axe_2handed',
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
  // Fantasy Weapons Bits (CC0), vendored at last: the real scythe for the
  // farmer and the plain spear the spearProp comment spent a release
  // waiting for. Both authored like every pack prop — grip at the origin,
  // up +Y — so they ride the same anchors; the procedural builds stay as
  // their not-yet-loaded fallbacks.
  'weapons/scythe',
  'weapons/spear_A',
];

const KK_CLIP_NAMES: Record<AnimKey, string> = {
  [AnimKeyNs.idle]: 'Idle_A',
  [AnimKeyNs.walk]: 'Walking_A',
  [AnimKeyNs.jog]: 'Running_A',
  [AnimKeyNs.attack]: 'Melee_1H_Attack_Chop',
  // Draw and release, composited at load from the pack's two halves
  // (see sequence in loadKayKitCharacters).
  [AnimKeyNs.shoot]: 'Bow_Shoot',
  // The levy on a tower roof: an overhand lob, empty-handed. The pack's
  // one throw, and it reads as a stone going over the parapet where the
  // bow draw read as a man miming an archer he is not.
  [AnimKeyNs.throwing]: 'Throw',
  // Real tool loops per work site.
  [AnimKeyNs.work]: 'Chopping',
  [AnimKeyNs.pickaxe]: 'Pickaxing',
  [AnimKeyNs.hammer]: 'Hammering',
  [AnimKeyNs.dig]: 'Digging',
  [AnimKeyNs.tend]: 'Working_A',
  // Hand-over-hand reeling doubles as cranking the well bucket up.
  [AnimKeyNs.draw]: 'Fishing_Reeling',
  // The scythe stroke: the pack's two-handed horizontal slice, which is
  // the mowing sweep — wind-up to the right, blade carried flat across
  // the body. The Tools library has no farm loop that swings anything.
  [AnimKeyNs.mow]: 'Melee_2H_Attack_Slice',
  // The patient hold, rod out over the water — the actual fisherman.
  [AnimKeyNs.fish]: 'Fishing_Idle',
  // Composited at load: gait legs + holding-pose arms.
  [AnimKeyNs.carry]: 'Carry_Walk',
  [AnimKeyNs.carryIdle]: 'Carry_Idle',
  [AnimKeyNs.death]: 'Death_A',
};

interface KKSpec {
  file: string;
  /** Mesh names to hide (capes, hats) so kinds read apart. */
  hide?: string[];
  right?: string;
  /** Euler fix-up for right-hand props that load facing the wrong way. */
  rightRot?: [number, number, number];
  /** Right-hand weapon from a builder function rather than a prop file —
   * for anything needing a fallback or fix-up beyond what `right` offers
   * (spearHand). Its result is authored in the pack props' frame, so it
   * drops into the handslot at identity exactly like `right`. */
  rightBuilt?: () => THREE.Group;
  /** The right-hand prop is a work tool, not a standing weapon: hidden
   * except while performing this WORK.* kind. */
  rightWorkKind?: number;
  left?: string;
  /** Euler fix-up for left-hand props, as rightRot is for the right. */
  leftRot?: [number, number, number];
  /** Prop strapped to the chest (quivers). */
  back?: string;
  /** Multiplies the texture — bandits go grim. */
  tint?: number;
  scale?: number;
  jog?: boolean;
  ranged?: boolean;
  attackClip?: string;
}

/** The bow prop's fix-up: a half turn about the grip (see the archer). */
const BOW_ROT: [number, number, number] = [0, Math.PI, 0];

const KK_SPECS = new Map<number, KKSpec>([
  [1, {file: 'Rogue', hide: ['Rogue_Cape']}],
  [
    2,
    {
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
    },
  ],
  [
    3,
    {file: 'Knight', right: 'sword_1handed', left: 'shield_badge', jog: true},
  ],
  [
    4,
    {
      file: 'Knight',
      hide: ['Knight_Cape', 'Knight_HelmetVisor'],
      // The pack spear, at handslot identity (see spearHand; the wizard
      // staff stood in for one once, and the hand-built spear after it).
      rightBuilt: spearHand,
      jog: true,
      attackClip: 'Melee_1H_Attack_Stab',
    },
  ],
  // The bow rides the left hand: the pack's draw and release are authored
  // for it — the left arm holds the bow out, the right hand goes to the
  // string. In the right hand it swung to the cheek at full draw while
  // the bow arm reached out empty. Loaded as-is it faces the wrong way,
  // string toward the target; a half turn about the grip puts the string
  // on the archer's side, where the draw hand pulls it.
  [
    5,
    {
      file: 'Ranger',
      left: 'bow_withString',
      leftRot: BOW_ROT,
      jog: true,
      ranged: true,
    },
  ],
  [6, {file: 'Rogue', tint: 0x7c8290, right: 'dagger', jog: true}],
  [
    7,
    {
      file: 'Rogue_Hooded',
      tint: 0x7c8290,
      left: 'bow_withString',
      leftRot: BOW_ROT,
      back: 'quiver',
      jog: true,
      ranged: true,
    },
  ],
  [
    8,
    {
      file: 'Barbarian',
      tint: 0x94848c,
      right: 'axe_2handed',
      scale: 1.18,
      jog: true,
      attackClip: 'Melee_2H_Attack_Chop',
    },
  ],
]);

/** Sim ground speed by kind byte, for matching gait playback to it. */
const KIND_SPEED = new Map<number, number>(
  Object.values(UNIT_DEFS).map(d => [d.id, d.speed]),
);

interface KKCharacter {
  scene: THREE.Group;
  scale: number;
  footY: number;
}

interface KKAssets {
  chars: Map<string, KKCharacter>;
  clips: Map<string, THREE.AnimationClip>;
  props: Map<string, THREE.Group>;
  /** Ground speed each gait clip is authored for, rig units/sec (0 =
   * unmeasured; gaits then play at their authored rate). */
  gaitSpeeds: {walk: number; jog: number};
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
  /** Locomotion clip for this unit, picked at build time to suit its sim
   * speed (see the gait matching in makeKayKitCharacter). */
  gait: Gait;
  /** Natural ground speed of each gait clip for this body, world units/sec
   * (0 = unmeasured: that gait plays at its authored rate). */
  gaitNat: {walk: number; jog: number};
  /** Ground speed the gait timeScales currently assume — setGaitSpeed's
   * deadband memory. */
  gaitSpeed: number;
  ranged: boolean;
  /** World-unit holder on the chest bone: carried goods parented here ride
   * the walk animation (bob, sway) instead of floating rigidly. */
  carryAnchor?: THREE.Group;
  /** World-unit holder in the right hand for swappable work tools. */
  toolAnchor?: THREE.Group;
  /** Sub-group of toolAnchor holding the currently swapped-in work tool. */
  toolCustom?: THREE.Group;
  /** The wardrobe's own hand prop (axe, sword, the farmer's scythe...),
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
    new THREE.MeshLambertMaterial({color: bandColor ?? 0x7a5636}),
  );
  band.position.y = 0.045;
  g.add(hat, band);
  return g;
}

/** Matte, shadow-casting setup shared by every loaded KayKit scene. */
function prepKayKitScene(scene: THREE.Group): void {
  scene.traverse(o => {
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

/**
 * Ground speed a gait clip is authored for, in rig units/sec. An in-place
 * gait sweeps the planted foot backward under the body at exactly the
 * ground speed the cycle was built to cover, so: sample the foot over one
 * cycle, take the longest stretch it spends in the lowest fifth of its arc
 * (the stance phase), and divide its horizontal travel by the time. Runs
 * once per gait at load, on a throwaway rig clone.
 */
function measureGaitSpeed(
  scene: THREE.Group,
  clip: THREE.AnimationClip | undefined,
): number {
  if (!clip) return 0;
  const root = skeletonClone(scene);
  // GLTFLoader sanitizes bone names ('foot.l' loads as 'footl').
  const foot = root.getObjectByName('foot.l') ?? root.getObjectByName('footl');
  if (!foot) return 0;
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();
  const N = 96;
  const dt = clip.duration / N;
  const pts: THREE.Vector3[] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < N; i++) {
    mixer.setTime(i * dt);
    root.updateMatrixWorld(true);
    const p = foot.getWorldPosition(new THREE.Vector3());
    pts.push(p);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const grounded = pts.map(p => p.y < minY + (maxY - minY) * 0.2);
  let bestStart = 0;
  let bestLen = 0;
  for (let s = 0; s < N; s++) {
    // Stance starts where grounded turns on (the scan is circular).
    if (grounded[(s + N - 1) % N] || !grounded[s]) continue;
    let len = 1;
    while (len < N && grounded[(s + len) % N]) len++;
    if (len > bestLen) {
      bestLen = len;
      bestStart = s;
    }
  }
  if (bestLen < 2) return 0;
  const a = pts[bestStart]!;
  const b = pts[(bestStart + bestLen - 1) % N]!;
  return Math.hypot(b.x - a.x, b.z - a.z) / ((bestLen - 1) * dt);
}

async function loadKayKitCharacters(): Promise<boolean> {
  {
    const loader = new GLTFLoader();
    const chars = new Map<string, KKCharacter>();
    const clips = new Map<string, THREE.AnimationClip>();
    const props = new Map<string, THREE.Group>();
    await Promise.all([
      ...KK_CHARACTER_FILES.map(async f => {
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
      ...KK_ANIMATION_FILES.map(async f => {
        const gltf = await loadGltfRetry(
          loader,
          `${KK_DIR}Rig_Medium_${f}.glb`,
        );
        for (const clip of gltf.animations) clips.set(clip.name, clip);
      }),
      ...KK_PROP_FILES.map(async f => {
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
      const legTracks = base.tracks.filter(t => !ARM_BONES.test(t.name));
      const armTracks = hold.tracks
        .filter(t => ARM_BONES.test(t.name))
        .map(t => {
          // A single static key: the pose's first frame, held.
          const size = t.getValueSize();
          const Track = t.constructor as new (
            name: string,
            times: number[],
            values: ArrayLike<number>,
          ) => THREE.KeyframeTrack;
          return new Track(t.name, [0], t.values.slice(0, size));
        });
      const clip = new THREE.AnimationClip(name, base.duration, [
        ...legTracks,
        ...armTracks,
      ]);
      clips.set(name, clip);
      return clip;
    };
    /**
     * Two clips played end to end as one loop, `first` then `second`,
     * for a pack action authored in halves. The loop is exactly twice
     * `first`'s length: `second` is kept for that length less `blend`,
     * and the last `blend` seconds ease every bone from where `second`
     * was cut back to `first`'s opening pose — the crossfade the mixer
     * would give two actions, baked in so one looping action carries the
     * whole shot and its release lands at phase 0.5 by construction,
     * not by measurement (LOOP_CUES, and the arrow's release watch in
     * sceneSync and buildingSync, count on that). Tracks `second` has and
     * `first` lacks are dropped: the one such track in the pack (the
     * release's handslot.l scale) is a constant 1.
     */
    const sequence = (
      firstName: string,
      secondName: string,
      name: string,
      blend: number,
    ): THREE.AnimationClip | null => {
      const first = clips.get(firstName);
      const second = clips.get(secondName);
      if (!first || !second) return null;
      const D = first.duration;
      const keep = D - blend;
      const total = 2 * D;
      const tracks = first.tracks.map(t => {
        const size = t.getValueSize();
        const times: number[] = Array.from(t.times);
        const values: number[] = Array.from(t.values);
        const tail = second.tracks.find(u => u.name === t.name);
        if (tail) {
          for (let k = 0; k < tail.times.length; k++) {
            const time = tail.times[k]!;
            if (time > keep) break;
            // The halves meet at D: `first` already keys its last pose
            // there, so `second`'s opening key would double the time.
            if (D + time <= times[times.length - 1]!) continue;
            times.push(D + time);
            for (let c = 0; c < size; c++)
              values.push(tail.values[k * size + c]!);
          }
        }
        // Close the loop: ease back to the opening pose over `blend`.
        times.push(total);
        for (let c = 0; c < size; c++) values.push(t.values[c]!);
        const Track = t.constructor as new (
          name: string,
          times: number[],
          values: ArrayLike<number>,
        ) => THREE.KeyframeTrack;
        return new Track(t.name, times, values);
      });
      const clip = new THREE.AnimationClip(name, total, tracks);
      clips.set(name, clip);
      return clip;
    };
    composite('Walking_A', 'Holding_B', 'Carry_Walk');
    composite('Running_A', 'Holding_B', 'Carry_Jog');
    composite('Idle_A', 'Holding_B', 'Carry_Idle');
    // The pack splits a shot in two: Ranged_Bow_Draw reaches for the
    // arrow, nocks it and pulls to full draw, then holds; Ranged_Bow_Release
    // starts from that hold, snaps the string hand away and settles. The
    // draw ends where the release begins; the release ends nowhere near
    // the reach, which is what the blend is for. Looping the draw alone —
    // what the archer did before — pulled the string back over and over
    // and never let go:
    // the hold snapped straight back to the reach at the wrap, and the
    // twang and the arrow rode the pull-back, which is the one moment an
    // archer is certainly not shooting. Play the two back to back as one
    // loop, with the release landing exactly halfway (see sequence).
    sequence('Ranged_Bow_Draw', 'Ranged_Bow_Release', 'Bow_Shoot', 0.25);

    // Everyone shares the Rig_Medium skeleton, so one character stands in
    // for all of them under the tape measure.
    const rig = chars.values().next().value;
    const gaitSpeeds = {
      walk: rig
        ? measureGaitSpeed(rig.scene, clips.get(KK_CLIP_NAMES[AnimKeyNs.walk]))
        : 0,
      jog: rig
        ? measureGaitSpeed(rig.scene, clips.get(KK_CLIP_NAMES[AnimKeyNs.jog]))
        : 0,
    };

    kkAssets = {chars, clips, props, gaitSpeeds};
    return true;
  }
}

const kkTintMaterials = new Map<string, THREE.MeshStandardMaterial>();

// --- Swappable work tools ------------------------------------------------
// Authored in world units: grip at the origin, handle up +Y, head at the
// top — the same frame the pack's axe sits in after its fix-up. The hammer
// and pickaxe are modeled (RPG Tools Bits, see packToolProp) and the
// scythe too now (Fantasy Weapons Bits, see packScytheProp); the
// procedural builds below remain as their pre-load fallbacks.

const toolMesh = (geo: THREE.BufferGeometry, color: number): THREE.Mesh => {
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({color}));
  m.castShadow = true;
  return m;
};

// Tool proportions follow the pack's chibi exaggeration: the KayKit axe is
// nearly half a body tall with a fist-sized head, and the first draft of
// these (0.3-unit twigs) disappeared in hand next to it.
function malletProp(): THREE.Group {
  const g = new THREE.Group();
  const handle = toolMesh(
    new THREE.CylinderGeometry(0.022, 0.028, 0.44, 6),
    0x8a6a42,
  );
  handle.position.y = 0.18;
  const head = toolMesh(
    new THREE.CylinderGeometry(0.085, 0.085, 0.22, 8),
    0x6b4e2e,
  );
  head.rotation.z = Math.PI / 2;
  head.position.y = 0.4;
  const band = toolMesh(
    new THREE.CylinderGeometry(0.088, 0.088, 0.03, 8),
    0x77848e,
  );
  band.rotation.z = Math.PI / 2;
  band.position.y = 0.4;
  g.add(handle, head, band);
  return g;
}

function pickaxeProp(): THREE.Group {
  const g = new THREE.Group();
  const handle = toolMesh(
    new THREE.CylinderGeometry(0.022, 0.028, 0.48, 6),
    0x8a6a42,
  );
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
  const handle = toolMesh(
    new THREE.CylinderGeometry(0.024, 0.03, 0.42, 6),
    0x8a6a42,
  );
  handle.position.y = 0.21;
  const profile = new THREE.Shape();
  profile.moveTo(-0.085, 0);
  profile.lineTo(-0.095, 0.09);
  profile.quadraticCurveTo(-0.075, 0.2, 0, 0.25);
  profile.quadraticCurveTo(0.075, 0.2, 0.095, 0.09);
  profile.lineTo(0.085, 0);
  profile.closePath();
  const blade = toolMesh(
    new THREE.ExtrudeGeometry(profile, {depth: 0.028, bevelEnabled: false}),
    0x8b95a0,
  );
  blade.position.set(0, 0.41, -0.014);
  const grip = toolMesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.13, 6),
    0x6b4e2e,
  );
  grip.rotation.z = Math.PI / 2;
  grip.position.y = -0.02;
  g.add(handle, blade, grip);
  return g;
}

function scytheProp(): THREE.Group {
  // The pre-load fallback for the Fantasy Weapons Bits scythe (see
  // WORK_TOOLS), in the same frame as every tool: grip at the origin,
  // snath up +Y, business end at the top. The blade is a flattened arc
  // hooked out sideways from the snath's head, so the two-handed slice
  // carries it flat through the stalks — a blade authored hanging down
  // (the way a real scythe mows) pointed at the sky through the whole
  // swing, because the handslot leads with the prop's +Y.
  const g = new THREE.Group();
  const lower = toolMesh(
    new THREE.CylinderGeometry(0.024, 0.03, 0.36, 6),
    0x8a6a42,
  );
  lower.position.y = 0.15;
  // The snath's upper run leans a touch forward — the bent haft is most
  // of what says scythe rather than staff at village zoom.
  const upper = toolMesh(
    new THREE.CylinderGeometry(0.019, 0.024, 0.34, 6),
    0x8a6a42,
  );
  upper.rotation.x = 0.24;
  upper.position.set(0, 0.47, 0.04);
  // The mower's second grip: a short nib pegged out of the haft.
  const nib = toolMesh(
    new THREE.CylinderGeometry(0.016, 0.016, 0.11, 6),
    0x6b4e2e,
  );
  nib.rotation.x = Math.PI / 2;
  nib.position.set(0, 0.33, 0.05);
  // Tang collar where the blade is bolted on.
  const collar = toolMesh(new THREE.BoxGeometry(0.05, 0.05, 0.07), 0x6b4e2e);
  collar.position.set(0, 0.63, 0.09);
  // The blade: a quarter-hoop laid flat and squashed thin — the same
  // read as the carried scythe good (models.ts), steel like the spade's
  // edge. The arc springs from the collar and sweeps out past +z.
  const blade = toolMesh(
    new THREE.TorusGeometry(0.19, 0.03, 4, 12, 1.9),
    0x8b95a0,
  );
  blade.rotation.set(Math.PI / 2, 0, 0);
  blade.rotation.order = 'ZYX';
  blade.rotation.y = -2.1; // aim the arc's spring at the collar
  // Squash the tube along the torus axis: thin in elevation, wide in
  // plan — a curved knife lying flat, not a bent rod.
  blade.scale.z = 0.32;
  blade.position.set(0.09, 0.63, 0.22);
  g.add(lower, upper, nib, collar, blade);
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

/** How far down its own haft a tool is gripped, world units. Exported so
 * the model lab's live knobs re-derive the slide from the same number
 * rather than a copy of it. */
export const GRIP_SLIDE = 0.14;

/**
 * Relaxed grip: mid-haft, head tipped out and a touch forward. Tools sat
 * grip-at-end pointing straight down the idle arm, which parked the spade
 * blade at the ankle and read as dropped rather than held; these angles
 * were tuned live in the fitting room and still swing true in the work
 * loops.
 *
 * `pitch` is extra roll about the fist for a tool that wants its head
 * carried lower than the swung ones do (the scythe's). It joins the
 * pose's own roll rather than nesting under it, so the slide below can
 * follow the haft the tool actually ends up on.
 */
function gripPose<T extends THREE.Object3D>(tool: T, pitch = 0): T {
  tool.rotation.set(0.35, 0, -0.55 + pitch);
  // The slide has to run down the tool's OWN haft. `position` lands in
  // the hand's frame and is applied after the rotation, so the bare
  // (0, -GRIP_SLIDE, 0) this used to be carried the haft sideways out of
  // the fist as much as down it: every hand tool in the game hung a haft's
  // width — 0.08 world, three times the shaft's own radius — clear of the
  // hand that was supposed to be gripping it, the fist closed on air
  // beside the wood. Rotated into the pose, the slide moves the grip
  // along the haft and nothing else, and the haft runs through the fist.
  tool.position.set(0, -GRIP_SLIDE, 0).applyEuler(tool.rotation);
  return tool;
}

/**
 * A pack tool sized into the procedural props' frame: grip at the origin,
 * handle up +Y, and `height` world units tall — the same over-half-a-body
 * exaggeration the hand-built ones wear, so a swap changes the silhouette
 * and nothing else. Falls back to the procedural build until the pack is
 * in (or if a file ever goes missing).
 */
function packToolProp(
  prop: string,
  height: number,
  fallback: () => THREE.Group,
): THREE.Group {
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

/**
 * The pack scythe, re-gripped and turned the right way round. Its origin
 * sits mid-haft rather than at the butt, so the pose's own slide alone
 * grips it three fifths of the way up — head-heavy, the snath trailing
 * as a counterweight; the inner offset pushes the tool back out along
 * the snath until the fist is on the middle wrapping. The half-turn puts
 * the hook under the snath instead of over it, and the pitch that floats
 * the head clear of the turf rides on the grip (SCYTHE_PITCH).
 */
function packScytheProp(): THREE.Group {
  if (!kkAssets?.props.get('weapons/scythe')) return scytheProp();
  const inner = packToolProp('weapons/scythe', 0.8, scytheProp);
  // Half a turn about the snath — the same fix-up the pack axe wears in
  // KK_SPECS, for the same reason. The file hooks its blade out to one
  // side of the haft, and the handslot leads with the prop's +Y, which
  // laid that hook ABOVE the snath: through the whole mowing stroke the
  // blade rode the top of the sweep with its edge at the sky, curling
  // back over the farmer's shoulder — a man cutting wheat with the spine
  // of the blade, holding the thing backwards. Turned, the hook hangs
  // under the far end of the snath the way a scythe's does and the sweep
  // carries it through the stalks.
  inner.rotation.y = Math.PI;
  // Slide the grip: 0.10 puts the fist on the haft's middle wrapping,
  // just under halfway up. More reads better still in the swing but the
  // surplus hangs BELOW the fist everywhere else — at idle the arm
  // points the head at the ground, and by 0.22 the tool stood buried to
  // the wrappings with the blade tip surfacing a step away like a shark.
  inner.position.y = 0.1;
  const g = new THREE.Group();
  g.add(inner);
  return g;
}

/**
 * The scythe's extra roll about the fist (gripPose's `pitch`), lifting
 * the head rather than dropping it: with the hook turned under, the arm's
 * own aim at the ground is now the blade's, and the -0.2 the upside-down
 * tool wore drove the whole head under the turf — the farmer mowed a
 * furrow, and at rest nothing of the scythe showed below the collar at
 * all. Tuned against the whole wardrobe, not one clip: 0.45 floats the
 * tip at stalk height through the stroke and rests it on the grass at
 * idle, where 0.5 already carried the stroke level at the hip.
 *
 * It rides on the pose rather than on a pivot inside the prop so that the
 * grip slide knows about it — nested, the slide followed the unpitched
 * haft and put the fist beside the snath again.
 */
const SCYTHE_PITCH = 0.45;

/** Work tools that want gripPose's `pitch`; the rest take the pose bare. */
const WORK_TOOL_PITCH: Record<number, number> = {
  8: SCYTHE_PITCH, // WORK.mow
};

const WORK_TOOLS: Record<number, () => THREE.Group> = {
  3: () => packToolProp('tools/hammer', 0.52, malletProp), // WORK.hammer
  2: () => packToolProp('tools/pickaxe', 0.58, pickaxeProp), // WORK.pickaxe
  4: spadeProp, // WORK.dig
  6: () => new THREE.Group(), // WORK.draw — bare hands on the well crank
  7: fishingPoleProp, // WORK.fish
  8: packScytheProp, // WORK.mow
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
  // farmer mows with the scythe he carries).
  const covered = make && visual.defaultTool?.userData.workKind === workKind;
  if (make && !covered) {
    // The pose lives on the holder, not the tool: the rod cancels these
    // very angles from inside itself (fishingPoleProp), so re-posing the
    // tool would undo its own fix-up.
    gripPose(visual.toolCustom, WORK_TOOL_PITCH[workKind] ?? 0);
    visual.toolCustom.add(make());
    if (visual.defaultTool) visual.defaultTool.visible = false;
  } else if (visual.defaultTool) {
    const d = visual.defaultTool.userData;
    visual.defaultTool.visible = !d.workOnly || workKind === d.workKind;
  }
}

// --- Weapons the packs don't ship ---------------------------------------

/**
 * The spearman's spear: Fantasy Weapons Bits' plain spear_A now that the
 * pack is vendored, exactly as the note below promised, with the
 * hand-built one kept as the not-yet-loaded fallback the way the mallet
 * and pickaxe stand behind their modeled tools. spear_A is authored like
 * every pack prop — grip at the origin, shaft up +Y, rig-compatible units
 * (3.1 from butt to point against the character's 2.54) — so it drops
 * into the handslot at identity and the stab clip drives its point at the
 * enemy unchanged.
 */
function spearHand(): THREE.Group {
  const spear = kkAssets?.props.get('weapons/spear_A');
  return spear ? (spear.clone() as THREE.Group) : spearProp();
}

/**
 * A spear, built by hand — spearHand's pre-load fallback.
 *
 * The spearman carried the pack's `staff` before this, borrowed for its
 * long shaft — but it is the *Mage's* staff, and the crystal knot on the
 * head of it gave the game away: at anything closer than village zoom the
 * levy's spearman was a wizard marching to war. It was built when the
 * free packs shipped no spear; Fantasy Weapons Bits does, and now that it
 * is vendored the modeled one takes the hand.
 *
 * Built in the pack props' own frame, so it drops into the handslot at
 * identity like any of them: grip at the origin, shaft up +Y, rig units —
 * the character stands 2.54 tall in those, and this is 2.8 from butt to
 * point. The rig lays a prop along that +Y out of the fist, which is why
 * the pack's sword runs blade-forward from the hand and not up it; the
 * stab clip then drives this point at the enemy for free.
 */
let spearTemplate: THREE.Group | null = null;

function spearProp(): THREE.Group {
  // Built once and cloned per man, exactly as the pack props are: a clone
  // shares its template's geometry and materials, and sharing is what
  // makes a prop free to throw away. #removeVisual disposes only what a
  // unit uniquely owns (its skeleton) precisely because props do not own
  // anything; four geometries and four materials built per spearman would
  // have bled VRAM through a war's worth of muster and death.
  if (spearTemplate) return spearTemplate.clone();
  // Named like a pack prop (the loader takes those names from the file),
  // so the fitting room can pick it out of a character.
  const g = new THREE.Group();
  g.name = 'spear';
  // Ash haft, thickening toward the butt, gripped a third of the way up.
  const shaft = toolMesh(
    new THREE.CylinderGeometry(0.062, 0.07, 2.3, 6),
    goodColors[GoodId.spear],
  );
  shaft.position.y = 0.3;
  // Leaf head, turned rather than extruded: a flat blade is what the spade
  // has, and it vanishes edge-on — a spear is seen from every side at once
  // in a melee. Steel, and the same steel the smith's spear good is
  // painted in, so the thing made in the shop is the thing carried.
  const blade = lathe(
    [
      [0, 0],
      [0.075, 0.05],
      [0.14, 0.18],
      [0.105, 0.36],
      [0.052, 0.51],
      [0, 0.62],
    ],
    goodColors[GoodId.sword],
    8,
  );
  // Flattened across the swing, the way a blade is: a full body of
  // revolution reads as a bud on a stick.
  blade.scale.z = 0.6;
  blade.position.y = 1.35;
  // Socket binding where the head is lashed on, and a butt cap that keeps
  // the shaft from ending in nothing when it is seen against the grass.
  const collar = toolMesh(
    new THREE.CylinderGeometry(0.088, 0.088, 0.12, 6),
    0x6b4e2e,
  );
  collar.position.y = 1.36;
  const butt = toolMesh(
    new THREE.CylinderGeometry(0.078, 0.078, 0.15, 6),
    goodColors[GoodId.sword],
  );
  butt.position.y = -0.79;
  g.add(shaft, blade, collar, butt);
  spearTemplate = g;
  return g.clone();
}

/** Workplace looks layered over the worker kind (profession byte). */
interface ProfLook {
  spec: KKSpec;
  /** Permanent carried tool + the WORK.* it already covers. */
  tool?: () => THREE.Group;
  toolWorkKind?: number;
  /** Extra roll about the fist for that tool (gripPose's `pitch`). */
  gripPitch?: number;
  strawHat?: boolean;
}

const PROF_LOOKS = new Map<number, ProfLook>([
  // Farmer: sun-worn tan leathers, straw hat, scythe in hand.
  [
    1,
    {
      spec: {file: 'Rogue', hide: ['Rogue_Cape'], tint: 0xc9a86a},
      tool: packScytheProp,
      toolWorkKind: 8, // WORK.mow
      gripPitch: SCYTHE_PITCH,
      strawHat: true,
    },
  ],
  // Miner: dust-grey barbarian with his pickaxe over the shoulder.
  [
    2,
    {
      spec: {file: 'Barbarian', hide: ['Barbarian_BearHat'], tint: 0x9b9084},
      tool: () => packToolProp('tools/pickaxe', 0.58, pickaxeProp),
      toolWorkKind: 2, // WORK.pickaxe
    },
  ],
]);

function makeKayKitCharacter(
  kind: number,
  profession = 0,
  owner = 0,
): {group: THREE.Group; visual: CharacterVisual} | null {
  if (!kkAssets) return null;
  const look = kind === 2 ? PROF_LOOKS.get(profession) : undefined;
  const spec = look?.spec ?? KK_SPECS.get(kind) ?? KK_SPECS.get(1)!;
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
  root.traverse(o => {
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
          tinted.color
            .lerp(new THREE.Color(clothFaction), 0.9)
            .lerp(new THREE.Color(0xffffff), 0.12);
          tinted.emissive.set(clothFaction).multiplyScalar(0.22);
        }
        kkTintMaterials.set(key, tinted);
      }
      o.material = tinted;
    }
  });

  // GLTFLoader sanitizes node names ('handslot.r' loads as 'handslotr'),
  // so look up both spellings.
  const boneOf = (bone: string): THREE.Object3D | undefined =>
    root.getObjectByName(bone) ??
    root.getObjectByName(bone.replace(/[^\w-]/g, ''));

  // Pack props are authored for the rig's handslot bones — identity drop-in.
  const slot = (
    bone: string,
    file: string | undefined,
    offset?: [number, number, number],
    rot?: [number, number, number],
  ) => {
    if (!file) return;
    const prop = kkAssets!.props.get(file);
    const anchor = boneOf(bone);
    if (!prop || !anchor) {
      console.warn(
        `[characters] slot miss: prop=${file}:${!!prop} bone=${bone}:${!!anchor}`,
      );
      return;
    }
    const inst = prop.clone();
    if (offset) inst.position.set(...offset);
    if (rot) inst.rotation.set(...rot);
    anchor.add(inst);
    return {inst, anchor};
  };
  const rightHand = slot('handslot.r', spec.right, undefined, spec.rightRot);
  if (rightHand && spec.rightWorkKind !== undefined) {
    rightHand.inst.userData.workKind = spec.rightWorkKind;
    rightHand.inst.userData.workOnly = true;
    rightHand.inst.visible = false;
  }
  // Hand-built weapons ride the same bone in the same frame as pack props.
  let builtWeapon: THREE.Group | undefined;
  if (spec.rightBuilt) {
    const anchor = boneOf('handslot.r');
    if (anchor) {
      builtWeapon = spec.rightBuilt();
      anchor.add(builtWeapon);
    }
  }
  slot('handslot.l', spec.left, undefined, spec.leftRot);
  slot('chest', spec.back, [0, 0, -0.14]);

  const s = char.scale * (spec.scale ?? 1);

  // --- Gait paced by ground speed ----------------------------------------
  // The sim slides this unit at a fixed tiles/sec; the clips were authored
  // for a rig covering ground at their own rate, which scales with the
  // body (a shorter serf takes shorter strides). Left at that rate the
  // feet skate — visibly so since TARGET_HEIGHT came down — so each gait
  // plays at sim speed / natural speed, held inside GAIT_RATE's band.
  // The clip itself stays a wardrobe choice: soldiers jog, everyone else
  // walks. Fully honest pacing was tried — a serf's 1.8 tiles/sec is two
  // body-heights a second, properly a run — and a village of serfs on the
  // run clip read as a village fleeing a fire. So villagers keep the walk
  // at a capped hustle, and the glide left over is accepted as the same
  // RTS stylization that oversizes them in the first place.
  // The base kind speed only seeds the rate — the real thing also wears
  // road/trail multipliers and the serfSpeed tech, so sceneSync keeps
  // re-feeding the speed it observes (setGaitSpeed).
  const simSpeed = KIND_SPEED.get(kind) ?? UNIT_DEFS[UnitTypeId.worker].speed;
  const walkNat = kkAssets.gaitSpeeds.walk * s;
  const jogNat = kkAssets.gaitSpeeds.jog * s;
  const gait: Gait = spec.jog ? GaitNs.jog : GaitNs.walk;

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
  const hand = boneOf('handslot.r');
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
      proceduralTool = gripPose(look.tool(), look.gripPitch ?? 0);
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
  for (const key of ANIM_KEYS) {
    let name =
      key === AnimKeyNs.attack && spec.attackClip
        ? spec.attackClip
        : KK_CLIP_NAMES[key];
    // A jogging carrier gets the run-legged carry composite.
    if (
      key === AnimKeyNs.carry &&
      gait === GaitNs.jog &&
      kkAssets.clips.has('Carry_Jog')
    )
      name = 'Carry_Jog';
    const clip = kkAssets.clips.get(name);
    if (!clip) continue;
    const action = mixer.clipAction(clip);
    if (key === AnimKeyNs.death) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true; // hold the final crumpled pose
    }
    actions.set(key, action);
  }

  const visual: CharacterVisual = {
    mixer,
    actions,
    current: null,
    gait,
    gaitNat: {walk: walkNat, jog: jogNat},
    gaitSpeed: 0,
    ranged: spec.ranged ?? false,
    carryAnchor,
    toolAnchor,
    toolCustom,
    defaultTool: proceduralTool ?? rightHand?.inst ?? builtWeapon,
    toolKind: 0,
  };
  setGaitSpeed(visual, simSpeed);
  return {group, visual};
}

/**
 * The clip a gait plays. Gait and AnimKey are separate enums whose numbers
 * collide (GaitNs.walk === AnimKeyNs.idle, GaitNs.jog === AnimKeyNs.walk),
 * so a gait must never be handed to playAnimation raw — when the members
 * were strings the two unions overlapped and 'walk' was both, which is
 * exactly how every walking serf came to play the idle clip.
 */
export function gaitAnimKey(gait: Gait): AnimKey {
  return gait === GaitNs.jog ? AnimKeyNs.jog : AnimKeyNs.walk;
}

/**
 * Playback-rate band per gait. The walk's cap is the one knob for how much
 * hustle a villager shows: a serf's true speed ratio is ~6x, so his walk
 * rides this cap flat-out and everything above it is the accepted glide.
 * Tuned by eye: 1.5x read as everyone hurrying somewhere; 1.3x is a
 * purposeful working walk (past ~2x the legs read as comedy). The jog
 * band is wide enough that soldiers track their true speed — 1.2x to 1.8x
 * across kinds — before a leg-blur cap.
 */
const GAIT_RATE: Record<Gait, {lo: number; hi: number}> = {
  [GaitNs.walk]: {lo: 0.85, hi: 1.3},
  [GaitNs.jog]: {lo: 0.8, hi: 1.8},
};

/**
 * Pace the gaits for a body covering `speed` world units/sec: each clip
 * plays at speed / its natural ground speed, held inside GAIT_RATE (see
 * the gait pacing note in makeKayKitCharacter). Seeded there with the
 * kind's base sim speed; sceneSync re-feeds the speed it actually observes
 * between publishes, which is where roads, trails and the serfSpeed tech
 * show up. Deadbanded so steady cruising writes nothing; playAnimation's
 * reset() leaves timeScale alone, so rates survive clip switches.
 */
export function setGaitSpeed(visual: CharacterVisual, speed: number): void {
  if (Math.abs(speed - visual.gaitSpeed) < visual.gaitSpeed * 0.02) return;
  visual.gaitSpeed = speed;
  const set = (key: AnimKey, g: Gait, nat: number): void => {
    const action = visual.actions.get(key);
    if (!action) return;
    const band = GAIT_RATE[g];
    action.timeScale = nat > 0 ? clamp(speed / nat, band.lo, band.hi) : 1;
  };
  set(AnimKeyNs.walk, GaitNs.walk, visual.gaitNat.walk);
  set(AnimKeyNs.jog, GaitNs.jog, visual.gaitNat.jog);
  set(
    AnimKeyNs.carry,
    visual.gait,
    visual.gait === GaitNs.jog ? visual.gaitNat.jog : visual.gaitNat.walk,
  );
}

/**
 * Load the character + animation library once. Resolves false (and the
 * renderer falls back to procedural people) if the assets can't load.
 */
let charLoading: Promise<boolean> | null = null;

/**
 * Fetch and prepare the character pack, once per page — the wardrobe, a
 * match and the field guide all ask for it, and rebuilding the rig cache
 * under a screen already using it re-fetches ~7 MB for nothing. A failure
 * is not cached, so the next screen to ask retries.
 */
export function loadCharacterAssets(): Promise<boolean> {
  charLoading ??= loadKayKitCharacters().then(
    ok => {
      if (!ok) charLoading = null;
      return ok;
    },
    (err: unknown) => {
      charLoading = null;
      throw err;
    },
  );
  return charLoading;
}

export function charactersReady(): boolean {
  return kkAssets !== null;
}

/** A boot sole's ground measurements, in world units. */
export interface Sole {
  width: number;
  length: number;
  /** How far the foot stands off the body's centerline — the natural
   * straddle of a walker's two feet about their line of march. */
  offset: number;
}

/**
 * The serf's left sole, measured off the Rogue's boot (the serf body):
 * its foot-boned vertices projected onto the ground and scaled to world
 * units — so the footprint layer stamps prints the size and stance of the
 * boots the villagers actually wear. Every pack character stands on the
 * same rig with near-identical boots, so one sole serves all kinds. Null
 * until the character assets load.
 */
export function serfSole(): Sole | null {
  const char = kkAssets?.chars.get('Rogue');
  if (!char) return null;
  // Boot vertices: dominant skin weight on the left foot or toe bones.
  // (GLTFLoader may sanitize 'foot.l' to 'footl'; match both.)
  const pts: [number, number, number][] = [];
  char.scene.traverse(o => {
    if (!(o instanceof THREE.SkinnedMesh)) return;
    const geo = o.geometry;
    const pos = geo.getAttribute('position');
    const jix = geo.getAttribute('skinIndex');
    const wts = geo.getAttribute('skinWeight');
    if (!pos || !jix || !wts) return;
    const footJoints = new Set<number>();
    o.skeleton.bones.forEach((b, i) => {
      if (/^(foot|toes)\.?l$/.test(b.name)) footJoints.add(i);
    });
    if (footJoints.size === 0) return;
    for (let v = 0; v < pos.count; v++) {
      let best = 0;
      for (let k = 1; k < 4; k++) {
        if (wts.getComponent(v, k) > wts.getComponent(v, best)) best = k;
      }
      if (!footJoints.has(jix.getComponent(v, best))) continue;
      pts.push([pos.getX(v), pos.getY(v), pos.getZ(v)]);
    }
  });
  if (pts.length < 8) return null;
  // Only the lower part of the boot prints — the ankle shaft overhangs it.
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    y0 = Math.min(y0, p[1]);
    y1 = Math.max(y1, p[1]);
  }
  const cut = y0 + (y1 - y0) * 0.45;
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  let n = 0;
  for (const p of pts) {
    if (p[1] > cut) continue;
    n++;
    x0 = Math.min(x0, p[0]);
    x1 = Math.max(x1, p[0]);
    z0 = Math.min(z0, p[2]);
    z1 = Math.max(z1, p[2]);
  }
  if (n < 8) return null;
  const s = char.scale;
  return {
    width: (x1 - x0) * s,
    length: (z1 - z0) * s,
    offset: (Math.abs(x0 + x1) / 2) * s,
  };
}

/**
 * A dressed, animated character for one unit. Returns null until assets
 * are loaded (callers fall back to the procedural person).
 */
export function makeCharacter(
  kind: number,
  profession = 0,
  owner = 0,
): {group: THREE.Group; visual: CharacterVisual} | null {
  return makeKayKitCharacter(kind, profession, owner);
}

/** Crossfade to the clip for this key; no-op when already playing it. */
export function playAnimation(
  visual: CharacterVisual,
  key: AnimKey,
  offset: number,
): void {
  if (visual.current === key) return;
  const next = visual.actions.get(key) ?? visual.actions.get(AnimKeyNs.idle);
  if (!next) return;
  const prev =
    visual.current !== null ? visual.actions.get(visual.current) : undefined;
  next.reset();
  // Desync the crowd: start loops at a per-unit offset.
  next.time = offset * next.getClip().duration;
  next.play();
  if (prev && prev !== next) {
    prev.crossFadeTo(next, 0.16, false);
  } else if (!prev) {
    // No known predecessor: `current` was nulled by the off-screen cull,
    // and the unit's state may have changed while nobody was sampling its
    // mixer. Whatever was playing at the cull is still enabled at full
    // weight — a fade only ever reaches the clip recorded in `current` —
    // so without this sweep a soldier whose fight ended off-screen came
    // back blending the attack loop into idle, hacking at thin air for
    // the rest of his life. Stopping (not fading) is safe: the pop this
    // hides happens on the unit's first frame back on screen, where a
    // restart already reads as intended (see the cull note in sceneSync).
    for (const action of visual.actions.values()) {
      if (action !== next) action.stop();
    }
  }
  visual.current = key;
}

/** Every animation key, in id order — what the clip loader walks. */
export const ANIM_KEYS: readonly AnimKey[] = [
  AnimKeyNs.idle,
  AnimKeyNs.walk,
  AnimKeyNs.jog,
  AnimKeyNs.attack,
  AnimKeyNs.shoot,
  AnimKeyNs.throwing,
  AnimKeyNs.work,
  AnimKeyNs.pickaxe,
  AnimKeyNs.hammer,
  AnimKeyNs.dig,
  AnimKeyNs.tend,
  AnimKeyNs.draw,
  AnimKeyNs.fish,
  AnimKeyNs.carry,
  AnimKeyNs.carryIdle,
  AnimKeyNs.death,
  AnimKeyNs.mow,
];
