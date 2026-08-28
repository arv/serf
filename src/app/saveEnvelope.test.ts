import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP_SIZE, tileCount } from '../shared/grid';
import { WORLD_SAVE_VERSION } from '../shared/saveVersion';
import {
  envelopeSave,
  looksLikeSave,
  readSaveMeta,
  readSaveWorldVersion,
  splitSave,
  unpackExplored,
} from './saveEnvelope';
import { MissionId, MISSION_KEYS } from '../sim/defs/missions';

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

  it('still splits an envelope from before the metadata head', () => {
    const world = '{"tick":3}';
    const v2 = JSON.stringify({ fmt: 'serf-save-v2', world, explored: '' });
    expect(splitSave(v2).world).toBe(world);
  });
});

describe('the metadata head', () => {
  const explored = new Uint8Array(TILES);

  it('is readable from the first bytes of the file, ahead of the world', () => {
    // The world is the megabyte; the head is what a listing reads, so it
    // has to be complete well inside the slice the shelf takes.
    const raw = envelopeSave(JSON.stringify({ big: 'x'.repeat(4000) }), explored, {
      mission: MISSION_KEYS[MissionId.clearing],
      opponents: 2,
    });
    expect(readSaveMeta(raw.slice(0, 512))).toEqual({
      world: WORLD_SAVE_VERSION,
      mission: MISSION_KEYS[MissionId.clearing],
      opponents: 2,
    });
  });

  it('says only what it was told', () => {
    expect(readSaveMeta(envelopeSave('{}', explored))).toEqual({ world: WORLD_SAVE_VERSION });
  });

  it('is absent from a save that never had one', () => {
    expect(readSaveMeta('{"fmt":"serf-save-v2","world":"{}"}')).toBeUndefined();
    expect(readSaveMeta('')).toBeUndefined();
  });

  it('screens what it hands back — the file is hand-editable', () => {
    // A mission that is not a string, a version that is not a number: the
    // shelf must not be handed either.
    expect(readSaveMeta('{"meta":{"world":4,"mission":7,"opponents":"lots"}}')).toEqual({
      world: 4,
    });
    expect(readSaveMeta('{"meta":{"mission":"clearing"}}')).toBeUndefined();
    expect(readSaveMeta('{"meta":{ nonsense }}')).toBeUndefined();
  });
});

describe('screening a file offered as a save', () => {
  it('takes an envelope, old or new', () => {
    expect(looksLikeSave(envelopeSave('{"tick":1}', new Uint8Array(TILES)))).toBe(true);
    expect(looksLikeSave('{"fmt":"serf-save-v2","world":"{}"}')).toBe(true);
  });

  it('takes a bare world file from before the envelope', () => {
    expect(looksLikeSave('{"version":4,"world":{"tick":1}}')).toBe(true);
  });

  it('refuses everything else', () => {
    expect(looksLikeSave('{"replayVersion":11,"commands":[]}')).toBe(false);
    expect(looksLikeSave('{"fmt":"serf-save-v3"}')).toBe(false);
    expect(looksLikeSave('not json')).toBe(false);
    expect(looksLikeSave('[]')).toBe(false);
  });
});

describe('which format a save was written in', () => {
  const world = JSON.stringify({ version: WORLD_SAVE_VERSION, world: { tick: 1 } });

  it('reads it off the metadata head', () => {
    expect(readSaveWorldVersion(envelopeSave(world, new Uint8Array(TILES)))).toBe(
      WORLD_SAVE_VERSION,
    );
  });

  it('reads it out of the world itself when there is no head', () => {
    // The file a build before the head wrote — and exactly the one that
    // used to be offered on the shelf and then blank the page. The world
    // rides an envelope as an escaped string, version first.
    const old = JSON.stringify({ fmt: 'serf-save-v2', world: '{"version":3,"world":{}}' });
    expect(readSaveWorldVersion(old)).toBe(3);
  });

  it('reads a bare save from before the envelope', () => {
    expect(readSaveWorldVersion('{"version":2,"world":{"tick":1}}')).toBe(2);
  });

  it('answers from the head alone — a listing never holds the whole file', () => {
    const head = envelopeSave(world, new Uint8Array(TILES)).slice(0, 200);
    expect(readSaveWorldVersion(head)).toBe(WORLD_SAVE_VERSION);
    const oldHead = JSON.stringify({
      fmt: 'serf-save-v2',
      world: JSON.stringify({ version: 3, world: { tick: 1, units: [1, 2, 3] } }),
    }).slice(0, 60);
    expect(readSaveWorldVersion(oldHead)).toBe(3);
  });

  it('says nothing about a file that says nothing', () => {
    expect(readSaveWorldVersion('{"fmt":"serf-save-v2","world":"{}"}')).toBeUndefined();
    expect(readSaveWorldVersion('')).toBeUndefined();
  });
});
