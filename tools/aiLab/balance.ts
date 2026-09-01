/**
 * The balance sweep: every playbook, many seeds, one table.
 *
 *   node --experimental-strip-types tools/aiLab/balance.ts [seeds] [offset]
 *                                                            [--difficulty x]
 *
 * Each run is one playbook alone on its own campaign map — the same drive
 * winnable.test.ts does, which is the game's own definition of "can this be
 * won". What the suite cannot do is tell a real change from a lucky seed,
 * and that is the whole reason this exists: a single campaign is cheap
 * (about a second) but wildly noisy, and balance questions are decided in
 * the aggregate or not at all.
 *
 * Read it with the noise in mind. A two- or three-win move over 32 seeds is
 * nothing; the way to know is to re-run on a different `offset` and see
 * whether the result survives — several plausible changes have died exactly
 * there, having looked like gains on the range they were tuned against.
 * Tune on one range, believe it only after another.
 *
 * `--difficulty easy|normal|hard` runs every playbook at one tier, which is
 * how the tiers themselves are calibrated. The instrument suits the
 * question: a tier is a change to ONE seat's strength, and this sweep asks
 * exactly how often that seat takes the map and how fast, against an
 * opponent — the ground and the bandits — that is identical at every
 * setting. (The mirrored bake-off is the instrument for seat-versus-seat,
 * and it does not carry a tier yet.) Read the result the way every other
 * number here is read: on two ranges, or not at all.
 */
import type {Enum} from '../../src/shared/enum.ts';
import {
  AI_STRATEGIES,
  type AiStrategyId,
  AI_STRATEGY_KEYS,
  AI_STRATEGY_ORDER,
} from '../../src/sim/defs/aiStrategies.ts';
import * as BuildingTypeId from '../../src/sim/defs/buildingTypeIdEnum.ts';
import {
  DIFFICULTY_KEYS,
  type DifficultyId,
  parseDifficultyId,
} from '../../src/sim/defs/difficulty.ts';
import * as UnitTypeId from '../../src/sim/defs/unitTypeIdEnum.ts';
import * as MatchState from '../../src/sim/matchStateEnum.ts';
import * as PlayerKind from '../../src/sim/playerKindEnum.ts';
import {AiBrain} from '../../src/sim/systems/ai.ts';
import {tickWorld} from '../../src/sim/tick.ts';
import {createWorld} from '../../src/sim/world.ts';

type UnitTypeId = Enum<typeof UnitTypeId>;

/** Long enough that a seat which is going to win has, and a stalled one is
 * visibly stalled rather than merely slow. */
const MAX_TICKS = 60_000;
/** Tower state is sampled rather than read off the end: a levy that held a
 * wall through a raid and was relieved leaves no trace in the final world. */
const SAMPLE_EVERY = 40;

interface Run {
  outcome: 'win' | 'dead' | 'timeout';
  tick: number;
  towers: number;
  manned: number;
  levyTicks: number;
  pop: number;
  army: number;
}

const SOLDIERS = new Set<UnitTypeId>([
  UnitTypeId.knight,
  UnitTypeId.spearman,
  UnitTypeId.archer,
]);

function playCampaign(
  id: AiStrategyId,
  seed: number,
  difficulty: DifficultyId | undefined,
): Run {
  // The seat names its playbook rather than being dealt one, so the world's
  // record of what it is playing agrees with the brain actually playing it.
  // Nothing downstream reads that record today — the economy rules take
  // their strategy from the brain — but a sweep whose world disagrees with
  // itself is a trap for whatever reads it next. Safe for the numbers:
  // dealStrategies is a pure function of the seed and runs before the
  // world's Rng is constructed, so naming a playbook cannot move the map.
  // The tier rides the seat, as it does in the game — the world deals it
  // down and the brain reads it back. Not a mission, so nothing about the
  // opening is scaled: what this sweep measures is the seat playing better
  // or worse, never a seat that was handed more.
  const world = createWorld({
    seed,
    difficulty,
    players: [{kind: PlayerKind.ai, strategy: id}],
  });
  const brain = new AiBrain(0, AI_STRATEGIES[id], world.map.size, difficulty);
  let levyTicks = 0;
  for (
    let t = 0;
    t < MAX_TICKS && world.outcome.state === MatchState.playing;
    t++
  ) {
    const commands = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    tickWorld(
      world,
      commands.map(cmd => ({playerId: 0, cmd})),
    );
    if (world.tick % SAMPLE_EVERY !== 0) continue;
    for (const b of world.buildings.values()) {
      if (b.dead || b.owner !== 0 || b.garrisonKind !== UnitTypeId.serf)
        continue;
      levyTicks += SAMPLE_EVERY;
      break;
    }
  }
  const towers = [...world.buildings.values()].filter(
    b => !b.dead && b.owner === 0 && b.type === BuildingTypeId.guardTower,
  );
  const mine = [...world.units.values()].filter(u => !u.dead && u.owner === 0);
  const state = world.outcome.state;
  const winner = (world.outcome as {winner?: number}).winner;
  return {
    outcome:
      state === MatchState.playing ? 'timeout' : winner === 0 ? 'win' : 'dead',
    tick: world.tick,
    towers: towers.length,
    manned: towers.filter(b => (b.garrison ?? 0) > 0).length,
    levyTicks,
    pop: mine.length,
    army: mine.filter(u => SOLDIERS.has(u.kind)).length,
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

function intArg(
  raw: string | undefined,
  fallback: number,
  name: string,
  min: number,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    console.error(
      `${name} must be a whole number >= ${min} (got ${JSON.stringify(raw)})\n` +
        'usage: balance.ts [seeds] [offset]',
    );
    process.exit(2);
  }
  return n;
}

// Validated rather than coerced: Number('x') is NaN, and a NaN count runs
// zero campaigns and prints a table of NaN medians that looks like a result.
const argv = process.argv.slice(2);
const tierAt = argv.indexOf('--difficulty');
const tierRaw = tierAt >= 0 ? argv[tierAt + 1] : undefined;
const difficulty =
  tierRaw === undefined ? undefined : parseDifficultyId(tierRaw);
if (tierAt >= 0 && difficulty === undefined) {
  console.error(
    `--difficulty wants one of ${Object.values(DIFFICULTY_KEYS).join(', ')}` +
      ` (got ${JSON.stringify(tierRaw)})`,
  );
  process.exit(2);
}
const positional = argv.filter(
  (a, i) => i !== tierAt && i !== tierAt + 1 && !a.startsWith('--'),
);
const count = intArg(positional[0], 32, 'seeds', 1);
const offset = intArg(positional[1], 101, 'offset', 0);
// Strided rather than consecutive: neighbouring seeds can generate valleys
// that rhyme, and a sweep wants independent maps.
const seeds = Array.from({length: count}, (_, i) => offset + i * 7);
const ids: readonly AiStrategyId[] = AI_STRATEGY_ORDER;

const tierLabel = difficulty ? DIFFICULTY_KEYS[difficulty] : 'normal';
console.log(
  `${count} seeds from ${offset}, ${MAX_TICKS} ticks each, difficulty ${tierLabel}\n`,
);
const everyWin: number[] = [];
let wins = 0;
let runs = 0;
for (const id of ids) {
  const res = seeds.map(s => playCampaign(id, s, difficulty));
  const won = res.filter(r => r.outcome === 'win');
  everyWin.push(...won.map(r => r.tick));
  wins += won.length;
  runs += res.length;
  console.log(
    `${AI_STRATEGY_KEYS[id].padEnd(9)} win ${String(won.length).padStart(2)}/${res.length}` +
      `  median ${String(median(won.map(r => r.tick))).padStart(6)}` +
      `  dead ${res.filter(r => r.outcome === 'dead').length}` +
      `  timeout ${res.filter(r => r.outcome === 'timeout').length}` +
      `  pop ${mean(res.map(r => r.pop)).toFixed(1)}` +
      `  army ${mean(res.map(r => r.army)).toFixed(1)}` +
      `  towers ${mean(res.map(r => r.towers)).toFixed(1)}` +
      `  levyTicks ${Math.round(mean(res.map(r => r.levyTicks)))}`,
  );
}
console.log(`\nTOTAL     win ${wins}/${runs}  median ${median(everyWin)}`);
