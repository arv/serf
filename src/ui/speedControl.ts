import {play} from '../audio/audio';
import {
  replayMode,
  resumeSpeed,
  setResumeSpeed,
  setSpeed,
  speed,
} from './store';

/**
 * The clock, and the one road to it.
 *
 * The speed cluster used to be the HUD's alone: three buttons, and
 * `mount.tsx` wiring each click to the worker and the store. The keyboard
 * wants the same gears (P, + and −), and a second copy of "tell the worker,
 * then tell the store, and remember what to come back to" is a copy that
 * drifts — the pause key would resume at a gear the buttons had moved off.
 * So the gears and the three writes live here, and every road goes through
 * them: the HUD's buttons, the mission briefing's Begin, the keys.
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
 * The gear one rung up (`dir` 1) or down (−1), stopping at the ends rather
 * than wrapping: + is "faster" and must never be the key that pauses.
 *
 * A gear the ladder does not hold steps from where it would sit — a replay
 * paused at 8× whose window then becomes a skirmish is the case, and
 * refusing to move at all would be the one answer with no way out.
 */
export function stepSpeed(
  from: number,
  dir: 1 | -1,
  replay = replayMode(),
): number {
  const ladder = speedGears(replay);
  const found = ladder.indexOf(from);
  const at = found >= 0 ? found : ladder.filter(g => g <= from).length - 1;
  const next = Math.min(ladder.length - 1, Math.max(0, at + dir));
  return ladder[next]!;
}

/**
 * Change the clock: the worker's timer, the HUD's signal, and the gear a
 * pause remembers. The click is here rather than on the callers for the
 * same reason the rest is — a new way to change speed cannot forget it.
 */
export function applySpeed(host: SpeedHost, value: number): void {
  play('uiClick');
  if (value !== 0) setResumeSpeed(value);
  host.setSpeed(value);
  setSpeed(value);
}

/** Hold, or let go again at the gear the hold interrupted. */
export function togglePause(host: SpeedHost): void {
  applySpeed(host, speed() === 0 ? resumeGear() : 0);
}

/** One rung faster, or slower. */
export function nudgeSpeed(host: SpeedHost, dir: 1 | -1): void {
  applySpeed(host, stepSpeed(speed(), dir));
}

/** What a resume lands on, clamped to the ladder actually in force: the
 * remembered gear may be a replay's 8× and this may no longer be one. */
function resumeGear(): number {
  const want = resumeSpeed();
  return speedGears().includes(want) ? want : 1;
}
