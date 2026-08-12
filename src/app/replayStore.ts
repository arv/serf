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
  /** The version the replay was recorded on; undefined when the file's
   * head doesn't say (a truncated or foreign file). Only the matching
   * build can play it back. */
  gameVersion?: string;
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

/** Keep names to what replayName() mints — the one place a filename comes
 * from user-adjacent input (the ?replay= URL param on playback). */
function fileNameFor(name: string): string | null {
  if (name.length === 0 || name.length > 64) return null;
  if (!/^[\w .-]+$/.test(name)) return null;
  return name + EXT;
}

/** Write one replay under `name`; false when OPFS is unavailable. */
export async function saveReplayFile(name: string, data: string): Promise<boolean> {
  const fileName = fileNameFor(name);
  if (!fileName) return false;
  const dir = await replaysDir(true);
  if (!dir) return false;
  try {
    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
    return true;
  } catch {
    return false;
  }
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
      const gameVersion = readReplayVersion(head);
      out.push({
        name: handle.name.slice(0, -EXT.length),
        size: file.size,
        lastModified: file.lastModified,
        ...(gameVersion !== undefined ? { gameVersion } : {}),
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
