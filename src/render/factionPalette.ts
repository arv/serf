import { BANDIT, MAX_PLAYERS } from '../sim/entities';

/**
 * Faction colors, drawn from the KayKit atlas's own palette so tinted
 * surfaces sit in-style with everything around them:
 * green #008454, red #d22227, blue #257ebc, gold #f9aa4e.
 *
 * The hexagon pack reserves one atlas swatch per building for team color
 * (its green/red/blue/yellow variants differ only in that slot, and only
 * by grey value) — we recolor that exact slot per owner instead, which is
 * what makes rival castles read at a glance. Bandits keep the stock grey.
 */
const PLAYER_COLORS: readonly number[] = [0x008454, 0xd22227, 0x257ebc, 0xf9aa4e];

/** Faction color for an owner, or undefined to keep the stock look. */
export function factionTint(owner: number): number | undefined {
  if (owner === BANDIT || owner >= MAX_PLAYERS) return undefined;
  return PLAYER_COLORS[owner];
}

/**
 * The atlas region KayKit reserves for team color, in UV space (one cell of
 * the 8x4 swatch grid). Triangles whose UVs land here get the faction
 * material; measured from the pack by diffing its color variants.
 */
export const TEAM_SWATCH_UV = { u0: 0.375, u1: 0.5, v0: 0.75, v1: 1.0 };
