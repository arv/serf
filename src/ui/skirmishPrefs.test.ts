import {afterEach, describe, expect, it, vi} from 'vitest';
import * as DifficultyIdNs from '../sim/defs/difficultyEnum.ts';
import {
  DEFAULT_SKIRMISH_PREFS,
  loadSkirmishPrefs,
  parseSkirmishPrefs,
  saveSkirmishPrefs,
  serializeSkirmishPrefs,
} from './skirmishPrefs';

/** What the menu offers today; the ceiling the parse clamps against. */
const MAX = 3;

/** A localStorage that only these tests can see. */
function stubLocalStorage(
  seed: Record<string, string> = {},
): Map<string, string> {
  const store = new Map(Object.entries(seed));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe('parseSkirmishPrefs', () => {
  it('reads a well-formed record', () => {
    expect(
      parseSkirmishPrefs(
        '{"v":1,"ai":3,"difficulty":"hard","bandits":false}',
        MAX,
      ),
    ).toEqual({
      v: 1,
      ai: 3,
      difficulty: DifficultyIdNs.hard,
      bandits: false,
    });
  });

  it('garbage, absence and version drift all read as defaults', () => {
    for (const raw of [
      null,
      '',
      'not json',
      '{"v":2,"ai":0,"difficulty":"hard"}',
      '[]',
    ]) {
      expect(parseSkirmishPrefs(raw, MAX), String(raw)).toEqual(
        DEFAULT_SKIRMISH_PREFS,
      );
    }
  });

  it('takes each field it can read and defaults only the rest', () => {
    expect(parseSkirmishPrefs('{"v":1,"ai":0}', MAX)).toEqual({
      ...DEFAULT_SKIRMISH_PREFS,
      ai: 0,
    });
    expect(parseSkirmishPrefs('{"v":1,"difficulty":"easy"}', MAX)).toEqual({
      ...DEFAULT_SKIRMISH_PREFS,
      difficulty: DifficultyIdNs.easy,
    });
    expect(parseSkirmishPrefs('{"v":1,"bandits":false}', MAX)).toEqual({
      ...DEFAULT_SKIRMISH_PREFS,
      bandits: false,
    });
  });

  it('clamps a seat count no pill on the screen could select', () => {
    // A record from a build that offered more seats, or a hand-edited one:
    // the row would light no pill and launch a number nobody chose.
    expect(parseSkirmishPrefs('{"v":1,"ai":7}', MAX).ai).toBe(MAX);
    expect(parseSkirmishPrefs('{"v":1,"ai":-2}', MAX).ai).toBe(0);
    expect(parseSkirmishPrefs('{"v":1,"ai":1.6}', MAX).ai).toBe(2);
    expect(parseSkirmishPrefs('{"v":1,"ai":"two"}', MAX).ai).toBe(
      DEFAULT_SKIRMISH_PREFS.ai,
    );
    expect(parseSkirmishPrefs('{"v":1,"ai":null}', MAX).ai).toBe(
      DEFAULT_SKIRMISH_PREFS.ai,
    );
  });

  it('refuses a tier the sim would not honour', () => {
    expect(
      parseSkirmishPrefs('{"v":1,"difficulty":"brutal"}', MAX).difficulty,
    ).toBe(DEFAULT_SKIRMISH_PREFS.difficulty);
  });

  it('returns a fresh object every time — callers mutate their copy', () => {
    const a = parseSkirmishPrefs(null, MAX);
    a.ai = 0;
    expect(parseSkirmishPrefs(null, MAX).ai).toBe(DEFAULT_SKIRMISH_PREFS.ai);
  });
});

describe('serializeSkirmishPrefs', () => {
  it('spells the tier as its key, not its number', () => {
    expect(
      JSON.parse(
        serializeSkirmishPrefs({
          v: 1,
          ai: 1,
          difficulty: DifficultyIdNs.easy,
          bandits: true,
        }),
      ),
    ).toEqual({v: 1, ai: 1, difficulty: 'easy', bandits: true});
  });

  it('round-trips every choice the rows can make', () => {
    for (const ai of [0, 1, 2, 3]) {
      for (const difficulty of [
        DifficultyIdNs.easy,
        DifficultyIdNs.normal,
        DifficultyIdNs.hard,
      ]) {
        for (const bandits of [true, false]) {
          const prefs = {v: 1, ai, difficulty, bandits} as const;
          expect(
            parseSkirmishPrefs(serializeSkirmishPrefs(prefs), MAX),
          ).toEqual(prefs);
        }
      }
    }
  });
});

describe('the stored record', () => {
  it('survives the trip through storage', () => {
    stubLocalStorage();
    saveSkirmishPrefs({
      v: 1,
      ai: 3,
      difficulty: DifficultyIdNs.hard,
      bandits: false,
    });
    expect(loadSkirmishPrefs(MAX)).toEqual({
      v: 1,
      ai: 3,
      difficulty: DifficultyIdNs.hard,
      bandits: false,
    });
  });

  it('reads as defaults where there is no storage at all', () => {
    // Node has no localStorage, so the bare read throws rather than
    // answering null — the same shape as a browser that denies it.
    expect(loadSkirmishPrefs(MAX)).toEqual(DEFAULT_SKIRMISH_PREFS);
  });

  it('a storage that throws costs the memory, never the choice', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(() =>
      saveSkirmishPrefs({
        v: 1,
        ai: 1,
        difficulty: DifficultyIdNs.easy,
        bandits: true,
      }),
    ).not.toThrow();
    expect(loadSkirmishPrefs(MAX)).toEqual(DEFAULT_SKIRMISH_PREFS);
  });
});
