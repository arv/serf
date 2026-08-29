import {spawn} from 'node:child_process';
import {appendFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {availableParallelism} from 'node:os';
import {dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
  parseStrategyId,
  AI_STRATEGY_ORDER,
} from '../../src/sim/defs/aiStrategies.ts';
import {
  ALL_ECONOMY_RULES,
  type EconomyRuleId,
  economyRuleFromKey,
  ECONOMY_RULE_KEYS,
} from '../../src/sim/economyRules.ts';
import type {Owner} from '../../src/sim/entities.ts';
import {
  buildEngine,
  describeSpec,
  parseEngineSpec,
  type EngineSpec,
  type LabEngine,
} from './engines.ts';
import {
  playMatch,
  type MatchConfig,
  type MatchRecord,
  type SeatStrategies,
} from './match.ts';
import type {WorkerTask} from './matchWorker.ts';
import {renderReport, type ReportHeader} from './report.ts';
import {summarize, type LayoutRun, type SeedRun} from './stats.ts';

/**
 * The bake-off: does putting an advisor over a seat's playbook beat not
 * putting one there?
 *
 * Per seed it plays up to three matches on one valley, all with the same
 * playbook on both sides so the advice is the only asymmetry:
 *
 *   control     neither seat advised — what the valley does on its own
 *   arm A       seat 0 advised, seat 1 on its printed playbook
 *   arm B       seat 1 advised, seat 0 on its printed playbook
 *
 * The mirrored pair is the point. The two starts are not identical — over
 * eight stock seeds seat 0 took five — so "the advised seat won 58%" would
 * mean nothing measured on one side only. Advising each seat in turn makes
 * the null exactly 50% no matter how lopsided the map is, and that is what
 * the report tests against.
 *
 * `--strategy steward:warlord` gives the seats different playbooks, and
 * then the sweep owes a second mirror. The advice mirror above still nulls
 * at exactly 50% — it never cared what the seats were playing — but it is
 * deaf to which PLAYBOOK is better, since it scores the advised side and
 * the advised side is each playbook in turn. So an asymmetric run plays
 * every seed in both seatings:
 *
 *   seating 0   seat 0 = steward, seat 1 = warlord
 *   seating 1   the two swapped
 *
 * and the report scores the steward across the pair. Under "these two are
 * equally good" it takes exactly one of its two seatings whatever head
 * start the valley hands a seat — the same cancellation the advice mirror
 * uses, one level up. Doubling the matches is what that costs.
 *
 * Calibrate it before trusting it:
 *
 *   --engine none      must print exactly 50.0% — with no strategist the
 *                      two arms ARE the control, so the mirror awards one
 *                      win and one loss per seed by construction. Anything
 *                      else means the harness is leaking state between
 *                      matches.
 *   --engine random    the noise floor. Turning knobs at random inside the
 *                      same ranges moves win rates on its own; an advisor
 *                      that cannot clear this line is not reading the
 *                      summary, it is just jostling the playbook.
 *
 * Only then is any arm's number worth reading.
 */

interface Options {
  spec: EngineSpec;
  seeds: number[];
  seedLabel: string;
  mapSize: number;
  bandits: boolean;
  strategies: SeatStrategies;
  maxTicks: number;
  advicePeriod: number;
  adviceStagger: number;
  latency: number;
  control: boolean;
  trace: boolean;
  checkInvariantsEvery: number;
  /** Undefined runs the whole table; a subset ablates. */
  economyRules?: readonly EconomyRuleId[];
  out: string | undefined;
  jobs: number;
  /** Wall-clock ceiling per --jobs child before the parent kills it and
   * scores the trial crashed — the guarantee matchWorker.ts promises. */
  matchTimeoutMs: number;
}

const USAGE = `
serf-valley AI bake-off

  node --experimental-strip-types tools/aiLab/bakeoff.ts [options]

  --engine <spec>      none | random[:n] | posture[:id] | posture-reads | script:{...}
                       (default: random)
  --seeds <spec>       1-24, or 1,4,9, or a mix (default: 1-24)
  --map <n>            grid side length (default: 96, the shipped default)
  --no-bandits         no bandit faction (default: bandits on)
  --strategy <id>[:<id>]
                       playbook both seats run (default: steward), or one
                       per seat — "--strategy steward:warlord" seats the
                       steward at 0 and the warlord at 1. Different
                       playbooks make every seed play twice more, once with
                       the two swapped, and add a PLAYBOOK MATCHUP section
                       nulled at 50% by that swap.
  --max-ticks <n>      give up and call it undecided (default: 120000)
  --advice-period <n>  ticks between one seat's consultations (default: 1800)
  --advice-stagger <n> offset between the seats' cadences (default: 300)
  --latency <n>        ticks between a consultation and its advice landing.
                       0 is an oracle; the recorded baselines all use it.
                       (default: 0)
  --rules <ids|none>   economy rules the seats run, comma-separated
                       (default: all of them). --rules none turns the layer
                       off; a subset ablates — sweep without one rule and the
                       difference is what that rule was worth.
  --no-control         skip the unadvised control match per seed
  --trace              keep every prompt and reply in the JSONL
  --check <n>          run sim invariants every n ticks, 0 to disable (default: 0)
  --jobs <n|max>       matches to play in parallel, each in its own process
                       (default: 1). Identical results to --jobs 1 for
                       every engine.
  --match-timeout-ms <n>
                       wall-clock ceiling per --jobs child before it is
                       killed and its trial scored crashed (default:
                       600000). One wedged match must not hang the sweep.
  --out <path>         write one JSON line per match here
  --help

  Examples:
    # calibrate: must print exactly 50.0%
    ... bakeoff.ts --engine none --seeds 1-12

    # the noise floor every model has to clear
    ... bakeoff.ts --engine random --seeds 1-40

    # the rule-based stance picker — the bar that actually matters
    ... bakeoff.ts --engine posture --seeds 1-40

    # ...and the same rule with the opponent unread: the null for it
    ... bakeoff.ts --engine posture-reads --seeds 1-80

    # one playbook against another, nobody advised
    ... bakeoff.ts --engine none --strategy steward:warlord --seeds 1-80
`;

/**
 * `steward` for both seats, or `steward:warlord` for one each. Validated
 * rather than cast: an unknown id used to sail through as an AiStrategyId
 * and land as the steward via strategyOf's fallback, so a typo silently
 * measured the default playbook against itself.
 */
export function parseStrategies(spec: string): SeatStrategies {
  const parts = spec.split(':');
  if (parts.length > 2)
    throw new Error(`--strategy wants "id" or "id:id", got "${spec}"`);
  const ids = parts.map(raw => {
    const id = parseStrategyId(raw.trim());
    if (!id) {
      throw new Error(
        `--strategy does not know "${raw}" (have: ${AI_STRATEGY_ORDER.join(', ')})`,
      );
    }
    return id;
  });
  return [ids[0]!, ids[1] ?? ids[0]!];
}

function parseSeeds(spec: string): number[] {
  const seeds: number[] = [];
  for (const part of spec.split(',')) {
    const range = /^(\d+)-(\d+)$/.exec(part.trim());
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (hi < lo) throw new Error(`--seeds range runs backwards: "${part}"`);
      for (let s = lo; s <= hi; s++) seeds.push(s);
      continue;
    }
    const one = Number(part.trim());
    if (!Number.isInteger(one))
      throw new Error(`--seeds wants integers, got "${part}"`);
    seeds.push(one);
  }
  if (seeds.length === 0) throw new Error('--seeds selected nothing');
  return seeds;
}

export function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`${flag} wants a value`);
    return value;
  };
  const num = (flag: string, fallback: number): number => {
    const raw = get(flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n))
      throw new Error(`${flag} wants a number, got "${raw}"`);
    return n;
  };

  const seedLabel = get('--seeds') ?? '1-24';
  const jobsRaw = get('--jobs') ?? '1';
  const jobs =
    jobsRaw === 'max'
      ? Math.max(1, availableParallelism() - 1)
      : Number(jobsRaw);
  if (!Number.isInteger(jobs) || jobs < 1) {
    throw new Error(
      `--jobs wants a positive integer or "max", got "${jobsRaw}"`,
    );
  }
  const latencyRaw = get('--latency') ?? '0';
  if (!Number.isFinite(Number(latencyRaw))) {
    throw new Error(`--latency wants a number of ticks, got "${latencyRaw}"`);
  }
  const rulesRaw = get('--rules');
  const economyRules =
    rulesRaw === undefined
      ? undefined
      : rulesRaw === 'none'
        ? []
        : rulesRaw.split(',').map(id => {
            const trimmed = id.trim();
            const rule = economyRuleFromKey(trimmed);
            if (rule === undefined) {
              throw new Error(
                `--rules does not know "${trimmed}" (have: ${ALL_ECONOMY_RULES.map(
                  r => ECONOMY_RULE_KEYS[r],
                ).join(', ')})`,
              );
            }
            return rule;
          });

  const matchTimeoutMs = num('--match-timeout-ms', 600_000);
  if (matchTimeoutMs <= 0) {
    throw new Error(
      `--match-timeout-ms wants a positive number of milliseconds, got "${matchTimeoutMs}"`,
    );
  }

  return {
    spec: parseEngineSpec(get('--engine') ?? 'random'),
    seeds: parseSeeds(seedLabel),
    seedLabel,
    mapSize: num('--map', 96),
    bandits: !argv.includes('--no-bandits'),
    strategies: parseStrategies(get('--strategy') ?? 'steward'),
    maxTicks: num('--max-ticks', 120_000),
    advicePeriod: num('--advice-period', 1800),
    adviceStagger: num('--advice-stagger', 300),
    latency: Number(latencyRaw),
    control: !argv.includes('--no-control'),
    trace: argv.includes('--trace'),
    checkInvariantsEvery: num('--check', 0),
    ...(economyRules !== undefined ? {economyRules} : {}),
    out: get('--out'),
    jobs,
    matchTimeoutMs,
  };
}

/** The two mirrored trials, in the order they are played. */
const ARM_SEATS: Owner[] = [0, 1];

/** One match the sweep owes: a seed's control, or one of its arms, in one
 * of the seatings. */
interface Trial {
  seed: number;
  seedIndex: number;
  /** 0 = playbooks as the flag gave them, 1 = the two seats swapped. */
  layout: 0 | 1;
  advisedSeat: Owner | null;
}

/**
 * How the serial path salts buildEngine, and how the worker must too.
 *
 * Seating 0 keeps the salt it always had, so every symmetric run recorded
 * before seatings existed still reproduces byte for byte. Seating 1 is a
 * different game and gets its own stream, off a coprime stride so the two
 * cannot collide for any seed a sweep will ever reach.
 */
const LAYOUT_SALT_STRIDE = 1_000_003;
const saltOf = (t: Trial): number =>
  t.seed * 2 + (t.advisedSeat ?? 0) + t.layout * LAYOUT_SALT_STRIDE;

/** The seats' playbooks in one seating. */
const seatingOf = (opts: Options, layout: 0 | 1): SeatStrategies =>
  layout === 0 ? opts.strategies : [opts.strategies[1], opts.strategies[0]];

/** Everything about a match except which seed, which seating and who is
 * advised — the three things a trial names. */
type MatchBase = Omit<MatchConfig, 'engines' | 'seed' | 'strategies'>;

/** Play one trial in this process — the --jobs 1 path, and the tests'. */
async function playHere(
  t: Trial,
  opts: Options,
  base: MatchBase,
): Promise<MatchRecord> {
  const engines = new Map<Owner, LabEngine>();
  if (t.advisedSeat !== null) {
    // `--engine none` builds nothing: the arm is then the control played
    // again, which is exactly the calibration case the header describes.
    const engine = buildEngine(opts.spec, saltOf(t));
    if (engine) engines.set(t.advisedSeat, engine);
  }
  return playMatch({
    ...base,
    seed: t.seed,
    strategies: seatingOf(opts, t.layout),
    engines,
  });
}

/** Play one trial in a child process — the --jobs N path. The child gets
 * the same salt the serial path would use, so N and 1 agree byte for byte. */
function playInWorker(
  t: Trial,
  opts: Options,
  base: MatchBase,
): Promise<MatchRecord> {
  const task: WorkerTask = {
    config: {...base, seed: t.seed, strategies: seatingOf(opts, t.layout)},
    advisedSeat: t.advisedSeat,
    spec: opts.spec,
    salt: saltOf(t),
  };
  const workerPath = fileURLToPath(
    new URL('./matchWorker.ts', import.meta.url),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', workerPath],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    // One settle, whoever gets there first: the watchdog must not wait for
    // a close that a truly stuck process might never emit, and a close (or
    // spawn error) arriving after the watchdog already scored the trial
    // must change nothing.
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      finish();
    };
    // The kill matchWorker.ts promises. A wedged child — a sim loop that
    // never ends, an http engine ignoring its own deadline — used to hold
    // its pool lane forever: the sweep never finished and the report (and
    // its crash accounting) never printed. The trial is scored crashed the
    // moment the deadline passes; the SIGKILL is best-effort on top
    // (SIGKILL, not SIGTERM: a process stuck in synchronous JS never
    // services a catchable signal — and one the kernel cannot reap frees
    // the lane anyway, which is the guarantee that matters).
    const watchdog = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `no result after ${opts.matchTimeoutMs}ms — worker killed ` +
              '(a wedged match, or raise --match-timeout-ms for a slow engine)',
          ),
        ),
      );
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone between scheduling and firing.
      }
    }, opts.matchTimeoutMs);
    const out: Buffer[] = [];
    const errText: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errText.push(chunk));
    child.on('error', err => settle(() => reject(err)));
    child.on('close', (code, signal) => {
      settle(() => {
        if (code !== 0) {
          // A signal death arrives as code null + the signal's name — the
          // OOM killer, a stray kill — and 'worker exited null' would bury
          // that.
          const why =
            signal !== null
              ? `worker killed by ${signal}`
              : `worker exited ${code}`;
          reject(
            new Error(Buffer.concat(errText).toString('utf8').trim() || why),
          );
          return;
        }
        try {
          resolve(
            JSON.parse(Buffer.concat(out).toString('utf8')) as MatchRecord,
          );
        } catch {
          reject(new Error('worker produced unparseable output'));
        }
      });
    });
    child.stdin.end(JSON.stringify(task));
  });
}

/** Run `work` over every item, at most `width` at a time, order preserved
 * in the result. Rejections surface as the item's settled error. */
async function pool<T, R>(
  items: T[],
  width: number,
  work: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = {status: 'fulfilled', value: await work(items[i]!)};
      } catch (err) {
        results[i] = {status: 'rejected', reason: err};
      }
    }
  };
  await Promise.all(Array.from({length: Math.min(width, items.length)}, lane));
  return results;
}

export async function runBakeoff(
  opts: Options,
  log: (line: string) => void,
): Promise<string> {
  const startedAt = Date.now();
  const crashes: string[] = [];

  if (opts.out) {
    mkdirSync(dirname(opts.out), {recursive: true});
    writeFileSync(opts.out, '');
  }
  const emit = (kind: string, t: Trial, record: MatchRecord): void => {
    if (!opts.out) return;
    // `layout` rides along so a swapped-seating sweep can be re-scored from
    // the JSONL alone; `advisedSeat` keeps the name and position it had, so
    // compare.ts reads runs recorded before seatings existed unchanged.
    appendFileSync(
      opts.out,
      `${JSON.stringify({kind, advisedSeat: t.advisedSeat, layout: t.layout, ...record})}\n`,
    );
  };

  const base: MatchBase = {
    mapSize: opts.mapSize,
    bandits: opts.bandits,
    maxTicks: opts.maxTicks,
    advicePeriod: opts.advicePeriod,
    adviceStagger: opts.adviceStagger,
    latencyTicks: opts.latency,
    checkInvariantsEvery: opts.checkInvariantsEvery,
    ...(opts.economyRules !== undefined
      ? {economyRules: opts.economyRules}
      : {}),
    trace: opts.trace,
  };

  // Two seatings only when the playbooks differ. Identical ones make the
  // swap the same match twice, which would double the sweep to buy nothing.
  const layouts: (0 | 1)[] =
    opts.strategies[0] === opts.strategies[1] ? [0] : [0, 1];
  const trials: Trial[] = opts.seeds.flatMap((seed, seedIndex) =>
    layouts.flatMap(layout => [
      ...(opts.control ? [{seed, seedIndex, layout, advisedSeat: null}] : []),
      ...ARM_SEATS.map(advisedSeat => ({seed, seedIndex, layout, advisedSeat})),
    ]),
  );

  let played = 0;
  const playOne = async (t: Trial): Promise<MatchRecord> => {
    const record = await (opts.jobs > 1
      ? playInWorker(t, opts, base)
      : playHere(t, opts, base));
    played++;
    // Emitted as it lands, not when the sweep ends: a three-hour run
    // killed at match 400 must leave 399 lines behind, not zero. Line
    // order therefore varies with --jobs; every line is self-describing
    // and compare.ts joins on fields, so order is presentation only.
    emit(t.advisedSeat === null ? 'control' : 'arm', t, record);
    const who =
      t.advisedSeat === null ? 'control' : `seat ${t.advisedSeat} advised`;
    const seating =
      layouts.length > 1 ? `[${record.strategies.join(' v ')}] ` : '';
    log(
      `seed ${t.seed} ${seating}${who} → ` +
        `${record.decided ? `winner ${record.winner ?? 'nobody'}` : 'undecided'} ` +
        `at ${record.ticks} ticks (${(record.wallMs / 1000).toFixed(1)}s, ${played}/${trials.length})`,
    );
    return record;
  };

  const settled = await pool(trials, opts.jobs, playOne);

  // Reassemble in seed order whatever order the pool finished in, so the
  // JSONL and the report read the same for every --jobs.
  const runs: SeedRun[] = opts.seeds.map(seed => ({
    seed,
    layouts: layouts.map((layout): LayoutRun => ({
      layout,
      control: null,
      arms: [],
    })),
  }));
  for (const [i, t] of trials.entries()) {
    const result = settled[i]!;
    const run = runs[t.seedIndex]!;
    const layout = run.layouts.find(l => l.layout === t.layout)!;
    if (result.status === 'rejected') {
      const reason =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      const who = t.advisedSeat === null ? 'control' : `seat ${t.advisedSeat}`;
      const seating = layouts.length > 1 ? ` seating ${t.layout}` : '';
      crashes.push(`seed ${t.seed}${seating} ${who}: ${reason}`);
      continue;
    }
    if (t.advisedSeat === null) layout.control = result.value;
    else layout.arms.push({advisedSeat: t.advisedSeat, record: result.value});
  }

  const report = summarize(runs, (Date.now() - startedAt) / 1000);
  const header: ReportHeader = {
    engine: describeSpec(opts.spec),
    seeds: opts.seedLabel,
    seedCount: opts.seeds.length,
    mapSize: opts.mapSize,
    bandits: opts.bandits,
    strategies: opts.strategies,
    advicePeriod: opts.advicePeriod,
    latency: opts.latency,
    maxTicks: opts.maxTicks,
    control: opts.control,
  };
  let text = renderReport(header, report);
  if (crashes.length > 0) {
    // Never quietly: a dropped trial skews the rate, so it is printed
    // where the rate is read.
    text += `\n\nCRASHED TRIALS (${crashes.length}, excluded from every number above)\n`;
    text += crashes.map(c => `  ${c}`).join('\n');
  }
  if (opts.out) {
    appendFileSync(
      opts.out,
      `${JSON.stringify({kind: 'report', header, report})}\n`,
    );
  }
  return text;
}

// Run only as a script, so the tests can import the pieces above.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  if (process.argv.includes('--help')) {
    console.log(USAGE.trim());
  } else {
    const opts = parseArgs(process.argv.slice(2));
    const text = await runBakeoff(opts, line =>
      process.stderr.write(`${line}\n`),
    );
    console.log(`\n${text}`);
  }
}
