import {describe, expect, it} from 'vitest';
import type {Enum} from '../shared/enum.ts';
import {UNIT_DEFS} from '../sim/defs/units.ts';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum.ts';
import {
  ROSTER_TILES,
  hpFraction,
  hpTone,
  rosterGroups,
  rosterOf,
  sameRoster,
  type SelectedUnit,
  type UnitSource,
} from './roster';

type UnitTypeId = Enum<typeof UnitTypeId>;

/**
 * The card's reading of the selection. The live buffer these numbers come
 * from belongs to the renderer and cannot be stood up in a headless test,
 * so the two reads it offers are the seam: a fake source hands over kinds
 * and health bytes, and everything the card prints is decided here.
 */

interface Row {
  id: number;
  kind: number;
  pct: number;
  /** His own full health. Defaults to his kind's, which is everyone the
   * barracks has not re-armoured. */
  maxHp?: number;
}

/** A stand-in for the unit publish: whatever rows it is given, and no more. */
function source(rows: readonly Row[]): UnitSource {
  const by = new Map(rows.map(r => [r.id, r]));
  const maxOf = (r: Row): number =>
    r.maxHp ?? UNIT_DEFS[r.kind as UnitTypeId].hp;
  return {
    kindOf: id => by.get(id)?.kind ?? null,
    hpPctOf: id => by.get(id)?.pct ?? null,
    maxHpOf: id => {
      const r = by.get(id);
      return r ? maxOf(r) : null;
    },
    isHolding: () => false,
  };
}

/** The byte a unit at full health is published with. */
const FULL = 255;

describe('the selection roster', () => {
  it('names every kind and puts hitpoints back on the byte', () => {
    const knightMax = UNIT_DEFS[UnitTypeId.knight].hp;
    const roster = rosterOf(
      [7, 9],
      source([
        {id: 7, kind: UnitTypeId.knight, pct: Math.round(0.5 * FULL)},
        {id: 9, kind: UnitTypeId.serf, pct: FULL},
      ]),
    );
    expect(roster).toEqual([
      {
        id: 7,
        kind: UnitTypeId.knight,
        hp: Math.round(knightMax / 2),
        maxHp: knightMax,
        holding: false,
      },
      {
        id: 9,
        kind: UnitTypeId.serf,
        hp: UNIT_DEFS[UnitTypeId.serf].hp,
        maxHp: UNIT_DEFS[UnitTypeId.serf].hp,
        holding: false,
      },
    ]);
  });

  it('reads the hold stance off the publish, and counts a change of it as news', () => {
    // The card's Hold button lights off this flag, and the roster is
    // rebuilt every frame: a man told to hold has to reach the card on
    // the next publish, not on his next wound.
    const rows: Row[] = [{id: 7, kind: UnitTypeId.knight, pct: FULL}];
    const holding = new Set<number>();
    const src = {...source(rows), isHolding: (id: number) => holding.has(id)};
    const before = rosterOf([7], src);
    expect(before[0]!.holding).toBe(false);
    holding.add(7);
    const after = rosterOf([7], src);
    expect(after[0]!.holding).toBe(true);
    expect(sameRoster(before, after)).toBe(false);
  });

  it('names an armoured soldier’s own maximum, not his kind’s', () => {
    // Mail Armor and Gilded Arms muster a knight at 120 against a base of
    // 80. The publish divides by his own number, so a whole man is a full
    // byte either way — what the card must not do is print 80/80 over
    // someone carrying 120, or call him whole after his first wound.
    const kindMax = UNIT_DEFS[UnitTypeId.knight].hp;
    const [whole] = rosterOf(
      [1],
      source([{id: 1, kind: UnitTypeId.knight, pct: FULL, maxHp: 120}]),
    );
    expect(whole).toEqual({
      id: 1,
      kind: UnitTypeId.knight,
      hp: 120,
      maxHp: 120,
      holding: false,
    });
    expect(whole!.maxHp).toBeGreaterThan(kindMax);

    // Ten off: the byte drops, and both printed numbers are his.
    const [hurt] = rosterOf(
      [1],
      source([
        {
          id: 1,
          kind: UnitTypeId.knight,
          pct: Math.round((110 / 120) * FULL),
          maxHp: 120,
        },
      ]),
    );
    expect(hurt!.hp).toBe(110);
    expect(hurt!.maxHp).toBe(120);
    // ...and he sorts as the wounded man he is, ahead of the whole.
    expect(hurt!.hp).toBeLessThan(hurt!.maxHp);
  });

  it('never prints a living unit as having nothing left', () => {
    // A knight on his last point of 80 is a byte of 3 — which rounds to
    // one hitpoint, not to none. Reading "0/80" over a man still swinging
    // is the lie that gets him abandoned.
    const [hurt] = rosterOf(
      [1],
      source([{id: 1, kind: UnitTypeId.knight, pct: 3}]),
    );
    expect(hurt!.hp).toBe(1);
    // A real zero is the byte a corpse carries, and says so.
    const [gone] = rosterOf(
      [1],
      source([{id: 1, kind: UnitTypeId.knight, pct: 0}]),
    );
    expect(gone!.hp).toBe(0);
  });

  it('drops ids the publish no longer carries rather than drawing a blank', () => {
    const roster = rosterOf(
      [1, 2],
      source([{id: 1, kind: UnitTypeId.archer, pct: FULL}]),
    );
    expect(roster.map(u => u.id)).toEqual([1]);
  });

  it('puts fighters first and breaks the tie by id, so tiles hold still', () => {
    const rows: Row[] = [
      {id: 4, kind: UnitTypeId.serf, pct: FULL},
      {id: 3, kind: UnitTypeId.archer, pct: FULL},
      {id: 2, kind: UnitTypeId.knight, pct: FULL},
      {id: 1, kind: UnitTypeId.knight, pct: FULL},
      {id: 5, kind: UnitTypeId.worker, pct: FULL},
    ];
    const ids = rosterOf(
      rows.map(r => r.id),
      source(rows),
    ).map(u => u.id);
    expect(ids).toEqual([1, 2, 3, 5, 4]);
    // Same people, handed over in another order: the card draws the same
    // row of tiles either way.
    const shuffled = rosterOf([5, 1, 4, 2, 3], source(rows)).map(u => u.id);
    expect(shuffled).toEqual(ids);
  });

  it('leaves a squad that fits alone, however shot up it is', () => {
    // Everyone is on screen already, so pulling the wounded forward buys
    // nothing — and costs the one thing worth having: tiles that do not
    // move while the player is reading them.
    const rows: Row[] = [
      {id: 1, kind: UnitTypeId.knight, pct: FULL},
      {id: 2, kind: UnitTypeId.knight, pct: 20},
      {id: 3, kind: UnitTypeId.knight, pct: FULL},
    ];
    expect(rosterOf([1, 2, 3], source(rows)).map(u => u.id)).toEqual([1, 2, 3]);
  });

  it('draws the wounded first once there are more men than tiles', () => {
    // Past the cap the card is choosing who the player sees, and the few
    // bleeding out of a big band are the whole reason to look.
    const rows: Row[] = [];
    for (let id = 1; id <= ROSTER_TILES + 6; id++) {
      rows.push({id, kind: UnitTypeId.knight, pct: FULL});
    }
    rows[rows.length - 1]!.pct = 40;
    rows[rows.length - 3]!.pct = 90;
    const ids = rosterOf(
      rows.map(r => r.id),
      source(rows),
    ).map(u => u.id);
    // The two hurt men lead, in the same fighters-then-id order as ever;
    // everyone whole keeps their old place behind them.
    expect(ids.slice(0, 2)).toEqual([rows.length - 2, rows.length]);
    expect(ids.slice(2)).toEqual(
      rows
        .map(r => r.id)
        .filter(id => id !== rows.length && id !== rows.length - 2),
    );
  });

  it('does not move a man again for a second wound', () => {
    // The key is "hurt at all", not "how hurt" — a unit crosses it once
    // (nothing in the sim heals a person) and then holds its place while
    // the arrows keep landing.
    const rows: Row[] = [];
    for (let id = 1; id <= ROSTER_TILES + 2; id++) {
      rows.push({id, kind: UnitTypeId.archer, pct: FULL});
    }
    rows[10]!.pct = 200;
    rows[20]!.pct = 100;
    const before = rosterOf(
      rows.map(r => r.id),
      source(rows),
    ).map(u => u.id);
    rows[10]!.pct = 30;
    rows[20]!.pct = 12;
    const after = rosterOf(
      rows.map(r => r.id),
      source(rows),
    ).map(u => u.id);
    expect(after).toEqual(before);
  });

  it('counts the kinds in the order the tiles are already in', () => {
    const rows: Row[] = [
      {id: 1, kind: UnitTypeId.knight, pct: FULL},
      {id: 2, kind: UnitTypeId.serf, pct: FULL},
      {id: 3, kind: UnitTypeId.knight, pct: FULL},
      {id: 4, kind: UnitTypeId.archer, pct: FULL},
    ];
    expect(rosterGroups(rosterOf([1, 2, 3, 4], source(rows)))).toEqual([
      {kind: UnitTypeId.knight, count: 2},
      {kind: UnitTypeId.archer, count: 1},
      {kind: UnitTypeId.serf, count: 1},
    ]);
    expect(rosterGroups([])).toEqual([]);
  });

  it('is unchanged by a wound too small to print, and changed by one that is', () => {
    // The roster is rebuilt every frame from a buffer rewritten twenty
    // times a second. Handing the card a fresh array each time would
    // re-render the tiles at frame rate for a squad standing in the sun.
    const before = rosterOf(
      [1],
      source([{id: 1, kind: UnitTypeId.knight, pct: FULL}]),
    );
    const graze = rosterOf(
      [1],
      source([{id: 1, kind: UnitTypeId.knight, pct: FULL - 1}]),
    );
    expect(graze[0]!.hp).toBe(before[0]!.hp);
    expect(sameRoster(before, graze)).toBe(true);

    const hit = rosterOf(
      [1],
      source([{id: 1, kind: UnitTypeId.knight, pct: 200}]),
    );
    expect(sameRoster(before, hit)).toBe(false);
  });

  it('tells a squad that changed size or membership from one that did not', () => {
    const rows: Row[] = [
      {id: 1, kind: UnitTypeId.serf, pct: FULL},
      {id: 2, kind: UnitTypeId.serf, pct: FULL},
    ];
    const both = rosterOf([1, 2], source(rows));
    expect(sameRoster(both, rosterOf([1, 2], source(rows)))).toBe(true);
    expect(sameRoster(both, rosterOf([1], source(rows)))).toBe(false);
    // A serf who became a worker in place keeps his id — the population
    // economy does exactly this — and the tile has to change with him,
    // which a comparison on ids alone would miss.
    const promoted = rosterOf(
      [1, 2],
      source([rows[0]!, {id: 2, kind: UnitTypeId.worker, pct: FULL}]),
    );
    expect(sameRoster(both, promoted)).toBe(false);
  });
});

describe('the health bars', () => {
  const unit = (hp: number): SelectedUnit => ({
    id: 1,
    kind: UnitTypeId.knight,
    hp,
    maxHp: 80,
    holding: false,
  });

  it('reads health as a fraction of the kind, and survives a zero maximum', () => {
    expect(hpFraction(unit(20))).toBeCloseTo(0.25);
    expect(
      hpFraction({
        id: 1,
        kind: UnitTypeId.serf,
        hp: 0,
        maxHp: 0,
        holding: false,
      }),
    ).toBe(0);
  });

  it('bands health into the three decisions rather than a gradient', () => {
    expect(hpTone(1)).toBe('ok');
    expect(hpTone(0.61)).toBe('ok');
    expect(hpTone(0.6)).toBe('hurt');
    expect(hpTone(0.26)).toBe('hurt');
    expect(hpTone(0.25)).toBe('dire');
    expect(hpTone(0)).toBe('dire');
  });
});
