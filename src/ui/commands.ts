import { BUILDING_DEFS } from '../sim/defs/buildings';
import { TECH_DEFS, type TechId } from '../sim/defs/techs';
import type { GoodAmounts } from '../sim/defs/goods';
import type { BuildingSnap } from '../protocol/messages';
import { HIRE_QUEUE_CAP, HIRE_SERF_COST, TRAIN_QUEUE_CAP } from '../sim/defs/balance';
import { GoodId } from '../sim/defs/goods';
import { UnitTypeId } from '../sim/defs/units';
import { BuildingTypeId } from '../sim/defs/buildings';

/**
 * The commands a selected building offers: who may run them, and which
 * letter runs them.
 *
 * The same arrangement buildMenu.ts has for the build ribbon, and for the
 * same reason. A shortcut that fires where the button is greyed out is a
 * second, more permissive command panel — the order goes to the sim, the
 * sim refuses it, and nothing on screen ever explains why. So the gates are
 * written once, as plain functions of the state they read, and both the
 * button's `disabled` and the key's refusal are spelled from them.
 *
 * These are contextual, exactly as in Warcraft III and StarCraft II: the
 * letters mean what the current selection says they mean. That costs
 * nothing here because a building selection and a unit selection are
 * mutually exclusive — with a barracks open there is no squad for A to
 * attack-move, so A is free to be the Archer.
 */

/** Which tech gates a trainable unit (mirrors unlockUnit effects). */
export function unitTechGate(unit: UnitTypeId): TechId | undefined {
  for (const def of Object.values(TECH_DEFS)) {
    for (const e of def.effects) {
      if (e.kind === 'unlockUnit' && e.unit === unit) return def.id;
    }
  }
  return undefined;
}

/**
 * Word goes out for another serf. `queued` is what keeps this honest: a
 * recruit paid for and still walking holds a bed the head count cannot see
 * yet, and the sim's own gate counts them.
 */
export function canHire(
  b: BuildingSnap,
  stock: GoodAmounts,
  pop: { pop: number; cap: number },
): boolean {
  if (b.type !== BuildingTypeId.storehouse || b.state !== 'built') return false;
  const queued = b.hireQueue ?? 0;
  return (
    (stock[GoodId.silver] ?? 0) >= HIRE_SERF_COST && queued < HIRE_QUEUE_CAP && pop.pop + queued < pop.cap
  );
}

/**
 * Put a recruit in the drill queue. Deliberately silent about the
 * ingredients: nothing is spent until training starts, so an order for a
 * sword the smith has not forged yet is a legitimate thing to queue, and
 * the button does not refuse it either.
 */
export function canTrain(
  b: BuildingSnap,
  unit: UnitTypeId,
  researched: readonly TechId[],
): boolean {
  if (b.state !== 'built') return false;
  const gate = unitTechGate(unit);
  if (gate !== undefined && !researched.includes(gate)) return false;
  return (b.trainQueue?.length ?? 0) < TRAIN_QUEUE_CAP;
}

/**
 * Letters for the recruits a building drills. First letters throughout —
 * the three of them start differently, which is the whole trick — and each
 * one lives in its own unit's name so the button can bold it in place.
 */
export const TRAIN_KEYS: Partial<Record<UnitTypeId, string>> = {
  [UnitTypeId.knight]: 'K',
  [UnitTypeId.spearman]: 'S',
  [UnitTypeId.archer]: 'A',
};

export function trainKey(unit: UnitTypeId): string {
  return TRAIN_KEYS[unit] ?? '';
}

/** The unit a letter drills at this building, or null for a stray key. */
export function trainingForKey(b: BuildingSnap, letter: string): UnitTypeId | null {
  const want = letter.toUpperCase();
  for (const option of BUILDING_DEFS[b.type].trains ?? []) {
    if (trainKey(option.unit) === want) return option.unit;
  }
  return null;
}

/** Hire a serf, at the storehouse that is selected. */
export const HIRE_KEY = 'H';

/**
 * Arm the rally flag, at the barracks that is selected: the next click on
 * the map plants it, and fresh soldiers march there as they step out of
 * the door. Y so it can live inside its own word (Rall**y**) — R belongs
 * to Research, which stays reachable with a barracks open.
 */
export const RALLY_KEY = 'Y';

/** May this building fly a rally flag at all? A type-level question — the
 * same one the sim asks (only buildings that train take one). */
export function canRally(b: BuildingSnap): boolean {
  return b.state === 'built' && BUILDING_DEFS[b.type].trains !== undefined;
}

/**
 * Open the tech tree. The one command here that is not contextual: the
 * tree is a sheet to read, not an order to give, and a player who wants to
 * check what Masonry costs should not first have to find their abbey. It
 * still wears its letter on the abbey's own Research button, which is
 * where someone is most likely to be looking for it.
 */
export const RESEARCH_KEY = 'R';
