/**
 * Saved replays live in the origin-private file system, one JSON file per
 * match under /replays, named by the datetime the replay was saved
 * ("2026-08-12 14.03.05.json"). OPFS rather than localStorage on purpose: a
 * long match's command log is far past the quota a few strings share, and
 * files can be listed, streamed and deleted individually.
 *
 * Every function here tolerates the API being absent (older browsers,
 * non-secure contexts): saving reports failure, listing answers empty —
 * the menu then simply has no replays to offer.
 */

import { readReplayVersion } from './replay';

const DIR = 'replays';
const EXT = '.json';

export interface ReplayFileInfo {
  /** The display name — the filename without its extension. */
  name: string;
  size: number;
  lastModified: number;
  /** The REPLAY_VERSION the file was recorded under; undefined when its
   * head doesn't say (a truncated or foreign file). Only a build carrying
   * the same number can play it back. */
  replayVersion?: number;
}

async function replaysDir(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(DIR, { create });
  } catch {
    // Without `create`, a missing directory lands here too: no replays yet.
    return null;
  }
}

/** Keep names to what replayName() mints — plus the collision suffix below
 * — since a filename also arrives as user-adjacent input (the ?replay= URL
 * param on playback). */
function fileNameFor(name: string): string | null {
  if (name.length === 0 || name.length > 64) return null;
  if (!/^[\w .()-]+$/.test(name)) return null;
  return name + EXT;
}

/**
 * Name of the lock that serializes saves. OPFS has no exclusive-create —
 * `getFileHandle({create:true})` opens whatever is there — so picking a
 * free name and writing it are two steps that a second save can interleave
 * with, both seeing the same name free and the later write winning. Web
 * Locks closes that across every tab of this origin, which is the whole
 * surface OPFS is shared over.
 */
const SAVE_LOCK = 'serf-replay-save';

/**
 * Write one replay under `name`, or under "name (2)" and so on when that
 * file already exists — the datetime names carry seconds only, so two
 * saves in one second (a double-click on the end card, or two tabs) must
 * land as two files rather than the second silently overwriting the
 * first. Returns the name actually used, or null when OPFS is
 * unavailable.
 */
export async function saveReplayFile(name: string, data: string): Promise<string | null> {
  const dir = await replaysDir(true);
  if (!dir) return null;
  const write = async (): Promise<string | null> => {
    for (let attempt = 1; attempt <= 9; attempt++) {
      const candidate = attempt === 1 ? name : `${name} (${attempt})`;
      const fileName = fileNameFor(candidate);
      if (!fileName) return null;
      try {
        await dir.getFileHandle(fileName);
        continue; // taken — try the next suffix
      } catch {
        // Not there: this name is free.
      }
      try {
        const handle = await dir.getFileHandle(fileName, { create: true });
        const writable = await handle.createWritable();
        await writable.write(data);
        await writable.close();
        return candidate;
      } catch {
        return null;
      }
    }
    return null; // nine saves in one second is not a hand on a button
  };
  // Without Web Locks (older browsers), the check-then-write above is
  // still the best available: unserialized, it is exactly the behavior
  // this lock exists to improve on, not a reason to refuse the save.
  return navigator.locks ? navigator.locks.request(SAVE_LOCK, write) : write();
}

/** Every saved replay, newest first. */
export async function listReplayFiles(): Promise<ReplayFileInfo[]> {
  const dir = await replaysDir(false);
  if (!dir) return [];
  const out: ReplayFileInfo[] = [];
  try {
    for await (const handle of dir.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith(EXT)) continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      // The version stamp sits in the file's head by construction; half a
      // KB per row keeps the listing cheap however long the logs get.
      const head = await file.slice(0, 512).text();
      const replayVersion = readReplayVersion(head);
      out.push({
        name: handle.name.slice(0, -EXT.length),
        size: file.size,
        lastModified: file.lastModified,
        ...(replayVersion !== undefined ? { replayVersion } : {}),
      });
    }
  } catch {
    return [];
  }
  // The names are datetimes, so this is also chronological — but the file
  // clock is the tiebreak for any hand-copied file that isn't one.
  out.sort((a, b) => b.name.localeCompare(a.name) || b.lastModified - a.lastModified);
  return out;
}

/** One replay's JSON, or null when it isn't there. */
export async function readReplayFile(name: string): Promise<string | null> {
  const fileName = fileNameFor(name);
  if (!fileName) return null;
  const dir = await replaysDir(false);
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(fileName);
    const file = await handle.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

export async function deleteReplayFile(name: string): Promise<void> {
  const fileName = fileNameFor(name);
  if (!fileName) return;
  const dir = await replaysDir(false);
  if (!dir) return;
  try {
    await dir.removeEntry(fileName);
  } catch {
    // Already gone — the menu refreshes its list either way.
  }
}
