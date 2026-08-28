import { FESTIVAL_DURATION } from '../defs/balance.ts';
import { TECH_DEFS } from '../defs/techs.ts';
import { type World } from '../world.ts';
import type { Building, Owner } from '../entities.ts';
import { GoodId } from '../defs/goods.ts';
import { BuildingTypeId } from '../defs/buildings.ts';
import { TechEffectKind } from '../defs/techs.ts';
import { TechId } from '../defs/techs.ts';
import { BuildingState } from '../entities.ts';

/**
 * Ticks every player's active research and festival buff. Research is
 * *started* by the research command (tick.ts); completion applies one-shot
 * effects here (currently just paving — unlock checks read `researched`
 * directly).
 */
export function researchSystem(world: World): void {
  // Each owner's first built abbey (the only one the old per-player scan
  // ever touched — it broke after the first match), gathered lazily in one
  // pass instead of a full building scan per player per tick.
  let abbeys: Map<Owner, Building> | undefined;
  const abbeyOf = (owner: Owner): Building | undefined => {
    if (!abbeys) {
      abbeys = new Map();
      for (const b of world.buildings.values()) {
        if (!b.dead && b.type === BuildingTypeId.abbey && b.state === BuildingState.built && !abbeys.has(b.owner)) {
          abbeys.set(b.owner, b);
        }
      }
    }
    return abbeys.get(owner);
  };

  for (const p of world.players) {
    const t = p.techs;

    if (t.active) {
      t.active.ticksLeft--;
      if (t.active.ticksLeft <= 0) {
        const def = TECH_DEFS[t.active.tech];
        t.researched.push(def.id);
        for (const effect of def.effects) {
          if (effect.kind === TechEffectKind.unlockPaving) p.pavingUnlocked = true;
        }
        t.active = undefined;
      }
    }

    if (t.festivalTicksLeft > 0) {
      t.festivalTicksLeft--;
      continue;
    }

    // Festivals: this player's built abbey burns 1 ale for a buff.
    if (!t.researched.includes(TechId.festivals)) continue;
    const abbey = abbeyOf(p.id);
    if (abbey && (abbey.inputs[GoodId.ale] ?? 0) > 0) {
      abbey.inputs[GoodId.ale] = (abbey.inputs[GoodId.ale] ?? 0) - 1;
      world.ledger.consumed[GoodId.ale] = (world.ledger.consumed[GoodId.ale] ?? 0) + 1;
      t.festivalTicksLeft = FESTIVAL_DURATION;
    }
  }
}
