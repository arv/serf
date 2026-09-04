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
  config: Omit<MatchConfig, 'engines' | 'playbooks'>;
  seats: readonly SeatEntry[];
}

export function playbookOf(entry: SeatEntry): AiStrategy {
  return {...AI_STRATEGIES[entry.strategyId], ...entry.delta} as AiStrategy;
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const task = JSON.parse(Buffer.concat(chunks).toString('utf8')) as EvolveTask;
  const record: MatchRecord = await playMatch({
    ...task.config,
    playbooks: task.seats.map(playbookOf),
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
