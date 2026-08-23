import { HIRE_SERF_COST, START_STOCK, TICKS_PER_SECOND } from '../../sim/defs/balance';
import {
  BUILDING_DEFS,
  TOOL_OF,
  outputGoodsOf,
  type BuildingTypeId,
  type Recipe,
} from '../../sim/defs/buildings';
import { GOODS, type GoodAmounts, type GoodId } from '../../sim/defs/goods';
import { TECH_DEFS, type TechId } from '../../sim/defs/techs';
import { UNIT_DEFS, WEAPON_OF, type UnitTypeId } from '../../sim/defs/units';

/**
 * The cross-reference graph the wiki walks: every "produced by / used by /
 * trained at / unlocked by" line, derived from the defs at module load.
 * Nothing here is authored — a new building, unit, good or tech shows up on
 * these pages the moment its def exists, with every def field it carries.
 */

export const ALL_BUILDINGS = Object.keys(BUILDING_DEFS) as BuildingTypeId[];
export const ALL_UNITS = Object.keys(UNIT_DEFS) as UnitTypeId[];
export const ALL_TECHS = Object.keys(TECH_DEFS) as TechId[];

export function secs(ticks: number): number {
  return ticks / TICKS_PER_SECOND;
}

/** "12 s" / "1 min 30 s" — durations on def scales, whole seconds. */
export function fmtSecs(ticks: number): string {
  const s = Math.round(secs(ticks));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m} min` : `${m} min ${r} s`;
}

/** Ideal output rate: goods per minute at full duty, no modifiers. */
export function perMinute(amount: number, durationTicks: number): number {
  return (amount * 60) / secs(durationTicks);
}

export function fmtPerMinute(amount: number, durationTicks: number): string {
  const rate = perMinute(amount, durationTicks);
  return `${Number.isInteger(rate) ? rate : rate.toFixed(1)}/min`;
}

export interface ProducerRef {
  building: BuildingTypeId;
  via: 'gather' | 'convert' | 'forge';
  amount: number;
  durationTicks: number;
  /** Gate on the recipe itself (a Smith forge option), not the roof. */
  requiresTech?: TechId;
}

export type ConsumerRef =
  | { kind: 'recipe'; building: BuildingTypeId; requiresTech?: TechId }
  | { kind: 'construction'; building: BuildingTypeId }
  | { kind: 'repair'; building: BuildingTypeId }
  | { kind: 'training'; building: BuildingTypeId; unit: UnitTypeId }
  | { kind: 'tech'; tech: TechId }
  | { kind: 'tool'; building: BuildingTypeId }
  | { kind: 'weapon'; unit: UnitTypeId }
  | { kind: 'hire' }
  | { kind: 'siteLoan' };

function goodsOf(amounts: GoodAmounts): GoodId[] {
  return Object.keys(amounts) as GoodId[];
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function producersFrom(
  building: BuildingTypeId,
  recipe: Recipe,
  via: 'gather' | 'convert' | 'forge',
  requiresTech: TechId | undefined,
  into: Map<GoodId, ProducerRef[]>,
): void {
  if (recipe.kind === 'gather') {
    push(into, recipe.output, {
      building,
      via,
      amount: 1,
      durationTicks: recipe.workTicks,
      ...(requiresTech !== undefined ? { requiresTech } : {}),
    });
    return;
  }
  for (const [good, amount] of Object.entries(recipe.outputs) as [GoodId, number][]) {
    push(into, good, {
      building,
      via,
      amount,
      durationTicks: recipe.durationTicks,
      ...(requiresTech !== undefined ? { requiresTech } : {}),
    });
  }
}

function buildProducedBy(): Map<GoodId, ProducerRef[]> {
  const map = new Map<GoodId, ProducerRef[]>();
  for (const id of ALL_BUILDINGS) {
    const def = BUILDING_DEFS[id];
    if (def.recipe) {
      producersFrom(id, def.recipe, def.recipe.kind === 'gather' ? 'gather' : 'convert', undefined, map);
    }
    for (const opt of def.recipeOptions ?? []) {
      producersFrom(id, opt.recipe, 'forge', opt.requiresTech, map);
    }
  }
  return map;
}

function buildConsumedBy(): Map<GoodId, ConsumerRef[]> {
  const map = new Map<GoodId, ConsumerRef[]>();
  for (const id of ALL_BUILDINGS) {
    const def = BUILDING_DEFS[id];
    for (const good of goodsOf(def.cost)) push(map, good, { kind: 'construction', building: id });
    // A mend bills against the build cost, so for most buildings the line
    // above already names the goods. `repairCost` is the exception — the
    // castle costs nothing to raise and real timber and stone to patch, so
    // without this neither good's page reports that use at all.
    for (const good of goodsOf(def.repairCost ?? {})) {
      push(map, good, { kind: 'repair', building: id });
    }
    if (def.recipe?.kind === 'convert') {
      for (const good of goodsOf(def.recipe.inputs)) push(map, good, { kind: 'recipe', building: id });
    }
    // One entry per good per building, not per forge option: nine Smith
    // recipes eating iron is one line on the iron page, not five.
    const optionInputs = new Map<GoodId, TechId | undefined>();
    for (const opt of def.recipeOptions ?? []) {
      for (const good of goodsOf(opt.recipe.inputs)) {
        // An ungated option wins: iron is "used by the Smith", full stop,
        // even though most of its menu is also tech-gated.
        if (!optionInputs.has(good) || opt.requiresTech === undefined) {
          optionInputs.set(good, opt.requiresTech);
        }
      }
    }
    for (const [good, requiresTech] of optionInputs) {
      push(map, good, {
        kind: 'recipe',
        building: id,
        ...(requiresTech !== undefined ? { requiresTech } : {}),
      });
    }
    for (const t of def.trains ?? []) {
      for (const good of goodsOf(t.cost)) {
        push(map, good, { kind: 'training', building: id, unit: t.unit });
      }
    }
  }
  for (const id of ALL_TECHS) {
    for (const good of goodsOf(TECH_DEFS[id].cost)) push(map, good, { kind: 'tech', tech: id });
  }
  for (const [building, tool] of Object.entries(TOOL_OF) as [BuildingTypeId, GoodId][]) {
    push(map, tool, { kind: 'tool', building });
  }
  for (const [unit, weapon] of Object.entries(WEAPON_OF) as [UnitTypeId, GoodId][]) {
    push(map, weapon, { kind: 'weapon', unit });
  }
  // The two consumers no def table names: hiring is priced in balance.ts,
  // and every construction site borrows a hammer (see TOOL_OF's comment).
  push(map, 'silver', { kind: 'hire' });
  push(map, 'hammer', { kind: 'siteLoan' });
  return map;
}

function buildTrainedAt(): Map<UnitTypeId, { building: BuildingTypeId; cost: GoodAmounts; durationTicks: number }> {
  const map = new Map<UnitTypeId, { building: BuildingTypeId; cost: GoodAmounts; durationTicks: number }>();
  for (const id of ALL_BUILDINGS) {
    for (const t of BUILDING_DEFS[id].trains ?? []) {
      map.set(t.unit, { building: id, cost: t.cost, durationTicks: t.durationTicks });
    }
  }
  return map;
}

/** Which tech names this building in an unlockBuilding effect — the "find
 * it on the tech page" direction of BUILDING_DEFS[id].requiresTech. */
function buildBuildingUnlocks(): Map<BuildingTypeId, TechId> {
  const map = new Map<BuildingTypeId, TechId>();
  for (const id of ALL_TECHS) {
    for (const e of TECH_DEFS[id].effects) {
      if (e.kind === 'unlockBuilding') map.set(e.building, id);
    }
  }
  return map;
}

/** Which tech unlocks this unit (mirrors ui/commands.ts unitTechGate,
 * built once for the whole table instead of per lookup). */
function buildUnitUnlocks(): Map<UnitTypeId, TechId> {
  const map = new Map<UnitTypeId, TechId>();
  for (const id of ALL_TECHS) {
    for (const e of TECH_DEFS[id].effects) {
      if (e.kind === 'unlockUnit') map.set(e.unit, id);
    }
  }
  return map;
}

export const PRODUCED_BY = buildProducedBy();
export const CONSUMED_BY = buildConsumedBy();
export const TRAINED_AT = buildTrainedAt();
export const BUILDING_UNLOCKED_BY = buildBuildingUnlocks();
export const UNIT_UNLOCKED_BY = buildUnitUnlocks();

/** Techs that gate this building's placement, normalized to an array
 * (requiresTech accepts one or any-of-several). */
export function buildingTechGates(id: BuildingTypeId): TechId[] {
  const req = BUILDING_DEFS[id].requiresTech;
  if (req === undefined) return [];
  return Array.isArray(req) ? req : [req];
}

/** What the village opens with — the one "source" that is not a building. */
export function startStockOf(good: GoodId): number {
  return START_STOCK[good] ?? 0;
}

export { GOODS, HIRE_SERF_COST };
