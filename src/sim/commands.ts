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
