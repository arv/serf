import { BUILDING_DEFS } from './defs/buildings.ts';
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
  | { kind: 'moveUnits'; unitIds: EntityId[]; x: number; y: number }
  | { kind: 'placeBuilding'; building: BuildingTypeId; x: number; y: number }
  | { kind: 'hireSerf' }
  | { kind: 'dismissWorker'; buildingId: EntityId }
  | { kind: 'sellBuilding'; buildingId: EntityId }
  | { kind: 'setBuildingPaused'; buildingId: EntityId; paused: boolean }
  | { kind: 'research'; tech: TechId }
  | { kind: 'trainUnit'; buildingId: EntityId; unit: UnitTypeId }
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
      return { kind: 'moveUnits', unitIds: [...(c.unitIds as EntityId[])], x: c.x, y: c.y };
    }
    case 'placeBuilding':
      if (!isDefined(BUILDING_DEFS, c.building)) return null;
      if (!isTile(c.x) || !isTile(c.y)) return null;
      return { kind: 'placeBuilding', building: c.building as BuildingTypeId, x: c.x, y: c.y };
    case 'hireSerf':
      return { kind: 'hireSerf' };
    case 'dismissWorker':
      if (!isId(c.buildingId)) return null;
      return { kind: 'dismissWorker', buildingId: c.buildingId };
    case 'sellBuilding':
      if (!isId(c.buildingId)) return null;
      return { kind: 'sellBuilding', buildingId: c.buildingId };
    case 'setBuildingPaused':
      if (!isId(c.buildingId)) return null;
      return { kind: 'setBuildingPaused', buildingId: c.buildingId, paused: c.paused === true };
    case 'research':
      if (!isDefined(TECH_DEFS, c.tech)) return null;
      return { kind: 'research', tech: c.tech as TechId };
    case 'trainUnit':
      if (!isId(c.buildingId) || !isDefined(UNIT_DEFS, c.unit)) return null;
      return { kind: 'trainUnit', buildingId: c.buildingId, unit: c.unit as UnitTypeId };
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
