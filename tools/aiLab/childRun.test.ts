import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {runMatchChild} from './childRun.ts';

/**
 * The lane has to settle. A sweep fans out over a pool of these, so a
 * child that dies in an unexpected way must cost one trial and never the
 * run — which is exactly what the first draft got wrong: with no `error`
 * listener a failed spawn is an uncaught exception, not a lost match.
 */
describe('the child runner', () => {
  it('loses one trial rather than the run when the worker does not exist', async () => {
    // Unhandled 'error' on a ChildProcess crashes the process, so if this
    // regresses the whole test file dies rather than this assertion.
    await expect(
      runMatchChild('/definitely/not/a/worker.ts', {}, 10_000),
    ).resolves.toBeNull();
  });

  it('settles on a worker that writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'childrun-'));
    const worker = join(dir, 'silent.ts');
    writeFileSync(worker, 'process.exit(0);\n');
    await expect(runMatchChild(worker, {}, 20_000)).resolves.toBeNull();
  });

  it('settles on a worker that never exits, rather than holding the lane', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'childrun-'));
    const worker = join(dir, 'wedged.ts');
    // Reads nothing and never returns: the shape a wedged match takes.
    writeFileSync(worker, 'setInterval(() => {}, 1000);\n');
    const started = Date.now();
    await expect(runMatchChild(worker, {}, 1_500)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('returns the record a worker writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'childrun-'));
    const worker = join(dir, 'echo.ts');
    writeFileSync(
      worker,
      `const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
process.stdout.write(Buffer.concat(chunks).toString('utf8'));
`,
    );
    const out = await runMatchChild(worker, {seed: 7, ticks: 42}, 20_000);
    expect(out).toMatchObject({seed: 7, ticks: 42});
  });
});
