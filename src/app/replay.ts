// Explicit .ts extensions: the server compiles this file too (it records
// multiplayer replays), and node/nodenext resolution insists on them the
// way the rest of the shared sim tree already does.
import { sanitizeCommand } from '../sim/commands.ts';
import type { PlayerCommand } from '../sim/tick.ts';
import type { WorldConfig } from '../sim/world.ts';

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
  config: WorldConfig & { myPlayerId?: number };
  /** The serialized world the match booted from, when it was a loaded save. */
  loadData?: string;
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
  const m = /"replayVersion":(\d{1,9})\b/.exec(raw.slice(0, 512));
  return m ? Number(m[1]) : undefined;
}

function isTick(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
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
  if (typeof d.replayVersion !== 'number' || !Number.isInteger(d.replayVersion)) return null;
  const config = d.config;
  if (typeof config !== 'object' || config === null) return null;
  if (typeof (config as { seed?: unknown }).seed !== 'number') return null;
  if (!Array.isArray((config as { players?: unknown }).players)) return null;
  if (!isTick(d.endTick)) return null;

  const commands: ReplayCommandEntry[] = [];
  if (Array.isArray(d.commands)) {
    for (const entry of d.commands as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as { tick?: unknown; commands?: unknown };
      if (!isTick(e.tick) || !Array.isArray(e.commands)) continue;
      const screened: PlayerCommand[] = [];
      for (const pc of e.commands as unknown[]) {
        if (typeof pc !== 'object' || pc === null) continue;
        const { playerId, cmd } = pc as { playerId?: unknown; cmd?: unknown };
        if (typeof playerId !== 'number' || !Number.isInteger(playerId)) continue;
        const clean = sanitizeCommand(cmd);
        if (clean) screened.push({ playerId, cmd: clean });
      }
      if (screened.length > 0) commands.push({ tick: e.tick, commands: screened });
    }
  }

  // The worker walks the log with a cursor, so order is a correctness
  // property of the file — restate it rather than trust it.
  commands.sort((a, b) => a.tick - b.tick);

  return {
    format: REPLAY_FORMAT,
    replayVersion: d.replayVersion,
    ...(typeof d.savedAt === 'string' ? { savedAt: d.savedAt } : {}),
    config: config as ReplayData['config'],
    ...(typeof d.loadData === 'string' ? { loadData: d.loadData } : {}),
    commands,
    endTick: d.endTick,
  };
}

/** "2026-08-12 14.03.05" — the datetime is the replay's name. Dots rather
 * than colons in the time: the name doubles as a filename. */
export function replayName(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`
  );
}
