import {afterEach, describe, expect, it, vi} from 'vitest';
import {DEFAULT_MAP_SIZE, tileCount} from '../shared/grid';
import {WORLD_SAVE_VERSION} from '../shared/saveVersion';
import * as MissionId from '../sim/defs/missionIdEnum.ts';
import {MISSION_KEYS} from '../sim/defs/missions';
import {installOpfs} from './opfsMock';
import {envelopeSave, type SaveMeta} from './saveEnvelope';
import {
  deleteSaveFile,
  importSaveFile,
  latestSaveName,
  listSaveFiles,
  migrateLegacySave,
  readSaveFile,
  saveGameFile,
} from './saveStore';

const TILES = tileCount(DEFAULT_MAP_SIZE);

/** A save as the match writes one: a world string under a metadata head. */
function save(about: Omit<SaveMeta, 'world'> = {}): string {
  return envelopeSave(
    JSON.stringify({version: WORLD_SAVE_VERSION, world: {tick: 7}}),
    new Uint8Array(TILES),
    about,
  );
}

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

describe('the saves shelf', () => {
  it('files each save as its own document and hands them back newest first', async () => {
    installOpfs();
    expect(await saveGameFile('2026-01-01 09.00.00', save())).toBe(
      '2026-01-01 09.00.00',
    );
    expect(await saveGameFile('2026-01-02 09.00.00', save())).toBe(
      '2026-01-02 09.00.00',
    );
    const found = await listSaveFiles();
    expect(found.map(f => f.name)).toEqual([
      '2026-01-02 09.00.00',
      '2026-01-01 09.00.00',
    ]);
    expect(await latestSaveName()).toBe('2026-01-02 09.00.00');
    // Saving twice no longer paves over the first: both worlds are there.
    expect(await readSaveFile('2026-01-01 09.00.00')).not.toBeNull();
  });

  it('reads each row’s badge out of the file head', async () => {
    installOpfs();
    await saveGameFile(
      'mission',
      save({mission: MISSION_KEYS[MissionId.clearing]}),
    );
    await saveGameFile('skirmish', save({opponents: 3}));
    const byName = new Map((await listSaveFiles()).map(f => [f.name, f.meta]));
    expect(byName.get('mission')).toEqual({
      world: WORLD_SAVE_VERSION,
      mission: MISSION_KEYS[MissionId.clearing],
    });
    expect(byName.get('skirmish')).toEqual({
      world: WORLD_SAVE_VERSION,
      opponents: 3,
    });
  });

  it('lists a save from before the metadata head with nothing to say', async () => {
    const opfs = installOpfs();
    opfs.put(
      'saves',
      'ancient.json',
      JSON.stringify({version: 4, world: {tick: 1}}),
    );
    const [row] = await listSaveFiles();
    expect(row!.name).toBe('ancient');
    expect(row!.meta).toBeUndefined();
    // Nothing to say about the village, but it still says which format
    // wrote it — that much the shelf needs to know whether to offer it.
    expect(row!.world).toBe(4);
  });

  it('reports the format of a save from an older build', async () => {
    // No metadata head, and a world this build cannot read: the row the
    // shelf has to grey out. Offered instead, it took the page down to a
    // blank screen when the worker refused the world.
    const opfs = installOpfs();
    opfs.put(
      'saves',
      'older.json',
      JSON.stringify({fmt: 'serf-save-v2', world: '{"version":3,"world":{}}'}),
    );
    const [row] = await listSaveFiles();
    expect(row!.meta).toBeUndefined();
    expect(row!.world).toBe(3);
  });

  it('deletes one without touching the others', async () => {
    installOpfs();
    await saveGameFile('keep', save());
    await saveGameFile('drop', save());
    await deleteSaveFile('drop');
    expect((await listSaveFiles()).map(f => f.name)).toEqual(['keep']);
  });

  it('files an imported save and refuses a file that is not one', async () => {
    installOpfs();
    const good = await importSaveFile(new File([save()], 'a village.json'));
    expect(good).toEqual({ok: true, name: 'a village'});
    expect(await readSaveFile('a village')).toBe(save());
    expect(
      await importSaveFile(new File(['{"replayVersion":11}'], 'log.json')),
    ).toEqual({
      ok: false,
      reason: 'unrecognized',
    });
    expect(
      await importSaveFile(new File(['not json at all'], 'x.json')),
    ).toEqual({
      ok: false,
      reason: 'unrecognized',
    });
  });

  it('strips the share sheet’s .txt wrapper off an imported name', async () => {
    installOpfs();
    // The sending half wraps a document as text/plain — Chromium's share
    // sheet refuses .json — so arrival must take the wrapper back off,
    // or a shared save refiles as "….txt" instead of under its own name.
    const shared = await importSaveFile(
      new File([save()], '2026-01-03 10.00.00.txt'),
    );
    expect(shared).toEqual({ok: true, name: '2026-01-03 10.00.00'});
    expect(await readSaveFile('2026-01-03 10.00.00')).toBe(save());
  });

  it('files an import whose filename the shelf cannot carry under a datetime', async () => {
    installOpfs();
    const result = await importSaveFile(
      new File([save()], 'saved: 12:04.json'),
    );
    expect(result.ok).toBe(true);
    // Not the dropped name — the stamp minted in its place.
    expect(result.ok && /^\d{4}-\d{2}-\d{2} /.test(result.name)).toBe(true);
  });
});

describe('the village left in the old single save slot', () => {
  it('is filed on the shelf, once, and the slot is cleared', async () => {
    installOpfs();
    const local = stubLocalStorage({'serf-save': save()});
    await migrateLegacySave();
    const found = await listSaveFiles();
    expect(found).toHaveLength(1);
    expect(await readSaveFile(found[0]!.name)).toBe(save());
    expect(local.get('serf-save')).toBeUndefined();
    // A second launch has nothing left to move.
    await migrateLegacySave();
    expect(await listSaveFiles()).toHaveLength(1);
  });

  it('stays put when there is nowhere to file it', async () => {
    vi.stubGlobal('navigator', {});
    const local = stubLocalStorage({'serf-save': save()});
    await migrateLegacySave();
    expect(local.get('serf-save')).toBe(save());
  });

  it('does nothing when there is no old save', async () => {
    installOpfs();
    stubLocalStorage();
    await migrateLegacySave();
    expect(await listSaveFiles()).toEqual([]);
  });
});
