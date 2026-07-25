import { FESTIVAL_DURATION } from '../defs/balance';
import { TECH_DEFS } from '../defs/techs';
import { type World } from '../world';

/**
 * Ticks the active research and the festival buff. Research is *started* by
 * the research command (tick.ts); completion applies one-shot effects here
 * (currently just paving — unlock checks read `researched` directly).
 */
export function researchSystem(world: World): void {
  const t = world.techs;

  if (t.active) {
    t.active.ticksLeft--;
    if (t.active.ticksLeft <= 0) {
      const def = TECH_DEFS[t.active.tech];
      t.researched.push(def.id);
      for (const effect of def.effects) {
        if (effect.kind === 'unlockPaving') world.pavingUnlocked = true;
      }
      t.active = undefined;
    }
  }

  if (t.festivalTicksLeft > 0) {
    t.festivalTicksLeft--;
    return;
  }

  // Festivals: a built terakoya burns 1 sake for a work-speed buff.
  if (!t.researched.includes('festivals')) return;
  for (const b of world.buildings.values()) {
    if (b.dead || b.type !== 'terakoya' || b.state !== 'built') continue;
    if ((b.inputs.sake ?? 0) > 0) {
      b.inputs.sake = (b.inputs.sake ?? 0) - 1;
      world.ledger.consumed.sake = (world.ledger.consumed.sake ?? 0) + 1;
      t.festivalTicksLeft = FESTIVAL_DURATION;
    }
    break;
  }
}
