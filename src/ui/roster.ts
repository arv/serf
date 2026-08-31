import type {Enum} from '../shared/enum.ts';
import {UNIT_DEFS} from '../sim/defs/units';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum.ts';

type UnitTypeId = Enum<typeof UnitTypeId>;

/**
 * The selection, as the card draws it: who is in hand, what each of them
 * is, and how beaten up.
 *
 * The selection signal itself is a bag of ids — enough to send an order to,
 * and nothing at all to look at. "3 units selected" is the same sentence
 * for three serfs about to be caught in a raid and for three knights who
 * can answer it, and the difference is the whole decision the player is
 * making. So the ids are turned back into people here — once for each
 * publish of the unit buffer, which is what Controls calls this on — and
 * the card gets names, kinds and hitpoints to show.
 *
 * Everything in this file is arithmetic over plain data on purpose: the
 * reads come from the render layer's shared buffer (the only place a live
 * unit's health exists on this thread), and threading them through a
 * one-method interface keeps the ordering and the diff testable without a
 * scene, a canvas or a worker.
 */

/** One selected person. `hp`/`maxHp` are hitpoints, already whole. */
export interface SelectedUnit {
  id: number;
  kind: UnitTypeId;
  hp: number;
  maxHp: number;
}

/** One kind, and how many of it are in hand — the composition line. */
export interface RosterGroup {
  kind: UnitTypeId;
  count: number;
}

/** What the roster needs of the live unit buffer, and no more. */
export interface UnitSource {
  /** UnitTypeId, or null for an id no longer in the latest publish. */
  kindOf(id: number): number | null;
  /** 0..255 of the kind's full health, or null for an id that has gone. */
  hpPctOf(id: number): number | null;
}

/**
 * How many people the card has tiles for. Lives here rather than with the
 * markup because the ordering below has to know when the roster is being
 * cut — who is drawn is decided by who fits.
 */
export const ROSTER_TILES = 24;

/**
 * Display order. Fighters first, and civilians last, because a mixed
 * selection is almost always an army with a serf or two swept up in the
 * band — and the army is what the orders on the card are for. Within a
 * kind the tie is broken by id, which never changes, so a tile cannot
 * swap places with its neighbour just because someone took an arrow.
 */
const RANK: Record<UnitTypeId, number> = {
  [UnitTypeId.knight]: 0,
  [UnitTypeId.marauder]: 1,
  [UnitTypeId.spearman]: 2,
  [UnitTypeId.bandit]: 3,
  [UnitTypeId.archer]: 4,
  [UnitTypeId.banditArcher]: 5,
  [UnitTypeId.worker]: 6,
  [UnitTypeId.serf]: 7,
};

function isUnitTypeId(kind: number): kind is UnitTypeId {
  return kind in RANK;
}

/**
 * Whole men last, once the card has to choose who to draw.
 *
 * This is a legal sort key only because it can never go back: nothing in
 * the sim gives a person hitpoints back once he has lost them — buildings
 * mend, people do not (see the tower that "is not a hospital" in
 * combat.test.ts). Research does raise what a soldier is *trained* at
 * (ModifierKey.militaryHp — Mail Armor, Gilded Arms), but that is the
 * number he walks out of the barracks with, not a gain he makes later. So
 * a man crosses from whole to hurt once in his life, moves up the card
 * once, and stays put. Sorting on how hurt he is would not have that
 * property: the tiles would re-order on every arrow, which is exactly when
 * the player is trying to read them.
 */
function woundRank(u: SelectedUnit): number {
  return u.hp < u.maxHp ? 0 : 1;
}

/**
 * Read the selected ids out of the live buffer, in display order.
 *
 * Ids the buffer no longer knows are dropped rather than drawn as a blank:
 * the selection is pruned against that same publish every frame, so a
 * missing id here is a person who died between the two reads, and half a
 * frame of a ghost tile is worse than none.
 *
 * The wounded are pulled to the front only when there are more people than
 * tiles, and for that reason alone: past the cap the card is choosing who
 * the player sees, and the four men bleeding out of a band of forty are
 * the whole reason to look. Inside the cap everyone is on screen already,
 * so the sort would buy nothing and cost the one thing worth having — a
 * squad of six under fire whose tiles never move.
 * The regime changes as a selection crosses the cap, which only happens on
 * a death, and a death re-shuffles the tiles after it whatever we do.
 */
export function rosterOf(
  ids: Iterable<number>,
  src: UnitSource,
): SelectedUnit[] {
  const out: SelectedUnit[] = [];
  for (const id of ids) {
    const kind = src.kindOf(id);
    if (kind === null || !isUnitTypeId(kind)) continue;
    const pct = src.hpPctOf(id);
    if (pct === null) continue;
    out.push({id, kind, hp: hpFromPct(pct, kind), maxHp: UNIT_DEFS[kind].hp});
  }
  const crowded = out.length > ROSTER_TILES;
  out.sort(
    (a, b) =>
      (crowded ? woundRank(a) - woundRank(b) : 0) ||
      RANK[a.kind] - RANK[b.kind] ||
      a.id - b.id,
  );
  return out;
}

/**
 * The byte back into hitpoints. It was written as a rounded fraction of the
 * kind's maximum, so this cannot be exact — it is out by at most half a
 * point on the biggest unit in the game, which is under what the card
 * prints anyway.
 *
 * The kind's maximum, note, and not this man's: the publisher divides by
 * the same UNIT_DEFS number (protocol/snapshot.ts) and clamps at full, so a
 * soldier trained under armor research — who walks out with half again the
 * hitpoints of his kind — reads as whole until he is down to what an
 * unarmored one starts with. The card is optimistic about him rather than
 * wrong about anyone else, and it is the same byte the bar over his head
 * has always drawn. Telling his true maximum apart from his kind's would
 * take a wider publish than this card is worth.
 *
 * The floor at 1 is the one place that matters: a knight on his last point
 * of 80 rounds to zero, and a card reading "0/80" over someone still
 * swinging is a lie in the direction that gets him abandoned. Only a real
 * zero — the byte a corpse is published with — prints as none left.
 */
function hpFromPct(pct: number, kind: UnitTypeId): number {
  const max = UNIT_DEFS[kind].hp;
  if (pct <= 0) return 0;
  return Math.min(max, Math.max(1, Math.round((pct / 255) * max)));
}

/**
 * Has anything the card draws changed? The roster is rebuilt every frame
 * from a buffer that is rewritten twenty times a second, and handing Solid
 * a fresh array each time would re-render the tiles at frame rate for a
 * selection standing still in the sun. Compared on the printed values, so
 * a wound too small to change the number is not news either.
 */
export function sameRoster(
  a: readonly SelectedUnit[],
  b: readonly SelectedUnit[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.kind !== y.kind || x.hp !== y.hp) return false;
  }
  return true;
}

/** Kinds and counts, in the same display order the roster is already in. */
export function rosterGroups(units: readonly SelectedUnit[]): RosterGroup[] {
  const out: RosterGroup[] = [];
  for (const u of units) {
    const last = out[out.length - 1];
    if (last?.kind === u.kind) last.count++;
    else out.push({kind: u.kind, count: 1});
  }
  return out;
}

/**
 * Health as a fraction, for the bars. Guarded against a zero maximum that
 * cannot happen today but would divide by it if a unit def ever lost its
 * hitpoints.
 */
export function hpFraction(u: SelectedUnit): number {
  return u.hp / Math.max(u.maxHp, 1);
}

/**
 * Three bands rather than a gradient: full-ish, hurt, and about to die.
 * A bar that slides through every shade between green and red says
 * "something is happening"; three steps say which of the three things the
 * player has to decide about — leave him, pull him out, or write him off.
 */
export function hpTone(fraction: number): 'ok' | 'hurt' | 'dire' {
  if (fraction <= 0.25) return 'dire';
  if (fraction <= 0.6) return 'hurt';
  return 'ok';
}
