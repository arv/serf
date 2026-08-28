/**
 * Service worker registration and the update handshake.
 *
 * The worker itself (src/app/sw.js, stamped into dist/sw.js by
 * build/swPlugin.ts) does the caching; this module decides *when* a new
 * one is allowed to take over. That matters because a match is a page:
 * every launch is a navigation and every save lives on this origin, so a
 * worker that claimed its clients the moment it installed would swap the
 * shell out from under a running game. Instead the new worker waits, and
 * we only wave it through from the start menu, where nothing is at stake.
 */

const SW_URL = '/sw.js';

let reloading = false;
let held = false;
/** Whether a worker has already been asked to take over. */
let waved = false;
/** The registration this page is watching, once install() has one. */
let watched: ServiceWorkerRegistration | null = null;

function takeOver(worker: ServiceWorker): void {
  // Nothing is controlling this page yet, so this is a first install:
  // there is no stale shell to replace and nothing to reload for.
  if (!navigator.serviceWorker.controller || waved || held) return;
  waved = true;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // A match may have started since the wave-through; a reload under a
    // running game is exactly what the handshake exists to avoid.
    if (reloading || held) return;
    reloading = true;
    location.reload();
  });
  worker.postMessage({type: 'skip-waiting'});
}

function track(worker: ServiceWorker | null): void {
  if (!worker) return;
  if (worker.state === 'installed') {
    takeOver(worker);
    return;
  }
  worker.addEventListener('statechange', () => {
    if (worker.state === 'installed') takeOver(worker);
  });
}

/**
 * Stop waving updates through. The menu registers with applyUpdates on —
 * nothing is at stake there — but the War Council hands its match over
 * without a navigation, so by the time a worker finishes installing this
 * page may have become a running game. Called as a match takes over: the
 * new worker stays parked, and the next launch picks it up.
 */
export function holdServiceWorkerUpdates(): void {
  held = true;
}

/**
 * Start waving them through again. A match used to end by unloading the
 * page, so the hold ended with the document — and the reload that brought
 * the menu back re-ran the whole handshake, which is what actually
 * collected a parked worker. Now the player walks back to the menu in
 * place and nothing re-runs, so lowering the flag has to do that work
 * itself: a worker that reached 'installed' while the match was up was
 * offered to takeOver() then and turned away, and 'installed' is not a
 * state it enters twice, so without asking again it would sit in `waiting`
 * for the rest of the session.
 */
export function releaseServiceWorkerUpdates(): void {
  held = false;
  const registration = watched;
  // Still resolving: install() tracks both workers itself when it lands,
  // and by then the flag is down.
  if (!registration) return;
  track(registration.waiting);
  track(registration.installing);
  // The menu is also where asking is affordable — the check below is
  // skipped while a match is booting so it does not compete for
  // connections with the models.
  if (navigator.onLine) void registration.update().catch(() => undefined);
}

/**
 * @param opts.applyUpdates true on the start menu — no sim, no unsaved
 * village, so a pending update can take over and the page reload straight
 * into it. False when the page boots straight into a match: the update
 * stays parked until the player next passes through the menu, which is
 * releaseServiceWorkerUpdates()'s job to notice.
 *
 * It is the opening value of the same hold the menu and a match raise and
 * lower, rather than a separate switch — one flag decides throughout, so
 * the worker found by a boot that went straight into a match is still
 * being watched when the flag comes down.
 */
export function registerServiceWorker(opts: {applyUpdates: boolean}): void {
  held = !opts.applyUpdates;
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) {
    // Dev serves from Vite with no hashed names; a worker left over from a
    // production build (or a preview on the same localhost port) would
    // happily answer with last week's bundle.
    void navigator.serviceWorker.getRegistrations().then(regs => {
      for (const reg of regs) void reg.unregister();
    });
    return;
  }
  // Registration competes with the boot fetches — the models, the worker
  // bundle — for connections. Losing that race costs the first launch
  // nothing and wins nothing either, so wait until the page has its bytes.
  window.addEventListener('load', () => {
    void install().catch((err: unknown) => {
      // Offline support is a bonus; the game does not depend on it.
      console.warn('[sw] not registered:', err);
    });
  });
}

async function install(): Promise<void> {
  const script = new URL(SW_URL, location.href).href;
  const existing = await navigator.serviceWorker.getRegistration('/');
  const current = existing?.active ?? existing?.waiting ?? existing?.installing;
  // Only register when there is nothing to register. Re-registering an
  // identical worker is meant to be a cheap no-op, but its promise joins
  // the registration's job queue behind the update check the browser
  // queued for this navigation — which Chrome is in no hurry to run, and
  // measurably does not, so awaiting it strands everything below.
  const registration =
    existing && current?.scriptURL === script
      ? existing
      : await navigator.serviceWorker.register(SW_URL, {
          scope: '/',
          // Our own static server marks .js immutable for a year. That is
          // right for hashed chunks and very wrong for the worker script,
          // the one file whose freshness decides whether an update is
          // ever seen.
          updateViaCache: 'none',
        });
  // Watched either way. Whether a worker may take over is `held`'s business
  // alone now, and a page that booted straight into a match still has to
  // notice the worker it will be handed when the player reaches the menu.
  watched = registration;

  // Three ways a new worker can be in play by now: parked from an earlier
  // visit that was mid-match when it arrived, still installing from one, or
  // about to be found by the check below. All of them arrive here as
  // events, which is what lets the check be asked for and then forgotten.
  track(registration.waiting);
  track(registration.installing);
  registration.addEventListener('updatefound', () =>
    track(registration.installing),
  );

  // Ask outright rather than trusting the browser's own check: every launch
  // here is a navigation the worker answers from its cache, and Chrome is
  // free to defer the update that navigation implies. Asking costs one GET
  // of a few KB; the answer lands whenever it lands (a minute is normal),
  // and the handover above is waiting for it.
  //
  // Not while a match is booting, though: there it would compete with the
  // models for connections, and releaseServiceWorkerUpdates() asks on the
  // way back to the menu instead.
  if (!held && navigator.onLine) await registration.update();
}
