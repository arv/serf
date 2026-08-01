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

export interface LobbyConfig {
  /** Computer seats to fill at match start. Fillers, not reservations: a
   * human joining always takes priority, so the AI only gets the chairs
   * still empty when the host begins. */
  ai: number;
  /** Neutral hostiles harass the roads. */
  bandits: boolean;
  /** Worldgen seed — same seed, same valley. */
  seed: number;
}

/** Seats at the table, humans and AI together. The world only has start
 * layouts for one through four players. */
export const MAX_SEATS = 4;

/** The default valley, shared with the start screen and configFromUrl. */
export const DEFAULT_SEED = 20260724;

export function defaultLobbyConfig(): LobbyConfig {
  return { ai: 0, bandits: true, seed: DEFAULT_SEED };
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
  return out;
}
