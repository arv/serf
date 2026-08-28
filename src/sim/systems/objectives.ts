import { UNIT_DEFS } from '../defs/units.ts';
import { MISSION_DEFS, type ObjectiveSpec } from '../defs/missions.ts';
import { buildingDef } from '../defs/buildings.ts';
import { populationOf } from '../population.ts';
import type { Owner } from '../entities.ts';
import type { World } from '../world.ts';
import * as ObjectiveKind from '../defs/objectiveKindEnum.ts';
import * as BuildingTypeId from '../defs/buildingTypeIdEnum.ts';
import * as BuildingState from '../buildingStateEnum.ts';
import * as GameEventKind from '../gameEventKindEnum.ts';
import * as CommandKind from '../commandKindEnum.ts';

/**
 * Mission objectives: stateless predicates over the world, latched into
 * World.objectivesDone by the caller (victory.ts). Kept out of victory.ts
 * only for readability — this is the whole objective system.
 */

export function objectiveMet(world: World, spec: ObjectiveSpec, player: Owner): boolean {
  switch (spec.kind) {
    case ObjectiveKind.building: {
      let n = 0;
      for (const b of world.buildings.values()) {
        if (
          !b.dead &&
          b.state === BuildingState.built &&
          b.owner === player &&
          b.type === spec.type
        )
          n++;
      }
      return n >= spec.count;
    }
    case ObjectiveKind.stock: {
      // Storehouse stock — what the resource bar shows. Goods in workshop
      // buffers or serfs' hands don't count until they come home.
      let n = 0;
      for (const b of world.buildings.values()) {
        if (
          !b.dead &&
          b.state === BuildingState.built &&
          b.owner === player &&
          buildingDef(b.type).storage
        ) {
          n += b.stock[spec.good] ?? 0;
        }
      }
      return n >= spec.amount;
    }
    case ObjectiveKind.research:
      return world.players[player]?.techs.researched.includes(spec.tech) ?? false;
    case ObjectiveKind.population:
      return populationOf(world, player) >= spec.count;
    case ObjectiveKind.soldiers: {
      let n = 0;
      for (const u of world.units.values()) {
        if (!u.dead && u.owner === player && UNIT_DEFS[u.kind].combat) n++;
      }
      return n >= spec.count;
    }
    case ObjectiveKind.razeCamp: {
      if (!world.banditsEnabled) return false; // a campless sandbox never auto-wins
      for (const b of world.buildings.values()) {
        if (!b.dead && b.type === BuildingTypeId.banditCamp) return false;
      }
      return true;
    }
  }
}

/**
 * Evaluate and latch this world's mission objectives for the human seat
 * (seat 0 — missions are the solo campaign). Pushes one objectiveComplete
 * event per newly-met objective; returns true when every latch is set.
 * Returns false for worlds with no mission checklist.
 */
export function latchObjectives(world: World): boolean {
  const mission = world.missionId ? MISSION_DEFS[world.missionId] : undefined;
  if (!mission || mission.objectives.length === 0) return false;
  const done = (world.objectivesDone ??= mission.objectives.map(() => false));
  let all = true;
  for (let i = 0; i < mission.objectives.length; i++) {
    if (done[i]) continue;
    if (objectiveMet(world, mission.objectives[i]!.spec, 0)) {
      done[i] = true;
      world.pendingEvents.push({ kind: GameEventKind.objectiveComplete, index: i, player: 0 });
    } else {
      all = false;
    }
  }
  return all;
}
