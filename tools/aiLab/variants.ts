import {fileURLToPath} from 'node:url';
import {
  AI_STRATEGIES,
  type AiStrategy,
} from '../../src/sim/defs/aiStrategies.ts';
import * as AiStrategyId from '../../src/sim/defs/aiStrategyIdEnum.ts';
import * as BuildAnchorNs from '../../src/sim/defs/buildAnchorEnum.ts';
import * as BuildingTypeId from '../../src/sim/defs/buildingTypeIdEnum.ts';
import * as TechId from '../../src/sim/defs/techIdEnum.ts';
import * as UnitTypeId from '../../src/sim/defs/unitTypeIdEnum.ts';
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
    // What `evolve --lineage mason` promoted: +12.5 points against the
    // whole league on a holdout (31.7% vs 19.2%, 23 flips toward and 8
    // away, p = 0.011). Whether any of that lands against the STEWARD
    // specifically is a different question — the league is five playbooks
    // and the steward is the one the mason loses 158 in 160 to.
    label: 'champion',
    what: 'evolve champion — serfTarget 12→15, researchReserve 10→6',
    play: {...mason, serfTarget: 15, researchReserve: 6},
  },
  ...rushProof(),
];

/**
 * The mason, given something to fight a rush WITH.
 *
 * The diagnosis, measured: at tick 17,000 against a steward the mason has
 * pop 31 to the steward's 33 and fields six spearmen against nine
 * knights, having fielded nothing at all when the steward had four. It is
 * not short of people. It converts almost none of them into soldiers, and
 * the ones it converts are the cheap unit.
 *
 * The reason is one line of its plan: a single weaponsmith, twelfth in
 * priority, with `weaponMix: [0]` — every forge on spears. It cannot
 * field a knight because it never forges a sword. The steward runs
 * [1, 0], sword first.
 *
 * These are the three moves that have to happen together, which is
 * exactly why the search could not find them: swords alone with one late
 * forge arms nobody, a second forge alone still makes spears, and a
 * knight preference with no sword to carry falls through to the
 * spearman fallback. Every single step scores worse than the parent.
 */
function rushProof(): {label: string; what: string; play: AiStrategy}[] {
  const arms = {
    weaponMix: [1, 0],
    trainPreference: [UnitTypeId.knight, UnitTypeId.spearman],
    trainFallback: UnitTypeId.spearman,
  };
  const twoForges = mason.build.map(b =>
    b.type === BuildingTypeId.weaponsmith ? {...b, count: 2} : b,
  );
  // The forge moved up the priority list, to just behind the barracks it
  // arms. Order is priority rather than sequence, so this only matters on
  // the beats where both are affordable — which are the beats that decide
  // whether a sword exists before the first march.
  const at = twoForges.findIndex(b => b.type === BuildingTypeId.weaponsmith);
  const bar = twoForges.findIndex(b => b.type === BuildingTypeId.barracks);
  const early = [...twoForges];
  const [forge] = early.splice(at, 1);
  early.splice(bar + 1, 0, forge!);
  return [
    {
      label: 'swords',
      what: 'weaponMix [0]→[1,0], train knights — one forge still',
      play: {...mason, ...arms},
    },
    {
      label: 'swords+forge',
      what: 'swords, and a second weaponsmith',
      play: {...mason, ...arms, build: twoForges},
    },
    {
      label: 'swords+early',
      what: 'swords, two forges, and the forge up behind the barracks',
      play: {...mason, ...arms, build: early},
    },
    {
      label: 'the-lot',
      what: 'swords + two forges + forge early + champion serfTarget 15',
      play: {...mason, ...arms, build: early, serfTarget: 15},
    },
  ];
}

/** The mason, taught the bow. Two orderings, because archery has to come
 * out of the same research budget the monument's deepMining does: one
 * puts the towers first and the plinth late, the other the reverse. */
function towerVariants(): {label: string; what: string; play: AiStrategy}[] {
  const towerStep = {
    type: BuildingTypeId.guardTower,
    count: 2,
    anchor: BuildAnchorNs.base,
    after: TechId.archery,
    needs: BuildingTypeId.barracks,
  };
  // In front of the gold line: the two steps the mason exists for stay
  // last, so a tower can never starve the plinth it is there to protect.
  const at = mason.build.findIndex(b => b.type === BuildingTypeId.goldMine);
  const build = [
    ...mason.build.slice(0, at),
    towerStep,
    ...mason.build.slice(at),
  ];
  const arms = {
    weaponMix: [0, 2],
    trainPreference: [UnitTypeId.archer, UnitTypeId.spearman],
    trainFallback: UnitTypeId.spearman,
  };
  return [
    {
      label: 'towers-late',
      what: 'guard towers + bow, archery AFTER deepMining (plinth first)',
      play: {
        ...mason,
        ...arms,
        build,
        researchOrder: [
          TechId.soldiery,
          TechId.ironworking,
          TechId.deepMining,
          TechId.archery,
        ],
      },
    },
    {
      label: 'towers-first',
      what: 'guard towers + bow, archery BEFORE deepMining (survive first)',
      play: {
        ...mason,
        ...arms,
        build,
        researchOrder: [
          TechId.soldiery,
          TechId.ironworking,
          TechId.archery,
          TechId.deepMining,
        ],
      },
    },
    {
      label: 'towers+serfs',
      what: 'towers-first, plus the champion serfTarget 15',
      play: {
        ...mason,
        ...arms,
        build,
        serfTarget: 15,
        researchOrder: [
          TechId.soldiery,
          TechId.ironworking,
          TechId.archery,
          TechId.deepMining,
        ],
      },
    },
  ];
}

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
