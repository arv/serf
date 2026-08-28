/**
 * Voice budgeting: the part that decides whether two hundred simultaneous
 * axe strikes are a living valley or white noise.
 *
 * Callers fire requests all frame; `flush()` runs once per rAF and turns
 * them into at most a couple dozen actual voices, in this order:
 *
 *  1. Inaudible requests were already dropped at `request()` — distance
 *     silence must not consume cooldown slots.
 *  2. A cue whose impact would land inside the cooldown window of one
 *     already emitted is folded away entirely: the voice already ringing
 *     — or booked to ring, since impacts are scheduled ahead — covers
 *     it. The window lives at the *landing* time, not the request time:
 *     a strike booked two seconds out must not gag an unrelated strike
 *     landing next to now, and two requests landing together must fold
 *     even when they were made seconds apart.
 *  3. N identical cues collapse into one voice: gain grows by a log law
 *     (coincident equal sources are +3 dB per doubling; we flatten even
 *     that, because a crowd should read as *bigger*, not *louder*), panned
 *     at the gain-weighted centroid. Two exceptions. When the group spans
 *     the stereo field (spread > CLUSTER_SPREAD), it splits by side — a
 *     skirmish at the left edge and one at the right must not merge into
 *     a single centred blob, which is the exact failure that makes
 *     collapsed audio sound wrong. And requests only group when they land
 *     inside the same cooldown-sized window: the two strikes of one
 *     pickaxe cycle arrive in the same frame but aim at moments seconds
 *     apart, and averaging those made one clink at a time when nothing
 *     hits.
 *  4. Per-bus caps keep the loudest-times-priority survivors; a global
 *     cap (minus voices still ringing in the engine) bounds the whole mix.
 *
 * Pure by construction: time comes in as a parameter, randomness is
 * hash2, results go into a caller-owned pool. The mixer never decides;
 * this module never plays. That split is what makes the interesting
 * bugs — and there are interesting bugs in code like this — testable
 * under vitest's node environment.
 */

import type { Enum } from '../shared/enum.ts';
import { hash2 } from '../shared/math';
import { MIN_AUDIBLE } from './pan';
import * as BusId from './busIdEnum.ts';

type BusId = Enum<typeof BusId>;

export interface SchedulerCueDef {
  bus: BusId;
  cooldownMs: number;
  priority: number;
  collapseCeiling?: number;
}

export interface PlayRequest {
  cue: string;
  pan: number;
  gain: number;
  /** Seconds ahead to schedule — the loop-event percussion fires at a
   * clip's wrap point but the impact lands mid-clip. Requests collapse
   * only with others landing in the same cooldown-sized window, where
   * the gain-weighted mean is just the crowd's natural stagger; impacts
   * aimed at different moments (a pickaxe cycle's two strikes) group
   * apart and keep their own times. */
  delay: number;
  /** Deterministic per-voice jitter seed in [0, 1). */
  seed: number;
}

export const BUS_CAPS: Record<BusId, number> = {
  [BusId.ui]: 4,
  [BusId.combat]: 12,
  [BusId.work]: 10,
  [BusId.world]: 6,
  [BusId.ambient]: 8,
  [BusId.music]: 1,
};

export const GLOBAL_CAP = 28;

const DEFAULT_CEILING = 2.2;
/** log2 loudness growth per doubling of collapsed sources. */
const COLLAPSE_SLOPE = 0.28;
/** Pan spread beyond which a group splits into a left and a right voice. */
const CLUSTER_SPREAD = 0.6;

/** Per-side running aggregate while a flush groups requests by cue. */
interface Side {
  n: number;
  maxGain: number;
  gainSum: number;
  panGainSum: number;
  delayGainSum: number;
}

interface Group {
  cue: string;
  /** Landing-time bucket (delay in cooldown-window units) — groups of the
   * same cue aimed at different moments stay apart. */
  bucket: number;
  minPan: number;
  maxPan: number;
  left: Side;
  right: Side;
}

interface Candidate {
  cue: string;
  bus: BusId;
  pan: number;
  gain: number;
  delay: number;
  score: number;
}

const resetSide = (s: Side): void => {
  s.n = 0;
  s.maxGain = 0;
  s.gainSum = 0;
  s.panGainSum = 0;
  s.delayGainSum = 0;
};

export class CueScheduler {
  #defs: Record<string, SchedulerCueDef>;
  #caps: Record<BusId, number>;
  #globalCap: number;

  // The frame's requests, as parallel pooled arrays (no per-request objects).
  #cues: string[] = [];
  #pans: number[] = [];
  #gains: number[] = [];
  #delays: number[] = [];
  #len = 0;

  /** Per cue: landing times (absolute ms) of emitted voices whose cooldown
   * windows may still matter. Pruned in place on record; a couple of
   * entries per active cue in steady state. */
  #landings = new Map<string, number[]>();
  // This flush's emissions, parked until the loop ends: the fold below
  // must see only *previous* flushes, or it would eat the second half of
  // a deliberate stereo split — same cue, same landing, two pans.
  #pendCues: string[] = [];
  #pendLandings: number[] = [];
  // Group and candidate pools persist across flushes; #groupLen/#candLen
  // are the live counts, so steady state allocates nothing per frame.
  #groups: Group[] = [];
  #cands: Candidate[] = [];
  /** Indices into #cands, sorted in place — see the sort in flush(). */
  #order: number[] = [];
  #busUsed = new Map<BusId, number>();
  #flushSeq = 0;

  constructor(
    defs: Record<string, SchedulerCueDef>,
    caps: Record<BusId, number> = BUS_CAPS,
    globalCap: number = GLOBAL_CAP,
  ) {
    this.#defs = defs;
    this.#caps = caps;
    this.#globalCap = globalCap;
  }

  /** Number of requests waiting for the next flush (tests watch this). */
  get pending(): number {
    return this.#len;
  }

  /** Queue one cue for this frame. Sub-audible requests vanish here, before
   * they can touch a cooldown. */
  request(cue: string, pan: number, gain: number, delaySec = 0): void {
    if (gain <= MIN_AUDIBLE || this.#defs[cue] === undefined) return;
    const i = this.#len++;
    this.#cues[i] = cue;
    this.#pans[i] = pan;
    this.#gains[i] = gain;
    this.#delays[i] = delaySec;
  }

  /**
   * Resolve the frame: write the voices to start into `out` (a caller-owned
   * pool whose slots are reused) and return how many are valid.
   * `activeVoices` is how many the engine is still playing — the global cap
   * covers the sum, not just this frame's newcomers.
   */
  flush(now: number, activeVoices: number, out: PlayRequest[]): number {
    // Group by cue and landing-time bucket (one cooldown window wide),
    // aggregating both a combined and a per-side view so the split
    // decision needs no second pass. The bucket keeps deliberately
    // distinct impact times apart. Lookup is a linear scan over the live
    // groups — a frame holds a handful of cue+bucket combinations, and a
    // keyed map would need a composite key allocated per request.
    let groupLen = 0;
    for (let i = 0; i < this.#len; i++) {
      const cue = this.#cues[i]!;
      const bucket = Math.floor((this.#delays[i]! * 1000) / this.#defs[cue]!.cooldownMs);
      let g: Group | undefined;
      for (let gi = 0; gi < groupLen; gi++) {
        const seen = this.#groups[gi]!;
        if (seen.cue === cue && seen.bucket === bucket) {
          g = seen;
          break;
        }
      }
      if (!g) {
        const gi = groupLen++;
        g = this.#groups[gi];
        if (!g) {
          g = this.#groups[gi] = {
            cue,
            bucket,
            minPan: 0,
            maxPan: 0,
            left: { n: 0, maxGain: 0, gainSum: 0, panGainSum: 0, delayGainSum: 0 },
            right: { n: 0, maxGain: 0, gainSum: 0, panGainSum: 0, delayGainSum: 0 },
          };
        }
        g.cue = cue;
        g.bucket = bucket;
        g.minPan = Infinity;
        g.maxPan = -Infinity;
        resetSide(g.left);
        resetSide(g.right);
      }
      const pan = this.#pans[i]!;
      const gain = this.#gains[i]!;
      if (pan < g.minPan) g.minPan = pan;
      if (pan > g.maxPan) g.maxPan = pan;
      const side = pan < 0 ? g.left : g.right;
      side.n++;
      side.gainSum += gain;
      side.panGainSum += pan * gain;
      side.delayGainSum += this.#delays[i]! * gain;
      if (gain > side.maxGain) side.maxGain = gain;
    }
    this.#len = 0;

    // The buckets are a fixed grid, so two groups can aim a hair apart
    // across a boundary (89ms and 91ms of delay hash to different
    // buckets). Fold any same-cue pair whose mean landings sit within
    // one cooldown window — that pair is one moment, not two. Groups per
    // flush are a handful; the quadratic scan is nothing.
    const meanDelay = (g: Group): number => {
      const gainSum = g.left.gainSum + g.right.gainSum;
      return gainSum > 0 ? (g.left.delayGainSum + g.right.delayGainSum) / gainSum : 0;
    };
    for (let a = 0; a < groupLen; a++) {
      const ga = this.#groups[a]!;
      const win = this.#defs[ga.cue]!.cooldownMs;
      for (let b = a + 1; b < groupLen; b++) {
        const gb = this.#groups[b]!;
        if (gb.cue !== ga.cue) continue;
        if (Math.abs(meanDelay(ga) - meanDelay(gb)) * 1000 >= win) continue;
        if (gb.minPan < ga.minPan) ga.minPan = gb.minPan;
        if (gb.maxPan > ga.maxPan) ga.maxPan = gb.maxPan;
        for (const side of ['left', 'right'] as const) {
          const sa = ga[side];
          const sb = gb[side];
          sa.n += sb.n;
          sa.gainSum += sb.gainSum;
          sa.panGainSum += sb.panGainSum;
          sa.delayGainSum += sb.delayGainSum;
          if (sb.maxGain > sa.maxGain) sa.maxGain = sb.maxGain;
        }
        // Swap the last live group in; gb stays parked in the pool.
        groupLen--;
        this.#groups[b] = this.#groups[groupLen]!;
        this.#groups[groupLen] = gb;
        // The merge moved ga's mean — groups already passed over may have
        // drifted into range, so rescan ga's row from the top.
        b = a;
      }
    }

    // Groups -> candidate voices (collapse, cluster split). Cooldown is
    // judged at emit time below, against landing times.
    let candLen = 0;
    for (let gi = 0; gi < groupLen; gi++) {
      const g = this.#groups[gi]!;
      const def = this.#defs[g.cue]!;
      const split = g.maxPan - g.minPan > CLUSTER_SPREAD;
      for (const side of split ? [g.left, g.right] : [null]) {
        let n: number, maxGain: number, gainSum: number, panGainSum: number, delayGainSum: number;
        if (side) {
          if (side.n === 0) continue;
          ({ n, maxGain, gainSum, panGainSum, delayGainSum } = side);
        } else {
          n = g.left.n + g.right.n;
          maxGain = Math.max(g.left.maxGain, g.right.maxGain);
          gainSum = g.left.gainSum + g.right.gainSum;
          panGainSum = g.left.panGainSum + g.right.panGainSum;
          delayGainSum = g.left.delayGainSum + g.right.delayGainSum;
        }
        const ceiling = def.collapseCeiling ?? DEFAULT_CEILING;
        const gain = Math.min(maxGain * (1 + COLLAPSE_SLOPE * Math.log2(n)), ceiling);
        const ci = candLen++;
        let c = this.#cands[ci];
        if (!c)
          c = this.#cands[ci] = { cue: '', bus: BusId.ui, pan: 0, gain: 0, delay: 0, score: 0 };
        c.cue = g.cue;
        c.bus = def.bus;
        c.pan = gainSum > 0 ? panGainSum / gainSum : 0;
        c.gain = gain;
        c.delay = gainSum > 0 ? delayGainSum / gainSum : 0;
        c.score = gain * def.priority;
      }
    }

    // Loudest-times-priority first. Sorting indices rather than a slice of
    // the pool keeps the steady state allocation-free: setting length on the
    // kept array reuses it, where slice() would hand back a new one every
    // frame. Ties hold their order either way — Array#sort is stable, and
    // the indices enter in candidate order.
    const order = this.#order;
    order.length = candLen;
    for (let i = 0; i < candLen; i++) order[i] = i;
    order.sort((a, b) => this.#cands[b]!.score - this.#cands[a]!.score);

    this.#busUsed.clear();
    let outLen = 0;
    let budget = this.#globalCap - activeVoices;
    this.#flushSeq++;
    for (let oi = 0; oi < candLen; oi++) {
      const c = this.#cands[order[oi]!]!;
      if (budget <= 0) break;
      // The cooldown fold, at landing time: covered by a voice a prior
      // frame already booked near this moment. This flush's own voices
      // are exempt — near-coincident candidates inside one flush are
      // either one group already or a stereo split that must stay two.
      if (this.#landingCovered(c.cue, now + c.delay * 1000)) continue;
      const used = this.#busUsed.get(c.bus) ?? 0;
      if (used >= (this.#caps[c.bus] ?? Infinity)) continue;
      this.#busUsed.set(c.bus, used + 1);
      budget--;
      let slot = out[outLen];
      if (!slot) slot = out[outLen] = { cue: '', pan: 0, gain: 0, delay: 0, seed: 0 };
      slot.cue = c.cue;
      slot.pan = c.pan;
      slot.gain = c.gain;
      slot.delay = c.delay;
      slot.seed = hash2(this.#flushSeq, outLen);
      // Only what actually sounded claims a cooldown window; a candidate
      // squeezed out by the caps must not silence its successors.
      this.#pendCues[outLen] = c.cue;
      this.#pendLandings[outLen] = now + c.delay * 1000;
      outLen++;
    }
    for (let i = 0; i < outLen; i++) {
      this.#recordLanding(this.#pendCues[i]!, this.#pendLandings[i]!, now);
    }
    return outLen;
  }

  /** Does this landing fall inside the cooldown window of one already
   * emitted (ringing now or booked ahead)? */
  #landingCovered(cue: string, landing: number): boolean {
    const list = this.#landings.get(cue);
    if (!list) return false;
    const win = this.#defs[cue]!.cooldownMs;
    for (let i = 0; i < list.length; i++) {
      if (Math.abs(landing - list[i]!) < win) return true;
    }
    return false;
  }

  #recordLanding(cue: string, landing: number, now: number): void {
    let list = this.#landings.get(cue);
    if (!list) this.#landings.set(cue, (list = []));
    // Compact away windows fully in the past, in place.
    const win = this.#defs[cue]!.cooldownMs;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i]! + win > now) list[w++] = list[i]!;
    }
    list.length = w;
    list.push(landing);
  }
}
