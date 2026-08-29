import {DEFAULT_SEED} from '../protocol/lobby';
import {parseStrategyId} from '../sim/defs/aiStrategies';
import {parseMissionId} from '../sim/defs/missions';
import * as PlayerKind from '../sim/playerKindEnum.ts';
import {missionWorldConfig, type WorldConfig} from '../sim/world';

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
  // ?mission=<id>: a campaign mission. The def is the whole recipe — its
  // pinned seed and seats win over any stray ?seed/?ai in the URL. An
  // unknown id is no id (the URL is hand-editable); the ordinary parsing
  // below then applies.
  const mission = parseMissionId(params.get('mission'));
  if (mission) {
    return {...missionWorldConfig(mission), myPlayerId: 0, adminEnabled: true};
  }
  // A non-numeric seed used to reach createWorld as NaN and generate a
  // broken world; fall back instead. The menu only ever sends digits, but
  // the URL is hand-editable.
  const parsedSeed = Number(params.get('seed'));
  const seed =
    Number.isFinite(parsedSeed) && params.get('seed')
      ? parsedSeed
      : DEFAULT_SEED;

  // ?size=N: grid side in tiles. Same hand-editable-URL hygiene as ?seed —
  // non-numeric falls back to the default, and createWorld clamps the rest
  // to [MIN_MAP_SIZE, MAX_MAP_SIZE].
  const parsedSize = Number(params.get('size'));
  const mapSize =
    Number.isFinite(parsedSize) && params.get('size') ? parsedSize : undefined;

  // ?ai=N: skirmish vs N computer opponents (seat 0 = you). ?players=N is
  // the dev testbed: N human seats, the extras sitting inert.
  const aiParam = Number(params.get('ai') ?? '0');
  const aiSeats = Math.max(
    0,
    Math.min(3, Number.isFinite(aiParam) ? aiParam : 0),
  );
  const playersParam = Number(params.get('players') ?? '1');
  const seats = Math.max(
    1,
    Math.min(4, Number.isFinite(playersParam) ? playersParam : 1),
  );
  // ?bots=warlord,,abbot names the opponents seat by seat; a blank or
  // unknown entry (and the whole param, absent) leaves that seat to the
  // seed's deal. Order matches the opponent seats, which start at 1.
  const bots = (params.get('bots') ?? '').split(',');
  const players: WorldConfig['players'] =
    aiSeats > 0
      ? [
          {kind: PlayerKind.human},
          ...Array.from({length: aiSeats}, (_, i) => ({
            kind: PlayerKind.ai,
            strategy: parseStrategyId(bots[i]),
          })),
        ]
      : Array.from({length: seats}, () => ({kind: PlayerKind.human}));

  return {
    seed,
    players,
    ...(mapSize !== undefined ? {mapSize} : {}),
    myPlayerId: 0,
    adminEnabled: true, // solo modes keep the sandbox switches live
    // ?bandits=0 turns the neutral hostiles off (the start screen's toggle).
    banditsEnabled: params.get('bandits') !== '0',
  };
}
