import { describe, expect, it } from 'vitest';
import { cmds } from './testUtils';
import { TILE_COUNT, tileX, tileY } from '../shared/grid';
import { createWorld, canPlace, type World } from './world';
import { tickWorld } from './tick';
import { TileResource } from './map';
import { TECH_DEFS, type TechId } from './defs/techs';
import { BUILDING_DEFS, type BuildingTypeId } from './defs/buildings';
import { HIRE_SERF_COST } from './defs/balance';
import type { SimCommand } from './commands';
import type { Building } from './entities';

/**
 * THE playtest: a scripted player wins the campaign on the default map using
 * only legitimate commands — build the economy, research, arm a squad,
 * defend against raids, raze the bandit camp. If balance changes ever make
 * the game unwinnable, this fails.
 */

const MILITARY = new Set(['samurai', 'ashigaru', 'archer']);

function buildings(world: World): Building[] {
  return [...world.buildings.values()].filter((b) => !b.dead && b.owner === 0);
}

function has(world: World, type: BuildingTypeId): boolean {
  return buildings(world).some((b) => b.type === type);
}

function storehouse(world: World): Building {
  return buildings(world).find((b) => b.type === 'storehouse')!;
}

function requireCost(type: BuildingTypeId): Record<string, number> {
  return BUILDING_DEFS[type].cost as Record<string, number>;
}

/**
 * Nearest placeable footprint origin around a point (spiral search) that
 * also keeps a one-tile gap from every other building — packing tighter can
 * seal a neighbor's doorway and strangle its deliveries.
 */
function findSpot(world: World, type: BuildingTypeId, cx: number, cy: number, maxR = 14) {
  const def = BUILDING_DEFS[type];
  const spaced = (x: number, y: number): boolean => {
    for (let ty = y - 1; ty < y + def.h + 1; ty++) {
      for (let tx = x - 1; tx < x + def.w + 1; tx++) {
        if (tx < 0 || ty < 0 || tx >= 64 || ty >= 64) continue;
        if (world.map.buildingAt[ty * 64 + tx]! >= 0) return false;
      }
    }
    return true;
  };
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (canPlace(world.map, type, x, y) && spaced(x, y)) return { x, y };
      }
    }
  }
  return null;
}

/** Nearest tile with a given resource to a point. */
function nearestResource(world: World, code: number, cx: number, cy: number) {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < TILE_COUNT; i++) {
    if (world.map.resource[i] !== code || world.map.resourceAmt[i]! <= 0) continue;
    const d = Math.abs(tileX(i) - cx) + Math.abs(tileY(i) - cy);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

describe('the campaign is winnable', () => {
  it('a scripted player beats the default map', () => {
    const world = createWorld(20260724);
    const sh = storehouse(world);
    const baseX = sh.x + 1;
    const baseY = sh.y + 1;

    const researchOrder: TechId[] = ['bushido', 'strawSandals', 'ironworking'];
    let lastAttackTick = -10_000;
    let lastRallyTick = 0;
    let attacking = false;

    /** Standing count incl. construction sites — the bot rebuilds losses. */
    const countOf = (type: BuildingTypeId): number =>
      buildings(world).filter((b) => b.type === type).length;

    const MAX_TICKS = 45_000; // ~37 minutes of game time
    for (let t = 0; t < MAX_TICKS; t++) {
      const commands: SimCommand[] = [];

      if (t % 20 === 0 && world.outcome.state === 'playing') {
        const stock = storehouse(world).stock;

        // --- Build order: desired counts vs standing counts ----------------
        // Rebuilds anything raiders destroy; a 2nd bamboo hut joins once the
        // smith economy starts drinking bamboo.
        const iron = world.players[0]!.techs.researched.includes('ironworking');
        const wants: [BuildingTypeId, number, { x: number; y: number } | null][] = [];
        const grove = nearestResource(world, TileResource.Bamboo, baseX, baseY);
        if (grove >= 0) {
          wants.push([
            'bambooHut',
            iron ? 2 : 1,
            findSpot(world, 'bambooHut', tileX(grove), tileY(grove), 6),
          ]);
        }
        const rocks = nearestResource(world, TileResource.Rock, baseX, baseY);
        if (rocks >= 0) {
          wants.push(['quarry', 1, findSpot(world, 'quarry', tileX(rocks), tileY(rocks), 6)]);
        }
        wants.push(['terakoya', 1, findSpot(world, 'terakoya', baseX, baseY)]);
        // Defense before economic width: dojo the moment Bushidō lands.
        if (world.players[0]!.techs.researched.includes('bushido')) {
          wants.push(['dojo', 1, findSpot(world, 'dojo', baseX, baseY)]);
        }
        wants.push(['well', 1, findSpot(world, 'well', baseX, baseY)]);
        wants.push(['ricePaddy', 1, findSpot(world, 'ricePaddy', baseX, baseY)]);
        // Silver funds hires + late research; build it after the army core.
        if (has(world, 'dojo')) {
          const silverSeam = nearestResource(world, TileResource.SilverDep, baseX, baseY);
          if (silverSeam >= 0) {
            wants.push([
              'silverMine',
              1,
              findSpot(world, 'silverMine', tileX(silverSeam), tileY(silverSeam), 4),
            ]);
          }
        }
        if (iron) {
          const seam = nearestResource(world, TileResource.IronDep, baseX, baseY);
          if (seam >= 0) {
            wants.push(['ironMine', 1, findSpot(world, 'ironMine', tileX(seam), tileY(seam), 4)]);
          }
          wants.push(['spearmaker', 1, findSpot(world, 'spearmaker', baseX, baseY)]);
          wants.push(['swordsmith', 1, findSpot(world, 'swordsmith', baseX, baseY)]);
        }

        for (const [type, desired, spot] of wants) {
          if (!spot || countOf(type) >= desired) continue;
          const cost = requireCost(type);
          const ok = Object.entries(cost).every(
            ([good, n]) => ((stock as Record<string, number>)[good] ?? 0) >= n,
          );
          if (ok) {
            commands.push({ kind: 'placeBuilding', building: type, x: spot.x, y: spot.y });
            break; // one placement per decision to keep hauling focused
          }
        }

        // --- Population: keep loose serfs around ---------------------------
        // Staffing and soldiering both consume serfs, but research bills come
        // first: no hiring until Bushidō is in, then hire with a reserve.
        const serfCount = [...world.units.values()].filter(
          (u) => !u.dead && u.kind === 'serf',
        ).length;
        const researchPending = researchOrder.some(
          (id) => !world.players[0]!.techs.researched.includes(id),
        );
        // Survival floor: below 3 serfs the economy is one raid from an
        // absorbing death spiral (no haulers -> no silver -> no hires), so
        // hire at any price. Otherwise grow the pool post-Bushidō with a
        // silver reserve for research bills.
        if (serfCount < 3 && (stock.silver ?? 0) >= HIRE_SERF_COST) {
          commands.push({ kind: 'hireSerf' });
        } else if (
          world.players[0]!.techs.researched.includes('bushido') &&
          serfCount < 8 &&
          (stock.silver ?? 0) >= HIRE_SERF_COST + (researchPending ? 10 : 0)
        ) {
          commands.push({ kind: 'hireSerf' });
        }

        // --- Research queue -------------------------------------------------
        if (!world.players[0]!.techs.active) {
          const next = researchOrder.find((id) => !world.players[0]!.techs.researched.includes(id));
          if (next && has(world, 'terakoya')) {
            const cost = TECH_DEFS[next].cost;
            const ok = Object.entries(cost).every(
              ([good, n]) => ((stock as Record<string, number>)[good] ?? 0) >= (n ?? 0),
            );
            if (ok) commands.push({ kind: 'research', tech: next });
          }
        }

        // --- Keep the dojo queue warm --------------------------------------
        // Train what the weapon economy can actually feed: samurai only when
        // a katana exists somewhere; spears otherwise.
        const dojo = buildings(world).find((b) => b.type === 'dojo' && b.state === 'built');
        if (dojo && (dojo.trainQueue?.length ?? 0) < 2) {
          const katanaAround =
            (stock.katana ?? 0) + (dojo.inputs.katana ?? 0) + (dojo.inbound.katana ?? 0) > 0;
          commands.push({
            kind: 'trainUnit',
            buildingId: dojo.id,
            unit: katanaAround ? 'samurai' : 'ashigaru',
          });
        }

        // --- Army: rally at home until strong, then raze the camp ----------
        const army = [...world.units.values()].filter(
          (u) => !u.dead && u.owner === 0 && MILITARY.has(u.kind),
        );
        const camp = [...world.buildings.values()].find(
          (b) => !b.dead && b.type === 'banditCamp',
        );
        if (camp && army.length >= 7 && t - lastAttackTick > 900) {
          attacking = true;
          lastAttackTick = t;
          commands.push({
            kind: 'moveUnits',
            unitIds: army.map((u) => u.id),
            x: camp.x + 1,
            y: camp.y + 1,
          });
        } else if (!attacking && army.length > 0 && t - lastRallyTick > 400) {
          // Garrison duty: stand by the storehouse so auto-acquire covers it.
          lastRallyTick = t;
          const idle = army.filter((u) => u.task.t === 'idle');
          if (idle.length > 0) {
            commands.push({
              kind: 'moveUnits',
              unitIds: idle.map((u) => u.id),
              x: baseX,
              y: baseY + 4,
            });
          }
        }
      }

      tickWorld(world, cmds(...commands));
      if (world.outcome.state !== 'playing') break;
    }

    // The one assertion that matters.
    expect(world.outcome, `ended at tick ${world.tick}`).toEqual({ state: 'over', winner: 0 });
    // And it should be winnable within a reasonable session.
    expect(world.tick).toBeLessThan(45_000);
  }, 120_000);
});
