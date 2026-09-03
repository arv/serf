import type {Enum} from '../shared/enum.ts';
import * as CommandKindNs from './commandKindEnum.ts';
import {
  FORGE_QUEUE_CAP,
  HIRE_QUEUE_CAP,
  TRAIN_QUEUE_CAP,
} from './defs/balance.ts';
import {
  AUTO_RECIPE,
  BUILDING_DEFS,
  type BuildingTypeId,
} from './defs/buildings.ts';
import {TECH_DEFS, type TechId} from './defs/techs.ts';
import {UNIT_DEFS, type UnitTypeId} from './defs/units.ts';
import type {EntityId} from './entities.ts';
import * as HeraldNoteNs from './heraldNoteEnum.ts';

export type CommandKind = Enum<typeof CommandKindNs>;
import * as AdminActionNs from './adminActionEnum.ts';

export type AdminAction = Enum<typeof AdminActionNs>;
export type HeraldNote = Enum<typeof HeraldNoteNs>;

/**
 * The only way anything outside the sim mutates the world. Commands are
 * queued and applied at the top of the next tick, in order. The worker
 * revalidates everything (the UI's checks are advisory only).
 */
export type SimCommand =
  // `attack` picks between the move orders: absent is a plain move that
  // ignores enemies until arrival, `true` an attack-move that engages
  // whatever it meets, and `'half'` walks the front half of the route as a
  // plain move before going live (the mobile tap default: one gesture must
  // both send an army out to fight and let it flee without reengaging).
  // `queue` is the Shift-click: rather than replacing what a unit is doing,
  // the order waits its turn behind it (Unit.orders) — a unit standing idle
  // simply takes it now. Absent, the order is the fresh one it has always
  // been, and it drops whatever was queued.
  // `patrol` is the beat: soldiers walk to the spot and back to where they
  // set out from, and keep doing so, fighting what they meet on every leg
  // (Waypoint.patrol). Always live, so `attack` says nothing beside it.
  // With `queue` it extends the beat a squad is already walking by one
  // more spot — or, behind a plain route, starts one from that route's
  // end. Civilians in the list take the plain walk instead.
  | {
      kind: CommandKindNs.moveUnits;
      unitIds: EntityId[];
      x: number;
      y: number;
      attack?: true | 'half';
      queue?: true;
      patrol?: true;
    }
  /**
   * Put a squad on one target — focus fire, and the only way a caller can
   * name a target at all. Every other order leaves that to the sim:
   * `acquireUnit` picks the nearest enemy weighted by the counter table,
   * for every soldier on the field, and that stays the default. This says
   * "all of you, that one", which is worth having because damage here is
   * flat — a soldier at a sliver of health hits exactly as hard as a fresh
   * one — so killing one enemy outright removes its whole output where
   * spreading the same damage over three removes none of it.
   *
   * A building is a legal target too (`building: true`), and means the
   * same thing: hit THAT one. Left to itself a squad besieges whatever
   * `nearestEnemyBuilding` puts in reach, which is the wall it happens to
   * be standing next to rather than the barracks behind it.
   *
   * The flag is explicit rather than inferred. Ids are unique across both
   * maps, so a lookup in each would resolve — but `Unit.targetIsBuilding`
   * is the sim's own discriminator for which map to read, and a caller
   * that names a building where it meant a unit is a bug worth failing on
   * rather than quietly resolving.
   */
  | {
      kind: CommandKindNs.focusTarget;
      unitIds: EntityId[];
      targetId: EntityId;
      building?: true;
    }
  /**
   * Hold ground: the named soldiers stop where they stand and fight only
   * what comes within weapon reach (units.ts, UnitTaskKind.hold). No
   * target and no tile — the order is the ground under their feet. The
   * one order that ends a march without starting another, which is what
   * makes it the retreat's other half: M walks a squad clear, and this is
   * how it is told to stop running and turn round on the spot rather than
   * at the tile it was sent to. Civilians in the list are skipped: a serf
   * has no reach to hold ground with, and stopping his errand mid-haul
   * would only strand the good.
   */
  | {kind: CommandKindNs.holdGround; unitIds: EntityId[]}
  | {
      kind: CommandKindNs.placeBuilding;
      building: BuildingTypeId;
      x: number;
      y: number;
    }
  | {kind: CommandKindNs.hireSerf}
  // Call one paid-for recruit back off the road. The slot names which,
  // the way cancelTraining's does; no building id, because hiring has
  // exactly one address (hireSerf doesn't name one either).
  | {kind: CommandKindNs.cancelHire; index: number}
  | {kind: CommandKindNs.sellBuilding; buildingId: EntityId}
  | {
      kind: CommandKindNs.setBuildingPaused;
      buildingId: EntityId;
      paused: boolean;
    }
  | {
      kind: CommandKindNs.setBuildingRepair;
      buildingId: EntityId;
      repair: boolean;
    }
  | {kind: CommandKindNs.setBuildingRecipe; buildingId: EntityId; index: number}
  | {
      kind: CommandKindNs.enqueueForge;
      buildingId: EntityId;
      recipeIndex: number;
    }
  | {
      kind: CommandKindNs.cancelForge;
      buildingId: EntityId;
      index: number;
      recipeIndex: number;
    }
  | {kind: CommandKindNs.research; tech: TechId}
  | {kind: CommandKindNs.trainUnit; buildingId: EntityId; unit: UnitTypeId}
  | {
      kind: CommandKindNs.cancelTraining;
      buildingId: EntityId;
      index: number;
      unit: UnitTypeId;
    }
  // Plant (x and y present) or take down (both absent) a barracks' rally
  // flag: the tile fresh soldiers march to as they step out of the door.
  | {
      kind: CommandKindNs.setRallyPoint;
      buildingId: EntityId;
      x?: number;
      y?: number;
    }
  | {kind: CommandKindNs.admin; action: AdminAction}
  /** A taunt with an address: the sender announces itself to one player
   * (heraldIncoming lands on their screen). Structured — a note id and an
   * optional count, never free text — and logged like every command, so a
   * replay's heralds arrive exactly as they were sent. */
  | {
      kind: CommandKindNs.herald;
      target: number;
      note: HeraldNote;
      count?: number;
    };

/** Sandbox tweaks (the ?admin panel). Single-player: no cheat gating needed. */

const HERALD_NOTES: readonly HeraldNote[] = [
  HeraldNoteNs.marchComing,
  HeraldNoteNs.retribution,
  HeraldNoteNs.finalAssault,
];

const ADMIN_ACTIONS: readonly AdminAction[] = [
  AdminActionNs.toggleRaids,
  AdminActionNs.clearBandits,
  AdminActionNs.grantGoods,
  AdminActionNs.toggleInstantBuild,
  AdminActionNs.finishResearch,
  AdminActionNs.spawnParade,
];

/**
 * Ceiling on one move order's unit list. Far above any selection a player
 * can build — it exists so a hostile frame cannot hand the tick a million
 * ids to walk.
 */
export const MAX_UNITS_PER_ORDER = 1024;

function isId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * A queue slot, bounded by the queue that holds it. The sim checks the slot
 * really holds what the click named (tick.ts) — this is the protocol's own
 * bound, and it is the cap rather than a round number because a slot past
 * the cap can never name anything: letting one through only buys a command
 * that reaches the sim to do nothing.
 */
function isSlot(v: unknown, cap: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < cap;
}

/** An index into a building's recipeOptions. Bounded by the longest menu
 * any building has, since which building this is arrives with the id and
 * is resolved in the sim. */
function isRecipeIndex(v: unknown): v is number {
  // Strict: valid indices are 0..length-1, so the length itself — the
  // first impossible value — is turned away with the rest.
  return (
    typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= 0 &&
    v < MAX_RECIPE_OPTIONS
  );
}

/** The longest recipeOptions any def carries — the Smith's nine. */
const MAX_RECIPE_OPTIONS = Math.max(
  ...Object.values(BUILDING_DEFS).map(d => d.recipeOptions?.length ?? 0),
);

/** Tile coordinates are always whole numbers on the wire; the sim's own
 * bounds checks (inBounds, canPlace) still decide whether they mean
 * anything, so this only rejects what could never have come from a client. */
const isTile = isId;

/** Own-property lookup on purpose: `BUILDING_DEFS['constructor']` is truthy
 * through the prototype and would sail past a plain truthiness test. */
/**
 * Does this untrusted value name a row of a def table?
 *
 * Both spellings are live while the ids are moving from words to numbers:
 * `Object.hasOwn` reads either, and the integer check is what keeps a
 * fractional or NaN "id" from indexing anything.
 */
function isDefined(table: object, key: unknown): boolean {
  if (typeof key === 'string') return Object.hasOwn(table, key);
  return (
    typeof key === 'number' &&
    Number.isInteger(key) &&
    Object.hasOwn(table, key)
  );
}

/**
 * Turn one untrusted wire value into a command, or reject it.
 *
 * A command frame is JSON from a socket anyone may open, so what arrives is
 * not a SimCommand — it merely claims to be one. `applyCommand` looks defs
 * up by name and reads fields without checking them, so a single
 * `{kind:'placeBuilding', building:'bogus'}` threw inside the server's tick
 * pump and took down the process, and every match running on it, with it.
 *
 * Screening here rather than defending inside the sim is what keeps the sim
 * deterministic: a rejected order never reaches the world at all, so every
 * observer of that world still sees the same tick.
 */
export function sanitizeCommand(raw: unknown): SimCommand | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  switch (c.kind) {
    case CommandKindNs.focusTarget: {
      if (!Array.isArray(c.unitIds)) return null;
      if (c.unitIds.length > MAX_UNITS_PER_ORDER) return null;
      if (!c.unitIds.every(isId)) return null;
      if (!isId(c.targetId)) return null;
      return {
        kind: CommandKindNs.focusTarget,
        unitIds: [...(c.unitIds as EntityId[])],
        targetId: c.targetId as EntityId,
        ...(c.building === true ? {building: true as const} : {}),
      };
    }
    case CommandKindNs.holdGround: {
      if (!Array.isArray(c.unitIds)) return null;
      if (c.unitIds.length > MAX_UNITS_PER_ORDER) return null;
      if (!c.unitIds.every(isId)) return null;
      return {
        kind: CommandKindNs.holdGround,
        unitIds: [...(c.unitIds as EntityId[])],
      };
    }
    case CommandKindNs.moveUnits: {
      if (!Array.isArray(c.unitIds)) return null;
      if (c.unitIds.length > MAX_UNITS_PER_ORDER) return null;
      if (!c.unitIds.every(isId)) return null;
      if (!isTile(c.x) || !isTile(c.y)) return null;
      return {
        kind: CommandKindNs.moveUnits,
        unitIds: [...(c.unitIds as EntityId[])],
        x: c.x,
        y: c.y,
        // Anything but the two literal fight values means a plain move —
        // the safe reading of a garbled flag is the order that starts no
        // fights.
        ...(c.attack === true || c.attack === 'half' ? {attack: c.attack} : {}),
        // Anything but a literal true is the fresh order: a garbled flag
        // replaces rather than appends, which is what an unflagged click
        // has always done.
        ...(c.queue === true ? {queue: true as const} : {}),
        // And only a literal true walks a beat: a garbled flag must not
        // leave a squad marching forever.
        ...(c.patrol === true ? {patrol: true as const} : {}),
      };
    }
    case CommandKindNs.placeBuilding:
      if (!isDefined(BUILDING_DEFS, c.building)) return null;
      if (!isTile(c.x) || !isTile(c.y)) return null;
      return {
        kind: CommandKindNs.placeBuilding,
        building: c.building as BuildingTypeId,
        x: c.x,
        y: c.y,
      };
    case CommandKindNs.hireSerf:
      return {kind: CommandKindNs.hireSerf};
    case CommandKindNs.cancelHire: {
      // Only the slot to screen: every recruit in the queue is the same
      // man, so there is no second field for a stale click to disagree
      // with — the sim checks the slot against the queue's depth instead.
      if (!isSlot(c.index, HIRE_QUEUE_CAP)) return null;
      return {kind: CommandKindNs.cancelHire, index: c.index};
    }
    case CommandKindNs.sellBuilding:
      if (!isId(c.buildingId)) return null;
      return {kind: CommandKindNs.sellBuilding, buildingId: c.buildingId};
    case CommandKindNs.setBuildingPaused:
      if (!isId(c.buildingId)) return null;
      return {
        kind: CommandKindNs.setBuildingPaused,
        buildingId: c.buildingId,
        paused: c.paused === true,
      };
    case CommandKindNs.setBuildingRepair:
      if (!isId(c.buildingId)) return null;
      return {
        kind: CommandKindNs.setBuildingRepair,
        buildingId: c.buildingId,
        repair: c.repair === true,
      };
    case CommandKindNs.setBuildingRecipe: {
      if (!isId(c.buildingId)) return null;
      // -1 is AUTO_RECIPE: clear the standing order and let the Smith pick.
      if (c.index !== AUTO_RECIPE && !isRecipeIndex(c.index)) return null;
      return {
        kind: CommandKindNs.setBuildingRecipe,
        buildingId: c.buildingId,
        index: c.index,
      };
    }
    case CommandKindNs.enqueueForge: {
      if (!isId(c.buildingId)) return null;
      if (!isRecipeIndex(c.recipeIndex)) return null;
      return {
        kind: CommandKindNs.enqueueForge,
        buildingId: c.buildingId,
        recipeIndex: c.recipeIndex,
      };
    }
    case CommandKindNs.cancelForge: {
      if (!isId(c.buildingId)) return null;
      // Both the slot and what the player thinks is in it, like
      // cancelTraining: a stale click after the queue shifted must miss
      // rather than cancel a neighbour.
      if (!isSlot(c.index, FORGE_QUEUE_CAP)) return null;
      if (!isRecipeIndex(c.recipeIndex)) return null;
      return {
        kind: CommandKindNs.cancelForge,
        buildingId: c.buildingId,
        index: c.index,
        recipeIndex: c.recipeIndex,
      };
    }
    case CommandKindNs.research:
      if (!isDefined(TECH_DEFS, c.tech)) return null;
      return {kind: CommandKindNs.research, tech: c.tech as TechId};
    case CommandKindNs.trainUnit:
      if (!isId(c.buildingId) || !isDefined(UNIT_DEFS, c.unit)) return null;
      return {
        kind: CommandKindNs.trainUnit,
        buildingId: c.buildingId,
        unit: c.unit as UnitTypeId,
      };
    case CommandKindNs.cancelTraining: {
      if (!isId(c.buildingId) || !isDefined(UNIT_DEFS, c.unit)) return null;
      if (!isSlot(c.index, TRAIN_QUEUE_CAP)) return null;
      return {
        kind: CommandKindNs.cancelTraining,
        buildingId: c.buildingId,
        index: c.index,
        unit: c.unit as UnitTypeId,
      };
    }
    case CommandKindNs.setRallyPoint: {
      if (!isId(c.buildingId)) return null;
      // No coordinates at all is the take-the-flag-down order; a half-given
      // pair is garbage rather than a guess at what was meant.
      if (c.x === undefined && c.y === undefined) {
        return {kind: CommandKindNs.setRallyPoint, buildingId: c.buildingId};
      }
      if (!isTile(c.x) || !isTile(c.y)) return null;
      return {
        kind: CommandKindNs.setRallyPoint,
        buildingId: c.buildingId,
        x: c.x,
        y: c.y,
      };
    }
    case CommandKindNs.admin:
      if (!ADMIN_ACTIONS.includes(c.action as AdminAction)) return null;
      return {kind: CommandKindNs.admin, action: c.action as AdminAction};
    case CommandKindNs.herald: {
      if (!Number.isInteger(c.target) || (c.target as number) < 0) return null;
      if (!HERALD_NOTES.includes(c.note as HeraldNote)) return null;
      // The count is flavor ("twelve strong"); clamp it so a hostile frame
      // cannot make the client print nonsense.
      const count =
        Number.isInteger(c.count) && (c.count as number) > 0
          ? Math.min(c.count as number, 64)
          : undefined;
      return {
        kind: CommandKindNs.herald,
        target: c.target as number,
        note: c.note as HeraldNote,
        ...(count !== undefined ? {count} : {}),
      };
    }
    default:
      return null;
  }
}

/**
 * Screen a whole frame's worth of orders. Never throws and never closes
 * anything: a garbled entry is dropped, and what is left is playable.
 */
export function sanitizeCommands(raw: unknown, limit: number): SimCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: SimCommand[] = [];
  for (const entry of raw) {
    if (out.length >= limit) break;
    const cmd = sanitizeCommand(entry);
    if (cmd) out.push(cmd);
  }
  return out;
}
