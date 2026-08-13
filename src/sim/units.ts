import type { EntityId, Owner } from './entities.ts';
import type { GoodId } from './defs/goods.ts';
import type { UnitTypeId } from './defs/units.ts';

/**
 * Task state machines are small discriminated unions; systems switch on
 * `task.t`. Movement is expressed as a path of tile indices plus a cursor.
 */
export type UnitTask =
  | { t: 'idle'; until: number } // wander/retry cooldown (tick when eligible)
  | { t: 'move' } // player order or wander; goes idle at the end
  // Attack-move: walk toward the ordered tile, engaging whatever comes into
  // acquire range on the way. The destination lives here because fighting
  // consumes the path — the combat system re-plans to it between fights.
  // `engageIdx` quiets the front leg: until the path cursor reaches it the
  // unit walks like a plain move (so a squad ordered away from a lost fight
  // breaks past its attackers instead of wheeling around), then goes live.
  | { t: 'attackMove'; destX: number; destY: number; engageIdx?: number }
  // Serf hauling (job id lives on the unit; phase lives on the job):
  | { t: 'haul' }
  // Resident worker gather loop:
  | { t: 'gatherOut'; tile: number }
  | { t: 'gatherWork'; tile: number; until: number }
  | { t: 'gatherHome' }
  // Serf walking to a building to become its worker (or a barracks recruit).
  | { t: 'staff'; buildingId: EntityId }
  // Bandit strategic objective: march on a player building.
  | { t: 'raid'; buildingId: EntityId };

export interface Unit {
  id: EntityId;
  kind: UnitTypeId;
  owner: Owner;
  /** Tile-space position (floats; tile centers are at +0.5). */
  x: number;
  y: number;
  hp: number;
  path: number[] | null;
  pathIdx: number;
  task: UnitTask;
  /** Current haul job (serfs). */
  jobId?: number;
  /** Good physically on the unit's shoulders. */
  carrying?: GoodId;
  /** Home building (resident workers). */
  homeId?: EntityId;
  /** Tile the unit occupied last tick — trail wear bookkeeping. */
  lastTile: number;
  // Combat runtime (units with a combat def):
  cooldownLeft: number;
  targetId?: EntityId;
  targetIsBuilding?: boolean;
  dead: boolean;
  /** Set by combat deaths only — the corpse lingers a moment for the death
   * animation. Absent for despawns (barracks consumption), which vanish at once. */
  deathTick?: number;
}

export function makeUnit(
  id: EntityId,
  kind: UnitTypeId,
  owner: Owner,
  x: number,
  y: number,
  hp: number,
): Unit {
  return {
    id,
    kind,
    owner,
    x,
    y,
    hp,
    path: null,
    pathIdx: 0,
    task: { t: 'idle', until: 0 },
    lastTile: -1,
    cooldownLeft: 0,
    dead: false,
  };
}
