/**
 * Saved replays: one JSON file per match under the OPFS directory
 * /replays, named by the datetime the replay was saved. The storage
 * mechanics — naming, collision suffixes, listing, deletion — are
 * fileStore's; what lives here is what makes a file a *replay*: the
 * version stamp a row has to show, and the screening an imported file has
 * to pass.
 */

import {
  createFileStore,
  stampName,
  HEAD_BYTES,
  type ImportResult,
  type StoredFileInfo,
} from './fileStore';
import { parseReplay, readReplayVersion } from './replay';

const store = createFileStore('replays');

export interface ReplayFileInfo extends StoredFileInfo {
  /** The REPLAY_VERSION the file was recorded under; undefined when its
   * head doesn't say (a truncated or foreign file). Only a build carrying
   * the same number can play it back. */
  replayVersion?: number;
}

/**
 * Write one replay under `name`, or under "name (2)" and so on when that
 * name is taken. Returns the name actually used, or null when OPFS is
 * unavailable.
 */
export function saveReplayFile(name: string, data: string): Promise<string | null> {
  return store.write(name, data);
}

/**
 * File a replay brought in from outside — the receiving half of sharing,
 * dragging a row out of the shelf being the sending half. The document is
 * screened before a byte lands in OPFS: parseReplay is the same gate
 * playback runs every file through, so anything filed here is at least a
 * replay-shaped document. Its version may still be foreign — the shelf
 * already knows how to show those as unplayable, and a place on the shelf
 * is worth more than a refusal. What gets saved is the raw text, not the
 * parse: playback re-screens on read anyway, and keeping the bytes means
 * a re-export hands back the file that came in.
 */
export async function importReplayFile(file: File): Promise<ImportResult> {
  let raw: string;
  try {
    raw = await file.text();
  } catch {
    return { ok: false, reason: 'storage' };
  }
  if (parseReplay(raw) === null) return { ok: false, reason: 'unrecognized' };
  // Filed under the dropped file's own name where that fits the shelf's
  // charset, today's datetime where it does not — an import is a save, so
  // the fallback is honest. A collision gets the store's " (2)" suffix
  // like any same-second pair of saves.
  const base = file.name.replace(/\.json$/i, '').trim();
  const name = store.validName(base) ? base : stampName(new Date());
  const saved = await saveReplayFile(name, raw);
  return saved !== null ? { ok: true, name: saved } : { ok: false, reason: 'storage' };
}

/** Every saved replay, newest first. */
export async function listReplayFiles(): Promise<ReplayFileInfo[]> {
  const files = await store.list();
  return Promise.all(
    files.map(async (info) => {
      // The version stamp sits in the file's head by construction.
      const replayVersion = readReplayVersion(await info.file.slice(0, HEAD_BYTES).text());
      return replayVersion !== undefined ? { ...info, replayVersion } : info;
    }),
  );
}

/** One replay's JSON, or null when it isn't there. */
export function readReplayFile(name: string): Promise<string | null> {
  return store.read(name);
}

export function deleteReplayFile(name: string): Promise<void> {
  return store.remove(name);
}
