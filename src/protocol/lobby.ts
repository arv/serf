/**
 * The lobby's match settings — the wire contract between the War Council
 * screen and the relay. Dependency-free like net.ts so the server, the
 * client and vitest all load it as-is.
 *
 * The host tunes these in the waiting room, every seat watches them change
 * live, and the server builds the world from its own sanitized copy when
 * the host starts the match. Nothing here is trusted off the wire:
 * sanitizeLobbyConfig is the single gate, applied both to the create
 * message and to every later adjustment.
 */

import { DEFAULT_MAP_SIZE, MAX_MAP_SIZE, MIN_MAP_SIZE } from '../shared/grid.ts';

export interface LobbyConfig {
  /** Computer seats to fill at match start. Fillers, not reservations: a
   * human joining always takes priority, so the AI only gets the chairs
   * still empty when the host begins. */
  ai: number;
  /** Neutral hostiles harass the roads. */
  bandits: boolean;
  /** Worldgen seed — same seed, same valley. */
  seed: number;
  /** Grid side in tiles — same size, same valley footprint. The waiting
   * room has no picker for it yet; until it grows one this stays the
   * default, but the wire contract already carries and sanitizes it. */
  size: number;
  /**
   * Which playbook each computer seat runs, in the order they fill the
   * table. A null (or a short list) leaves that seat to the seed's deal,
   * which is the default — the host picks an opponent only when they want
   * a particular one. Ids are validated against the sim's table, so this
   * cannot name a playbook that does not exist.
   */
  bots: (string | null)[];
}

/** Seats at the table, humans and AI together. The world only has start
 * layouts for one through four players. */
export const MAX_SEATS = 4;

/** The default valley, shared with the start screen and configFromUrl.
 * Kept in step with winnable.test.ts's pinned seed: the map every new
 * player boots into carries the standing guarantee that it can be won. */
export const DEFAULT_SEED = 17;

export function defaultLobbyConfig(): LobbyConfig {
  return { ai: 0, bandits: true, seed: DEFAULT_SEED, size: DEFAULT_MAP_SIZE, bots: [] };
}

/**
 * Overlay an untrusted patch onto a known-good config. Unknown fields are
 * dropped, wrong-typed fields are ignored, numbers are clamped — a hostile
 * client can pick any legal settings, never an illegal world.
 */
export function sanitizeLobbyConfig(base: LobbyConfig, patch: unknown): LobbyConfig {
  const out = { ...base };
  if (typeof patch !== 'object' || patch === null) return out;
  const p = patch as Record<string, unknown>;
  if (typeof p.ai === 'number' && Number.isFinite(p.ai)) {
    out.ai = Math.max(0, Math.min(MAX_SEATS - 1, Math.floor(p.ai)));
  }
  if (typeof p.bandits === 'boolean') out.bandits = p.bandits;
  if (typeof p.seed === 'number' && Number.isFinite(p.seed)) {
    // Same coercion the old start message used: any finite number becomes
    // a deterministic int32, so every seat derives the identical world.
    out.seed = p.seed | 0;
  }
  if (typeof p.size === 'number' && Number.isFinite(p.size)) {
    // Even, like resolveMapSize: the world builder rounds odd sizes down,
    // and the lobby must display the size the match will actually use.
    out.size = Math.max(MIN_MAP_SIZE, Math.min(MAX_MAP_SIZE, Math.floor(p.size))) & ~1;
  }
  if (Array.isArray(p.bots)) {
    // Shape only: a name this file has never heard of is not an error, it
    // just fails to name a playbook when the world is built, and that seat
    // takes the seed's deal. Kept dependency-free on purpose — the sim's
    // table of playbooks is not something the wire contract should import.
    out.bots = p.bots
      .slice(0, MAX_SEATS)
      .map((b) => (typeof b === 'string' && b.length <= 24 ? b : null));
  }
  return out;
}
