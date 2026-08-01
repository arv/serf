import { describe, expect, it } from 'vitest';
import { TILE_COUNT } from '../shared/grid';
import { envelopeSave, splitSave } from './saveEnvelope';

describe('the solo save envelope', () => {
  it('round-trips the world string and the explored grid', () => {
    const explored = new Uint8Array(TILE_COUNT).map((_, i) => (i % 3 === 0 ? 1 : 0));
    const world = JSON.stringify({ tick: 123, units: [] });
    const { world: back, explored: bits } = splitSave(envelopeSave(world, explored));
    expect(back).toBe(world);
    expect(bits).toEqual(explored);
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
    const saved = JSON.parse(envelopeSave(world, new Uint8Array(TILE_COUNT))) as {
      explored: string;
    };
    saved.explored = '!!!not-base64!!!';
    const { world: back, explored } = splitSave(JSON.stringify({ ...saved }));
    expect(back).toBe(world);
    expect(explored).toBeUndefined();
  });

  it('survives non-JSON input entirely', () => {
    expect(splitSave('garbage')).toEqual({ world: 'garbage' });
  });
});
