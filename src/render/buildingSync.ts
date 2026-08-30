import * as THREE from 'three';
import {LOOP_CUES} from '../audio/animCues';
import type {CueId} from '../audio/cues';
import type {BuildingSnap} from '../protocol/messages';
import * as StaffingState from '../protocol/staffingStateEnum.ts';
import type {Enum} from '../shared/enum.ts';
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
import {makeCharacter, playAnimation, type CharacterVisual} from './characters';
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

type BuildingState = Enum<typeof BuildingState>;
type GoodId = Enum<typeof GoodId>;

/** A built fishery's pier, in world space: the deck line from its landward
 * end to the fishing spot near the tip, plank height, and the yaw that
 * faces the water. Shared with sceneSync, which walks the fisherman out
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
  frame?: THREE.Group;
  model: THREE.Group;
  /** Warcraft-style rise: a world-space clip plane reveals the model
   * bottom-up as materials arrive and progress ticks. */
  clip?: {plane: THREE.Plane; height: number; baseY: number};
  /** Model height above ground, for floating the hp bar. */
  topY: number;
  /**
   * A road: flat ground once it is laid, and a thing units walk along
   * rather than a thing anyone clicks. Its scaffolding is not worth a pick
   * box — see heightOf.
   */
  road: boolean;
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
  shoal?: THREE.Object3D;
  /** The fishery's pier decor — the deck the fisherman walks out on. */
  pier?: THREE.Object3D;
  /** Measured deck line, cached: measuring may also swing the decor 45°
   * on a corner-only shore, and that must happen exactly once. */
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
  userData: {noFog: true},
});

/** White, so each bar's per-instance colour comes through unmultiplied. */
const HP_FG_MAT = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  depthTest: false,
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
 * Mirrors the building list into the scene. Sites show a timber frame with
 * the real building rising out of it half-built (clip-plane reveal) while a
 * peasant hammers away; completion swaps in the solid model. Without loaded
 * GLB assets it falls back to the ghost-scale-up look.
 */
export class BuildingSync {
  #scene: THREE.Scene;
  #heights: HeightField;
  /** Seat viewing the scene — everyone else is an enemy to the fog. */
  #owner: number;
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
    if (v.state !== BuildingState.site) return v.topY;
    const raised = v.clip
      ? Math.max(0, v.clip.plane.constant - v.clip.baseY)
      : // The ghost site grows by scale rather than by clip, and topY was
        // measured at the seed scale — read the drawn height back off it.
        (v.topY * v.model.scale.y) / GHOST_SEED_SCALE;
    return Math.max(SITE_FRAME_H, raised);
  }

  /** The elevation this building stands on — see BuildingHeights.baseOf. */
  baseOf(id: number): number {
    return this.#visuals.get(id)?.root.position.y ?? 0;
  }

  /** The highest roofline standing — see #ceiling. */
  ceiling(): number {
    return this.#ceiling;
  }

  constructor(scene: THREE.Scene, heights: HeightField, owner = 0) {
    this.#scene = scene;
    this.#heights = heights;
    this.#owner = owner;
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
      }

      // Enemy buildings are remembered: once you have seen a camp it stays
      // on the map even when the light moves off it, because it is not
      // going anywhere. (Units get the opposite rule — see sceneSync.)
      if (this.#fog && b.owner !== this.#owner) {
        v.root.visible = this.#fog.exploredAt(b.x + b.w / 2, b.y + b.h / 2);
      }

      v.staffed = b.staffing === StaffingState.staffed;
      v.working = b.working === true;
      v.firing = b.firing === true;
      v.volleyRange = volleyRangeOf(b);
      this.#syncPiles(v, b);
      this.#syncGarrison(v, b);

      // Damage bar: appears once hurt (highlight() shows it on healthy
      // ones). Recorded here, drawn by #rebuildHpBars once the roster is
      // settled — a bar is an instance in a shared mesh now, not an object
      // hung off this building.
      v.pct = b.maxHp > 0 ? b.hp / b.maxHp : 1;
    }
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

  #beginTeardown(id: number): void {
    const v = this.#visuals.get(id);
    if (!v) return;
    this.#visuals.delete(id);
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
    if (shoal)
      shoal.position.y =
        (WATER_LEVEL - SHOAL_DRAFT - root.position.y) / model.scale.y;

    const topY = clip
      ? clip.height
      : new THREE.Box3().setFromObject(model).max.y;
    // Where this building's roof will reach when it is finished, which is
    // what the pick walk wants as its ceiling: a site's finished height
    // (topY is already that for a clipped one, and the seed scale away from
    // it for a ghost), never less than the frame it stands in while it gets
    // there, and all of it over the ground this one stands on.
    const road = buildingDef(b.type).isRoad === true;
    const finished =
      b.state === BuildingState.site
        ? Math.max(SITE_FRAME_H, clip ? topY : topY / GHOST_SEED_SCALE)
        : topY;
    if (!road)
      this.#ceiling = Math.max(this.#ceiling, root.position.y + finished);
    this.#scene.add(root);
    return {
      root,
      state: b.state,
      frame,
      model,
      clip,
      topY,
      road,
      pct: 1,
      pileKey: '',
      pileLanes: new Map(),
      crank: model.getObjectByName('wellCrank') ?? undefined,
      fan: model.getObjectByName('millFan') ?? undefined,
      fanSpeed: 0,
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
    };
  }

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

  /** Terrain lookup (tile ints -> is water?), fed from main's map mirror.
   * The pier measurement uses it to tell a wet tip from a dry one. */
  #water: ((tx: number, tz: number) => boolean) | null = null;

  setWater(query: (tx: number, tz: number) => boolean): void {
    this.#water = query;
  }

  /** Built fisheries' piers, in world space: where the deck line runs
   * (landward end -> fishing spot near the tip), the height of the planks,
   * and the yaw that faces the water. sceneSync walks the resident
   * fisherman out along it and stands him at the spot, line in the water —
   * the same render-side move as the well serfs, because the sim parks him
   * on whatever tile the path found. */
  fisheryPiers(): PierInfo[] {
    const out: PierInfo[] = [];
    for (const v of this.#visuals.values()) {
      if (v.state !== BuildingState.built || !v.pier) continue;
      out.push((v.pierLine ??= this.#measurePier(v)));
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
    let yaw = (v.facing * Math.PI) / 2;
    let dirX = Math.sin(yaw);
    let dirZ = Math.cos(yaw);
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    // Facing is a quarter turn, so the deck line lies along one axis.
    const half =
      (Math.abs(dirX) > 0.5 ? box.max.x - box.min.x : box.max.z - box.min.z) /
      2;
    const baseX = cx - dirX * half;
    const baseZ = cz - dirZ * half;
    let tipX = cx + dirX * half;
    let tipZ = cz + dirZ * half;
    // Corner-only shores: placement guarantees water touching the
    // footprint, but facing is a quarter turn — when the water sits on
    // the diagonal, a straight pier ends on grass. Swing the deck 45°
    // about its landward end toward whichever diagonal is wet. Without a
    // terrain feed (tests, or before main wires it) the tip counts as
    // wet and the pier stays straight.
    const wet = (x: number, z: number): boolean =>
      this.#water?.(Math.floor(x), Math.floor(z)) ?? true;
    if (!wet(tipX, tipZ)) {
      for (const theta of [Math.PI / 4, -Math.PI / 4]) {
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        const rx = tipX - baseX;
        const rz = tipZ - baseZ;
        const tx = baseX + rx * c + rz * s;
        const tz = baseZ - rx * s + rz * c;
        if (!wet(tx, tz)) continue;
        this.#swingDecor(v, baseX, baseZ, theta);
        yaw += theta;
        dirX = Math.sin(yaw);
        dirZ = Math.cos(yaw);
        tipX = tx;
        tipZ = tz;
        break;
      }
    }
    return {
      bx: v.root.position.x,
      bz: v.root.position.z,
      baseX,
      baseZ,
      // A step short of the tip, so the toes stay on the planks.
      spotX: tipX - dirX * 0.4,
      spotZ: tipZ - dirZ * 0.4,
      yaw,
      // The docks model's plank top sits at 0.04 of its own units; after
      // the decor scale that is ~0.05 over the building's ground. The
      // pier bbox can't say (its mooring posts top out well above the
      // deck), so the constant it is.
      deckY: v.root.position.y + 0.05,
    };
  }

  /** Rotate the pier — and the shoal working the water off its end — about
   * the vertical line through the deck's landward end. The parent chain is
   * Y-rotation plus uniform scale, so a world-space angle carries into the
   * local frame unchanged. */
  #swingDecor(
    v: BuildingVisual,
    baseX: number,
    baseZ: number,
    theta: number,
  ): void {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const p = new THREE.Vector3();
    for (const obj of [v.pier, v.shoal]) {
      if (!obj?.parent) continue;
      obj.parent.worldToLocal(p.set(baseX, 0, baseZ));
      const rx = obj.position.x - p.x;
      const rz = obj.position.z - p.z;
      obj.position.x = p.x + rx * c + rz * s;
      obj.position.z = p.z - rx * s + rz * c;
      obj.rotation.y += theta;
    }
  }

  /** Per render frame: the decor that moves. dt in seconds (pass 0 while
   * paused). Windlasses are not here — the well keeps no resident, so there
   * is nothing building-side to key them off; sceneSync turns each one under
   * the serf that came to draw from it. */
  /**
   * Per-frame decor: sails, shoals and the watch on the roof.
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
    for (const v of this.#visuals.values()) {
      // Most of a settlement is huts and warehouses with nothing that
      // moves; this loop used to walk all of them to find that out.
      if (!v.fan && !v.shoal && v.manned.length === 0) continue;
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
    // (they're ankle-high; carriers step over them).
    piles.position.set(0, 0, b.h / 2 + 0.3);
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

  #dispose(id: number): void {
    const v = this.#visuals.get(id);
    if (!v) return;
    this.#scene.remove(v.root);
    this.#freeGpu(v);
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
