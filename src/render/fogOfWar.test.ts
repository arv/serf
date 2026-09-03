import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import {
  ACTION,
  SAB_BYTES,
  SabReader,
  SabWriter,
  type UnitSnapshot,
} from '../protocol/sabLayout';
import {tileIdx} from '../shared/grid';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum';
import type {PlayArea} from '../sim/map';
import {FogOfWar} from './fogOfWar';

/** Grid 8, play square [2, 6) — margin two tiles deep on every side. */
const AREA: PlayArea = {size: 8, play: 4};

/** An explored grid with just these tiles seen. */
function seeded(...tiles: [number, number][]): Uint8Array {
  const out = new Uint8Array(AREA.size * AREA.size);
  for (const [x, z] of tiles) out[tileIdx(x, z, AREA.size)] = 1;
  return out;
}

describe('fog margin', () => {
  it('leaves the scenery ring dark until the border beside it is seen', () => {
    const fog = new FogOfWar(0, AREA);
    // Nothing scouted: the ring is fogged like everything else. It used to
    // be held permanently lit, which framed an unexplored map as a dark
    // island inside bright scenery.
    expect(fog.exploredAt(0.5, 0.5)).toBe(false);
    expect(fog.exploredAt(7.5, 7.5)).toBe(false);
  });

  it('lights the ring outside a border that has been seen', () => {
    const fog = new FogOfWar(0, AREA);
    fog.seedExplored(seeded([2, 2]));
    // Both margin tiles diagonally out from the seen corner mirror it.
    expect(fog.exploredAt(0.5, 0.5)).toBe(true);
    expect(fog.exploredAt(1.5, 1.5)).toBe(true);
    // Straight out from it, too — clamping is per axis.
    expect(fog.exploredAt(0.5, 2.5)).toBe(true);
    expect(fog.exploredAt(2.5, 0.5)).toBe(true);
  });

  it('keeps the ring dark outside a border that has not been seen', () => {
    const fog = new FogOfWar(0, AREA);
    fog.seedExplored(seeded([2, 2]));
    // The far corner mirrors (5, 5), which nobody has scouted.
    expect(fog.exploredAt(7.5, 7.5)).toBe(false);
    expect(fog.exploredAt(6.5, 6.5)).toBe(false);
  });

  it('answers every query true while disabled', () => {
    const fog = new FogOfWar(0, AREA);
    fog.setEnabled(false);
    expect(fog.exploredAt(0.5, 0.5)).toBe(true);
    expect(fog.visibleAt(0.5, 0.5)).toBe(true);
    expect(fog.litAt(0.5, 0.5)).toBe(1);
  });
});

/** Big enough that two seats' sight circles (6.5 tiles, plus the rim) do
 * not reach each other — the eight-tile map above is one valley to any of
 * them. Play square [4, 28). */
const VALLEY: PlayArea = {size: 32, play: 24};

function reading(units: UnitSnapshot[]): SabReader {
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const writer = new SabWriter(sab);
  const reader = new SabReader(sab);
  writer.publish(units);
  reader.poll(0);
  return reader;
}

function man(id: number, x: number, y: number, owner: number): UnitSnapshot {
  return {
    id,
    x,
    y,
    kind: UnitTypeId.serf,
    owner,
    hpPct: 255,
    maxHp: 25,
    carrying: 0,
    action: ACTION.idle,
  };
}

/** A second past in one go: the reveal easing is time-based, so a whole
 * second is a full reveal and the mask reads as its own sight. */
function pass(fog: FogOfWar, reader: SabReader): void {
  fog.update(1, reader, [], new THREE.Scene());
}

describe('the seat the fog is drawn through', () => {
  /** Mine at one corner of the play square, his at the other. */
  const MINE: [number, number] = [6.5, 6.5];
  const HIS: [number, number] = [25.5, 25.5];
  const roster = [man(1, ...MINE, 0), man(2, ...HIS, 1)];

  it('shows the map through whichever seat it is turned to', () => {
    const fog = new FogOfWar(0, VALLEY, [0, 1]);
    const reader = reading(roster);
    pass(fog, reader);
    expect(fog.visibleAt(...MINE)).toBe(true);
    expect(fog.visibleAt(...HIS)).toBe(false);

    fog.setOwner(1);
    expect(fog.owner).toBe(1);
    pass(fog, reader);
    // His valley now, and mine is not merely unlit but unseen: his sight
    // has never been near it, and nothing of my memory carries over.
    expect(fog.visibleAt(...HIS)).toBe(true);
    expect(fog.visibleAt(...MINE)).toBe(false);
    expect(fog.exploredAt(...MINE)).toBe(false);

    // ...and back, with my own memory where it was left.
    fog.setOwner(0);
    pass(fog, reader);
    expect(fog.visibleAt(...MINE)).toBe(true);
    expect(fog.exploredAt(...HIS)).toBe(false);
  });

  it('keeps a named seat’s memory while nobody is watching it', () => {
    const fog = new FogOfWar(0, VALLEY, [0, 1]);
    pass(fog, reading(roster));
    // He walks home while the view is still mine.
    pass(fog, reading([man(1, ...MINE, 0), man(2, 12.5, 12.5, 1)]));

    fog.setOwner(1);
    pass(fog, reading([man(1, ...MINE, 0), man(2, 12.5, 12.5, 1)]));
    // Where he stood while unwatched is remembered, not relit: the corner
    // is his own scouting, kept as the live match kept it.
    expect(fog.exploredAt(...HIS)).toBe(true);
    expect(fog.visibleAt(...HIS)).toBe(false);
    expect(fog.visibleAt(12.5, 12.5)).toBe(true);
  });

  it('gives a seat nobody asked for a memory that starts now', () => {
    // A live match names no other seat — there is nothing to switch to.
    const fog = new FogOfWar(0, VALLEY);
    pass(fog, reading(roster));
    fog.setOwner(1);
    pass(fog, reading([man(1, ...MINE, 0), man(2, 12.5, 12.5, 1)]));
    expect(fog.visibleAt(12.5, 12.5)).toBe(true);
    // The corner he was standing in a moment ago was never anyone's to
    // remember: nothing was keeping his sight before the view turned.
    expect(fog.exploredAt(...HIS)).toBe(false);
  });
});
