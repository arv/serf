import { buildEngine, type EngineSpec, type LabEngine } from './engines.ts';
import { playMatch, type MatchConfig, type MatchRecord } from './match.ts';
import type { Owner } from '../../src/sim/entities.ts';

/**
 * One match in one child process — the unit `--jobs` parallelizes over.
 *
 * A process rather than a worker_thread on purpose: the sim is plain
 * synchronous JS, so threads would buy nothing but shared-heap risk, and
 * a process gives the one guarantee a bake-off needs — that a crashed or
 * wedged match cannot take the sweep down with it. The parent kills the
 * process on timeout and scores the trial crashed; nothing to unwind.
 *
 * Protocol: the task as JSON on stdin, the MatchRecord as JSON on stdout,
 * anything human on stderr. Exit 0 iff the match finished.
 */

export interface WorkerTask {
  config: Omit<MatchConfig, 'engines'>;
  /** null plays the unadvised control. */
  advisedSeat: Owner | null;
  spec: EngineSpec;
  /** Same salt the serial path passes buildEngine, so --jobs N and
   * --jobs 1 play byte-identical matches. */
  salt: number;
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const task = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WorkerTask;

  const engines = new Map<Owner, LabEngine>();
  if (task.advisedSeat !== null) {
    const engine = buildEngine(task.spec, task.salt);
    if (engine) engines.set(task.advisedSeat, engine);
  }
  const record: MatchRecord = await playMatch({ ...task.config, engines });
  process.stdout.write(JSON.stringify(record));
}

main().catch((err: unknown) => {
  process.stderr.write(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
