import {TURNS} from '../render/seasons';
import {
  ICE_FROM,
  ICE_GRACE_TICKS,
  ICE_UNTIL,
  TICKS_PER_SECOND,
  YEAR_TICKS,
  iceBears,
} from '../sim/defs/balance';

/**
 * How far round the dial a share of the year stands, in turns from the
 * top, clockwise. Midwinter is put at the foot, so the sun rides high
 * through the summer and goes under in the winter — the year read the way
 * a day is.
 */
export function dialTurn(at: number): number {
  return at - (TURNS.winter + TURNS.thawing) / 2 + 0.5;
}

/**
 * The year as a ring: summer's color, turning to winter's over the weeks
 * the snow comes in, and back over the thaw. Drawn from the same turns the
 * scene takes, at the same place on the dial the sun reads.
 */
export function yearRing(summer: string, winter: string): string {
  const pct = (share: number): string => `${+(share * 100).toFixed(3)}%`;
  return (
    `conic-gradient(from ${+dialTurn(0).toFixed(5)}turn, ` +
    `${summer} 0 ${pct(TURNS.snowing)}, ` +
    `${winter} ${pct(TURNS.winter)} ${pct(TURNS.thawing)}, ` +
    `${summer} 100%)`
  );
}

/** Minutes and seconds, rounded up: a wait that says 0:00 is over. */
export function clock(seconds: number): string {
  const s = Math.max(Math.ceil(seconds), 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Where in its year the sim's ice starts and stops bearing, in ticks:
 * the very sums iceBears does, so the two cannot disagree by a hair. */
const ICE_STARTS = ICE_FROM * YEAR_TICKS;
const ICE_ENDS = ICE_UNTIL * YEAR_TICKS + ICE_GRACE_TICKS;

/**
 * What the dial says when asked: the season, and what the lakes do next and
 * how soon.
 *
 * Two clocks, each for what it knows. The season is the look's — `at`, the
 * share of the year the scene has reached, so the name agrees with the
 * dial and the snow. The lakes are the sim's — `tick`, its latest
 * published tick (SabReader.tick) — because the sim alone decides whether
 * a man may walk on one, and the scene's clock is allowed to run ahead of
 * it.
 */
export function yearTip(
  at: number,
  tick: number,
): {title: string; body: string} {
  const title = at >= TURNS.winter ? 'Winter' : 'Summer';
  const into = tick % YEAR_TICKS;
  const until = (target: number): string =>
    clock((target - into) / TICKS_PER_SECOND);
  if (iceBears(tick))
    return {
      title,
      body: `The lakes are frozen hard enough to walk across. They thaw in ${until(ICE_ENDS)}.`,
    };
  if (into < ICE_STARTS)
    return {
      title,
      body: `In ${until(ICE_STARTS)} the lakes freeze hard enough to walk across.`,
    };
  return {
    title,
    body: `The lakes have thawed. They freeze again in ${until(YEAR_TICKS + ICE_STARTS)}.`,
  };
}
