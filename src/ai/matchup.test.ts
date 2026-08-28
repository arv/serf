import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../sim/world.ts';
import { tickWorld } from '../sim/tick.ts';
import { AiSeats } from '../sim/aiSeats.ts';
import { checkInvariants } from '../sim/debug/invariants.ts';
import { LlmStrategist, type ChatEngine } from './strategist.ts';
import { summarizeForSeat } from './summary.ts';
import type { ChatMessage } from './prompt.ts';
import { MatchState } from '../sim/world.ts';
import { AiStrategyId } from '../sim/defs/aiStrategies.ts';
import { PlayerKind } from '../sim/player.ts';

/**
 * Two LLM-advised seats against each other: the whole strategist pipeline —
 * sim-side summaries on the real cadence, real prompts, real parsing and
 * clamping, real overrides through AiSeats — with only the model itself
 * played by a script. One seat's "model" is a warmonger, the other's a
 * turtle, so the test proves advice actually reaches the field: the two
 * villages must fight visibly different wars than they would unadvised.
 *
 * This mirrors simWorker's loop (decide → tick, summaries every
 * ADVICE_PERIOD ticks per seat) rather than importing the worker, which
 * needs a DedicatedWorkerGlobalScope these node tests don't have.
 */

const ADVICE_PERIOD = 900;
const ADVICE_STAGGER = 300;

/** A scripted "model": answers every prompt with its one fixed personality. */
function scriptedEngine(reply: object): ChatEngine {
  return { complete: () => Promise.resolve(JSON.stringify(reply)) };
}

interface MatchResult {
  world: World;
  adviceApplied: Map<number, number>;
  prompts: Map<number, ChatMessage[][]>;
}

/** The simWorker loop, headless: both AI seats advised by their engines. */
async function playAdvisedMatch(
  seed: number,
  engines: Map<number, ChatEngine>,
  maxTicks: number,
): Promise<MatchResult> {
  const world = createWorld({
    seed,
    players: [
      { kind: PlayerKind.ai, strategy: AiStrategyId.steward },
      { kind: PlayerKind.ai, strategy: AiStrategyId.steward },
    ],
    banditsEnabled: false,
    // What is under test is the advice plumbing and its fingerprints on
    // the field, at the tempo the tick horizons below were tuned for —
    // the classic 64 map. Map scale has its own tests.
    mapSize: 64,
  });
  const seats = new AiSeats(world);
  const adviceApplied = new Map<number, number>();
  const prompts = new Map<number, ChatMessage[][]>();
  const strategists = new Map<number, LlmStrategist>();
  for (const id of seats.seatIds()) {
    const engine = engines.get(id);
    if (!engine) continue;
    const record: ChatMessage[][] = [];
    prompts.set(id, record);
    const strategist = new LlmStrategist({
      sendAdvice: (playerId, override) => {
        adviceApplied.set(playerId, (adviceApplied.get(playerId) ?? 0) + 1);
        seats.applyAdvice(playerId, override);
      },
      onStatus: () => {},
      // The harness sees every prompt on its way to the seat's engine.
      engineFactory: () =>
        Promise.resolve({
          complete: (messages, schema) => {
            record.push(messages);
            return engine.complete(messages, schema);
          },
        }),
    });
    await strategist.start();
    strategists.set(id, strategist);
  }

  const summaryDue = new Map(
    seats.seatIds().map((id, i) => [id, ADVICE_PERIOD + i * ADVICE_STAGGER]),
  );
  for (let t = 0; t < maxTicks && world.outcome.state === MatchState.playing; t++) {
    tickWorld(world, seats.decide(world));
    for (const [playerId, due] of summaryDue) {
      if (world.tick < due) continue;
      summaryDue.set(playerId, world.tick + ADVICE_PERIOD);
      const brain = seats.brainFor(playerId);
      if (brain) strategists.get(playerId)?.onSummary(playerId, summarizeForSeat(world, brain));
      // The consultation is fire-and-forget; a scripted engine resolves in
      // a microtask, so one yield is the whole "inference latency".
      await new Promise((r) => setTimeout(r, 0));
    }
    if (world.tick % 500 === 0) {
      expect(checkInvariants(world).violations, `at tick ${world.tick}`).toEqual([]);
    }
  }
  return { world, adviceApplied, prompts };
}

describe('an LLM-advised match, seat against seat', () => {
  it('two advised seats fight it out to a winner, advice landing throughout', async () => {
    // Same playbook on both sides on purpose: whatever difference shows up
    // in how the two seats play, the advice is the only place it can have
    // come from.
    const engines = new Map<number, ChatEngine>([
      // Seat 0's advisor smells blood from the first consultation.
      [
        0,
        scriptedEngine({
          armyAttackSize: 4,
          attackCooldown: 300,
          prefersRivals: true,
          reason: 'strike before they dig in',
        }),
      ],
      // Seat 1's advisor builds tall and hides behind the walls.
      [
        1,
        scriptedEngine({
          armyAttackSize: 14,
          homeGuard: 14,
          serfTarget: 14,
          reason: 'outlast them',
        }),
      ],
    ]);

    const { world, adviceApplied, prompts } = await playAdvisedMatch(42, engines, 90_000);

    // Both advisors were consulted with the real prompt, repeatedly, and
    // their advice reached their seats.
    for (const id of [0, 1]) {
      expect(prompts.get(id)!.length, `seat ${id} consultations`).toBeGreaterThan(3);
      expect(adviceApplied.get(id), `seat ${id} advice applied`).toBeGreaterThanOrEqual(1);
      const [system, user] = prompts.get(id)![0]!;
      expect(system!.content).toContain('Choose exactly one posture');
      expect(user!.content).toContain(`"id":${id},"strategyId":"steward"`);
    }
    // Advice is a standing override, not a drumbeat: a scripted model that
    // never changes its mind sends one message per seat and is done.
    expect(adviceApplied.get(0)).toBe(1);
    expect(adviceApplied.get(1)).toBe(1);

    // The war ends, and the way it ends carries the advice's fingerprints:
    // a seat that musters at four with a short cooldown attacks a turtle
    // that never leaves home. Either the rush wins or the turtle grinds it
    // down — but somebody wins; two stock stewards on this map would both
    // march at seven into mutual attrition.
    expect(world.outcome.state, `still playing at tick ${world.tick}`).toBe(MatchState.over);
    expect((world.outcome as { winner: number | null }).winner).not.toBeNull();
  }, 240_000);

  it('plays a different war than the same seats unadvised', async () => {
    // The control: identical seed, identical playbooks, no strategists.
    const control = createWorld({
      seed: 42,
      players: [
        { kind: PlayerKind.ai, strategy: AiStrategyId.steward },
        { kind: PlayerKind.ai, strategy: AiStrategyId.steward },
      ],
      banditsEnabled: false,
      mapSize: 64, // must mirror playAdvisedMatch's world exactly
    });
    const controlSeats = new AiSeats(control);
    // 16k ticks: far enough for the advised attack cadence to leave the
    // first marks on the field — this seed's roll develops both economies
    // identically for the first ~12k, and the horizon must sit past where
    // the armies start moving differently.
    for (let t = 0; t < 16_000 && control.outcome.state === MatchState.playing; t++) {
      tickWorld(control, controlSeats.decide(control));
    }

    const engines = new Map<number, ChatEngine>([
      [0, scriptedEngine({ armyAttackSize: 4, attackCooldown: 300, prefersRivals: true })],
      [1, scriptedEngine({ armyAttackSize: 14, homeGuard: 14, serfTarget: 14 })],
    ]);
    const { world: advised } = await playAdvisedMatch(42, engines, 16_000);

    // Same valley, same tick horizon — different game on the field. (Tick
    // counts can differ only if one match already ended; the state digest
    // is what must diverge.)
    const digest = (w: World): string =>
      JSON.stringify([
        w.tick,
        [...w.units.values()].map((u) => [u.kind, u.owner, Math.round(u.x), Math.round(u.y)]),
      ]);
    expect(digest(advised)).not.toBe(digest(control));
  }, 120_000);
});
