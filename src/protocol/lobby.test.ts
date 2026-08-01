import { describe, expect, it } from 'vitest';
import { MAX_SEATS, defaultLobbyConfig, sanitizeLobbyConfig } from './lobby';

/**
 * The lobby config sanitizer is the trust boundary for match settings: the
 * host's create message and every later adjustment pass through it before
 * the server builds a world from the result.
 */
describe('sanitizeLobbyConfig', () => {
  const base = defaultLobbyConfig();

  it('applies a legal patch field by field', () => {
    const out = sanitizeLobbyConfig(base, { ai: 2, bandits: false, seed: 123456 });
    expect(out).toEqual({ ai: 2, bandits: false, seed: 123456 });
  });

  it('keeps the base where the patch is silent', () => {
    expect(sanitizeLobbyConfig(base, { bandits: false })).toEqual({ ...base, bandits: false });
    expect(sanitizeLobbyConfig(base, {})).toEqual(base);
  });

  it('never mutates the base', () => {
    const before = { ...base };
    sanitizeLobbyConfig(base, { ai: 3, bandits: false, seed: 9 });
    expect(base).toEqual(before);
  });

  it('shrugs off non-object patches', () => {
    for (const junk of [undefined, null, 42, 'ai=3', [1, 2, 3], true]) {
      expect(sanitizeLobbyConfig(base, junk)).toEqual(base);
    }
  });

  it('ignores wrong-typed fields instead of failing the whole patch', () => {
    const out = sanitizeLobbyConfig(base, { ai: '3', bandits: 'yes', seed: NaN });
    expect(out).toEqual(base);
  });

  it('clamps AI seats to the chairs that exist', () => {
    expect(sanitizeLobbyConfig(base, { ai: 99 }).ai).toBe(MAX_SEATS - 1);
    expect(sanitizeLobbyConfig(base, { ai: -5 }).ai).toBe(0);
    expect(sanitizeLobbyConfig(base, { ai: 2.9 }).ai).toBe(2);
  });

  it('coerces any finite seed to a deterministic int32', () => {
    expect(sanitizeLobbyConfig(base, { seed: 1.7 }).seed).toBe(1);
    expect(sanitizeLobbyConfig(base, { seed: 2 ** 40 }).seed).toBe((2 ** 40) | 0);
    expect(sanitizeLobbyConfig(base, { seed: Infinity }).seed).toBe(base.seed);
  });
});
