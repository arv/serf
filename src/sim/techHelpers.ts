import { TECH_DEFS, type ModifierKey, type TechId } from './defs/techs.ts';
import { buildingDef, type BuildingTypeId } from './defs/buildings.ts';
import type { UnitTypeId } from './defs/units.ts';
import type { Owner } from './entities.ts';
import type { World } from './world.ts';

/**
 * All tech effects are read through these functions, so sim systems never
 * inspect tech defs directly. Techs are per-player: every helper takes the
 * owner whose research state applies. BANDIT (no player entry) gets the
 * unmodified baseline.
 */

/** Product of all researched multipliers for a key (plus the festival buff). */
export function getModifier(world: World, owner: Owner, key: ModifierKey): number {
  const techs = world.players[owner]?.techs;
  if (!techs) return 1;
  let m = 1;
  for (const id of techs.researched) {
    for (const effect of TECH_DEFS[id].effects) {
      if (effect.kind === 'modifier' && effect.key === key) m *= effect.multiplier;
    }
  }
  if (key === 'workSpeed' && techs.festivalTicksLeft > 0) m *= 1.25;
  return m;
}

export function isBuildingUnlocked(world: World, owner: Owner, type: BuildingTypeId): boolean {
  const req = buildingDef(type).requiresTech;
  if (req === undefined) return true;
  return world.players[owner]?.techs.researched.includes(req) ?? false;
}

/** Units named by an unlockUnit effect are gated; everything else is free. */
export function isUnitUnlocked(world: World, owner: Owner, unit: UnitTypeId): boolean {
  for (const def of Object.values(TECH_DEFS)) {
    for (const effect of def.effects) {
      if (effect.kind === 'unlockUnit' && effect.unit === unit) {
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
): { ok: boolean; reason?: string } {
  const t = world.players[owner]?.techs;
  if (!t) return { ok: false, reason: 'no such player' };
  if (t.researched.includes(tech)) return { ok: false, reason: 'already researched' };
  if (t.active) return { ok: false, reason: 'research in progress' };
  const def = TECH_DEFS[tech];
  for (const p of def.prereqs) {
    if (!t.researched.includes(p)) return { ok: false, reason: `requires ${TECH_DEFS[p].name}` };
  }
  let hasTerakoya = false;
  for (const b of world.buildings.values()) {
    if (!b.dead && b.type === 'terakoya' && b.state === 'built' && b.owner === owner) {
      hasTerakoya = true;
      break;
    }
  }
  if (!hasTerakoya) return { ok: false, reason: 'needs a built Terakoya' };
  return { ok: true };
}
