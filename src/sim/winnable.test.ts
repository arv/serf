import { describe, expect, it } from 'vitest';
import { TILE_COUNT, tileX, tileY } from '../shared/grid';
import { createWorld, canPlace, type World } from './world';
import { tickWorld } from './tick';
import { TileResource } from './map';
import { TECH_DEFS, type TechId } from './defs/techs';
import { BUILDING_DEFS, type BuildingTypeId } from './defs/buildings';
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
  return [...world.buildings.values()].filter((b) => !b.dead && b.owner === 'player');
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

/** Nearest placeable footprint origin around a point (spiral search). */
function findSpot(world: World, type: BuildingTypeId, cx: number, cy: number, maxR = 14) {
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (canPlace(world.map, type, x, y)) return { x, y };
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
    const placed = new Set<BuildingTypeId>();
    let lastAttackTick = -10_000;

    const MAX_TICKS = 45_000; // ~37 minutes of game time
    for (let t = 0; t < MAX_TICKS; t++) {
      const commands: SimCommand[] = [];

      if (t % 20 === 0 && world.outcome === 'playing') {
        const stock = storehouse(world).stock;

        // --- Build order (each placed once, when affordable) ---------------
        const wantOrder: [BuildingTypeId, { x: number; y: number } | null][] = [];
        if (!placed.has('bambooHut')) {
          const grove = nearestResource(world, TileResource.Bamboo, baseX, baseY);
          if (grove >= 0) {
            wantOrder.push([
              'bambooHut',
              findSpot(world, 'bambooHut', tileX(grove), tileY(grove), 6),
            ]);
          }
        }
        if (!placed.has('quarry')) {
          const rocks = nearestResource(world, TileResource.Rock, baseX, baseY);
          if (rocks >= 0) {
            wantOrder.push(['quarry', findSpot(world, 'quarry', tileX(rocks), tileY(rocks), 6)]);
          }
        }
        if (!placed.has('terakoya')) {
          wantOrder.push(['terakoya', findSpot(world, 'terakoya', baseX, baseY)]);
        }
        if (!placed.has('well')) wantOrder.push(['well', findSpot(world, 'well', baseX, baseY)]);
        if (!placed.has('ricePaddy')) {
          wantOrder.push(['ricePaddy', findSpot(world, 'ricePaddy', baseX, baseY)]);
        }
        if (!placed.has('dojo') && world.techs.researched.includes('bushido')) {
          wantOrder.push(['dojo', findSpot(world, 'dojo', baseX, baseY)]);
        }
        if (!placed.has('ironMine') && world.techs.researched.includes('ironworking')) {
          const seam = nearestResource(world, TileResource.IronDep, baseX, baseY);
          if (seam >= 0) {
            wantOrder.push(['ironMine', findSpot(world, 'ironMine', tileX(seam), tileY(seam), 4)]);
          }
        }
        if (!placed.has('swordsmith') && world.techs.researched.includes('ironworking')) {
          wantOrder.push(['swordsmith', findSpot(world, 'swordsmith', baseX, baseY)]);
        }
        if (!placed.has('spearmaker') && world.techs.researched.includes('ironworking')) {
          wantOrder.push(['spearmaker', findSpot(world, 'spearmaker', baseX, baseY)]);
        }

        for (const [type, spot] of wantOrder) {
          if (!spot) continue;
          const cost = requireCost(type);
          const ok = Object.entries(cost).every(
            ([good, n]) => ((stock as Record<string, number>)[good] ?? 0) >= n,
          );
          if (ok) {
            commands.push({ kind: 'placeBuilding', building: type, x: spot.x, y: spot.y });
            placed.add(type);
            break; // one placement per decision to keep hauling focused
          }
        }

        // --- Research queue -------------------------------------------------
        if (!world.techs.active) {
          const next = researchOrder.find((id) => !world.techs.researched.includes(id));
          if (next && has(world, 'terakoya')) {
            const cost = TECH_DEFS[next].cost;
            const ok = Object.entries(cost).every(
              ([good, n]) => ((stock as Record<string, number>)[good] ?? 0) >= (n ?? 0),
            );
            if (ok) commands.push({ kind: 'research', tech: next });
          }
        }

        // --- Keep the dojo queue warm --------------------------------------
        const dojo = buildings(world).find((b) => b.type === 'dojo' && b.state === 'built');
        if (dojo && (dojo.trainQueue?.length ?? 0) < 2) {
          // Alternate spears and swords; the queue simply waits for weapons.
          commands.push({
            kind: 'trainUnit',
            buildingId: dojo.id,
            unit: t % 40 === 0 ? 'ashigaru' : 'samurai',
          });
        }

        // --- March on the camp when the squad is ready ---------------------
        const army = [...world.units.values()].filter(
          (u) => !u.dead && u.owner === 'player' && MILITARY.has(u.kind),
        );
        const camp = [...world.buildings.values()].find(
          (b) => !b.dead && b.type === 'banditCamp',
        );
        if (camp && army.length >= 6 && t - lastAttackTick > 600) {
          lastAttackTick = t;
          commands.push({
            kind: 'moveUnits',
            unitIds: army.map((u) => u.id),
            x: camp.x + 1,
            y: camp.y + 1,
          });
        }
      }

      tickWorld(world, commands);
      if (world.outcome !== 'playing') break;
    }

    // The one assertion that matters.
    expect(world.outcome, `ended at tick ${world.tick}`).toBe('won');
    // And it should be winnable within a reasonable session.
    expect(world.tick).toBeLessThan(45_000);
  }, 120_000);
});
