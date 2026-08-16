/**
 * Voice budgeting: the part that decides whether two hundred simultaneous
 * axe strikes are a living valley or white noise.
 *
 * Callers fire requests all frame; `flush()` runs once per rAF and turns
 * them into at most a couple dozen actual voices, in this order:
 *
 *  1. Inaudible requests were already dropped at `request()` — distance
 *     silence must not consume cooldown slots.
 *  2. A cue inside its cooldown window is folded away entirely: the voice
 *     already ringing covers it.
 *  3. N identical cues collapse into one voice: gain grows by a log law
 *     (coincident equal sources are +3 dB per doubling; we flatten even
 *     that, because a crowd should read as *bigger*, not *louder*), panned
 *     at the gain-weighted centroid. One exception: when the group spans
 *     the stereo field (spread > CLUSTER_SPREAD), it splits by side — a
 *     skirmish at the left edge and one at the right must not merge into
 *     a single centred blob, which is the exact failure that makes
 *     collapsed audio sound wrong.
 *  4. Per-bus caps keep the loudest-times-priority survivors; a global
 *     cap (minus voices still ringing in the engine) bounds the whole mix.
 *
 * Pure by construction: time comes in as a parameter, randomness is
 * hash2, results go into a caller-owned pool. The mixer never decides;
 * this module never plays. That split is what makes the interesting
 * bugs — and there are interesting bugs in code like this — testable
 * under vitest's node environment.
 */

import { hash2 } from '../shared/math';
import { MIN_AUDIBLE } from './pan';

export interface SchedulerCueDef {
  bus: string;
  cooldownMs: number;
  priority: number;
  collapseCeiling?: number;
}

export interface PlayRequest {
  cue: string;
  pan: number;
  gain: number;
  /** Seconds ahead to schedule — the loop-event percussion fires at a
   * clip's wrap point but the impact lands mid-clip. Collapsed voices
   * carry the gain-weighted mean; the spread inside one collapse window
   * is the crowd's natural stagger and one voice cannot keep it anyway. */
  delay: number;
  /** Deterministic per-voice jitter seed in [0, 1). */
  seed: number;
}

export const BUS_CAPS: Record<string, number> = {
  ui: 4,
  combat: 12,
  work: 10,
  world: 6,
  ambient: 8,
  music: 1,
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
  minPan: number;
  maxPan: number;
  left: Side;
  right: Side;
}

interface Candidate {
  cue: string;
  bus: string;
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
  #caps: Record<string, number>;
  #globalCap: number;

  // The frame's requests, as parallel pooled arrays (no per-request objects).
  #cues: string[] = [];
  #pans: number[] = [];
  #gains: number[] = [];
  #delays: number[] = [];
  #len = 0;

  #last = new Map<string, number>();
  // Group and candidate pools persist across flushes; #groupLen/#candLen
  // are the live counts, so steady state allocates nothing per frame.
  #groups: Group[] = [];
  #groupIdx = new Map<string, number>();
  #cands: Candidate[] = [];
  #busUsed = new Map<string, number>();
  #flushSeq = 0;

  constructor(
    defs: Record<string, SchedulerCueDef>,
    caps: Record<string, number> = BUS_CAPS,
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
    // Group by cue, aggregating both a combined and a per-side view so the
    // split decision needs no second pass.
    let groupLen = 0;
    this.#groupIdx.clear();
    for (let i = 0; i < this.#len; i++) {
      const cue = this.#cues[i]!;
      let gi = this.#groupIdx.get(cue);
      if (gi === undefined) {
        gi = groupLen++;
        this.#groupIdx.set(cue, gi);
        let g = this.#groups[gi];
        if (!g) {
          g = this.#groups[gi] = {
            cue,
            minPan: 0,
            maxPan: 0,
            left: { n: 0, maxGain: 0, gainSum: 0, panGainSum: 0, delayGainSum: 0 },
            right: { n: 0, maxGain: 0, gainSum: 0, panGainSum: 0, delayGainSum: 0 },
          };
        }
        g.cue = cue;
        g.minPan = Infinity;
        g.maxPan = -Infinity;
        resetSide(g.left);
        resetSide(g.right);
      }
      const g = this.#groups[gi]!;
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

    // Groups -> candidate voices (cooldown, collapse, cluster split).
    let candLen = 0;
    for (let gi = 0; gi < groupLen; gi++) {
      const g = this.#groups[gi]!;
      const def = this.#defs[g.cue]!;
      const last = this.#last.get(g.cue);
      if (last !== undefined && now - last < def.cooldownMs) continue;
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
        if (!c) c = this.#cands[ci] = { cue: '', bus: '', pan: 0, gain: 0, delay: 0, score: 0 };
        c.cue = g.cue;
        c.bus = def.bus;
        c.pan = gainSum > 0 ? panGainSum / gainSum : 0;
        c.gain = gain;
        c.delay = gainSum > 0 ? delayGainSum / gainSum : 0;
        c.score = gain * def.priority;
      }
    }

    // Loudest-times-priority first. n stays small (< 40), so sorting an
    // index-free slice of the pool is fine; the pool itself keeps its
    // high-water length.
    const live = this.#cands.slice(0, candLen).sort((a, b) => b.score - a.score);

    this.#busUsed.clear();
    let outLen = 0;
    let budget = this.#globalCap - activeVoices;
    this.#flushSeq++;
    for (const c of live) {
      if (budget <= 0) break;
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
      outLen++;
      // Only what actually sounded claims the cooldown window; a candidate
      // squeezed out by the caps must not silence its successors.
      this.#last.set(c.cue, now);
    }
    return outLen;
  }
}
