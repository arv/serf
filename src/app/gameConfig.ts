import {DEFAULT_SEED} from '../protocol/lobby';
import {parseStrategyId} from '../sim/defs/aiStrategies';
import {
  DIFFICULTY_KEYS,
  type DifficultyId,
  parseDifficultyId,
} from '../sim/defs/difficulty.ts';
import * as DifficultyIdNs from '../sim/defs/difficultyEnum.ts';
import {
  MISSION_KEYS,
  type MissionId,
  parseMissionId,
} from '../sim/defs/missions';
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

/**
 * The URL that launches a commission — the writing half of the ?mission
 * parameter configFromUrl reads below, spelled once so the two halves
 * cannot drift. Both launch sites (the campaign list's Play, the end
 * card's Continue) go through here.
 *
 * The key, not the id. A mission is a number inside the sim but a word in
 * the query string, and parseMissionId's string branch knows only the
 * words: '?mission=' + the raw id named no mission at all, so a
 * commission launched as an ordinary skirmish — pinned seed gone, no
 * briefing card, no objectives checklist.
 */
export function missionUrl(id: MissionId, difficulty?: DifficultyId): string {
  const tier =
    difficulty && difficulty !== DifficultyIdNs.normal
      ? `&difficulty=${DIFFICULTY_KEYS[difficulty]}`
      : '';
  return `?mission=${MISSION_KEYS[id]}${tier}`;
}

export function configFromUrl(search: string): GameConfig {
  const params = new URLSearchParams(search);
  // ?mission=<name>: a campaign mission, named (missionUrl above writes
  // the name; the id is a number and reads as nothing here). The def is
  // the whole recipe — its pinned seed and seats win over any stray
  // ?seed/?ai in the URL. An unknown name is no mission (the URL is
  // hand-editable); the ordinary parsing below then applies.
  // ?difficulty=easy|normal|hard. On a commission it scales the opening
  // the crown grants you — larder, hands, and the peace before the first
  // raid; in a skirmish it is how well the computer seats play, and
  // nobody's larder moves. An unknown word is `normal`, the printed game.
  const difficulty = parseDifficultyId(params.get('difficulty'));
  const mission = parseMissionId(params.get('mission'));
  if (mission) {
    return {
      ...missionWorldConfig(mission),
      ...(difficulty ? {difficulty} : {}),
      myPlayerId: 0,
      adminEnabled: true,
    };
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
    ...(difficulty ? {difficulty} : {}),
    ...(mapSize !== undefined ? {mapSize} : {}),
    myPlayerId: 0,
    adminEnabled: true, // solo modes keep the sandbox switches live
    // ?bandits=0 turns the neutral hostiles off (the start screen's toggle).
    banditsEnabled: params.get('bandits') !== '0',
  };
}
