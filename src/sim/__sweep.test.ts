import { it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { canPlace, createWorld, type World } from './world.ts';
import { tickWorld } from './tick.ts';
import { cmds } from './testUtils.ts';
import { AiBrain } from './systems/ai.ts';
import { AI_STRATEGIES, type AiStrategyId } from './defs/aiStrategies.ts';
import { strategyOf } from './defs/aiStrategies.ts';
import type { BuildingTypeId } from './defs/buildings.ts';
import type { SimCommand } from './commands.ts';

const OUT = '/tmp/sweep-results.txt';
const mode = process.env.SW_MODE!;
const seeds = process.env.SW_SEEDS!.split(',').map(Number);

function solo(seed: number, id: AiStrategyId, maxTicks: number): World {
  const world = createWorld({ seed, players: [{ kind: 'ai' }] });
  const brain = new AiBrain(0, AI_STRATEGIES[id], world.map.size);
  for (let t = 0; t < maxTicks && world.outcome.state === 'playing'; t++) {
    const commands = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    tickWorld(world, commands.map((cmd) => ({ playerId: 0, cmd })));
  }
  return world;
}

it(`sweep ${mode}`, () => {
  for (const seed of seeds) {
    if (mode.startsWith('solo-')) {
      const id = mode.slice(5) as AiStrategyId;
      const w = solo(seed, id, 45_000);
      appendFileSync(OUT, `${mode} seed=${seed}: ${JSON.stringify(w.outcome)} tick=${w.tick}\n`);
    } else if (mode === 'aivai') {
      const world = createWorld({ seed, players: [{ kind: 'ai' }, { kind: 'ai' }], banditsEnabled: false });
      const brains = world.players.map((p) => new AiBrain(p.id, strategyOf(p.strategy), world.map.size));
      for (let t = 0; t < 90_000 && world.outcome.state === 'playing'; t++) {
        const commands = [];
        for (const brain of brains) {
          if (!brain.shouldDecide(world.tick)) continue;
          for (const cmd of brain.decide(world)) commands.push({ playerId: brain.playerId, cmd });
        }
        tickWorld(world, commands);
      }
      appendFileSync(OUT, `aivai seed=${seed}: ${JSON.stringify(world.outcome)} tick=${world.tick}\n`);
    } else if (mode === 'rival') {
      // Mission 6 shape: seat 0 ai (dealt), seat 1 steward, bandits on.
      const world = createWorld({
        seed,
        players: [{ kind: 'ai' }, { kind: 'ai', strategy: 'steward' }],
        banditsEnabled: true,
      });
      const brains = world.players.map((p) => new AiBrain(p.id, strategyOf(p.strategy), world.map.size));
      for (let t = 0; t < 90_000 && world.outcome.state === 'playing'; t++) {
        const commands = [];
        for (const brain of brains) {
          if (!brain.shouldDecide(world.tick)) continue;
          for (const cmd of brain.decide(world)) commands.push({ playerId: brain.playerId, cmd });
        }
        tickWorld(world, commands);
      }
      appendFileSync(OUT, `rival seed=${seed}: ${JSON.stringify(world.outcome)} tick=${world.tick}\n`);
    } else if (mode === 'clearing') {
      const world = createWorld({ seed, players: [{ kind: 'human' }], banditsEnabled: false, mission: 'clearing' });
      const keep = [...world.buildings.values()].find((b) => b.type === 'storehouse')!;
      const castle = { x: keep.x + 1, y: keep.y + 1 };
      const findSpot = (type: BuildingTypeId): { x: number; y: number } | null => {
        for (let r = 0; r < 16; r++) {
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
              if (canPlace(world.map, type, castle.x + dx, castle.y + dy)) {
                return { x: castle.x + dx, y: castle.y + dy };
              }
            }
          }
        }
        return null;
      };
      let ok = true;
      for (const t of ['woodcutter', 'quarry', 'house'] as const) {
        const spot = findSpot(t);
        if (!spot) { ok = false; break; }
        tickWorld(world, cmds({ kind: 'placeBuilding', building: t, x: spot.x, y: spot.y } as SimCommand));
      }
      if (ok) {
        let hired = false;
        for (let t = 0; t < 36_000 && world.outcome.state === 'playing'; t++) {
          if (!hired) {
            const built = [...world.buildings.values()].some((b) => !b.dead && b.state === 'built' && b.type === 'house');
            if (built) {
              tickWorld(world, cmds({ kind: 'hireSerf' }, { kind: 'hireSerf' }, { kind: 'hireSerf' }, { kind: 'hireSerf' }, { kind: 'hireSerf' }));
              hired = true;
              continue;
            }
          }
          tickWorld(world, []);
        }
      }
      appendFileSync(OUT, `clearing seed=${seed}: ${JSON.stringify(world.outcome)} tick=${world.tick}\n`);
    }
  }
}, 3_000_000);
