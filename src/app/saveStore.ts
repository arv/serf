/**
 * Saved games: one JSON file per save under the OPFS directory /saves,
 * named by the datetime it was written — the same shape the replay shelf
 * has, and for the same reasons. A save used to be one localStorage key,
 * so saving overwrote the only slot there was and a big village could
 * blow the quota outright (a whole map plus every unit, well past the few
 * megabytes localStorage shares between all its keys). Here each save is
 * its own file: keep as many as you like, load any of them, delete the
 * ones you are done with.
 *
 * Storage mechanics live in fileStore; what lives here is what makes a
 * file a *save* — the metadata head a row shows, and the screening an
 * imported file has to pass.
 */

import {
  createFileStore,
  stampName,
  HEAD_BYTES,
  type ImportResult,
  type StoredFileInfo,
} from './fileStore';
import { looksLikeSave, readSaveMeta, type SaveMeta } from './saveEnvelope';

const store = createFileStore('saves');

/** The localStorage key the single save slot used to live under. */
const LEGACY_KEY = 'serf-save';

export interface SaveFileInfo extends StoredFileInfo {
  /** What the file's head says about the village; undefined for a save
   * from before the metadata head (or a truncated file). */
  meta?: SaveMeta;
}

export type { ImportResult };

/**
 * Write one save under `name`, or under "name (2)" and so on when that
 * name is taken. Returns the name actually used, or null when OPFS is
 * unavailable.
 */
export function saveGameFile(name: string, data: string): Promise<string | null> {
  return store.write(name, data);
}

/** Write a save under the current datetime — what every save button does. */
export function saveGameNow(data: string): Promise<string | null> {
  return saveGameFile(stampName(new Date()), data);
}

/** Every saved game, newest first. */
export async function listSaveFiles(): Promise<SaveFileInfo[]> {
  const files = await store.list();
  return Promise.all(
    files.map(async (info) => {
      const meta = readSaveMeta(await info.file.slice(0, HEAD_BYTES).text());
      return meta !== undefined ? { ...info, meta } : info;
    }),
  );
}

/** The newest save's name, or null when there is nothing saved. */
export async function latestSaveName(): Promise<string | null> {
  const files = await store.list();
  return files[0]?.name ?? null;
}

/** One save's JSON, or null when it isn't there. */
export function readSaveFile(name: string): Promise<string | null> {
  return store.read(name);
}

export function deleteSaveFile(name: string): Promise<void> {
  return store.remove(name);
}

/**
 * File a save brought in from outside — dragging a row out of the shelf
 * being the sending half. Screened before a byte lands in OPFS, the same
 * way an imported replay is; a save whose world is too old for this build
 * still gets a place on the shelf, which marks it rather than refusing it.
 */
export async function importSaveFile(file: File): Promise<ImportResult> {
  let raw: string;
  try {
    raw = await file.text();
  } catch {
    return { ok: false, reason: 'storage' };
  }
  if (!looksLikeSave(raw)) return { ok: false, reason: 'unrecognized' };
  const base = file.name.replace(/\.json$/i, '').trim();
  const name = store.validName(base) ? base : stampName(new Date());
  const saved = await saveGameFile(name, raw);
  return saved !== null ? { ok: true, name: saved } : { ok: false, reason: 'storage' };
}

/**
 * Move the old single-slot save into the shelf, once. The village a player
 * left in localStorage before this build is the one they mean to come back
 * to, so it is filed as a file like any other — under the datetime of the
 * move, since the slot never recorded when it was written.
 *
 * The key is cleared only after the file is safely written: a failed
 * migration (no OPFS here) must leave the old slot exactly where it was,
 * and the next launch can try again.
 */
export async function migrateLegacySave(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_KEY);
  } catch {
    return; // no storage at all (private mode): nothing to migrate
  }
  if (raw === null) return;
  const name = await saveGameFile(stampName(new Date()), raw);
  if (name === null) return;
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Left behind: the next launch files a duplicate rather than losing
    // the village, which is the better of the two failures.
  }
}
