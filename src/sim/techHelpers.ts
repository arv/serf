import { TECH_DEFS, type ModifierKey, type TechId } from './defs/techs';
import { buildingDef, type BuildingTypeId } from './defs/buildings';
import type { UnitTypeId } from './defs/units';
import type { World } from './world';

/**
 * All tech effects are read through these three functions, so sim systems
 * never inspect tech defs directly.
 */

/** Product of all researched multipliers for a key (plus the festival buff). */
export function getModifier(world: World, key: ModifierKey): number {
  let m = 1;
  for (const id of world.techs.researched) {
    for (const effect of TECH_DEFS[id].effects) {
      if (effect.kind === 'modifier' && effect.key === key) m *= effect.multiplier;
    }
  }
  if (key === 'workSpeed' && world.techs.festivalTicksLeft > 0) m *= 1.25;
  return m;
}

export function isBuildingUnlocked(world: World, type: BuildingTypeId): boolean {
  const req = buildingDef(type).requiresTech;
  return req === undefined || world.techs.researched.includes(req);
}

/** Units named by an unlockUnit effect are gated; everything else is free. */
export function isUnitUnlocked(world: World, unit: UnitTypeId): boolean {
  for (const def of Object.values(TECH_DEFS)) {
    for (const effect of def.effects) {
      if (effect.kind === 'unlockUnit' && effect.unit === unit) {
        return world.techs.researched.includes(def.id);
      }
    }
  }
  return true;
}

export function canResearch(world: World, tech: TechId): { ok: boolean; reason?: string } {
  const t = world.techs;
  if (t.researched.includes(tech)) return { ok: false, reason: 'already researched' };
  if (t.active) return { ok: false, reason: 'research in progress' };
  const def = TECH_DEFS[tech];
  for (const p of def.prereqs) {
    if (!t.researched.includes(p)) return { ok: false, reason: `requires ${TECH_DEFS[p].name}` };
  }
  let hasTerakoya = false;
  for (const b of world.buildings.values()) {
    if (!b.dead && b.type === 'terakoya' && b.state === 'built') {
      hasTerakoya = true;
      break;
    }
  }
  if (!hasTerakoya) return { ok: false, reason: 'needs a built Terakoya' };
  return { ok: true };
}
