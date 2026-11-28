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

const S = TICKS_PER_SECOND;
/** The first tick the ice bears, and the first it no longer does. */
const FREEZE = ICE_FROM * YEAR_TICKS;
const THAW = ICE_UNTIL * YEAR_TICKS + ICE_GRACE_TICKS;

describe('the season dial', () => {
  it('puts midwinter at the foot and midsummer at the top', () => {
    const midwinter = (TURNS.winter + TURNS.thawing) / 2;
    expect(dialTurn(midwinter)).toBeCloseTo(0.5);
    expect(dialTurn(TURNS.snowing / 2)).toBeCloseTo(0);
    // The sun goes round once a year, clockwise.
    expect(dialTurn(0.4) - dialTurn(0.3)).toBeCloseTo(0.1);
  });

  it('paints the ring from the turns the scene takes', () => {
    expect(yearRing('#0a0', '#fff')).toBe(
      'conic-gradient(from -0.325turn, #0a0 0 65%, #fff 75% 90%, #0a0 100%)',
    );
  });

  it('counts down in minutes and seconds, rounding up', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(0.05)).toBe('0:01');
    expect(clock(59.5)).toBe('1:00');
    expect(clock(325)).toBe('5:25');
    expect(clock(-3)).toBe('0:00');
  });
});

describe('the season dial’s tip', () => {
  it('names the season by the look, each through its own turn', () => {
    expect(yearTip(0, 0).title).toBe('Summer');
    // The snow is coming, but it is still summer's turn.
    expect(yearTip(TURNS.snowing + 0.01, 0).title).toBe('Summer');
    expect(yearTip(TURNS.winter, 0).title).toBe('Winter');
    // The snow is going, but it is still winter's.
    expect(yearTip(0.99, 0).title).toBe('Winter');
  });

  it('says when the lakes will freeze', () => {
    expect(yearTip(0.5, FREEZE - 60 * S).body).toBe(
      'In 1:00 the lakes freeze hard enough to walk across.',
    );
  });

  it('says the lakes bear exactly while iceBears does', () => {
    for (const tick of [FREEZE - 1, FREEZE, THAW - 1, THAW]) {
      const said = yearTip(0.8, tick).body.startsWith('The lakes are frozen');
      expect(said, `tick ${tick}`).toBe(iceBears(tick));
    }
    expect(yearTip(0.8, FREEZE).body).toBe(
      `The lakes are frozen hard enough to walk across. They thaw in ${clock((THAW - FREEZE) / S)}.`,
    );
    // The last tick it bears still has a tick to go, not 0:00.
    expect(yearTip(0.8, THAW - 1).body).toMatch(/They thaw in 0:01\.$/);
  });

  it('says when the thawed lakes freeze again, next year', () => {
    expect(yearTip(0.95, THAW).body).toBe(
      `The lakes have thawed. They freeze again in ${clock((YEAR_TICKS - THAW + FREEZE) / S)}.`,
    );
  });

  it('reads the lakes off the sim, however far the look has run ahead', () => {
    // The scene's clock may lead the sim's by up to half a minute. Here the
    // look is well into winter while the sim has not frozen a lake yet: the
    // tip names the look's season and promises no ice.
    const tip = yearTip(0.8, FREEZE - 10 * S);
    expect(tip.title).toBe('Winter');
    expect(tip.body).toBe(
      'In 0:10 the lakes freeze hard enough to walk across.',
    );
    // And the other way: the look still in summer, the sim already frozen.
    expect(yearTip(0.74, FREEZE).body).toMatch(/^The lakes are frozen/);
  });

  it('reads the lakes off the sim’s year, whatever ?year does to the look', () => {
    // A year later on the sim's clock is the same day of its year.
    expect(yearTip(0.3, YEAR_TICKS + FREEZE).body).toBe(
      yearTip(0.3, FREEZE).body,
    );
  });
});
