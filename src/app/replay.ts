// Explicit .ts extensions: the server compiles this file too (it records
// multiplayer replays), and node/nodenext resolution insists on them the
// way the rest of the shared sim tree already does.
import {sanitizeCommand} from '../sim/commands.ts';
import {parseStrategyId} from '../sim/defs/aiStrategies.ts';
import {parseDifficultyId} from '../sim/defs/difficulty.ts';
import {parseMissionId} from '../sim/defs/missions.ts';
import {playerKindFromKey} from '../sim/player.ts';
import type {PlayerCommand} from '../sim/tick.ts';
import type {WorldConfig} from '../sim/world.ts';

/**
 * A replay is the sim's whole diet, written down: the world recipe (and the
 * save it booted from, if any) plus every command that reached the tick —
 * the players' and the AI seats' alike — stamped with the tick it applied
 * on. The sim is deterministic, so that log replays the match exactly.
 *
 * The AI's moves are stored rather than re-derived on purpose: playback
 * never runs the brains at all, so the AI algorithm is free to change
 * between builds without rewriting history. What playback does re-run is
 * the sim itself, and that is version-bound — a tick system tuned in a
 * later build replays yesterday's commands into a different world. Every
 * replay therefore carries the REPLAY_VERSION it was recorded under
 * (shared/replayVersion.ts, whose honesty a hash-pinning test enforces),
 * and playback refuses a file stamped differently rather than diverge
 * silently.
 *
 * Recorded in the sim worker (single player) or on the server (multiplayer
 * — see server/src/rooms.ts), saved to OPFS by the main thread, played
 * back by booting the sim worker with the log instead of a live command
 * stream.
 */

/** What kind of document this is. Unversioned on purpose: compatibility —
 * structural and behavioral alike — is REPLAY_VERSION's whole job. */
export const REPLAY_FORMAT = 'serf-replay';

/** Every command applied on one tick, the AI seats' included. */
export interface ReplayCommandEntry {
  tick: number;
  commands: PlayerCommand[];
}

export interface ReplayData {
  format: typeof REPLAY_FORMAT;
  /** The REPLAY_VERSION this was recorded under. The sim must match
   * tick-for-tick for playback to mean anything, so a replay only plays
   * on a build carrying the same number. */
  replayVersion: number;
  /** When the replay was saved (informational only). */
  savedAt?: string;
  /** The config the worker booted with. Carries myPlayerId when the match
   * was launched from a GameConfig, so playback watches the same seat. */
  config: WorldConfig & {myPlayerId?: number};
  /** The serialized world the match booted from, when it was a loaded save. */
  loadData?: string;
  /**
   * The watching seat's explored grid at that same moment, packed the way
   * a save envelope packs it. Fog is render-side and lives outside the
   * world, so a replay resuming from `loadData` would otherwise start
   * blind and re-darken ground the player had long since scouted — the
   * playback would not look like the match it records. Only meaningful
   * alongside loadData: a replay from tick 0 accumulates its own fog
   * exactly as the live match did.
   */
  explored?: string;
  /** Ascending by tick. */
  commands: ReplayCommandEntry[];
  /** Where the recording stopped; playback pauses here. */
  endTick: number;
}

export function serializeReplay(data: ReplayData): string {
  return JSON.stringify(data);
}

/**
 * The version stamp alone, cheaply, for the menu's shelf — where a dozen
 * files may need labeling and full parses would be waste. Serializers put
 * replayVersion right after format, so the head of the file is enough.
 */
export function readReplayVersion(raw: string): number | undefined {
  // Whitespace-tolerant: our serializers write compactly, but a replay a
  // player pretty-printed by hand is still that replay.
  const m = /"replayVersion"\s*:\s*(\d{1,9})\b/.exec(raw.slice(0, 512));
  return m ? Number(m[1]) : undefined;
}

function isTick(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * Rebuild the config from scratch rather than trust the file's object: a
 * replay in OPFS is hand-editable, and createWorld reads config fields
 * without checking them — a crafted `players: [null]` would crash it, and
 * an unknown mission id would half-apply. Only known fields cross over,
 * each screened. Null means the document cannot describe a world.
 */
function sanitizeConfig(raw: unknown): ReplayData['config'] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.seed !== 'number' || !Number.isFinite(c.seed)) return null;
  // 1..4 seats — the world has no start layout past four.
  if (!Array.isArray(c.players) || c.players.length < 1 || c.players.length > 4)
    return null;
  const players: WorldConfig['players'] = [];
  for (const entry of c.players as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null;
    const kind = (entry as {kind?: unknown}).kind;
    const seat = playerKindFromKey(kind);
    if (seat === undefined) return null;
    // Strategy is decorative on playback (the brains never run — their
    // moves are in the log), so an unknown one degrades to "dealt" rather
    // than sinking the file.
    const strategy = parseStrategyId((entry as {strategy?: unknown}).strategy);
    // The tier is NOT decorative on playback: on a commission it scales
    // the human seat's opening larder, the hands in the yard and the raid
    // clock, so a file that names one has to rebuild the world it was
    // recorded in. An unknown one degrades to `normal`, the printed game.
    const difficulty = parseDifficultyId(
      (entry as {difficulty?: unknown}).difficulty,
    );
    players.push({
      kind: seat,
      ...(strategy ? {strategy} : {}),
      ...(difficulty ? {difficulty} : {}),
    });
  }
  const mission = parseMissionId(c.mission);
  const difficulty = parseDifficultyId(c.difficulty);
  const myPlayerId = c.myPlayerId;
  return {
    seed: c.seed,
    players,
    ...(typeof c.adminEnabled === 'boolean'
      ? {adminEnabled: c.adminEnabled}
      : {}),
    ...(typeof c.banditsEnabled === 'boolean'
      ? {banditsEnabled: c.banditsEnabled}
      : {}),
    ...(mission ? {mission} : {}),
    ...(difficulty ? {difficulty} : {}),
    ...(typeof myPlayerId === 'number' &&
    Number.isInteger(myPlayerId) &&
    myPlayerId >= 0 &&
    myPlayerId < players.length
      ? {myPlayerId}
      : {}),
  };
}

/**
 * Parse and screen a replay file. The file sits in the player's own OPFS,
 * but it is still a hand-editable JSON document feeding the sim directly —
 * so commands go through the same sanitizeCommand screen a network frame
 * would, and anything garbled is dropped rather than crashing the tick.
 * Returns null when the document is not a replay at all.
 */
export function parseReplay(raw: string): ReplayData | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null) return null;
  const d = doc as Record<string, unknown>;
  if (d.format !== REPLAY_FORMAT) return null;
  if (typeof d.replayVersion !== 'number' || !Number.isInteger(d.replayVersion))
    return null;
  const config = sanitizeConfig(d.config);
  if (!config) return null;
  if (!isTick(d.endTick)) return null;

  const commands: ReplayCommandEntry[] = [];
  if (Array.isArray(d.commands)) {
    for (const entry of d.commands as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as {tick?: unknown; commands?: unknown};
      if (!isTick(e.tick) || !Array.isArray(e.commands)) continue;
      const screened: PlayerCommand[] = [];
      for (const pc of e.commands as unknown[]) {
        if (typeof pc !== 'object' || pc === null) continue;
        const {playerId, cmd} = pc as {playerId?: unknown; cmd?: unknown};
        if (typeof playerId !== 'number' || !Number.isInteger(playerId))
          continue;
        const clean = sanitizeCommand(cmd);
        if (clean) screened.push({playerId, cmd: clean});
      }
      if (screened.length > 0)
        commands.push({tick: e.tick, commands: screened});
    }
  }

  // The worker walks the log with a cursor, so order is a correctness
  // property of the file — restate it rather than trust it.
  commands.sort((a, b) => a.tick - b.tick);

  return {
    format: REPLAY_FORMAT,
    replayVersion: d.replayVersion,
    ...(typeof d.savedAt === 'string' ? {savedAt: d.savedAt} : {}),
    config,
    ...(typeof d.loadData === 'string' ? {loadData: d.loadData} : {}),
    // Opaque here: unpacking is the fog's business, and a corrupt grid
    // costs the replay its memory of scouted ground, never its world.
    ...(typeof d.explored === 'string' ? {explored: d.explored} : {}),
    commands,
    endTick: d.endTick,
  };
}
