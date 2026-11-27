import {describe, expect, it} from 'vitest';
import {TURNS} from '../render/seasons';
import {
  ICE_FROM,
  ICE_GRACE_TICKS,
  ICE_UNTIL,
  TICKS_PER_SECOND,
  YEAR_TICKS,
  iceBears,
} from '../sim/defs/balance';
import {clock, dialTurn, yearRing, yearTip} from './seasonClock';

const year = (at: number) => ({at, ticks: YEAR_TICKS, turning: true});

describe('the season dial', () => {
  it('puts midwinter at the foot and midsummer near the top', () => {
    const midwinter = (TURNS.winter + TURNS.thawing) / 2;
    expect(dialTurn(midwinter)).toBeCloseTo(0.5);
    // The sun goes round once a year, clockwise.
    expect(dialTurn(0.4) - dialTurn(0.3)).toBeCloseTo(0.1);
    // Summer's middle is within an hour of the clock of the top.
    const midsummer = TURNS.snowing / 2;
    expect(Math.abs(dialTurn(midsummer) % 1)).toBeLessThan(1 / 12);
  });

  it('paints the ring from the turns the scene takes', () => {
    expect(yearRing('#0a0', '#fff')).toBe(
      'conic-gradient(from -0.325turn, #0a0 0 65%, #fff 75% 90%, #0a0 100%)',
    );
  });

  it('counts down in minutes and seconds, rounding up', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(0.2)).toBe('0:01');
    expect(clock(59.5)).toBe('1:00');
    expect(clock(325)).toBe('5:25');
    expect(clock(-3)).toBe('0:00');
  });

  it('names the season each holds through its own turn', () => {
    expect(yearTip(year(0)).title).toBe('Summer');
    // The snow is coming, but it is still summer's turn.
    expect(yearTip(year(TURNS.snowing + 0.01)).title).toBe('Summer');
    expect(yearTip(year(TURNS.winter)).title).toBe('Winter');
    // A hair short of the turn is the turn's tick, and the tip that names
    // it agrees with the ice it describes.
    const turn = yearTip(year(TURNS.winter - 1e-9));
    expect(turn.title).toBe('Winter');
    expect(turn.body).toMatch(/^The lakes are frozen/);
    // The snow is going, but it is still winter's.
    expect(yearTip(year(0.99)).title).toBe('Winter');
  });

  it('tells summer when the lakes will freeze', () => {
    expect(yearTip(year(TURNS.winter - 60 / 480)).body).toBe(
      'Winter in 1:00, and the lakes freeze hard enough to walk across.',
    );
  });

  it('tells winter when the ice stops bearing, by the sim’s own rule', () => {
    const ends = ICE_UNTIL * YEAR_TICKS + ICE_GRACE_TICKS;
    // The last tick it bears, and the first it does not.
    expect(iceBears(ends - 1)).toBe(true);
    expect(iceBears(ends)).toBe(false);
    const at = (ends - 30 * TICKS_PER_SECOND) / YEAR_TICKS;
    expect(yearTip(year(at)).body).toBe(
      'The lakes are frozen hard enough to walk across. They thaw in 0:30.',
    );
    expect(yearTip(year(ICE_FROM)).body).toMatch(/^The lakes are frozen/);
    expect(yearTip(year(ends / YEAR_TICKS)).body).toBe(
      'The lakes have thawed. Summer in 0:40.',
    );
  });

  it('does not count a hair under a second as a second more', () => {
    // 0.95 of the year is 9119.999… ticks in floating point.
    expect(yearTip(year(0.95)).body).toBe(
      'The lakes have thawed. Summer in 0:24.',
    );
  });

  it('counts in the year the scene keeps, which ?year can shorten', () => {
    const short = {at: 0.5, ticks: 40 * TICKS_PER_SECOND, turning: true};
    expect(yearTip(short).body).toBe(
      'Winter in 0:10, and the lakes freeze hard enough to walk across.',
    );
  });

  it('promises nothing while a pinned season holds the year still', () => {
    expect(yearTip({at: 0.825, ticks: YEAR_TICKS, turning: false})).toEqual({
      title: 'Winter',
    });
  });
});
