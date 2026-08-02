import { DEFAULT_SEED } from '../protocol/lobby';
import { parseStrategyId } from '../sim/defs/aiStrategies';
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
  // A non-numeric seed used to reach createWorld as NaN and generate a
  // broken world; fall back instead. The menu only ever sends digits, but
  // the URL is hand-editable.
  const parsedSeed = Number(params.get('seed'));
  const seed = Number.isFinite(parsedSeed) && params.get('seed') ? parsedSeed : DEFAULT_SEED;

  // ?ai=N: skirmish vs N computer opponents (seat 0 = you). ?players=N is
  // the dev testbed: N human seats, the extras sitting inert.
  const aiParam = Number(params.get('ai') ?? '0');
  const aiSeats = Math.max(0, Math.min(3, Number.isFinite(aiParam) ? aiParam : 0));
  const playersParam = Number(params.get('players') ?? '1');
  const seats = Math.max(1, Math.min(4, Number.isFinite(playersParam) ? playersParam : 1));
  // ?bots=warlord,,abbot names the opponents seat by seat; a blank or
  // unknown entry (and the whole param, absent) leaves that seat to the
  // seed's deal. Order matches the opponent seats, which start at 1.
  const bots = (params.get('bots') ?? '').split(',');
  const players: WorldConfig['players'] =
    aiSeats > 0
      ? [
          { kind: 'human' },
          ...Array.from({ length: aiSeats }, (_, i) => ({
            kind: 'ai' as const,
            strategy: parseStrategyId(bots[i]),
          })),
        ]
      : Array.from({ length: seats }, () => ({ kind: 'human' as const }));

  return {
    seed,
    players,
    myPlayerId: 0,
    adminEnabled: true, // solo modes keep the sandbox switches live
    // ?bandits=0 turns the neutral hostiles off (the start screen's toggle).
    banditsEnabled: params.get('bandits') !== '0',
  };
}
