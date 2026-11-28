import * as THREE from 'three';
import {describe, expect, it, vi} from 'vitest';
import {
  ACTION,
  PUBLISH_INTERVAL_MS,
  SAB_BYTES,
  SabReader,
  SabWriter,
  WORK,
  type UnitSnapshot,
} from '../protocol/sabLayout';
import {unitSnapshots} from '../protocol/snapshot.ts';
import {TICKS_PER_SECOND} from '../sim/defs/balance.ts';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import {UNIT_DEFS} from '../sim/defs/units.ts';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum.ts';
import {addSerf, addStorehouse, bareWorld} from '../sim/testUtils.ts';
import {tickWorld} from '../sim/tick.ts';
import {placeBuiltBuilding} from '../sim/world.ts';
import type {HeightField} from './heightField';

/**
 * The hauler at the well. The sim walks him to the tile east of the shaft
 * (BuildingDef.drawFrom) and stands him in its middle for the whole draw;
 * the handle is a third of a tile in from there, and the render takes him
 * that last step. It used to ease him onto it in a tenth of a second —
 * from the wrong side of the well, straight through it — which read as a
 * teleport. What is pinned here is that every frame of it is a walk.
 *
 * Only the body is stubbed, as in sceneSync.pier.test.ts: an empty clip
 * library, which every character call in the loop tolerates. Positions come
 * back through positionOfInto, the channel picking reads.
 */
const groups: THREE.Group[] = [];
vi.mock('./characters', async importOriginal => {
  const real = await importOriginal<typeof import('./characters')>();
  return {
    ...real,
    makeCharacter: () => {
      const group = new THREE.Group();
      groups.push(group);
      return {
        group,
        visual: {
          mixer: new THREE.AnimationMixer(group),
          actions: new Map(),
          current: null,
          gait: 0,
          gaitNat: {walk: 0, jog: 0},
          gaitSpeed: 0,
          ranged: false,
          toolKind: 0,
        },
      };
    },
  };
});

const {SceneSync} = await import('./sceneSync');

const flat = {at: () => 0} as unknown as HeightField;

const FRAME_MS = 1000 / 60;
const DT = FRAME_MS / 1000;
/** Render frames per publish: twenty a second under sixty. Counted rather
 * than timed, so float drift cannot land two publishes a frame apart and
 * charge the interpolation's catch-up to the walk under test. */
const FRAMES_PER_PUBLISH = Math.round(PUBLISH_INTERVAL_MS / FRAME_MS);
/** The sim's own stride for him, tiles a second. */
const SERF_SPEED = UNIT_DEFS[UnitTypeId.serf].speed;
/** The render's, for the steps it takes him itself (sceneSync.ts). */
const RENDER_WALK = UNIT_DEFS[UnitTypeId.worker].speed;

/** A well on tile (26, 30): its centre, and the crank side east of it. */
const WELL_X = 26.5;
const WELL_Z = 30.5;
const CRANK_TILE = {x: 27.5, y: 30.5};
/** Where the render stands him to wind it (CRANK_MARK_X/Z). */
const MARK = {x: WELL_X + 0.64, y: WELL_Z - 0.12};

const EAST = 64;
const WEST = 192;

function hauler(over: Partial<UnitSnapshot>): UnitSnapshot {
  return {
    id: 1,
    x: CRANK_TILE.x,
    y: CRANK_TILE.y,
    kind: UnitTypeId.serf,
    owner: 0,
    hpPct: 255,
    maxHp: 38,
    carrying: 0,
    action: ACTION.work,
    workKind: WORK.draw,
    ...over,
  };
}

/**
 * One hauler and one well, with the sim publishing twenty times a second
 * under a sixty-frame render loop — the cadence a match runs at, so the
 * interpolation between publishes is in every measurement as it would be
 * on screen.
 */
function rig(first: UnitSnapshot, others: {x: number; z: number}[] = []) {
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const writer = new SabWriter(sab);
  const reader = new SabReader(sab);
  const sync = new SceneSync(new THREE.Scene(), reader, flat);
  const well = (at: {x: number; z: number}) => {
    const crank = new THREE.Object3D();
    const grip = new THREE.Object3D();
    grip.position.set(0.36, -0.09, 0);
    crank.add(grip);
    return {...at, crank, grip};
  };
  const wells = [{x: WELL_X, z: WELL_Z}, ...others].map(well);
  const crank = wells[0]!.crank;
  sync.setWells(wells);
  groups.length = 0;
  let frames = 0;
  let now = 0;
  // Twice, so the second publish has a predecessor to read "standing
  // still" from.
  writer.publish([first], 0);
  reader.poll(now);
  writer.publish([first], 0);
  reader.poll(now);
  const out = {x: 0, y: 0};
  const where = () => {
    sync.positionOfInto(1, now, out);
    return {x: out.x, y: out.y};
  };
  return {
    crank,
    /** Every well's windlass, ours first. */
    cranks: wells.map(w => w.crank),
    where,
    now: () => now,
    yaw: () => groups[0]!.rotation.y,
    /** One render frame; `sim` is asked for the unit whenever a publish
     * falls due. Returns how far he was drawn moving this frame. */
    frame(sim: (t: number) => UnitSnapshot): number {
      const before = where();
      now = ++frames * FRAME_MS;
      if (frames % FRAMES_PER_PUBLISH === 0) writer.publish([sim(now)], 0);
      reader.poll(now);
      sync.update(now);
      const after = where();
      return Math.hypot(after.x - before.x, after.y - before.y);
    },
  };
}

const dist = (a: {x: number; y: number}, b: {x: number; y: number}): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe('the hauler at the well', () => {
  it('walks the last step to the handle, and winds only once he is there', () => {
    // Up from the east along the row, the way the sim brings him — the
    // walk ends in the middle of the crank side's tile, and he draws.
    const fromX = 30.5;
    const walkMs = ((fromX - CRANK_TILE.x) / SERF_SPEED) * 1000;
    const sim = (t: number): UnitSnapshot =>
      t < walkMs
        ? hauler({
            x: fromX - (t / 1000) * SERF_SPEED,
            action: ACTION.idle,
          })
        : hauler({});
    const r = rig(hauler({x: fromX, action: ACTION.idle}));

    // The sim's walk, through to the render seeing him stand. Never more
    // than his stride and the render's at once: on the frame the stop is
    // seen, the interpolation lands the last of the sim's walk and the
    // render takes its first step in the same frame.
    let worst = 0;
    while (r.now() < walkMs + 2 * PUBLISH_INTERVAL_MS)
      worst = Math.max(worst, r.frame(sim));
    expect(worst).toBeLessThanOrEqual((SERF_SPEED + RENDER_WALK) * DT + 1e-6);
    // Stepping toward the handle, and not there yet: nothing has been
    // winding it.
    expect(dist(r.where(), MARK)).toBeGreaterThan(0.25);
    expect(r.crank.rotation.x).toBe(0);

    // From here every frame is a step at the render's walking pace and
    // no more. Eased, the first frame alone covered 0.06 of a tile.
    worst = 0;
    let wound = false;
    for (let f = 0; f < 60; f++) {
      const moved = r.frame(sim);
      worst = Math.max(worst, moved);
      if (r.crank.rotation.x > 0) {
        // The windlass turns only under his hand.
        expect(dist(r.where(), MARK)).toBeLessThan(1e-6);
        wound = true;
      }
    }
    expect(worst).toBeLessThanOrEqual(RENDER_WALK * DT + 1e-6);
    expect(wound).toBe(true);
    expect(dist(r.where(), MARK)).toBeLessThan(1e-6);
    expect(r.yaw()).toBeCloseTo(0); // side-on to the well, crank at his right
  });

  it('walks off the handle when the draw is done, rather than sliding', () => {
    const r = rig(hauler({}));
    for (let f = 0; f < 60; f++) r.frame(() => hauler({}));
    expect(dist(r.where(), MARK)).toBeLessThan(1e-6);

    // Bucket up: the sim walks him away east from the middle of his tile.
    // The third of a tile between there and the handle is given back while
    // he goes — never faster than half a stride on top of his own.
    let start: number | undefined;
    const sim = (t: number): UnitSnapshot => {
      start ??= t;
      return hauler({
        x: CRANK_TILE.x + ((t - start) / 1000) * SERF_SPEED,
        action: ACTION.idle,
      });
    };
    let worst = 0;
    for (let f = 0; f < 90; f++) worst = Math.max(worst, r.frame(sim));
    expect(worst).toBeLessThanOrEqual(
      (SERF_SPEED + RENDER_WALK / 2) * DT + 1e-6,
    );
    // ...and given back in full: he is walking where the sim has him.
    r.frame(sim);
    const at = r.where();
    expect(Math.abs(at.y - CRANK_TILE.y)).toBeLessThan(1e-3);
  });

  it('turns to the handle, not to the bearing the sim sends', () => {
    const r = rig(hauler({facing: WEST, targetDist: 8}));
    for (let f = 0; f < 60; f++)
      r.frame(() => hauler({facing: WEST, targetDist: 8}));
    expect(r.yaw()).toBeCloseTo(0);
  });

  it('leaves a man the sim stood across the shaft to draw where he is', () => {
    // The crank side was shut, so the sim stood him on the west tile
    // instead. The handle is across the well from there: he is not walked
    // round to it (still less through it), the windlass does not turn on
    // its own, and the bearing turns him to the shaft.
    const west = hauler({x: 25.5, facing: EAST, targetDist: 8});
    const r = rig(west);
    for (let f = 0; f < 60; f++) r.frame(() => west);
    expect(dist(r.where(), {x: 25.5, y: 30.5})).toBeLessThan(1e-6);
    expect(r.crank.rotation.x).toBe(0);
    expect(r.yaw()).toBeCloseTo(Math.PI / 2); // facing +x, the well
  });

  it('winds the well he draws from when two share his tile', () => {
    // Two wells two tiles apart in a row: our crank side is the other
    // well's west ring tile. A man the sim stood there for the EAST well
    // (its own crank side shut) is drawing from that one — the bearing
    // says so — and must not be walked to our handle or turn our windlass.
    const other = {x: WELL_X + 2, z: WELL_Z};
    const forOther = hauler({facing: EAST, targetDist: 8});
    const r = rig(forOther, [other]);
    for (let f = 0; f < 60; f++) r.frame(() => forOther);
    expect(dist(r.where(), CRANK_TILE)).toBeLessThan(1e-6);
    expect(r.cranks.every(c => c.rotation.x === 0)).toBe(true);
    expect(r.yaw()).toBeCloseTo(Math.PI / 2); // turned to the east well

    // The same tile, drawing from ours: he is at our crank.
    const forUs = hauler({facing: WEST, targetDist: 8});
    const s = rig(forUs, [other]);
    for (let f = 0; f < 60; f++) s.frame(() => forUs);
    expect(dist(s.where(), MARK)).toBeLessThan(1e-6);
    expect(s.cranks[0]!.rotation.x).toBeGreaterThan(0);
    expect(s.cranks[1]!.rotation.x).toBe(0);
  });

  it('fetches a bucket from the far side without a jump or a short cut', () => {
    // The whole errand, sim and render together: a storehouse west of the
    // well, a man between them, one bucket. The sim walks him round the
    // shaft to the crank side, holds him there for the draw and walks him
    // home; the render takes every publish of it at sixty frames a second.
    const world = bareWorld();
    addStorehouse(world, 14, 30, {});
    const well = placeBuiltBuilding(world, BuildingTypeId.well, 0, 26, 30);
    well.stock[GoodId.water] = 1;
    well.paused = true; // one bucket, one errand
    const serf = addSerf(world, 20, 30);
    expect(well.x + 0.5).toBe(WELL_X); // the render's well is this one
    expect(well.y + 0.5).toBe(WELL_Z);

    const sab = new SharedArrayBuffer(SAB_BYTES);
    const writer = new SabWriter(sab);
    const reader = new SabReader(sab);
    const sync = new SceneSync(new THREE.Scene(), reader, flat);
    const crank = new THREE.Object3D();
    const grip = new THREE.Object3D();
    crank.add(grip);
    sync.setWells([{x: WELL_X, z: WELL_Z, crank, grip}]);
    const framesPerTick = Math.round(60 / TICKS_PER_SECOND);
    let now = 0;
    const out = {x: 0, y: 0};
    const where = () => {
      sync.positionOfInto(serf.id, now, out);
      return {x: out.x, y: out.y};
    };

    let worst = 0;
    let wound = false;
    let carried = false;
    let prev: {x: number; y: number} | undefined;
    for (let t = 0; t < 40 * TICKS_PER_SECOND; t++) {
      tickWorld(world, []);
      writer.publish([...unitSnapshots(world)], 0);
      for (let f = 0; f < framesPerTick; f++) {
        now += FRAME_MS;
        reader.poll(now);
        sync.update(now);
        const at = where();
        if (prev) worst = Math.max(worst, dist(at, prev));
        prev = at;
        // Never drawn on the shaft itself, which is where a beeline from
        // the far side to the handle would take him.
        const onShaft =
          Math.abs(at.x - WELL_X) < 0.5 && Math.abs(at.y - WELL_Z) < 0.5;
        expect(onShaft).toBe(false);
        if (crank.rotation.x > 0 && !wound) {
          expect(dist(at, MARK)).toBeLessThan(1e-6);
          wound = true;
        }
      }
      if (serf.carrying === GoodId.water) carried = true;
      if (carried && serf.carrying === undefined) break; // delivered
    }
    expect(wound).toBe(true);
    expect(carried).toBe(true);
    expect(serf.carrying).toBeUndefined();
    // No frame of it covers more ground than his own stride and the
    // render's step together, the most the two can ever add up to (the
    // frame he stops on: see the first test).
    expect(worst).toBeLessThanOrEqual((SERF_SPEED + RENDER_WALK) * DT + 1e-6);
  });
});
