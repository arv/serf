import {TURNS} from '../render/seasons';
import {
  ICE_FROM,
  ICE_GRACE_TICKS,
  ICE_UNTIL,
  TICKS_PER_SECOND,
  YEAR_TICKS,
} from '../sim/defs/balance';

/**
 * Where the valley is in its year, as the scene shows it (Seasons.year):
 * `at` the share of the year gone, 0 at summer's first tick; `ticks` the
 * year's length; `turning` false while ?season holds one season still.
 */
export interface YearReading {
  at: number;
  ticks: number;
  turning: boolean;
}

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

/** The share of the year the lakes stop bearing at (iceBears). */
const ICE_ENDS = ICE_UNTIL + ICE_GRACE_TICKS / YEAR_TICKS;

/**
 * What the dial says when asked: the season, and what the lakes do next and
 * how soon. The season is the look's; the lakes are the sim's, which is
 * what decides whether a man may walk on one.
 */
export function yearTip(year: YearReading): {title: string; body?: string} {
  // Everything in whole ticks of the year, as iceBears counts: in shares,
  // the tick the ice stops bearing can land a hair either side of the
  // line, and the tip says it thaws in 0:00 on ice nobody may walk.
  const tick = (share: number): number => Math.round(share * year.ticks);
  const now = tick(year.at);
  const title = now >= tick(TURNS.winter) ? 'Winter' : 'Summer';
  // Held still, nothing is coming.
  if (!year.turning) return {title};
  const until = (share: number): string =>
    clock((tick(share) - now) / TICKS_PER_SECOND);
  if (now < tick(ICE_FROM))
    return {
      title,
      body: `Winter in ${until(TURNS.winter)}, and the lakes freeze hard enough to walk across.`,
    };
  if (now < tick(ICE_ENDS))
    return {
      title,
      body: `The lakes are frozen hard enough to walk across. They thaw in ${until(ICE_ENDS)}.`,
    };
  return {title, body: `The lakes have thawed. Summer in ${until(1)}.`};
}
