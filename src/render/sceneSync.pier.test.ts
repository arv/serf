import * as THREE from 'three';
import {describe, expect, it, vi} from 'vitest';
import {
  ACTION,
  SAB_BYTES,
  SabReader,
  SabWriter,
  WORK,
  type UnitSnapshot,
} from '../protocol/sabLayout';
import {unitSnapshots} from '../protocol/snapshot.ts';
import {tileIdx} from '../shared/grid.ts';
import {BUILDING_DEFS} from '../sim/defs/buildings.ts';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import * as RecipeKind from '../sim/defs/recipeKindEnum.ts';
import * as Terrain from '../sim/terrainEnum.ts';
import {bareWorld, staffBuilding} from '../sim/testUtils.ts';
import {tickWorld} from '../sim/tick.ts';
import {placeBuiltBuilding} from '../sim/world.ts';
import type {PierInfo} from './buildingSync';
import type {HeightField} from './heightField';

/**
 * The fisherman's trip along his deck. It is render-side — the sim parks
 * him on one adjacent tile for the whole twenty-second catch — so the
 * whole behaviour lives in update(), which normally needs the loaded GLB
 * wardrobe. Only the body is stubbed here: an empty clip library, which
 * every character call in the loop already tolerates (playAnimation and
 * setGaitSpeed no-op on a missing action, setWorkTool on a missing tool
 * anchor). The walk itself is pure arithmetic on the pier line and runs
 * exactly as it does in a match.
 *
 * Positions come back through positionOfInto — the channel picking reads —
 * so what is asserted is where the player's mouse would find him.
 */
vi.mock('./characters', async importOriginal => {
  const real = await importOriginal<typeof import('./characters')>();
  return {
    ...real,
    makeCharacter: () => {
      const group = new THREE.Group();
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

/** A deck running due east out of the hut door at (30, 30), 1.6 long. */
const PIER: PierInfo = {
  bx: 30,
  bz: 30,
  baseX: 30,
  baseZ: 30,
  spotX: 31.6,
  spotZ: 30,
  yaw: Math.PI / 2, // +x
  deckY: 0.4,
};

function fisherman(action: number = ACTION.work): UnitSnapshot {
  return {
    id: 1,
    // Parked a tile back from the door, on the ground the path found —
    // never on the planks, which is the whole reason the render walks him.
    x: 29,
    y: 30.5,
    kind: 5,
    owner: 0,
    hpPct: 255,
    maxHp: 80,
    carrying: 0,
    action,
    workKind: WORK.fish,
  };
}

/** One parked fisherman, one pier, and a clock that advances in frames. */
function rig(): {
  step: (frames: number, action?: number, at?: {x: number; y: number}) => void;
  where: () => {x: number; y: number};
} {
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const writer = new SabWriter(sab);
  const reader = new SabReader(sab);
  const sync = new SceneSync(new THREE.Scene(), reader, flat);
  sync.setPiers([PIER]);
  let now = 0;
  // Twice, so the second publish has a predecessor to read "standing
  // still" from.
  writer.publish([fisherman()]);
  reader.poll(now);
  writer.publish([fisherman()]);
  reader.poll(now);
  const out = {x: 0, y: 0};
  return {
    step(frames, action = ACTION.work, at) {
      for (let f = 0; f < frames; f++) {
        now += 1000 / 60;
        const u = fisherman(action);
        if (at) {
          u.x = at.x;
          u.y = at.y;
        }
        writer.publish([u]);
        reader.poll(now);
        sync.update(now);
      }
    },
    where() {
      sync.positionOfInto(1, now, out);
      return {x: out.x, y: out.y};
    },
  };
}

/** How far off the deck's centre line he is drawn — off the planks. */
const drift = (p: {x: number; y: number}): number => Math.abs(p.y - PIER.baseZ);
/** How far along the deck from the door, negative while still ashore. */
const along = (p: {x: number; y: number}): number => p.x - PIER.baseX;

describe('the fisherman on his deck', () => {
  it('walks out along the planks instead of appearing at the tip', () => {
    const r = rig();
    r.step(1);
    expect(along(r.where())).toBeLessThan(0.2); // not teleported to the spot
    // He goes by way of the door: while he is off the deck the walk aims at
    // the landward end, so he never cuts the corner over open water.
    let worst = 0;
    for (let f = 0; f < 240; f++) {
      r.step(1);
      if (along(r.where()) > 0.05) worst = Math.max(worst, drift(r.where()));
    }
    expect(worst).toBeLessThan(0.05);
    expect(along(r.where())).toBeGreaterThan(1.4);
    expect(drift(r.where())).toBeLessThan(0.02);
  });

  it('shifts stand down the planks between casts', () => {
    const r = rig();
    r.step(240); // out to the tip, settled and fishing
    const first = along(r.where());
    expect(first).toBeGreaterThan(1.4);
    // PIER_PACE_HOLD is 6s, and the shift is a walk down the deck.
    r.step(60 * 8);
    const second = along(r.where());
    expect(second).toBeLessThan(first - 0.3);
    expect(drift(r.where())).toBeLessThan(0.02);
    // ...and back to the tip on the next hold.
    r.step(60 * 8);
    expect(along(r.where())).toBeGreaterThan(second + 0.3);
  });

  it('walks the catch back to the hut door and goes out again', () => {
    const r = rig();
    r.step(240);
    expect(along(r.where())).toBeGreaterThan(1.4);
    // The batch edge — one idle publish between two convert batches — is
    // the fish landed, and it turns him round.
    r.step(1, ACTION.idle);
    r.step(59);
    const back = r.where();
    expect(along(back)).toBeLessThan(1.2);
    expect(drift(back)).toBeLessThan(0.02); // in along the planks
    r.step(90);
    expect(along(r.where())).toBeLessThan(0.1); // at the door
    // The beat at the door, then back out.
    r.step(60 * 3);
    expect(along(r.where())).toBeGreaterThan(0.5);
  });

  it('holds the door for as long as the work flag stays down', () => {
    const r = rig();
    r.step(240);
    // The trip in is started by work going away and finished by it coming
    // back — not by the clock. Today's sim always has it back long before
    // he reaches the door (the catch is one tick in four hundred, pinned
    // below), so this is the rule rather than a scene from a match: a work
    // flag that DID stay down leaves him at his door instead of pacing out
    // to cast for nothing.
    r.step(300, ACTION.idle);
    expect(along(r.where())).toBeLessThan(0.1);
    r.step(300, ACTION.idle); // well past PIER_DROP_HOLD, still there
    expect(along(r.where())).toBeLessThan(0.1);
    r.step(180); // working again: the beat expires and he goes back out
    expect(along(r.where())).toBeGreaterThan(1.0);
  });

  it('retraces the deck when the sim takes him off post', () => {
    const r = rig();
    r.step(240);
    expect(along(r.where())).toBeGreaterThan(1.4);
    // The sim walks him inland — a new position every publish, so he reads
    // as moving and the post is gone. He has to come off along the deck
    // line, not slide sideways off it across open water.
    let worst = 0;
    for (let f = 1; f <= 40; f++) {
      r.step(1, ACTION.idle, {x: 29 - f * 0.03, y: 30.5 + f * 0.03});
      if (along(r.where()) > 0.2) worst = Math.max(worst, drift(r.where()));
    }
    // Dead on the line: the retrace is driven along the deck itself, so the
    // sim's own inland walk cannot drag him off the side of it.
    expect(worst).toBeLessThan(0.01);
    expect(along(r.where())).toBeLessThan(1.3); // and he did walk in
  });
});

/**
 * The catch is read off the sim's own publish, so what that publish looks
 * like is load-bearing for everything above: no batch edge, no trip to the
 * door. Nothing else pins it, and it is the kind of shape a change to
 * production.ts could round off without anyone noticing the fisherman had
 * quietly stopped walking his fish in.
 */
describe('the tick the catch is read from', () => {
  it('is one non-work tick between two convert batches, and only that', () => {
    const world = bareWorld();
    // A shore along the footprint's north edge, which is what a fishery
    // needs to stand at all (chains.test.ts covers the placement rule).
    for (let tx = 25; tx < 40; tx++) {
      const i = tileIdx(tx, 29, world.map.size);
      world.map.terrain[i] = Terrain.Water;
      world.map.blocked[i] = 1;
    }
    const fishery = placeBuiltBuilding(
      world,
      BuildingTypeId.fishery,
      0,
      30,
      30,
    );
    const worker = staffBuilding(world, fishery);
    // Both the run length and what is asserted about it come off the def, so
    // a rebalance carries the test with it and only a change in SHAPE fails.
    // Three batches and change, however long a batch is.
    const recipe = BUILDING_DEFS[BuildingTypeId.fishery].recipe;
    expect(recipe?.kind).toBe(RecipeKind.convert); // ...a batch, not a gather
    const batch =
      recipe?.kind === RecipeKind.convert ? recipe.durationTicks : 0;
    expect(batch).toBeGreaterThan(0);
    const runs: {work: boolean; ticks: number}[] = [];
    for (let t = 0; t < batch * 3 + batch / 2; t++) {
      tickWorld(world, []);
      for (const s of unitSnapshots(world)) {
        if (s.id !== worker.id) continue;
        expect(s.workKind).toBe(WORK.fish); // ...and he never stops being a fisherman
        const work = s.action === ACTION.work;
        const last = runs.at(-1);
        if (last && last.work === work) last.ticks++;
        else runs.push({work, ticks: 1});
      }
    }
    // Work for the recipe's whole duration, one tick off, work again — so
    // three batches is work/idle/work/idle/work and a tail.
    expect(runs.length).toBeGreaterThan(4);
    for (const [i, run] of runs.entries()) {
      if (!run.work) expect(run.ticks).toBe(1);
      // The last run is cut off by the end of the loop, not by a batch.
      else if (i < runs.length - 1) expect(run.ticks).toBe(batch);
    }
  });
});
