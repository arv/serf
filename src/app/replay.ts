// Explicit .ts extensions: the server compiles this file too (it records
// multiplayer replays), and node/nodenext resolution insists on them the
// way the rest of the shared sim tree already does.
import { sanitizeCommand } from '../sim/commands.ts';
import type { PlayerCommand } from '../sim/tick.ts';
import type { WorldConfig } from '../sim/world.ts';
import type { AiStrategy } from '../sim/defs/aiStrategies.ts';

/**
 * A replay is the sim's whole diet, written down: the world recipe (and the
 * save it booted from, if any) plus every outside command stamped with the
 * tick it was applied on. The sim is deterministic — same world, same
 * commands at the same ticks, same match — so nothing else needs storing:
 * the AI seats re-decide from the world exactly as they did live, and only
 * the two nondeterministic inflows (the player's orders and the LLM
 * strategist's advice) ride the log.
 *
 * Recorded in the sim worker (single player only — multiplayer's world
 * lives on the server), saved to OPFS by the main thread, played back by
 * booting the same worker with the log instead of a live command stream.
 */

export const REPLAY_FORMAT = 'serf-replay-v1';

/** Player commands applied on one tick (AI commands are re-derived, not stored). */
export interface ReplayCommandEntry {
  tick: number;
  commands: PlayerCommand[];
}

/** One strategist consultation landing on a seat, at the tick it landed. */
export interface ReplayAdviceEntry {
  tick: number;
  playerId: number;
  override: Partial<AiStrategy>;
}

export interface ReplayData {
  format: typeof REPLAY_FORMAT;
  /** When the replay was saved (informational only). */
  savedAt?: string;
  /** The config the worker booted with. Carries myPlayerId when the match
   * was launched from a GameConfig, so playback watches the same seat. */
  config: WorldConfig & { myPlayerId?: number };
  /** The serialized world the match booted from, when it was a loaded save. */
  loadData?: string;
  /** Ascending by tick. */
  commands: ReplayCommandEntry[];
  /** Ascending by tick. */
  advice: ReplayAdviceEntry[];
  /** Where the recording stopped; playback pauses here. */
  endTick: number;
}

export function serializeReplay(data: ReplayData): string {
  return JSON.stringify(data);
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

  const advice: ReplayAdviceEntry[] = [];
  if (Array.isArray(d.advice)) {
    for (const entry of d.advice as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as { tick?: unknown; playerId?: unknown; override?: unknown };
      if (!isTick(e.tick)) continue;
      if (typeof e.playerId !== 'number' || !Number.isInteger(e.playerId)) continue;
      if (typeof e.override !== 'object' || e.override === null) continue;
      advice.push({
        tick: e.tick,
        playerId: e.playerId,
        override: e.override as Partial<AiStrategy>,
      });
    }
  }

  // The worker walks both logs with a cursor, so order is a correctness
  // property of the file — restate it rather than trust it.
  commands.sort((a, b) => a.tick - b.tick);
  advice.sort((a, b) => a.tick - b.tick);

  return {
    format: REPLAY_FORMAT,
    ...(typeof d.savedAt === 'string' ? { savedAt: d.savedAt } : {}),
    config: config as ReplayData['config'],
    ...(typeof d.loadData === 'string' ? { loadData: d.loadData } : {}),
    commands,
    advice,
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
