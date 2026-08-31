/**
 * SharedArrayBuffer layout for the hot worker->main path: per-publish unit
 * render state in 4 rotating slots, each guarded by a seqlock.
 *
 * The worker publishes once per 50 ms interval (after running 0..N sim ticks
 * depending on game speed). The renderer interpolates between the two most
 * recent publishes on its own rAF clock. Readers copy a slot and then verify
 * its sequence number was stable across the copy; with 4 slots at 20 Hz a
 * slot is only rewritten 200 ms later, so retries are practically never.
 */

export const MAX_UNITS = 1024;
export const SLOT_COUNT = 4;
export const PUBLISH_INTERVAL_MS = 50;

// Header (Int32 indices)
const H_PUBLISH_SEQ = 0; // total publishes so far; slot = seq % SLOT_COUNT
const H_SLOT_SEQ0 = 1; // per-slot seqlock words [1..4]
const HEADER_INTS = 8;

// Per-slot layout, in bytes, after the header.
const COUNT_BYTES = 4;
const IDS_BYTES = 4 * MAX_UNITS;
const XS_BYTES = 4 * MAX_UNITS;
const YS_BYTES = 4 * MAX_UNITS;
/** Bytes of per-unit auxiliary state: kind, owner, hpPct, carrying, action, workKind, profession, facing, targetDist, maxHp. */
export const AUX_STRIDE = 10;
const AUX_BYTES = AUX_STRIDE * MAX_UNITS;

/** What a unit is visibly doing — drives limb animation in the renderer. */
export const ACTION = {idle: 0, work: 1, fight: 2, dead: 3} as const;

/** Which kind of work — picks the tool animation (chop vs pickaxe vs...). */
export const WORK = {
  none: 0,
  chop: 1,
  pickaxe: 2,
  hammer: 3,
  dig: 4,
  tend: 5,
  draw: 6,
  fish: 7,
  mow: 8,
} as const;

/** A worker's workplace flavor — picks a profession body (farmer's straw hat...). */
export const PROFESSION = {none: 0, farmer: 1, miner: 2} as const;
export const SLOT_BYTES =
  COUNT_BYTES + IDS_BYTES + XS_BYTES + YS_BYTES + AUX_BYTES;
export const SAB_BYTES = HEADER_INTS * 4 + SLOT_COUNT * SLOT_BYTES;

interface SlotViews {
  count: Int32Array;
  ids: Int32Array;
  xs: Float32Array;
  ys: Float32Array;
  aux: Uint8Array;
}

function slotViews(
  buffer: SharedArrayBuffer | ArrayBuffer,
  slot: number,
): SlotViews {
  let off = HEADER_INTS * 4 + slot * SLOT_BYTES;
  const count = new Int32Array(buffer, off, 1);
  off += COUNT_BYTES;
  const ids = new Int32Array(buffer, off, MAX_UNITS);
  off += IDS_BYTES;
  const xs = new Float32Array(buffer, off, MAX_UNITS);
  off += XS_BYTES;
  const ys = new Float32Array(buffer, off, MAX_UNITS);
  off += YS_BYTES;
  const aux = new Uint8Array(buffer, off, AUX_BYTES);
  return {count, ids, xs, ys, aux};
}

/**
 * What the writer needs per unit.
 *
 * Every field but the position pair is one byte on the wire, and both
 * writers below store what they are handed as a plain typed-array store —
 * which truncates and wraps rather than saturating. Holding the range is
 * therefore the producer's job, not theirs: snapshot.ts rounds, clamps and
 * masks each of these on the way out (hpPct and maxHp saturate, facing
 * wraps a full turn on purpose, targetDist is held off zero), and
 * decodeHot's rows come back out of bytes already. A row from anywhere
 * else owes the same.
 */
export interface UnitSnapshot {
  id: number;
  x: number;
  y: number;
  kind: number;
  owner: number;
  /**
   * Health as 0..255 of the unit's OWN maximum (`maxHp` below), not of its
   * kind's — armour research makes those different numbers, and against the
   * kind an armoured soldier saturates at full until a third of him is gone.
   */
  hpPct: number;
  /**
   * The unit's own full health in hitpoints, so a reader can turn `hpPct`
   * back into the absolute pair a card prints ("104/120"). Saturated at 255
   * by the producer (see above), which is well clear of the 120 a soldier
   * musters at today — a modifier that ever carried a man past a byte would
   * read as capped there, never as wrapped.
   */
  maxHp: number;
  carrying: number;
  /** ACTION.idle / work / fight / dead — animation intent. */
  action: number;
  /** WORK.* refinement when action is work (defaults to none). */
  workKind?: number;
  /** PROFESSION.* workplace flavor (defaults to none). */
  profession?: number;
  /**
   * Yaw toward the unit's target over a full turn (0..255 = 0..2π), for the
   * frames where the sim knows which way a unit should look and the renderer
   * cannot tell: a fighter standing still has no movement delta to face by.
   * Only meaningful while action is fight.
   */
  facing?: number;
  /**
   * Distance to the engaged target in eighth-tiles (0..255 = 0..31.875),
   * held off zero while engaged so 0 always reads as "no target". With
   * `facing` this reconstructs the target *point*, which is what lets the
   * renderer fly an archer's arrow at the enemy the sim actually shot —
   * the bearing alone says which way, never how far. Only meaningful
   * while action is fight.
   */
  targetDist?: number;
}

export class SabWriter {
  #header: Int32Array;
  #slots: SlotViews[];

  constructor(buffer: SharedArrayBuffer | ArrayBuffer) {
    this.#header = new Int32Array(buffer, 0, HEADER_INTS);
    this.#slots = [];
    for (let s = 0; s < SLOT_COUNT; s++) this.#slots.push(slotViews(buffer, s));
  }

  /** Publish the current unit state as the next slot. */
  publish(units: Iterable<UnitSnapshot>): void {
    const seq = Atomics.load(this.#header, H_PUBLISH_SEQ) + 1;
    const slotIdx = seq % SLOT_COUNT;
    const slot = this.#slots[slotIdx]!;
    const lock = H_SLOT_SEQ0 + slotIdx;

    Atomics.add(this.#header, lock, 1); // odd: write in progress
    let n = 0;
    for (const u of units) {
      if (n >= MAX_UNITS) break;
      slot.ids[n] = u.id;
      slot.xs[n] = u.x;
      slot.ys[n] = u.y;
      const a = n * AUX_STRIDE;
      slot.aux[a] = u.kind;
      slot.aux[a + 1] = u.owner;
      slot.aux[a + 2] = u.hpPct;
      slot.aux[a + 3] = u.carrying;
      slot.aux[a + 4] = u.action;
      slot.aux[a + 5] = u.workKind ?? 0;
      slot.aux[a + 6] = u.profession ?? 0;
      slot.aux[a + 7] = u.facing ?? 0;
      slot.aux[a + 8] = u.targetDist ?? 0;
      slot.aux[a + 9] = u.maxHp;
      n++;
    }
    slot.count[0] = n;
    Atomics.add(this.#header, lock, 1); // even: stable
    Atomics.store(this.#header, H_PUBLISH_SEQ, seq);
  }
}

/** A stable copy of one published slot. */
export interface SlotCopy {
  publishSeq: number;
  count: number;
  ids: Int32Array;
  xs: Float32Array;
  ys: Float32Array;
  aux: Uint8Array;
  /** id -> index within this copy */
  index: Map<number, number>;
}

function emptyCopy(): SlotCopy {
  return {
    publishSeq: -1,
    count: 0,
    ids: new Int32Array(MAX_UNITS),
    xs: new Float32Array(MAX_UNITS),
    ys: new Float32Array(MAX_UNITS),
    aux: new Uint8Array(AUX_BYTES),
    index: new Map(),
  };
}

export class SabReader {
  #header: Int32Array;
  #slots: SlotViews[];
  /** Two most recent stable copies: [previous, latest]. */
  readonly prev = emptyCopy();
  readonly latest = emptyCopy();
  /** performance.now() when `latest` was first observed. */
  latestObservedAt = 0;

  constructor(buffer: SharedArrayBuffer | ArrayBuffer) {
    this.#header = new Int32Array(buffer, 0, HEADER_INTS);
    this.#slots = [];
    for (let s = 0; s < SLOT_COUNT; s++) this.#slots.push(slotViews(buffer, s));
  }

  /**
   * Poll for new publishes. Copies at most the two most recent slots; returns
   * true if `latest` advanced.
   */
  poll(now: number): boolean {
    const seq = Atomics.load(this.#header, H_PUBLISH_SEQ);
    if (seq === this.latest.publishSeq || seq === 0) return false;

    // If we skipped publishes (slow frame), refresh prev from seq-1, else
    // reuse the old latest as prev by swapping buffers.
    if (seq === this.latest.publishSeq + 1) {
      this.#swapLatestIntoPrev();
    } else if (seq > 1) {
      this.#copySlot(seq - 1, this.prev);
    }
    if (!this.#copySlot(seq, this.latest)) return false;
    this.latestObservedAt = now;
    return true;
  }

  #swapLatestIntoPrev(): void {
    const p = this.prev;
    const l = this.latest;
    (this.prev as SlotCopy).publishSeq = l.publishSeq;
    // Swap the typed arrays + maps wholesale.
    const tmp = {ids: p.ids, xs: p.xs, ys: p.ys, aux: p.aux, index: p.index};
    Object.assign(p, {
      publishSeq: l.publishSeq,
      count: l.count,
      ids: l.ids,
      xs: l.xs,
      ys: l.ys,
      aux: l.aux,
      index: l.index,
    });
    Object.assign(l, tmp);
  }

  #copySlot(seq: number, out: SlotCopy): boolean {
    const slotIdx = seq % SLOT_COUNT;
    const slot = this.#slots[slotIdx]!;
    const lock = H_SLOT_SEQ0 + slotIdx;
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = Atomics.load(this.#header, lock);
      if (before & 1) continue; // write in progress
      const count = slot.count[0]!;
      // Copy only the live prefix: the seqlock before/after check re-verifies
      // that count and rows were stable across the copy, so stale bytes past
      // `count` are never read.
      out.ids.set(slot.ids.subarray(0, count));
      out.xs.set(slot.xs.subarray(0, count));
      out.ys.set(slot.ys.subarray(0, count));
      out.aux.set(slot.aux.subarray(0, count * AUX_STRIDE));
      const after = Atomics.load(this.#header, lock);
      if (before === after) {
        out.publishSeq = seq;
        out.count = count;
        out.index.clear();
        for (let i = 0; i < count; i++) out.index.set(out.ids[i]!, i);
        return true;
      }
    }
    return false;
  }
}
