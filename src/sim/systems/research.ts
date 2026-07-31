import { FESTIVAL_DURATION } from '../defs/balance.ts';
import { TECH_DEFS } from '../defs/techs.ts';
import { type World } from '../world.ts';

/**
 * Ticks every player's active research and festival buff. Research is
 * *started* by the research command (tick.ts); completion applies one-shot
 * effects here (currently just paving — unlock checks read `researched`
 * directly).
 */
export function researchSystem(world: World): void {
  for (const p of world.players) {
    const t = p.techs;

    if (t.active) {
      t.active.ticksLeft--;
      if (t.active.ticksLeft <= 0) {
        const def = TECH_DEFS[t.active.tech];
        t.researched.push(def.id);
        for (const effect of def.effects) {
          if (effect.kind === 'unlockPaving') p.pavingUnlocked = true;
        }
        t.active = undefined;
      }
    }

    if (t.festivalTicksLeft > 0) {
      t.festivalTicksLeft--;
      continue;
    }

    // Festivals: this player's built terakoya burns 1 sake for a buff.
    if (!t.researched.includes('festivals')) continue;
    for (const b of world.buildings.values()) {
      if (b.dead || b.type !== 'terakoya' || b.state !== 'built' || b.owner !== p.id) continue;
      if ((b.inputs.sake ?? 0) > 0) {
        b.inputs.sake = (b.inputs.sake ?? 0) - 1;
        world.ledger.consumed.sake = (world.ledger.consumed.sake ?? 0) + 1;
        t.festivalTicksLeft = FESTIVAL_DURATION;
      }
      break;
    }
  }
}
