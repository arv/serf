import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP_SIZE, tileCount } from '../shared/grid';
import { envelopeSave, splitSave, unpackExplored } from './saveEnvelope';

const TILES = tileCount(DEFAULT_MAP_SIZE);

describe('the solo save envelope', () => {
  it('round-trips the world string and the explored grid', () => {
    const explored = new Uint8Array(TILES).map((_, i) => (i % 3 === 0 ? 1 : 0));
    const world = JSON.stringify({ tick: 123, units: [] });
    const { world: back, explored: packed } = splitSave(envelopeSave(world, explored));
    expect(back).toBe(world);
    // The split hands back the still-packed grid — the tile count is only
    // known later, so unpacking is the caller's move.
    expect(typeof packed).toBe('string');
    expect(unpackExplored(packed!, TILES)).toEqual(explored);
  });

  it('passes a legacy raw save through untouched, fog unseeded', () => {
    const legacy = JSON.stringify({ tick: 5, units: [], buildings: [] });
    expect(splitSave(legacy)).toEqual({ world: legacy });
  });

  it('is not fooled by world JSON that happens to have a world field', () => {
    const impostor = JSON.stringify({ world: 'nope', tick: 9 });
    expect(splitSave(impostor)).toEqual({ world: impostor });
  });

  it('keeps the world when the fog bits are corrupt', () => {
    const world = '{"tick":1}';
    const saved = JSON.parse(envelopeSave(world, new Uint8Array(TILES))) as {
      explored: string;
    };
    saved.explored = '!!!not-base64!!!';
    const { world: back, explored } = splitSave(JSON.stringify({ ...saved }));
    expect(back).toBe(world);
    // The corrupt string rides through the split untouched; the unpack is
    // where it fails — softly, so the world is never lost to bad fog.
    expect(unpackExplored(explored!, TILES)).toBeUndefined();
  });

  it('survives non-JSON input entirely', () => {
    expect(splitSave('garbage')).toEqual({ world: 'garbage' });
  });
});
