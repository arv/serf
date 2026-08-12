/**
 * The page's hidden state, fanned out to everything that freezes with it —
 * the sim worker's pump, the net worker's stream, the LLM strategist.
 *
 * visibilitychange is the primary signal, but it is not a guarantee: mobile
 * browsers (iOS Safari on quick app switches and the lock screen most of
 * all) sometimes drop the return-to-visible event. When that happens the
 * worker's pump stays stopped under a live screen — the game sits frozen
 * until the player minimizes and comes back a second time, and that cycle's
 * events happen to land. The watchdog below closes the hole with a signal
 * the browser cannot fail to send: requestAnimationFrame only ticks on a
 * visible page, so a long gap between callbacks *is* the return.
 *
 * State here is "what the sinks were last told", not a reading of
 * document.hidden — the whole point is that document's own account can be
 * missing a transition. Sinks are only called on change, so wiring extra
 * signals into set() costs nothing when they agree.
 */

/**
 * A rAF gap longer than this means the page was away and is back. Well
 * above any jank a visible frame produces (a heavy scene stalls for
 * hundreds of milliseconds, not a second), and any genuine absence a
 * player can notice is far longer. A false wake is harmless anyway: rAF
 * ran, so the page is visible, and visible is what a wake asserts.
 */
export const WAKE_GAP_MS = 1000;

export class HiddenSync {
  #sinks: ((hidden: boolean) => void)[] = [];
  #hidden: boolean;
  #lastFrame: number | undefined;
  /** rAF callbacks seen since the state last changed to hidden. */
  #framesWhileHidden = 0;

  constructor(initialHidden: boolean) {
    this.#hidden = initialHidden;
  }

  /** Register a sink and tell it the current state at once. */
  add(sink: (hidden: boolean) => void): void {
    this.#sinks.push(sink);
    sink(this.#hidden);
  }

  /** Report a transition (visibilitychange). Sinks hear only changes. */
  set(hidden: boolean): void {
    if (hidden === this.#hidden) return;
    this.#hidden = hidden;
    this.#framesWhileHidden = 0;
    for (const sink of this.#sinks) sink(hidden);
  }

  /**
   * Called once per rAF callback with its timestamp, before any pacing —
   * a skipped frame must still count as proof of visibility. Two wake
   * rules, because a hide can be any length: a gap since the last
   * callback (the long absence, woken on the first frame back), and a
   * second callback while still told-hidden (the short one, where the gap
   * never grows — rAF does not run on a hidden page, so callbacks that
   * keep coming are themselves the return). Two rather than one, so a
   * single stray callback racing the hide itself cannot quietly restart
   * the sim on a page that really is going dark. Only ever wakes: a
   * stopped rAF clock cannot run code to notice its own silence, so the
   * missed-hide direction has no watchdog (the cost there is battery,
   * not a frozen game).
   */
  frame(now: number): void {
    if (this.#hidden) {
      this.#framesWhileHidden++;
      const longGap = this.#lastFrame !== undefined && now - this.#lastFrame > WAKE_GAP_MS;
      if (longGap || this.#framesWhileHidden >= 2) this.set(false);
    }
    this.#lastFrame = now;
  }
}
