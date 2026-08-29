import {describe, expect, it} from 'vitest';
import {AiSeats} from '../sim/aiSeats.ts';
import {checkInvariants} from '../sim/debug/invariants.ts';
import * as AiStrategyId from '../sim/defs/aiStrategyIdEnum.ts';
import * as MatchState from '../sim/matchStateEnum.ts';
import * as PlayerKind from '../sim/playerKindEnum.ts';
import {tickWorld} from '../sim/tick.ts';
import {createWorld, type World} from '../sim/world.ts';
import {parseAdvice, toOverride} from './advice.ts';
import {summarizeForSeat} from './summary.ts';

/**
 * Two advised seats against each other: the whole advice pipeline —
 * sim-side summaries on the real cadence, real parsing and clamping, real
 * overrides through AiSeats — with the advisor played by a script. One
 * seat's advisor is a warmonger, the other's a turtle, so the test proves
 * advice actually reaches the field: the two villages must fight visibly
 * different wars than they would unadvised.
 *
 * This is the seam the aiLab harness measures through (tools/aiLab), tested
 * from the src side so a sim change that severs it fails here too.
 */

const ADVICE_PERIOD = 900;
const ADVICE_STAGGER = 300;

/** A scripted advisor: answers every summary with one fixed personality. */
type Advisor = () => string;
const scripted =
  (reply: object): Advisor =>
  () =>
    JSON.stringify(reply);

interface MatchResult {
  world: World;
  adviceApplied: Map<number, number>;
  consultations: Map<number, number>;
}

/** The harness loop, headless: both AI seats advised by their advisors. */
function playAdvisedMatch(
  seed: number,
  advisors: Map<number, Advisor>,
  maxTicks: number,
): MatchResult {
  const world = createWorld({
    seed,
    players: [
      {kind: PlayerKind.ai, strategy: AiStrategyId.steward},
      {kind: PlayerKind.ai, strategy: AiStrategyId.steward},
    ],
    banditsEnabled: false,
    // What is under test is the advice plumbing and its fingerprints on
    // the field, at the tempo the tick horizons below were tuned for —
    // the classic 64 map. Map scale has its own tests.
    mapSize: 64,
  });
  const seats = new AiSeats(world);
  const adviceApplied = new Map<number, number>();
  const consultations = new Map<number, number>();
  // The consult bookkeeping the harness keeps (tools/aiLab/match.ts):
  // replies merge over a standing pile, and only a pile that changed is
  // sent — an advisor that never changes its mind costs one message.
  const sentKey = new Map<number, string>();

  const summaryDue = new Map(
    seats.seatIds().map((id, i) => [id, ADVICE_PERIOD + i * ADVICE_STAGGER]),
  );
  for (
    let t = 0;
    t < maxTicks && world.outcome.state === MatchState.playing;
    t++
  ) {
    tickWorld(world, seats.decide(world));
    for (const [playerId, due] of summaryDue) {
      if (world.tick < due) continue;
      summaryDue.set(playerId, world.tick + ADVICE_PERIOD);
      const brain = seats.brainFor(playerId);
      const advisor = advisors.get(playerId);
      if (!brain || !advisor) continue;
      consultations.set(playerId, (consultations.get(playerId) ?? 0) + 1);
      // The summary is taken even though a scripted advisor ignores it —
      // the cadence and the read are what the loop is exercising.
      summarizeForSeat(world, brain);
      const advice = parseAdvice(advisor());
      if (!advice) continue;
      const override = toOverride(advice);
      const key = JSON.stringify(override);
      if (Object.keys(override).length === 0 || key === sentKey.get(playerId))
        continue;
      sentKey.set(playerId, key);
      adviceApplied.set(playerId, (adviceApplied.get(playerId) ?? 0) + 1);
      seats.applyAdvice(playerId, override);
    }
    if (world.tick % 500 === 0) {
      expect(
        checkInvariants(world).violations,
        `at tick ${world.tick}`,
      ).toEqual([]);
    }
  }
  return {world, adviceApplied, consultations};
}

describe('an advised match, seat against seat', () => {
  it('two advised seats fight it out to a winner, advice landing throughout', () => {
    // Same playbook on both sides on purpose: whatever difference shows up
    // in how the two seats play, the advice is the only place it can have
    // come from.
    const advisors = new Map<number, Advisor>([
      // Seat 0's advisor smells blood from the first consultation.
      [
        0,
        scripted({
          armyAttackSize: 4,
          attackCooldown: 300,
          prefersRivals: true,
          reason: 'strike before they dig in',
        }),
      ],
      // Seat 1's advisor builds tall and hides behind the walls.
      [
        1,
        scripted({
          armyAttackSize: 14,
          homeGuard: 14,
          serfTarget: 14,
          reason: 'outlast them',
        }),
      ],
    ]);

    const {world, adviceApplied, consultations} = playAdvisedMatch(
      42,
      advisors,
      90_000,
    );

    // Both advisors were consulted repeatedly, and their advice reached
    // their seats.
    for (const id of [0, 1]) {
      expect(
        consultations.get(id)!,
        `seat ${id} consultations`,
      ).toBeGreaterThan(3);
      expect(
        adviceApplied.get(id),
        `seat ${id} advice applied`,
      ).toBeGreaterThanOrEqual(1);
    }
    // Advice is a standing override, not a drumbeat: a scripted advisor
    // that never changes its mind sends one message per seat and is done.
    expect(adviceApplied.get(0)).toBe(1);
    expect(adviceApplied.get(1)).toBe(1);

    // The war ends, and the way it ends carries the advice's fingerprints:
    // a seat that musters at four with a short cooldown attacks a turtle
    // that never leaves home. Either the rush wins or the turtle grinds it
    // down — but somebody wins; two stock stewards on this map would both
    // march at seven into mutual attrition.
    expect(world.outcome.state, `still playing at tick ${world.tick}`).toBe(
      MatchState.over,
    );
    expect((world.outcome as {winner: number | null}).winner).not.toBeNull();
  }, 240_000);

  it('plays a different war than the same seats unadvised', () => {
    // The control: identical seed, identical playbooks, no advisors.
    const control = createWorld({
      seed: 42,
      players: [
        {kind: PlayerKind.ai, strategy: AiStrategyId.steward},
        {kind: PlayerKind.ai, strategy: AiStrategyId.steward},
      ],
      banditsEnabled: false,
      mapSize: 64, // must mirror playAdvisedMatch's world exactly
    });
    const controlSeats = new AiSeats(control);
    // 16k ticks: far enough for the advised attack cadence to leave the
    // first marks on the field — this seed's roll develops both economies
    // identically for the first ~12k, and the horizon must sit past where
    // the armies start moving differently.
    for (
      let t = 0;
      t < 16_000 && control.outcome.state === MatchState.playing;
      t++
    ) {
      tickWorld(control, controlSeats.decide(control));
    }

    const advisors = new Map<number, Advisor>([
      [
        0,
        scripted({
          armyAttackSize: 4,
          attackCooldown: 300,
          prefersRivals: true,
        }),
      ],
      [1, scripted({armyAttackSize: 14, homeGuard: 14, serfTarget: 14})],
    ]);
    const {world: advised} = playAdvisedMatch(42, advisors, 16_000);

    // Same valley, same tick horizon — different game on the field. (Tick
    // counts can differ only if one match already ended; the state digest
    // is what must diverge.)
    const digest = (w: World): string =>
      JSON.stringify([
        w.tick,
        [...w.units.values()].map(u => [
          u.kind,
          u.owner,
          Math.round(u.x),
          Math.round(u.y),
        ]),
      ]);
    expect(digest(advised)).not.toBe(digest(control));
  }, 120_000);
});
