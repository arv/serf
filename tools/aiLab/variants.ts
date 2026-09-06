import {fileURLToPath} from 'node:url';
import {
  AI_STRATEGIES,
  type AiStrategy,
} from '../../src/sim/defs/aiStrategies.ts';
import * as AiStrategyId from '../../src/sim/defs/aiStrategyIdEnum.ts';
import * as PostureId from '../../src/sim/defs/postureIdEnum.ts';
import * as TechId from '../../src/sim/defs/techIdEnum.ts';
import type {Owner} from '../../src/sim/entities.ts';
import {intArg} from './args.ts';
import {runMatchChild} from './childRun.ts';
import {wonByMonument} from './probe.ts';
import type {ProbeTask} from './probeWorker.ts';

/**
 * Playbook variants, head to head against one printed opponent.
 *
 * The probe steers a seat with ADVICE, which reaches only the knobs on the
 * advice whitelist — so a question about a playbook's stance cascade, its
 * research order or its build list cannot be asked there at all. This asks
 * those, through the base-playbook seam instead (MatchConfig.playbooks):
 * a whole AiStrategy goes in as a seat's printed line, with the stance
 * engine and the difficulty tier composing over it exactly as they do over
 * a shipped one.
 *
 * Both seatings of every seed, so the map's head start is worn by each side
 * equally. The rate is NOT nulled at 50% — two different playbooks carry
 * whatever gap there is between them — so read it as a level against the
 * baseline row, which is the same variant question asked of the printed
 * line.
 */

const WORKER = `${fileURLToPath(new URL('.', import.meta.url))}probeWorker.ts`;

const mason = AI_STRATEGIES[AiStrategyId.mason];

/** The variants, each a whole playbook the seat plays as its own. */
const VARIANTS: {label: string; what: string; play: AiStrategy}[] = [
  {label: 'printed', what: 'the mason as shipped', play: mason},
  {
    label: 'contest',
    what: 'found: fortify → muster (build an army instead of recalling one)',
    play: {
      ...mason,
      stances: {...mason.stances, found: {posture: PostureId.muster}},
    },
  },
  {
    // `found` is required by the playbook format — a seat must have a mood
    // for "a rival castle is on the map" — so the nearest thing to not
    // reacting is to keep growing rather than to recall the army.
    label: 'keep-growing',
    what: 'found: fortify → expand (build on rather than recall)',
    play: {
      ...mason,
      stances: {...mason.stances, found: {posture: PostureId.expand}},
    },
  },
  {
    label: 'deep-first',
    what: 'deepMining 4th → 3rd, ahead of cobbledBoots',
    play: {
      ...mason,
      researchOrder: [
        TechId.soldiery,
        TechId.ironworking,
        TechId.deepMining,
        TechId.cobbledBoots,
      ],
    },
  },
  {
    label: 'contest+deep',
    what: 'both of the above',
    play: {
      ...mason,
      stances: {...mason.stances, found: {posture: PostureId.muster}},
      researchOrder: [
        TechId.soldiery,
        TechId.ironworking,
        TechId.deepMining,
        TechId.cobbledBoots,
      ],
    },
  },
];

function arg(flag: string, fallback: number, min = 1): number {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  const raw = process.argv[i + 1];
  if (raw === undefined || raw.startsWith('--'))
    throw new Error(`${flag} wants a value`);
  const n = intArg(raw, fallback, min);
  if (n === null) throw new Error(`${flag} wants a whole number >= ${min}`);
  return n;
}

async function main(): Promise<void> {
  const seedCount = arg('--seeds', 40);
  const seedStart = arg('--seed-start', 41, 0);
  const jobs = arg('--jobs', 4);
  const seeds = Array.from({length: seedCount}, (_, i) => i + seedStart);
  const opponent = AI_STRATEGIES[AiStrategyId.steward];

  type Trial = {variant: number; seed: number; seat: Owner};
  const trials: Trial[] = [];
  for (let v = 0; v < VARIANTS.length; v++) {
    for (const seed of seeds) {
      trials.push({variant: v, seed, seat: 0 as Owner});
      trials.push({variant: v, seed, seat: 1 as Owner});
    }
  }
  console.log(
    `variants: ${VARIANTS.length} × ${seeds.length} seeds × 2 seatings = ` +
      `${trials.length} matches vs ${opponent.name}, jobs ${jobs}\n`,
  );

  const wins = VARIANTS.map(() => 0);
  const decided = VARIANTS.map(() => 0);
  const monument = VARIANTS.map(() => 0);
  const ticks: number[][] = VARIANTS.map(() => []);
  let next = 0;
  let done = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({length: jobs}, async () => {
      for (;;) {
        const i = next++;
        if (i >= trials.length) return;
        const t = trials[i]!;
        const play = VARIANTS[t.variant]!.play;
        const task: ProbeTask = {
          config: {
            seed: t.seed,
            mapSize: 96,
            bandits: true,
            strategies: [AiStrategyId.mason, AiStrategyId.steward],
            playbooks: t.seat === 0 ? [play, opponent] : [opponent, play],
            maxTicks: 120_000,
            advicePeriod: 1800,
            adviceStagger: 300,
            latencyTicks: 0,
          },
          specs: [null, null],
        };
        const rec = await runMatchChild(WORKER, task, 300_000);
        if (rec && rec.decided && rec.winner !== null) {
          decided[t.variant]!++;
          ticks[t.variant]!.push(rec.ticks);
          if (rec.winner === t.seat) wins[t.variant]!++;
          if (wonByMonument(rec)) monument[t.variant]!++;
        }
        if (++done % 40 === 0)
          process.stderr.write(`  ${done}/${trials.length}\n`);
      }
    }),
  );

  console.log(
    `MASON VARIANTS vs ${opponent.name}, seeds ${seeds[0]}-${seeds.at(-1)}`,
  );
  console.log('');
  console.log('  variant       wins/dec    rate   monWins  median ticks  what');
  for (let v = 0; v < VARIANTS.length; v++) {
    const sorted = [...ticks[v]!].sort((a, b) => a - b);
    const med = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
    console.log(
      `  ${VARIANTS[v]!.label.padEnd(13)} ${String(wins[v]).padStart(3)}/${String(decided[v]).padEnd(4)}` +
        ` ${((100 * wins[v]!) / (decided[v] || 1)).toFixed(1).padStart(6)}%` +
        ` ${String(monument[v]).padStart(6)}   ${String(med).padStart(9)}  ${VARIANTS[v]!.what}`,
    );
  }
  console.log(`\n  ${((Date.now() - started) / 1000).toFixed(0)}s wall.`);
}

await main();
