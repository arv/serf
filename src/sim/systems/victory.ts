import type { World } from '../world';

/** Destroy the bandit camp to win; lose your storehouse and it's over. */
export function victorySystem(world: World): void {
  if (world.outcome !== 'playing') return;
  let camp = false;
  let storehouse = false;
  for (const b of world.buildings.values()) {
    if (b.dead) continue;
    if (b.type === 'banditCamp') camp = true;
    if (b.type === 'storehouse') storehouse = true;
  }
  if (!storehouse) {
    world.outcome = 'lost';
    world.pendingEvents.push({ kind: 'gameOver', outcome: 'lost' });
  } else if (!camp) {
    world.outcome = 'won';
    world.pendingEvents.push({ kind: 'gameOver', outcome: 'won' });
  }
}
