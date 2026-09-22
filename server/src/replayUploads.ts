/**
 * Uploaded replays: the recordings clients hand the server when a match
 * ends, and the shelf the /all-replays page reads back.
 *
 * Why they exist: solo play never opens a socket, so the only trace of it
 * in the logs is the page view that loaded the bundle. A finished match's
 * replay is the whole game written down — who played, on what, for how
 * long, and every order they gave — which is what turns "someone opened
 * the page" into "someone played, and here is how".
 *
 * Nothing about this is load-bearing for play. The client uploads without
 * telling the player and without caring whether it worked (see
 * src/app/replayUpload.ts), so every limit below is free to refuse: a
 * refused upload costs an observation, never a game.
 *
 * On disk, under `<state dir>/replays`, two files per recording:
 *
 *   <id>.json       the screened replay, exactly what playback will read
 *   <id>.meta.json  its summary, which is all the listing ever opens
 *
 * The summary is a separate small file rather than an entry in one index,
 * because an index is a second copy of the truth that a half-finished
 * write can leave disagreeing with the files beside it. Here the pair IS
 * the record: a replay whose meta never landed is swept on the next prune,
 * and there is no third thing to keep in step.
 *
 * Ids sort chronologically as strings (`YYYYMMDD-HHMMSSsss-<rand>`), so the
 * prune and the newest-first listing are both a plain sort of the
 * directory — no file has to be opened to know its age.
 */

import {randomBytes} from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {
  parseReplay,
  serializeReplay,
  type ReplayData,
} from '../../src/app/replay.ts';
import {AI_STRATEGY_KEYS} from '../../src/sim/defs/aiStrategies.ts';
import {DIFFICULTY_KEYS} from '../../src/sim/defs/difficulty.ts';
import {MISSION_KEYS} from '../../src/sim/defs/missions.ts';
import {PLAYER_KIND_KEYS} from '../../src/sim/player.ts';
import {stateDir} from './persist.ts';

/**
 * The largest upload the server will read. A long four-seat match logs
 * every order the AI seats gave as well as the player's, so these are
 * megabytes rather than kilobytes — but a body past this is not a replay
 * we want, and reading it to find out is the attack.
 */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** How many recordings the shelf keeps, and how much room they may take
 * between them. Whichever bites first, the oldest go — the volume is
 * shared with the room snapshot, and a full disk costs live matches their
 * deploy handover, which is worth more than any archived game. */
export const MAX_STORED_REPLAYS = 500;
export const MAX_STORED_BYTES = 256 * 1024 * 1024;

/** Uploads one address may land in an hour. A match takes minutes, so this
 * is far above honest play and far below anything worth storing. */
export const MAX_UPLOADS_PER_HOUR = 20;

/** How a recording reached the server: a local sim's own log, or a seat's
 * copy of a relayed match. The client says which — the two are otherwise
 * indistinguishable, since a one-human room looks exactly like solo. */
export type ReplaySource = 'solo' | 'net';

/**
 * How the match stopped: played to a winner, or walked out of.
 *
 * Both are filed. A match people leave is not a failed recording — it is
 * the commoner event, and the one that says where a game loses someone —
 * so the shelf keeps the distinction rather than collecting only the
 * games that ended tidily. Networked matches are `decided` by
 * construction: the relay hands out a room's log only once its outcome
 * has nothing left to hide (rooms.ts, replayFor), so a seat that quits
 * mid-match is answered with nothing and files nothing.
 */
export type ReplayEnding = 'decided' | 'abandoned';

/** What the listing shows for one recording. Everything here is derived
 * from the replay itself at upload time, so the shelf never opens a
 * recording it is only naming. */
export interface ReplaySummary {
  id: string;
  /** When the server filed it (the client's own savedAt rides inside the
   * replay, and is not to be trusted with the ordering). */
  uploadedMs: number;
  /** Size of the stored replay, after screening. */
  bytes: number;
  source: ReplaySource;
  ending: ReplayEnding;
  /** The REPLAY_VERSION it was recorded under. A build that plays a
   * different number cannot watch it — the shelf says so rather than
   * offering a link that fails on arrival. */
  replayVersion: number;
  /** Where the recording stops. With TICK_MS this is the match's length. */
  endTick: number;
  seed: number;
  /** Which seat the recording watches through. */
  seat?: number;
  mission?: string;
  difficulty?: string;
  seats: {kind: string; strategy?: string; difficulty?: string}[];
  /** Orders logged, all seats together — a rough measure of how busy the
   * match was, and the one number that separates a game played from a
   * game left running. */
  commands: number;
  /** Lines said at the table. Multiplayer only; solo has nobody to talk to. */
  chat: number;
}

/** Where the recordings live. Read per call, like persist.ts's own dir, so
 * a test pointing SERF_STATE_DIR somewhere else is obeyed. */
export function replayDir(): string {
  return join(stateDir(), 'replays');
}

const REPLAY_SUFFIX = '.json';
const META_SUFFIX = '.meta.json';

/**
 * Ids are minted here and nowhere else, and everything that takes one from
 * a URL checks it against this. `<id>.json` is joined onto a directory
 * path, so an id is the one place a request could otherwise name a file
 * outside the shelf.
 */
const ID_RE = /^\d{8}-\d{9}-[0-9a-f]{6}$/;

export function isReplayId(raw: unknown): raw is string {
  return typeof raw === 'string' && ID_RE.test(raw);
}

export function mintReplayId(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  // To the millisecond, not the second: the ordering of the shelf and of
  // the prune is this string's sort, and two matches ending inside the
  // same second would otherwise be ranked by the random tail.
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}` +
    String(now.getUTCMilliseconds()).padStart(3, '0');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

/** The replay's own account of itself, for the shelf. Names rather than
 * enum numbers: the listing is read by a person, and the numbers are an
 * implementation detail of the sim that is free to move. */
function summarize(
  id: string,
  replay: ReplayData,
  opts: {
    bytes: number;
    uploadedMs: number;
    source: ReplaySource;
    ending: ReplayEnding;
  },
): ReplaySummary {
  const {config} = replay;
  let commands = 0;
  for (const entry of replay.commands) commands += entry.commands.length;
  return {
    id,
    uploadedMs: opts.uploadedMs,
    bytes: opts.bytes,
    source: opts.source,
    ending: opts.ending,
    replayVersion: replay.replayVersion,
    endTick: replay.endTick,
    seed: config.seed,
    ...(config.myPlayerId !== undefined ? {seat: config.myPlayerId} : {}),
    ...(config.mission !== undefined
      ? {mission: MISSION_KEYS[config.mission]}
      : {}),
    ...(config.difficulty !== undefined
      ? {difficulty: DIFFICULTY_KEYS[config.difficulty]}
      : {}),
    seats: config.players.map(p => ({
      kind: PLAYER_KIND_KEYS[p.kind],
      ...(p.strategy !== undefined
        ? {strategy: AI_STRATEGY_KEYS[p.strategy]}
        : {}),
      ...(p.difficulty !== undefined
        ? {difficulty: DIFFICULTY_KEYS[p.difficulty]}
        : {}),
    })),
    commands,
    chat: replay.chat?.length ?? 0,
  };
}

export type StoreResult =
  | {ok: true; summary: ReplaySummary}
  | {ok: false; reason: 'unreadable' | 'storage'};

/**
 * File one uploaded recording.
 *
 * The bytes are screened before any of them land: parseReplay is the same
 * gate playback runs every file through, and what is written is its
 * output re-serialized rather than the body as it arrived. That is the
 * point — the shelf then holds nothing but replay-shaped documents, junk
 * fields a client smuggled in are gone, and the size on disk is the size
 * of the game rather than of whatever surrounded it.
 *
 * The meta file is written second and the replay renamed into place
 * first, so a process killed mid-store leaves a replay with no summary —
 * invisible to the listing, and swept by the next prune — rather than a
 * summary pointing at a file that is not there.
 */
export async function storeReplay(
  raw: string,
  opts: {source: ReplaySource; ending: ReplayEnding; nowMs: number},
): Promise<StoreResult> {
  const replay = parseReplay(raw);
  if (replay === null) return {ok: false, reason: 'unreadable'};
  const screened = serializeReplay(replay);
  const id = mintReplayId(new Date(opts.nowMs));
  const summary = summarize(id, replay, {
    bytes: Buffer.byteLength(screened),
    uploadedMs: opts.nowMs,
    source: opts.source,
    ending: opts.ending,
  });
  const dir = replayDir();
  // Whole file, then rename, the way the room snapshot is written: a
  // half-written replay under its real name would be listed and then
  // fail to parse on the one click that opened it.
  const tmp = join(dir, `${id}${REPLAY_SUFFIX}.tmp`);
  try {
    await mkdir(dir, {recursive: true});
    await writeFile(tmp, screened);
    await rename(tmp, join(dir, `${id}${REPLAY_SUFFIX}`));
    await writeFile(join(dir, `${id}${META_SUFFIX}`), JSON.stringify(summary));
  } catch {
    // The scratch file is named for an id nothing will mint again, and it
    // ends in neither suffix the shelf knows — so a leftover is invisible
    // to the listing AND to the prune, and would sit on the volume for
    // good. Taken away here; only a process killed between the write and
    // the rename can still leave one.
    try {
      await rm(tmp, {force: true});
    } catch {
      // Nothing to be done, and the upload already failed.
    }
    return {ok: false, reason: 'storage'};
  }
  return {ok: true, summary};
}

/** Every id on the shelf, oldest first — which is id order, since the id
 * starts with the second it was minted. */
async function storedIds(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return []; // nothing uploaded here yet
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(REPLAY_SUFFIX) || entry.endsWith(META_SUFFIX)) continue;
    const id = entry.slice(0, -REPLAY_SUFFIX.length);
    if (isReplayId(id)) ids.push(id);
  }
  return ids.sort();
}

/**
 * The shelf, newest first.
 *
 * Only the summaries are opened — the recordings themselves are megabytes
 * and the listing names them, nothing more. A recording whose summary is
 * missing or unreadable is left out rather than guessed at: it is either
 * mid-store or the wreckage of one, and the prune will deal with it.
 */
export async function listStoredReplays(): Promise<ReplaySummary[]> {
  const dir = replayDir();
  const ids = await storedIds(dir);
  const summaries: ReplaySummary[] = [];
  for (const id of ids.reverse()) {
    try {
      const raw = await readFile(join(dir, `${id}${META_SUFFIX}`), 'utf8');
      const parsed = JSON.parse(raw) as ReplaySummary;
      // Trusted because we wrote it, checked because a stale or
      // hand-edited meta must not put a row on the page with no id to
      // click through to.
      if (isReplayId(parsed.id)) summaries.push(parsed);
    } catch {
      continue;
    }
  }
  return summaries;
}

/** One recording's JSON, or null when that id names nothing here. */
export async function readStoredReplay(id: string): Promise<string | null> {
  if (!isReplayId(id)) return null;
  try {
    return await readFile(join(replayDir(), `${id}${REPLAY_SUFFIX}`), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Bring the shelf back inside its limits, oldest first. Returns how many
 * recordings were dropped.
 *
 * Both halves of a record go, and a record missing its meta counts as
 * zero bytes and is dropped like any other — which is how the debris of
 * an interrupted store leaves the disk.
 *
 * The limits are arguments rather than constants read from inside,
 * because what "too many" means is the deployment's business — and
 * because a test that had to file five hundred matches to watch one fall
 * off the end would not be a test anyone runs.
 */
export async function pruneStoredReplays(
  limits: {count?: number; bytes?: number} = {},
): Promise<number> {
  const maxCount = limits.count ?? MAX_STORED_REPLAYS;
  const maxBytes = limits.bytes ?? MAX_STORED_BYTES;
  const dir = replayDir();
  const ids = await storedIds(dir);
  const sizes = new Map<string, number>();
  let total = 0;
  for (const id of ids) {
    let bytes = 0;
    try {
      const raw = await readFile(join(dir, `${id}${META_SUFFIX}`), 'utf8');
      bytes = (JSON.parse(raw) as ReplaySummary).bytes;
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) bytes = 0;
    } catch {
      bytes = 0;
    }
    sizes.set(id, bytes);
    total += bytes;
  }
  let count = ids.length;
  let dropped = 0;
  for (const id of ids) {
    if (count <= maxCount && total <= maxBytes) break;
    await rm(join(dir, `${id}${REPLAY_SUFFIX}`), {force: true});
    await rm(join(dir, `${id}${META_SUFFIX}`), {force: true});
    total -= sizes.get(id) ?? 0;
    count--;
    dropped++;
  }
  return dropped;
}

/**
 * Per-address upload budget, in this process's memory.
 *
 * Memory rather than disk on purpose: the budget exists to stop one client
 * filling the volume in an afternoon, and a deploy resetting it costs at
 * most one window's worth of uploads. Addresses are kept only as long as
 * their window — the map is swept on every call, so an address that
 * stopped uploading stops being remembered.
 */
const HOUR_MS = 60 * 60 * 1000;
const uploadsByIp = new Map<string, number[]>();

/** Count this address's upload against its hour. False when the budget is
 * already spent — the caller refuses, and nothing is recorded. */
export function claimUploadSlot(ip: string, nowMs: number): boolean {
  for (const [key, stamps] of uploadsByIp) {
    const live = stamps.filter(t => nowMs - t < HOUR_MS);
    if (live.length === 0) uploadsByIp.delete(key);
    else uploadsByIp.set(key, live);
  }
  const mine = uploadsByIp.get(ip) ?? [];
  if (mine.length >= MAX_UPLOADS_PER_HOUR) return false;
  mine.push(nowMs);
  uploadsByIp.set(ip, mine);
  return true;
}

/** Test seam: forget every address's window. */
export function resetUploadBudgets(): void {
  uploadsByIp.clear();
}
