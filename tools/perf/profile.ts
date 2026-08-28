/**
 * Sim profiler: run a headless match and report where the tick budget goes.
 *
 * Two modes:
 *   default        per-system wall-clock, measured by wrapping each system
 *   --cpu-prof     just run the loop; let node's sampling profiler do it
 *
 * Usage:
 *   node --experimental-strip-types tools/perf/profile.ts [--ticks N] [--seed N] [--size N]
 */
import {AiSeats} from '../../src/sim/aiSeats.ts';
import * as AiStrategyId from '../../src/sim/defs/aiStrategyIdEnum.ts';
import * as PlayerKind from '../../src/sim/playerKindEnum.ts';
import {tickWorld} from '../../src/sim/tick.ts';
import {createWorld} from '../../src/sim/world.ts';

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
}

const TICKS = arg('ticks', 20000);
const SEED = arg('seed', 7);
const SIZE = arg('size', 96);

const world = createWorld({
  seed: SEED,
  players: [
    {kind: PlayerKind.ai, strategy: AiStrategyId.steward},
    {kind: PlayerKind.ai, strategy: AiStrategyId.warlord},
  ],
  banditsEnabled: true,
  mapSize: SIZE,
});
const seats = new AiSeats(world);

const t0 = process.hrtime.bigint();
let ticked = 0;
for (let i = 0; i < TICKS; i++) {
  const cmds = seats.decide(world);
  tickWorld(world, cmds);
  ticked++;
  if (!world.players.some(p => p.kind === PlayerKind.ai && p.alive)) break;
}
const t1 = process.hrtime.bigint();

const ms = Number(t1 - t0) / 1e6;
const units = world.units.size;
const buildings = world.buildings.size;
console.log(
  JSON.stringify(
    {
      seed: SEED,
      size: SIZE,
      ticks: ticked,
      totalMs: +ms.toFixed(1),
      msPerTick: +(ms / ticked).toFixed(4),
      ticksPerSec: Math.round((ticked / ms) * 1000),
      units,
      buildings,
      jobs: world.jobs.size,
    },
    null,
    2,
  ),
);
