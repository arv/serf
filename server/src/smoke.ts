/**
 * Proves the server process can run the simulation.
 *
 * The sim is plain TypeScript with no browser dependencies, and `src/sim`
 * spells out `.ts` on its relative imports, so Node loads it straight from
 * source — no build step, matching how the rest of this package runs. This
 * script is the guard on that arrangement: if someone adds a DOM import to
 * the sim, or an extensionless specifier, it stops loading here rather than
 * at match start in production.
 *
 *   pnpm --dir server smoke
 */
import { createWorld } from '../../src/sim/world.ts';
import { tickWorld } from '../../src/sim/tick.ts';
import { checkInvariants, checkLedger, countGoods } from '../../src/sim/debug/invariants.ts';

const TICKS = 1000;

const world = createWorld({
  seed: 7,
  players: [{ kind: 'human' }, { kind: 'ai' }],
  adminEnabled: false,
  banditsEnabled: true,
});
const initialGoods = countGoods(world);

const startedAt = process.hrtime.bigint();
for (let i = 0; i < TICKS; i++) tickWorld(world, []);
const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

const failures = [
  ...checkInvariants(world).violations,
  ...checkLedger(world, initialGoods),
];

if (world.tick !== TICKS) failures.push(`tick is ${world.tick}, expected ${TICKS}`);
if (world.units.size === 0) failures.push('no units survived');
if (world.buildings.size === 0) failures.push('no buildings survived');

const perTick = (elapsedMs / TICKS).toFixed(3);
console.log(
  `sim ran in node: ${TICKS} ticks in ${elapsedMs.toFixed(0)}ms (${perTick}ms/tick), ` +
    `${world.units.size} units, ${world.buildings.size} buildings`,
);

if (failures.length > 0) {
  console.error(`FAILED with ${failures.length} violation(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('OK');
