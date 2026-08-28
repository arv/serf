import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import type {Owner} from '../../src/sim/entities.ts';
import type {MatchRecord} from './match.ts';
import {binomCdfHalf, twoSidedExact, wilson} from './stats.ts';

/**
 * Two bake-off runs, head to head: is model A actually better than model B?
 *
 * Comparing the two reports' intervals is the weak way to answer that —
 * it throws away the runs' best property, which is that they played the
 * *same seeds*. Paired on (seed, advised seat), most trials come out the
 * same on both sides and carry no information; the whole question lives in
 * the discordant pairs, where one model's advice won a trial the other's
 * lost. Under the null (models equally good) each discordant pair is a
 * coin flip, so the tail probability is exact binomial — McNemar's test.
 * On forty seeds this resolves differences the two Wilson intervals,
 * overlapping hopelessly, cannot see.
 *
 *   node --experimental-strip-types tools/aiLab/compare.ts a.jsonl b.jsonl
 *
 * The files are `--out` JSONL from two bakeoff runs over the same seeds
 * and settings; trials only one side played (crashed, different seed
 * lists) are reported and dropped.
 */

interface RunLine extends MatchRecord {
  kind: string;
  advisedSeat: Owner | null;
  /** Absent in runs recorded before seatings existed, which is the same
   * thing as seating 0. */
  layout?: 0 | 1;
}

/**
 * A trial's identity across two runs. Seating 0 keeps the bare
 * `seed:seat` key it always had, so a run recorded before seatings existed
 * still pairs against a new one — and seating 1 has to be in the key at
 * all, or an asymmetric run's two seatings collide on it and the second
 * silently overwrites the first.
 */
function trialKey(seed: number, seat: Owner, layout: 0 | 1): string {
  return layout === 0 ? `${seed}:${seat}` : `${seed}:${seat}:${layout}`;
}

/** One run's arm trials: (seed, advisedSeat) → did the advised seat win.
 * Undecided matches are excluded here for the same reason the report
 * excludes them — nobody won them. */
export interface ArmOutcomes {
  label: string;
  outcomes: Map<string, boolean>;
}

export function readRun(path: string): ArmOutcomes {
  const outcomes = new Map<string, boolean>();
  let label = path;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const parsed = JSON.parse(line) as
      | RunLine
      | {kind: 'report'; header?: {engine?: string}};
    if (parsed.kind === 'report') {
      const engine = (parsed as {header?: {engine?: string}}).header?.engine;
      if (engine) label = engine;
      continue;
    }
    const record = parsed as RunLine;
    if (record.kind !== 'arm' || record.advisedSeat === null || !record.decided)
      continue;
    outcomes.set(
      trialKey(record.seed, record.advisedSeat, record.layout ?? 0),
      record.winner === record.advisedSeat,
    );
  }
  return {label, outcomes};
}

export interface Comparison {
  a: {label: string; wins: number; trials: number};
  b: {label: string; wins: number; trials: number};
  /** Trials both runs decided — the paired set. */
  paired: number;
  /** Only in one run (crashed, undecided, or different seeds). */
  unpaired: number;
  /** A won where B lost. */
  aOnly: number;
  /** B won where A lost. */
  bOnly: number;
  /** Two-sided exact McNemar p over the discordant pairs. 1 when there
   * are none — identical records carry no evidence either way. */
  p: number;
}

/** Moved to stats.ts once the seating mirror needed the same exact test;
 * re-exported so this file still reads as the home of McNemar. */
export {binomCdfHalf};

export function compare(a: ArmOutcomes, b: ArmOutcomes): Comparison {
  let paired = 0;
  let aOnly = 0;
  let bOnly = 0;
  const keys = new Set([...a.outcomes.keys(), ...b.outcomes.keys()]);
  let unpaired = 0;
  for (const key of keys) {
    const aWon = a.outcomes.get(key);
    const bWon = b.outcomes.get(key);
    if (aWon === undefined || bWon === undefined) {
      unpaired++;
      continue;
    }
    paired++;
    if (aWon && !bWon) aOnly++;
    else if (bWon && !aWon) bOnly++;
  }
  const p = twoSidedExact(aOnly, bOnly);
  const wins = (r: ArmOutcomes): number =>
    [...r.outcomes.values()].filter(Boolean).length;
  return {
    a: {label: a.label, wins: wins(a), trials: a.outcomes.size},
    b: {label: b.label, wins: wins(b), trials: b.outcomes.size},
    paired,
    unpaired,
    aOnly,
    bOnly,
    p,
  };
}

const pct = (wins: number, trials: number): string =>
  trials === 0 ? '—' : `${((wins / trials) * 100).toFixed(1)}%`;

export function renderComparison(c: Comparison): string {
  const out: string[] = [];
  const p = (s = ''): void => void out.push(s);
  const side = (
    tag: string,
    s: {label: string; wins: number; trials: number},
  ): void => {
    const [lo, hi] = wilson(s.wins, s.trials);
    p(
      `  ${tag}  ${s.label}\n` +
        `     ${s.wins} / ${s.trials} advised wins (${pct(s.wins, s.trials)}), ` +
        `95% CI [${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%]`,
    );
  };
  p('Serf Valley — paired model comparison');
  side('A', c.a);
  side('B', c.b);
  p();
  p(
    `PAIRED on (seed, advised seat): ${c.paired} trials` +
      (c.unpaired > 0 ? ` (${c.unpaired} unpaired, dropped)` : ''),
  );
  p(`  A won, B lost   ${String(c.aOnly).padStart(4)}`);
  p(`  B won, A lost   ${String(c.bOnly).padStart(4)}`);
  p(
    `  same outcome    ${String(c.paired - c.aOnly - c.bOnly).padStart(4)}   (carry no evidence either way)`,
  );
  p();
  p(`  exact McNemar p = ${c.p.toPrecision(3)}`);
  if (c.aOnly + c.bOnly === 0) {
    p(
      '  VERDICT   the runs never disagreed — nothing separates these models here.',
    );
  } else if (c.p < 0.05) {
    const better = c.aOnly > c.bOnly ? 'A' : 'B';
    p(`  VERDICT   ${better} is better on these seeds (p < 0.05).`);
  } else {
    p(
      '  VERDICT   not significant — the discordant pairs are consistent with a',
    );
    p('            coin flip. More seeds, or a real difference is not there.');
  }
  return out.join('\n');
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (files.length !== 2) {
    console.error(
      'usage: node --experimental-strip-types tools/aiLab/compare.ts <a.jsonl> <b.jsonl>',
    );
    process.exit(2);
  }
  console.log(
    renderComparison(compare(readRun(files[0]!), readRun(files[1]!))),
  );
}
