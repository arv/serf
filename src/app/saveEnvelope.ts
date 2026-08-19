/**
 * The solo save as it sits in storage: the worker's world serialization
 * plus the renderer's fog memory, under a head of metadata the saves list
 * can read without opening the world. The world alone used to be the whole
 * save, and reloading one left everything the player had scouted dark —
 * the sim has no notion of what a seat has *seen* (solo fog is entirely
 * render-side), so the explored grid has to ride along here, at the one
 * layer that can see both halves.
 *
 * The envelope is assembled and split on the main thread only; the worker
 * keeps receiving exactly the world string it produced. Saves from before
 * the envelope are raw world strings, and splitSave passes them through
 * untouched, fog simply unseeded — precisely the old behavior.
 */

import { WORLD_SAVE_VERSION } from '../shared/saveVersion';
import type { MissionId } from '../sim/defs/missions';

const FMT = 'serf-save-v3';
/** The envelope before the metadata head; still loaded, just listed with
 * nothing to say about itself. */
const FMT_V2 = 'serf-save-v2';

/**
 * What the saves list shows about a file without reading the world out of
 * it: which sim version wrote it (a row this build cannot load says so
 * instead of failing in the worker) and what the village was. Written at
 * the head of the envelope so a listing reads a few hundred bytes per row
 * rather than megabytes.
 */
export interface SaveMeta {
  /** WORLD_SAVE_VERSION as of the write. */
  world: number;
  /** The campaign mission this village belongs to; absent in free play. */
  mission?: MissionId;
  /** Computer opponents in the match. */
  opponents?: number;
}

/** One byte per tile in, six bits per char out (packed + base64). Shared
 * with replays, which carry the same grid when one boots from a save —
 * and with the server, whose own packing (persist.ts) is bit-compatible. */
export function packExplored(explored: Uint8Array): string {
  const bytes = new Uint8Array(Math.ceil(explored.length / 8));
  for (let i = 0; i < explored.length; i++) {
    if (explored[i]) bytes[i >> 3] = bytes[i >> 3]! | (1 << (i & 7));
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function unpackExplored(packed: string, tiles: number): Uint8Array | undefined {
  try {
    const bin = atob(packed);
    const out = new Uint8Array(tiles);
    for (let i = 0; i < tiles; i++) {
      const byte = bin.charCodeAt(i >> 3);
      if (Number.isNaN(byte)) break; // truncated: keep what decoded
      if (byte & (1 << (i & 7))) out[i] = 1;
    }
    return out;
  } catch {
    return undefined; // corrupt fog is no reason to lose the world
  }
}

/** `about` is what the match knows about itself; the sim version is
 * stamped here, since this is the layer that knows which one wrote the
 * world string. Key order is the format: everything a listing reads comes
 * before the world, which is the megabyte. */
export function envelopeSave(
  world: string,
  explored: Uint8Array,
  about: Omit<SaveMeta, 'world'> = {},
): string {
  const meta: SaveMeta = { world: WORLD_SAVE_VERSION, ...about };
  return JSON.stringify({ fmt: FMT, meta, world, explored: packExplored(explored) });
}

/** Split the envelope without unpacking the fog: at load time the world's
 * grid size is not known yet (it only arrives with the init frame), so the
 * explored grid stays packed here and the caller unpacks it — via
 * `unpackExplored(str, tiles)` — once the size is in hand. */
export function splitSave(data: string): { world: string; explored?: string } {
  try {
    const parsed = JSON.parse(data) as { fmt?: string; world?: string; explored?: string };
    if ((parsed?.fmt === FMT || parsed?.fmt === FMT_V2) && typeof parsed.world === 'string') {
      return {
        world: parsed.world,
        explored: typeof parsed.explored === 'string' ? parsed.explored : undefined,
      };
    }
  } catch {
    // Not JSON at all — certainly not an envelope.
  }
  return { world: data };
}

/**
 * The metadata head, from the head of the file alone — the listing never
 * has the whole envelope in hand. Cut out with a regex rather than parsed,
 * because the text stops mid-world: the meta object holds no nested
 * object by construction, so the first `}` closes it.
 *
 * Everything is screened on the way out. A file in OPFS is hand-editable,
 * and a mission id straight out of one would index the mission table.
 */
export function readSaveMeta(head: string): SaveMeta | undefined {
  const m = /"meta"\s*:\s*(\{[^{}]*\})/.exec(head);
  if (!m) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]!);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const meta = raw as Record<string, unknown>;
  if (typeof meta.world !== 'number' || !Number.isInteger(meta.world)) return undefined;
  return {
    world: meta.world,
    ...(typeof meta.mission === 'string' ? { mission: meta.mission as MissionId } : {}),
    ...(typeof meta.opponents === 'number' && Number.isInteger(meta.opponents)
      ? { opponents: meta.opponents }
      : {}),
  };
}

/**
 * Which world format a save was written in, from the head of the file
 * alone — the number this build has to match to load it.
 *
 * The metadata head answers it outright, but only saves from this build on
 * carry one. Older files still say so in their own way: an envelope holds
 * the world as an escaped JSON string, and the world's first key is its
 * version, so the number sits a few dozen bytes in either way. Read out
 * with a regex for the same reason readSaveMeta is — the text a listing
 * holds stops mid-world, and there is nothing here to parse.
 *
 * Undefined means the file does not say, which is not the same as saying
 * an old number: nothing is refused on the strength of it.
 */
export function readSaveWorldVersion(head: string): number | undefined {
  const meta = readSaveMeta(head);
  if (meta) return meta.world;
  // The world inside an envelope: `"world":"{\"version\":4,…"`. The
  // escaped quotes are what tell it apart from the bare save below.
  const inside = /\\"version\\"\s*:\s*(\d+)/.exec(head);
  if (inside) return Number(inside[1]);
  // A save from before the envelope: the sim's own file, version first.
  const bare = /"version"\s*:\s*(\d+)/.exec(head);
  return bare ? Number(bare[1]) : undefined;
}

/**
 * Is this document a save at all? The gate an imported file passes before
 * a byte of it lands in OPFS — an envelope, or a bare world string from
 * before the envelope existed. Deliberately shallow: it reads the wrapper,
 * not the world, because a save whose world this build cannot load is
 * still a save and the list says so per row.
 */
export function looksLikeSave(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const doc = parsed as Record<string, unknown>;
  if ((doc.fmt === FMT || doc.fmt === FMT_V2) && typeof doc.world === 'string') return true;
  // A pre-envelope save: the sim's own file, version and world in hand.
  return typeof doc.version === 'number' && typeof doc.world === 'object' && doc.world !== null;
}
