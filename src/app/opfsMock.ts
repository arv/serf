/**
 * An in-memory stand-in for the origin-private file system, for the tests
 * around fileStore and the two stores built on it. Test scaffolding: it is
 * imported by *.test.ts only, and nothing the game ships reaches it.
 *
 * Only the slice of the API those stores use is here — directories, files,
 * a writable stream and the async iteration a listing does — with the same
 * failure the browser gives for a missing entry, since "not there" is the
 * signal the stores read a free name from.
 */

import { vi } from 'vitest';

interface Entry {
  text: string;
  lastModified: number;
}

function missing(name: string): Error {
  const err = new Error(`${name} not found`);
  err.name = 'NotFoundError';
  return err;
}

export interface OpfsMock {
  /** Everything in one directory, as name → text. */
  dump(dir: string): Record<string, string>;
  /** Put a file there without going through a store. */
  put(dir: string, name: string, text: string, lastModified?: number): void;
}

/**
 * Install the mock as navigator.storage for the current test file; vitest's
 * stub is undone by `vi.unstubAllGlobals()`. The clock a file is stamped
 * with counts up rather than reading the wall clock, so a listing's tiebreak
 * is deterministic.
 */
export function installOpfs(extra: Record<string, unknown> = {}): OpfsMock {
  const dirs = new Map<string, Map<string, Entry>>();
  let clock = 1_000_000;

  const fileHandle = (dir: Map<string, Entry>, name: string) => ({
    kind: 'file' as const,
    name,
    getFile: () => {
      const entry = dir.get(name);
      if (!entry) throw missing(name);
      return new File([entry.text], name, { lastModified: entry.lastModified });
    },
    createWritable: () => {
      let buffer = '';
      return Promise.resolve({
        write: (chunk: string) => {
          buffer += chunk;
          return Promise.resolve();
        },
        close: () => {
          dir.set(name, { text: buffer, lastModified: clock++ });
          return Promise.resolve();
        },
      });
    },
  });

  const dirHandle = (dirName: string, dir: Map<string, Entry>) => ({
    kind: 'directory' as const,
    name: dirName,
    getFileHandle: (name: string, opts?: { create?: boolean }) => {
      if (!dir.has(name) && !opts?.create) throw missing(name);
      return Promise.resolve(fileHandle(dir, name));
    },
    removeEntry: (name: string) => {
      if (!dir.delete(name)) throw missing(name);
      return Promise.resolve();
    },
    values: async function* () {
      for (const name of [...dir.keys()]) yield fileHandle(dir, name);
    },
  });

  const root = {
    getDirectoryHandle: (name: string, opts?: { create?: boolean }) => {
      let dir = dirs.get(name);
      if (!dir) {
        if (!opts?.create) throw missing(name);
        dir = new Map();
        dirs.set(name, dir);
      }
      return Promise.resolve(dirHandle(name, dir));
    },
  };

  vi.stubGlobal('navigator', {
    storage: { getDirectory: () => Promise.resolve(root) },
    ...extra,
  });

  return {
    dump: (name) =>
      Object.fromEntries(
        [...(dirs.get(name) ?? new Map<string, Entry>())].map(([k, v]) => [k, v.text]),
      ),
    put: (dirName, name, text, lastModified) => {
      let dir = dirs.get(dirName);
      if (!dir) dirs.set(dirName, (dir = new Map()));
      dir.set(name, { text, lastModified: lastModified ?? clock++ });
    },
  };
}
