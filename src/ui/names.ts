import type {PlayerSnap} from '../protocol/messages';
import type {Enum} from '../shared/enum.ts';
import {AI_STRATEGIES} from '../sim/defs/aiStrategies.ts';
import {BUILDING_DEFS, type BuildingTypeId} from '../sim/defs/buildings';
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import {TECH_DEFS, type TechId} from '../sim/defs/techs';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum.ts';
import {isPlayerOwner} from '../sim/entities.ts';

type GoodId = Enum<typeof GoodId>;
type UnitTypeId = Enum<typeof UnitTypeId>;

/**
 * Display-name helpers. Buildings and techs carry their names and
 * descriptions on their defs; units and goods have no display fields, so
 * their name maps live here.
 */

export function buildingName(type: BuildingTypeId): string {
  return BUILDING_DEFS[type].name;
}

export function techName(id: TechId): string {
  return TECH_DEFS[id].name;
}

export function techDesc(id: TechId): string {
  return TECH_DEFS[id].desc;
}

const UNIT_NAMES: Record<UnitTypeId, string> = {
  [UnitTypeId.serf]: 'Serf',
  [UnitTypeId.worker]: 'Worker',
  [UnitTypeId.knight]: 'Knight',
  [UnitTypeId.spearman]: 'Spearman',
  [UnitTypeId.archer]: 'Archer',
  [UnitTypeId.bandit]: 'Bandit',
  [UnitTypeId.banditArcher]: 'Bandit Archer',
  [UnitTypeId.marauder]: 'Marauder',
};

export function unitName(unit: UnitTypeId): string {
  return UNIT_NAMES[unit];
}

/**
 * Plurals, spelled out rather than suffixed: the selection card names a
 * squad of one kind as what it is ("6 Spearmen"), and an -s on the end of
 * every name gets that one wrong. `n` of 1 gives the singular back, so the
 * caller can hand over whatever it happens to be holding.
 */
const UNIT_PLURALS: Record<UnitTypeId, string> = {
  [UnitTypeId.serf]: 'Serfs',
  [UnitTypeId.worker]: 'Workers',
  [UnitTypeId.knight]: 'Knights',
  [UnitTypeId.spearman]: 'Spearmen',
  [UnitTypeId.archer]: 'Archers',
  [UnitTypeId.bandit]: 'Bandits',
  [UnitTypeId.banditArcher]: 'Bandit Archers',
  [UnitTypeId.marauder]: 'Marauders',
};

export function unitNamePlural(unit: UnitTypeId, n: number): string {
  return n === 1 ? UNIT_NAMES[unit] : UNIT_PLURALS[unit];
}

const GOOD_NAMES: Record<GoodId, string> = {
  [GoodId.water]: 'Water',
  [GoodId.wheat]: 'Wheat',
  [GoodId.wood]: 'Wood',
  [GoodId.stone]: 'Stone',
  [GoodId.iron]: 'Iron',
  [GoodId.silver]: 'Silver',
  [GoodId.gold]: 'Gold',
  [GoodId.sword]: 'Sword',
  [GoodId.spear]: 'Spear',
  [GoodId.bow]: 'Bow',
  [GoodId.ale]: 'Ale',
  [GoodId.flour]: 'Flour',
  [GoodId.food]: 'Food',
  [GoodId.axe]: 'Axe',
  [GoodId.pickaxe]: 'Pickaxe',
  [GoodId.scythe]: 'Scythe',
  [GoodId.hammer]: 'Hammer',
  [GoodId.cauldron]: 'Cauldron',
  [GoodId.rod]: 'Fishing Rod',
};

export function goodName(good: GoodId): string {
  return GOOD_NAMES[good];
}

/**
 * Who a seat is, in the words the rest of the game already uses for them:
 * an AI by the playbook it was dealt — the same name its heralds announce
 * it under — a human rival by its number, and the raiders by the one name
 * they answer to.
 *
 * Only a spectator asks. A live match's cards are all your own things, so
 * nothing there ever prints a seat's name; a replay's cards may be
 * anybody's, and a card that does not say whose is a card about a village
 * the player cannot place.
 */
export function seatName(
  owner: number,
  players: readonly PlayerSnap[],
): string {
  if (!isPlayerOwner(owner)) return 'Bandits';
  const strategy = players.find(p => p.id === owner)?.strategy;
  // A seat with no playbook is a person: either an opponent in a recorded
  // multiplayer match, or — before the deal existed — an AI from an older
  // save. Numbered from one, the way the seats are counted out loud.
  if (strategy === undefined) return `Player ${owner + 1}`;
  const name = AI_STRATEGIES[strategy].name;
  // Two seats can hold the same playbook: ?bots=abbot,abbot names it
  // twice, and a lobby can pick it twice (the deal itself never repeats
  // one — four playbooks cover MAX_PLAYERS seats). The name alone then
  // points at two villages, and a card, a chip or a herald that says "The
  // Abbot" says nothing. The seat number tells them apart, counted the
  // same way a person's is above.
  const twins = players.some(p => p.id !== owner && p.strategy === strategy);
  return twins ? `${name} (seat ${owner + 1})` : name;
}
