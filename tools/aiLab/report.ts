import { trialsForPrecision, type BakeoffReport, type Rate } from './stats.ts';
import { TICK_MS } from '../../src/sim/defs/balance.ts';

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
  strategy: string;
  advicePeriod: number;
  latency: number | 'measured';
  maxTicks: number;
  control: boolean;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
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

export function renderReport(header: ReportHeader, report: BakeoffReport): string {
  const { health, flips, advised } = report;
  const out: string[] = [];
  const p = (s = ''): void => void out.push(s);

  p('Serf Valley — LLM strategist bake-off');
  p(`  engine    ${header.engine}`);
  p(
    `  seeds     ${header.seeds} (${header.seedCount}) · map ${header.mapSize} · ` +
      `bandits ${header.bandits ? 'on' : 'off'} · ${header.strategy}`,
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
  p();
  for (const line of verdict(report)) p(`  ${line}`);
  p();

  if (header.control) {
    p('FLIPS vs the unadvised control (same seed, same playbooks)');
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
