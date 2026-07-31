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

  it('ignores junk rather than booting a broken world', () => {
    expect(configFromUrl('?ai=abc').players).toEqual([{ kind: 'human' }]);
    // A NaN seed used to reach worldgen and produce nonsense.
    expect(configFromUrl('?seed=abc').seed).toBe(20260724);
    expect(configFromUrl('?seed=').seed).toBe(20260724);
  });
});
