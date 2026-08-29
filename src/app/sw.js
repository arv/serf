/**
 * Serf Valley's offline service worker.
 *
 * Single player is entirely local — a World in a Web Worker, no server in
 * the loop — so once the bytes are on the device there is no reason a
 * skirmish should need the network. This worker makes that true: it
 * precaches the app shell and the KayKit models, then serves both from
 * disk, so a cold launch on a plane starts a valley just as fast as one at
 * home. Multiplayer still needs the relay, and the start menu says so.
 *
 * Not bundled: build/swPlugin.ts copies this file into dist/ verbatim
 * except for the four placeholders below, which it fills with the built
 * file names and a version stamp. Keep it plain ES2022 with no imports.
 */

/* eslint-env serviceworker */

/** Bumped by the plugin whenever a shell file changes, which is what
 * retires the old cache. Assets version separately: a JS-only deploy must
 * not re-download 10 MB of models. */
const SHELL_CACHE = 'serf-shell-__SHELL_VERSION__';
const ASSET_CACHE = 'serf-assets-__ASSET_VERSION__';

/** The document, its bundle, the fonts, the icons — everything needed to
 * put a playable menu on screen. */
const SHELL = ['__SHELL__'];
/** The KayKit GLTF/GLB packs. Heavy, rarely changing, and the renderer
 * falls back to procedural models without them — so they install
 * best-effort rather than holding up the shell. */
const ASSETS = ['__ASSETS__'];

/** Cache key every navigation resolves to, whatever query it carried. */
const DOCUMENT = '/index.html';

/** Concurrent asset fetches while warming the cache. Enough to keep the
 * connection busy, few enough to leave room for the page's own loads. */
const WARM_BATCH = 6;

self.addEventListener('install', event => {
  event.waitUntil(precache());
});

self.addEventListener('activate', event => {
  event.waitUntil(activate());
});

// The page asks for the handover rather than us seizing it: a new worker
// that claims mid-match would pull the rug on a running game (see
// serviceWorker.ts, which only sends this from the menu).
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'skip-waiting') void self.skipWaiting();
});

async function precache() {
  // The shell is all-or-nothing: a half-cached bundle is worse than no
  // worker at all, and a rejection here leaves the old one in charge.
  const shell = await caches.open(SHELL_CACHE);
  await shell.addAll(SHELL);
  await warmAssets();
}

async function warmAssets() {
  const cache = await caches.open(ASSET_CACHE);
  // Carried over from the previous version of the shell: same URLs, same
  // cache name, nothing to fetch.
  const have = new Set(
    (await cache.keys()).map(req => new URL(req.url).pathname),
  );
  const missing = ASSETS.filter(url => !have.has(url));
  for (let i = 0; i < missing.length; i += WARM_BATCH) {
    await Promise.all(
      // These are immutable and were almost certainly just pulled by the
      // page itself, so this is an HTTP-cache read, not a second download.
      missing
        .slice(i, i + WARM_BATCH)
        .map(url => cache.add(url).catch(() => undefined)),
    );
  }
}

async function activate() {
  const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
  const names = await caches.keys();
  await Promise.all(
    names
      .filter(name => name.startsWith('serf-') && !keep.has(name))
      .map(n => caches.delete(n)),
  );
  await self.clients.claim();
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // The relay lives on this origin too, but it is a WebSocket upgrade and
  // never reaches here. What does reach here and must not be answered from
  // disk: range requests, and anything not ours.
  if (url.origin !== self.location.origin) return;
  if (request.headers.has('range')) return;

  if (request.mode === 'navigate') {
    event.respondWith(serveDocument(request));
    return;
  }
  event.respondWith(serveAsset(request));
});

/**
 * Every launch — '/', '/?seed=7', '/?mp=ABCDE' — is the same document, and
 * it comes from the cache. The response carries the COOP/COEP headers it
 * was fetched with, which is what keeps `crossOriginIsolated` (and so
 * SharedArrayBuffer, and so the whole sim) true offline.
 *
 * Cache-first, deliberately: freshness is the update flow's job, not this
 * request's. The browser revalidates sw.js on every navigation, and a new
 * worker precaches a new shell under a new name — so the deploy after this
 * one lands whole, instead of a fresh document being handed stale chunks.
 */
async function serveDocument(request) {
  const shell = await caches.open(SHELL_CACHE);
  const cached = await shell.match(DOCUMENT);
  if (cached) return cached;
  return fetch(request);
}

/** The families that belong in the asset cache — build/swPlugin.ts's
 * ASSET_PREFIXES, duplicated because this file takes no imports. */
const ASSET_FAMILIES = ['/models/', '/audio/'];

async function serveAsset(request) {
  const shell = await caches.open(SHELL_CACHE);
  const hit = await shell.match(request, {ignoreSearch: true});
  if (hit) return hit;
  const assets = await caches.open(ASSET_CACHE);
  const asset = await assets.match(request, {ignoreSearch: true});
  if (asset) return asset;

  // First sight of a model or sample the warm pass missed (or a file added
  // since). Serve it and keep it, so the next launch has it offline — but
  // ONLY the asset families. Everything else that lands here is either
  // already in the shell cache above, or a stale page asking for a chunk
  // the new deploy deleted — where the server's SPA fallback answers 200
  // with the document, and remembering THAT under the chunk's name poisons
  // the cache.
  const response = await fetch(request);
  const path = new URL(request.url).pathname;
  // The content-type guard closes the same trap from the other side: an
  // old page asking for an asset the new deploy deleted gets the server's
  // SPA fallback — 200, text/html — and remembering the DOCUMENT under a
  // model's URL poisons the cache as surely as caching it under a chunk's.
  const isHtml = (response.headers.get('content-type') ?? '').includes(
    'text/html',
  );
  if (
    ASSET_FAMILIES.some(p => path.startsWith(p)) &&
    response.ok &&
    response.type === 'basic' &&
    !isHtml
  ) {
    void assets.put(request, response.clone());
  }
  return response;
}
