import { describe, expect, it } from 'vitest';
import { configFromUrl } from './gameConfig';

/**
 * The start screen speaks to the game entirely through the query string, so
 * these are the contract between the menu and boot(). Every launch URL the
 * menu can produce is covered here.
 */
describe('configFromUrl', () => {
  it('defaults to a solo sandbox with bandits on', () => {
    const c = configFromUrl('');
    expect(c.players).toEqual([{ kind: 'human' }]);
    expect(c.banditsEnabled).toBe(true);
    expect(c.seed).toBe(20260724);
  });

  it('reads ?bandits=0 — and only that exact value', () => {
    expect(configFromUrl('?bandits=0').banditsEnabled).toBe(false);
    expect(configFromUrl('?bandits=1').banditsEnabled).toBe(true);
    // Absent means on: the menu omits the param when the toggle is left alone.
    expect(configFromUrl('?ai=2&seed=5').banditsEnabled).toBe(true);
  });

  it('builds the skirmish the menu asks for', () => {
    const c = configFromUrl('?ai=2&seed=1234');
    expect(c.seed).toBe(1234);
    expect(c.players).toEqual([{ kind: 'human' }, { kind: 'ai' }, { kind: 'ai' }]);
    expect(c.myPlayerId).toBe(0);
  });

  it('caps computer opponents at the three the menu offers', () => {
    expect(configFromUrl('?ai=3').players).toHaveLength(4);
    expect(configFromUrl('?ai=9').players).toHaveLength(4);
    expect(configFromUrl('?ai=-1').players).toEqual([{ kind: 'human' }]);
  });

  it('names the opponents ?bots asks for, seat by seat', () => {
    const c = configFromUrl('?ai=3&bots=warlord,,abbot');
    expect(c.players.map((p) => p.strategy)).toEqual([undefined, 'warlord', undefined, 'abbot']);
    // No param at all: every opponent is left to the seed's deal.
    expect(configFromUrl('?ai=2').players.map((p) => p.strategy)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    // A playbook nobody has heard of names nothing — it never reaches the
    // world as a strategy id.
    expect(configFromUrl('?ai=1&bots=nonesuch').players[1]!.strategy).toBeUndefined();
  });

  it('ignores junk rather than booting a broken world', () => {
    expect(configFromUrl('?ai=abc').players).toEqual([{ kind: 'human' }]);
    // A NaN seed used to reach worldgen and produce nonsense.
    expect(configFromUrl('?seed=abc').seed).toBe(20260724);
    expect(configFromUrl('?seed=').seed).toBe(20260724);
  });

  it('reads ?llm=1, but only where there is an opponent to advise', () => {
    expect(configFromUrl('?ai=2&llm=1').llmOpponent).toBe(true);
    expect(configFromUrl('?ai=2').llmOpponent).toBe(false);
    expect(configFromUrl('?ai=2&llm=yes').llmOpponent).toBe(false);
    // A sandbox has no AI seats: a strategist with nobody to advise stays
    // off however the URL asks.
    expect(configFromUrl('?llm=1').llmOpponent).toBe(false);
  });
});
