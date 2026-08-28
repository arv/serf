import {afterEach, describe, expect, it, vi} from 'vitest';
import {createFileStore, stampName} from './fileStore';
import {installOpfs} from './opfsMock';

afterEach(() => vi.unstubAllGlobals());

describe('stored file names', () => {
  it('names a document by datetime, filename-safe', () => {
    expect(stampName(new Date(2026, 7, 12, 14, 3, 5))).toBe(
      '2026-08-12 14.03.05',
    );
  });

  it('refuses names a filename (or a drag triple) could not carry', () => {
    const store = createFileStore('things');
    expect(store.validName('2026-08-12 14.03.05')).toBe(true);
    expect(store.validName('a (2)')).toBe(true);
    expect(store.validName('')).toBe(false);
    expect(store.validName('../escape')).toBe(false);
    expect(store.validName('12:03')).toBe(false);
    expect(store.validName('x'.repeat(65))).toBe(false);
  });
});

describe('a file store', () => {
  it('writes, reads back and deletes', async () => {
    const opfs = installOpfs();
    const store = createFileStore('things');
    expect(await store.write('one', 'first')).toBe('one');
    expect(opfs.dump('things')).toEqual({'one.json': 'first'});
    expect(await store.read('one')).toBe('first');
    await store.remove('one');
    expect(await store.read('one')).toBeNull();
    // Deleting again is not an error: the menu refreshes either way.
    await store.remove('one');
  });

  it('suffixes rather than overwrites when the name is taken', async () => {
    installOpfs();
    const store = createFileStore('things');
    expect(await store.write('same', 'a')).toBe('same');
    expect(await store.write('same', 'b')).toBe('same (2)');
    expect(await store.write('same', 'c')).toBe('same (3)');
    expect(await store.read('same')).toBe('a');
    expect(await store.read('same (2)')).toBe('b');
  });

  it('refuses a name it could not file', async () => {
    installOpfs();
    const store = createFileStore('things');
    expect(await store.write('no:colons', 'x')).toBeNull();
  });

  it('lists newest first, and ignores anything that is not ours', async () => {
    const opfs = installOpfs();
    const store = createFileStore('things');
    await store.write('2026-01-01 00.00.00', 'old');
    await store.write('2026-06-01 00.00.00', 'new');
    opfs.put('things', 'notes.txt', 'not a document of ours');
    const found = await store.list();
    expect(found.map(f => f.name)).toEqual([
      '2026-06-01 00.00.00',
      '2026-01-01 00.00.00',
    ]);
    expect(await found[0]!.file.text()).toBe('new');
    expect(found[0]!.size).toBeGreaterThan(0);
  });

  it('reads a name that is not there as nothing at all', async () => {
    installOpfs();
    const store = createFileStore('things');
    expect(await store.read('absent')).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('stands down where the browser has no OPFS', async () => {
    vi.stubGlobal('navigator', {});
    const store = createFileStore('things');
    expect(await store.write('one', 'x')).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(await store.read('one')).toBeNull();
    await store.remove('one'); // no throw
  });

  it('keeps one directory’s writes out of another’s', async () => {
    const opfs = installOpfs();
    await createFileStore('replays').write('name', 'a log');
    await createFileStore('saves').write('name', 'a village');
    expect(opfs.dump('replays')).toEqual({'name.json': 'a log'});
    expect(opfs.dump('saves')).toEqual({'name.json': 'a village'});
  });
});
