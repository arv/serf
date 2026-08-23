/**
 * The model cache's repair crew.
 *
 * wllama stores a downloaded GGUF as two files: the bytes, and a metadata
 * record written *after* the last byte lands. A download that stops early
 * — the menu handing over to a match, a closed tab, a toggle flipped off —
 * leaves the first without the second, and that half-state is one wllama
 * never recovers from on its own:
 *
 *   - `CacheManager.download` asks the storage backend whether a file of
 *     that name exists before fetching anything. A partial file answers
 *     yes, so it skips the network entirely and returns as if cached.
 *   - `Model.refresh` then looks for a cache entry tagged with the model's
 *     URL. The partial has no metadata, so it is tagged with nothing, and
 *     the lookup throws `Model file not found: <url>`.
 *
 * Nothing in that path ever deletes or repairs the partial, so the failure
 * is not a bad run — it is permanent. Once a single download is
 * interrupted, every later attempt short-circuits to the same throw, in
 * this match and every match after it, until the origin's storage is
 * cleared by hand. Since the start menu warms the model in the background
 * and aborts that warm-up the moment the player launches, interrupting the
 * download is the *ordinary* path, not the unlucky one.
 *
 * So the wreckage is swept before every attempt: an entry that is not a
 * complete, correctly tagged copy of the model is worse than no entry at
 * all, because no entry at least downloads.
 *
 * The resumable downloader (modelDownload.ts) never leaves this wreckage —
 * its partials live in their own directory, as a resume point rather than
 * a poison. The sweep stays for the paths where wllama still fetches for
 * itself (browsers the resumable store can't serve) and for leftovers of
 * sessions that predate it.
 */

/** A cache entry as `CacheManager.list()` reports it. Structural, so
 * wllama's own CacheManager satisfies it and tests can pass a fake. */
export interface ModelCacheEntry {
  /** Storage key: `${hashSHA1(url)}_${fileName}`. */
  name: string;
  /** Bytes actually on disk. */
  size: number;
  metadata: {
    /** The URL the file was downloaded from — empty when the metadata
     * record was never written, which is exactly the broken case. */
    originalURL: string;
    /** Bytes the download was supposed to produce. */
    originalSize: number;
  };
}

/** The slice of wllama's CacheManager this needs. */
export interface ModelCache {
  list(): Promise<ModelCacheEntry[]>;
  getNameFromURL(url: string): Promise<string>;
  /** Removes the file and its metadata record together. */
  delete(nameOrURL: string): Promise<void>;
}

/** Whole means both halves agree: the metadata record exists and says
 * this URL, and the bytes on disk are as many as it promised. */
function isWholeCopy(entry: ModelCacheEntry, url: string): boolean {
  return entry.metadata.originalURL === url && entry.metadata.originalSize === entry.size;
}

/**
 * Whether the cache holds a complete, correctly tagged copy of `url` — the
 * same judgment the sweep below makes, asked the other way around. This is
 * what lets a caller skip the network entirely (and what wllama's own
 * `Model.validate` will agree with when it goes looking).
 */
export async function hasWholeModel(cache: ModelCache, url: string): Promise<boolean> {
  const entries = await cache.list();
  return entries.some((entry) => isWholeCopy(entry, url));
}

/**
 * Drop every cache entry for `url` that is not a whole, correctly tagged
 * copy of it. A complete download is left alone — that is the whole point
 * of the cache — and entries belonging to other models are never touched.
 *
 * @returns how many entries were discarded, for the log line.
 */
export async function discardPartialModel(cache: ModelCache, url: string): Promise<number> {
  // Two ways an entry can be this model's: it carries the URL (a finished
  // download), or it merely occupies the name derived from that URL (an
  // interrupted one, which carries nothing at all). The second is the case
  // that matters — it is the file wllama would mistake for a hit.
  const key = await cache.getNameFromURL(url);
  const entries = await cache.list();
  let discarded = 0;
  for (const entry of entries) {
    if (entry.name !== key && entry.metadata.originalURL !== url) continue;
    if (isWholeCopy(entry, url)) continue;
    await cache.delete(entry.name);
    discarded++;
  }
  return discarded;
}
