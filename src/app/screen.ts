/**
 * What is on the page, and how to take it off again.
 *
 * Screens change in this document now (see app/router.ts), so exactly one
 * of these is mounted at a time and the previous one is disposed before the
 * next is built — the canvas, the WebGL context and the #ui overlay are
 * singular, and two screens cannot share them.
 */
export interface Screen {
  /** Which screen this is; see screenKey(). */
  key: string;
  dispose(): void;
  /** Same-key navigation: the URL moved but still names this screen. Most
   * screens have nothing to do — the menu editing its own address bar lands
   * here — but one that carries sub-navigation of its own (the docs wiki)
   * re-reads location and turns its page in place. */
  onRouteChange?(): void;
}
