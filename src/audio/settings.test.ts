import { describe, expect, it } from 'vitest';
import { audioFromUrl, DEFAULT_PREFS, parseAudioPrefs, volumeToGain } from './settings';

describe('parseAudioPrefs', () => {
  it('reads a well-formed record', () => {
    expect(parseAudioPrefs('{"v":1,"volume":0.5,"muted":true}')).toEqual({
      v: 1,
      volume: 0.5,
      muted: true,
    });
  });

  it('garbage, absence and version drift all read as defaults', () => {
    for (const raw of [null, '', 'not json', '{"v":2,"volume":0.5}', '{"volume":"loud"}', '[]']) {
      expect(parseAudioPrefs(raw), String(raw)).toEqual(DEFAULT_PREFS);
    }
  });

  it('clamps an out-of-range volume instead of trusting it', () => {
    expect(parseAudioPrefs('{"v":1,"volume":7}').volume).toBe(1);
    expect(parseAudioPrefs('{"v":1,"volume":-2}').volume).toBe(0);
    expect(parseAudioPrefs('{"v":1,"volume":null}')).toEqual(DEFAULT_PREFS);
  });

  it('returns a fresh object every time — callers mutate their copy', () => {
    const a = parseAudioPrefs(null);
    a.volume = 0;
    expect(parseAudioPrefs(null).volume).toBe(DEFAULT_PREFS.volume);
  });
});

describe('volumeToGain', () => {
  it('is monotone with fixed ends', () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(1)).toBe(1);
    let prev = -1;
    for (let v = 0; v <= 1.001; v += 0.1) {
      const g = volumeToGain(v);
      expect(g).toBeGreaterThan(prev);
      prev = g;
    }
  });

  it('is perceptual: half slider is well under half gain', () => {
    expect(volumeToGain(0.5)).toBeLessThan(0.3);
  });

  it('clamps outside the slider range', () => {
    expect(volumeToGain(-1)).toBe(0);
    expect(volumeToGain(2)).toBe(1);
  });
});

describe('audioFromUrl', () => {
  it('reads the two flags in the house ?param style', () => {
    expect(audioFromUrl('?mute=1')).toEqual({ mute: true });
    expect(audioFromUrl('?vol=0.4')).toEqual({ volume: 0.4 });
    expect(audioFromUrl('?seed=3&mute=1&vol=0.4')).toEqual({ mute: true, volume: 0.4 });
  });

  it('ignores absence and nonsense', () => {
    expect(audioFromUrl('')).toEqual({});
    expect(audioFromUrl('?seed=3')).toEqual({});
    expect(audioFromUrl('?mute=0')).toEqual({});
    expect(audioFromUrl('?vol=loud')).toEqual({});
  });

  it('clamps a volume from the address bar like any other', () => {
    expect(audioFromUrl('?vol=9')).toEqual({ volume: 1 });
    expect(audioFromUrl('?vol=-3')).toEqual({ volume: 0 });
  });
});
