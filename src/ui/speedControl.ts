import {play} from '../audio/audio';
import {replayMode, setSpeed, speed} from './store';

/**
 * The clock, and the one road to it.
 *
 * The speed cluster used to be the HUD's alone: three buttons, and
 * `mount.tsx` wiring each click to the worker and the store. The keyboard
 * wants the same gears, and a second copy of "tell the worker, then tell
 * the store" is a copy that drifts — a key and a button disagreeing about
 * what the fastest gear is, in the one screen (a replay) where the answer
 * differs. So the gears and both writes live here, and every road goes
 * through them: the HUD's buttons, the mission briefing's Begin, the keys.
 *
 * Numbers only, deliberately. The input layer imports this, and what a gear
 * looks like (its icon, its label) is the HUD's business — `Hud.tsx` hangs
 * those off these values rather than restating them.
 */

/** The gears the live game runs at, slowest first: hold, walk, and the
 * fast forward that is still slow enough to give an order into. */
export const SPEED_GEARS: readonly [number, number, number] = [0, 1, 3];

/** Replays get one gear beyond the live game's fastest: nobody is issuing
 * orders, so there is no reaction time to protect. */
export const REPLAY_GEAR = 8;

/** Just enough of a SimHost to change the clock — a test hands in the one
 * method rather than a worker. */
export interface SpeedHost {
  setSpeed(speed: number): void;
}

/** The ladder in force: a replay's has the extra rung on top. */
export function speedGears(replay = replayMode()): readonly number[] {
  return replay ? [...SPEED_GEARS, REPLAY_GEAR] : SPEED_GEARS;
}

/**
 * The nearest gear above (`dir` 1) or below (−1) this one, stopping at the
 * ends rather than wrapping: − is how the village is held, and a + that
 * wrapped round to the hold would be the fast forward key pausing the game.
 *
 * Asked as "the next rung past `from`" rather than "the rung `from` sits on,
 * plus one", because those two differ for a gear the ladder does not hold —
 * a replay's 8× carried into a skirmish ladder that stops at 3. Counting by
 * index landed on 3 and *then* stepped down, so one press of − answered 1
 * and skipped a gear; reading the ladder directly cannot, whether or not
 * `from` is one of its rungs.
 */
export function stepSpeed(
  from: number,
  dir: 1 | -1,
  replay = replayMode(),
): number {
  const ladder = speedGears(replay);
  const next =
    dir > 0 ? ladder.find(g => g > from) : ladder.findLast(g => g < from);
  // Past the last rung in that direction, stay on it.
  return next ?? (dir > 0 ? ladder[ladder.length - 1]! : ladder[0]!);
}

/**
 * Change the clock: the worker's timer and the HUD's signal. The click is
 * here rather than on the callers for the same reason the rest is — a new
 * way to change speed cannot forget it.
 */
export function applySpeed(host: SpeedHost, value: number): void {
  play('uiClick');
  host.setSpeed(value);
  setSpeed(value);
}

/**
 * One rung faster, or slower — the whole of what the keyboard does to the
 * clock. There is no separate pause key: the bottom rung *is* the pause, so
 * − holds the village and + lets it go again, and one pair of keys carries
 * the strip end to end. A dedicated toggle would have been a second road to
 * the rung − already reaches in a press, and a second road that then has to
 * remember which gear it interrupted.
 */
export function nudgeSpeed(host: SpeedHost, dir: 1 | -1): void {
  applySpeed(host, stepSpeed(speed(), dir));
}
