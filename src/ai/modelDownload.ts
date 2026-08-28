/**
 * The model download that survives being interrupted.
 *
 * wllama caches a *finished* GGUF forever, but knows nothing about an
 * unfinished one: stop a download at 90% and the next attempt starts over
 * at byte zero (after modelCache.ts has swept the leftovers out of its
 * way). And stopping early is the ordinary path, not the unlucky one — the
 * start menu warms the model while the player picks opponents and the
 * launch abandons that warm-up, so on any connection slower than the
 * player's patience the ~400 MB fetch restarts from scratch on every load
 * and may simply never complete.
 *
 * So the bytes are kept between loads. Progress accumulates in a private
 * OPFS directory — next to, never inside, wllama's cache — as a row of
 * part files plus one metadata record naming the URL, the server's ETag
 * and the promised size. The next attempt asks the server to continue
 * (`Range: bytes=N-`) and appends; only when every byte has landed is the
 * finished file installed into wllama's cache, correctly tagged, where
 * every later load finds it exactly as if wllama had downloaded it itself.
 *
 * Written to be impossible to poison, because the failure it replaces was
 * a permanent one:
 *
 *   - A part file is committed atomically (OPFS writables swap on close),
 *     so a part either exists whole or not at all, and the parts must
 *     chain gaplessly from zero to count. Anything else is discarded.
 *   - Resuming requires the server to prove continuity: a strong ETag
 *     equal to the stored one, and a Content-Range that picks up exactly
 *     where the parts end in a file of the promised size. A changed file,
 *     a server that never named the proof, or a CORS layer that hides it
 *     all start over rather than risk splicing two versions together.
 *   - Each metadata record carries a random attempt id and parts are named
 *     with it, so a straggling write from an abandoned attempt can never
 *     join a newer chain.
 *   - One download runs at a time per origin (a Web Lock, with a same-page
 *     queue where the browser has none): the menu's warm-up and a match's
 *     load can meet around the handoff, and queue — sweep, probe, install
 *     and the callers' wllama-native fallback included — instead of
 *     interleaving over the one staging directory.
 *   - A stream that ends cleanly but early is a failure, not a finish:
 *     nothing short of the promised size is ever installed. A server that
 *     never says the size cannot make that promise, so it is not this
 *     module's to download at all.
 *   - The install frees each part as it copies it, so the transient
 *     footprint is the model plus one part — never two whole copies
 *     racing the quota.
 *
 * And to never do worse than the old behavior: a browser whose OPFS can't
 * take main-thread writes or that has no Web Locks — or whose storage
 * exists but refuses to open or to take the staging record — gets
 * 'unsupported' and the callers fall back to wllama's own downloader, and
 * a resume request the network refuses outright (a proxy or CORS layer
 * that balks at Range) retries once as the plain fetch it would have
 * been anyway.
 */

import {
  discardPartialModel,
  hasWholeModel,
  type ModelCache,
} from './modelCache.ts';

/** The slice of wllama's CacheManager this needs beyond the sweeper's:
 * the way in. `write` is marked deprecated upstream in favor of letting
 * wllama download for itself — which is precisely what this module is not
 * doing — and it remains the one call that stores bytes and their
 * metadata record together. */
export interface InstallableModelCache extends ModelCache {
  write(
    name: string,
    stream: ReadableStream<Uint8Array>,
    metadata: {etag: string; originalSize: number; originalURL: string},
  ): Promise<void>;
}

/** The record beside the parts: what the bytes are, and what would prove
 * them stale. */
export interface PartialMeta {
  url: string;
  /** The server's ETag, verbatim — resuming means proving the file has
   * not changed under us. '' (none, or only a weak one) makes the partial
   * unresumable, and readState treats it as absent. */
  etag: string;
  /** Bytes the server promised. Nothing short of this is ever installed. */
  total: number;
  /** Random id for this download's chain; parts carry it so a straggling
   * write from an abandoned attempt can never join a newer chain. */
  attempt: string;
}

export interface PartialPart {
  attempt: string;
  offset: number;
  size: number;
  blob: Blob;
}

/** Where partial downloads wait between loads. Structural, so tests run
 * over a Map; the real one (opfsPartialStore) lives in OPFS. */
export interface PartialStore {
  /** null when absent or unreadable — either way, nothing to resume. */
  readMeta(): Promise<PartialMeta | null>;
  writeMeta(meta: PartialMeta): Promise<void>;
  listParts(): Promise<PartialPart[]>;
  /** Whole or not at all: a part interrupted mid-write must not appear. */
  writePart(attempt: string, offset: number, bytes: Uint8Array): Promise<void>;
  /** Absent parts are not an error. */
  deletePart(attempt: string, offset: number): Promise<void>;
  clear(): Promise<void>;
}

export type ModelProgress = (progress: {loaded: number; total: number}) => void;

export interface EnsureModelOpts {
  /** Counts from the resumed offset, not zero — the visible payoff. */
  onProgress?: ModelProgress;
  signal?: AbortSignal;
  /** Test injections. `store: null` forces the unsupported path. */
  store?: PartialStore | null;
  fetcher?: typeof fetch;
  partBytes?: number;
}

export interface EnsureModelResult {
  /** cached: the cache already held the whole model, nothing was fetched.
   * downloaded: it does now. unsupported: no resumable storage here — the
   * caller should let wllama download for itself, exactly as before this
   * module existed. */
  status: 'cached' | 'downloaded' | 'unsupported';
  /** Bytes carried over from an earlier attempt; 0 means started fresh. */
  resumedFrom: number;
}

/** Commit granularity: how much an unclean death can cost. Small enough
 * to lose casually, large enough that a 400 MB model is ~50 files. */
const PART_BYTES = 8 * 1024 * 1024;

/** One download at a time per origin — a Web Lock, or a same-page queue
 * where the browser has none. (In practice every browser whose OPFS the
 * store accepts ships Web Locks; the queue is belt over braces, and
 * cross-tab overlap without either is what the attempt-id fencing keeps
 * merely wasteful, never corrupting.) Exported for the callers' native
 * fallback: a wllama download is still a download, and belongs in the
 * same critical section as every other. The signal covers the wait —
 * a disposed caller queued behind a long download must not wake up
 * later and start one of its own. */
const DOWNLOAD_LOCK = 'serf-llm-download';
let lockQueue: Promise<unknown> = Promise.resolve();
export function withModelDownloadLock<T>(
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks) {
    return locks.request(
      DOWNLOAD_LOCK,
      signal ? {signal} : {},
      work,
    ) as Promise<T>;
  }
  const run = lockQueue.then(() => {
    if (signal?.aborted)
      throw new Error('aborted waiting for the model download lock');
    return work();
  });
  lockQueue = run.catch(() => undefined);
  return run;
}

/** Thrown when the resumable path must stand aside — staging storage that
 * refuses to work, a server that names no size — as distinct from a
 * failed download: the right answer is wllama's own downloader, not a
 * dead strategist. */
class FallBackToWllama extends Error {}

/**
 * Get the model into wllama's cache, resuming any earlier attempt's bytes.
 * Everything runs under the download lock — the sweep and the cache probe
 * included, so one caller cannot sweep away the half-written file another
 * is in the middle of installing. Sweeps wllama-native wreckage (see
 * modelCache.ts) whatever else happens, so even the 'unsupported'
 * fallback downloads onto clean ground.
 */
export async function ensureModelCached(
  cache: InstallableModelCache,
  url: string,
  opts: EnsureModelOpts = {},
): Promise<EnsureModelResult> {
  const store = opts.store !== undefined ? opts.store : opfsPartialStore();
  return withModelDownloadLock(async () => {
    // The wait may have outlived the caller — granted is not wanted.
    if (opts.signal?.aborted) throw new Error('model download aborted');
    await sweepWllamaCache(cache, url);
    if (await hasWholeModelSafe(cache, url)) {
      // A death between install and cleanup strands a finished chain
      // beside the installed model; sweep it whenever the hit is
      // confirmed, or the duplicate would hold quota forever.
      if (store) await store.clear().catch(() => {});
      return {status: 'cached', resumedFrom: 0};
    }
    if (!store) return {status: 'unsupported', resumedFrom: 0};
    let prior: Awaited<ReturnType<typeof readState>>;
    try {
      prior = await readState(store, url);
    } catch {
      // The store's API exists but its storage refuses to open (site data
      // blocked, quota machinery wedged): not this module's download to
      // make. wllama's own path gets its chance instead.
      return {status: 'unsupported', resumedFrom: 0};
    }
    try {
      return await download(cache, url, store, prior, opts);
    } catch (err) {
      if (err instanceof FallBackToWllama)
        return {status: 'unsupported', resumedFrom: 0};
      throw err;
    }
  }, opts.signal);
}

/** The download itself, from whatever `prior` bytes exist to the install.
 * Runs under the lock. */
async function download(
  cache: InstallableModelCache,
  url: string,
  store: PartialStore,
  prior: Awaited<ReturnType<typeof readState>>,
  opts: EnsureModelOpts,
): Promise<EnsureModelResult> {
  const fetcher = opts.fetcher ?? fetch;
  // Anything but a positive integer would turn flush's slicing loop into
  // a spin; a nonsense override earns the default, not a hang.
  const wanted = opts.partBytes ?? PART_BYTES;
  const partBytes =
    Number.isSafeInteger(wanted) && wanted > 0 ? wanted : PART_BYTES;

  // Everything already here — a session that died between the last part
  // landing and the install. Nothing to fetch.
  if (prior && prior.size === prior.meta.total) {
    await install(cache, url, store, prior.meta, prior.size);
    return {status: 'downloaded', resumedFrom: prior.size};
  }

  const opened = await open(store, url, prior, fetcher, opts.signal);
  // A server that will not say how big the file is cannot prove a
  // clean-looking stream complete, and an unproven install is the poison
  // this module refuses. Such servers are wllama's to download, exactly
  // as they were before this module existed.
  if (opened.meta.total <= 0) {
    opened.response.body?.cancel().catch(() => {});
    throw new FallBackToWllama('server names no size');
  }
  const {meta, response} = opened;
  const resumedFrom = opened.base;
  let base = opened.base;
  opts.onProgress?.({loaded: base, total: meta.total});

  // The stream, committed in atomic parts as it arrives. On ANY exit —
  // network drop, abort, quota — whatever is buffered is flushed first:
  // keeping the bytes is the entire point of this module.
  const body = response.body;
  if (!body)
    throw new Error(`model download had no body (HTTP ${response.status})`);
  const reader = body.getReader();
  let buffer: Uint8Array[] = [];
  let buffered = 0;
  const flush = async (): Promise<void> => {
    if (buffered === 0) return;
    const bytes = concat(buffer, buffered);
    buffer = [];
    buffered = 0;
    // Sliced to the granularity, whatever size the network's reads came
    // in: a part never exceeds partBytes, so the commit bound — and the
    // install's one-part footprint — holds even against a giant chunk.
    for (let at = 0; at < bytes.length; at += partBytes) {
      const slice = bytes.subarray(at, Math.min(at + partBytes, bytes.length));
      await store.writePart(meta.attempt, base, slice);
      base += slice.length;
    }
  };
  // Report whenever the visible percent moves, not per network chunk — a
  // Solid signal is on the other end. (The total is always known here;
  // a size-less server was turned away above.)
  let lastPct = Math.floor((base / meta.total) * 100);
  const report = (): void => {
    if (!opts.onProgress) return;
    const loaded = base + buffered;
    const pct = Math.floor((loaded / meta.total) * 100);
    if (pct === lastPct) return;
    lastPct = pct;
    opts.onProgress({loaded, total: meta.total});
  };
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer.push(value);
      buffered += value.length;
      if (buffered >= partBytes) await flush();
      report();
    }
    await flush();
  } catch (err) {
    try {
      await flush();
    } catch {
      // Storage refused the salvage; the failure that matters is below.
    }
    throw err instanceof Error ? err : new Error(String(err));
  }

  // A clean end short of the promise is a failure, not a finish — install
  // it and the cache holds a convincingly tagged corrupt model forever.
  // The parts stay: the next attempt picks up right here.
  if (base !== meta.total) {
    throw new Error(
      `model download ended early (${base} of ${meta.total} bytes)`,
    );
  }
  await install(cache, url, store, meta, base);
  return {status: 'downloaded', resumedFrom};
}

/** The whole-model probe, unable to take the download down with it: a
 * cache that cannot be listed right now is treated as holding nothing —
 * the download that follows has better odds than giving up here. */
async function hasWholeModelSafe(
  cache: ModelCache,
  url: string,
): Promise<boolean> {
  try {
    return await hasWholeModel(cache, url);
  } catch {
    return false;
  }
}

/** modelCache.ts's sweep, best-effort as ever: a cache that cannot even be
 * listed is not a reason to skip the download the player is waiting for. */
async function sweepWllamaCache(cache: ModelCache, url: string): Promise<void> {
  try {
    const discarded = await discardPartialModel(cache, url);
    if (discarded > 0) {
      console.warn(
        '[strategist] discarded an unfinished model download; fetching it again',
      );
    }
  } catch (err) {
    console.warn(
      `[strategist] could not check the model cache: ${String(err)}`,
    );
  }
}

/**
 * What the store holds for `url`, provided it is worth resuming: metadata
 * that names this URL with a strong ETag and a known total, and parts (of
 * that metadata's attempt) chaining gaplessly from zero. Anything less is
 * cleared and reported as nothing — a partial that cannot be trusted is
 * exactly the poison this module exists to not have.
 *
 * Also the storage probe: listParts runs whether or not metadata exists,
 * so an OPFS that refuses to open rejects here — before any network — and
 * the caller can fall back to wllama's own downloader.
 */
async function readState(
  store: PartialStore,
  url: string,
): Promise<{meta: PartialMeta; parts: PartialPart[]; size: number} | null> {
  const meta = await store.readMeta();
  const all = await store.listParts();
  const parts = chainParts(all, meta);
  const size = parts.reduce((sum, part) => sum + part.size, 0);
  const usable =
    meta !== null &&
    meta.url === url &&
    meta.etag !== '' &&
    meta.total > 0 &&
    size > 0 &&
    size <= meta.total;
  if (!usable) {
    // Best-effort, and only when there is something to discard: whatever
    // a broken clear leaves behind wears an attempt id no later chain
    // will accept. Storage that is truly broken already rejected above.
    if (meta !== null || all.length > 0) await store.clear().catch(() => {});
    return null;
  }
  return {meta, parts, size};
}

/** The longest gapless run from offset zero, this attempt's parts only.
 * Sorted by offset; a stray file — another attempt's straggler, or a
 * duplicate offset — ends the chain rather than joining it. */
function chainParts(
  parts: PartialPart[],
  meta: PartialMeta | null,
): PartialPart[] {
  if (!meta) return [];
  const own = parts
    .filter(p => p.attempt === meta.attempt)
    .sort((a, b) => a.offset - b.offset);
  const chain: PartialPart[] = [];
  let next = 0;
  for (const part of own) {
    if (part.offset !== next) break;
    chain.push(part);
    next += part.size;
  }
  return chain;
}

/**
 * Open the response the stream loop will drain, resuming when the server
 * cooperates and falling back to a fresh start whenever it does not: a 200
 * where 206 was asked (no range support, or the file changed), a 206
 * carrying a different ETag or the wrong offset, a 416, or a resume
 * request the network refuses outright — each of those restarts from zero
 * rather than failing, because starting over is what every load did before
 * this module.
 */
async function open(
  store: PartialStore,
  url: string,
  prior: {meta: PartialMeta; size: number} | null,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<{meta: PartialMeta; base: number; response: Response}> {
  const init: RequestInit = signal ? {signal} : {};
  // A start from zero, recorded around whichever response carries it.
  const adopt = async (
    response: Response,
  ): Promise<{meta: PartialMeta; base: number; response: Response}> => {
    const meta: PartialMeta = {
      url,
      etag: strongEtag(response),
      total: contentTotal(response),
      attempt: crypto.randomUUID().slice(0, 8),
    };
    // The clear is best-effort — whatever survives it wears another
    // attempt's id and can never join this chain. The record is not: it
    // is the first write, before any byte has landed, so its failure is
    // the store refusing to work, not a download failing — stand aside
    // for wllama's own path. (A write that fails mid-stream stays a
    // failure: those bytes were paid for, and quietly refetching them
    // all natively would not be the cheaper outcome it pretends to be.)
    await store.clear().catch(() => {});
    try {
      await store.writeMeta(meta);
    } catch (err) {
      response.body?.cancel().catch(() => {});
      throw new FallBackToWllama(String(err));
    }
    return {meta, base: 0, response};
  };
  const fresh = async (): Promise<{
    meta: PartialMeta;
    base: number;
    response: Response;
  }> => {
    const response = await fetcher(url, init);
    if (!response.ok)
      throw new Error(`model download failed: HTTP ${response.status}`);
    if (response.status !== 200) {
      // An unsolicited partial answer to a whole-file ask — adopt a 206's
      // shifted bytes at offset zero and every later check would bless
      // the corruption. A server this noncompliant gets no download.
      response.body?.cancel().catch(() => {});
      throw new Error(
        `model download failed: HTTP ${response.status} to a whole-file request`,
      );
    }
    return adopt(response);
  };
  if (!prior) return fresh();

  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      headers: {Range: `bytes=${prior.size}-`},
    });
  } catch (err) {
    // The ranged request itself was refused before any HTTP answer — most
    // likely a CORS or proxy layer that balks at the Range header, which
    // an unranged fetch never trips. But surface a deliberate abort as
    // itself, not as whatever the fresh attempt then dies of.
    if (signal?.aborted)
      throw err instanceof Error ? err : new Error(String(err));
    return fresh();
  }
  if (response.status !== 206) {
    // 200 is the whole file — the server ignored the range or the file
    // changed. Either way it is a fresh start already in hand.
    if (response.status === 200) return adopt(response);
    if (response.status === 416) return fresh();
    throw new Error(`model download failed: HTTP ${response.status}`);
  }
  // 206: the range came back, but only the validators prove it is a range
  // of *our* file: a strong ETag equal to the stored one, and a
  // Content-Range picking up exactly where the parts end in a file of the
  // size the record promised. Any of it missing or saying otherwise — a
  // changed file, a server that never named the proof, a CORS layer
  // hiding it — means the bytes must not be mixed; a fresh start is never
  // worse than a wrong splice.
  const etag = strongEtag(response);
  const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(
    response.headers.get('content-range') ?? '',
  );
  const provenOurs =
    etag === prior.meta.etag &&
    range !== null &&
    Number(range[1]) === prior.size &&
    Number(range[2]) === prior.meta.total;
  if (!provenOurs) {
    response.body?.cancel().catch(() => {});
    return fresh();
  }
  return {meta: prior.meta, base: prior.size, response};
}

/** The ETag as a resume validator: verbatim, or '' when the server sent
 * none — or only a weak one, which promises equivalence, not the byte
 * identity that splicing ranges together requires. */
function strongEtag(response: Response): string {
  const etag = response.headers.get('etag') ?? '';
  return etag.startsWith('W/') ? '' : etag;
}

/** Total size as this response states it: Content-Range's full length on
 * a 206, Content-Length otherwise, 0 for "never said" — where absent,
 * garbage and absurd all count as never said, because a NaN in
 * particular would sail past every <= 0 guard downstream. */
function contentTotal(response: Response): number {
  const range = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
  const total = range
    ? Number(range[1])
    : Number(response.headers.get('content-length') ?? 0);
  return Number.isSafeInteger(total) && total > 0 ? total : 0;
}

/**
 * The finish line: stream the chained parts into wllama's cache under the
 * name and metadata its own download would have written, so every later
 * load — and modelCache.ts's sweep — sees a finished download and nothing
 * else. Only then is the staging directory dropped.
 */
async function install(
  cache: InstallableModelCache,
  url: string,
  store: PartialStore,
  meta: PartialMeta,
  size: number,
): Promise<void> {
  const parts = chainParts(await store.listParts(), meta);
  const chained = parts.reduce((sum, part) => sum + part.size, 0);
  if (chained !== size)
    throw new Error('model download storage changed underneath');
  let at = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull: async controller => {
      const part = parts[at++];
      if (!part) {
        controller.close();
        return;
      }
      const bytes = new Uint8Array(await part.blob.arrayBuffer());
      // Freed as it is copied, so the transient footprint is the model
      // plus one part rather than two whole copies racing the quota. The
      // price: a death mid-install breaks the chain and costs a fresh
      // download — seconds of copying weighed against doubling 400 MB.
      await store.deletePart(part.attempt, part.offset).catch(() => {});
      controller.enqueue(bytes);
    },
  });
  await cache.write(await cache.getNameFromURL(url), stream, {
    originalURL: url,
    originalSize: size,
    // wllama stores its ETags stripped to alphanumerics; written the same
    // way so the record is indistinguishable from its own.
    etag: meta.etag.replace(/[^A-Za-z0-9]/g, ''),
  });
  // Best-effort: the model is installed either way, and a chain this
  // sweep misses is caught by the one every cache hit runs.
  await store.clear().catch(() => {});
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/** The staging directory: OPFS, beside wllama's `cache` directory and
 * invisible to it, so nothing here can ever be mistaken for a cache hit. */
const PARTIAL_DIR = 'serf-llm-download';
const META_FILE = 'meta.json';
const PART_RE = /^part-([0-9a-f]+)-(\d{12})$/;
const partName = (attempt: string, offset: number): string =>
  `part-${attempt}-${String(offset).padStart(12, '0')}`;

/**
 * The real store, or null where it cannot work — no OPFS, file handles
 * without main-thread `createWritable` (older Safari; wllama covers those
 * with its own worker-based writes, so the fallback is simply the old
 * non-resuming behavior, not a regression), or no Web Locks. The last is
 * part of the contract, not a convenience: without a cross-tab lock, two
 * tabs could interleave over this one directory, and every browser that
 * passes the other checks ships Web Locks anyway.
 */
export function opfsPartialStore(): PartialStore | null {
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.storage?.getDirectory !== 'function' ||
    typeof navigator.locks?.request !== 'function' ||
    typeof FileSystemFileHandle === 'undefined' ||
    !('createWritable' in FileSystemFileHandle.prototype)
  ) {
    return null;
  }
  const dir = async (): Promise<FileSystemDirectoryHandle> => {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(PARTIAL_DIR, {create: true});
  };
  const put = async (
    name: string,
    data: Uint8Array | string,
  ): Promise<void> => {
    const handle = await (await dir()).getFileHandle(name, {create: true});
    // Committed on close, atomically: OPFS writables stage into a swap
    // file, which is exactly what lets a part be whole or absent.
    const writable = await handle.createWritable();
    await writable.write(data as FileSystemWriteChunkType);
    await writable.close();
  };
  return {
    readMeta: async () => {
      try {
        const handle = await (await dir()).getFileHandle(META_FILE);
        const meta = JSON.parse(
          await (await handle.getFile()).text(),
        ) as Partial<PartialMeta>;
        if (
          typeof meta.url !== 'string' ||
          typeof meta.etag !== 'string' ||
          typeof meta.total !== 'number' ||
          typeof meta.attempt !== 'string'
        ) {
          return null;
        }
        return {
          url: meta.url,
          etag: meta.etag,
          total: meta.total,
          attempt: meta.attempt,
        };
      } catch {
        return null;
      }
    },
    writeMeta: meta => put(META_FILE, JSON.stringify(meta)),
    listParts: async () => {
      const parts: PartialPart[] = [];
      for await (const [name, handle] of (await dir()).entries()) {
        const match = PART_RE.exec(name);
        if (!match || handle.kind !== 'file') continue;
        const blob = await handle.getFile();
        parts.push({
          attempt: match[1]!,
          offset: Number(match[2]),
          size: blob.size,
          blob,
        });
      }
      return parts;
    },
    writePart: (attempt, offset, bytes) =>
      put(partName(attempt, offset), bytes),
    deletePart: async (attempt, offset) => {
      await (
        await dir()
      )
        .removeEntry(partName(attempt, offset))
        .catch((err: unknown) => {
          if ((err as {name?: string}).name !== 'NotFoundError') throw err;
        });
    },
    clear: async () => {
      const root = await navigator.storage.getDirectory();
      await root
        .removeEntry(PARTIAL_DIR, {recursive: true})
        .catch((err: unknown) => {
          if ((err as {name?: string}).name !== 'NotFoundError') throw err;
        });
    },
  };
}
