import type {Enum} from '../shared/enum.ts';
import type {GoodId} from './defs/goods.ts';
import type {UnitTypeId} from './defs/units.ts';
import type {EntityId, Owner} from './entities.ts';
import * as UnitTaskKindNs from './unitTaskKindEnum.ts';

export type UnitTaskKind = Enum<typeof UnitTaskKindNs>;

/**
 * Task state machines are small discriminated unions; systems switch on
 * `task.t`. Movement is expressed as a path of tile indices plus a cursor.
 */
export type UnitTask =
  | {t: UnitTaskKindNs.idle; until: number} // wander/retry cooldown (tick when eligible)
  | {t: UnitTaskKindNs.move} // player order or wander; goes idle at the end
  // Attack-move: walk toward the ordered tile, engaging whatever comes into
  // acquire range on the way. The destination lives here because fighting
  // consumes the path — the combat system re-plans to it between fights.
  // `engageIdx` quiets the front leg: until the path cursor reaches it the
  // unit walks like a plain move (so a squad ordered away from a lost fight
  // breaks past its attackers instead of wheeling around), then goes live.
  | {
      t: UnitTaskKindNs.attackMove;
      destX: number;
      destY: number;
      engageIdx?: number;
    }
  // Serf hauling (job id lives on the unit; phase lives on the job):
  | {t: UnitTaskKindNs.haul}
  // Resident worker gather loop:
  | {t: UnitTaskKindNs.gatherOut; tile: number}
  | {t: UnitTaskKindNs.gatherWork; tile: number; until: number}
  | {t: UnitTaskKindNs.gatherHome}
  // Serf walking to a building to become its worker (or a barracks recruit).
  | {t: UnitTaskKindNs.staff; buildingId: EntityId}
  // Bandit strategic objective: march on a player building.
  | {t: UnitTaskKindNs.raid; buildingId: EntityId};

export interface Unit {
  id: EntityId;
  kind: UnitTypeId;
  owner: Owner;
  /** Tile-space position (floats; tile centers are at +0.5). */
  x: number;
  y: number;
  hp: number;
  /**
   * Full health for THIS man, which is not the same number as his kind's.
   * A kind's `hp` is only where he starts: armour research (militaryHp)
   * musters a soldier at up to half again as many, so a knight can walk out
   * of the barracks at 120 against a base of 80. Everything that reports a
   * wound — the bar over his head, the card that names him — measures
   * against this, because measuring against the kind calls an armoured man
   * untouched until a third of him is gone.
   */
  maxHp: number;
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
  /**
   * The squad's pace, tiles/sec — a group move order marches at its slowest
   * member's speed so the fast arms hold formation instead of outrunning
   * the shield line (only set where it binds: units at or below the pace
   * march unmarked). Cleared when the walk arrives, and the moment a fight
   * starts — the counter table prices every chase at true speeds, and a
   * spearman who runs down archers at knight pace isn't a spearman.
   */
  marchSpeed?: number;
  /**
   * Consecutive ticks a standing enemy has held this walker off (see
   * separation.ts holdOff). A walker wedged against an enemy's rank for
   * DETOUR_AFTER of them re-plans his route round it. Soldiers only, and
   * only while pinned: cleared (to undefined, lazily — see clearMarchSpeed
   * for why) the first tick nobody holds him.
   */
  heldTicks?: number;
  // Combat runtime (units with a combat def):
  cooldownLeft: number;
  targetId?: EntityId;
  targetIsBuilding?: boolean;
  /**
   * No building-target repathing before this tick. A raider whose objective
   * is walled off used to fail a full unreachable search, disengage, and
   * re-acquire the same building next tick — one worst-case A* per unit per
   * tick, forever; seven stuck knights alone ground the sim to a crawl.
   * The backoff turns that into one search every couple of seconds.
   */
  repathAt?: number;
  dead: boolean;
  /** Set by combat deaths only — the corpse lingers a moment for the death
   * animation. Absent for despawns (barracks consumption), which vanish at once. */
  deathTick?: number;
}

/**
 * Drop a standing pace cap without touching units that never carried one.
 * The field is added lazily — only members of a mixed squad that a march
 * held back ever get it — and a bare `= undefined` write would add the
 * property (a hidden-class transition) to every unit that walks a route
 * to its end. Every clear site goes through here so none regresses.
 */
export function clearMarchSpeed(unit: Unit): void {
  if (unit.marchSpeed !== undefined) unit.marchSpeed = undefined;
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
    // Everyone is born whole; only the barracks hands out more than a kind
    // carries (see Unit.maxHp), and it raises both numbers together.
    maxHp: hp,
    path: null,
    pathIdx: 0,
    task: {t: UnitTaskKindNs.idle, until: 0},
    lastTile: -1,
    cooldownLeft: 0,
    dead: false,
  };
}
