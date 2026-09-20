import {describe, expect, it} from 'vitest';
import type {BuildingSnap} from '../protocol/messages';
import * as BuildingState from '../sim/buildingStateEnum.ts';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import {GatherAlerts} from './gatherAlerts';

/** A gatherer on the roster, as the snapshot ships one. */
function hut(over: Partial<BuildingSnap> = {}): BuildingSnap {
  return {
    id: 7,
    type: BuildingTypeId.quarry,
    owner: 0,
    x: 10,
    y: 12,
    w: 2,
    h: 2,
    hp: 100,
    maxHp: 100,
    state: BuildingState.built,
    stock: {},
    inputs: {},
    inbound: {},
    reservedOut: {},
    resourceLeft: 8,
    ...over,
  } as BuildingSnap;
}

function harness() {
  const said: {text: string; focus?: {x: number; y: number}}[] = [];
  let now = 0;
  const alerts = new GatherAlerts({
    toast: (text, focus) => said.push({text, focus}),
    now: () => now,
  });
  return {
    said,
    alerts,
    pass: (...roster: BuildingSnap[]) => alerts.update(roster, 0),
    wait: (ms: number) => {
      now += ms;
    },
  };
}

describe('gatherer notices', () => {
  it('says nothing while there is ground to work', () => {
    const h = harness();
    h.pass(hut());
    h.pass(hut({resourceLeft: 3}));
    expect(h.said).toEqual([]);
  });

  it('announces a quarry that has worked out its ground, once', () => {
    const h = harness();
    h.pass(hut());
    h.pass(hut({resourceLeft: 0}));
    expect(h.said).toHaveLength(1);
    expect(h.said[0]!.text).toContain('worked out');
    // Clickable: the notice takes the camera to the hut it is about.
    expect(h.said[0]!.focus).toEqual({x: 10, y: 12});
    // Still spent on every frame after — news once, not a drumbeat.
    h.wait(5 * 60_000);
    h.pass(hut({resourceLeft: 0}));
    h.pass(hut({resourceLeft: 0}));
    expect(h.said).toHaveLength(1);
  });

  it('tells a hut walled in from one worked out, and counts what is shut in', () => {
    const h = harness();
    h.pass(hut());
    h.pass(hut({resourceLeft: 0, resourceBlocked: 10}));
    expect(h.said).toHaveLength(1);
    expect(h.said[0]!.text).toContain('walled in');
    expect(h.said[0]!.text).toContain('10 loads');
  });

  it('says a woodcutter is finished here, not finished', () => {
    const h = harness();
    h.pass(hut({type: BuildingTypeId.woodcutter}));
    h.pass(hut({type: BuildingTypeId.woodcutter, resourceLeft: 0}));
    expect(h.said[0]!.text).toContain('felled everything in reach');
  });

  it('announces the turn from walled in to worked out: a different move', () => {
    const h = harness();
    h.pass(hut());
    h.pass(hut({resourceLeft: 0, resourceBlocked: 6}));
    h.wait(RETOAST + 1);
    h.pass(hut({resourceLeft: 0}));
    expect(h.said.map(s => s.text.includes('walled in'))).toEqual([
      true,
      false,
    ]);
  });

  it('holds its tongue when a hut flaps across the line', () => {
    const h = harness();
    h.pass(hut({type: BuildingTypeId.woodcutter}));
    h.pass(hut({type: BuildingTypeId.woodcutter, resourceLeft: 0}));
    // A stump grows back into reach and is felled again inside the cooldown.
    h.wait(1000);
    h.pass(hut({type: BuildingTypeId.woodcutter, resourceLeft: 1}));
    h.pass(hut({type: BuildingTypeId.woodcutter, resourceLeft: 0}));
    expect(h.said).toHaveLength(1);
    // Past the cooldown it is worth saying again.
    h.wait(RETOAST);
    h.pass(hut({type: BuildingTypeId.woodcutter, resourceLeft: 1}));
    h.pass(hut({type: BuildingTypeId.woodcutter, resourceLeft: 0}));
    expect(h.said).toHaveLength(2);
  });

  it('is silent about a hut first seen already spent', () => {
    // A loaded save, a replay joined in the middle, the frame a match
    // opens on: history, not news.
    const h = harness();
    h.pass(hut({resourceLeft: 0}));
    h.pass(hut({resourceLeft: 0}));
    expect(h.said).toEqual([]);
  });

  it('leaves a halted hut alone, and reads its ground fresh when it runs again', () => {
    const h = harness();
    h.pass(hut());
    h.pass(hut({resourceLeft: 0, paused: true}));
    expect(h.said).toEqual([]);
    h.pass(hut({resourceLeft: 0}));
    expect(h.said).toHaveLength(1);
  });

  it('ignores another seat, and sites that are still going up', () => {
    const h = harness();
    h.pass(hut({owner: 1}), hut({id: 8, state: BuildingState.site}));
    h.pass(
      hut({owner: 1, resourceLeft: 0}),
      hut({id: 8, state: BuildingState.site, resourceLeft: 0}),
    );
    expect(h.said).toEqual([]);
  });

  it('forgets a hut that is gone, so the next one on that ground is read fresh', () => {
    const h = harness();
    h.pass(hut());
    h.pass(); // razed or sold
    h.pass(hut({resourceLeft: 0})); // a new hut, first sight
    expect(h.said).toEqual([]);
  });

  it('starts over when the HUD turns to another seat', () => {
    const said: {text: string}[] = [];
    const alerts = new GatherAlerts({toast: text => said.push({text})});
    alerts.update([hut()], 0);
    // The turn drops seat 0's history, so seat 1's spent quarry is first
    // sight — history for this seat too, and not announced.
    alerts.update([hut({id: 9, owner: 1, resourceLeft: 0})], 1);
    alerts.update([hut({id: 9, owner: 1, resourceLeft: 0})], 1);
    expect(said).toEqual([]);
  });
});

/** Mirrors the module's own cooldown; imported by value would export an
 * implementation detail for one assertion. */
const RETOAST = 60_000;
