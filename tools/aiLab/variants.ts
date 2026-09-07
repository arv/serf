import {fileURLToPath} from 'node:url';
import {
  AI_STRATEGIES,
  type AiStrategy,
} from '../../src/sim/defs/aiStrategies.ts';
import * as AiStrategyId from '../../src/sim/defs/aiStrategyIdEnum.ts';
import * as UnitTypeId from '../../src/sim/defs/unitTypeIdEnum.ts';
import type {Owner} from '../../src/sim/entities.ts';
import {intArg} from './args.ts';
import {runMatchChild} from './childRun.ts';
import {byKey, valueOf, wonByMonument} from './probe.ts';
import type {ProbeTask} from './probeWorker.ts';

/**
 * Playbook variants, head to head against one printed opponent.
 *
 * The probe steers a seat with ADVICE, which reaches only the knobs on the
 * advice whitelist — so a question about a playbook's stance cascade, its
 * research order or its build list cannot be asked there at all. This asks
 * those, through the base-playbook seam instead (a whole AiStrategy as a
 * seat in `MatchConfig.seats`):
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
  {
    label: 'shipped',
    what: 'the mason as it now stands — swords, knights first',
    play: mason,
  },
  {
    // The line it replaced, rebuilt here so the comparison survives the
    // change having shipped: `mason` above now reads the new numbers.
    label: 'old-spears',
    what: 'the mason before — weaponMix [0], spearmen only',
    play: {
      ...mason,
      weaponMix: [0],
      trainPreference: [UnitTypeId.spearman],
      trainFallback: UnitTypeId.spearman,
    },
  },
];

/**
 * The mason, armed with what actually counters a steward, and fed enough
 * to field it.
 *
 * Two measurements set this up. First, at tick 16,000 the mason holds
 * FIVE swords and no food and fields two knights, while a steward holds
 * two swords and fields six: a knight costs 3 food and 1 sword, so the
 * sword line unblocked the forge and the larder became the ceiling. That
 * same shortage gated its monument, so the mason has ONE bottleneck and
 * it caps the army and the win condition together.
 *
 * Second, the counter triangle (defs/units.ts COUNTER_TABLE): heavy beats
 * light 1.5, light catches ranged 1.5, ranged kites heavy 1.5. The
 * steward fields knights — heavy. The mason fields spearmen — light,
 * which takes 0.67 into heavy. It was not merely outnumbered; it was
 * fielding the class that loses WORST to what was coming. Swords moved it
 * to a neutral 1.0 and won ten times as often. Archers are 1.5 into
 * knights, better still — but light catches ranged, so an unscreened
 * archer is run down, and the mixed line is the one with an answer to
 * both.
 *
 * An earlier tower arm measured nothing, and that null does not stand: it
 * was run before the food ceiling was found, with no screen in front of
 * the bows, and with archery competing against deepMining for the same
 * research. Every military option was capped by the same shortage.
 */

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
  const vsRaw = valueOf(process.argv, '--vs');
  const vsId = byKey(vsRaw ?? 'steward');
  const opponent = AI_STRATEGIES[vsId];

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
            // One expression, so `--vs warlord` cannot record a steward
            // in seat 1 the way it once did: each entry is the playbook
            // itself and the lineage is read off its `id`. This is where
            // the two-array version was wrong twice (see MatchConfig).
            seats: t.seat === 0 ? [play, opponent] : [opponent, play],
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
