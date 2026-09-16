import * as THREE from 'three';
import {LOOP_CUES} from '../audio/animCues';
import type {CueId} from '../audio/cues';
import type {BuildingSnap} from '../protocol/messages';
import * as StaffingState from '../protocol/staffingStateEnum.ts';
import type {Enum} from '../shared/enum.ts';
import {tileIdx} from '../shared/grid';
import {hash2} from '../shared/math';
import * as BuildingState from '../sim/buildingStateEnum.ts';
import {buildingDef} from '../sim/defs/buildings';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import {GOODS} from '../sim/defs/goods';
import {UNIT_DEFS} from '../sim/defs/units';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum.ts';
import {WATER_LEVEL} from '../sim/map';
import * as AnimKey from './animKeyEnum.ts';
import {crossedRelease} from './arrows';
import {glbYardProp, glbYardRock, makeGlbBuilding} from './assets';
import {CAMERA_YAW, type ViewBounds} from './cameraRig';
import {
  makeCharacter,
  playAnimation,
  updateBow,
  updateGrip,
  type CharacterVisual,
} from './characters';
import type {FogQuery} from './fogOfWar';
import type {HeightField} from './heightField';
import {eachMaterial, mapMaterials} from './materials';
import {
  makeGhostModel,
  makePileProp,
  makeSiteFrame,
  PILE_SCALE,
  makeRoadPile,
  SITE_FRAME_H,
} from './models';
import {
  harvestTrainingRig,
  ownTrainingMaterials,
  setTrainingLevel,
  TRAINING_NODES,
  type TrainingRig,
} from './procTraining';
import {
  occluderMaterial,
  OCCLUDER_PAD,
  WALL_RENDER_ORDER,
  type OccluderBox,
} from './xrayOutline';

/** How tall a building has to stand before it can hide anybody (the pad
 * that goes with it lives with the test that reads it — see
 * occluderBoxes and OCCLUDER_PAD). */
const OCCLUDER_MIN_HEIGHT = 0.4;

/** Model nodes that reach outside the footprint their building is boxed
 * by, and so may not stamp the wall bit (see the marking in #create).
 *
 * A fishery's deck runs a couple of tiles out over open water and its
 * shoal swims off the end of it, while occluderBoxes only ever emits the
 * footprint. Marked, they would put the bit down over water no box
 * vouches for. Named rather than measured because the model names them
 * already — everything else a building carries stands within its own
 * walls. */
const BEYOND_FOOTPRINT = new Set(['fisheryPier', 'fisheryShoal']);

type BuildingState = Enum<typeof BuildingState>;
type GoodId = Enum<typeof GoodId>;

/** A built fishery's pier, in world space: the deck line from its landward
 * end to the fishing spot near the tip, plank height, and the yaw the deck
 * runs at — which is where the water is, not merely where the hut faces
 * (#measurePier). Shared with sceneSync, which walks the fisherman out
 * along it. */
export interface PierInfo {
  /** Building center, the anchor a fisherman is matched to his pier by. */
  bx: number;
  bz: number;
  baseX: number;
  baseZ: number;
  spotX: number;
  spotZ: number;
  yaw: number;
  deckY: number;
}

/** A built wheat farm's field, in world space: the mowing circuit the
 * resident farmer walks (authored into the farmstead model as named
 * marks — see makeFarmstead), the open-front entry, the plot bounds and
 * the pad's standing height. Shared with sceneSync, which walks the
 * farmer along it, scythe swinging. */
export interface FieldInfo {
  /** Building center, the anchor a farmer is matched to his field by. */
  bx: number;
  bz: number;
  /** Front-center entry: an approach from off the plot converges here
   * first, so the farmer comes in over the open front edge instead of
   * clipping the flank fences. */
  gateX: number;
  gateZ: number;
  /** The circuit in visiting order; sceneSync ping-pongs it. */
  points: {x: number; z: number}[];
  /** Plot bounds (a margin outside the circuit), for telling a walker
   * already on the field from one still parked on the ring around it. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** World height of the worked pad's top — the field's deckY. */
  padY: number;
}

/** How far below the waterline the shoal group is re-seated, in world
 * units — enough that the tallest swim circle and the fish bodies stay
 * submerged rather than breaking the surface. */
const SHOAL_DRAFT = 0.14;

/**
 * How far short of the deck's tip the fisherman stands, world units: his
 * toes stay on the planks and the line drops off the end. The fit search
 * below wants this stretch of deck over water too — the rod hangs its line
 * near plumb (characters.ts fishingPoleProp), so a hook that clears the
 * shoreline by a plank's width is a hook in the grass.
 *
 * Exported because it is what closes `PierInfo`: the spot is the only point
 * on the deck the struct carries, and the tip — the thing that must not end
 * on grass — is this much further along the yaw. The model lab's pier page
 * (tools/modelLab/_pier.ts) scores decks on both.
 */
export const PIER_SPOT_BACK = 0.4;

/**
 * The docks model's plank top over the building's own ground, in world
 * units at the authored deck length. Read off the model (0.04 of its own
 * units, ~0.05 after the decor scale) rather than measured: the pier's
 * bbox can't say, because its mooring posts top out well above the deck.
 */
const PIER_DECK_Y = 0.05;

/**
 * How far under the water plane the deck's far end wants to sit, world
 * units.
 *
 * Wetness is asked of the height field rather than of the sim's water
 * tiles, because the question is what the player sees: the terrain mesh
 * draws that field vertex for vertex (terrainMesh.ts), so the shoreline on
 * screen is exactly where it crosses WATER_LEVEL. A tile-grid answer is
 * coarser than the thing it is answering about — the first water tile's
 * landward half can still be dry ground on screen — and a deck that clears
 * the line by a hair reads as planks on the bank. A plank's depth of margin
 * is what makes it read as planks over water.
 *
 * On the handful of shores where nothing the fit can reach is this deep
 * (a shallow pond, a marshy notch), the search runs again asking only to
 * be under the surface at all: touching the water beats standing off it.
 */
const PIER_DRAFT = 0.15;

/** One step of the deck's aim, radians. */
const PIER_TURN_STEP = Math.PI / 12;
/** How far either way the aim may swing: four steps, so 60 degrees. */
const PIER_TURN_STEPS = 4;
/** One step off the deck's authored length, world units. */
const PIER_TRIM_STEP = 0.25;
/** How much of the deck may be given up: four steps, so a whole tile. */
const PIER_TRIM_STEPS = 4;

/**
 * The deck fits `#measurePier` tries, least intrusive first: `turn` in
 * 15-degree steps off the building's facing (turning the WHOLE building —
 * the deck stays square to the hut), `trim` in quarter-tile steps
 * off the deck's authored length.
 *
 * Both are needed because neither the sim's facing nor the model's reach is
 * a promise about water. `Building.facing` is a quarter turn (world.ts
 * waterFacing) — on a shore that runs anywhere but square to the grid, the
 * nearest water is off that axis and the authored deck ends on grass. And
 * placement only promises water within a tile of the footprint
 * (`nearWater`), while the authored deck runs nearly two tiles past it, so
 * a narrow inlet or a pond edge is something the deck can stride clean over
 * and land dry on the far bank.
 *
 * One step of either counts the same, so the search gives up a quarter tile
 * of planking as readily as it turns the deck 15 degrees. The authored
 * placement is first in the list and wins whenever it already reaches
 * water, which on generated maps is a little under three sites in five;
 * past a 60-degree turn the deck stops reading as one that belongs to the
 * hut, and the sites that far off the facing are the ones a trim answers.
 * (tools/modelLab/_pier.html renders the result on generated shoreline —
 * it is where these numbers come from and where a change to them is
 * judged.)
 */
const PIER_FITS: readonly {turn: number; trim: number}[] = (() => {
  const fits: {turn: number; trim: number}[] = [];
  for (let turn = -PIER_TURN_STEPS; turn <= PIER_TURN_STEPS; turn++)
    for (let trim = 0; trim <= PIER_TRIM_STEPS; trim++) fits.push({turn, trim});
  // Total distortion first — with a turn half again as heavy as a trim,
  // because a turn swings the whole building while a trim only shortens
  // planks — then the smaller turn (a hut that still points where the sim
  // said is less surprising), east before west as the final tiebreak.
  return fits.sort(
    (a, b) =>
      1.5 * Math.abs(a.turn) + a.trim - (1.5 * Math.abs(b.turn) + b.trim) ||
      Math.abs(a.turn) - Math.abs(b.turn) ||
      b.turn - a.turn,
  );
})();

/**
 * The scale a ghost site starts at, when there is no GLB to clip and the
 * building grows out of the ground instead. Its drawn height is this share
 * of the model's own, which is what makes heightOf's arithmetic work.
 */
const GHOST_SEED_SCALE = 0.22;

/** Who mans a guard tower's roof. */
const ARCHER_KIND = UnitTypeId.archer;
/** The levy on the roof wears the serf it is. */
const LEVY_KIND = UnitTypeId.serf;

/**
 * Where in the Throw clip the stone leaves the hand, as a phase 0..1 —
 * the levy's release, next to the bow's in LOOP_CUES. Measured the way
 * the animCues phases are (tools/modelLab/animImpacts.mjs curve
 * Rig_Medium_General.glb Throw handslot.r): the wind-up ends at 0.41,
 * then the hand whips forward, crossing overhead at 0.475 with its
 * swing speed peaking right beside it (13.9 rig units/s at 0.487) —
 * the stone is gone as the hand comes over the top.
 */
const THROW_RELEASE = 0.48;

/**
 * How far this building's volley visibly reaches — the garrison rule's
 * own numbers (the levy's stones, or the archer's bow plus the height
 * bonus: volleyOf's arithmetic in sim/systems/combat.ts), plus half the
 * footprint, because the sim measures reach from the footprint's edge
 * and the render measures from the roof post near its middle. 0 for
 * anything without a garrison, which is what gates the volley watch off.
 */
function volleyRangeOf(b: BuildingSnap): number {
  const rule = buildingDef(b.type).garrison;
  if (!rule) return 0;
  const reach =
    b.levied === true
      ? rule.levy.range
      : (UNIT_DEFS[rule.unit].combat?.range ?? 0) + rule.rangeBonus;
  if (reach <= 0) return 0;
  return reach + Math.max(b.w, b.h) / 2;
}

/** Reused for the post->root coordinate hop; buildings do not move. */
const SCRATCH_POS = new THREE.Vector3();

/**
 * The farmstead's walk marks, gate first then the circuit in authored
 * order. By name rather than child order: normalize and the decor pass
 * both re-parent, and a clone's traversal order is nothing to build a
 * route on.
 */
function harvestMowMarks(model: THREE.Object3D): THREE.Object3D[] {
  const gate = model.getObjectByName('mowGate');
  if (!gate) return [];
  const path: {i: number; o: THREE.Object3D}[] = [];
  model.traverse(o => {
    const m = /^mowPath(\d+)$/.exec(o.name);
    if (m) path.push({i: Number(m[1]), o});
  });
  path.sort((a, b) => a.i - b.i);
  return [gate, ...path.map(p => p.o)];
}

/**
 * Drop a cloned character and free what it uniquely owns on the GPU.
 *
 * Every SkeletonUtils.clone gets its own Skeleton, and a skeleton lazily
 * allocates a float DataTexture of bone matrices at first render — so
 * removing a roof archer without this leaks one texture per man, and a
 * tower manned, emptied and manned again over a long match bleeds VRAM.
 * (Geometry and materials are shared with the loaded assets and must not
 * be touched.) The same rule sceneSync applies to its unit visuals.
 */
function disposeTree(group: THREE.Object3D): void {
  group.traverse(o => {
    if (o instanceof THREE.SkinnedMesh) o.skeleton.dispose();
  });
}

/**
 * The free lane nearest the middle, counting outward: 0, +1, -1, +2, -2…
 *
 * The first good a building holds stands squarely at its door, and each
 * later kind flanks what is already there — which is the whole point of
 * lanes rather than a centered row: the row would have had to shuffle.
 */
function freeLane(taken: Set<number>): number {
  if (!taken.has(0)) return 0;
  for (let step = 1; ; step++) {
    if (!taken.has(step)) return step;
    if (!taken.has(-step)) return -step;
  }
}

interface BuildingVisual {
  root: THREE.Group;
  state: BuildingState;
  /** What it is, so a visual can be dropped by kind — see forgetMonuments. */
  type: BuildingSnap['type'];
  frame?: THREE.Group;
  model: THREE.Group;
  /** Warcraft-style rise: a world-space clip plane reveals the model
   * bottom-up as materials arrive and progress ticks. */
  clip?: {plane: THREE.Plane; height: number; baseY: number};
  /** Model height above ground, for floating the hp bar. */
  topY: number;
  /** A site's own marked meshes, so the stamping can be turned on and off
   * as it rises (see #syncWall). Absent on a finished building, whose
   * marked materials are shared with every other of its type and are
   * never turned off. */
  wall?: THREE.Mesh[];
  /** Half the footprint, in tiles — the box the x-ray outlines test a
   * unit's line of sight against (see occluderBoxes). */
  halfW: number;
  halfD: number;
  /**
   * A road: flat ground once it is laid, and a thing units walk along
   * rather than a thing anyone clicks. Its scaffolding is not worth a pick
   * box — see heightOf. Salvage piles carry the flag too, for the same
   * ground-level treatment.
   */
  road: boolean;
  /** A salvage pile: no model, only piles — and no collapse when it
   * clears, because the goods left one by one on serfs' shoulders. */
  salvage: boolean;
  /** The tiles outside its own footprint this building is drawn over, as
   * keys into #drawn — hers to give back when she comes down. */
  drawn: number[];
  /** The model's own box, in root space: what those tiles were read off.
   * Kept so that a re-claim for a pile at the door does not have to walk
   * every vertex of the building again. */
  modelBox: THREE.Box3;
  /** Latest hp fraction, for hover bars on healthy buildings. */
  pct: number;
  /** Physical stock piles against the front wall. */
  piles?: THREE.Group;
  /** Serialized pile contents — rebuilt only when the counts change. */
  pileKey: string;
  /** Which lane each good's stack stands in, kept across rebuilds so a
   * stack never slides sideways because a *different* good arrived. */
  pileLanes: Map<GoodId, number>;
  /** The well's windlass, spun per frame while the well is staffed. */
  crank?: THREE.Object3D;
  /** The mill's sail assembly, turned per frame while the mill grinds. */
  fan?: THREE.Object3D;
  /** Current sail speed, eased toward grinding/idle — heavy sails spin up
   * and coast down instead of snapping with the batch boundary. */
  fanSpeed: number;
  /** The flue mouth — the bakehouse's oven cap, the Smith's forge chimney
   * — harvested from the model by name ('smokeFlue'). Where the smoke
   * stands while a batch is on the fire. */
  flue?: THREE.Object3D;
  /** The smoke column over that flue: built the first time the fire
   * lights, then recycled — a post that never works never pays for it. */
  smoke?: {group: THREE.Group; puffs: SmokePuff[]};
  /** Smoke thickness 0..1, eased toward working/idle — a fire lights and
   * banks rather than snapping with the batch boundary (see #smokeFrame). */
  smokeLevel: number;
  shoal?: THREE.Object3D;
  /** The fishery's pier decor — the deck the fisherman walks out on. */
  pier?: THREE.Object3D;
  /** Measured deck line, cached: measuring may also swing the whole
   * building toward the water, and that must happen exactly once. */
  pierLine?: PierInfo;
  /** The farm's authored walk marks: gate first, then the circuit in
   * visiting order. Empty for everything without a field. */
  mowMarks: THREE.Object3D[];
  /** Measured circuit, cached like pierLine — buildings do not move. */
  fieldInfo?: FieldInfo;
  /** Quarter turns from "front faces +z" (shore buildings turn to their
   * water); kept for deriving where the pier runs. */
  facing: number;
  staffed: boolean;
  /** Latest BuildingSnap.working — a convert batch actually ticking. */
  working: boolean;
  /** Longest footprint side, for sizing the teardown dust. */
  span: number;
  /** Empty marks on a manned building's roof, harvested from the model by
   * name — where the garrison stands. Empty for everything unmanned. */
  posts: THREE.Object3D[];
  /** The archers currently standing on those posts, one per man the sim
   * says is inside. Built here rather than fed from the unit stream:
   * a garrisoned soldier is not a unit any more (he was consumed into the
   * building), so there is nothing in the SAB to place. `shootT` is each
   * man's own release watch — his clip's time last frame, held only while
   * he is loosing (the same contract as UnitVisual.shootT in sceneSync). */
  manned: {group: THREE.Group; char: CharacterVisual | null; shootT?: number}[];
  /** Latest BuildingSnap.firing — the roof draws instead of idling. */
  firing: boolean;
  /** Who this building shoots for — the volley target pick needs a side. */
  owner: number;
  /** How far the roof's volley visibly reaches (volleyRangeOf); tracks the
   * garrison kind, so it moves when a levy is relieved by archers. */
  volleyRange: number;
  /** Latest BuildingSnap.levied: villagers on the roof, not archers. Kept
   * so a relief — the levy going down as soldiers come up — rebuilds the
   * figures instead of leaving serfs standing in an archer's post. */
  levied: boolean;
  /** The lit windows, the brazier, the banner and the yard — harvested off
   * the model of a building that trains, absent on every other one (see
   * procTraining.ts). */
  train?: TrainingRig;
  /** The materials that rig's glow rides on, cloned per building so one
   * barracks' fire is not every barracks' fire. Freed with the visual. */
  trainMats?: THREE.Material[];
  /** Is a course actually running here — a started order at the barracks or
   * the range, a serf being hired at the castle. */
  training: boolean;
  /** How lit the cue is, 0..1, eased toward that. The same treatment the
   * chimney smoke gets and for the same reason: a fire is banked and a
   * banner is hauled down, and neither happens between two frames. */
  trainLevel: number;
}

/** One yard-stock entry: what good, worn as which look, standing where. */
interface YardStyle {
  good: GoodId;
  /** Pack prop stacks (lumber, cut stone)... */
  prop?: string;
  /** ...or spoil boulders tinted to the ore. */
  rock?: number;
  /** Normalized template coords: x, z, yaw, per-spot scale factor. */
  spots: [number, number, number, number][];
  /** Template-space size of the biggest stack or boulder. */
  size: number;
  /** Goods per stack shown. */
  per: number;
}

/** The mine model's three cut-out boulder seats (see the surgery in
 * assets.ts) — shared by the quarry and all three mines. */
const MINE_SPOTS: [number, number, number, number][] = [
  [-0.218, 0.245, 0.4, 1],
  [0.177, 0.337, -0.3, 0.52],
  [-0.325, 0.274, 1.1, 0.54],
];

const HP_BAR_W = 1.1;

/** Grinding-speed sail rotation, rad/s — brisk enough to read as working
 * at village zoom, slow enough to stay a windmill and not a propeller. */
const MILL_FAN_SPEED = 1.5;

/** One low-poly ball shared by every dust puff; scaled per puff. */
const PUFF_GEO = new THREE.IcosahedronGeometry(1, 0);

/** One puff of chimney smoke (the bakery's oven, the Smith's forge). `t`
 * is its life phase 0..1 — born at the flue, gone about a unit up.
 * Negative = not yet born: the births are staggered so a lighting fire's
 * column climbs out of the flue one puff at a time instead of appearing
 * full-grown in the air. */
interface SmokePuff {
  mesh: THREE.Mesh;
  t: number;
  /** Per-puff hash seed, for the sway and tumble. */
  seed: number;
}

/** How many puffs stand in one chimney's column at a time. */
const SMOKE_PUFFS = 6;
/** One puff's life, seconds. With six puffs a fresh one leaves the flue
 * about twice a second — a steady breathing pace, not a house fire. */
const SMOKE_LIFE = 2.6;
/** How far a puff rises over its life, world units. */
const SMOKE_RISE = 0.95;

/** Scratch color for hp tinting — callers copy out of it immediately. */
const HP_COLOR = new THREE.Color();

function hpColor(pct: number): THREE.Color {
  return HP_COLOR.setHSL(0.33 * Math.max(0, Math.min(1, pct)), 0.8, 0.45);
}

// Shared across every bar (like the unit path in sceneSync): only the fg
// material is per-bar, because #styleBar tints its color per building.
const HP_BG_GEO = new THREE.PlaneGeometry(HP_BAR_W, 0.13);
const HP_FG_GEO = new THREE.PlaneGeometry(HP_BAR_W - 0.06, 0.07);
const HP_BG_MAT = new THREE.MeshBasicMaterial({
  color: 0x140f0a,
  depthTest: false,
  // Transparent at full opacity, for the queue rather than for the look —
  // see hpBarMaterial in sceneSync.ts. An opaque bar draws before every
  // transparent thing on the map whatever its renderOrder, and a ground
  // decal drawn after it paints over a bar that wrote no depth.
  transparent: true,
  userData: {noFog: true},
});

/** White, so each bar's per-instance colour comes through unmultiplied. */
const HP_FG_MAT = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  depthTest: false,
  transparent: true,
  userData: {noFog: true},
});

/** Bar scratch: one instance matrix, composed per bar per rebuild. */
const BAR_POS = new THREE.Vector3();
const BAR_OFFSET = new THREE.Vector3();
const BAR_SCALE = new THREE.Vector3(1, 1, 1);
const BAR_MATRIX = new THREE.Matrix4();
/** Stands in for the camera's orientation before boot has handed one
 * over — the rig's own default line, so it cannot go stale the next time
 * that line moves. A frame with the real camera in hand rebuilds off it
 * regardless (see frame). */
const BAR_FALLBACK_QUAT = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(0, 1, 0),
  CAMERA_YAW,
);
/**
 * How near two orientations must be to count as the same one.
 *
 * Not an exact compare, which is what this was and what made it wrong.
 * #apply builds the camera's quaternion with lookAt, from a position that
 * is the target plus an offset — so panning subtracts two numbers that
 * have grown apart and hands back a direction whose last bits wander,
 * even though the angle has not changed at all. Measured, seventy per
 * cent of pan frames came out "different" at an angle of exactly zero,
 * and every one of them rewrote every bar in the settlement.
 *
 * |dot| is cos of half the angle between them, so this is about five
 * thousandths of a degree — four orders clear of the float noise below it
 * and four clear of the smallest turn the ease will make above it.
 */
const BAR_QUAT_EPS = 1e-12;
/** Bars are rare (hurt, hovered or selected), so start small and grow. */
const BAR_CAPACITY_MIN = 32;

/**
 * Marks a branch of a building's tree as no part of its shape — see
 * silhouetteT. Set on the thing hung off the root, and the whole branch
 * under it goes with it.
 */
const PICK_IGNORE = 'noPick';

/** Scratch for #reclaimDrawn — a pile rebuild is a common event. */
const CLAIM_BOX = new THREE.Box3();
const PILE_BOX = new THREE.Box3();

/**
 * Is a course actually running in this building — the cue procTraining's
 * rig answers to.
 *
 * A queue is not a course: an order waiting on a sword nobody has forged
 * yet is exactly the state a player wants told apart from four knights on
 * the fire, so it is the STARTED order that counts (the same `started` the
 * card's progress bar reads). The castle's own course is its serf hire,
 * which has no queue of its own to look into — a hire in flight is what
 * `hireQueue` means.
 *
 * Paused kills it outright: a paused barracks' clock is frozen and its
 * windows have no business being lit.
 */
function isTraining(b: BuildingSnap): boolean {
  if (b.paused === true) return false;
  if (b.trainQueue?.some(q => q.started) === true) return true;
  return (b.hireQueue ?? 0) > 0;
}

/** Whether `o` hangs somewhere under `of` — itself included. */
function descends(o: THREE.Object3D, of: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = o; n; n = n.parent) {
    if (n === of) return true;
  }
  return false;
}

/**
 * The meshes of a building that are the building: drawn, and built into it
 * rather than merely standing in its air (see PICK_IGNORE).
 *
 * Gathered before the ray is cast rather than sieved out of its hits
 * afterwards, because a raycaster tests the triangles of everything it is
 * handed and only then reports what it met. The roof watch is the reason
 * the difference matters: those are skinned meshes, and skinned triangles
 * are the dearest kind there are — a hover over a manned tower would pay
 * for every one of them to learn they are not the tower.
 *
 * A raycast also reaches what the camera does not, since three tests
 * geometry and never visibility: an unlit puff or a part the model keeps
 * hidden would be as clickable as a wall.
 */
function collectPickable(o: THREE.Object3D, out: THREE.Object3D[]): void {
  if (!o.visible || o.userData[PICK_IGNORE] === true) return;
  if (o instanceof THREE.Mesh) out.push(o);
  for (const child of o.children) collectPickable(child, out);
}

/**
 * Mirrors the building list into the scene. Sites show a timber frame with
 * the real building rising out of it half-built (clip-plane reveal) while a
 * peasant hammers away; completion swaps in the solid model. Without loaded
 * GLB assets it falls back to the ghost-scale-up look.
 */
export class BuildingSync {
  #scene: THREE.Scene;
  #heights: HeightField;
  #visuals = new Map<number, BuildingVisual>();
  /** Every damage bar, batched — see #rebuildHpBars. Created on first use
   * and regrown as the settlement takes more hits at once. */
  #hpBg?: THREE.InstancedMesh;
  #hpFg?: THREE.InstancedMesh;
  /** The camera's live orientation, for screen-parallel hp bars (set at
   * boot; the rig turns this very quaternion). */
  cameraQuaternion: THREE.Quaternion | null = null;
  /** The orientation the standing bars were built with. They are instanced
   * — the quaternion is baked into each matrix at rebuild — and a rebuild
   * only happens when the roster or the highlight changes. Neither of
   * those is a camera turn, so without this the bars would hold the angle
   * they were built at while the world swung round them. */
  #hpQuat = new THREE.Quaternion();
  /** Fog test; enemy buildings hide until their ground has been explored. */
  #fog: FogQuery | null = null;
  /**
   * Highest roofline raised so far, as an absolute elevation — where the
   * pointer's pick walk gives up (see screenToBuilding). Absolute, because
   * a keep on a ridge reaches higher over a valley than its own height says.
   * A high-water mark: it grows with the settlement and never shrinks,
   * because a razed keep only costs the walk a couple of probes through
   * empty air, where re-scanning every visual to reclaim them would cost
   * more, every raze.
   */
  #ceiling = Number.NEGATIVE_INFINITY;
  /**
   * Tile -> the buildings drawn over it from off their own plots. The
   * sim's map says which building *stands* on a tile, and for the pointer
   * that is not the same question: a fishery's jetty runs a good two tiles
   * out over the water (assets.ts PIER_TILES), drawn on ground the
   * footprint never claims. Without this the walk finds no candidate out
   * there and a click on the planks reads as a click on the lake.
   *
   * Every claimant, not the first: two jetties can cross the same water —
   * a pier reaches 2.54 tiles and placement only holds a ring of one — and
   * a tile that named one of them would hide the other from the trace, and
   * then go empty the moment the one it named came down.
   */
  #drawn = new Map<number, number[]>();
  /** Reused by silhouetteT: a pick runs every frame the pointer moves, and
   * a fresh raycaster and hit list each would be an allocation a frame. */
  /** Seconds of drawn time, for the cues whose motion is periodic rather
   * than integrated: a barracks picked up mid-drill joins the beat the
   * yard is already on instead of starting its own (see
   * setTrainingLevel). */
  #now = 0;
  #pickRay = new THREE.Raycaster();
  #pickHits: THREE.Intersection[] = [];
  #pickMeshes: THREE.Object3D[] = [];
  /**
   * Presentation cue channel, injected from main. Every call is guarded
   * on `v.root.visible`: unlike sceneSync, this loop does NOT skip fogged
   * buildings (they stay in the scene, merely invisible), so an unguarded
   * cue here would announce construction inside unexplored enemy ground —
   * a maphack by ear, the exact leak the fog exists to close.
   */
  onCue: ((cue: CueId, x: number, z: number) => void) | null = null;

  /**
   * Volley channel, injected from main: fired the frame a roof figure's
   * clip crosses its release — bow or measured throw — with where the
   * man stands (feet, world space, roof height included), whose side he
   * shoots for, how far his volley reaches, and whether he is levy (a
   * lobbed stone) rather than an archer (an arrow). The receiver picks
   * the target and flies the projectile: which enemy the tower actually
   * shot never reaches the client, so the pick is render-side (see
   * SceneSync.nearestEnemyInto). Same visibility guarantee as onCue —
   * the roof loop below only runs for buildings on a lit, on-camera
   * patch of ground.
   */
  onVolley:
    | ((
        x: number,
        y: number,
        z: number,
        owner: number,
        range: number,
        levied: boolean,
      ) => void)
    | null = null;

  setFog(fog: FogQuery): void {
    this.#fog = fog;
  }

  /**
   * How tall this building stands right now, in world units above its own
   * base — what the pointer picks against, so that clicking a castle's
   * towers picks the castle rather than reading through it to the ground
   * behind. A site answers with what it has raised so far, not with the
   * building it will be: half a keep is half a keep to the eye, and to the
   * pointer. Its frame counts too, and early on it is all there is —
   * scaffolding you can see is scaffolding you can click.
   */
  heightOf(id: number): number {
    const v = this.#visuals.get(id);
    if (!v) return 0;
    // A road is ground. Its site frame stands 0.7 up for the twenty ticks
    // it takes to lay, and roads are laid in long chains along the very
    // ground people order units down — a pick box on each would hang a
    // wall of them over the route. Nobody means to click a road anyway.
    if (v.road) return 0;
    // Scaffolding you can see is scaffolding you can click, so the pick
    // box never falls below the frame. The occluders take the bare
    // #raised instead: a frame is four posts and some rails, and a man
    // behind one is not hidden by it.
    return Math.max(
      v.state === BuildingState.site ? SITE_FRAME_H : 0,
      this.#raised(v),
    );
  }

  /** How far the model itself has actually risen above its own base. */
  #raised(v: BuildingVisual): number {
    if (v.state !== BuildingState.site) return v.topY;
    return v.clip
      ? Math.max(0, v.clip.plane.constant - v.clip.baseY)
      : // The ghost site grows by scale rather than by clip, and topY was
        // measured at the seed scale — read the drawn height back off it.
        (v.topY * v.model.scale.y) / GHOST_SEED_SCALE;
  }

  /** Turn a site's wall stamping on or off. Cheap enough to call every
   * frame: both of these are state flags, not shader defines, and the
   * write is skipped while it is already where it should be.
   *
   * Both halves move together, and the render order is not the cosmetic
   * one. The bit is never cleared, so an unmarked mesh left standing in
   * the buildings' late slot is a way to inherit one: three sorts the
   * opaque queue by renderOrder and then by MATERIAL ID, so an unmarked
   * site sharing that slot can be drawn after a wall, win the depth test
   * at a pixel that wall had stamped, and leave the bit behind over
   * ground the wall no longer owns. Back in the ordinary world it draws
   * before every marked building instead, and a building that then loses
   * the depth test to it stamps nothing at all (ZFail keeps). */
  #syncWall(v: BuildingVisual, on: boolean): void {
    if (!v.wall) return;
    for (const mesh of v.wall) {
      mesh.renderOrder = on ? WALL_RENDER_ORDER : 0;
      eachMaterial(mesh, m => {
        if (m.stencilWrite !== on) m.stencilWrite = on;
      });
    }
  }

  /** The elevation this building stands on — see BuildingHeights.baseOf. */
  baseOf(id: number): number {
    return this.#visuals.get(id)?.root.position.y ?? 0;
  }

  /** The highest roofline standing — see #ceiling. */
  ceiling(): number {
    return this.#ceiling;
  }

  /**
   * The buildings drawn over this ground from off their own plots, pushed
   * onto `out` — see #drawn. The broad phase asks it beside the footprint
   * the sim keeps, so that what a building reaches out over gets a
   * candidate at all; whether the ray truly meets one is still
   * silhouetteT's to answer.
   */
  drawnAt(x: number, z: number, out: number[]): void {
    const size = this.#heights.size;
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tz < 0 || tx >= size || tz >= size) return;
    const here = this.#drawn.get(tileIdx(tx, tz, size));
    if (here) out.push(...here);
  }

  /**
   * How far along the ray this building is met as it is actually drawn, or
   * -1 where the ray passes through its box and touches nothing of it — the
   * pick's narrow phase (see screenToBuilding).
   *
   * The box a footprint and a roofline make is far more building than the
   * building: a keep is towers with sky between them, a cottage is a ridge
   * with sky over its eaves, and a click on that sky went to the box. So
   * the model itself answers, triangle by triangle. What is hung in a
   * building's air rather than built into it — its chimney smoke, the fish
   * off a fishery's pier, the archers posted on its roof — is not part of
   * the shape (see PICK_IGNORE): the smoke would hand back exactly the
   * column of dead sky this exists to give up, and a man is not a wall.
   */
  silhouetteT(id: number, origin: THREE.Vector3, dir: THREE.Vector3): number {
    const v = this.#visuals.get(id);
    // Nothing drawn has no silhouette to meet: a road is ground, and a
    // building on unscouted land is a memory the fog has not handed back
    // yet. Both fall through to the caller's ground hit, which is the pick
    // they had before any of this.
    if (!v || v.road || !v.root.visible) return -1;
    // A pick runs between frames — after a roster arrived and before the
    // render that settles the scene's matrices — so settle this one's.
    v.root.updateWorldMatrix(true, true);
    const meshes = this.#pickMeshes;
    meshes.length = 0;
    collectPickable(v.root, meshes);
    this.#pickRay.set(origin, dir);
    const hits = this.#pickHits;
    hits.length = 0;
    this.#pickRay.intersectObjects(meshes, false, hits);
    for (const hit of hits) {
      // A site is revealed bottom-up by a clip plane, and clipping is a
      // shader's business: the courses nobody has laid yet are still there
      // in the geometry for a ray to hit. Half a keep is half a keep to the
      // pointer too. The plane is installed on the model's own materials
      // and on nothing else, so the frame around it is not cut — its posts
      // stand to their full height from the first tick.
      if (
        v.clip &&
        hit.point.y > v.clip.plane.constant &&
        descends(hit.object, v.model)
      ) {
        continue;
      }
      return hit.distance;
    }
    return -1;
  }

  constructor(scene: THREE.Scene, heights: HeightField) {
    this.#scene = scene;
    this.#heights = heights;
  }

  update(buildings: BuildingSnap[]): void {
    const seen = new Set<number>();
    for (const b of buildings) {
      seen.add(b.id);
      let v = this.#visuals.get(b.id);
      if (v && v.state !== b.state) {
        // The site's scaffolding comes down and the finished building
        // stands: the one moment construction is worth hearing. Only for
        // a swap the player can see (fog guard — see onCue), and only on
        // a real transition: a boot or a resync builds every visual
        // fresh and must not arrive as a fanfare salvo.
        if (
          this.onCue &&
          v.state === BuildingState.site &&
          b.state === BuildingState.built &&
          v.root.visible
        ) {
          this.onCue('buildingComplete', b.x + b.w / 2, b.y + b.h / 2);
        }
        this.#dispose(b.id);
        v = undefined;
      }
      if (!v) {
        v = this.#create(b);
        this.#visuals.set(b.id, v);
      }
      if (b.state === BuildingState.site) {
        const p = b.progress01 ?? 0;
        if (v.clip) {
          // Reveal the build bottom-up; a sliver shows from the start so
          // fresh sites read as more than an empty frame.
          v.clip.plane.constant = v.clip.baseY + 0.08 + v.clip.height * p;
        } else {
          v.model.scale.setScalar(
            GHOST_SEED_SCALE + (1 - GHOST_SEED_SCALE) * p,
          );
        }
        // ...and the wall bit says exactly what occluderBoxes says. A
        // site is only an occluder once what has RISEN inside its frame
        // is tall enough to hide somebody; before that the boxes leave it
        // out, and the pixels have to agree — a sill lying along the
        // ground and four ankle-high posts that stamp are how a green arc
        // gets drawn under a man's boots, which is the whole artefact
        // this pass was rewritten to stop. Read off the same #raised as
        // the box, every frame, because it is what changes.
        this.#syncWall(v, this.#raised(v) >= OCCLUDER_MIN_HEIGHT);
      }

      // Enemy buildings are remembered: once you have seen a camp it stays
      // on the map even when the light moves off it, because it is not
      // going anywhere. (Units get the opposite rule — see sceneSync.)
      // The exempt side is the fog's, not one remembered here: a replay
      // turning to another seat turns this rule with it. Written every
      // pass, own side included, rather than only where the fog hides:
      // the seat can change under a standing roster, and a hut left
      // hidden while it was a rival's would otherwise stay hidden now
      // that it is the viewed seat's own.
      if (this.#fog) {
        v.root.visible =
          b.owner === this.#fog.owner ||
          this.#fog.exploredAt(b.x + b.w / 2, b.y + b.h / 2);
      }

      v.staffed = b.staffing === StaffingState.staffed;
      v.working = b.working === true;
      v.training = isTraining(b);
      v.firing = b.firing === true;
      v.volleyRange = volleyRangeOf(b);
      const pileKey = v.pileKey;
      this.#syncPiles(v, b);
      // The stock at the door stands a third of a tile outside the front
      // wall, on ground the footprint never covers, and it comes and goes
      // with the hauling: when it changes, so does the ground this
      // building is drawn over.
      if (v.pileKey !== pileKey) this.#reclaimDrawn(b.id, v);
      this.#syncGarrison(v, b);

      // Damage bar: appears once hurt (highlight() shows it on healthy
      // ones). Recorded here, drawn by #rebuildHpBars once the roster is
      // settled — a bar is an instance in a shared mesh now, not an object
      // hung off this building.
      v.pct = b.maxHp > 0 ? b.hp / b.maxHp : 1;
    }
    // Snapshotted: #beginTeardown deletes from #visuals as we walk it.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const id of [...this.#visuals.keys()]) {
      // Gone from the roster: sold or razed. Instead of popping out of
      // existence the model goes down into the ground under a puff of
      // dust (see frame). The site->built swap above stays instant — that
      // building is not leaving, it is arriving.
      if (!seen.has(id)) this.#beginTeardown(id);
    }
    // Once, with the roster, the damage and the fog all settled.
    this.#rebuildHpBars();
  }

  /**
   * Take the tiles this building is drawn over but does not stand on, and
   * hand back the keys to them — see #drawn. The footprint's own tiles are
   * left out: the sim's map already answers for those, and the smaller
   * this stays the less there is to keep straight.
   */
  #claimDrawn(
    id: number,
    root: THREE.Group,
    halfW: number,
    halfD: number,
    bbox: THREE.Box3 | null,
  ): number[] {
    const drawn: number[] = [];
    if (!bbox || bbox.isEmpty()) return drawn;
    const size = this.#heights.size;
    const x0 = Math.floor(root.position.x + bbox.min.x);
    const x1 = Math.floor(root.position.x + bbox.max.x);
    const z0 = Math.floor(root.position.z + bbox.min.z);
    const z1 = Math.floor(root.position.z + bbox.max.z);
    // The footprint, back out of the center the root stands on.
    const fx = root.position.x - halfW;
    const fz = root.position.z - halfD;
    for (let tz = z0; tz <= z1; tz++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (tx < 0 || tz < 0 || tx >= size || tz >= size) continue;
        if (tx >= fx && tx < fx + halfW * 2 && tz >= fz && tz < fz + halfD * 2)
          continue;
        const key = tileIdx(tx, tz, size);
        const here = this.#drawn.get(key);
        if (here) here.push(id);
        else this.#drawn.set(key, [id]);
        drawn.push(key);
      }
    }
    return drawn;
  }

  /** Give back the tiles a visual claimed, leaving any neighbour that
   * reaches over the same ground still holding it. */
  #releaseDrawn(id: number, v: BuildingVisual): void {
    for (const key of v.drawn) {
      const here = this.#drawn.get(key);
      if (!here) continue;
      const at = here.indexOf(id);
      if (at >= 0) here.splice(at, 1);
      if (here.length === 0) this.#drawn.delete(key);
    }
    v.drawn.length = 0;
  }

  /**
   * Re-take the ground this building is drawn over, model and door piles
   * together. The claim #create made is only as good as the building was
   * that moment: the stock at the door comes and goes (#syncPiles stands
   * it a third of a tile OUTSIDE the front wall, which is ground the
   * footprint never covers), and a jetty is aimed after it is built.
   */
  #reclaimDrawn(id: number, v: BuildingVisual): void {
    if (v.road) return;
    this.#releaseDrawn(id, v);
    CLAIM_BOX.copy(v.modelBox);
    if (v.piles) {
      // Settle the pile group's own matrices first: a claim runs when the
      // roster lands, which can be before any frame has been drawn, and a
      // box read off an unsettled tree is a box at the origin. Its own,
      // not the whole building's — the parents walk up to the scene and
      // the props under it are a handful.
      v.piles.updateWorldMatrix(true, true);
      // The root is in the scene by now, so this reads world space; the
      // claim wants the model's own, as at creation. The root carries no
      // rotation or scale, so its position is the whole of the difference.
      PILE_BOX.setFromObject(v.piles);
      PILE_BOX.translate(SCRATCH_POS.copy(v.root.position).negate());
      CLAIM_BOX.union(PILE_BOX);
    }
    v.drawn = this.#claimDrawn(id, v.root, v.halfW, v.halfD, CLAIM_BOX);
  }

  #beginTeardown(id: number): void {
    const v = this.#visuals.get(id);
    if (!v) return;
    // A spent salvage pile just stops being there: the goods left one by
    // one on serfs' shoulders (#syncPiles already emptied it), so a
    // collapse cue and a dust cloud would announce a demolition where
    // nothing stood.
    if (v.salvage) {
      this.#dispose(id);
      return;
    }
    this.#visuals.delete(id);
    // A model on its way into the ground is no longer drawn over anything.
    this.#releaseDrawn(id, v);
    // The rumble belongs to the dust cloud below — and only where the
    // cloud is drawn (fog guard — see onCue).
    if (this.onCue && v.root.visible) {
      this.onCue('buildingCollapse', v.root.position.x, v.root.position.z);
    }
    // The cloud: a fistful of low-poly puffs bursting out past the walls,
    // each with its own heading, size, tumble and moment to join — chaos,
    // not choreography. A single tidy expanding ring read as a decal.
    const dust = new THREE.Group();
    dust.position.copy(v.root.position);
    const n = 8 + Math.round(v.span * 4);
    const puffs = [];
    for (let i = 0; i < n; i++) {
      const grey = 0.55 + hash2(id * 3 + i, 21) * 0.3;
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(grey + 0.09, grey + 0.03, grey * 0.82),
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(PUFF_GEO, mat);
      mesh.visible = false;
      dust.add(mesh);
      puffs.push({
        mesh,
        angle: (i / n) * Math.PI * 2 + (hash2(id + i, 3) - 0.5) * 1.2,
        r0: v.span * (0.25 + hash2(id + i, 5) * 0.3),
        vr: v.span * (0.5 + hash2(id + i, 9) * 0.7),
        size: v.span * (0.1 + hash2(id + i, 13) * 0.16),
        delay: hash2(id + i, 17) * 0.4,
        spinX: (hash2(id + i, 19) - 0.5) * 9,
        spinZ: (hash2(id + i, 23) - 0.5) * 9,
      });
    }
    this.#scene.add(dust);
    this.#dying.push({
      visual: v,
      t: 0,
      baseY: v.root.position.y,
      tiltX: (hash2(id, 7) - 0.5) * 0.22,
      tiltZ: (hash2(id, 11) - 0.5) * 0.22,
      dust,
      puffs,
    });
  }

  #create(b: BuildingSnap): BuildingVisual {
    const root = new THREE.Group();
    const cx = b.x + b.w / 2;
    const cz = b.y + b.h / 2;
    root.position.set(cx, this.#heights.at(cx, cz), cz);

    let frame: THREE.Group | undefined;
    let model: THREE.Group;
    let clip: BuildingVisual['clip'];
    if (b.state === BuildingState.site) {
      frame = makeSiteFrame(b.w, b.h);
      root.add(frame);
      const glb = makeGlbBuilding(b.type, b.owner);
      if (glb) {
        model = glb;
        // Per-site material clones so the clip plane never touches the
        // shared templates or finished buildings.
        const plane = new THREE.Plane(
          new THREE.Vector3(0, -1, 0),
          root.position.y,
        );
        const clipped = (m: THREE.Material): THREE.Material => {
          const c = m.clone();
          c.clippingPlanes = [plane];
          c.clipShadows = true;
          // The plane cuts a closed shell open, and a front-faced shell
          // cut open is a hole: you see past the near wall to nothing,
          // because the faces that would be behind it all point away.
          // Drawing both sides puts the far wall's inside back on the
          // screen, so a half-raised building reads as a building with
          // its top off rather than as a facade. It is not a capped cut
          // — the slice is still hollow, not solid stone — but hollow
          // and roofed beats transparent. Safe here and only here: these
          // materials are already per-site clones, so nothing finished
          // and no shared template sees this.
          c.side = THREE.DoubleSide;
          // Without this the shadow keeps the old one-sided read and the
          // building casts a shadow with a hole in it.
          c.shadowSide = THREE.DoubleSide;
          return c;
        };
        model.traverse(o => {
          if (o instanceof THREE.Mesh) mapMaterials(o, clipped);
        });
        // Note: root isn't in the scene yet, so this bbox is root-local —
        // max.y IS the model height above its own base.
        const bbox = new THREE.Box3().setFromObject(model);
        clip = {plane, height: bbox.max.y, baseY: root.position.y};
        plane.constant = root.position.y + 0.08;
        root.add(model);
        // No cosmetic builder here: the staffing system sends a real serf
        // who becomes the builder (and then the worker) — sceneSync
        // renders them hammering like any other unit.
      } else {
        model = makeGhostModel(b.type);
        model.scale.setScalar(GHOST_SEED_SCALE);
        root.add(model);
      }
    } else if (b.type === BuildingTypeId.salvage) {
      // Salvage is nothing but its piles (#syncPiles): the walls already
      // came down with the building it was, so there is no model — and no
      // road-pile marker either, which would read as a structure standing
      // where only goods lie.
      model = new THREE.Group();
      root.add(model);
    } else {
      // Roads are the one type without a GLB — their 'built' form is the
      // terrain itself, so the pile marker covers the site moment only.
      model = makeGlbBuilding(b.type, b.owner) ?? makeRoadPile();
      root.add(model);
    }

    // Shore buildings turn to face their water (Building.facing). Only the
    // model turns, not the root: the footprint stays axis-aligned, and the
    // root's own x/z rotation belongs to the collapse animation.
    if (b.facing) model.rotation.y = (b.facing * Math.PI) / 2;

    // The template bakes the fishery's shoal at deck height off the front
    // edge, but the water surface is a world plane well below the shore the
    // building stands on — left there, the fish circle in the air over the
    // waterline. Re-seat the group so they swim just under the surface: a
    // world-unit drop, folded back into the model's vertical scale.
    const shoal = model.getObjectByName('fisheryShoal') ?? undefined;
    if (shoal) {
      shoal.position.y =
        (WATER_LEVEL - SHOAL_DRAFT - root.position.y) / model.scale.y;
      // The fish swim off the end of the pier, out over open water: a
      // click on them is a click on the sea, not on the hut — silhouetteT.
      shoal.userData[PICK_IGNORE] = true;
    }

    // The model's own box. Root-local, like the clip's above: the root is
    // not in the scene yet, so setFromObject reads the model's own space —
    // which is what both readings below want, a height over the base and a
    // reach out from the center. An empty group (salvage) has no box to
    // read, and the pile is ankle-high anyway.
    const bbox =
      b.type === BuildingTypeId.salvage
        ? null
        : new THREE.Box3().setFromObject(model);
    const topY = clip ? clip.height : (bbox?.max.y ?? 0);
    // Where this building's roof will reach when it is finished, which is
    // what the pick walk wants as its ceiling: a site's finished height
    // (topY is already that for a clipped one, and the seed scale away from
    // it for a ghost), never less than the frame it stands in while it gets
    // there, and all of it over the ground this one stands on.
    // Salvage shares the road's ground-level treatment — no pick box, no
    // claim on the camera ceiling; the tile pick still selects it.
    const road =
      buildingDef(b.type).isRoad === true || b.type === BuildingTypeId.salvage;

    // The walls say where they are, for the x-ray outlines: every fragment
    // of the model stamps a stencil bit where it wins the depth test, and
    // that bit — not "something is nearer than me" — is what lets an
    // outline be drawn over it.
    //
    // Only what occluderBoxes is willing to call an occluder, because a
    // bit the boxes do not vouch for is a green arc drawn over something
    // that is not hiding anybody. A road's pile of stone and a salvage
    // heap are ankle-high and are left out of the boxes, so they stamp
    // nothing. Neither does a site's frame: the boxes measure a site by
    // what has RISEN inside it (#raised), never by its scaffolding, and
    // that scaffolding is a sill lying along the ground — exactly the
    // thing that must not stamp. The model alone, and for a site only
    // once it has risen far enough to earn a box (#syncWall).
    //
    // Drawn last among the opaque world (WALL_RENDER_ORDER), because a
    // bit is never cleared and anything unmarked drawing after a building
    // would leave one standing over its own depth.
    const wall: THREE.Mesh[] = [];
    if (!road) {
      // Walked rather than traversed, so a subtree that reaches past the
      // footprint can be left whole where it stands.
      const mark = (o: THREE.Object3D): void => {
        if (BEYOND_FOOTPRINT.has(o.name) || TRAINING_NODES.has(o.name)) return;
        if (o instanceof THREE.Mesh) {
          mapMaterials(o, occluderMaterial);
          o.renderOrder = WALL_RENDER_ORDER;
          wall.push(o);
        }
        for (const child of o.children) mark(child);
      };
      mark(model);
    }
    const finished =
      b.state === BuildingState.site
        ? Math.max(SITE_FRAME_H, clip ? topY : topY / GHOST_SEED_SCALE)
        : topY;
    if (!road)
      this.#ceiling = Math.max(this.#ceiling, root.position.y + finished);
    // The training cue, harvested once off the finished model. After the
    // wall marking above on purpose — that pass would otherwise hand the
    // glow meshes an occluder twin, and the clone below would then be
    // setting the opacity of a material nothing is drawing with.
    const train =
      b.state === BuildingState.built ? harvestTrainingRig(model) : null;
    const trainMats = train ? ownTrainingMaterials(train) : [];

    const modelBox = bbox ?? new THREE.Box3().makeEmpty();
    const drawn = road
      ? []
      : this.#claimDrawn(b.id, root, b.w / 2, b.h / 2, modelBox);
    this.#scene.add(root);
    return {
      root,
      type: b.type,
      state: b.state,
      frame,
      model,
      clip,
      topY,
      // Only a site's, and only because its model's materials are
      // per-site clones (the clip and ghost passes above): turning those
      // off turns off this one building. A finished building's are the
      // marked templates its whole type shares, and are never off — nor
      // is its place in the queue, which only an unmarked mesh has to
      // give up.
      wall: b.state === BuildingState.site ? wall : undefined,
      halfW: b.w / 2,
      halfD: b.h / 2,
      road,
      drawn,
      modelBox,
      pct: 1,
      pileKey: '',
      pileLanes: new Map(),
      crank: model.getObjectByName('wellCrank') ?? undefined,
      fan: model.getObjectByName('millFan') ?? undefined,
      fanSpeed: 0,
      flue: model.getObjectByName('smokeFlue') ?? undefined,
      smokeLevel: 0,
      shoal,
      pier: model.getObjectByName('fisheryPier') ?? undefined,
      mowMarks: harvestMowMarks(model),
      facing: b.facing ?? 0,
      staffed: false,
      working: false,
      span: Math.max(b.w, b.h),
      posts: ['towerPost0', 'towerPost1']
        .map(n => model.getObjectByName(n))
        .filter((o): o is THREE.Object3D => o !== undefined),
      manned: [],
      firing: false,
      owner: b.owner,
      volleyRange: 0,
      levied: false,
      salvage: b.type === BuildingTypeId.salvage,
      // Only on a finished building: a site draws the same model (under a
      // clip plane, with its own material clones) and a half-raised
      // barracks with its windows lit would be a barracks nobody built yet
      // announcing a course it cannot be running.
      train: train ?? undefined,
      trainMats: trainMats.length > 0 ? trainMats : undefined,
      training: false,
      trainLevel: 0,
    };
  }

  /**
   * The standing buildings as plain boxes, for the x-ray outlines: a unit
   * whose line to the camera crosses one of these is hidden behind a wall
   * and gets an outline drawn over it (xrayOutline.ts).
   *
   * Roads, salvage piles and bare foundations are not in it — nothing
   * ankle-high hides anybody — and neither is a building this seat has
   * never seen: it is not drawn, so it cannot be what is standing in
   * front of anyone, and the same rule that keeps a cue from announcing
   * construction in unexplored ground keeps an outline from being drawn
   * against a wall nobody knows is there.
   *
   * The horizontal extent is padded past the footprint, because eaves
   * overhang and the test is allowed to be generous but never mean: a box
   * that missed would cost an outline, where a box that over-reaches
   * costs two draws the depth test throws away.
   *
   * Read every frame rather than snapshotted when the roster changes, and
   * that is the whole of why: what belongs in this list turns on more than
   * the roster message. The fog decides it, and reaches this sync after
   * the first pass and turns again with the viewed seat in a replay;
   * forgetMonuments drops visuals on a players-only frame; a construction
   * site rises between messages. Three snapshot points had been found by
   * the time this comment was written and a fourth was waiting. Reading it
   * live has none. The array and the boxes in it are reused, so a caller
   * must read them rather than keep them, and a quiet frame allocates
   * nothing.
   */
  occluderBoxes(): readonly OccluderBox[] {
    const out = this.#occluders;
    let n = 0;
    for (const v of this.#visuals.values()) n = this.#addBox(out, n, v);
    // A wreck is still a wall until the dust settles: teardown takes the
    // building off the roster at once and spends the next second sinking
    // and tilting the model, which goes on writing depth the whole time.
    // Left out, a man behind a collapsing keep would lose his edge while
    // the keep was still in front of him. The box follows the sink (it is
    // read off the live root) and ignores the tilt, which is what the
    // eaves padding is there to absorb.
    for (const d of this.#dying) n = this.#addBox(out, n, d.visual);
    out.length = n;
    return out;
  }

  /** One building's box appended at `n`, or nothing if it cannot hide
   * anybody. Returns where the next one goes. */
  #addBox(out: OccluderBox[], n: number, v: BuildingVisual): number {
    if (v.salvage || !v.root.visible) return n;
    // What the model has raised so far, not what it will be, and not the
    // frame the pick box floors at: a foundation hides nobody and a
    // half-built keep hides them to exactly the course it has reached.
    const top = v.road ? 0 : this.#raised(v);
    if (top < OCCLUDER_MIN_HEIGHT) return n;
    const {x, y, z} = v.root.position;
    const box = (out[n] ??= {
      minX: 0,
      maxX: 0,
      minZ: 0,
      maxZ: 0,
      baseY: 0,
      topY: 0,
    });
    box.minX = x - v.halfW - OCCLUDER_PAD;
    box.maxX = x + v.halfW + OCCLUDER_PAD;
    box.minZ = z - v.halfD - OCCLUDER_PAD;
    box.maxZ = z + v.halfD + OCCLUDER_PAD;
    box.baseY = y;
    box.topY = y + top;
    return n + 1;
  }

  /** Reused frame to frame by occluderBoxes — see the note there. */
  #occluders: OccluderBox[] = [];

  /** Built wells' world centers, windlasses and grip handles — sceneSync
   * stands the drawing serf beside the crank, IK-glues their hand to the
   * grip, and turns the windlass under it. */
  wellCranks(): {
    x: number;
    z: number;
    crank: THREE.Object3D;
    grip: THREE.Object3D;
  }[] {
    const out: {
      x: number;
      z: number;
      crank: THREE.Object3D;
      grip: THREE.Object3D;
    }[] = [];
    for (const v of this.#visuals.values()) {
      if (v.state !== BuildingState.built || !v.crank) continue;
      const grip = v.crank.getObjectByName('wellGrip');
      if (grip)
        out.push({
          x: v.root.position.x,
          z: v.root.position.z,
          crank: v.crank,
          grip,
        });
    }
    return out;
  }

  /** Built fisheries' piers, in world space: where the deck line runs
   * (landward end -> fishing spot near the tip), the height of the planks,
   * and the yaw that faces the water. sceneSync walks the resident
   * fisherman out along it and stands him at the spot, line in the water —
   * the same render-side move as the well serfs, because the sim parks him
   * on whatever tile the path found. */
  fisheryPiers(): PierInfo[] {
    const out: PierInfo[] = [];
    for (const [id, v] of this.#visuals) {
      if (v.state !== BuildingState.built || !v.pier) continue;
      if (!v.pierLine) {
        v.pierLine = this.#measurePier(v);
        // The fit can turn the hut and trim the deck, so the water this
        // building is drawn over is no longer the water #create claimed
        // for it (see #drawn). Measured once, re-claimed once.
        v.model.updateWorldMatrix(true, true);
        v.modelBox.setFromObject(v.model);
        // setFromObject reads world space now that the root is in the
        // scene; the claim wants the model's own, as at creation.
        v.modelBox.translate(SCRATCH_POS.copy(v.root.position).negate());
        this.#reclaimDrawn(id, v);
      }
      out.push(v.pierLine);
    }
    return out;
  }

  /** Built wheat farms' fields, in world space: the mowing circuit, the
   * open-front entry and the pad height. sceneSync walks the resident
   * farmer along the circuit, scythe swinging, while a batch runs — the
   * same render-side move as the fisherman on his pier, because the sim
   * parks the worker on whatever adjacent tile the path found. */
  farmFields(): FieldInfo[] {
    const out: FieldInfo[] = [];
    for (const v of this.#visuals.values()) {
      if (v.state !== BuildingState.built || v.mowMarks.length < 2) continue;
      out.push((v.fieldInfo ??= this.#measureField(v)));
    }
    return out;
  }

  #measureField(v: BuildingVisual): FieldInfo {
    // Structural updates can land before the next render ticks world
    // matrices — settle them before measuring (same as the pier).
    v.root.updateWorldMatrix(true, true);
    const [gate, ...path] = v.mowMarks;
    gate!.getWorldPosition(SCRATCH_POS);
    const gateX = SCRATCH_POS.x;
    const gateZ = SCRATCH_POS.z;
    // The marks sit ON the pad top, so any one of them is the field's
    // standing height.
    const padY = SCRATCH_POS.y;
    const points: {x: number; z: number}[] = [];
    let minX = gateX;
    let maxX = gateX;
    let minZ = gateZ;
    let maxZ = gateZ;
    for (const m of path) {
      m.getWorldPosition(SCRATCH_POS);
      points.push({x: SCRATCH_POS.x, z: SCRATCH_POS.z});
      minX = Math.min(minX, SCRATCH_POS.x);
      maxX = Math.max(maxX, SCRATCH_POS.x);
      minZ = Math.min(minZ, SCRATCH_POS.z);
      maxZ = Math.max(maxZ, SCRATCH_POS.z);
    }
    // A margin past the circuit: "on the field" must already be true a
    // step before the first lane, or the entry leg would never hand over.
    const M = 0.3;
    return {
      bx: v.root.position.x,
      bz: v.root.position.z,
      gateX,
      gateZ,
      points,
      minX: minX - M,
      maxX: maxX + M,
      minZ: minZ - M,
      maxZ: maxZ + M,
      padY,
    };
  }

  #measurePier(v: BuildingVisual): PierInfo {
    // This runs on structural updates, possibly before the next render
    // ticks world matrices — settle them before measuring.
    v.root.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(v.pier!);
    const facingYaw = (v.facing * Math.PI) / 2;
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    // Facing is a quarter turn, so the authored deck line lies along one
    // axis.
    const along = Math.abs(Math.sin(facingYaw)) > 0.5;
    const len = along ? box.max.x - box.min.x : box.max.z - box.min.z;
    // The landward end, where the deck meets the hut. A trim shortens the
    // deck about this point, so it never comes loose; a turn instead
    // rotates the whole model about the footprint center (below).
    const baseX = cx - Math.sin(facingYaw) * (len / 2);
    const baseZ = cz - Math.cos(facingYaw) * (len / 2);
    let yaw = facingYaw;
    let scale = 1;
    // The deck stays square to the hut: a turn rotates the WHOLE model
    // (house, deck and all) about the footprint center, so the pair never
    // come apart. The fit search therefore pivots the deck line about the
    // building center rather than the deck's landward end.
    const pvX = v.root.position.x;
    const pvZ = v.root.position.z;
    const spin = (x: number, z: number, th: number): [number, number] => {
      const rx = x - pvX;
      const rz = z - pvZ;
      const c = Math.cos(th);
      const sn = Math.sin(th);
      return [pvX + rx * c + rz * sn, pvZ + rz * c - rx * sn];
    };
    let fitBaseX = baseX;
    let fitBaseZ = baseZ;
    let spotX = baseX + Math.sin(yaw) * (len - PIER_SPOT_BACK);
    let spotZ = baseZ + Math.cos(yaw) * (len - PIER_SPOT_BACK);
    // Aim the deck at the water: the least intrusive fit whose tip AND
    // whose fishing spot both stand over it (see PIER_FITS for why the
    // authored placement so often does not, and PIER_DRAFT for what
    // standing over water means here). Deep enough to read as water if any
    // fit can manage it, wet at all if none can; a shore that no fit
    // reaches at all keeps the authored deck, which is no worse than what
    // the model shipped with.
    for (const draft of [PIER_DRAFT, 0]) {
      const wet = (x: number, z: number): boolean =>
        this.#heights.at(x, z) < WATER_LEVEL - draft;
      const fit = PIER_FITS.find(f => {
        const th = f.turn * PIER_TURN_STEP;
        const [bX, bZ] = spin(baseX, baseZ, th);
        const fitYaw = facingYaw + th;
        const fitLen = len - f.trim * PIER_TRIM_STEP;
        const dirX = Math.sin(fitYaw);
        const dirZ = Math.cos(fitYaw);
        return (
          wet(bX + dirX * fitLen, bZ + dirZ * fitLen) &&
          wet(
            bX + dirX * (fitLen - PIER_SPOT_BACK),
            bZ + dirZ * (fitLen - PIER_SPOT_BACK),
          )
        );
      });
      if (!fit) continue;
      const th = fit.turn * PIER_TURN_STEP;
      const fitLen = len - fit.trim * PIER_TRIM_STEP;
      yaw = facingYaw + th;
      scale = fitLen / len;
      [fitBaseX, fitBaseZ] = spin(baseX, baseZ, th);
      spotX = fitBaseX + Math.sin(yaw) * (fitLen - PIER_SPOT_BACK);
      spotZ = fitBaseZ + Math.cos(yaw) * (fitLen - PIER_SPOT_BACK);
      if (th !== 0) {
        // The facing-rotated model is the pier's ancestor just under root.
        let model: THREE.Object3D = v.pier!;
        while (model.parent && model.parent !== v.root) model = model.parent;
        model.rotation.y += th;
        v.root.updateWorldMatrix(true, true);
      }
      break;
    }
    if (scale !== 1) this.#fitDecor(v, fitBaseX, fitBaseZ, scale);
    return {
      bx: v.root.position.x,
      bz: v.root.position.z,
      baseX: fitBaseX,
      baseZ: fitBaseZ,
      spotX,
      spotZ,
      yaw,
      // A trimmed deck is a smaller dock, planks and all, so its top comes
      // down with it.
      deckY: v.root.position.y + PIER_DECK_Y * scale,
    };
  }

  /**
   * Re-seat the pier — and the shoal working the water off its end — for
   * the trim `#measurePier` chose: pull both in to `scale` of their reach
   * from the deck's landward end. (A turn is not handled here any more —
   * it rotates the whole model, so the decor rides along for free.)
   *
   * The deck shrinks with its reach, and does so UNIFORMLY (the pier's own
   * scale, all three axes): a trim leaves a smaller dock, narrower and
   * lower in proportion, rather than a full-width deck squashed short.
   * Uniform is also the only scale that needs no opinion about which of the
   * prop's own axes its length runs along — decor is authored with a
   * quarter-turn `rot` (assets.ts), and a length-only scale would silently
   * pinch the width instead the day that rot changes. What it costs is
   * piling depth, which is why the trim is bounded: the docks model's
   * pilings hang ~1.27 under the deck, so even the deepest trim leaves
   * ~0.76 against the ~0.4 they need to reach from the shore they stand on
   * down past the waterline.
   *
   * The fish only swim in closer — a trim is the pier's, not theirs.
   */
  #fitDecor(
    v: BuildingVisual,
    baseX: number,
    baseZ: number,
    scale: number,
  ): void {
    const p = new THREE.Vector3();
    for (const obj of [v.pier, v.shoal]) {
      if (!obj?.parent) continue;
      obj.parent.worldToLocal(p.set(baseX, 0, baseZ));
      obj.position.x = p.x + (obj.position.x - p.x) * scale;
      obj.position.z = p.z + (obj.position.z - p.z) * scale;
    }
    v.pier?.scale.multiplyScalar(scale);
  }

  /** Per render frame: the decor that moves. dt in seconds (pass 0 while
   * paused). Windlasses are not here — the well keeps no resident, so there
   * is nothing building-side to key them off; sceneSync turns each one under
   * the serf that came to draw from it. */
  /**
   * Per-frame decor: sails, shoals, chimney smoke and the watch on the
   * roof.
   *
   * `bounds` is the camera's view rectangle. Everything this loop drives is
   * decoration on a building the player is looking at, so a building that
   * is fogged or off-camera is skipped outright — the sails of a mill
   * nobody can see still cost a mixer update and a shoal of fish still
   * costs a sin, a cos and a transform each. Buildings do not move, so
   * `root.position` is the whole test.
   *
   * What that trades: a windmill picked up mid-turn rather than where it
   * would have been had it kept spinning off-camera, and a roof archer
   * resuming his clip instead of restarting it. Neither has anything on
   * screen to be out of step with — the same reasoning sceneSync already
   * applies when it culls a unit's animation off-screen.
   */
  frame(dt: number, bounds?: ViewBounds): void {
    // Re-aim the bars if the camera has turned under them — a turn, not a
    // pan and not the float noise a pan leaves in the quaternion, so a
    // camera crossing the map costs nothing and only a real turn pays.
    //
    // Ahead of the dt gate on purpose: the game pauses, the camera does
    // not. Turning while paused would otherwise leave every bar facing
    // wherever the view was when the world stopped.
    const camQuat = this.cameraQuaternion;
    if (camQuat && Math.abs(camQuat.dot(this.#hpQuat)) < 1 - BAR_QUAT_EPS) {
      this.#rebuildHpBars();
    }
    if (dt <= 0) return;
    this.#now += dt;
    for (const v of this.#visuals.values()) {
      // Most of a settlement is huts and warehouses with nothing that
      // moves; this loop used to walk all of them to find that out.
      if (!v.fan && !v.shoal && !v.flue && !v.train && v.manned.length === 0) {
        continue;
      }
      if (!v.root.visible) continue; // fogged: remembered, not watched
      if (bounds !== undefined) {
        const bx = v.root.position.x;
        const bz = v.root.position.z;
        if (
          bx < bounds.minX ||
          bx > bounds.maxX ||
          bz < bounds.minZ ||
          bz > bounds.maxZ
        ) {
          continue;
        }
      }
      if (v.fan) {
        // The sails turn while the mill grinds — the mill keeps no resident
        // (the wind is the worker), so the cue is the batch itself
        // (BuildingSnap.working), not staffing. Speed eases toward the
        // target: heavy sails carry momentum, and the coast also bridges
        // the one-tick gap between back-to-back batches, which would
        // otherwise read as a stutter whenever a publish lands in it.
        const target =
          v.working && v.state === BuildingState.built ? MILL_FAN_SPEED : 0;
        v.fanSpeed += (target - v.fanSpeed) * Math.min(1, dt * 1.6);
        if (v.fanSpeed > 0.01) v.fan.rotation.z += v.fanSpeed * dt;
      }
      if (v.flue) this.#smokeFrame(v, dt);
      if (v.train) this.#trainFrame(v, dt);
      if (v.shoal && v.staffed && v.state === BuildingState.built) {
        // Each fish carries its own circle, direction and depth. Advancing
        // the phase and pointing the nose down the tangent is the whole
        // motion: at village zoom a rigid fish on a slow curve reads as
        // swimming, and the model has no rig to do better with.
        for (const pivot of v.shoal.children) {
          const p = pivot.userData as {
            r: number;
            phase: number;
            speed: number;
            y: number;
          };
          p.phase += dt * p.speed;
          pivot.position.set(
            Math.cos(p.phase) * p.r,
            p.y,
            Math.sin(p.phase) * p.r,
          );
          // The model's nose is -z: rotation.y = t points it at
          // (-sin t, -cos t), while the tangent of a counter-clockwise circle
          // at phase p is (-sin p, cos p). So the half turn belongs to the
          // forward swimmer, and the one running its circle backwards is the
          // one that takes the bare -phase. Swapped, every fish in the shoal
          // travelled tail-first.
          pivot.rotation.y = -p.phase + (p.speed > 0 ? Math.PI : 0);
        }
      }
      // The watch on the roof: drawing while the tower is between volleys,
      // idle the rest of the time. Desynced by post index so two men on one
      // roof never breathe in lockstep.
      for (let i = 0; i < v.manned.length; i++) {
        const man = v.manned[i]!;
        const char = man.char;
        if (!char) continue;
        // The levy has no bow to draw, so it lobs: the villager throws and
        // the archer keeps his own loose.
        const shooting = v.levied ? AnimKey.throwing : AnimKey.shoot;
        playAnimation(char, v.firing ? shooting : AnimKey.idle, i * 0.37);
        char.mixer.update(dt);
        if (char.bow) updateBow(char);
        if (char.grip) updateGrip(char, dt);
        // Each man's projectile leaves at his own clip's release — the
        // same phase-crossing watch the field archers keep (sceneSync),
        // against the throw's measured release for the levy. Volleys ride
        // the drawing state rather than the sim's exact fire ticks (those
        // never reach the client); two desynced clips loosing on their
        // own rhythm while the tower is hot is the intended read.
        const act =
          v.firing && this.onVolley && v.volleyRange > 0
            ? char.actions.get(shooting)
            : undefined;
        if (act) {
          const rel =
            (v.levied
              ? THROW_RELEASE
              : (LOOP_CUES[AnimKey.shoot]?.impactPhase01 ?? 0.5)) *
            act.getClip().duration;
          const t = act.time;
          const prevT = man.shootT;
          man.shootT = t;
          if (crossedRelease(prevT, t, rel)) {
            man.group.getWorldPosition(SCRATCH_POS);
            // The roof gets the field archer's twang too — buildingSync
            // drives these mixers itself, so sceneSync's loop-cue hook
            // never hears them. The levy stays quiet: there is no stone
            // cue, and a silent lob beats a borrowed bow twang.
            if (!v.levied)
              this.onCue?.('bowRelease', SCRATCH_POS.x, SCRATCH_POS.z);
            this.onVolley!(
              SCRATCH_POS.x,
              SCRATCH_POS.y,
              SCRATCH_POS.z,
              v.owner,
              v.volleyRange,
              v.levied,
            );
          }
        } else {
          man.shootT = undefined;
        }
      }
    }
    if (this.#dying.length === 0) return;
    const DURATION = 1.15;
    for (const d of this.#dying) {
      d.t = Math.min(d.t + dt / DURATION, 1);
      // Ease-in sink: slow shudder first, then the drop.
      const sink = d.t * d.t;
      const {root} = d.visual;
      root.position.y = d.baseY - sink * (d.visual.topY + 0.4);
      root.rotation.x = d.tiltX * d.t;
      root.rotation.z = d.tiltZ * d.t;
      for (const p of d.puffs) {
        // Each puff lives on its own clock: nothing until its delay, then
        // a burst out and up, a slow tumble, and a shrink into nothing.
        const tau = Math.min(Math.max((d.t - p.delay) / (1 - p.delay), 0), 1);
        p.mesh.visible = tau > 0;
        if (tau <= 0) continue;
        const r = p.r0 + p.vr * tau;
        p.mesh.position.set(
          Math.cos(p.angle) * r,
          0.12 + Math.sin(tau * Math.PI) * p.size * 2.2,
          Math.sin(p.angle) * r,
        );
        p.mesh.scale.setScalar(
          p.size * (0.5 + tau * 1.1) * (1 - tau * tau * 0.6),
        );
        p.mesh.rotation.x += p.spinX * dt;
        p.mesh.rotation.z += p.spinZ * dt;
        (p.mesh.material as THREE.MeshBasicMaterial).opacity =
          0.8 * (1 - tau) * (1 - tau);
      }
    }
    for (let i = this.#dying.length - 1; i >= 0; i--) {
      const d = this.#dying[i]!;
      if (d.t < 1) continue;
      this.#scene.remove(d.visual.root, d.dust);
      for (const p of d.puffs) (p.mesh.material as THREE.Material).dispose();
      this.#freeGpu(d.visual);
      this.#dying.splice(i, 1);
    }
  }

  /**
   * Chimney smoke, per frame: a short column of soft grey puffs off the
   * flue while a batch is on the fire — the bakery's oven and the Smith's
   * forge, via the 'smokeFlue' mark each model carries.
   *
   * The cue is the batch (BuildingSnap.working) AND someone at the post.
   * Working alone — the mill's cue — is not enough here: a convert whose
   * worker dies mid-batch freezes rather than finishing (production.ts
   * skips unstaffed posts), but prodTicksLeft stays set, so the snapshot
   * still says working. Staffing gates the smoke the way it gates the
   * fishery's shoal; the mill keeps its working-only cue because the wind
   * is its worker and its batches never freeze this way. The thickness
   * eases rather than snapping: up briskly when the batch lights, down at
   * a third of that when it ends, because an oven banks rather than going
   * out — and the lingering trickle bridges the one-tick gap between
   * back-to-back batches, which would otherwise read as the fire dying
   * between every two loaves.
   */
  #smokeFrame(v: BuildingVisual, dt: number): void {
    // Two fires, one column. A convert post's is its batch (with a hand at
    // the post to keep it going); a training building's flue is the brazier
    // in its yard, which is lit for the course and not for a batch it has
    // none of.
    const lit = v.train ? v.training : v.working && v.staffed;
    const target = lit && v.state === BuildingState.built ? 1 : 0;
    v.smokeLevel +=
      (target - v.smokeLevel) *
      Math.min(1, dt * (target > v.smokeLevel ? 1.6 : 0.55));
    const smoke = v.smoke;
    if (v.smokeLevel < 0.02) {
      // Cold oven. Hide the column and rewind the births, so the next
      // batch's smoke climbs out of the flue puff by puff instead of
      // reappearing full-grown in the air where the last one faded.
      if (smoke && smoke.group.visible) {
        smoke.group.visible = false;
        smoke.puffs.forEach((p, i) => {
          p.t = -i / smoke.puffs.length;
          p.mesh.visible = false;
        });
      }
      return;
    }
    const s = (v.smoke ??= this.#makeSmoke(v));
    s.group.visible = true;
    for (const p of s.puffs) {
      p.t += dt / SMOKE_LIFE;
      if (p.t >= 1) p.t -= 1;
      p.mesh.visible = p.t >= 0;
      if (p.t < 0) continue; // not born yet — see SmokePuff.t
      const t = p.t;
      // Rise on a light sway that loosens with age, leaning gently
      // downwind (+x) the way every chimney in a village leans together.
      p.mesh.position.set(
        t * 0.14 + Math.sin(t * 5.1 + p.seed * 9.4) * 0.05 * (0.4 + t),
        t * SMOKE_RISE,
        Math.cos(t * 4.3 + p.seed * 6.3) * 0.04 * (0.4 + t),
      );
      p.mesh.rotation.y = p.seed * 7 + t * 1.4;
      // Growing as it thins: narrower than the flue at birth, half a tile
      // of loose haze by the time it goes.
      p.mesh.scale.setScalar(0.07 + t * 0.17);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity =
        0.5 * v.smokeLevel * Math.min(1, t * 6) * (1 - t);
    }
  }

  /**
   * The training cue, per frame: lit windows, the brazier's fire, the
   * banner's run up the pole, the pell's rocking and the arrows down the
   * range's lane (procTraining.ts holds all of it).
   *
   * The level eases rather than snapping, on the chimney smoke's own
   * reasoning and with its own asymmetry: a course starting is a torch put
   * to a laid fire and a banner hauled up, which is brisk; a course ending
   * is a fire left to burn down, which is not. The slow side also bridges
   * the gap between two orders in a full queue — the sim starts the next
   * one a tick after the last one ends, and a strictly-read cue would put
   * the banner down and back up between every two soldiers.
   */
  #trainFrame(v: BuildingVisual, dt: number): void {
    const target = v.training && v.state === BuildingState.built ? 1 : 0;
    v.trainLevel +=
      (target - v.trainLevel) *
      Math.min(1, dt * (target > v.trainLevel ? 2.2 : 0.7));
    setTrainingLevel(v.train!, v.trainLevel, this.#now);
  }

  /**
   * Build one building's puff column, parked in root space over its flue.
   *
   * Off the root rather than off the anchor for the same reason the roof
   * archers are: the model carries the footprint's scale and the puffs are
   * already sized in world units. Built on first need — this can run
   * before a render has ticked world matrices, so settle them first (the
   * same move as #measurePier).
   */
  #makeSmoke(v: BuildingVisual): {group: THREE.Group; puffs: SmokePuff[]} {
    v.root.updateWorldMatrix(true, true);
    v.flue!.getWorldPosition(SCRATCH_POS);
    v.root.worldToLocal(SCRATCH_POS);
    const group = new THREE.Group();
    group.name = 'chimneySmoke';
    // Smoke is weather, not masonry — see silhouetteT.
    group.userData[PICK_IGNORE] = true;
    group.position.copy(SCRATCH_POS);
    const puffs: SmokePuff[] = [];
    for (let i = 0; i < SMOKE_PUFFS; i++) {
      // Pale warm greys, a shade apart so the column reads as puffs
      // rather than as one wobbling blob.
      const grey = 0.76 + hash2(i, 27) * 0.14;
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(grey, grey, grey * 1.02),
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(PUFF_GEO, mat);
      mesh.visible = false;
      group.add(mesh);
      puffs.push({mesh, t: -i / SMOKE_PUFFS, seed: hash2(i, 31)});
    }
    v.root.add(group);
    return {group, puffs};
  }

  /**
   * The Settlers fantasy: every good a building holds exists physically,
   * piled against its front wall — the same props the serfs carry. Piles
   * track the true sim counts, so a good vanishes from the stack at the
   * exact publish where a carrier picks it up. Sites show the materials
   * delivered so far.
   */
  /** Producers whose stock lives in the yard: goods render where the
   * model's baked stock stood before the surgeries cut it out (normalized
   * template coords x the template scale) — the same graphics the model
   * shipped with, except a carrier can walk off with them. Spots are
   * biggest-first; `per` goods fill one stack/boulder. */
  static #YARDS: Partial<Record<BuildingSnap['type'], YardStyle>> = {
    [BuildingTypeId.woodcutter]: {
      good: GoodId.wood,
      prop: 'resource_lumber',
      spots: [
        [0.36, 0.28, 0.3, 1],
        [0.36, -0.04, -0.25, 0.9],
        [0.08, 0.3, 0.15, 0.85],
      ],
      size: 0.12,
      per: 3,
    },
    [BuildingTypeId.quarry]: {
      good: GoodId.stone,
      prop: 'resource_stone',
      spots: MINE_SPOTS,
      size: 0.12,
      per: 3,
    },
    [BuildingTypeId.ironMine]: {
      good: GoodId.iron,
      rock: 0x9a5f42,
      spots: MINE_SPOTS,
      size: 0.153,
      per: 2,
    },
    [BuildingTypeId.silverMine]: {
      good: GoodId.silver,
      rock: 0xdbe4ee,
      spots: MINE_SPOTS,
      size: 0.153,
      per: 2,
    },
    [BuildingTypeId.goldMine]: {
      good: GoodId.gold,
      rock: 0xf0bc42,
      spots: MINE_SPOTS,
      size: 0.153,
      per: 2,
    },
  };

  #syncYard(v: BuildingVisual, b: BuildingSnap): boolean {
    const yard = BuildingSync.#YARDS[b.type];
    if (!yard || b.state !== BuildingState.built) return false;
    const n = (b.stock[yard.good] ?? 0) + (b.inputs[yard.good] ?? 0);
    const stacks = Math.min(Math.ceil(n / yard.per), yard.spots.length);
    const key = `yard${stacks}`;
    if (key === v.pileKey) return true;
    v.pileKey = key;
    if (v.piles) {
      v.root.remove(v.piles);
      v.piles = undefined;
    }
    if (stacks === 0) return true;
    const s = Math.min(b.w, b.h) * 1.06;
    const piles = new THREE.Group();
    for (let i = 0; i < stacks; i++) {
      const [x, z, rot, f] = yard.spots[i]!;
      const item = yard.prop
        ? glbYardProp(yard.prop, yard.size * f * s)
        : glbYardRock(yard.rock!, yard.size * f * s);
      if (!item) return true; // assets missing; nothing to show
      item.position.set(x * s, 0, z * s);
      item.rotation.y = rot;
      piles.add(item);
    }
    v.root.add(piles);
    v.piles = piles;
    return true;
  }

  /**
   * Stand the tower's archers on its roof, one per man the sim reports.
   *
   * Unlike the fisherman on his pier or the serf at the windlass — both of
   * which are real units the render merely relocates — these men have no
   * unit to relocate: staffing consumed them into the building, which is
   * exactly what makes a garrison unshootable. So the roof owns its own
   * characters, created and destroyed as the count moves.
   *
   * They hang off the root rather than off the model, because the model
   * carries the footprint's scale (a 2x2 tower is 2.12x) and a character is
   * already sized in world units. The post's world position is converted
   * back through the root to get there.
   */
  #syncGarrison(v: BuildingVisual, b: BuildingSnap): void {
    const want =
      v.state === BuildingState.built
        ? Math.min(b.garrison ?? 0, v.posts.length)
        : 0;
    // A relief swaps who is standing there without moving the count, so the
    // kind has to be able to condemn the figures the way the count does.
    const levied = b.levied === true;
    if (levied !== v.levied) {
      for (const gone of v.manned) {
        v.root.remove(gone.group);
        disposeTree(gone.group);
      }
      v.manned.length = 0;
      v.levied = levied;
    }
    while (v.manned.length > want) {
      const gone = v.manned.pop()!;
      v.root.remove(gone.group);
      disposeTree(gone.group);
    }
    while (v.manned.length < want) {
      const made = makeCharacter(
        b.levied ? LEVY_KIND : ARCHER_KIND,
        0,
        b.owner,
      );
      if (!made) break; // characters not loaded yet; try again next roster
      const post = v.posts[v.manned.length]!;
      post.getWorldPosition(SCRATCH_POS);
      v.root.worldToLocal(SCRATCH_POS);
      made.group.position.copy(SCRATCH_POS);
      // Face outward, away from the tower's middle: two men shoulder to
      // shoulder staring the same way read as a rank, not a watch.
      made.group.rotation.y = Math.atan2(SCRATCH_POS.x, SCRATCH_POS.z);
      // A man on the roof is not the roof (see silhouetteT) — and he is a
      // skinned mesh besides, the one shape on a building whose triangles
      // a ray cannot test cheaply.
      made.group.userData[PICK_IGNORE] = true;
      v.root.add(made.group);
      v.manned.push({group: made.group, char: made.visual});
    }
  }

  #syncPiles(v: BuildingVisual, b: BuildingSnap): void {
    if (this.#syncYard(v, b)) return;
    const def = buildingDef(b.type);
    const shown: [GoodId, number][] = [];
    for (const g of GOODS) {
      let n: number;
      if (b.state === BuildingState.site) {
        // Delivered materials wait by the frame, then drain into the
        // structure as the build progresses.
        const delivered =
          ((def.cost as Partial<Record<GoodId, number>>)[g] ?? 0) -
          (b.siteNeeds?.[g] ?? 0);
        n = Math.round(delivered * (1 - (b.progress01 ?? 0)));
      } else {
        n = (b.stock[g] ?? 0) + (b.inputs[g] ?? 0);
      }
      if (n > 0) shown.push([g, Math.min(n, 8)]);
    }
    const key = shown.map(([g, n]) => `${g}:${n}`).join('.');
    if (key === v.pileKey) return;
    v.pileKey = key;
    // Lanes are sticky. Laying the stacks out by their index in `shown`
    // meant every kind already on the ground jumped sideways the moment a
    // new kind was set down beside it — half a lane, for goods nobody had
    // touched. A good keeps the lane it was first given instead, so an
    // arrival only ever adds a stack at the edge; a good that runs out
    // hands its lane back for the next arrival to claim.
    const lanes = v.pileLanes;
    const present = new Set(shown.map(([g]) => g));
    for (const g of lanes.keys()) if (!present.has(g)) lanes.delete(g);
    const taken = new Set(lanes.values());
    for (const [g] of shown) {
      if (lanes.has(g)) continue;
      const lane = freeLane(taken);
      lanes.set(g, lane);
      taken.add(lane);
    }
    if (v.piles) {
      v.root.remove(v.piles);
      v.piles = undefined;
    }
    if (shown.length === 0) return;

    const piles = new THREE.Group();
    // Just outside the front wall, Settlers-style — goods wait at the door
    // (they're ankle-high; carriers step over them). A salvage pile has no
    // wall to wait outside: its goods lie where the building stood.
    piles.position.set(
      0,
      0,
      b.type === BuildingTypeId.salvage ? 0 : b.h / 2 + 0.3,
    );
    for (const [good, n] of shown) {
      const lane = lanes.get(good)!;
      // The lattice grows with the props (PILE_SCALE), or the fatter
      // stacks interpenetrate.
      const cx = lane * 0.42 * PILE_SCALE;
      for (let i = 0; i < n; i++) {
        const prop = makePileProp(good);
        const row = i % 3;
        const layer = (i / 3) | 0;
        prop.position.set(
          cx + (hash2(b.id * 31 + i, lane) - 0.5) * 0.06,
          layer * 0.12 * PILE_SCALE,
          (row * 0.17 - 0.17) * PILE_SCALE,
        );
        prop.rotation.y = (hash2(b.id * 17 + i, lane + 9) - 0.5) * 0.7;
        piles.add(prop);
      }
    }
    v.root.add(piles);
    v.piles = piles;
  }

  #hoverId = -1;
  #selectedId = -1;

  /** Visuals mid-teardown: the building already left the roster, the model
   * is sinking into its own dust. Purely cosmetic — picking, fog and the
   * mirror all forgot the building the moment the roster did. */
  #dying: {
    visual: BuildingVisual;
    t: number;
    baseY: number;
    tiltX: number;
    tiltZ: number;
    dust: THREE.Group;
    puffs: {
      mesh: THREE.Mesh;
      angle: number;
      r0: number;
      vr: number;
      size: number;
      /** Fraction of the teardown before this puff joins in. */
      delay: number;
      spinX: number;
      spinZ: number;
    }[];
  }[] = [];

  /**
   * Every building's damage bar, in two draw calls.
   *
   * Each bar used to be a pair of meshes parented to its building, and the
   * foreground material was cloned per building so #styleBar could tint it
   * — so a raid that hurt twenty buildings cost forty draw calls and twenty
   * materials. They are two InstancedMeshes now, rebuilt whenever something
   * that decides a bar changes: the roster and the damage (update), or what
   * is under the cursor (highlight). Not per frame — nothing about a bar
   * moves between those.
   */
  #rebuildHpBars(): void {
    const camQuat = this.cameraQuaternion ?? BAR_FALLBACK_QUAT;
    // Recorded before the early-out below: a settlement with no bars to
    // draw has nothing to re-aim either, and must not ask again next frame.
    this.#hpQuat.copy(camQuat);
    // Counted before anything is written. Two reasons: growing reallocates
    // the instance buffers, so doing it partway through the fill would
    // throw away every bar already written (a bug that only appears once a
    // settlement outgrows the starting capacity) — and an unhurt, unhovered
    // settlement, which is most of a peaceful game, then never allocates
    // the meshes at all.
    let need = 0;
    for (const [id, v] of this.#visuals) if (this.#wantsBar(id, v)) need++;
    if (need === 0) {
      if (this.#hpBg && this.#hpFg) {
        this.#hpBg.count = 0;
        this.#hpFg.count = 0;
      }
      return;
    }
    this.#ensureBarCapacity(need);
    let n = 0;
    for (const [id, v] of this.#visuals) {
      if (!this.#wantsBar(id, v)) continue;
      // The bar group hung at topY + 0.45 above a root that carries no
      // rotation of its own (a building's facing turns its model, not its
      // root), square to the screen.
      BAR_POS.set(
        v.root.position.x,
        v.root.position.y + v.topY + 0.45,
        v.root.position.z,
      );
      BAR_SCALE.set(1, 1, 1);
      BAR_MATRIX.compose(BAR_POS, camQuat, BAR_SCALE);
      this.#hpBg!.setMatrixAt(n, BAR_MATRIX);
      // The fill shrinks from the left, so it slides half of what it lost —
      // the offset the foreground mesh used to carry, rotated into the
      // screen plane because the bar is no longer parented to anything.
      const w = Math.max(v.pct, 0.02);
      BAR_SCALE.set(w, 1, 1);
      BAR_OFFSET.set((-(HP_BAR_W - 0.06) * (1 - w)) / 2, 0, 0).applyQuaternion(
        camQuat,
      );
      BAR_POS.add(BAR_OFFSET);
      BAR_MATRIX.compose(BAR_POS, camQuat, BAR_SCALE);
      this.#hpFg!.setMatrixAt(n, BAR_MATRIX);
      this.#hpFg!.setColorAt(n, hpColor(v.pct));
      n++;
    }
    if (this.#hpBg && this.#hpFg) {
      this.#hpBg.count = n;
      this.#hpFg.count = n;
      if (n > 0) {
        this.#hpBg.instanceMatrix.needsUpdate = true;
        this.#hpFg.instanceMatrix.needsUpdate = true;
        if (this.#hpFg.instanceColor)
          this.#hpFg.instanceColor.needsUpdate = true;
      }
    }
  }

  /**
   * Does this building show a bar right now? Hurt or under the cursor —
   * and not lost in fog, which used to come free from the bar being a
   * child of a hidden root and has to be asked for now that the bars live
   * in world space. Missing it would float a bar over a building the
   * player cannot see.
   */
  #wantsBar(id: number, v: BuildingVisual): boolean {
    const highlighted = id === this.#hoverId || id === this.#selectedId;
    return (v.pct < 1 || highlighted) && v.root.visible;
  }

  /** Grow the bar meshes to hold at least `need` instances. */
  #ensureBarCapacity(need: number): void {
    if (need <= 0) return;
    if (this.#hpBg && this.#hpBg.instanceMatrix.count >= need) return;
    const size = Math.max(BAR_CAPACITY_MIN, 1 << (32 - Math.clz32(need - 1)));
    if (this.#hpBg) {
      this.#scene.remove(this.#hpBg, this.#hpFg!);
      this.#hpBg.dispose();
      this.#hpFg!.dispose();
    }
    this.#hpBg = new THREE.InstancedMesh(HP_BG_GEO, HP_BG_MAT, size);
    this.#hpFg = new THREE.InstancedMesh(HP_FG_GEO, HP_FG_MAT, size);
    // The draw order the two meshes used to carry, and no frustum culling:
    // the bounding sphere describes the quad at the origin, not where the
    // instances of it actually stand.
    this.#hpBg.renderOrder = 90;
    this.#hpFg.renderOrder = 91;
    this.#hpBg.frustumCulled = false;
    this.#hpFg.frustumCulled = false;
    this.#hpBg.count = 0;
    this.#hpFg.count = 0;
    this.#scene.add(this.#hpBg, this.#hpFg);
  }

  /** Hovered or selected buildings show their hp bar even at full health. */
  highlight(hover: number, selected: number): void {
    if (hover === this.#hoverId && selected === this.#selectedId) return;
    this.#hoverId = hover;
    this.#selectedId = selected;
    this.#rebuildHpBars();
  }

  /**
   * Drop every monument visual so the next update builds them again.
   *
   * The figure on a plinth comes from the seat's playbook, and the roster
   * that carries the playbooks arrives on the first frame — after a resync
   * or a loaded save has already put monuments on the board. Without this
   * they would keep the default serf for the rest of the match.
   *
   * Immediate, not the razing teardown: nothing is being destroyed, the
   * same building is about to be rebuilt with the right face.
   */
  forgetMonuments(): void {
    // Deleting the entry the loop is standing on is defined behaviour for
    // a Map, so this needs no copy.
    for (const [id, v] of this.#visuals) {
      if (v.type === BuildingTypeId.monument) this.#dispose(id);
    }
  }

  #dispose(id: number): void {
    const v = this.#visuals.get(id);
    if (!v) return;
    this.#scene.remove(v.root);
    this.#freeGpu(v);
    this.#releaseDrawn(id, v);
    this.#visuals.delete(id);
  }

  /** Free what this visual uniquely owns on the GPU. Models share the
   * template geometry/materials — except construction sites, which clone
   * every material to carry their private clip plane, and hp bars, whose
   * per-building tinted fg material is theirs alone (quads are shared). */
  #freeGpu(v: BuildingVisual): void {
    // The roof watch, whose skeletons are this visual's alone (see
    // disposeTree). Here rather than in #dispose because a razed tower
    // never goes through it — it sinks into the ground first, and the
    // teardown pass is the other caller.
    for (const man of v.manned) disposeTree(man.group);
    v.manned.length = 0;
    // The smoke's per-puff materials are this visual's alone too (the
    // ball geometry is the shared PUFF_GEO and stays).
    if (v.smoke) {
      for (const p of v.smoke.puffs)
        (p.mesh.material as THREE.Material).dispose();
      v.smoke = undefined;
    }
    // The cue's glow materials are this visual's alone — cloned at create
    // so one barracks' fire is not every barracks' (ownTrainingMaterials).
    // The geometry under them is the shared template's and stays.
    if (v.trainMats) {
      for (const m of v.trainMats) m.dispose();
      v.trainMats = undefined;
      v.train = undefined;
    }
    if (v.clip) {
      v.model.traverse(o => {
        // eachMaterial, not `.dispose()` on the field: faction-colored
        // buildings carry material arrays, and the bare call threw here —
        // which didn't just leak, it aborted update() mid-frame. The
        // finished building vanished (site removed, built model never
        // made), the broken visual stayed in the map, and every later
        // frame re-threw at the same building, freezing building sync,
        // stock, and the outcome banner for the rest of the match.
        if (o instanceof THREE.Mesh) eachMaterial(o, m => m.dispose());
      });
    }
    // No bar material to free: bars are instances in a shared mesh now, and
    // both their geometries and both their materials are module-level.
  }
}
