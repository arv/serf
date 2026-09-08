import {
  AI_STRATEGIES,
  type AiStrategy,
} from '../../src/sim/defs/aiStrategies.ts';
import type {AiStrategyId} from '../../src/sim/defs/aiStrategies.ts';
import {playMatch, type MatchConfig, type MatchRecord} from './match.ts';

/**
 * One search match in one child process.
 *
 * The wire carries a lineage id and the knobs laid over it rather than a
 * whole `AiStrategy`, for the same reason the mutation space is bounded to
 * the advice whitelist: a candidate IS its parent plus a handful of
 * numbers, and shipping the build order across a pipe every match would
 * send the identical arrays a thousand times to say nothing.
 *
 * The reconstructed playbook goes in as a seat's BASE line, so the stance
 * cascade and the difficulty tier compose over it (see AiSeats). Nothing
 * here advises anybody: the search is asking what a playbook is worth, and
 * advice would mute the moods it is being measured with.
 */

export interface SeatEntry {
  strategyId: AiStrategyId;
  /** Whitelist knobs laid over the lineage. Empty plays it as printed. */
  delta: Record<string, unknown>;
}

export interface EvolveTask {
  /** Everything but the seats, which are built here from `seats` below —
   * one source for both the playbook a brain plays and the lineage the
   * record reports, so the two cannot drift (see MatchConfig.seats). */
  config: Omit<MatchConfig, 'engines' | 'seats'>;
  seats: readonly SeatEntry[];
}

export function playbookOf(entry: SeatEntry): AiStrategy {
  return {...AI_STRATEGIES[entry.strategyId], ...entry.delta} as AiStrategy;
}

/**
 * The task's seats as a match's two, or an error.
 *
 * A match has exactly two seats, and this checks the LENGTH rather than
 * only that two entries came through. The task arrives as JSON off a pipe,
 * and both ways of getting it wrong are silent: one seat short and a side
 * plays its printed line while the run's log claims a candidate, one seat
 * over and the extra is dropped on the floor. Either puts a number in a
 * table for a match that never happened, which is the failure this whole
 * seat type exists to make impossible.
 */
export function seatsOf(task: EvolveTask): [AiStrategy, AiStrategy] {
  const [a, b] = task.seats;
  if (task.seats.length !== 2 || !a || !b)
    throw new Error(
      `evolveWorker: a match wants two seats, got ${task.seats.length}`,
    );
  return [playbookOf(a), playbookOf(b)];
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const task = JSON.parse(Buffer.concat(chunks).toString('utf8')) as EvolveTask;
  const record: MatchRecord = await playMatch({
    ...task.config,
    seats: seatsOf(task),
    engines: new Map(),
  });
  process.stdout.write(JSON.stringify(record));
}

if (process.argv[1]?.endsWith('evolveWorker.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    process.exitCode = 1;
  });
}
