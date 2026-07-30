import { BANDIT, MAX_PLAYERS } from '../sim/entities';

/**
 * Faction colors. Seat 0 keeps the packs' stock look (the classic solo
 * palette — green banners, undyed cloth); seats 1-3 get a cloth/roof tint
 * lerp. Bandits read as a faction through their unit kinds and the red
 * camp tower, so they carry no extra tint here.
 */
const PLAYER_COLORS: readonly number[] = [
  0x000000, // seat 0: untinted (never read)
  0xa5504a, // crimson
  0xc9a53e, // gold
  0x6a5aa5, // violet
];

/** Tint for an owner's cloth/roofs, or undefined for "leave stock colors". */
export function factionTint(owner: number): number | undefined {
  if (owner === 0 || owner === BANDIT || owner >= MAX_PLAYERS) return undefined;
  return PLAYER_COLORS[owner];
}

/** UI accent color for an owner (toasts, swatches). Seat 0 gets the green
 * the stock assets already read as. */
export function factionAccent(owner: number): number {
  if (owner === 0) return 0x4a8a5a;
  if (owner === BANDIT) return 0x5a5148;
  return PLAYER_COLORS[owner] ?? 0x888888;
}
