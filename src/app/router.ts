/**
 * The page's one navigator.
 *
 * Serf used to change screens by changing `location`: the start menu wrote
 * `location.search` and the whole document came back up in a match. It
 * worked, and it cost a full reload for every launch — the bundle re-parsed,
 * the models re-fetched from cache, the WebGL context re-negotiated. It also
 * cost the one thing that cannot be re-negotiated: unloading a document
 * fully exits fullscreen, so a player who asked for it was dropped out of it
 * on the way into the very match they asked for.
 *
 * Multiplayer never had that problem — the War Council hands its match over
 * in place — and this module gives every other screen change the same shape.
 * A navigation here changes the URL and calls one handler; nothing unloads.
 *
 * The URL stays the source of truth rather than becoming decoration. Every
 * screen is still fully described by its query string, so a real reload — a
 * shared link, the GPU-loss recovery, the service worker's update swap —
 * lands exactly where it did before.
 *
 * Where the Navigation API exists (Baseline as of early 2026) it is the
 * better half of this: one `navigate` event covers our own calls and the
 * back/forward gestures alike, so Back out of a match runs the same code
 * path as Quit to menu instead of being a reload. Elsewhere the same shape
 * is assembled out of pushState and popstate.
 */

/**
 * What the app does when the URL becomes a different screen.
 *
 * `force` is set by the two navigations that name the screen already on the
 * glass and mean it: Play again and Watch again. Everything else is
 * expected to be idempotent — the menu edits its own address bar as the
 * council names a room, and both pushState and replaceState arrive here as
 * navigations.
 */
export type RouteHandler = (opts: { force: boolean }) => Promise<void>;

/** The slice of the Navigation API this uses, structurally — the DOM lib
 * cannot be relied on to describe it yet. */
interface NavigateEventLike extends Event {
  readonly canIntercept: boolean;
  readonly hashChange: boolean;
  readonly downloadRequest: string | null;
  readonly formData: unknown;
  readonly navigationType: 'push' | 'replace' | 'reload' | 'traverse';
  readonly destination: { readonly url: string };
  intercept(opts: { handler: () => Promise<void> }): void;
}
interface NavigationLike extends EventTarget {
  navigate(
    url: string,
    opts?: { history?: 'auto' | 'push' | 'replace' },
  ): { committed: Promise<unknown>; finished: Promise<unknown> };
}

function navigationApi(): NavigationLike | null {
  return (window as unknown as { navigation?: NavigationLike }).navigation ?? null;
}

let handler: RouteHandler | null = null;
/**
 * Set by goto({force}) and read by the very next run. A field rather than
 * an argument because the trip in between belongs to the browser: goto
 * hands the URL to the Navigation API, which hands a navigate event back,
 * and nothing of ours rides along.
 */
let forceNext = false;

/**
 * Run the handler, and let a failure stop here.
 *
 * Nothing above this is in a position to handle one. A navigation's caller
 * is usually a click handler with nowhere to put a rejection, and a back
 * gesture has no caller at all — so rethrowing only chose where the
 * complaint surfaced: the Navigation API path would reject out of
 * intercept()'s handler as an unhandled rejection, while the popstate path
 * swallowed it. The screen that failed has already said so on its own
 * terms (fatal() puts its own page up), so this logs and stops, the same
 * way on both.
 */
async function run(): Promise<void> {
  const force = forceNext;
  forceNext = false;
  try {
    await handler?.({ force });
  } catch (err) {
    console.error('[router] the screen failed to come up:', err);
  }
}

/**
 * Wire the router up, once, at boot. `onRoute` is called for every screen
 * change from here on — ours and the browser's back/forward alike — and is
 * expected to read `location` and put the right thing on the page.
 */
export function startRouter(onRoute: RouteHandler): void {
  handler = onRoute;
  const nav = navigationApi();
  if (nav) {
    nav.addEventListener('navigate', (event) => {
      const e = event as NavigateEventLike;
      // Anything that is not "same page, different screen" belongs to the
      // browser. A reload especially: it is the recovery path the GPU-loss
      // handler and the service worker swap both rely on, and intercepting
      // it would quietly turn a deliberate fresh start into a soft one.
      if (!e.canIntercept || e.hashChange || e.downloadRequest !== null || e.formData) return;
      if (e.navigationType === 'reload') return;
      if (new URL(e.destination.url).origin !== location.origin) return;
      e.intercept({ handler: run });
    });
    return;
  }
  // No Navigation API: pushState moves the URL and popstate is how the
  // back gesture arrives. Same two jobs, more seams.
  window.addEventListener('popstate', () => void run());
}

/**
 * Go to a screen, in this document. `url` is a query string or path — the
 * same string that used to be assigned to `location`.
 */
export function goto(url: string, opts: { force?: boolean } = {}): void {
  const force = opts.force === true;
  forceNext = force;
  // "Again" replaces rather than pushes: the match being restarted is not a
  // place the player came from, and a Play again pressed five times should
  // still leave Back meaning the menu.
  const mode = force ? 'replace' : 'push';
  const nav = navigationApi();
  if (nav) {
    // Both promises reject when a navigation is superseded or aborted —
    // a second click while the first screen is still building — and
    // neither is anyone's to await here.
    const { committed, finished } = nav.navigate(url, { history: mode });
    void committed.catch(() => undefined);
    void finished.catch(() => undefined);
    return;
  }
  if (mode === 'replace') history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  void run();
}

/** True where a screen change costs no document. Only for telling the
 * player what to expect — every path works either way. */
export function inDocumentNavigation(): boolean {
  return navigationApi() !== null || typeof history.pushState === 'function';
}
