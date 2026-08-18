import { describe, expect, it } from 'vitest';
import { parseAdvice } from '../../src/ai/advice.ts';
import { parseArgs } from './bakeoff.ts';
import { buildEngine, parseEngineSpec, randomEngine, scriptEngine } from './engines.ts';
import { digestOf, playMatch, type MatchConfig, type MatchRecord } from './match.ts';
import { binomCdfHalf, compare, renderComparison, type ArmOutcomes } from './compare.ts';
import { renderReport, verdict, type ReportHeader } from './report.ts';
import { summarize, trialsForPrecision, wilson, type SeedRun } from './stats.ts';
import type { Owner } from '../../src/sim/entities.ts';
import type { LabEngine } from './engines.ts';

/**
 * The harness measuring the harness.
 *
 * A bake-off is only worth running if it cannot manufacture a result, so
 * most of what is checked here is the absence of one: the same config
 * twice gives the same match, an unadvised arm gives exactly the coin
 * flip, and eight straight wins do not read as certainty.
 */

/** Small, bandit-free, short — the plumbing is what these exercise. */
function config(over: Partial<MatchConfig> = {}): MatchConfig {
  return {
    seed: 42,
    mapSize: 64,
    bandits: false,
    strategy: 'steward',
    maxTicks: 4_000,
    advicePeriod: 500,
    adviceStagger: 200,
    engines: new Map<Owner, LabEngine>(),
    latencyTicks: 0,
    ...over,
  };
}

const WARMONGER = { armyAttackSize: 4, attackCooldown: 300, prefersRivals: true };
/** Long enough for this fixture to decide itself (seat 1 razes seat 0 at
 * tick 9915 unadvised). It has to run that deep: the steward's growth
 * knobs sit behind its growthAfter research and its war knobs behind a
 * mustered army, so the villages play identically for thousands of ticks
 * whatever the advice says — matchup.test.ts leans on the same fact. */
const FULL_MATCH_TICKS = 10_000;

describe('wilson intervals', () => {
  it('never reads a clean sweep as certainty', () => {
    const [lo, hi] = wilson(8, 8);
    expect(hi).toBe(1);
    // The naive interval would put this at [100%, 100%] and let eight
    // seeds settle the question.
    expect(lo).toBeLessThan(0.7);
  });

  it('brackets a coin flip symmetrically', () => {
    const [lo, hi] = wilson(50, 100);
    expect(lo).toBeCloseTo(0.404, 2);
    expect(hi).toBeCloseTo(0.596, 2);
  });

  it('knows nothing from nothing', () => {
    expect(wilson(0, 0)).toEqual([0, 1]);
  });

  it('prices the precision honestly', () => {
    expect(trialsForPrecision(0.05)).toBe(385);
    expect(trialsForPrecision(0.15)).toBe(43);
  });
});

describe('engine specs', () => {
  it('reads every accepted form', () => {
    expect(parseEngineSpec('none')).toEqual({ kind: 'none' });
    expect(parseEngineSpec('random')).toEqual({ kind: 'random', seed: 1 });
    expect(parseEngineSpec('random:7')).toEqual({ kind: 'random', seed: 7 });
    expect(parseEngineSpec('script:{"homeGuard":9}')).toEqual({
      kind: 'script',
      reply: { homeGuard: 9 },
    });
    expect(parseEngineSpec('http://localhost:8080/v1/', 'qwen')).toEqual({
      kind: 'http',
      baseUrl: 'http://localhost:8080/v1',
      model: 'qwen',
    });
  });

  it('refuses what it cannot run rather than guessing', () => {
    expect(() => parseEngineSpec('qwen2.5')).toThrow(/unrecognized/);
    expect(() => parseEngineSpec('script:not json')).toThrow(/could not parse/);
  });

  it('builds nothing for the unadvised control', () => {
    expect(buildEngine({ kind: 'none' }, 1)).toBeNull();
  });
});

describe('the random baseline', () => {
  it('replays exactly, so a noise floor is reproducible', async () => {
    const a = randomEngine(99);
    const b = randomEngine(99);
    const c = randomEngine(100);
    const roll = async (e: LabEngine): Promise<string[]> => {
      const out: string[] = [];
      for (let i = 0; i < 5; i++) out.push(await e.complete([], '{}'));
      return out;
    };
    expect(await roll(a)).toEqual(await roll(b));
    expect(await roll(randomEngine(99))).not.toEqual(await roll(c));
  });

  it('only ever rolls advice the validator would keep unchanged', async () => {
    // The point of the baseline is that it differs from a model in
    // judgment alone — never in whether the reply survives the gate, and
    // never by being clamped into a different value than it asked for.
    const engine = randomEngine(7);
    for (let i = 0; i < 200; i++) {
      const raw = await engine.complete([], '{}');
      const advice = parseAdvice(raw);
      expect(advice, raw).not.toBeNull();
      const asked = JSON.parse(raw) as Record<string, unknown>;
      for (const [key, value] of Object.entries(advice!)) {
        expect(value, `${key} in ${raw}`).toEqual(asked[key]);
      }
    }
  });
});

describe('a headless match', () => {
  it('replays tick for tick, so a sweep measures the model and not itself', async () => {
    const engines = new Map<Owner, LabEngine>([[0, scriptEngine(WARMONGER)]]);
    const first = await playMatch(config({ engines }));
    const second = await playMatch(
      config({ engines: new Map<Owner, LabEngine>([[0, scriptEngine(WARMONGER)]]) }),
    );
    expect(digestOf(second)).toBe(digestOf(first));
  });

  it('plays a different war than unadvised — but only if the advice lands in time', async () => {
    // Advise seat 1: the seat that actually musters on this fixture. Seat 0
    // dies before its army knobs ever gate a decision, so advising it is a
    // genuine no-op — which is itself the kind of truth the bake-off's
    // mirrored arms exist to average out.
    const control = await playMatch(config({ maxTicks: FULL_MATCH_TICKS }));
    const advised = await playMatch(
      config({
        engines: new Map<Owner, LabEngine>([[1, scriptEngine(WARMONGER)]]),
        maxTicks: FULL_MATCH_TICKS,
      }),
    );
    // Same advice, held up past the end of the match: latency must be a
    // real delay in the sim, so advice that never lands is a perfect
    // no-op — tick for tick the control, not merely a similar game.
    const tooLate = await playMatch(
      config({
        engines: new Map<Owner, LabEngine>([[1, scriptEngine(WARMONGER)]]),
        maxTicks: FULL_MATCH_TICKS,
        latencyTicks: FULL_MATCH_TICKS * 2,
      }),
    );
    expect(control.advised).toEqual([]);
    expect(advised.advised).toEqual([{ playerId: 1, engine: expect.any(String) }]);
    // Marching at four instead of seven ends the same war sooner.
    expect(advised.decided).toBe(true);
    expect(advised.ticks).toBeLessThan(control.ticks);
    expect(digestOf(advised)).not.toBe(digestOf(control));
    expect(digestOf(tooLate)).toBe(digestOf(control));
    // And the records say why: consultations ran, advice was sent, but
    // none of it ever reached the brain.
    expect(tooLate.adviceApplied['1']).toBe(1);
    expect(tooLate.consults.every((c) => c.appliedTick === undefined)).toBe(true);
  }, 60_000);

  it('runs the real prompt and the real validator over every reply', async () => {
    const record = await playMatch(
      config({ engines: new Map<Owner, LabEngine>([[0, scriptEngine(WARMONGER)]]), trace: true }),
    );
    expect(record.consults.length).toBeGreaterThan(3);
    const first = record.consults[0]!;
    // prompt.ts's glossary and summary.ts's seat block, not a stand-in.
    expect(first.prompt![0]!.content).toContain('armyAttackSize');
    expect(first.prompt![1]!.content).toContain('"strategyId":"steward"');
    expect(first.parsed).toBe(true);
    expect(first.knobs).toBe(3);
    // Standing advice repeated verbatim costs one message, not one a turn.
    expect(record.adviceApplied['0']).toBe(1);
  });

  it('makes advice wait out the inference it would really have cost', async () => {
    const latencyTicks = 700;
    const record = await playMatch(
      config({ engines: new Map<Owner, LabEngine>([[0, scriptEngine(WARMONGER)]]), latencyTicks }),
    );
    const applied = record.consults.filter((c) => c.appliedTick !== undefined);
    expect(applied.length).toBe(1);
    expect(applied[0]!.appliedTick).toBe(applied[0]!.tick + latencyTicks);

    const instant = await playMatch(
      config({ engines: new Map<Owner, LabEngine>([[0, scriptEngine(WARMONGER)]]) }),
    );
    const now = instant.consults.filter((c) => c.appliedTick !== undefined);
    expect(now[0]!.appliedTick).toBe(now[0]!.tick);
  });

  it('scores a model that cannot hold the format, and reports the giving up', async () => {
    const broken: LabEngine = {
      label: 'broken',
      usage: [],
      complete: () => Promise.resolve('Sure! Here is my advice: attack now.'),
    };
    const record = await playMatch(
      config({ engines: new Map<Owner, LabEngine>([[0, broken]]), advicePeriod: 400 }),
    );
    const replies = record.consults.filter((c) => !c.skipped);
    expect(replies.length).toBe(3); // three strikes, then inert
    expect(replies.every((c) => c.parsed === false)).toBe(true);
    expect(record.failures[0]!.reason).toMatch(/giving up after 3/);
    // Once it has given up, later summaries are declined rather than sent.
    expect(record.consults.some((c) => c.skipped)).toBe(true);
    expect(record.adviceApplied['0']).toBeUndefined();
  });

  it('leaves a standing worth reading', async () => {
    const record = await playMatch(config({ maxTicks: 2_000 }));
    expect(record.decided).toBe(false);
    expect(record.winner).toBeNull();
    for (const seat of record.standings) {
      expect(seat.castleStanding).toBe(true);
      expect(seat.buildings).toBeGreaterThan(0);
      expect(seat.pop).toBeGreaterThan(0);
    }
  });
});

/** A decided match, fabricated — the aggregation is what is under test. */
function fake(seed: number, winner: Owner | null, decided = true): MatchRecord {
  return {
    seed,
    mapSize: 64,
    bandits: false,
    strategy: 'steward',
    advised: [],
    ticks: 10_000,
    decided,
    winner,
    standings: [],
    consults: [],
    adviceApplied: {},
    failures: [],
    wallMs: 1,
    digest: `fake-${seed}-${String(winner)}`,
  };
}

function mirrored(results: [Owner | null, Owner | null][], control: (Owner | null)[]): SeedRun[] {
  return results.map(([a, b], i) => ({
    seed: i + 1,
    control: fake(i + 1, control[i] ?? null),
    arms: [
      { advisedSeat: 0 as Owner, record: fake(i + 1, a) },
      { advisedSeat: 1 as Owner, record: fake(i + 1, b) },
    ],
  }));
}

describe('aggregation', () => {
  it('cancels the valley’s seat bias by construction', () => {
    // Seat 0 wins every match regardless of who was advised — a maximally
    // lopsided map with advice that does nothing. The mirror must read
    // that as exactly 50%.
    const report = summarize(
      mirrored(
        [
          [0, 0],
          [0, 0],
          [0, 0],
        ],
        [0, 0, 0],
      ),
      1,
    );
    expect(report.advised.wins).toBe(3);
    expect(report.advised.trials).toBe(6);
    expect(report.advised.rate).toBe(0.5);
    expect(report.flips.unchanged).toBe(6);
  });

  it('counts a flip by its direction, not just its existence', () => {
    // Control says seat 1 wins both seeds. Advising seat 0 turns the first
    // one over (toward); advising seat 1 leaves it as it was.
    const report = summarize(
      mirrored(
        [
          [0, 1],
          [1, 1],
        ],
        [1, 1],
      ),
      1,
    );
    expect(report.flips.toward).toBe(1);
    expect(report.flips.away).toBe(0);
    expect(report.flips.unchanged).toBe(3);
    // Seed 1 both arms, seed 2's seat-1 arm — the seat-0 arm of seed 2 is
    // the one trial the advised side lost.
    expect(report.advised.wins).toBe(3);
  });

  it('keeps undecided matches out of the rate instead of awarding them', () => {
    const runs = mirrored(
      [
        [0, 1],
        [0, 1],
      ],
      [0, 0],
    );
    runs[0]!.arms[0]!.record = fake(1, null, false);
    const report = summarize(runs, 1);
    expect(report.undecided).toBe(1);
    expect(report.advised.trials).toBe(3);
  });

  it('separates a model that broke from a model with nothing to say', () => {
    const runs = mirrored([[0, 1]], [0]);
    runs[0]!.arms[0]!.record.consults = [
      { playerId: 0, tick: 1, ms: 10, promptChars: 100, replyChars: 5, parsed: false },
      { playerId: 0, tick: 2, ms: 20, promptChars: 100, replyChars: 2, parsed: true, knobs: 0 },
      { playerId: 0, tick: 3, ms: 30, promptChars: 100, replyChars: 0, error: 'timeout' },
      { playerId: 0, tick: 4, ms: 0, promptChars: 0, replyChars: 0, skipped: true },
    ];
    const { health } = summarize(runs, 1);
    expect(health.consultations).toBe(4);
    expect(health.parseFailures).toBe(1);
    expect(health.emptyAdvice).toBe(1);
    expect(health.errors).toBe(1);
    expect(health.skipped).toBe(1);
    expect(health.latencyMs.max).toBe(30);
  });
});

describe('the verdict', () => {
  const header: ReportHeader = {
    engine: 'test',
    seeds: '1-3',
    seedCount: 3,
    mapSize: 64,
    bandits: false,
    strategy: 'steward',
    advicePeriod: 1800,
    latency: 0,
    maxTicks: 120_000,
    control: true,
  };

  it('refuses to call a straddling interval a result', () => {
    const report = summarize(
      mirrored(
        [
          [0, 1],
          [0, 1],
          [1, 0],
        ],
        [0, 0, 0],
      ),
      1,
    );
    // Four wins from six trials is 67% — the kind of number a three-seed
    // run produces constantly and which means nothing at all.
    expect(report.advised.wins).toBe(4);
    expect(verdict(report).join(' ')).toMatch(/not significant/);
    expect(renderReport(header, report)).toContain('ADVISED WIN RATE');
  });

  it('says so when the whole interval clears the bar', () => {
    const results: [Owner, Owner][] = Array.from({ length: 40 }, () => [0, 1]);
    const report = summarize(mirrored(results, Array<Owner>(40).fill(0)), 1);
    expect(report.advised.trials).toBe(80);
    expect(verdict(report).join(' ')).toMatch(/HELPS/);
  });

  it('says so just as plainly when the advice is making things worse', () => {
    const results: [Owner, Owner][] = Array.from({ length: 40 }, () => [1, 0]);
    const report = summarize(mirrored(results, Array<Owner>(40).fill(0)), 1);
    expect(verdict(report).join(' ')).toMatch(/HURTS/);
  });
});

describe('paired comparison', () => {
  const run = (label: string, entries: [string, boolean][]): ArmOutcomes => ({
    label,
    outcomes: new Map(entries),
  });

  it('computes the exact binomial tail it claims to', () => {
    expect(binomCdfHalf(-1, 10)).toBe(0);
    expect(binomCdfHalf(10, 10)).toBe(1);
    expect(binomCdfHalf(5, 10)).toBeCloseTo(0.623, 3);
    // The classic: 1 discordant win against 9 — p = 2 * P(X <= 1 | B(10, ½)).
    expect(2 * binomCdfHalf(1, 10)).toBeCloseTo(0.0215, 3);
    // Log-space keeps big n finite where naive factorials overflow.
    expect(binomCdfHalf(200, 400)).toBeCloseTo(0.52, 1);
  });

  it('scores only the discordant pairs', () => {
    const a = run('a', [['1:0', true], ['1:1', true], ['2:0', true], ['2:1', false]]);
    const b = run('b', [['1:0', true], ['1:1', false], ['2:0', false], ['2:1', false]]);
    const c = compare(a, b);
    expect(c.paired).toBe(4);
    expect(c.aOnly).toBe(2);
    expect(c.bOnly).toBe(0);
    expect(c.p).toBeCloseTo(0.5, 5); // 2 * P(X <= 0 | B(2, ½))
    expect(renderComparison(c)).toContain('not significant');
  });

  it('drops trials only one run played, and says so', () => {
    const a = run('a', [['1:0', true], ['9:0', true]]);
    const b = run('b', [['1:0', false]]);
    const c = compare(a, b);
    expect(c.paired).toBe(1);
    expect(c.unpaired).toBe(1);
    expect(renderComparison(c)).toContain('1 unpaired');
  });

  it('calls a run that never disagreed what it is: no evidence', () => {
    const a = run('a', [['1:0', true], ['1:1', false]]);
    const b = run('b', [['1:0', true], ['1:1', false]]);
    const c = compare(a, b);
    expect(c.p).toBe(1);
    expect(renderComparison(c)).toContain('never disagreed');
  });

  it('declares a winner only past the conventional bar', () => {
    // Nine discordant pairs, all falling A's way: p ≈ 0.004.
    const entries = Array.from({ length: 9 }, (_, i) => `${i}:0`);
    const a = run('a', entries.map((k) => [k, true] as [string, boolean]));
    const b = run('b', entries.map((k) => [k, false] as [string, boolean]));
    const c = compare(a, b);
    expect(c.p).toBeLessThan(0.05);
    expect(renderComparison(c)).toContain('A is better');
  });
});

describe('the command line', () => {
  it('defaults to the game as shipped', () => {
    const opts = parseArgs([]);
    expect(opts.mapSize).toBe(96);
    expect(opts.bandits).toBe(true);
    expect(opts.advicePeriod).toBe(1800); // simWorker's cadence, not the tests'
    expect(opts.spec).toEqual({ kind: 'random', seed: 1 });
    expect(opts.control).toBe(true);
  });

  it('reads seed ranges, lists and mixtures', () => {
    expect(parseArgs(['--seeds', '3-6']).seeds).toEqual([3, 4, 5, 6]);
    expect(parseArgs(['--seeds', '1,4,9']).seeds).toEqual([1, 4, 9]);
    expect(parseArgs(['--seeds', '1-3,10']).seeds).toEqual([1, 2, 3, 10]);
    expect(() => parseArgs(['--seeds', '6-3'])).toThrow(/backwards/);
  });

  it('takes latency as ticks or as the engine’s own clock', () => {
    expect(parseArgs(['--latency', '120']).latency).toBe(120);
    expect(parseArgs(['--latency', 'measured']).latency).toBe('measured');
    expect(() => parseArgs(['--latency', 'soon'])).toThrow(/measured/);
  });

  it('will not silently swallow a flag that wanted a value', () => {
    expect(() => parseArgs(['--seeds', '--trace'])).toThrow(/wants a value/);
  });

  it('reads --jobs as a count or as max, and refuses nonsense', () => {
    expect(parseArgs([]).jobs).toBe(1);
    expect(parseArgs(['--jobs', '4']).jobs).toBe(4);
    expect(parseArgs(['--jobs', 'max']).jobs).toBeGreaterThanOrEqual(1);
    expect(() => parseArgs(['--jobs', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--jobs', '2.5'])).toThrow(/positive integer/);
  });
});
