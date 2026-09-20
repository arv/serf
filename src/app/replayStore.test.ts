import {afterEach, describe, expect, it, vi} from 'vitest';
import {installOpfs} from './opfsMock';

afterEach(() => {
  vi.unstubAllGlobals();
  // The scratch slot keeps its recording in module state as well as on
  // disk, so one test's staging would otherwise answer the next one's read.
  vi.resetModules();
});

/** A fresh instance of the store — a tab that has just booted. */
function freshStore(): Promise<typeof import('./replayStore')> {
  return import('./replayStore');
}

/**
 * OPFS with a Web Locks stand-in beside it — the browser has one, and it
 * is what turns two overlapping writes into two files rather than one:
 * the second takes the lock after the first has already taken the name,
 * so it sees the name as taken and suffixes. Without it the two writes
 * race into the same name and the collision this guards never appears.
 */
function opfsWithLocks(): ReturnType<typeof installOpfs> {
  const tail = new Map<string, Promise<unknown>>();
  return installOpfs({
    locks: {
      request(name: string, fn: () => Promise<unknown>) {
        const queued = (tail.get(name) ?? Promise.resolve()).then(fn, fn);
        tail.set(
          name,
          queued.catch(() => undefined),
        );
        return queued;
      },
    },
  });
}

describe('the scratch replay slot', () => {
  it('hands back what was staged', async () => {
    const opfs = installOpfs();
    const store = await freshStore();
    expect(await store.readStagedReplay()).toBeNull();
    await store.stageReplay('a recording');
    expect(await store.readStagedReplay()).toBe('a recording');
    // Its own directory: the shelf lists /replays, and a match watched
    // back is not a replay the player filed.
    expect(opfs.dump('replays')).toEqual({});
    expect(Object.values(opfs.dump('replay-scratch'))).toEqual(['a recording']);
  });

  it('holds one recording, not a shelf of them', async () => {
    const opfs = installOpfs();
    const store = await freshStore();
    await store.stageReplay('the first match');
    await store.stageReplay('the second match');
    // The file store suffixes rather than overwrites, so staging has to
    // clear the slot first — two files would leave the read on the old one.
    expect(Object.values(opfs.dump('replay-scratch'))).toEqual([
      'the second match',
    ]);
    expect(await store.readStagedReplay()).toBe('the second match');
  });

  it('queues overlapping stagings rather than orphaning a file', async () => {
    const opfs = opfsWithLocks();
    const store = await freshStore();
    // Two clicks on "Watch replay" — the button stays live across the
    // worker round trip. Clearing the slot and writing it are two steps,
    // so unqueued these land as "last match" and "last match (2)", and
    // the suffixed one is a file nothing reads and nothing removes.
    await Promise.all([
      store.stageReplay('the first match'),
      store.stageReplay('the second match'),
    ]);
    expect(Object.keys(opfs.dump('replay-scratch'))).toEqual([
      'last match.json',
    ]);
    expect(await store.readStagedReplay()).toBe('the second match');
  });

  it('comes back off disk in a tab that has forgotten it', async () => {
    installOpfs();
    const store = await freshStore();
    await store.stageReplay('a recording');
    // A reload of ?rewatch: same origin, same OPFS, nothing left in memory.
    vi.resetModules();
    const reloaded = await freshStore();
    expect(await reloaded.readStagedReplay()).toBe('a recording');
  });

  it('stages without OPFS, since the handoff never leaves the tab', async () => {
    vi.stubGlobal('navigator', {});
    const store = await freshStore();
    await store.stageReplay('a recording');
    expect(await store.readStagedReplay()).toBe('a recording');
  });
});
