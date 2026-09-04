import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {StrategyAdvice} from '../../src/ai/advice.ts';
import {Rng} from '../../src/shared/rng.ts';
import {
  AI_STRATEGIES,
  type AiStrategy,
} from '../../src/sim/defs/aiStrategies.ts';
import * as AiStrategyIdNs from '../../src/sim/defs/aiStrategyIdEnum.ts';
import type {Owner} from '../../src/sim/entities.ts';
import type {EngineSpec} from './engines.ts';
import type {MatchConfig, MatchRecord} from './match.ts';
import {adviceOf, describeMutation, mutate} from './mutate.ts';
import type {ProbeTask} from './probeWorker.ts';

/**
 * The knob-space sanity probe: does ANY neighbour of a shipped playbook
 * beat its parent, paired?
 *
 * The bake-off answers "is this advisor worth listening to". This answers
 * the question one level under it — whether the surface an advisor turns
 * has any headroom left at all. The recorded reason to doubt it: a model
 * authoring these same eleven numbers measured 50.0% with ZERO flips
 * (README, "Authoring knobs does not work at this size") while the same
 * model naming a stance cleared the floor. If a search over this space is
 * worth writing, something in it has to move a win rate here first.
 *
 * Both seats play the same playbook and BOTH are advised — the candidate
 * against the parent's own numbers restated — because advice outranks the
 * stance engine (systems/ai.ts, `{...strategy, ...stanceKnobs,
 * ...override}`), so an unadvised opponent would differ from the candidate
 * by its moods as well as by the knobs. Restating the parent mutes the
 * stance cascade on both sides and leaves the delta alone. The seatings
 * are mirrored, so the null is exactly 50% whatever head start the valley
 * gives a seat. The control is the parent against itself, played once per
 * seed and shared by every candidate — re-playing it per candidate would
 * burn a third of the sweep to learn nothing — and the `identity`
 * candidate IS that control, which is the calibration: it must report
 * every trial identical and nothing flipped.
 *
 * Read the flips, not the rate. "50% with zero flips" and "50% with
 * balanced flips" print the same headline and mean opposite things: the
 * first says the knobs never reached the field, the second says they
 * reached it and did not matter.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WORKER = `${HERE}probeWorker.ts`;

interface Candidate {
  label: string;
  what: string;
  advice: StrategyAdvice;
}

interface Trial {
  candidate: number;
  seed: number;
  /** Which seat wears the candidate's knobs; the other wears the parent's.
   * The pair of seatings is what nulls the valley's head start at 50%. */
  candidateSeat: Owner;
}

interface Done extends Trial {
  record: MatchRecord | null;
}

function baseConfig(
  seed: number,
  mapSize: number,
): Omit<MatchConfig, 'engines'> {
  const steward = AiStrategyIdNs.steward;
  return {
    seed,
    mapSize,
    bandits: true,
    strategies: [steward, steward],
    maxTicks: 120_000,
    advicePeriod: 1800,
    adviceStagger: 300,
    latencyTicks: 0,
  };
}

function playOne(
  trial: Trial,
  cand: Candidate,
  parent: Candidate,
  mapSize: number,
  timeoutMs: number,
): Promise<Done> {
  const wears = (c: Candidate): EngineSpec => ({
    kind: 'script',
    reply: c.advice,
  });
  const task: ProbeTask = {
    config: baseConfig(trial.seed, mapSize),
    specs:
      trial.candidateSeat === 0
        ? [wears(cand), wears(parent)]
        : [wears(parent), wears(cand)],
  };
  return new Promise<Done>(resolve => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', WORKER],
      {stdio: ['pipe', 'pipe', 'inherit']},
    );
    const out: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return resolve({...trial, record: null});
      try {
        resolve({
          ...trial,
          record: JSON.parse(
            Buffer.concat(out).toString('utf8'),
          ) as MatchRecord,
        });
      } catch {
        resolve({...trial, record: null});
      }
    });
    child.stdin.end(JSON.stringify(task));
  });
}

/** Wilson 95% interval on k/n. */
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.959964;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - s) / d, (c + s) / d];
}

/** Two-sided exact binomial on k of n at p = 0.5. */
function binomP(k: number, n: number): number {
  if (n === 0) return 1;
  const logC = (a: number, b: number): number => {
    let r = 0;
    for (let i = 1; i <= b; i++) r += Math.log(a - b + i) - Math.log(i);
    return r;
  };
  const pmf = (i: number): number => Math.exp(logC(n, i) - n * Math.LN2);
  const obs = pmf(k) * (1 + 1e-9);
  let p = 0;
  for (let i = 0; i <= n; i++) if (pmf(i) <= obs) p += pmf(i);
  return Math.min(1, p);
}

function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}

function arg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

async function main(): Promise<void> {
  const seedCount = arg('--seeds', 24);
  const mutantCount = arg('--mutants', 8);
  const jobs = arg('--jobs', 4);
  const mapSize = arg('--map', 96);
  const mutSeed = arg('--mut-seed', 1);
  const seedStart = arg('--seed-start', 1);
  const onlyAt = process.argv.indexOf('--only');
  const only =
    onlyAt < 0 ? null : new Set(process.argv[onlyAt + 1]!.split(','));
  const ablateAt = process.argv.indexOf('--ablate');
  const ablate = ablateAt < 0 ? null : process.argv[ablateAt + 1]!;
  const timeoutMs = arg('--match-timeout-ms', 300_000);

  const parent: AiStrategy = AI_STRATEGIES[AiStrategyIdNs.steward];
  const rng = new Rng(mutSeed);

  const candidates: Candidate[] = [
    // Calibration. The parent's own knobs, handed back to it as advice:
    // nothing may move, and every arm must end on its control's winner AND
    // its control's tick count. A failure here means the seam perturbs a
    // match by itself and every number below is jitter.
    // MUST be index 0: it is the parent every other candidate is played
    // against, and the seed's control is it against itself.
    {
      label: 'identity',
      what: 'the parent, restated — calibration, must be 100% same',
      advice: adviceOf(parent),
    },
    // The positive control, and the real question. Not a neighbour — the
    // aggression the sweeps keep re-discovering (README: "the printed
    // steward line is too passive"), written straight into the knobs the
    // whitelist already exposes. If the space has headroom anywhere, it is
    // here; if THIS cannot beat the parent, no search over these knobs will.
    {
      label: 'aggro',
      what: 'armyAttackSize 7→4, attackCooldown 900→400, prefersRivals→true',
      advice: {
        ...adviceOf(parent),
        armyAttackSize: 4,
        attackCooldown: 400,
        prefersRivals: true,
      },
    },
  ];
  for (let i = 0; i < mutantCount; i++) {
    // Alternating one- and three-knob steps: the honest neighbour, and a
    // bolder jump, because a search that only ever moves one knob a fifth
    // of its range may be too small a step to move a win rate at all.
    const knobs = i % 2 === 0 ? 1 : 3;
    const m = mutate(parent, rng, {knobs});
    const label = `mut${i + 1}`;
    candidates.push({
      label,
      what: `${knobs}-knob · ${describeMutation(m)}`,
      advice: adviceOf(m.strategy),
    });
    // The winner of a multi-knob step says nothing about which of its knobs
    // won. Split it: one candidate per change, played on the same seeds.
    if (ablate === label) {
      for (const c of m.changes) {
        const one: AiStrategy = {...parent};
        Object.assign(one, {[c.knob]: c.to});
        candidates.push({
          label: `${label}.${c.knob}`,
          what: `ablation · ${c.knob} ${JSON.stringify(c.from)}→${JSON.stringify(c.to)}`,
          advice: adviceOf(one),
        });
      }
    }
  }
  // The parent is index 0 and is never filtered out — it is what every
  // other candidate is played against.
  const kept = only
    ? candidates.filter(
        (c, i) =>
          i === 0 ||
          only.has(c.label) ||
          (ablate !== null && c.label.startsWith(`${ablate}.`)),
      )
    : candidates;
  candidates.length = 0;
  candidates.push(...kept);

  const parent0 = candidates[0]!;
  const seeds = Array.from({length: seedCount}, (_, i) => i + seedStart);
  const trials: Trial[] = [];
  // The control is the parent against itself — one match per seed, shared.
  for (const seed of seeds)
    trials.push({candidate: -1, seed, candidateSeat: 0 as Owner});
  // `identity` is that same match twice over; skip it and read the control
  // as its result, so the calibration costs nothing but still prints.
  for (let c = 1; c < candidates.length; c++) {
    for (const seed of seeds) {
      trials.push({candidate: c, seed, candidateSeat: 0 as Owner});
      trials.push({candidate: c, seed, candidateSeat: 1 as Owner});
    }
  }

  process.stderr.write(
    `probe: ${candidates.length} candidates × ${seeds.length} seeds ` +
      `+ ${seeds.length} shared controls = ${trials.length} matches, ` +
      `jobs ${jobs}\n`,
  );

  const results: Done[] = [];
  let next = 0;
  let finished = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({length: jobs}, async () => {
      for (;;) {
        const i = next++;
        if (i >= trials.length) return;
        const t = trials[i]!;
        results.push(
          await playOne(
            t,
            t.candidate < 0 ? parent0 : candidates[t.candidate]!,
            parent0,
            mapSize,
            timeoutMs,
          ),
        );
        finished++;
        if (finished % 10 === 0) {
          const per = (Date.now() - started) / finished / 1000;
          const left = ((trials.length - finished) * per).toFixed(0);
          process.stderr.write(
            `  ${finished}/${trials.length} · ${per.toFixed(1)}s/match · ` +
              `~${left}s left\n`,
          );
        }
      }
    }),
  );

  const controls = new Map<number, MatchRecord | null>();
  for (const r of results) {
    if (r.candidate < 0) controls.set(r.seed, r.record);
  }
  // The calibration reads off the controls: identity in both seatings is
  // the control match itself, so it must be 100% identical, 0 flips, and
  // exactly the control's own seat split.
  for (const seed of seeds) {
    const ctl = controls.get(seed) ?? null;
    results.push({candidate: 0, seed, candidateSeat: 0 as Owner, record: ctl});
    results.push({candidate: 0, seed, candidateSeat: 1 as Owner, record: ctl});
  }

  console.log('');
  console.log(
    `KNOB-SPACE PROBE — parent ${parent.name}, both seats, ` +
      `map ${mapSize}, seeds ${seeds[0]}-${seeds.at(-1)}`,
  );
  console.log('');
  console.log(
    '  cand      wins/trials    rate    95% CI            ' +
      'flips ->/<-  same  undec  what',
  );

  for (let c = 0; c < candidates.length; c++) {
    const mine = results.filter(r => r.candidate === c);
    let wins = 0;
    let decided = 0;
    let undecided = 0;
    let crashed = 0;
    let toward = 0;
    let away = 0;
    let identical = 0;
    for (const r of mine) {
      if (!r.record) {
        crashed++;
        continue;
      }
      const ctl = controls.get(r.seed);
      if (ctl && ctl.winner === r.record.winner && ctl.ticks === r.record.ticks)
        identical++;
      if (r.record.winner === null) {
        undecided++;
        continue;
      }
      decided++;
      const won = r.record.winner === r.candidateSeat;
      if (won) wins++;
      if (ctl && ctl.winner !== null) {
        const ctlWon = ctl.winner === r.candidateSeat;
        if (won && !ctlWon) toward++;
        if (!won && ctlWon) away++;
      }
    }
    const rate = decided ? wins / decided : 0;
    const [lo, hi] = wilson(wins, decided);
    const cand = candidates[c]!;
    console.log(
      `  ${cand.label.padEnd(9)} ${String(wins).padStart(3)}/${String(decided).padEnd(3)}` +
        `      ${pct(rate).padStart(6)}  ` +
        `[${pct(lo).padStart(6)}, ${pct(hi).padStart(6)}]   ` +
        `${String(toward).padStart(3)}/${String(away).padEnd(3)}     ` +
        `${String(identical).padStart(3)}   ${String(undecided).padStart(3)}` +
        `${crashed ? `  CRASHED ${crashed}` : ''}  ${cand.what}`,
    );
  }

  console.log('');
  console.log('  Paired against the control, per seed (a seed counts only');
  console.log("  when the two disagree — McNemar's discordant pairs):");
  console.log('');
  for (let c = 0; c < candidates.length; c++) {
    const mine = results.filter(
      r => r.candidate === c && r.record?.winner != null,
    );
    let won = 0;
    let lost = 0;
    for (const r of mine) {
      const ctl = controls.get(r.seed);
      if (!ctl || ctl.winner === null) continue;
      const advisedWon = r.record!.winner === r.candidateSeat;
      const ctlWon = ctl.winner === r.candidateSeat;
      if (advisedWon && !ctlWon) won++;
      if (!advisedWon && ctlWon) lost++;
    }
    const p = binomP(won, won + lost);
    console.log(
      `  ${candidates[c]!.label.padEnd(9)} flipped ${won} toward, ${lost} away` +
        `  ${won + lost === 0 ? '(nothing moved)' : `p = ${p.toFixed(3)}`}`,
    );
  }
  const ticks = results
    .filter(r => r.candidate < 0 && r.record)
    .map(r => r.record!.ticks)
    .sort((a, b) => a - b);
  const med = ticks.length ? ticks[Math.floor(ticks.length / 2)]! : 0;
  console.log('');
  console.log(
    `  CONTROLS  median ${med} ticks (${(med / 20 / 60).toFixed(1)} min) · ` +
      `shortest ${ticks[0] ?? 0} · longest ${ticks.at(-1) ?? 0}`,
  );
  console.log(`  ${((Date.now() - started) / 1000).toFixed(0)}s wall.`);
}

await main();
