import { describe, expect, it } from 'vitest';
import { ADVICE_RANGES, parseAdvice, toOverride } from './advice.ts';

/**
 * The advice parser stands between a language model and the AI brain, so
 * what is covered here is the hostile half: replies that are not JSON,
 * numbers outside their ranges, keys off the whitelist, prototype tricks —
 * everything a model (or whoever is prompting it) could send must come out
 * as either clamped knobs or nothing.
 */

describe('parseAdvice', () => {
  it('refuses what does not parse, and what parses to a non-object', () => {
    expect(parseAdvice('')).toBeNull();
    expect(parseAdvice('marching at dawn')).toBeNull();
    expect(parseAdvice('{"armyAttackSize": 8')).toBeNull(); // truncated mid-reply
    expect(parseAdvice('null')).toBeNull();
    expect(parseAdvice('42')).toBeNull();
    expect(parseAdvice('[{"armyAttackSize": 8}]')).toBeNull();
  });

  it('keeps valid knobs and rounds them to integers', () => {
    const advice = parseAdvice('{"armyAttackSize": 9.6, "prefersRivals": true}');
    expect(advice).toEqual({ armyAttackSize: 10, prefersRivals: true });
  });

  it('clamps every numeric knob into its published range', () => {
    for (const [key, [min, max]] of Object.entries(ADVICE_RANGES)) {
      expect(parseAdvice(`{"${key}": ${min - 100}}`)).toEqual({ [key]: min });
      expect(parseAdvice(`{"${key}": ${max + 100}}`)).toEqual({ [key]: max });
    }
  });

  it('drops knobs that are the wrong type instead of guessing', () => {
    expect(parseAdvice('{"armyAttackSize": "seven"}')).toEqual({});
    expect(parseAdvice('{"armyAttackSize": null}')).toEqual({});
    expect(parseAdvice('{"prefersRivals": "yes"}')).toEqual({});
    expect(parseAdvice('{"serfTarget": 1e999}')).toEqual({}); // Infinity after parse
  });

  it('strips keys off the whitelist, build order and prototype tricks included', () => {
    const advice = parseAdvice(
      JSON.stringify({
        build: [{ type: 'castle', count: 9 }],
        researchOrder: ['everything'],
        __proto__: { armyAttackSize: 99 },
        constructor: 'nonesuch',
        armyAttackSize: 8,
      }),
    );
    expect(advice).toEqual({ armyAttackSize: 8 });
    // And the trick left no mark on anything downstream of the parse.
    expect(({} as Record<string, unknown>)['armyAttackSize']).toBeUndefined();
  });

  it('filters trainPreference to real soldiers, deduplicated, never empty', () => {
    expect(parseAdvice('{"trainPreference": ["archer", "serf", "archer", "knight"]}')).toEqual({
      trainPreference: ['archer', 'knight'],
    });
    // A list that filters to nothing would train nothing — dropped instead.
    expect(parseAdvice('{"trainPreference": ["bandit", "dragon"]}')).toEqual({});
    expect(parseAdvice('{"trainPreference": "knight"}')).toEqual({});
  });

  it('keeps weaponMix only when every entry is a recipe index', () => {
    expect(parseAdvice('{"weaponMix": [1, 0, 5]}')).toEqual({ weaponMix: [1, 0, 2] });
    expect(parseAdvice('{"weaponMix": [1, "sword"]}')).toEqual({});
    expect(parseAdvice('{"weaponMix": []}')).toEqual({});
    // Length capped at the three smiths the mix can address.
    expect(parseAdvice('{"weaponMix": [0, 1, 2, 1, 0]}')).toEqual({ weaponMix: [0, 1, 2] });
  });

  it('truncates the reason and keeps it out of the override', () => {
    const advice = parseAdvice(`{"reason": "${'x'.repeat(500)}", "homeGuard": 5}`)!;
    expect(advice.reason).toHaveLength(200);
    expect(toOverride(advice)).toEqual({ homeGuard: 5 });
  });

  it('treats an empty reply as "change nothing", not as garbage', () => {
    expect(parseAdvice('{}')).toEqual({});
    expect(toOverride({})).toEqual({});
  });
});
