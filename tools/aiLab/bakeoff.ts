import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildEngine,
  describeSpec,
  parseEngineSpec,
  type EngineSpec,
  type LabEngine,
} from './engines.ts';
import { playMatch, type MatchConfig, type MatchRecord } from './match.ts';
import { renderReport, type ReportHeader } from './report.ts';
import { summarize, type SeedRun } from './stats.ts';
import type { AiStrategyId } from '../../src/sim/defs/aiStrategies.ts';
import type { Owner } from '../../src/sim/entities.ts';
import type { WorkerTask } from './matchWorker.ts';

/**
 * The bake-off: does putting a model in the strategist's seat beat not
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
 * Calibrate it before trusting it:
 *
 *   --engine none      must print exactly 50.0% — with no strategist the
 *                      two arms ARE the control, so the mirror awards one
 *                      win and one loss per seed by construction. Anything
 *                      else means the harness is leaking state between
 *                      matches.
 *   --engine random    the noise floor. Turning knobs at random inside the
 *                      same ranges moves win rates on its own; a model
 *                      that cannot clear this line is not reading the
 *                      summary, it is just jostling the playbook.
 *
 * Only then is a real model's number worth reading.
 */

interface Options {
  spec: EngineSpec;
  seeds: number[];
  seedLabel: string;
  mapSize: number;
  bandits: boolean;
  strategy: AiStrategyId;
  maxTicks: number;
  advicePeriod: number;
  adviceStagger: number;
  latency: number | 'measured';
  timeoutMs: number | undefined;
  control: boolean;
  trace: boolean;
  checkInvariantsEvery: number;
  out: string | undefined;
  jobs: number;
}

const USAGE = `
serf-valley LLM strategist bake-off

  node --experimental-strip-types tools/aiLab/bakeoff.ts [options]

  --engine <spec>      none | random[:n] | posture[:id] | script:{...}
                       | http://host:port/v1  (default: random)
  --model <name>       model name sent to an http engine (default: local-model)
  --seeds <spec>       1-24, or 1,4,9, or a mix (default: 1-24)
  --map <n>            grid side length (default: 96, the shipped default)
  --no-bandits         no bandit faction (default: bandits on)
  --strategy <id>      playbook both seats run (default: steward)
  --max-ticks <n>      give up and call it undecided (default: 120000)
  --advice-period <n>  ticks between one seat's consultations (default: 1800)
  --advice-stagger <n> offset between the seats' cadences (default: 300)
  --latency <n|measured>
                       ticks between a consultation starting and its advice
                       landing. 0 gives the model hindsight the shipped one
                       does not have; 'measured' uses the engine's own wall
                       clock, which is realistic but not reproducible.
                       (default: 0)
  --timeout-ms <n>     per-consultation deadline (default: the strategist's 60000)
  --no-control         skip the unadvised control match per seed
  --trace              keep every prompt and reply in the JSONL
  --check <n>          run sim invariants every n ticks, 0 to disable (default: 0)
  --jobs <n|max>       matches to play in parallel, each in its own process
                       (default: 1). Identical results to --jobs 1 for every
                       engine except http, where it also means concurrent
                       requests — size the server's --parallel to match.
  --out <path>         write one JSON line per match here
  --help

  Examples:
    # calibrate: must print exactly 50.0%
    ... bakeoff.ts --engine none --seeds 1-12

    # the noise floor every model has to clear
    ... bakeoff.ts --engine random --seeds 1-40

    # the rule-based stance picker — the bar that actually matters
    ... bakeoff.ts --engine posture --seeds 1-40

    # real weights, through llama.cpp's own server
    #   llama-server -m qwen2.5-0.5b-instruct-q4_k_m.gguf -c 2048 --port 8080
    ... bakeoff.ts --engine http://localhost:8080/v1 --seeds 1-40 --out runs/qwen.jsonl
`;

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
    if (!Number.isInteger(one)) throw new Error(`--seeds wants integers, got "${part}"`);
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
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} wants a value`);
    return value;
  };
  const num = (flag: string, fallback: number): number => {
    const raw = get(flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${flag} wants a number, got "${raw}"`);
    return n;
  };

  const seedLabel = get('--seeds') ?? '1-24';
  const jobsRaw = get('--jobs') ?? '1';
  const jobs = jobsRaw === 'max' ? Math.max(1, availableParallelism() - 1) : Number(jobsRaw);
  if (!Number.isInteger(jobs) || jobs < 1) {
    throw new Error(`--jobs wants a positive integer or "max", got "${jobsRaw}"`);
  }
  const latencyRaw = get('--latency') ?? '0';
  if (latencyRaw !== 'measured' && !Number.isFinite(Number(latencyRaw))) {
    throw new Error(`--latency wants a number of ticks or "measured", got "${latencyRaw}"`);
  }
  const timeoutRaw = get('--timeout-ms');

  return {
    spec: parseEngineSpec(get('--engine') ?? 'random', get('--model') ?? 'local-model'),
    seeds: parseSeeds(seedLabel),
    seedLabel,
    mapSize: num('--map', 96),
    bandits: !argv.includes('--no-bandits'),
    strategy: (get('--strategy') ?? 'steward') as AiStrategyId,
    maxTicks: num('--max-ticks', 120_000),
    advicePeriod: num('--advice-period', 1800),
    adviceStagger: num('--advice-stagger', 300),
    latency: latencyRaw === 'measured' ? 'measured' : Number(latencyRaw),
    timeoutMs: timeoutRaw === undefined ? undefined : Number(timeoutRaw),
    control: !argv.includes('--no-control'),
    trace: argv.includes('--trace'),
    checkInvariantsEvery: num('--check', 0),
    out: get('--out'),
    jobs,
  };
}

/** The two mirrored trials, in the order they are played. */
const ARM_SEATS: Owner[] = [0, 1];

/** One match the sweep owes: a seed's control, or one of its arms. */
interface Trial {
  seed: number;
  seedIndex: number;
  advisedSeat: Owner | null;
}

/** How the serial path salts buildEngine, and how the worker must too. */
const saltOf = (t: Trial): number => t.seed * 2 + (t.advisedSeat ?? 0);

/** Play one trial in this process — the --jobs 1 path, and the tests'. */
async function playHere(t: Trial, opts: Options, base: Omit<MatchConfig, 'engines' | 'seed'>): Promise<MatchRecord> {
  const engines = new Map<Owner, LabEngine>();
  if (t.advisedSeat !== null) {
    // `--engine none` builds nothing: the arm is then the control played
    // again, which is exactly the calibration case the header describes.
    const engine = buildEngine(opts.spec, saltOf(t));
    if (engine) engines.set(t.advisedSeat, engine);
  }
  return playMatch({ ...base, seed: t.seed, engines });
}

/** Play one trial in a child process — the --jobs N path. The child gets
 * the same salt the serial path would use, so N and 1 agree byte for byte
 * (http engines aside, which sample). */
function playInWorker(t: Trial, opts: Options, base: Omit<MatchConfig, 'engines' | 'seed'>): Promise<MatchRecord> {
  const task: WorkerTask = {
    config: { ...base, seed: t.seed },
    advisedSeat: t.advisedSeat,
    spec: opts.spec,
    salt: saltOf(t),
  };
  const workerPath = fileURLToPath(new URL('./matchWorker.ts', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const errText: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errText.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(errText).toString('utf8').trim() || `worker exited ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(out).toString('utf8')) as MatchRecord);
      } catch {
        reject(new Error('worker produced unparseable output'));
      }
    });
    child.stdin.end(JSON.stringify(task));
  });
}

/** Run `work` over every item, at most `width` at a time, order preserved
 * in the result. Rejections surface as the item's settled error. */
async function pool<T, R>(items: T[], width: number, work: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { status: 'fulfilled', value: await work(items[i]!) };
      } catch (err) {
        results[i] = { status: 'rejected', reason: err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
  return results;
}

export async function runBakeoff(opts: Options, log: (line: string) => void): Promise<string> {
  const startedAt = Date.now();
  const crashes: string[] = [];

  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, '');
  }
  const emit = (kind: string, advisedSeat: Owner | null, record: MatchRecord): void => {
    if (!opts.out) return;
    appendFileSync(opts.out, `${JSON.stringify({ kind, advisedSeat, ...record })}\n`);
  };

  const base: Omit<MatchConfig, 'engines' | 'seed'> = {
    mapSize: opts.mapSize,
    bandits: opts.bandits,
    strategy: opts.strategy,
    maxTicks: opts.maxTicks,
    advicePeriod: opts.advicePeriod,
    adviceStagger: opts.adviceStagger,
    latencyTicks: opts.latency,
    checkInvariantsEvery: opts.checkInvariantsEvery,
    trace: opts.trace,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };

  const trials: Trial[] = opts.seeds.flatMap((seed, seedIndex) => [
    ...(opts.control ? [{ seed, seedIndex, advisedSeat: null }] : []),
    ...ARM_SEATS.map((advisedSeat) => ({ seed, seedIndex, advisedSeat })),
  ]);

  let played = 0;
  const playOne = async (t: Trial): Promise<MatchRecord> => {
    const record = await (opts.jobs > 1 ? playInWorker(t, opts, base) : playHere(t, opts, base));
    played++;
    // Emitted as it lands, not when the sweep ends: a three-hour run
    // killed at match 400 must leave 399 lines behind, not zero. Line
    // order therefore varies with --jobs; every line is self-describing
    // and compare.ts joins on fields, so order is presentation only.
    emit(t.advisedSeat === null ? 'control' : 'arm', t.advisedSeat, record);
    const who = t.advisedSeat === null ? 'control' : `seat ${t.advisedSeat} advised`;
    log(
      `seed ${t.seed} ${who} → ` +
        `${record.decided ? `winner ${record.winner ?? 'nobody'}` : 'undecided'} ` +
        `at ${record.ticks} ticks (${(record.wallMs / 1000).toFixed(1)}s, ${played}/${trials.length})`,
    );
    return record;
  };

  const settled = await pool(trials, opts.jobs, playOne);

  // Reassemble in seed order whatever order the pool finished in, so the
  // JSONL and the report read the same for every --jobs.
  const runs: SeedRun[] = opts.seeds.map((seed) => ({ seed, control: null, arms: [] }));
  for (const [i, t] of trials.entries()) {
    const result = settled[i]!;
    const run = runs[t.seedIndex]!;
    if (result.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      const who = t.advisedSeat === null ? 'control' : `seat ${t.advisedSeat}`;
      crashes.push(`seed ${t.seed} ${who}: ${reason}`);
      continue;
    }
    if (t.advisedSeat === null) run.control = result.value;
    else run.arms.push({ advisedSeat: t.advisedSeat, record: result.value });
  }

  const report = summarize(runs, (Date.now() - startedAt) / 1000);
  const header: ReportHeader = {
    engine: describeSpec(opts.spec),
    seeds: opts.seedLabel,
    seedCount: opts.seeds.length,
    mapSize: opts.mapSize,
    bandits: opts.bandits,
    strategy: opts.strategy,
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
    text += crashes.map((c) => `  ${c}`).join('\n');
  }
  if (opts.out) {
    appendFileSync(opts.out, `${JSON.stringify({ kind: 'report', header, report })}\n`);
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
    const text = await runBakeoff(opts, (line) => process.stderr.write(`${line}\n`));
    console.log(`\n${text}`);
  }
}
