import * as THREE from 'three';
import {WATER_LEVEL} from '../sim/map';
import type {HeightField} from './heightField';

/**
 * Aiming a fishery's deck at the water.
 *
 * Shared by the two places a fishery is drawn on terrain: BuildingSync,
 * which stands the built hut and hands sceneSync the deck line its
 * fisherman walks, and GhostPlacement, which shows the player the same hut
 * under the cursor before they commit to the spot. Both want the identical
 * answer — a preview whose jetty ends on grass is a promise the finished
 * building then breaks.
 */

/** A fishery's pier, in world space: the deck line from its landward end to
 * the fishing spot near the tip, plank height, and the yaw the deck runs at
 * — which is where the water is, not merely where the hut faces (`fitPier`).
 * Shared with sceneSync, which walks the fisherman out along it. */
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
/** How far either way the aim may swing: six steps, so a right angle.
 *
 * The sim's facing is a guess at the water, not a promise about it (it
 * names the quarter the NEAREST water tile lies in — world.ts
 * waterFacing), so the fit has to be free to leave it. A right angle is
 * as far as that guess can be wrong while still pointing at the same
 * body of water; past it the deck would be answering a different shore
 * than the one the hut was sited for. */
const PIER_TURN_STEPS = 6;
/** One step off the deck's authored length, world units. */
const PIER_TRIM_STEP = 0.25;
/** How much of the deck may be given up: four steps, so a whole tile. */
const PIER_TRIM_STEPS = 4;

/**
 * How far to either side of the planks the fit looks for water, world
 * units — clear of the deck's own width (~0.6) and its mooring posts, so
 * a probe that comes back wet is open water somebody could row into
 * rather than the gap under the planks.
 */
const PIER_FLANK = 0.7;

/**
 * Where along the deck those flanks are read, as a share of its run: out
 * past the hut, and again near the tip where the fisherman stands.
 */
const PIER_FLANK_AT: readonly number[] = [0.55, 0.9];

/**
 * Where the fit reads the lake to decide which way it opens, as shares of
 * the deck's own reach: just past the planks' landward half, at the tip,
 * and a deck's length again beyond it. Three rings rather than one because
 * a single ring reads a reed-fringed notch as confidently as it reads the
 * open lake.
 */
const AIM_RINGS: readonly number[] = [0.6, 1, 1.6];

/** How many directions those rings are read in — 24, so the same 15
 * degrees the deck itself turns in. */
const AIM_STEPS = 24;

/**
 * How much clear water the fit keeps between two decks, world units.
 *
 * Placement only ever guards footprints, and a fishery's deck hangs two
 * tiles past its own (PIER_TILES in assets.ts) — so two huts on the same
 * bank, each legally sited, can put their planks through one another. The
 * second deck to be measured is the one that gives way. A deck is ~0.6
 * wide, so this leaves a gap about as wide as the planks themselves: they
 * read as two jetties on one shore rather than one forked structure.
 */
const PIER_CLEARANCE = 1;

/**
 * The passes the search makes, in order, stopping at the first that finds
 * anything: keep off the neighbours' planks while there is still water to
 * be had, and only crowd them when the alternative is a deck standing on
 * grass.
 *
 * Both halves matter in that order. A shore crowded enough that no aim is
 * both wet and clear is rare in a village and routine in the model lab,
 * which stands a fishery on every legal site at once — and there the
 * strict rule alone left a hundred decks in the fields, which is much
 * worse to look at than two jetties sharing a corner.
 */
const PIER_PASSES: readonly {draft: number; clear: boolean}[] = [
  {draft: PIER_DRAFT, clear: true},
  {draft: 0, clear: true},
  {draft: PIER_DRAFT, clear: false},
  {draft: 0, clear: false},
];

/**
 * Every deck the fit may choose between: `turn` in 15-degree steps off the
 * building's facing (turning the WHOLE building — the deck stays square to
 * the hut), `trim` in quarter-tile steps off the deck's authored length.
 *
 * Unsorted, because unlike the old search this one does not take the first
 * candidate that works — it scores them all and `bestFit` picks. (The
 * model lab's pier page, tools/modelLab/_pier.html, renders the result on
 * generated shoreline; it is where these numbers are judged.)
 */
const PIER_FITS: readonly {turn: number; trim: number}[] = (() => {
  const fits: {turn: number; trim: number}[] = [];
  for (let turn = -PIER_TURN_STEPS; turn <= PIER_TURN_STEPS; turn++)
    for (let trim = 0; trim <= PIER_TRIM_STEPS; trim++) fits.push({turn, trim});
  return fits;
})();

/** A candidate deck, scored. */
interface ScoredFit {
  turn: number;
  trim: number;
  /** How many of the flank probes came back wet, out of four. */
  flank: number;
  /** Radians off the direction the water opens in (`waterAim`). */
  aimOff: number;
}

/** Two angles' separation, radians, whichever way round is shorter. */
function angleGap(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

/**
 * Which way this shore opens: the direction of the water around the
 * building, as a yaw.
 *
 * Every ring point that comes back wet votes with its own direction and
 * the votes are summed, so the answer is the middle of the water rather
 * than the nearest drop of it — on a bank running northwest to southeast
 * that is the perpendicular, which is why fisheries on diagonal shores
 * come out on the diagonal without anything here preferring 45 degrees as
 * such. A shore that genuinely runs east to west still answers due north,
 * and its deck still comes out square to the grid.
 *
 * Null where nothing around the building is wet — there is no aim to have,
 * and the fit falls back on its other preferences.
 */
function waterAim(
  heights: HeightField,
  cx: number,
  cz: number,
  reach: number,
): number | null {
  let sx = 0;
  let sz = 0;
  for (let i = 0; i < AIM_STEPS; i++) {
    const th = (i * 2 * Math.PI) / AIM_STEPS;
    const dx = Math.sin(th);
    const dz = Math.cos(th);
    for (const r of AIM_RINGS) {
      if (heights.at(cx + dx * reach * r, cz + dz * reach * r) < WATER_LEVEL) {
        sx += dx;
        sz += dz;
      }
    }
  }
  return sx === 0 && sz === 0 ? null : Math.atan2(sx, sz);
}

/**
 * Which of two decks the fishery would rather have.
 *
 * Open water alongside first, and by a long way: a deck with the lake on
 * both sides is a jetty, and the same deck with a bank alongside it is a
 * boardwalk running down the shore. That is the whole difference between a
 * fishery that looks sited and one that looks dropped.
 *
 * Then the longer deck, because a trim is planking given up. Then the aim
 * nearest the way the water opens (`waterAim`) — which is what stops a
 * deck standing square to the grid on a bank that runs across it, the
 * thing that reads as odd even when the planks are over water the whole
 * way. The sim's facing is only the last word between two aims the lake
 * cannot choose between, so a fishery still points roughly where the sim
 * said and two hosts drawing the same building draw it the same way; east
 * before west settles the last tie.
 */
function better(a: ScoredFit, b: ScoredFit): boolean {
  // Aims a step apart differ by 15 degrees, so anything under a thousandth
  // of a radian is the same angle reached from either side of the water's.
  const aim = Math.abs(a.aimOff - b.aimOff) > 1e-3 ? b.aimOff - a.aimOff : 0;
  return (
    (a.flank - b.flank ||
      b.trim - a.trim ||
      aim ||
      Math.abs(b.turn) - Math.abs(a.turn) ||
      a.turn - b.turn) > 0
  );
}

/** Shortest distance between two 2D segments — deck against deck. */
function segmentGap(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): number {
  const pointGap = (
    px: number,
    pz: number,
    sx: number,
    sz: number,
    ex: number,
    ez: number,
  ): number => {
    const vx = ex - sx;
    const vz = ez - sz;
    const len2 = vx * vx + vz * vz;
    const t =
      len2 === 0
        ? 0
        : Math.max(0, Math.min(1, ((px - sx) * vx + (pz - sz) * vz) / len2));
    return Math.hypot(px - (sx + vx * t), pz - (sz + vz * t));
  };
  // Two segments either cross — gap zero — or their closest approach is at
  // one of the four endpoints, which is what a walk of the four covers.
  const d1 = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
  if (d1 !== 0) {
    const s = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / d1;
    const t = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / d1;
    if (s >= 0 && s <= 1 && t >= 0 && t <= 1) return 0;
  }
  return Math.min(
    pointGap(ax, az, cx, cz, dx, dz),
    pointGap(bx, bz, cx, cz, dx, dz),
    pointGap(cx, cz, ax, az, bx, bz),
    pointGap(dx, dz, ax, az, bx, bz),
  );
}

/** The parts of a drawn fishery the fit moves: the root standing on the
 * ground at the footprint center, the named deck somewhere under it, the
 * shoal working the water off its end, and the quarter turn the sim gave
 * the hut (Building.facing). */
export interface PierParts {
  root: THREE.Object3D;
  pier: THREE.Object3D;
  shoal?: THREE.Object3D | undefined;
  facing: number;
}

const SCRATCH = new THREE.Vector3();

/**
 * Re-seat the shoal for the ground this fishery stands on.
 *
 * The template bakes the fish at deck height off the front edge, but the
 * water surface is a world plane well below the shore the building stands
 * on — left there, they circle in the air over the waterline. Drop the
 * group so they swim just under the surface: a world-unit drop, folded back
 * into the model's vertical scale.
 */
export function seatShoal(
  shoal: THREE.Object3D,
  model: THREE.Object3D,
  rootY: number,
): void {
  shoal.position.y = (WATER_LEVEL - SHOAL_DRAFT - rootY) / model.scale.y;
}

/** The facing-rotated model under the root — the node a turn spins, and the
 * pier's own ancestor, so house and deck can never come apart. */
export function pierModel(parts: PierParts): THREE.Object3D {
  let model: THREE.Object3D = parts.pier;
  while (model.parent && model.parent !== parts.root) model = model.parent;
  return model;
}

/**
 * Aim this fishery's deck at the open water and report where it ends up.
 *
 * The deck has to reach water at all — its tip and the fisherman's spot
 * both stand over it or the aim is no aim — and among the aims that manage
 * that, the one with the most water alongside the planks wins (`better`).
 *
 * `taken` is the decks already standing: this one keeps clear of them
 * (PIER_CLEARANCE), so a second fishery on the same bank turns or trims
 * around its neighbour instead of growing through it. Pass the piers
 * already measured; an empty list means a free shore.
 *
 * Mutates the model: a turn rotates the whole thing about the footprint
 * center, a trim pulls the deck (and the fish off its end) in toward the
 * landward end. Callers that re-fit the same model — the placement ghost,
 * which walks it across the shore a tile at a time — must put the decor
 * back the way the template authored it first, because both moves compound.
 */
export function fitPier(
  parts: PierParts,
  heights: HeightField,
  taken: readonly PierInfo[] = [],
): PierInfo {
  const {root, pier, shoal} = parts;
  // This runs on structural updates, possibly before the next render
  // ticks world matrices — settle them before measuring.
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(pier);
  const facingYaw = (parts.facing * Math.PI) / 2;
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
  const pvX = root.position.x;
  const pvZ = root.position.z;
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
  // Where each standing deck runs, as a segment this one must not cross.
  const others = taken.map(p => {
    const dirX = Math.sin(p.yaw);
    const dirZ = Math.cos(p.yaw);
    return [
      p.baseX,
      p.baseZ,
      p.spotX + dirX * PIER_SPOT_BACK,
      p.spotZ + dirZ * PIER_SPOT_BACK,
    ] as const;
  });
  // Water beside the planks is asked of the surface, not of the draft: a
  // shallow margin still reads as water from the shore, and a flank score
  // that changed between the two passes below would have the deck swinging
  // for a reason the player cannot see.
  const flanksOf = (
    bX: number,
    bZ: number,
    fitYaw: number,
    fitLen: number,
  ): number => {
    const dirX = Math.sin(fitYaw);
    const dirZ = Math.cos(fitYaw);
    let n = 0;
    for (const at of PIER_FLANK_AT) {
      const alongX = bX + dirX * fitLen * at;
      const alongZ = bZ + dirZ * fitLen * at;
      // Perpendicular to the deck, a probe to either hand.
      for (const side of [1, -1]) {
        const px = alongX + dirZ * PIER_FLANK * side;
        const pz = alongZ - dirX * PIER_FLANK * side;
        if (heights.at(px, pz) < WATER_LEVEL) n++;
      }
    }
    return n;
  };
  // Which way this shore opens, read once off the building's own ground —
  // the aim every candidate is measured against below.
  const aim = waterAim(heights, root.position.x, root.position.z, len);
  // Deep enough to read as water if any aim can manage it, wet at all if
  // none can; a shore that no aim reaches keeps the authored deck, which is
  // no worse than what the model shipped with.
  for (const pass of PIER_PASSES) {
    // Nothing standing nearby: the two lenient passes would only repeat
    // the strict ones.
    if (!pass.clear && others.length === 0) break;
    const wet = (x: number, z: number): boolean =>
      heights.at(x, z) < WATER_LEVEL - pass.draft;
    let best: ScoredFit | null = null;
    for (const f of PIER_FITS) {
      const th = f.turn * PIER_TURN_STEP;
      const [bX, bZ] = spin(baseX, baseZ, th);
      const fitYaw = facingYaw + th;
      const fitLen = len - f.trim * PIER_TRIM_STEP;
      const dirX = Math.sin(fitYaw);
      const dirZ = Math.cos(fitYaw);
      const tipX = bX + dirX * fitLen;
      const tipZ = bZ + dirZ * fitLen;
      if (!wet(tipX, tipZ)) continue;
      if (!wet(tipX - dirX * PIER_SPOT_BACK, tipZ - dirZ * PIER_SPOT_BACK))
        continue;
      if (
        pass.clear &&
        others.some(
          o =>
            segmentGap(bX, bZ, tipX, tipZ, o[0], o[1], o[2], o[3]) <
            PIER_CLEARANCE,
        )
      )
        continue;
      const cand = {
        turn: f.turn,
        trim: f.trim,
        flank: flanksOf(bX, bZ, fitYaw, fitLen),
        aimOff: aim === null ? 0 : angleGap(fitYaw, aim),
      };
      if (best === null || better(cand, best)) best = cand;
    }
    if (!best) continue;
    const th = best.turn * PIER_TURN_STEP;
    const fitLen = len - best.trim * PIER_TRIM_STEP;
    yaw = facingYaw + th;
    scale = fitLen / len;
    [fitBaseX, fitBaseZ] = spin(baseX, baseZ, th);
    spotX = fitBaseX + Math.sin(yaw) * (fitLen - PIER_SPOT_BACK);
    spotZ = fitBaseZ + Math.cos(yaw) * (fitLen - PIER_SPOT_BACK);
    if (th !== 0) {
      pierModel(parts).rotation.y += th;
      root.updateWorldMatrix(true, true);
    }
    break;
  }
  if (scale !== 1) fitDecor(pier, shoal, fitBaseX, fitBaseZ, scale);
  return {
    bx: root.position.x,
    bz: root.position.z,
    baseX: fitBaseX,
    baseZ: fitBaseZ,
    spotX,
    spotZ,
    yaw,
    // A trimmed deck is a smaller dock, planks and all, so its top comes
    // down with it.
    deckY: root.position.y + PIER_DECK_Y * scale,
  };
}

/**
 * Re-seat the pier — and the shoal working the water off its end — for
 * the trim `fitPier` chose: pull both in to `scale` of their reach
 * from the deck's landward end. (A turn is not handled here — it rotates
 * the whole model, so the decor rides along for free.)
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
function fitDecor(
  pier: THREE.Object3D,
  shoal: THREE.Object3D | undefined,
  baseX: number,
  baseZ: number,
  scale: number,
): void {
  for (const obj of [pier, shoal]) {
    if (!obj?.parent) continue;
    obj.parent.worldToLocal(SCRATCH.set(baseX, 0, baseZ));
    obj.position.x = SCRATCH.x + (obj.position.x - SCRATCH.x) * scale;
    obj.position.z = SCRATCH.z + (obj.position.z - SCRATCH.z) * scale;
  }
  pier.scale.multiplyScalar(scale);
}
