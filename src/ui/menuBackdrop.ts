import type { Backdrop } from './backdropScene';

export type { Backdrop };

/**
 * The menu's live backdrop, on demand.
 *
 * The scene behind the glass is the real game (backdropScene.ts) — terrain,
 * water, buildings, a camera on a slow orbit — which means three.js and the
 * whole render stack. It is also, by its own description, cosmetic: a
 * browser that refuses WebGL leaves the menu looking deliberate anyway. So
 * it has no business being on the way to the menu's first paint, and this
 * module is the seam that keeps it off: the import sites are unchanged, and
 * the scene's chunk is fetched once something actually asks for a backdrop.
 *
 * Everything about a backdrop's life — the one live instance, the release
 * that hands its WebGL context back before the match takes one — still
 * belongs to the scene module. What lives here is only the window that
 * module cannot see: the stretch where its chunk is still in flight and
 * there is nothing yet to release.
 */

/** The scene's chunk, once anything has asked for it. */
let loading: Promise<typeof import('./backdropScene')> | null = null;
/** The same module, after it arrives — so release stays synchronous, which
 * is what its callers assume: single player begins by giving the context
 * back and navigating in the same breath (StartMenu.tsx). */
let scene: typeof import('./backdropScene') | null = null;
/**
 * Bumped by every start and every release, exactly as the scene module does
 * it — for the one gap it cannot cover. A backdrop asked for and released
 * again while the chunk was still arriving must never be built: the page is
 * already on its way into a match, and the context this would take is the
 * one that match needs.
 */
let generation = 0;

/** Nothing was built, so there is nothing to stop. */
const DEAD: Backdrop = { stop() {} };

/**
 * Give the backdrop's WebGL context back, now. Safe to call at any time,
 * including with a start still in flight, with the chunk still in flight,
 * and with no backdrop at all.
 */
export function releaseMenuBackdrop(): void {
  generation++;
  scene?.releaseMenuBackdrop();
}

export async function startMenuBackdrop(canvas: HTMLCanvasElement): Promise<Backdrop> {
  const mine = ++generation;
  loading ??= import('./backdropScene').catch((err: unknown) => {
    // A chunk that did not arrive must not be remembered as the answer, or
    // one dropped connection would leave the menu flat for the rest of the
    // page's life. The next screen to ask gets a fresh try.
    loading = null;
    throw err;
  });
  scene = await loading;
  // Released while the chunk was on the wire. Every start after this point
  // is the scene module's own to guard, and it does.
  if (mine !== generation) return DEAD;
  return scene.startMenuBackdrop(canvas);
}
