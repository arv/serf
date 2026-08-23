import { FORGE_QUEUE_CAP, TRAIN_QUEUE_CAP } from './defs/balance.ts';
import { AUTO_RECIPE, BUILDING_DEFS } from './defs/buildings.ts';
import { TECH_DEFS } from './defs/techs.ts';
import { UNIT_DEFS } from './defs/units.ts';
import type { EntityId } from './entities.ts';
import type { BuildingTypeId } from './defs/buildings.ts';
import type { TechId } from './defs/techs.ts';
import type { UnitTypeId } from './defs/units.ts';

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
  | { kind: 'moveUnits'; unitIds: EntityId[]; x: number; y: number; attack?: true | 'half' }
  | { kind: 'placeBuilding'; building: BuildingTypeId; x: number; y: number }
  | { kind: 'hireSerf' }
  | { kind: 'sellBuilding'; buildingId: EntityId }
  | { kind: 'setBuildingPaused'; buildingId: EntityId; paused: boolean }
  | { kind: 'setBuildingRepair'; buildingId: EntityId; repair: boolean }
  | { kind: 'setBuildingRecipe'; buildingId: EntityId; index: number }
  | { kind: 'enqueueForge'; buildingId: EntityId; recipeIndex: number }
  | { kind: 'cancelForge'; buildingId: EntityId; index: number; recipeIndex: number }
  | { kind: 'research'; tech: TechId }
  | { kind: 'trainUnit'; buildingId: EntityId; unit: UnitTypeId }
  | { kind: 'cancelTraining'; buildingId: EntityId; index: number; unit: UnitTypeId }
  // Plant (x and y present) or take down (both absent) a barracks' rally
  // flag: the tile fresh soldiers march to as they step out of the door.
  | { kind: 'setRallyPoint'; buildingId: EntityId; x?: number; y?: number }
  | { kind: 'admin'; action: AdminAction };

/** Sandbox tweaks (the ?admin panel). Single-player: no cheat gating needed. */
export type AdminAction =
  | 'toggleRaids'
  | 'clearBandits'
  | 'grantGoods'
  | 'toggleInstantBuild'
  | 'finishResearch'
  | 'spawnParade';

const ADMIN_ACTIONS = [
  'toggleRaids',
  'clearBandits',
  'grantGoods',
  'toggleInstantBuild',
  'finishResearch',
  'spawnParade',
] as const satisfies readonly AdminAction[];

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
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < MAX_RECIPE_OPTIONS;
}

/** The longest recipeOptions any def carries — the Smith's nine. */
const MAX_RECIPE_OPTIONS = Math.max(
  ...Object.values(BUILDING_DEFS).map((d) => d.recipeOptions?.length ?? 0),
);

/** Tile coordinates are always whole numbers on the wire; the sim's own
 * bounds checks (inBounds, canPlace) still decide whether they mean
 * anything, so this only rejects what could never have come from a client. */
const isTile = isId;

/** Own-property lookup on purpose: `BUILDING_DEFS['constructor']` is truthy
 * through the prototype and would sail past a plain truthiness test. */
function isDefined(table: object, key: unknown): boolean {
  return typeof key === 'string' && Object.hasOwn(table, key);
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
    case 'moveUnits': {
      if (!Array.isArray(c.unitIds)) return null;
      if (c.unitIds.length > MAX_UNITS_PER_ORDER) return null;
      if (!c.unitIds.every(isId)) return null;
      if (!isTile(c.x) || !isTile(c.y)) return null;
      return {
        kind: 'moveUnits',
        unitIds: [...(c.unitIds as EntityId[])],
        x: c.x,
        y: c.y,
        // Anything but the two literal fight values means a plain move —
        // the safe reading of a garbled flag is the order that starts no
        // fights.
        ...(c.attack === true || c.attack === 'half' ? { attack: c.attack } : {}),
      };
    }
    case 'placeBuilding':
      if (!isDefined(BUILDING_DEFS, c.building)) return null;
      if (!isTile(c.x) || !isTile(c.y)) return null;
      return { kind: 'placeBuilding', building: c.building as BuildingTypeId, x: c.x, y: c.y };
    case 'hireSerf':
      return { kind: 'hireSerf' };
    case 'sellBuilding':
      if (!isId(c.buildingId)) return null;
      return { kind: 'sellBuilding', buildingId: c.buildingId };
    case 'setBuildingPaused':
      if (!isId(c.buildingId)) return null;
      return { kind: 'setBuildingPaused', buildingId: c.buildingId, paused: c.paused === true };
    case 'setBuildingRepair':
      if (!isId(c.buildingId)) return null;
      return { kind: 'setBuildingRepair', buildingId: c.buildingId, repair: c.repair === true };
    case 'setBuildingRecipe': {
      if (!isId(c.buildingId)) return null;
      // -1 is AUTO_RECIPE: clear the standing order and let the Smith pick.
      if (c.index !== AUTO_RECIPE && !isRecipeIndex(c.index)) return null;
      return { kind: 'setBuildingRecipe', buildingId: c.buildingId, index: c.index };
    }
    case 'enqueueForge': {
      if (!isId(c.buildingId)) return null;
      if (!isRecipeIndex(c.recipeIndex)) return null;
      return { kind: 'enqueueForge', buildingId: c.buildingId, recipeIndex: c.recipeIndex };
    }
    case 'cancelForge': {
      if (!isId(c.buildingId)) return null;
      // Both the slot and what the player thinks is in it, like
      // cancelTraining: a stale click after the queue shifted must miss
      // rather than cancel a neighbour.
      if (!isSlot(c.index, FORGE_QUEUE_CAP)) return null;
      if (!isRecipeIndex(c.recipeIndex)) return null;
      return {
        kind: 'cancelForge',
        buildingId: c.buildingId,
        index: c.index,
        recipeIndex: c.recipeIndex,
      };
    }
    case 'research':
      if (!isDefined(TECH_DEFS, c.tech)) return null;
      return { kind: 'research', tech: c.tech as TechId };
    case 'trainUnit':
      if (!isId(c.buildingId) || !isDefined(UNIT_DEFS, c.unit)) return null;
      return { kind: 'trainUnit', buildingId: c.buildingId, unit: c.unit as UnitTypeId };
    case 'cancelTraining': {
      if (!isId(c.buildingId) || !isDefined(UNIT_DEFS, c.unit)) return null;
      if (!isSlot(c.index, TRAIN_QUEUE_CAP)) return null;
      return {
        kind: 'cancelTraining',
        buildingId: c.buildingId,
        index: c.index,
        unit: c.unit as UnitTypeId,
      };
    }
    case 'setRallyPoint': {
      if (!isId(c.buildingId)) return null;
      // No coordinates at all is the take-the-flag-down order; a half-given
      // pair is garbage rather than a guess at what was meant.
      if (c.x === undefined && c.y === undefined) {
        return { kind: 'setRallyPoint', buildingId: c.buildingId };
      }
      if (!isTile(c.x) || !isTile(c.y)) return null;
      return { kind: 'setRallyPoint', buildingId: c.buildingId, x: c.x, y: c.y };
    }
    case 'admin':
      if (!ADMIN_ACTIONS.includes(c.action as AdminAction)) return null;
      return { kind: 'admin', action: c.action as AdminAction };
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
