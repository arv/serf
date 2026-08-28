import {CacheManager, ModelManager} from '@wllama/wllama/esm/index.js';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  discardPartialModel,
  hasWholeModel,
  type ModelCache,
  type ModelCacheEntry,
} from './modelCache.ts';

/**
 * The real wllama, not a stand-in: what is being pinned down here is the
 * library's own behavior around a half-written file, and a mock of it
 * would only assert what we already believe. wllama talks to a
 * StorageBackend and to fetch — both are supplied below, so the whole
 * download path runs in node over an in-memory disk.
 */

const URL_ = 'https://example.test/models/qwen2.5-0.5b-instruct-q4_k_m.gguf';
const HF_URL =
  'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/model.gguf';
const SIZE = 4096;

/** wllama's storage contract, over a Map. */
function memoryBackend(): {
  files: Map<string, Uint8Array>;
  isSupported(): boolean;
  read(key: string): Promise<Blob | null>;
  write(key: string, stream: ReadableStream<Uint8Array>): Promise<void>;
  getSize(key: string): Promise<number>;
  list(): Promise<{key: string; size: number}[]>;
  delete(key: string): Promise<void>;
} {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    isSupported: () => true,
    read: async key => {
      const bytes = files.get(key);
      return bytes ? new Blob([bytes as BlobPart]) : null;
    },
    write: async (key, stream) => {
      const chunks: BlobPart[] = [];
      const reader = stream.getReader();
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value as BlobPart);
      }
      files.set(key, new Uint8Array(await new Blob(chunks).arrayBuffer()));
    },
    getSize: async key => files.get(key)?.length ?? -1,
    list: async () =>
      [...files].map(([key, bytes]) => ({key, size: bytes.length})),
    delete: async key => void files.delete(key),
  };
}

/** The storage key wllama derives from a URL: sha1(url) + '_' + filename. */
async function cacheKey(url: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(url),
  );
  const hex = [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex}_${url.split('/').pop()}`;
}

/** A weights host: HEAD for the size, GET for the bytes, and the LFS
 * pointer wllama reads to learn a Hugging Face file's sha256. */
function serveModel(): void {
  vi.stubGlobal('fetch', (input: string, init?: {method?: string}) => {
    const url = String(input);
    if (url.includes('/raw/')) {
      return Promise.resolve(
        new Response(`oid sha256:${'a'.repeat(64)}\nsize ${SIZE}\n`),
      );
    }
    const headers = {'content-length': String(SIZE), 'etag': '"v1"'};
    if (init?.method === 'HEAD')
      return Promise.resolve(new Response(null, {headers}));
    return Promise.resolve(
      new Response(new Uint8Array(SIZE) as BodyInit, {headers}),
    );
  });
}

const quiet = {debug: () => {}, log: () => {}, warn: () => {}, error: () => {}};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('discardPartialModel', () => {
  /** Entries as CacheManager.list() reports them, over a fake cache. */
  function fakeCache(
    entries: ModelCacheEntry[],
  ): ModelCache & {deleted: string[]} {
    const deleted: string[] = [];
    return {
      deleted,
      list: () => Promise.resolve(entries),
      getNameFromURL: url => Promise.resolve(`key(${url})`),
      delete: name => {
        deleted.push(name);
        return Promise.resolve();
      },
    };
  }

  const entry = (over: Partial<ModelCacheEntry> = {}): ModelCacheEntry => ({
    name: `key(${URL_})`,
    size: SIZE,
    metadata: {originalURL: URL_, originalSize: SIZE},
    ...over,
  });

  it('keeps a whole download', async () => {
    const cache = fakeCache([entry()]);
    expect(await discardPartialModel(cache, URL_)).toBe(0);
    expect(cache.deleted).toEqual([]);
  });

  it('discards bytes left under the model’s name with no metadata', async () => {
    // What an interrupted download leaves: the file is there, but nothing
    // records which URL it came from, so list() reports it untagged.
    const cache = fakeCache([
      entry({size: 900, metadata: {originalURL: '', originalSize: 900}}),
    ]);
    expect(await discardPartialModel(cache, URL_)).toBe(1);
    expect(cache.deleted).toEqual([`key(${URL_})`]);
  });

  it('discards a tagged entry whose bytes fall short of its metadata', async () => {
    const cache = fakeCache([entry({size: SIZE - 1})]);
    expect(await discardPartialModel(cache, URL_)).toBe(1);
  });

  it('discards a tagged entry too small to be a model at all', async () => {
    // Self-consistent (bytes match the record) but under wllama's 16-byte
    // validation floor: calling this whole would report ready on a file
    // wllama itself will refuse to load.
    const cache = fakeCache([
      entry({size: 8, metadata: {originalURL: URL_, originalSize: 8}}),
    ]);
    expect(await hasWholeModel(cache, URL_)).toBe(false);
    expect(await discardPartialModel(cache, URL_)).toBe(1);
  });

  it('leaves other models alone, whole or broken', async () => {
    const other = 'https://example.test/models/other.gguf';
    const cache = fakeCache([
      entry({
        name: 'key(other)',
        metadata: {originalURL: other, originalSize: SIZE},
      }),
      entry({
        name: 'key(other-partial)',
        metadata: {originalURL: '', originalSize: SIZE},
      }),
    ]);
    expect(await discardPartialModel(cache, URL_)).toBe(0);
    expect(cache.deleted).toEqual([]);
  });
});

describe('the wllama cache, as the sweep finds it', () => {
  function manager(): {
    mm: ModelManager;
    backend: ReturnType<typeof memoryBackend>;
  } {
    const backend = memoryBackend();
    const mm = new ModelManager({
      cacheManager: new CacheManager([backend]),
      logger: quiet,
    });
    return {mm, backend};
  }

  it('downloads and caches a model when the cache is empty', async () => {
    serveModel();
    const {mm, backend} = manager();
    const model = await mm.downloadModel(HF_URL);
    expect(model.size).toBe(SIZE);
    expect(backend.files.get(await cacheKey(HF_URL))?.length).toBe(SIZE);
    expect((await mm.getModels()).map(m => m.url)).toEqual([HF_URL]);
  });

  /**
   * The bug this module exists for. wllama checks only that a file of the
   * right *name* exists before deciding the download is already done, so
   * the leftovers of an interrupted attempt make it skip the network — and
   * then fail looking for a cache entry tagged with the model's URL.
   * Nothing in wllama repairs that, which is why every attempt afterwards
   * fails identically until the entry is thrown away.
   */
  it('fails forever on the leftovers of an interrupted download', async () => {
    serveModel();
    const {mm, backend} = manager();
    backend.files.set(await cacheKey(HF_URL), new Uint8Array(SIZE / 4));

    await expect(mm.downloadModel(HF_URL)).rejects.toThrow(
      `Model file not found: ${HF_URL}`,
    );
    // Not a bad run: the retry that a player's next match amounts to hits
    // exactly the same wall, and the partial is still sitting there.
    await expect(mm.downloadModel(HF_URL)).rejects.toThrow(
      `Model file not found: ${HF_URL}`,
    );
    expect(backend.files.get(await cacheKey(HF_URL))?.length).toBe(SIZE / 4);
  });

  it('downloads again once the sweep has thrown the leftovers away', async () => {
    serveModel();
    const {mm, backend} = manager();
    backend.files.set(await cacheKey(HF_URL), new Uint8Array(SIZE / 4));

    expect(await discardPartialModel(mm.cacheManager, HF_URL)).toBe(1);
    const model = await mm.downloadModel(HF_URL);
    expect(model.size).toBe(SIZE);
    expect(backend.files.get(await cacheKey(HF_URL))?.length).toBe(SIZE);
  });

  it('leaves a finished download in the cache to be reused', async () => {
    serveModel();
    const {mm} = manager();
    await mm.downloadModel(HF_URL);
    expect(await discardPartialModel(mm.cacheManager, HF_URL)).toBe(0);
    expect((await mm.getModels()).map(m => m.url)).toEqual([HF_URL]);
  });
});
