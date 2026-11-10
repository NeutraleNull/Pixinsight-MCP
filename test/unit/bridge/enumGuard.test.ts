import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnumCheckInconclusive, EnumGuard } from '../../../src/bridge/enumGuard.js';
import { ManagedInstance } from '../../../src/bridge/instance.js';
import { JobManager } from '../../../src/bridge/jobs.js';
import { FakePixInsight, failJob, makePaths, waitUntil, type Script } from '../fakes.js';

describe('EnumGuard', () => {
  let home: string;
  let cachePath: string;
  let cli: FakePixInsight;

  /** For the tests about a value that makes PixInsight hang: nobody wants to wait for the real limits. */
  const IMPATIENT = { checkMs: 400, cleanupMs: 400 };
  /** For all others, long enough that a slow machine is not taken for a hang. */
  const PATIENT = { checkMs: 10_000, cleanupMs: 10_000 };

  const guard = async (script: Script, otherBuild = '1', timeouts = PATIENT) => {
    cli.script = script;
    const shadow = new ManagedInstance(cli, [250], await makePaths(home));
    const jobs = new JobManager({
      cli,
      jobsDir: join(home, 'jobs'),
      opsDir: '/ops',
      runnerPath: '/runner.js',
      beginLogPath: '/begin_log.js',
      endLogPath: '/end_log.js',
      target: shadow,
      pollMs: 2,
      livenessMs: 5,
    });
    return new EnumGuard(shadow, jobs, cachePath, otherBuild, timeouts);
  };

  const cache = async () => JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, { safe: boolean; reason?: string }>;
  const checks = () => cli.ran.filter((job) => job.op === 'check_enum').length;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-test-'));
    cachePath = join(home, 'checks.json');
    cli = new FakePixInsight();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('remembers a safe value, per build', async () => {
    const first = await guard(() => ({ accepted: true }));
    expect(await first.check('P', 'mode', 'A')).toEqual({ safe: true });
    expect(await first.check('P', 'mode', 'A')).toEqual({ safe: true });
    expect(checks()).toBe(1);
    expect(await cache()).toEqual({ '1:P.mode=A': { safe: true } });
    await (await guard(() => ({ accepted: true }), '2')).check('P', 'mode', 'A');
    expect(checks()).toBe(2);
  });

  it('remembers a clean rejection after one try', async () => {
    const checker = await guard((_job, dir) => failJob(dir, 'invalid_parameter_value', 'out of range'));
    expect(await checker.check('P', 'mode', 'A')).toEqual({ safe: false, reason: 'out of range' });
    expect(checks()).toBe(1);
    expect((await cache())['1:P.mode=A']?.safe).toBe(false);
  });

  it('counts a crash only if it happens again on a fresh instance', async () => {
    const crashing: Script = (_job, _dir, pixinsight) => {
      pixinsight.crash(250);
      return undefined;
    };
    const verdict = await (await guard(crashing)).check('P', 'mode', 'A');
    expect(verdict).toMatchObject({ safe: false, reason: expect.stringContaining('crashes') });
    expect(checks()).toBe(2);
    expect((await cache())['1:P.mode=A']?.safe).toBe(false);
  });

  it('does not blame a value for one lost instance, for example one stopped from outside', async () => {
    let tries = 0;
    const checker = await guard((_job, _dir, pixinsight) => {
      if (++tries === 1) {
        pixinsight.remove(250);
        return undefined;
      }
      return { accepted: true };
    });
    expect(await checker.check('P', 'mode', 'A')).toEqual({ safe: true });
    expect(checks()).toBe(2);
    expect((await cache())['1:P.mode=A']).toEqual({ safe: true });
  });

  it('counts a hang only if it happens again, and does not leave the job in the way', async () => {
    const checker = await guard(() => undefined, '1', IMPATIENT);
    const verdict = await checker.check('P', 'mode', 'A');
    expect(verdict).toMatchObject({ safe: false, reason: expect.stringContaining('hangs') });
    expect(checks()).toBe(2);
    expect(cli.killed).toHaveLength(2);
  });

  it('believes a hang for this session only, because a busy machine gives no answer either', async () => {
    const checker = await guard(() => undefined, '1', IMPATIENT);
    await checker.check('P', 'mode', 'A');
    expect((await checker.check('P', 'mode', 'A')).safe).toBe(false);
    expect(checks()).toBe(2);
    await expect(readFile(cachePath, 'utf8')).rejects.toThrow();

    const later = await guard(() => ({ accepted: true }));
    expect(await later.check('P', 'mode', 'A')).toEqual({ safe: true });
  });

  it('respects an entry that someone removed from the file', async () => {
    const checker = await guard(() => ({ accepted: true }));
    await checker.check('P', 'mode', 'A');
    await writeFile(cachePath, '{}');
    await checker.check('P', 'mode', 'C');
    expect(Object.keys(await cache())).toEqual(['1:P.mode=C']);
  });

  it('stops the shadow instance between two checks, never during one', async () => {
    let finish!: () => Promise<void>;
    const checker = await guard((_job, dir) => {
      finish = () => failJob(dir, 'invalid_parameter_value', 'no').then(() => undefined);
      return undefined;
    });
    const checking = checker.check('P', 'mode', 'A');
    await waitUntil(() => finish !== undefined);
    const stopping = checker.stopShadow();
    expect(cli.terminated).toEqual([]);
    await finish();
    await checking;
    await stopping;
    expect(cli.terminated).toEqual([250]);
  });

  it('does not blame a value for one slow answer', async () => {
    let tries = 0;
    // Only the first try gets no answer. The second one has all the time it needs.
    const checker = await guard(() => (++tries === 1 ? undefined : { accepted: true }), '1', { checkMs: 400, cleanupMs: 10_000 });
    expect(await checker.check('P', 'mode', 'A')).toEqual({ safe: true });
  });

  it('keeps nothing when the check itself could not be carried out', async () => {
    const checker = await guard((_job, dir) => failJob(dir, 'script_error', 'file not found'));
    await expect(checker.check('P', 'mode', 'A')).rejects.toBeInstanceOf(EnumCheckInconclusive);
    await expect(readFile(cachePath, 'utf8')).rejects.toThrow();
  });

  it('keeps nothing when the helper instance cannot be started', async () => {
    cli.addInstance(250);
    const checker = await guard(() => ({ accepted: true }));
    await expect(checker.check('P', 'mode', 'A')).rejects.toThrow(/occupied/);
    await expect(readFile(cachePath, 'utf8')).rejects.toThrow();
  });

  it('keeps nothing about a hang it cannot clean up, where instances cannot be listed', async () => {
    cli.listable = false;
    await expect((await guard(() => undefined, '1', IMPATIENT)).check('P', 'mode', 'A')).rejects.toBeInstanceOf(EnumCheckInconclusive);
    await expect(readFile(cachePath, 'utf8')).rejects.toThrow();
  });

  it('keeps what another server has written in the meantime', async () => {
    const checker = await guard(() => ({ accepted: true }));
    await checker.check('P', 'mode', 'A');
    await writeFile(cachePath, JSON.stringify({ ...(await cache()), '1:Q.other=B': { safe: true } }));
    await checker.check('P', 'mode', 'C');
    expect(Object.keys(await cache()).sort()).toEqual(['1:P.mode=A', '1:P.mode=C', '1:Q.other=B']);
  });

  it('survives a damaged cache file', async () => {
    await writeFile(cachePath, '{ not json');
    expect(await (await guard(() => ({ accepted: true }))).check('P', 'mode', 'A')).toEqual({ safe: true });
  });
});
