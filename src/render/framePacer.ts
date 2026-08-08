/**
 * Frame pacing for battery-bound devices. requestAnimationFrame fires at the
 * display's refresh rate — 90 Hz on a Pixel 6, 120 on many phones — and an
 * RTS gains nothing from drawing the valley that often, while the GPU burns
 * battery on every frame. Capping to 30 fps skips two frames in three on a
 * 90 Hz panel and one in two on a 60 Hz one, and everything downstream is
 * time-based (dt / now), so nothing on screen moves any slower — it just
 * redraws less often.
 *
 * 30 divides 60, 90 and 120 evenly, so the kept frames land on a steady
 * grid instead of alternating gaps; the grace margin below is what makes
 * that division come out clean against rAF timestamp jitter.
 */

/** Cap applied on coarse-pointer (touch) devices. Desktop is uncapped. */
export const MOBILE_FPS_CAP = 30;

/**
 * Grace subtracted from the interval when deciding whether a frame is due:
 * a rAF callback that arrives one refresh early (33.3ms is not a whole
 * number of 11.1ms frames) still counts, rather than slipping a whole
 * refresh and landing the loop at ~27 fps. Half a 90 Hz frame.
 */
const GRACE_MS = 5;

export class FramePacer {
  #interval: number;
  #last = -Infinity;

  /** `fps: null` means uncapped — every frame is due. */
  constructor(fps: number | null) {
    this.#interval = fps === null ? 0 : 1000 / fps;
  }

  /**
   * Called once per rAF callback with its timestamp; true when this frame
   * should run. A skipped frame does no work at all — the caller just
   * re-arms rAF and returns.
   */
  due(now: number): boolean {
    if (this.#interval === 0) return true;
    if (now - this.#last < this.#interval - GRACE_MS) return false;
    this.#last = now;
    return true;
  }
}

/**
 * The pacer a render loop should use on this device: capped on touch
 * devices (phones and tablets, the battery-bound ones — the same signal
 * renderer.ts uses to trade resolution for framerate), uncapped elsewhere.
 */
export function batteryFramePacer(): FramePacer {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return new FramePacer(coarse ? MOBILE_FPS_CAP : null);
}
