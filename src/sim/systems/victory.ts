import { buildingDef } from '../defs/buildings.ts';
import { latchObjectives } from './objectives.ts';
import type { Owner } from '../entities.ts';
import type { World } from '../world.ts';
import { BuildingTypeId } from '../defs/buildings.ts';
import { BuildingState } from '../entities.ts';

/**
 * Elimination and match end. A player whose storehouse falls is out; the
 * last faction standing wins. Solo keeps the original campaign objective:
 * raze the bandit camp to win, lose the storehouse and it's over. Bandits
 * are a neutral raid faction in every mode — in multiplayer, razing their
 * camp just stops the raids.
 *
 * A campaign mission with a checklist (world.missionId) replaces the solo
 * win with its own: every objective latched at once. The loss is unchanged
 * — the storehouse is still the elimination token — and a mission with no
 * checklist (the rival-banner bonus) falls through to the ordinary
 * elimination rules.
 */
export function victorySystem(world: World): void {
  if (world.outcome.state !== 'playing') return;

  // One pass over the buildings replaces a full scan per player per tick.
  const hasStorehouse = new Set<Owner>();
  for (const b of world.buildings.values()) {
    if (!b.dead && b.state === BuildingState.built && buildingDef(b.type).storage) {
      hasStorehouse.add(b.owner);
    }
  }
  for (const p of world.players) {
    if (!p.alive) continue;
    if (!hasStorehouse.has(p.id)) {
      p.alive = false;
      world.pendingEvents.push({ kind: 'playerEliminated', player: p.id });
    }
  }

  // Mission checklist first: all objectives latched at once is the win.
  // Only while the human seat still stands — a castle lost on the same
  // tick is a loss, not a photo finish.
  if (world.players[0]?.alive && latchObjectives(world)) {
    endMatch(world, 0);
    return;
  }
  const missionChecklist = (world.objectivesDone?.length ?? 0) > 0;

  const alive = world.players.filter((p) => p.alive);
  if (world.players.length === 1) {
    // Solo campaign: destroy the bandit camp to win. A world generated
    // without bandits has no camp and no objective — a sandbox that only
    // ends if the storehouse falls. A mission checklist replaces this win
    // outright (razing the camp is then just one line on the list).
    let campStands = false;
    for (const b of world.buildings.values()) {
      if (!b.dead && b.type === BuildingTypeId.banditCamp) {
        campStands = true;
        break;
      }
    }
    if (alive.length === 0) endMatch(world, null);
    else if (!missionChecklist && !campStands && world.banditsEnabled) endMatch(world, 0);
  } else if (alive.length <= 1) {
    endMatch(world, alive[0]?.id ?? null);
  }
}

function endMatch(world: World, winner: Owner | null): void {
  world.outcome = { state: 'over', winner };
  world.pendingEvents.push({ kind: 'gameOver', winner });
}
