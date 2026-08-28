import {
  trialsForPrecision,
  type BakeoffReport,
  type PlaybookMatchup,
  type Rate,
} from './stats.ts';
import { TICK_MS } from '../../src/sim/defs/balance.ts';
import type { SeatStrategies } from './match.ts';
import { AI_STRATEGY_KEYS } from '../../src/sim/defs/aiStrategies.ts';

/**
 * The printed run. Written to be read by someone deciding whether to swap
 * a model, which means the verdict line does most of the work: a rate
 * without an interval is how a twenty-seed run turns into a conviction.
 */

export interface ReportHeader {
  engine: string;
  seeds: string;
  seedCount: number;
  mapSize: number;
  bandits: boolean;
  strategies: SeatStrategies;
  advicePeriod: number;
  latency: number | 'measured';
  maxTicks: number;
  control: boolean;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** What the seats ran, and whether the sweep owed a seating mirror for it. */
export function describeSeating([a, b]: SeatStrategies): string {
  const an = AI_STRATEGY_KEYS[a];
  const bn = AI_STRATEGY_KEYS[b];
  return a === b ? an : `${an} vs ${bn} (both seatings)`;
}

const minutes = (ticks: number): string => `${((ticks * TICK_MS) / 60_000).toFixed(1)} min`;

function rateLine(label: string, rate: Rate): string {
  const count = `${rate.wins} / ${rate.trials}`.padEnd(9);
  return `  ${label.padEnd(12)}${count} ${pct(rate.rate).padStart(6)}`;
}

/**
 * Did the advice do anything? Only three answers are honest, and two of
 * them are "we cannot tell yet".
 */
export function verdict(report: BakeoffReport): string[] {
  const { advised } = report;
  if (advised.trials === 0) {
    return ['VERDICT   no match reached a verdict — raise --max-ticks.'];
  }
  const halfWidth = (advised.hi - advised.lo) / 2;
  const resolves = `at ${advised.trials} trials this can only resolve ±${(halfWidth * 100).toFixed(1)}pp`;
  const forFive = `±5pp would need ~${trialsForPrecision(0.05)} trials (${Math.ceil(trialsForPrecision(0.05) / 2)} seeds)`;

  if (advised.lo > 0.5) {
    return [
      `VERDICT   the advice HELPS — the whole interval sits above 50%.`,
      `          ${resolves}.`,
    ];
  }
  if (advised.hi < 0.5) {
    return [
      `VERDICT   the advice HURTS — the whole interval sits below 50%.`,
      `          ${resolves}.`,
    ];
  }
  return [
    `VERDICT   not significant — the interval spans 50%, so this run is`,
    `          consistent with the advice doing nothing at all.`,
    `          ${resolves}; ${forFive}.`,
  ];
}

/**
 * Playbook against playbook. Two numbers, and the order to read them in:
 * the seed-level exact test first, the pooled rate second.
 *
 * The pooled rate's Wilson interval treats the two seatings of a seed as
 * two independent draws, and they are not — they share a valley. So it is
 * printed as the effect size it is, with the interval flagged, while the
 * verdict comes off the paired test, which assumes nothing about the map.
 */
export function renderMatchup(m: PlaybookMatchup): string[] {
  const out: string[] = [];
  const p = (s = ''): void => void out.push(s);
  const { paired } = m;
  const decisive = paired.bothA + paired.bothB;

  p(
    `PLAYBOOK MATCHUP  ${AI_STRATEGY_KEYS[m.a]} vs ${AI_STRATEGY_KEYS[m.b]}  (unadvised matches only)`,
  );
  p(
    `  ${AI_STRATEGY_KEYS[m.a].padEnd(12)}${`${m.rate.wins} / ${m.rate.trials}`.padEnd(9)} ` +
      `${pct(m.rate.rate).padStart(6)}   95% CI [${pct(m.rate.lo)}, ${pct(m.rate.hi)}] (optimistic — see below)`,
  );
  for (const s of m.bySeat) {
    p(
      `    on seat ${s.seat}  ${String(s.wins).padStart(3)} / ${String(s.trials).padEnd(4)} ${pct(s.trials === 0 ? 0 : s.wins / s.trials).padStart(6)}`,
    );
  }
  p('  A wide gap between those two lines is the valley favouring a start,');
  p('  which is exactly what playing both seatings cancels.');
  p();
  const seedLine = (label: string, n: number): void =>
    p(`    ${label.padEnd(24)}${String(n).padStart(4)}`);
  p(`  PER SEED, across the two seatings`);
  seedLine(`${AI_STRATEGY_KEYS[m.a]} took both`, paired.bothA);
  seedLine(`${AI_STRATEGY_KEYS[m.b]} took both`, paired.bothB);
  seedLine('one each (no evidence)', paired.split);
  if (paired.unresolved > 0) seedLine('unresolved', paired.unresolved);
  p(`    exact binomial over the ${decisive} decisive seeds: p = ${paired.p.toPrecision(3)}`);
  p();
  if (decisive === 0) {
    p(`  VERDICT   every seed split one seating each — nothing separates`);
    p(`            these playbooks here.`);
  } else if (paired.p < 0.05) {
    const better = AI_STRATEGY_KEYS[paired.bothA > paired.bothB ? m.a : m.b];
    p(`  VERDICT   ${better} is the better playbook on these seeds (p < 0.05).`);
  } else {
    p(`  VERDICT   not significant — a seed that swings with the seating is`);
    p(`            the map talking, and the ones that did not are consistent`);
    p(`            with a coin flip. More seeds, or the gap is not there.`);
  }
  p();
  p('  The pooled rate above counts each seed twice and its two counts are');
  p('  correlated, so read the paired line for significance and the rate');
  p('  only for size.');
  return out;
}

export function renderReport(header: ReportHeader, report: BakeoffReport): string {
  const { health, flips, advised } = report;
  const out: string[] = [];
  const p = (s = ''): void => void out.push(s);

  p('Serf Valley — LLM strategist bake-off');
  p(`  engine    ${header.engine}`);
  p(
    `  seeds     ${header.seeds} (${header.seedCount}) · map ${header.mapSize} · ` +
      `bandits ${header.bandits ? 'on' : 'off'} · ${describeSeating(header.strategies)}`,
  );
  p(
    `  cadence   advice every ${header.advicePeriod} ticks ` +
      `(${((header.advicePeriod * TICK_MS) / 1000).toFixed(0)}s) · ` +
      `latency ${header.latency === 'measured' ? 'measured' : `${header.latency} ticks`}`,
  );
  p(`  horizon   ${header.maxTicks} ticks · control ${header.control ? 'on' : 'off'}`);
  p();

  p('ADVISED WIN RATE');
  p(rateLine('overall', advised));
  p(`              95% CI [${pct(advised.lo)}, ${pct(advised.hi)}]`);
  for (const { seat, rate } of report.bySeat) p(rateLine(`seat ${seat}`, rate));
  p();
  p('  Each seed is played twice — once advising each seat — so whatever');
  p('  head start the valley gives a seat is worn by the advised side in');
  p('  half the trials and the control in the other half. The null is 50%.');
  if (report.playbooks) {
    // The mirror never cared what the seats were playing, so the bar holds
    // — but the rate is now an average over two different treatments, and
    // the per-seat split is two questions rather than two halves of one.
    p();
    p(`  The seats run different playbooks, so this rate pools advice given`);
    p(`  to the ${report.playbooks.a} with advice given to the ${report.playbooks.b}.`);
    p('  The null is still exactly 50% — the mirror is over which seat wears');
    p('  the advice, not over what it is playing — but which playbook is');
    p('  better is a separate question, measured below.');
  }
  p();
  for (const line of verdict(report)) p(`  ${line}`);
  p();

  if (report.playbooks) {
    for (const line of renderMatchup(report.playbooks)) p(line);
    p();
  }

  if (header.control) {
    p('FLIPS vs the unadvised control (same seed, same seating)');
    p(`  toward the advised seat  ${String(flips.toward).padStart(4)}`);
    p(`  away from it             ${String(flips.away).padStart(4)}`);
    p(`  winner unchanged         ${String(flips.unchanged).padStart(4)}`);
    if (flips.noControl > 0) p(`  no usable control        ${String(flips.noControl).padStart(4)}`);
    p();
  }

  const replies = health.consultations - health.skipped;
  const share = (n: number): string => (replies === 0 ? '—' : pct(n / replies));
  p('ENGINE HEALTH');
  p(`  consultations  ${health.consultations} (declined ${health.skipped})`);
  p(
    `  replies        errors ${health.errors} (${share(health.errors)}) · ` +
      `unparseable ${health.parseFailures} (${share(health.parseFailures)}) · ` +
      `no-change ${health.emptyAdvice} (${share(health.emptyAdvice)})`,
  );
  p(`  advice landed  ${health.adviceMessages} messages`);
  p(
    `  latency ms     p50 ${health.latencyMs.p50} · p95 ${health.latencyMs.p95} · ` +
      `max ${health.latencyMs.max}`,
  );
  if (health.latencyMs.p50 > 0) {
    // The number the game actually has to live with: how far the valley
    // moves while the model is thinking.
    p(
      `                 ≈ ${Math.round(health.latencyMs.p50 / TICK_MS)} ticks of sim at p50 ` +
        `(re-run with --latency measured to make the advice pay it)`,
    );
  }
  p(
    health.gaveUp.length === 0
      ? '  gave up        none'
      : `  gave up        ${health.gaveUp.length}: ${health.gaveUp[0]!.reason}`,
  );
  p();

  p('MATCHES');
  p(
    `  median ${report.matchTicks.median} ticks (${minutes(report.matchTicks.median)}) · ` +
      `longest ${report.matchTicks.max} · undecided ${report.undecided}`,
  );
  p(
    `  stalled ${report.stalls.matches} match(es) · ` +
      `${report.stalls.recoveries} recovery order(s)`,
  );
  p(`  sweep took ${report.wallSeconds.toFixed(0)}s`);
  return out.join('\n');
}
