import type { WorldConfig } from '../sim/world';

/**
 * Everything a client needs to boot a game: the world recipe plus which
 * seat this client plays. Today it comes from the URL; the multiplayer
 * lobby will hand over the same shape.
 */
export interface GameConfig extends WorldConfig {
  myPlayerId: number;
}

export function configFromUrl(search: string): GameConfig {
  const params = new URLSearchParams(search);
  const seedParam = params.get('seed');
  const seed = seedParam ? Number(seedParam) : 20260724;

  // Dev testbed: ?players=N boots an N-seat world (extra seats sit inert
  // until the AI or the lobby fills them). ?ai=1 arrives with the AI phase.
  const playersParam = Number(params.get('players') ?? '1');
  const seats = Math.max(1, Math.min(4, Number.isFinite(playersParam) ? playersParam : 1));
  const players = Array.from({ length: seats }, () => ({ kind: 'human' as const }));

  return {
    seed,
    players,
    myPlayerId: 0,
    adminEnabled: true, // solo modes keep the sandbox switches live
    banditsEnabled: true,
  };
}
