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
import { BUILD_GROUPS } from '../../ui/buildMenu';

/**
 * The cross-reference graph the wiki walks: every "produced by / used by /
 * trained at / unlocked by" line, derived from the defs at module load.
 * Nothing here is authored — a new building, unit, good or tech shows up on
 * these pages the moment its def exists, with every def field it carries.
 */

export const ALL_BUILDINGS = Object.keys(BUILDING_DEFS) as BuildingTypeId[];
export const ALL_UNITS = Object.keys(UNIT_DEFS) as UnitTypeId[];
export const ALL_TECHS = Object.keys(TECH_DEFS) as TechId[];

/**
 * The kinds the raids are made of, and the camp they muster from.
 *
 * A list because the defs carry no allegiance — a marauder is a unit like
 * any other to the sim, and only worldgen decides who fields one. Kept
 * here rather than on the units page because the previews need it too: a
 * raider rendered as owner 0 comes out in player one's green, where
 * factionTint(BANDIT) deliberately leaves the pack's own grim look alone.
 */
export const RAIDER_UNITS: UnitTypeId[] = ['bandit', 'banditArcher', 'marauder'];
export const RAIDER_BUILDINGS: BuildingTypeId[] = ['banditCamp'];

/**
 * The roofs no ribbon tab offers: worldgen's and the road pass's. Derived
 * rather than listed, so a new system building cannot be silently missed —
 * every building has a page, and a page nothing links to is a page nobody
 * reads. Lives here rather than beside the tiles that render it so the
 * invariant can be tested without standing up a DOM.
 */
export function worldBuildings(): BuildingTypeId[] {
  const inMenu = new Set(BUILD_GROUPS.flatMap((g) => g.types));
  return ALL_BUILDINGS.filter((id) => !inMenu.has(id));
}

export function secs(ticks: number): number {
  return ticks / TICKS_PER_SECOND;
}

/**
 * "12 s" / "2.5 s" / "1 min 30 s".
 *
 * Not rounded to whole seconds: the woodcutter works a tile in 2.5, and
 * rounding that to "3 s" put the card in contradiction with the "24/min"
 * printed beside it, which is computed from the same tick count.
 */
export function fmtSecs(ticks: number): string {
  const s = secs(ticks);
  if (s < 60) return `${Number(s.toFixed(2))} s`;
  // Past a minute the fraction is noise — nothing on these pages is tuned
  // to a half-second at that scale.
  const whole = Math.round(s);
  const m = Math.floor(whole / 60);
  const r = whole % 60;
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
  | { kind: 'siteLoan' }
  | { kind: 'festival' }
  | { kind: 'ration' };

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
  // The consumers no def table names, because they are mechanics rather
  // than recipe rows: hiring is priced in balance.ts, every construction
  // site borrows a hammer (see TOOL_OF), and ale is drunk in two places —
  // the abbey's festivals and the barracks' cask. Without these the ale
  // page would list what research costs and nothing about what ale is for.
  push(map, 'silver', { kind: 'hire' });
  push(map, 'hammer', { kind: 'siteLoan' });
  push(map, 'ale', { kind: 'festival' });
  push(map, 'ale', { kind: 'ration' });
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
