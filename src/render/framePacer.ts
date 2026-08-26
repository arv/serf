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

/** Cap applied on coarse-pointer (touch) devices at rest. Desktop is uncapped. */
export const MOBILE_FPS_CAP = 30;

/**
 * Cap applied on those devices while the player is driving the camera.
 *
 * The paragraph above is true of everything on screen except the ground
 * itself moving under a finger. A swipe is supposed to leave the map stuck
 * to the fingertip, and at 30 fps the ground arrives up to 33ms behind it —
 * which is not read as a low frame rate but as the map being heavy and
 * slow to follow, because the hand knows where it put the thing. Doubling
 * the rate for the length of the gesture halves that gap, and costs the
 * battery only while a finger is actually down.
 *
 * 60 rather than uncapped: past it the improvement is finer than a swipe
 * can show, and a 120 Hz panel would be drawing the valley four times for
 * every one it drew at rest. It does not divide 90 the way 30 divides all
 * three, so a 90 Hz panel keeps every second frame and swipes at 45 — off
 * the round number, but on a steady grid and half again the resting rate,
 * which is the part the hand is reading.
 */
export const MOBILE_INTERACT_FPS_CAP = 60;

/**
 * Grace subtracted from the interval when deciding whether a frame is due:
 * a rAF callback that arrives one refresh early (33.3ms is not a whole
 * number of 11.1ms frames) still counts, rather than slipping a whole
 * refresh and landing the loop at ~27 fps. Half a 90 Hz frame.
 */
const GRACE_MS = 5;

export class FramePacer {
  #interval: number;
  #boostInterval: number;
  #last = -Infinity;

  /**
   * `fps: null` means uncapped — every frame is due. `boostFps` is the cap
   * that applies instead while the caller asks for the boost; it defaults
   * to `fps`, which is a pacer with no boost to give.
   */
  constructor(fps: number | null, boostFps: number | null = fps) {
    this.#interval = fps === null ? 0 : 1000 / fps;
    this.#boostInterval = boostFps === null ? 0 : 1000 / boostFps;
  }

  /**
   * Called once per rAF callback with its timestamp; true when this frame
   * should run. A skipped frame does no work at all — the caller just
   * re-arms rAF and returns.
   *
   * `boost` raises the cap for this frame — pass what the player is doing,
   * not what the last frame decided, so the rate follows the gesture
   * rather than trailing it by however long the cap was holding frames.
   */
  due(now: number, boost = false): boolean {
    const interval = boost ? this.#boostInterval : this.#interval;
    // An uncapped interval needs no special case and must not have one:
    // the grace already puts the threshold below zero, so every frame is
    // due — and the frame it keeps is still written down. A pacer that
    // skipped the bookkeeping while uncapped would come off an uncapped
    // boost with a stale mark and hand out a capped frame on the heels of
    // a boosted one, which is the resting cap broken at exactly the
    // moment it takes over.
    if (now - this.#last < interval - GRACE_MS) return false;
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
  return coarse ? new FramePacer(MOBILE_FPS_CAP, MOBILE_INTERACT_FPS_CAP) : new FramePacer(null);
}
