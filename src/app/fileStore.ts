/**
 * The origin-private file system as this game uses it: one directory per
 * kind of document (replays, saved games), one JSON file per document,
 * named by the datetime it was written ("2026-08-12 14.03.05.json").
 *
 * OPFS rather than localStorage on purpose: a long match's command log —
 * or a saved world, which is the whole map plus every unit — is far past
 * the quota a few strings share, and files can be listed, streamed and
 * deleted individually.
 *
 * Every function here tolerates the API being absent (older browsers,
 * non-secure contexts): writing reports failure, listing answers empty —
 * the menu then simply has no documents to offer.
 */

const EXT = '.json';

export interface StoredFileInfo {
  /** The display name — the filename without its extension. */
  name: string;
  size: number;
  lastModified: number;
  /** The OPFS-backed File itself. Lazy — holding it reads nothing — and
   * carried because dragging a row out of the menu must hand the payload
   * over synchronously at dragstart, with no room for an async OPFS
   * round-trip. */
  file: File;
}

/** What became of one file offered to a store's import. */
export type ImportResult =
  | {ok: true; name: string}
  | {ok: false; reason: 'unrecognized' | 'storage'};

export interface FileStore {
  /**
   * Write one document under `name`, or under "name (2)" and so on when
   * that file already exists — the datetime names carry seconds only, so
   * two writes in one second (a double-click on a menu button, or two
   * tabs) must land as two files rather than the second silently
   * overwriting the first. Returns the name actually used, or null when
   * OPFS is unavailable.
   */
  write(name: string, data: string): Promise<string | null>;
  /** Every document in the directory, newest first. */
  list(): Promise<StoredFileInfo[]>;
  /** One document's text, or null when it isn't there. */
  read(name: string): Promise<string | null>;
  remove(name: string): Promise<void>;
  /** Whether a display name can name a file in this store. */
  validName(name: string): boolean;
}

/**
 * The datetime a stored document is named by. Sorts chronologically as a
 * string, and carries no character a filename (or a `DownloadURL` drag
 * triple, which is colon-delimited) would object to.
 */
export function stampName(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`
  );
}

/** Keep names to what stampName() mints — plus the collision suffix below
 * — since a filename also arrives as user-adjacent input (the ?replay= and
 * ?load= URL params). */
function fileNameFor(name: string): string | null {
  if (name.length === 0 || name.length > 64) return null;
  if (!/^[\w .()-]+$/.test(name)) return null;
  return name + EXT;
}

/**
 * One directory of documents. `dir` names it under the OPFS root and also
 * scopes the write lock, so replays and saves never wait on each other.
 */
export function createFileStore(dir: string): FileStore {
  const open = async (
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | null> => {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory)
      return null;
    try {
      const root = await navigator.storage.getDirectory();
      return await root.getDirectoryHandle(dir, {create});
    } catch {
      // Without `create`, a missing directory lands here too: nothing
      // written yet.
      return null;
    }
  };

  /**
   * Name of the lock that serializes writes. OPFS has no exclusive-create
   * — `getFileHandle({create:true})` opens whatever is there — so picking
   * a free name and writing it are two steps that a second write can
   * interleave with, both seeing the same name free and the later write
   * winning. Web Locks closes that across every tab of this origin, which
   * is the whole surface OPFS is shared over.
   */
  const lock = `serf-${dir}-write`;

  return {
    validName: name => fileNameFor(name) !== null,

    async write(name, data) {
      const handle = await open(true);
      if (!handle) return null;
      const attempt = async (): Promise<string | null> => {
        for (let n = 1; n <= 9; n++) {
          const candidate = n === 1 ? name : `${name} (${n})`;
          const fileName = fileNameFor(candidate);
          if (!fileName) return null;
          try {
            await handle.getFileHandle(fileName);
            continue; // taken — try the next suffix
          } catch {
            // Not there: this name is free.
          }
          try {
            const entry = await handle.getFileHandle(fileName, {create: true});
            const writable = await entry.createWritable();
            await writable.write(data);
            await writable.close();
            return candidate;
          } catch {
            return null;
          }
        }
        return null; // nine writes in one second is not a hand on a button
      };
      // Without Web Locks (older browsers), the check-then-write above is
      // still the best available: unserialized, it is exactly the behavior
      // this lock exists to improve on, not a reason to refuse the write.
      return navigator.locks
        ? navigator.locks.request(lock, attempt)
        : attempt();
    },

    async list() {
      const handle = await open(false);
      if (!handle) return [];
      const out: StoredFileInfo[] = [];
      try {
        for await (const entry of handle.values()) {
          if (entry.kind !== 'file' || !entry.name.endsWith(EXT)) continue;
          const file = await (entry as FileSystemFileHandle).getFile();
          out.push({
            name: entry.name.slice(0, -EXT.length),
            size: file.size,
            lastModified: file.lastModified,
            file,
          });
        }
      } catch {
        return [];
      }
      // The names are datetimes, so this is also chronological — but the
      // file clock is the tiebreak for any hand-copied file that isn't one.
      out.sort(
        (a, b) =>
          b.name.localeCompare(a.name) || b.lastModified - a.lastModified,
      );
      return out;
    },

    async read(name) {
      const fileName = fileNameFor(name);
      if (!fileName) return null;
      const handle = await open(false);
      if (!handle) return null;
      try {
        const entry = await handle.getFileHandle(fileName);
        const file = await entry.getFile();
        return await file.text();
      } catch {
        return null;
      }
    },

    async remove(name) {
      const fileName = fileNameFor(name);
      if (!fileName) return;
      const handle = await open(false);
      if (!handle) return;
      try {
        await handle.removeEntry(fileName);
      } catch {
        // Already gone — the menu refreshes its list either way.
      }
    },
  };
}

/** How much of a file's head a listing reads to find its stamp: the
 * documents here put their version and metadata first by construction, and
 * half a KB per row keeps the listing cheap however long the bodies get. */
export const HEAD_BYTES = 512;
