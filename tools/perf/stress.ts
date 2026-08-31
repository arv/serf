/**
 * Sim stress profiler: a deliberately heavy valley, timed system by system.
 *
 * The AI bake-off matches stay small (30-ish units), so they measure the
 * quiet case. This one inflates a real generated world to late-game weight
 * — hundreds of serfs, a wide village, a live bandit war — and reports
 * where the tick budget actually goes.
 *
 * Usage:
 *   node --experimental-strip-types tools/perf/stress.ts [--ticks N] [--serfs N] [--size N]
 */

import {Rng} from '../../src/shared/rng.ts';
import * as BuildingState from '../../src/sim/buildingStateEnum.ts';
import * as AiStrategyId from '../../src/sim/defs/aiStrategyIdEnum.ts';
import {BUILDING_TYPES, buildingDef} from '../../src/sim/defs/buildings.ts';
import {GOODS} from '../../src/sim/defs/goods.ts';
import * as UnitTypeId from '../../src/sim/defs/unitTypeIdEnum.ts';
import {hashWorld} from '../../src/sim/hash.ts';
import * as PlayerKind from '../../src/sim/playerKindEnum.ts';
import {banditsSystem} from '../../src/sim/systems/bandits.ts';
import {combatSystem} from '../../src/sim/systems/combat.ts';
import {constructionSystem} from '../../src/sim/systems/construction.ts';
import {
  findStorehouse,
  logisticsSystem,
} from '../../src/sim/systems/logistics.ts';
import {movementSystem} from '../../src/sim/systems/movement.ts';
import {productionSystem} from '../../src/sim/systems/production.ts';
import {researchSystem} from '../../src/sim/systems/research.ts';
import {staffingSystem} from '../../src/sim/systems/staffing.ts';
import {trailsSystem} from '../../src/sim/systems/trails.ts';
import {trainingSystem, hiringSystem} from '../../src/sim/systems/training.ts';
import {victorySystem} from '../../src/sim/systems/victory.ts';
import {wanderSystem} from '../../src/sim/systems/wander.ts';
import {
  canPlace,
  createWorld,
  placeSite,
  spawnUnitNearby,
  type World,
} from '../../src/sim/world.ts';

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
}

const TICKS = arg('ticks', 3000);
const SERFS = arg('serfs', 220);
const SIZE = arg('size', 96);
const SEED = arg('seed', 7);

const world = createWorld({
  seed: SEED,
  players: [
    {kind: PlayerKind.human},
    {kind: PlayerKind.ai, strategy: AiStrategyId.warlord},
  ],
  banditsEnabled: true,
  mapSize: SIZE,
});

// Stock the storehouse so nothing starves the systems we want to measure.
const sh = findStorehouse(world, 0)!;
for (const g of GOODS) sh.stock[g] = 9999;

// A wide village: every non-system building type, sprinkled across the
// player's half until the map stops taking them.
const types = BUILDING_TYPES.filter(t => {
  const d = buildingDef(t);
  return !d.systemOnly && !d.storage && !d.isRoad;
});
const rng = new Rng(1234);
let placed = 0;
for (let attempt = 0; attempt < 4000 && placed < 90; attempt++) {
  const t = types[Math.floor(rng.next() * types.length)]!;
  const x = Math.floor(sh.x - 30 + rng.next() * 60);
  const y = Math.floor(sh.y - 30 + rng.next() * 60);
  if (!canPlace(world.map, t, x, y)) continue;
  const b = placeSite(world, t, 0, x, y);
  if (!b) continue;
  // Finish it outright: we are measuring the running village, not a site.
  b.state = BuildingState.built;
  b.siteNeeds = undefined;
  placed++;
}

for (let i = 0; i < SERFS; i++) {
  spawnUnitNearby(
    world,
    UnitTypeId.serf,
    0,
    sh.x + (i % 20) - 10,
    sh.y + Math.floor(i / 20) - 5,
  );
}
for (let i = 0; i < 40; i++) {
  spawnUnitNearby(
    world,
    UnitTypeId.knight,
    0,
    sh.x + (i % 10) - 5,
    sh.y + 12 + Math.floor(i / 10),
  );
}

const systems: [string, (w: World) => void][] = [
  ['research', researchSystem],
  ['production', w => productionSystem(w, new Rng(w.rngState))],
  ['logistics', logisticsSystem],
  ['construction', constructionSystem],
  ['staffing', staffingSystem],
  ['training', trainingSystem],
  ['hiring', hiringSystem],
  ['wander', w => wanderSystem(w, new Rng(w.rngState))],
  ['movement', movementSystem],
  ['combat', combatSystem],
  ['bandits', w => banditsSystem(w, new Rng(w.rngState))],
  ['trails', trailsSystem],
  ['victory', victorySystem],
];

// --hash turns this into a determinism probe instead of a stopwatch: the
// timing runs are the only thing that cares about per-system totals, and a
// heavy valley full of soldiers is the coverage the small AI matches in
// digest.ts cannot give the combat target-acquisition tie-breaks.
const HASH = process.argv.includes('--hash');

const totals = new Map<string, number>();
const t0 = process.hrtime.bigint();
for (let i = 0; i < TICKS; i++) {
  if (HASH) {
    for (const [, fn] of systems) fn(world);
    if (i % 100 === 0)
      console.log(`tick=${i} hash=${hashWorld(world).toString(16)}`);
  } else {
    for (const [name, fn] of systems) {
      const a = process.hrtime.bigint();
      fn(world);
      const b = process.hrtime.bigint();
      totals.set(name, (totals.get(name) ?? 0) + Number(b - a));
    }
  }
  // removeDead, inlined (not exported)
  for (const [id, u] of world.units)
    if (u.dead && u.deathTick === undefined) world.units.delete(id);
  for (const [id, b] of world.buildings) if (b.dead) world.buildings.delete(id);
  world.tick++;
}
const t1 = process.hrtime.bigint();

const totalMs = Number(t1 - t0) / 1e6;
const rows = [...totals.entries()]
  .map(([name, ns]) => ({
    system: name,
    ms: +(ns / 1e6).toFixed(1),
    pct: +((ns / 1e6 / totalMs) * 100).toFixed(1),
    usPerTick: +(ns / 1e3 / TICKS).toFixed(1),
  }))
  .sort((a, b) => b.ms - a.ms);

console.log(
  `world: ${world.units.size} units, ${world.buildings.size} buildings, ${world.jobs.size} jobs, ${SIZE}x${SIZE}`,
);
console.log(
  `${TICKS} ticks in ${totalMs.toFixed(0)}ms = ${(totalMs / TICKS).toFixed(3)} ms/tick\n`,
);
console.table(rows);
