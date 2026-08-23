import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheManager, ModelManager } from '@wllama/wllama/esm/index.js';
import {
  ensureModelCached,
  opfsPartialStore,
  type PartialMeta,
  type PartialPart,
  type PartialStore,
} from './modelDownload.ts';

/**
 * The downloader against the real wllama cache, as in modelCache.test.ts:
 * what must hold is not just that bytes move, but that what lands in the
 * cache is indistinguishable from a download wllama made itself — found
 * by getModels, judged valid, left alone by the sweep. The two seams the
 * browser supplies are supplied here instead: fetch (a scriptable weights
 * host that can die mid-body, forget its ETag, or ignore Range) and the
 * partial store (a Map standing in for the OPFS directory).
 */

const URL_ = 'https://example.test/models/lfm.gguf';
const SIZE = 4096;
/** Position-dependent bytes, so a splice of two versions — or a resume
 * that starts one byte off — can never equal the original. */
const BYTES = Uint8Array.from({ length: SIZE }, (_, i) => (i * 7 + (i >> 8)) % 256);
/** Small parts so every download spans many commits. */
const PART = 256;

/** wllama's storage contract, over a Map. */
function memoryBackend(): {
  files: Map<string, Uint8Array>;
  isSupported(): boolean;
  read(key: string): Promise<Blob | null>;
  write(key: string, stream: ReadableStream<Uint8Array>): Promise<void>;
  getSize(key: string): Promise<number>;
  list(): Promise<{ key: string; size: number }[]>;
  delete(key: string): Promise<void>;
} {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    isSupported: () => true,
    read: async (key) => {
      const bytes = files.get(key);
      return bytes ? new Blob([bytes as BlobPart]) : null;
    },
    write: async (key, stream) => {
      const chunks: BlobPart[] = [];
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value as BlobPart);
      }
      files.set(key, new Uint8Array(await new Blob(chunks).arrayBuffer()));
    },
    getSize: async (key) => files.get(key)?.length ?? -1,
    list: async () => [...files].map(([key, bytes]) => ({ key, size: bytes.length })),
    delete: async (key) => void files.delete(key),
  };
}

/** The storage key wllama derives from a URL: sha1(url) + '_' + filename. */
async function cacheKey(url: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(url));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex}_${url.split('/').pop()}`;
}

/** The partial store's contract, over a Map. */
function memoryStore(): PartialStore & {
  meta: () => PartialMeta | null;
  held: () => number;
  maxPart: () => number;
} {
  let meta: PartialMeta | null = null;
  let maxPart = 0;
  const parts = new Map<string, Uint8Array>();
  return {
    meta: () => meta,
    /** Bytes waiting in parts, for the salvage assertions. */
    held: () => [...parts.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    /** The largest part ever committed — the commit-granularity bound. */
    maxPart: () => maxPart,
    readMeta: async () => meta,
    writeMeta: async (m) => {
      meta = m;
    },
    listParts: async (): Promise<PartialPart[]> =>
      [...parts.entries()].map(([key, bytes]) => {
        const [attempt, offset] = key.split(':') as [string, string];
        return { attempt, offset: Number(offset), size: bytes.length, blob: new Blob([bytes as BlobPart]) };
      }),
    writePart: async (attempt, offset, bytes) => {
      maxPart = Math.max(maxPart, bytes.length);
      parts.set(`${attempt}:${offset}`, bytes.slice());
    },
    deletePart: async (attempt, offset) => {
      parts.delete(`${attempt}:${offset}`);
    },
    clear: async () => {
      meta = null;
      parts.clear();
    },
  };
}

/** One response's script. Defaults to serving everything asked for. */
interface Plan {
  /** Reject the fetch itself (a network or CORS layer, not an HTTP answer). */
  reject?: string;
  /** Answer with this bare status (416, 503, ...). */
  status?: number;
  /** Serve only this many bytes of the requested slice, then break the
   * stream — or end it politely when `clean` is set. */
  serve?: number;
  clean?: boolean;
  /** Answer 206 starting at this offset even though no Range was asked —
   * the noncompliant server the adopt path must refuse. */
  shift?: number;
}

/**
 * A scriptable weights host. Honors single open-ended Range requests
 * (unless told not to), names an ETag (unless told otherwise), and takes a
 * queue of per-request plans — an empty queue means every request succeeds
 * whole.
 */
function weightsHost(
  opts: {
    etag?: string;
    ranges?: boolean;
    bytes?: Uint8Array;
    /** A server (or proxy) that never says how big the file is. */
    noLength?: boolean;
    /** A Content-Length that is not a number at all. */
    badLength?: boolean;
    /** Headers a CORS layer strips from 206 answers only. */
    hide206?: ('etag' | 'content-range')[];
  } = {},
): {
  fetcher: typeof fetch;
  calls: { range: string | null }[];
  plans: Plan[];
  setBytes: (bytes: Uint8Array) => void;
  setEtag: (etag: string) => void;
} {
  let bytes = opts.bytes ?? BYTES;
  let etag = opts.etag ?? '"v1"';
  const calls: { range: string | null }[] = [];
  const plans: Plan[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(URL_);
    const plan = plans.shift() ?? {};
    const range = new Headers(init?.headers).get('range');
    calls.push({ range });
    if (plan.reject !== undefined) throw new Error(plan.reject);
    if (plan.status !== undefined) return new Response(null, { status: plan.status });
    const match = opts.ranges === false ? null : range && /^bytes=(\d+)-$/.exec(range);
    const start = plan.shift ?? (match ? Number(match[1]) : 0);
    const partial = plan.shift !== undefined || match !== null;
    const slice = bytes.slice(start);
    const headers: Record<string, string> = {};
    if (!opts.noLength) {
      headers['content-length'] = opts.badLength ? 'garbage' : String(slice.length);
    }
    if (etag !== '') headers.etag = etag;
    if (partial) {
      headers['content-range'] = `bytes ${start}-${bytes.length - 1}/${bytes.length}`;
      for (const name of opts.hide206 ?? []) delete headers[name];
    }
    const cut = plan.serve ?? slice.length;
    let at = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (at >= cut) {
          if (cut < slice.length && !plan.clean) {
            controller.error(new Error('connection lost'));
          } else {
            controller.close();
          }
          return;
        }
        const end = Math.min(at + 64, cut);
        controller.enqueue(slice.slice(at, end));
        at = end;
      },
    });
    return new Response(body, { status: partial ? 206 : 200, headers });
  }) as typeof fetch;
  return {
    fetcher,
    calls,
    plans,
    setBytes: (b) => {
      bytes = b;
    },
    setEtag: (e) => {
      etag = e;
    },
  };
}

function harness(hostOpts: Parameters<typeof weightsHost>[0] = {}): {
  backend: ReturnType<typeof memoryBackend>;
  cache: CacheManager;
  store: ReturnType<typeof memoryStore>;
  host: ReturnType<typeof weightsHost>;
  ensure: (over?: {
    signal?: AbortSignal;
    onProgress?: (p: { loaded: number; total: number }) => void;
  }) => ReturnType<typeof ensureModelCached>;
} {
  const backend = memoryBackend();
  const cache = new CacheManager([backend]);
  const store = memoryStore();
  const host = weightsHost(hostOpts);
  return {
    backend,
    cache,
    store,
    host,
    ensure: (over = {}) =>
      ensureModelCached(cache, URL_, {
        store,
        fetcher: host.fetcher,
        partBytes: PART,
        ...over,
      }),
  };
}

const quiet = { debug: () => {}, log: () => {}, warn: () => {}, error: () => {} };

/**
 * A miniature OPFS: named directories of named byte arrays, swap-on-close
 * writables — just enough surface for opfsPartialStore to run for real,
 * so its binary round-trip, part-name parsing and recursive clear are
 * covered and not merely believed.
 */
function fakeOpfs(): {
  storage: { getDirectory: () => Promise<unknown> };
  dirs: Map<string, Map<string, Uint8Array>>;
} {
  const dirs = new Map<string, Map<string, Uint8Array>>();
  const notFound = (): Error => Object.assign(new Error('not found'), { name: 'NotFoundError' });
  const fileHandle = (files: Map<string, Uint8Array>, name: string) => ({
    kind: 'file' as const,
    getFile: async () => new Blob([files.get(name) as BlobPart]),
    createWritable: async () => {
      // Swap semantics, like the real thing: nothing lands until close.
      const chunks: BlobPart[] = [];
      return {
        write: async (data: Uint8Array | string) => {
          chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : (data as BlobPart));
        },
        close: async () => {
          files.set(name, new Uint8Array(await new Blob(chunks).arrayBuffer()));
        },
      };
    },
  });
  const dirHandle = (files: Map<string, Uint8Array>) => ({
    getFileHandle: async (name: string, o?: { create?: boolean }) => {
      if (!files.has(name)) {
        if (!o?.create) throw notFound();
        files.set(name, new Uint8Array());
      }
      return fileHandle(files, name);
    },
    removeEntry: async (name: string) => {
      if (!files.delete(name)) throw notFound();
    },
    entries: async function* () {
      for (const name of [...files.keys()]) yield [name, fileHandle(files, name)] as const;
    },
  });
  const root = {
    getDirectoryHandle: async (name: string, o?: { create?: boolean }) => {
      if (!dirs.has(name)) {
        if (!o?.create) throw notFound();
        dirs.set(name, new Map());
      }
      return dirHandle(dirs.get(name)!);
    },
    removeEntry: async (name: string) => {
      if (!dirs.has(name)) throw notFound();
      dirs.delete(name);
    },
  };
  return { storage: { getDirectory: async () => root }, dirs };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** What the whole exercise is for: the model sits in wllama's cache
 * exactly as its own download would, bytes and record agreeing. */
async function expectInstalled(
  h: { backend: ReturnType<typeof memoryBackend>; cache: CacheManager },
  bytes: Uint8Array = BYTES,
): Promise<void> {
  expect(h.backend.files.get(await cacheKey(URL_))).toEqual(bytes);
  const mm = new ModelManager({ cacheManager: h.cache, logger: quiet });
  expect((await mm.getModels()).map((m) => m.url)).toEqual([URL_]);
}

describe('ensureModelCached', () => {
  it('downloads a cold model and installs it as wllama’s own', async () => {
    const h = harness();
    expect(await h.ensure()).toEqual({ status: 'downloaded', resumedFrom: 0 });
    await expectInstalled(h);
    // The record too, ETag stripped to alphanumerics the way wllama does.
    const entry = (await h.cache.list()).find((e) => e.metadata.originalURL === URL_)!;
    expect(entry.metadata).toMatchObject({ originalSize: SIZE, etag: 'v1' });
    // Staging is gone: nothing left to resume, nothing left to leak.
    expect(h.store.meta()).toBeNull();
    expect(h.store.held()).toBe(0);
  });

  it('fetches nothing when the cache already holds the model', async () => {
    const h = harness();
    await h.ensure();
    const fetched = h.host.calls.length;
    expect(await h.ensure()).toEqual({ status: 'cached', resumedFrom: 0 });
    expect(h.host.calls).toHaveLength(fetched);
  });

  it('keeps an interrupted download’s bytes and resumes where they stop', async () => {
    const h = harness();
    h.host.plans.push({ serve: 1000 });
    await expect(h.ensure()).rejects.toThrow('connection lost');
    // Salvaged to the last byte received, not the last part boundary.
    expect(h.store.held()).toBe(1000);
    expect(await h.ensure()).toEqual({ status: 'downloaded', resumedFrom: 1000 });
    expect(h.host.calls[1]).toEqual({ range: 'bytes=1000-' });
    await expectInstalled(h);
  });

  it('resumes across as many deaths as the connection cares to have', async () => {
    const h = harness();
    h.host.plans.push({ serve: 1000 }, { serve: 1500 });
    await expect(h.ensure()).rejects.toThrow('connection lost');
    await expect(h.ensure()).rejects.toThrow('connection lost');
    expect(await h.ensure()).toEqual({ status: 'downloaded', resumedFrom: 2500 });
    expect(h.host.calls.map((c) => c.range)).toEqual([null, 'bytes=1000-', 'bytes=2500-']);
    await expectInstalled(h);
  });

  it('counts progress from the resumed offset', async () => {
    const h = harness();
    h.host.plans.push({ serve: 1000 });
    await expect(h.ensure()).rejects.toThrow();
    const seen: { loaded: number; total: number }[] = [];
    await h.ensure({ onProgress: (p) => seen.push(p) });
    expect(seen[0]).toEqual({ loaded: 1000, total: SIZE });
    expect(seen.at(-1)).toEqual({ loaded: SIZE, total: SIZE });
  });

  it('a changed file restarts clean instead of splicing versions', async () => {
    const h = harness();
    h.host.plans.push({ serve: 1000 });
    await expect(h.ensure()).rejects.toThrow();
    // The model was republished: new bytes, new ETag. The 1000 old bytes
    // must not survive into the install.
    const v2 = Uint8Array.from({ length: SIZE }, (_, i) => (i * 13 + 5) % 256);
    h.host.setBytes(v2);
    h.host.setEtag('"v2"');
    expect(await h.ensure()).toEqual({ status: 'downloaded', resumedFrom: 0 });
    // The resume was offered, seen to be of a different file, abandoned.
    expect(h.host.calls.map((c) => c.range)).toEqual([null, 'bytes=1000-', null]);
    await expectInstalled(h, v2);
  });

  it('a server that ignores Range means a fresh start, not a failure', async () => {
    const h = harness({ ranges: false });
    h.host.plans.push({ serve: 1000 });
    await expect(h.ensure()).rejects.toThrow();
    expect(await h.ensure()).toEqual({ status: 'downloaded', resumedFrom: 0 });
    // The 200 that answered the ranged request was itself the whole file —
    // no third fetch.
    expect(h.host.calls).toHaveLength(2);
    await expectInstalled(h);
  });

  it('416 falls back to a fresh fetch', async () => {
    const h = harness();
    h.host.plans.push({ serve: 1000 });
    await expect(h.ensure()).rejects.toThrow();
    h.host.plans.push({ status: 416 });
    expect(await h.ensure()).toEqual({ status: 'downloaded', resumedFrom: 0 });
    expect(h.host.calls.map((c) => c.range)).toEqual([null, 'bytes=1000-', null]);
    await expectInstalled(h);
  });

  it('a ranged request refused outright retries as the plain fetch', async () => {
    // Not an HTTP answer: a CORS or proxy layer balking at the Range
    // header. Resuming must never fail where starting over would work.
    const h = harness();
    h.host.plans.push({ serve: 1000 });
    await expect(h.ensure()).rejects.toThrow();
    h.host.plans.push({ reject: 'preflight refused' });
    expect(await h.ensure()).toEqual({ status: 'downloaded', resumedFrom: 0 });
    expect(h.host.calls.map((c) => c.range)).toEqual([null, 'bytes=1000-', null]);
    await expectInstalled(h);
  });

  it('a deliberate abort surfaces as itself and keeps the bytes', async () => {
    const h = harness();
    h.host.plans.push({ serve: 1000 });
    await expect(h.ensure()).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    // Turned away at the lock, before any network or cache work — and
    // the partial survives for the load that comes next.
    await expect(h.ensure({ signal: controller.signal })).rejects.toThrow('aborted');
    expect(h.host.calls).toHaveLength(1);
    expect(h.store.held()).toBe(1000);
  });

  it('a stream that ends politely but early is a failure, not a finish', async () => {
    // The trap: install 1000 bytes under a record that says 1000 and the
    // cache holds a convincingly whole corrupt model forever.
    const h = harness();
    h.host.plans.push({ serve: 1000, clean: true });
    await expect(h.ensure()).rejects.toThrow('ended early (1000 of 4096 bytes)');
    expect(h.backend.files.size).toBe(0);
    expect(await h.ensure()).toEqual({ status: 'downloaded', resumedFrom: 1000 });
    await expectInstalled(h);
  });

  it('a download that died with every byte banked installs without fetching', async () => {
    // The session ended exactly between the last part landing and the
    // install — everything is here, nothing is owed to the network.
    const h = harness();
    await h.store.writeMeta({ url: URL_, etag: '"v1"', total: SIZE, attempt: 'aaaa' });
    for (let at = 0; at < SIZE; at += 1024) {
      await h.store.writePart('aaaa', at, BYTES.slice(at, at + 1024));
    }
    expect(await h.ensure()).toEqual({ status: 'downloaded', resumedFrom: SIZE });
    expect(h.host.calls).toHaveLength(0);
    await expectInstalled(h);
  });

  it('a server that names no ETag leaves nothing worth resuming', async () => {
    // No validator, no proof the next answer is the same file: the partial
    // is discarded rather than trusted.
    const h = harness({ etag: '' });
    h.host.plans.push({ serve: 1000 });
    await expect(h.ensure()).rejects.toThrow();
    expect(await h.ensure()).toEqual({ status: 'downloaded', resumedFrom: 0 });
    expect(h.host.calls.map((c) => c.range)).toEqual([null, null]);
    await expectInstalled(h);
  });

  it('a weak ETag counts as none', async () => {
    // W/ promises equivalence, not the byte identity that splicing ranges
    // together requires.
    const h = harness({ etag: 'W/"v1"' });
    h.host.plans.push({ serve: 1000 });
    await expect(h.ensure()).rejects.toThrow();
    expect(await h.ensure()).toEqual({ status: 'downloaded', resumedFrom: 0 });
    expect(h.host.calls.map((c) => c.range)).toEqual([null, null]);
    await expectInstalled(h);
  });

  it('a 206 that hides its ETag is not proof enough — fresh start', async () => {
    // The stored partial had a strong ETag, but the resume answer names
    // none (a CORS layer between): nothing proves it is the same file.
    const h = harness({ hide206: ['etag'] });
    h.host.plans.push({ serve: 1000 });
    await expect(h.ensure()).rejects.toThrow();
    expect(await h.ensure()).toEqual({ status: 'downloaded', resumedFrom: 0 });
    expect(h.host.calls.map((c) => c.range)).toEqual([null, 'bytes=1000-', null]);
    await expectInstalled(h);
  });

  it('a 206 that hides its Content-Range is not proof enough — fresh start', async () => {
    const h = harness({ hide206: ['content-range'] });
    h.host.plans.push({ serve: 1000 });
    await expect(h.ensure()).rejects.toThrow();
    expect(await h.ensure()).toEqual({ status: 'downloaded', resumedFrom: 0 });
    expect(h.host.calls.map((c) => c.range)).toEqual([null, 'bytes=1000-', null]);
    await expectInstalled(h);
  });

  it('a straggler from an abandoned attempt never joins the chain', async () => {
    // The race this guards: an aborted attempt's last flush landing after
    // a newer attempt has cleared and restarted. Its part carries the old
    // attempt id, so the chain ends where this attempt's own bytes do.
    const h = harness();
    await h.store.writeMeta({ url: URL_, etag: '"v1"', total: SIZE, attempt: 'aaaa' });
    await h.store.writePart('aaaa', 0, BYTES.slice(0, 512));
    await h.store.writePart('bbbb', 512, BYTES.slice(512, 768));
    expect(await h.ensure()).toEqual({ status: 'downloaded', resumedFrom: 512 });
    expect(h.host.calls[0]).toEqual({ range: 'bytes=512-' });
    await expectInstalled(h);
  });

  it('sweeps wllama’s own wreckage before downloading', async () => {
    // Bytes under the model's name with no metadata record — what an
    // interrupted wllama-native download leaves, and what wllama mistakes
    // for a cache hit forever (modelCache.ts).
    const h = harness();
    h.backend.files.set(await cacheKey(URL_), new Uint8Array(1024));
    expect(await h.ensure()).toEqual({ status: 'downloaded', resumedFrom: 0 });
    await expectInstalled(h);
  });

  it('reports unsupported — and fetches nothing — without a store', async () => {
    const h = harness();
    const result = await ensureModelCached(h.cache, URL_, {
      store: null,
      fetcher: h.host.fetcher,
    });
    expect(result).toEqual({ status: 'unsupported', resumedFrom: 0 });
    expect(h.host.calls).toHaveLength(0);
  });

  it('a store whose storage refuses to open means unsupported, not failure', async () => {
    // The API exists (the store was constructed) but the disk says no —
    // site data blocked, quota machinery wedged. The caller must get its
    // wllama fallback, not a dead strategist.
    const h = harness();
    h.store.listParts = () => Promise.reject(new Error('storage blocked'));
    expect(await h.ensure()).toEqual({ status: 'unsupported', resumedFrom: 0 });
    expect(h.host.calls).toHaveLength(0);
  });

  it('a store that refuses the staging record means unsupported too', async () => {
    // Reads worked, so the probe passed — but the first write (the record,
    // before any byte lands) fails. Same answer: wllama's own path.
    const h = harness();
    h.store.writeMeta = () => Promise.reject(new Error('quota exceeded'));
    expect(await h.ensure()).toEqual({ status: 'unsupported', resumedFrom: 0 });
    expect(h.host.calls).toHaveLength(1);
  });

  it('a server that never says the size is not this downloader’s to trust', async () => {
    // Without a total, a clean-looking stream cannot be proven complete,
    // and installing an unproven file would poison the cache. Stand aside
    // for wllama, which behaves for these servers as it always did.
    const h = harness({ noLength: true });
    expect(await h.ensure()).toEqual({ status: 'unsupported', resumedFrom: 0 });
    expect(h.host.calls).toHaveLength(1);
    expect(h.backend.files.size).toBe(0);
  });

  it('a Content-Length that is not a number counts as never said', async () => {
    // NaN in particular would sail past a <= 0 guard and turn a short
    // stream into an early-termination failure loop instead of the
    // wllama fallback.
    const h = harness({ badLength: true });
    expect(await h.ensure()).toEqual({ status: 'unsupported', resumedFrom: 0 });
    expect(h.host.calls).toHaveLength(1);
  });

  it('an unsolicited 206 is refused, never adopted at offset zero', async () => {
    // A noncompliant server answering a whole-file ask with shifted
    // bytes: adopting them at zero is the one corruption every later
    // check would bless, so nothing of it may enter the store.
    const h = harness();
    h.host.plans.push({ shift: 1000 });
    await expect(h.ensure()).rejects.toThrow('HTTP 206 to a whole-file request');
    expect(h.store.meta()).toBeNull();
    expect(h.store.held()).toBe(0);
    expect(h.backend.files.size).toBe(0);
  });

  it('a nonsense part granularity earns the default, not a hang', async () => {
    const h = harness();
    const result = await ensureModelCached(h.cache, URL_, {
      store: h.store,
      fetcher: h.host.fetcher,
      partBytes: 0,
    });
    expect(result).toEqual({ status: 'downloaded', resumedFrom: 0 });
    await expectInstalled(h);
  });

  it('the install frees each part as it copies, even when clear cannot run', async () => {
    // The quota argument: mid-install the store holds the uncopied tail,
    // not a second whole model. A broken clear() must not change that.
    const h = harness();
    h.store.clear = () => Promise.reject(new Error('clear refused'));
    expect(await h.ensure()).toEqual({ status: 'downloaded', resumedFrom: 0 });
    expect(h.store.held()).toBe(0);
    await expectInstalled(h);
  });

  it('a network chunk larger than the granularity is committed in bounded parts', async () => {
    // The host reads in 64-byte chunks; a 48-byte granularity means every
    // read overflows it. The bound must hold anyway — it is what keeps
    // the install's transient footprint one part, not one chunk.
    const h = harness();
    const result = await ensureModelCached(h.cache, URL_, {
      store: h.store,
      fetcher: h.host.fetcher,
      partBytes: 48,
    });
    expect(result).toEqual({ status: 'downloaded', resumedFrom: 0 });
    expect(h.store.maxPart()).toBeLessThanOrEqual(48);
    await expectInstalled(h);
  });

  it('overlap without Web Locks still queues within the page', async () => {
    // Node has no navigator.locks, so this exercises the module's own
    // queue: two callers, one fetch, the second finding the first's work.
    const h = harness();
    const [first, second] = await Promise.all([h.ensure(), h.ensure()]);
    expect([first.status, second.status].sort()).toEqual(['cached', 'downloaded']);
    expect(h.host.calls).toHaveLength(1);
    await expectInstalled(h);
  });

  it('a cache hit sweeps any partial stranded beside it', async () => {
    // The crash window: install succeeded, the cleanup after it did not.
    // Without the sweep the finished chain would double the model's
    // footprint forever, because every later call stops at "cached".
    const h = harness();
    await h.ensure();
    await h.store.writeMeta({ url: URL_, etag: '"v1"', total: SIZE, attempt: 'aaaa' });
    await h.store.writePart('aaaa', 0, BYTES.slice(0, 1024));
    expect(await h.ensure()).toEqual({ status: 'cached', resumedFrom: 0 });
    expect(h.store.meta()).toBeNull();
    expect(h.store.held()).toBe(0);
  });

  it('a cache that cannot be listed is a miss, not a dead end', async () => {
    // The probe must not take the download down with it: list() failing
    // transiently should cost a redundant fetch at worst.
    const backend = memoryBackend();
    const cache = new CacheManager([backend]);
    const store = memoryStore();
    const host = weightsHost();
    const result = await ensureModelCached(
      {
        list: () => Promise.reject(new Error('transient storage error')),
        getNameFromURL: (url) => cache.getNameFromURL(url),
        delete: (name) => cache.delete(name),
        write: (name, stream, metadata) => cache.write(name, stream, metadata),
      },
      URL_,
      { store, fetcher: host.fetcher, partBytes: PART },
    );
    expect(result).toEqual({ status: 'downloaded', resumedFrom: 0 });
    expect(backend.files.get(await cacheKey(URL_))).toEqual(BYTES);
  });

  it('overlapping downloads queue on the lock, and the second finds the first’s work', async () => {
    // The menu-to-match handoff can have two callers over one staging
    // directory; with a Web Lock they serialize, and the waiter's re-check
    // turns its download into a cache hit — one fetch, not two.
    let tail: Promise<unknown> = Promise.resolve();
    vi.stubGlobal('navigator', {
      locks: {
        request: (_name: string, _opts: unknown, work: () => Promise<unknown>) => {
          const run = tail.then(work);
          tail = run.catch(() => undefined);
          return run;
        },
      },
    });
    const h = harness();
    const [first, second] = await Promise.all([h.ensure(), h.ensure()]);
    expect([first.status, second.status].sort()).toEqual(['cached', 'downloaded']);
    expect(h.host.calls).toHaveLength(1);
    await expectInstalled(h);
  });

  it('carries a download across loads through the real OPFS store', async () => {
    // The production store over a faked OPFS: binary parts, the JSON
    // record, offset-named files and the recursive clear all round-trip,
    // with fresh handles standing in for the next page load.
    const world = fakeOpfs();
    vi.stubGlobal('navigator', {
      storage: world.storage,
      // Web Locks is part of the store's support contract; a pass-through
      // grant serializes nothing but proves the probe.
      locks: { request: (_name: string, _opts: unknown, work: () => Promise<unknown>) => work() },
    });
    vi.stubGlobal('FileSystemFileHandle', class { createWritable(): void {} });
    const backend = memoryBackend();
    const cache = new CacheManager([backend]);
    const host = weightsHost();
    const ensure = (): ReturnType<typeof ensureModelCached> =>
      ensureModelCached(cache, URL_, {
        store: opfsPartialStore(),
        fetcher: host.fetcher,
        partBytes: PART,
      });
    host.plans.push({ serve: 1000 });
    await expect(ensure()).rejects.toThrow('connection lost');
    expect(world.dirs.has('serf-llm-download')).toBe(true);
    expect(await ensure()).toEqual({ status: 'downloaded', resumedFrom: 1000 });
    expect(host.calls[1]).toEqual({ range: 'bytes=1000-' });
    expect(backend.files.get(await cacheKey(URL_))).toEqual(BYTES);
    // Installed and swept: the staging directory is gone.
    expect(world.dirs.has('serf-llm-download')).toBe(false);
  });
});

describe('opfsPartialStore', () => {
  it('declines this environment rather than half-working in it', () => {
    // Node has no OPFS; the store must say so and let the callers fall
    // back to wllama's own downloader, not throw from inside a download.
    expect(opfsPartialStore()).toBeNull();
  });
});
