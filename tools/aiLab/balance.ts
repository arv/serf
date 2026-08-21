/**
 * The balance sweep: every playbook, many seeds, one table.
 *
 *   node --experimental-strip-types tools/aiLab/balance.ts [seeds] [offset]
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
 */
import { createWorld } from '../../src/sim/world.ts';
import { tickWorld } from '../../src/sim/tick.ts';
import { AiBrain } from '../../src/sim/systems/ai.ts';
import { AI_STRATEGIES, type AiStrategyId } from '../../src/sim/defs/aiStrategies.ts';

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

const SOLDIERS = new Set(['knight', 'spearman', 'archer']);

function playCampaign(id: AiStrategyId, seed: number): Run {
  const world = createWorld({ seed, players: [{ kind: 'ai' }] });
  const brain = new AiBrain(0, AI_STRATEGIES[id], world.map.size);
  let levyTicks = 0;
  for (let t = 0; t < MAX_TICKS && world.outcome.state === 'playing'; t++) {
    const commands = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    tickWorld(
      world,
      commands.map((cmd) => ({ playerId: 0, cmd })),
    );
    if (world.tick % SAMPLE_EVERY !== 0) continue;
    for (const b of world.buildings.values()) {
      if (b.dead || b.owner !== 0 || b.garrisonKind !== 'serf') continue;
      levyTicks += SAMPLE_EVERY;
      break;
    }
  }
  const towers = [...world.buildings.values()].filter(
    (b) => !b.dead && b.owner === 0 && b.type === 'guardTower',
  );
  const mine = [...world.units.values()].filter((u) => !u.dead && u.owner === 0);
  const state = world.outcome.state;
  const winner = (world.outcome as { winner?: number }).winner;
  return {
    outcome: state === 'playing' ? 'timeout' : winner === 0 ? 'win' : 'dead',
    tick: world.tick,
    towers: towers.length,
    manned: towers.filter((b) => (b.garrison ?? 0) > 0).length,
    levyTicks,
    pop: mine.length,
    army: mine.filter((u) => SOLDIERS.has(u.kind)).length,
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const count = Number(process.argv[2] ?? 32);
const offset = Number(process.argv[3] ?? 101);
// Strided rather than consecutive: neighbouring seeds can generate valleys
// that rhyme, and a sweep wants independent maps.
const seeds = Array.from({ length: count }, (_, i) => offset + i * 7);
const ids = Object.keys(AI_STRATEGIES) as AiStrategyId[];

console.log(`${count} seeds from ${offset}, ${MAX_TICKS} ticks each\n`);
const everyWin: number[] = [];
let wins = 0;
let runs = 0;
for (const id of ids) {
  const res = seeds.map((s) => playCampaign(id, s));
  const won = res.filter((r) => r.outcome === 'win');
  everyWin.push(...won.map((r) => r.tick));
  wins += won.length;
  runs += res.length;
  console.log(
    `${id.padEnd(9)} win ${String(won.length).padStart(2)}/${res.length}` +
      `  median ${String(median(won.map((r) => r.tick))).padStart(6)}` +
      `  dead ${res.filter((r) => r.outcome === 'dead').length}` +
      `  timeout ${res.filter((r) => r.outcome === 'timeout').length}` +
      `  pop ${mean(res.map((r) => r.pop)).toFixed(1)}` +
      `  army ${mean(res.map((r) => r.army)).toFixed(1)}` +
      `  towers ${mean(res.map((r) => r.towers)).toFixed(1)}` +
      `  levyTicks ${Math.round(mean(res.map((r) => r.levyTicks)))}`,
  );
}
console.log(`\nTOTAL     win ${wins}/${runs}  median ${median(everyWin)}`);
