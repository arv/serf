import type {Owner} from '../../src/sim/entities.ts';
import {buildEngine, type EngineSpec, type LabEngine} from './engines.ts';
import {playMatch, type MatchConfig, type MatchRecord} from './match.ts';

/**
 * One match with an engine in BOTH seats — the probe's unit of work.
 *
 * `matchWorker.ts` advises one seat because that is the bake-off's
 * experiment: advice is the only asymmetry, so the unadvised seat is the
 * control. The knob probe cannot use that shape. Advice outranks the
 * stance engine (`{...strategy, ...stanceKnobs, ...override}` in
 * systems/ai.ts), so ANY advice — the playbook's own numbers included —
 * pins the advised seat's war knobs and mutes its moods. A one-sided arm
 * would then be measuring "stances off, plus the candidate's delta"
 * against "stances on", and the delta is the smaller half of that.
 *
 * So both seats are advised: the candidate against its parent restated,
 * which suppresses the stance engine identically on both sides and leaves
 * the knob delta as the only difference. Protocol is matchWorker's — task
 * JSON on stdin, MatchRecord on stdout.
 */

export interface ProbeTask {
  config: Omit<MatchConfig, 'engines'>;
  /** Seat-indexed; a seat with no spec plays its printed playbook. */
  specs: readonly (EngineSpec | null)[];
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const task = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProbeTask;

  const engines = new Map<Owner, LabEngine>();
  for (const [seat, spec] of task.specs.entries()) {
    if (!spec) continue;
    const engine = buildEngine(spec, seat);
    if (engine) engines.set(seat as Owner, engine);
  }
  const record: MatchRecord = await playMatch({...task.config, engines});
  process.stdout.write(JSON.stringify(record));
}

main().catch((err: unknown) => {
  process.stderr.write(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exitCode = 1;
});
