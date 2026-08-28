/**
 * The behaviour-preservation harness.
 *
 * Optimising a deterministic sim is only safe if the sim still ticks
 * bit-identically afterwards — replays and saves rest on it (see
 * shared/replayVersion.test.ts). This plays a spread of AI matches and
 * prints a world hash every DIGEST_EVERY ticks, so a candidate change can
 * be diffed against the same run on the base revision:
 *
 *   git stash && node --experimental-strip-types tools/perf/digest.ts > /tmp/before.txt
 *   git stash pop && node --experimental-strip-types tools/perf/digest.ts > /tmp/after.txt
 *   diff /tmp/before.txt /tmp/after.txt && echo IDENTICAL
 *
 * Hashes at intervals rather than only at the end: a divergence that
 * cancels out by the final tick still means the sim moved, and the tick it
 * first shows up on is the one worth debugging.
 */
import { AiSeats } from '../../src/sim/aiSeats.ts';
import { hashWorld } from '../../src/sim/hash.ts';
import { tickWorld } from '../../src/sim/tick.ts';
import { createWorld } from '../../src/sim/world.ts';
import { AI_STRATEGY_ORDER } from '../../src/sim/defs/aiStrategies.ts';
import * as PlayerKind from '../../src/sim/playerKindEnum.ts';

const DIGEST_EVERY = 500;
const TICKS = Number(process.env.DIGEST_TICKS ?? 6000);

// A spread wide enough that a moved tie-break has somewhere to show up:
// several seeds, both map sizes, bandits on and off, every playbook pairing.
const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34];
const SIZES = [64, 96];

for (const size of SIZES) {
  for (const seed of SEEDS) {
    for (const bandits of [true, false]) {
      const a = AI_STRATEGY_ORDER[seed % AI_STRATEGY_ORDER.length]!;
      const b = AI_STRATEGY_ORDER[(seed + 1) % AI_STRATEGY_ORDER.length]!;
      const world = createWorld({
        seed,
        players: [
          { kind: PlayerKind.ai, strategy: a },
          { kind: PlayerKind.ai, strategy: b },
        ],
        banditsEnabled: bandits,
        mapSize: size,
      });
      const seats = new AiSeats(world);
      const tag = `size=${size} seed=${seed} bandits=${bandits ? 1 : 0} ${a}/${b}`;
      for (let t = 0; t < TICKS; t++) {
        tickWorld(world, seats.decide(world));
        if (world.tick % DIGEST_EVERY === 0) {
          console.log(`${tag} tick=${world.tick} hash=${hashWorld(world).toString(16)}`);
        }
      }
      console.log(
        `${tag} FINAL tick=${world.tick} hash=${hashWorld(world).toString(16)} ` +
          `units=${world.units.size} buildings=${world.buildings.size} jobs=${world.jobs.size}`,
      );
    }
  }
}
