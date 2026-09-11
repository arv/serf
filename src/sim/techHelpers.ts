import type {Enum} from '../shared/enum.ts';
import * as BuildingState from './buildingStateEnum.ts';
import {FESTIVAL_SPEEDUP} from './defs/balance.ts';
import {buildingDef} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as ModifierKey from './defs/modifierKeyEnum.ts';
import * as TechEffectKind from './defs/techEffectKindEnum.ts';
import {TECH_DEFS, type TechId} from './defs/techs.ts';
import type {UnitTypeId} from './defs/units.ts';
import type {Building, Owner} from './entities.ts';
import type {World} from './world.ts';

type BuildingTypeId = Enum<typeof BuildingTypeId>;
type ModifierKey = Enum<typeof ModifierKey>;

/**
 * All tech effects are read through these functions, so sim systems never
 * inspect tech defs directly. Techs are per-player: every helper takes the
 * owner whose research state applies. BANDIT (no player entry) gets the
 * unmodified baseline.
 */

/** Product of all researched multipliers for a key — plus the festival, which
 * rides two keys at once: the village's work and its soldiers' fighting
 * (FESTIVAL_SPEEDUP). A tech may feed `fightSpeed` through an ordinary
 * modifier effect; the festival is the one source of it today. */
export function getModifier(
  world: World,
  owner: Owner,
  key: ModifierKey,
): number {
  const techs = world.players[owner]?.techs;
  if (!techs) return 1;
  let m = 1;
  for (const id of techs.researched) {
    for (const effect of TECH_DEFS[id].effects) {
      if (effect.kind === TechEffectKind.modifier && effect.key === key)
        m *= effect.multiplier;
    }
  }
  if (
    (key === ModifierKey.workSpeed || key === ModifierKey.fightSpeed) &&
    techs.festivalTicksLeft > 0
  )
    m *= FESTIVAL_SPEEDUP;
  return m;
}

export function isBuildingUnlocked(
  world: World,
  owner: Owner,
  type: BuildingTypeId,
): boolean {
  const req = buildingDef(type).requiresTech;
  if (req === undefined) return true;
  const researched = world.players[owner]?.techs.researched ?? [];
  // An array means any one of them opens the door (the weaponsmith comes
  // with ironworking or archery, whichever lands first).
  return Array.isArray(req)
    ? req.some(t => researched.includes(t))
    : researched.includes(req);
}

/** Units named by an unlockUnit effect are gated; everything else is free. */
export function isUnitUnlocked(
  world: World,
  owner: Owner,
  unit: UnitTypeId,
): boolean {
  for (const def of Object.values(TECH_DEFS)) {
    for (const effect of def.effects) {
      if (effect.kind === TechEffectKind.unlockUnit && effect.unit === unit) {
        return world.players[owner]?.techs.researched.includes(def.id) ?? false;
      }
    }
  }
  return true;
}

export function canResearch(
  world: World,
  owner: Owner,
  tech: TechId,
): {ok: boolean; reason?: string} {
  const t = world.players[owner]?.techs;
  if (!t) return {ok: false, reason: 'no such player'};
  if (t.researched.includes(tech))
    return {ok: false, reason: 'already researched'};
  if (t.active) return {ok: false, reason: 'research in progress'};
  const def = TECH_DEFS[tech];
  for (const p of def.prereqs) {
    if (!t.researched.includes(p))
      return {ok: false, reason: `requires ${TECH_DEFS[p].name}`};
  }
  if (!researchAbbey(world, owner))
    return {ok: false, reason: 'needs a built Abbey'};
  return {ok: true};
}

/**
 * The roof a study is ordered at: this owner's first standing Abbey in
 * world order, which is the same one every time the question is asked.
 *
 * World order is id order here, though it is worth saying why rather than
 * leaving it to look like luck: buildings are only ever appended to the map
 * under a fresh ascending id (placeSite, placeBuiltBuilding) and only ever
 * deleted from it (tick.ts drops the dead), and deleting leaves the rest of
 * a JS Map in place. Nothing is re-inserted, so iteration cannot fall out
 * of id order — and a save round-trips the map in that same order
 * (save.ts). This is the convention findStorehouse and the festival's own
 * abbeyOf already use; a seat with two Abbeys gets the elder one from all
 * three.
 *
 * It is where the bill is carried (systems/logistics.ts) and what the order
 * is pinned to for as long as the goods are on the road.
 */
export function researchAbbey(
  world: World,
  owner: Owner,
): Building | undefined {
  for (const b of world.buildings.values()) {
    if (
      !b.dead &&
      b.type === BuildingTypeId.abbey &&
      b.state === BuildingState.built &&
      b.owner === owner
    ) {
      return b;
    }
  }
  return undefined;
}
