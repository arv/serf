import { TECH_DEFS, type TechId } from './defs/techs.ts';
import { buildingDef } from './defs/buildings.ts';
import type { UnitTypeId } from './defs/units.ts';
import type { Owner } from './entities.ts';
import type { World } from './world.ts';
import { BuildingTypeId } from './defs/buildings.ts';
import { ModifierKey } from './defs/techs.ts';
import { TechEffectKind } from './defs/techs.ts';

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
      if (effect.kind === TechEffectKind.modifier && effect.key === key) m *= effect.multiplier;
    }
  }
  if (key === ModifierKey.workSpeed && techs.festivalTicksLeft > 0) m *= 1.25;
  return m;
}

export function isBuildingUnlocked(world: World, owner: Owner, type: BuildingTypeId): boolean {
  const req = buildingDef(type).requiresTech;
  if (req === undefined) return true;
  const researched = world.players[owner]?.techs.researched ?? [];
  // An array means any one of them opens the door (the weaponsmith comes
  // with ironworking or archery, whichever lands first).
  return Array.isArray(req) ? req.some((t) => researched.includes(t)) : researched.includes(req);
}

/** Units named by an unlockUnit effect are gated; everything else is free. */
export function isUnitUnlocked(world: World, owner: Owner, unit: UnitTypeId): boolean {
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
): { ok: boolean; reason?: string } {
  const t = world.players[owner]?.techs;
  if (!t) return { ok: false, reason: 'no such player' };
  if (t.researched.includes(tech)) return { ok: false, reason: 'already researched' };
  if (t.active) return { ok: false, reason: 'research in progress' };
  const def = TECH_DEFS[tech];
  for (const p of def.prereqs) {
    if (!t.researched.includes(p)) return { ok: false, reason: `requires ${TECH_DEFS[p].name}` };
  }
  let hasAbbey = false;
  for (const b of world.buildings.values()) {
    if (!b.dead && b.type === BuildingTypeId.abbey && b.state === 'built' && b.owner === owner) {
      hasAbbey = true;
      break;
    }
  }
  if (!hasAbbey) return { ok: false, reason: 'needs a built Abbey' };
  return { ok: true };
}
