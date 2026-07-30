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

  // ?ai=N: skirmish vs N computer opponents (seat 0 = you). ?players=N is
  // the dev testbed: N human seats, the extras sitting inert.
  const aiParam = Number(params.get('ai') ?? '0');
  const aiSeats = Math.max(0, Math.min(3, Number.isFinite(aiParam) ? aiParam : 0));
  const playersParam = Number(params.get('players') ?? '1');
  const seats = Math.max(1, Math.min(4, Number.isFinite(playersParam) ? playersParam : 1));
  const players: { kind: 'human' | 'ai' }[] =
    aiSeats > 0
      ? [{ kind: 'human' }, ...Array.from({ length: aiSeats }, () => ({ kind: 'ai' as const }))]
      : Array.from({ length: seats }, () => ({ kind: 'human' as const }));

  return {
    seed,
    players,
    myPlayerId: 0,
    adminEnabled: true, // solo modes keep the sandbox switches live
    banditsEnabled: true,
  };
}
