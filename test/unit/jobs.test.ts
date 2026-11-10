import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError, type InstanceInfo, type PixInsightCli } from '../../src/bridge/cli.js';
import { JobManager, type JobManagerOptions, type JobTarget } from '../../src/bridge/jobs.js';
import { sleep, waitUntil, writeResult } from './fakes.js';

type Behaviour = (jobDir: string, op: string) => Promise<void> | void;

/** Plays the part of a PixInsight instance: it reads the job and answers through the job's files. */
class FakeCli implements PixInsightCli {
  sent: string[] = [];
  instances: InstanceInfo[] | null = [{ slot: 7, pid: 42, crashed: false }];
  executeError: Error | null = null;
  behaviour: Behaviour = async (jobDir) => {
    await writeFile(join(jobDir, 'started.json'), '{}');
    await writeResult(jobDir, JSON.stringify({ ok: true, value: 'done' }));
  };

  /** Every command in the order it arrived: the script file, and its arguments. */
  commands: Array<{ script: string; args: string[] }> = [];
  /** Fails the command for this script file, this many times. */
  failOn: { script: string; times: number } | null = null;
  /** Runs right before a command for this script file goes out. */
  before: { script: string; then: () => void | Promise<void> } | null = null;

  async execute(_slot: number, script: string, args: string[]): Promise<void> {
    if (this.executeError) throw this.executeError;
    if (this.before?.script === script) await this.before.then();
    if (this.failOn?.script === script && this.failOn.times-- > 0) throw new CliError('PixInsight command failed', 'cli_failed');
    this.commands.push({ script, args });
    // Only the runner takes a job. Anything else is a script of its own.
    if (script !== '/runner.js') return;
    const jobDir = args[0] as string;
    const { op } = JSON.parse(await readFile(join(jobDir, 'job.json'), 'utf8')) as { op: string };
    this.sent.push(op);
    void this.behaviour(jobDir, op);
  }

  async enumerate(): Promise<InstanceInfo[] | null> {
    return this.instances;
  }

  launch(): void {}

  async terminate(): Promise<void> {}

  kill(): void {}

  isRunning(): boolean {
    return true;
  }
}

/** A target that only does what a test tells it to. */
class FakeTarget implements JobTarget {
  generation = 0;
  notice: string | undefined;
  invalidated = 0;
  resolveError: Error | null = null;

  async resolve(): Promise<number> {
    if (this.resolveError) throw this.resolveError;
    return 7;
  }

  current(): { slot: number; pid: number | null } | null {
    return { slot: 7, pid: 42 };
  }

  invalidate(): void {
    this.invalidated++;
  }

  takeNotice(): string | undefined {
    const notice = this.notice;
    this.notice = undefined;
    return notice;
  }
}

describe('JobManager', () => {
  let jobsDir: string;
  let cli: FakeCli;
  let target: FakeTarget;

  beforeEach(async () => {
    jobsDir = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-test-'));
    cli = new FakeCli();
    target = new FakeTarget();
  });

  afterEach(async () => {
    // A job that never ends would go on writing its heartbeat into the folder.
    await Promise.all(managers.splice(0).map((each) => each.close()));
    await rm(jobsDir, { recursive: true, force: true });
  });

  const managers: JobManager[] = [];

  function manager(options: Partial<JobManagerOptions> = {}): JobManager {
    const created = newManager(options);
    managers.push(created);
    return created;
  }

  function newManager(options: Partial<JobManagerOptions>): JobManager {
    return new JobManager({
      cli,
      jobsDir,
      opsDir: '/ops',
      runnerPath: '/runner.js',
      beginLogPath: '/begin_log.js',
      endLogPath: '/end_log.js',
      target,
      pollMs: 2,
      livenessMs: 10,
      idleThresholdMs: 40,
      ...options,
    });
  }

  it('returns the value of a successful job', async () => {
    const jobs = manager();
    const job = jobs.submit('ping', {});
    const done = await jobs.wait(job.id, 2000);
    expect(done).toMatchObject({ state: 'succeeded', done: true, value: 'done', slot: 7 });
  });

  it('writes the job description for the runner', async () => {
    const jobs = manager();
    const job = jobs.submit('run_process', { a: 1 });
    await jobs.wait(job.id, 2000);
    const written = JSON.parse(await readFile(join(jobsDir, job.id, 'job.json'), 'utf8')) as unknown;
    expect(written).toEqual({ op: 'run_process', args: { a: 1 }, opsDir: '/ops' });
  });

  it('hands jobs over one at a time and in order', async () => {
    const finishers: Array<() => Promise<void>> = [];
    cli.behaviour = (jobDir) => {
      finishers.push(() => writeResult(jobDir, JSON.stringify({ ok: true })));
    };
    const jobs = manager();
    const submitted = ['a', 'b', 'c'].map((op) => jobs.submit(op, {}));
    await waitUntil(() => cli.sent.length === 1);
    await sleep(30);
    expect(cli.sent).toEqual(['a']);
    for (let index = 0; index < 3; index++) {
      await waitUntil(() => finishers.length > index);
      await finishers[index]?.();
    }
    await jobs.wait(submitted[2]!.id, 2000);
    expect(cli.sent).toEqual(['a', 'b', 'c']);
  });

  it('keeps structured errors from the runner, and reads problems from the console log', async () => {
    cli.behaviour = async (jobDir) => {
      await writeFile(join(jobDir, 'console.log'), 'PixelMath: Processing\n*** Error: x\n');
      await writeResult(jobDir, JSON.stringify({ ok: false, error: { kind: 'process_failed', message: 'nope' } }));
    };
    const jobs = manager();
    const job = jobs.submit('run_process', {});
    expect(await jobs.wait(job.id, 2000)).toMatchObject({
      state: 'failed',
      error: { kind: 'process_failed', message: 'nope' },
      console: ['*** Error: x'],
      log: ['PixelMath: Processing', '*** Error: x'],
    });
  });

  it('treats a plugin reporting an exit code as a problem, and limits the log', async () => {
    const noise = Array.from({ length: 50 }, (_, index) => `line ${index}`).join('\n');
    cli.behaviour = async (jobDir) => {
      await writeFile(join(jobDir, 'console.log'), `Exit error code 255\n${noise}\n`);
      await writeResult(jobDir, JSON.stringify({ ok: true, value: 1 }));
    };
    const jobs = manager();
    const done = await jobs.wait(jobs.submit('run_process', {}).id, 2000);
    expect(done.console).toEqual(['Exit error code 255']);
    expect(done.log).toHaveLength(30);
    expect(done.log?.at(-1)).toBe('line 49');
  });

  it.each([
    ['null', 'null'],
    ['a value that is no result', '[1]'],
    ['a damaged file', '{ "ok": tr'],
  ])('ends the job instead of polling forever on %s', async (_name, content) => {
    cli.behaviour = async (jobDir) => {
      await writeResult(jobDir, content);
    };
    const jobs = manager();
    expect(await jobs.wait(jobs.submit('ping', {}).id, 2000)).toMatchObject({ state: 'failed', error: { kind: 'script_error' } });
  });

  it('reports an abort as such', async () => {
    cli.behaviour = async (jobDir) => {
      await writeResult(jobDir, JSON.stringify({ ok: false, error: { kind: 'aborted', message: 'stop' } }));
    };
    const jobs = manager();
    const job = jobs.submit('run_process', {});
    expect((await jobs.wait(job.id, 2000)).state).toBe('aborted');
  });

  it('fails the job when no instance can be resolved', async () => {
    target.resolveError = new CliError('No running PixInsight instance found.', 'instance_not_running');
    const jobs = manager();
    const job = jobs.submit('ping', {});
    expect(await jobs.wait(job.id, 2000)).toMatchObject({ state: 'failed', error: { kind: 'instance_not_running' } });
  });

  it('notices a crash and moves on to the next job', async () => {
    cli.behaviour = (_jobDir, op) => {
      if (op === 'doomed') cli.instances = [{ slot: 7, pid: null, crashed: true }];
    };
    const jobs = manager();
    const doomed = jobs.submit('doomed', {});
    const result = await jobs.wait(doomed.id, 2000);
    expect(result).toMatchObject({ state: 'lost', error: { kind: 'instance_lost' } });
    expect(target.invalidated).toBe(1);

    cli.instances = [{ slot: 7, pid: 43, crashed: false }];
    cli.behaviour = async (jobDir) => {
      await writeResult(jobDir, JSON.stringify({ ok: true, value: 1 }));
    };
    const next = jobs.submit('next', {});
    expect((await jobs.wait(next.id, 2000)).state).toBe('succeeded');
  });

  it('flags a stalled job as waiting for input when the instance uses no CPU', async () => {
    cli.behaviour = async (jobDir) => {
      await writeFile(join(jobDir, 'started.json'), '{}');
    };
    const jobs = manager({ cpuSeconds: async () => 5 });
    const job = jobs.submit('stuck', {});
    await waitUntil(async () => (await jobs.get(job.id))?.waitingForInput === true);
    expect(await jobs.get(job.id)).toMatchObject({ state: 'running', activity: 'idle', done: false });
  });

  it('does not flag a job that is computing', async () => {
    cli.behaviour = async (jobDir) => {
      await writeFile(join(jobDir, 'started.json'), '{}');
    };
    let seconds = 0;
    const jobs = manager({ cpuSeconds: async () => (seconds += 10) });
    const job = jobs.submit('busy', {});
    await sleep(120);
    expect(await jobs.get(job.id)).toMatchObject({ activity: 'computing', waitingForInput: false });
  });

  it('flags a job PixInsight has not even started, for example behind a startup dialog', async () => {
    cli.behaviour = () => {};
    const jobs = manager({ cpuSeconds: async () => 5 });
    const job = jobs.submit('blocked', {});
    await waitUntil(async () => (await jobs.get(job.id))?.waitingForInput === true);
    expect((await jobs.get(job.id))?.state).toBe('sent');
  });

  it('shows the newest console lines of a running job, without timestamps, color codes and noise', async () => {
    cli.behaviour = async (jobDir) => {
      await writeFile(join(jobDir, 'started.json'), '{}');
      await writeFile(
        join(jobDir, 'console.log'),
        '[2026-11-08 14:22:57] *******\n[2026-11-08 14:22:57] PixInsight Core 1.9.6 Lockhart (x64)\n' +
          '[2026-11-08 14:22:58] \x1b[1mTGVDenoise\x1b[0m: Processing\n[2026-11-08 14:22:58] Writing swap files...\n[2026-11-08 14:22:58] 4651.799 MiB/s\n',
      );
    };
    const jobs = manager();
    const job = jobs.submit('slow', {});
    await waitUntil(async () => (await jobs.get(job.id))?.logTail !== undefined);
    expect((await jobs.get(job.id))?.logTail).toEqual(['TGVDenoise: Processing']);
  });

  it('can withdraw a job that is still queued, but not one that was sent', async () => {
    cli.behaviour = () => {};
    const jobs = manager();
    const first = jobs.submit('first', {});
    const second = jobs.submit('second', {});
    await waitUntil(() => cli.sent.length === 1);
    expect(jobs.cancelQueued(first.id)).toBe(false);
    expect(jobs.cancelQueued(second.id)).toBe(true);
    expect(await jobs.get(second.id)).toMatchObject({ state: 'aborted', error: { kind: 'cancelled' } });
  });

  describe('abandoning', () => {
    it('frees the queue from a job that will never finish, where a crash cannot be seen', async () => {
      cli.instances = null;
      cli.behaviour = () => {};
      const jobs = manager();
      const stuck = jobs.submit('stuck', {});
      const next = jobs.submit('next', {});
      await waitUntil(() => cli.sent.length === 1);
      expect(await jobs.abandon(stuck.id)).toMatchObject({ started: false, stillRuns: false });
      expect(await jobs.get(stuck.id)).toMatchObject({ state: 'failed', error: { kind: 'abandoned', message: expect.stringContaining('will not run any more') } });
      await waitUntil(() => cli.sent.length === 2);
      expect(cli.sent).toEqual(['stuck', 'next']);
      expect(jobs.stats().active?.id).toBe(next.id);
    });

    it('applies only to the job that is out at PixInsight', async () => {
      cli.behaviour = () => {};
      const jobs = manager();
      const first = jobs.submit('first', {});
      const second = jobs.submit('second', {});
      await waitUntil(() => cli.sent.length === 1);
      expect(await jobs.abandon(second.id)).toBeNull();
      expect(await jobs.abandon('nope')).toBeNull();
      expect(await jobs.abandon(first.id)).toMatchObject({ started: false, stillRuns: false });
      expect(await jobs.abandon(first.id)).toBeNull();
    });

    it('keeps the outcome if the job finishes after all', async () => {
      const directories: string[] = [];
      cli.behaviour = (jobDir) => {
        directories.push(jobDir);
      };
      const jobs = manager();
      const job = jobs.submit('late', {});
      await waitUntil(() => cli.sent.length === 1);
      await jobs.abandon(job.id);
      await writeResult(directories[0] as string, JSON.stringify({ ok: true, value: 1 }));
      await sleep(20);
      expect((await jobs.get(job.id))?.error?.kind).toBe('abandoned');
    });
  });

  describe('a job nobody waits for any more', () => {
    // Not a number for the moment in which the file is being replaced, which a reader can run into on Windows.
    const heartbeat = (dir: string) =>
      readFile(join(dir, 'awaited'), 'utf8').then(
        (text) => (text.trim() === '' ? Number.NaN : Number(text)),
        () => Number.NaN,
      );

    it('goes out with a fresh sign that the server waits, which is kept fresh', async () => {
      const directories: string[] = [];
      const atArrival: number[] = [];
      cli.behaviour = async (jobDir) => {
        directories.push(jobDir);
        atArrival.push(await heartbeat(jobDir));
      };
      const jobs = manager();
      jobs.submit('slow', {});
      await waitUntil(() => atArrival.length === 1);
      expect(Date.now() - atArrival[0]!).toBeLessThan(1000);
      // The next sign follows after a second. How long after is up to the machine.
      await waitUntil(async () => (await heartbeat(directories[0]!)) > atArrival[0]!, 8000);
    }, 15_000);

    it('is marked as withdrawn when it is abandoned, so that PixInsight does not start it later', async () => {
      const directories: string[] = [];
      cli.behaviour = (jobDir) => {
        directories.push(jobDir);
      };
      const jobs = manager();
      const job = jobs.submit('stuck', {});
      await waitUntil(() => directories.length === 1);
      await jobs.abandon(job.id);
      expect(await heartbeat(directories[0]!)).toBe(0);
    });

    it('says so if PixInsight had started the job, because then it goes on', async () => {
      cli.behaviour = async (jobDir) => {
        await writeFile(join(jobDir, 'started.json'), '{}');
      };
      const jobs = manager();
      const job = jobs.submit('running', {});
      await waitUntil(() => cli.sent.length === 1);
      // Whether or not the server has noticed the start yet: the file decides.
      expect(await jobs.abandon(job.id)).toMatchObject({ started: true, stillRuns: true });
      expect((await jobs.get(job.id))?.error?.message).toMatch(/goes on there/);
    });

    it('is withdrawn when the server shuts down, along with everything in the queue', async () => {
      const directories: string[] = [];
      cli.behaviour = (jobDir) => {
        directories.push(jobDir);
      };
      const jobs = manager();
      const out = jobs.submit('out', {});
      const queued = jobs.submit('queued', {});
      await waitUntil(() => directories.length === 1);
      await jobs.close();
      expect(await heartbeat(directories[0]!)).toBe(0);
      expect((await jobs.get(out.id))?.error?.kind).toBe('abandoned');
      expect((await jobs.get(queued.id))?.error?.kind).toBe('cancelled');
      await sleep(30);
      expect(cli.sent).toEqual(['out']);
    });

    it('is not sent if it was abandoned while its instance was still starting', async () => {
      let started!: () => void;
      target.resolve = () => new Promise<number>((resolve) => (started = () => resolve(7)));
      const jobs = manager();
      const job = jobs.submit('close_image', {});
      await waitUntil(() => jobs.stats().active !== null);
      expect(await jobs.abandon(job.id)).toMatchObject({ started: false, stillRuns: false });
      started();
      await sleep(30);
      expect(cli.sent).toEqual([]);
    });

    it('can simply be cancelled while its instance is still starting', async () => {
      let started!: () => void;
      target.resolve = () => new Promise<number>((resolve) => (started = () => resolve(7)));
      const jobs = manager();
      const job = jobs.submit('close_image', {});
      await waitUntil(() => jobs.stats().active !== null);
      expect(jobs.cancelQueued(job.id)).toBe(true);
      started();
      await sleep(30);
      expect(cli.sent).toEqual([]);
      expect((await jobs.get(job.id))?.error?.kind).toBe('cancelled');
    });
  });

  it('refuses an operation that needs a check, if it comes without one', () => {
    const jobs = manager({ needsValidation: ['run_process'] });
    expect(() => jobs.submit('run_process', {})).toThrow(/without its check/);
    expect(jobs.submit('run_process', {}, { validate: async () => {} }).state).toBe('queued');
  });

  it('puts the scripts back before a job goes out', async () => {
    let restored = 0;
    const jobs = manager({ ensureScripts: async () => void restored++ });
    await jobs.wait(jobs.submit('ping', {}).id, 2000);
    expect(restored).toBe(1);
  });

  it('reports a fault of its own as such, and not as a missing instance', async () => {
    target.resolveError = new TypeError('oops');
    const jobs = manager();
    expect((await jobs.wait(jobs.submit('ping', {}).id, 2000)).error).toEqual({ kind: 'internal_error', message: 'oops' });
  });

  it('does not take a process that writes to its console for one that waits for the user', async () => {
    let lines = 0;
    cli.behaviour = async (jobDir) => {
      await writeFile(join(jobDir, 'started.json'), '{}');
      const timer = setInterval(() => void writeFile(join(jobDir, 'console.log'), 'working\n'.repeat(++lines)).catch(() => clearInterval(timer)), 10);
      setTimeout(() => clearInterval(timer), 1200);
    };
    // A wide margin between the writes and the limit, so that a slow disk does not look like silence.
    const jobs = manager({ cpuSeconds: async () => 5, idleThresholdMs: 400 });
    const job = jobs.submit('external', {});
    await waitUntil(async () => (await jobs.get(job.id))?.state === 'running');
    await sleep(600);
    expect(await jobs.get(job.id)).toMatchObject({ state: 'running', waitingForInput: false });
    await waitUntil(async () => (await jobs.get(job.id))?.waitingForInput === true, 5000);
  });

  describe('a job that has to be checked first', () => {
    it('is only checked when its turn has come, so that its lookups find PixInsight free', async () => {
      let finishFirst!: () => Promise<void>;
      cli.behaviour = (jobDir, op) => {
        if (op === 'long') finishFirst = () => writeResult(jobDir, JSON.stringify({ ok: true }));
        else return writeResult(jobDir, JSON.stringify({ ok: true }));
      };
      const jobs = manager();
      let checked = false;
      jobs.submit('long', {});
      const second = jobs.submit('checked', {}, { validate: async () => void (checked = true) });
      await waitUntil(() => cli.sent.length === 1);
      await sleep(30);
      expect(checked).toBe(false);
      await finishFirst();
      expect((await jobs.wait(second.id, 2000)).state).toBe('succeeded');
      expect(checked).toBe(true);
    });

    const gate = () => {
      let open!: () => void;
      let reject!: (error: Error) => void;
      const closed = new Promise<void>((resolve, fail) => {
        open = resolve;
        reject = fail;
      });
      return { closed, open, reject };
    };

    it('keeps its place in the queue while it is checked', async () => {
      const check = gate();
      const jobs = manager();
      const first = jobs.submit('checked', {}, { validate: () => check.closed });
      const second = jobs.submit('second', {});
      await sleep(20);
      expect(cli.sent).toEqual([]);
      check.open();
      await jobs.wait(second.id, 2000);
      expect((await jobs.get(first.id))?.state).toBe('succeeded');
      expect(cli.sent).toEqual(['checked', 'second']);
    });

    it('can wait for a lookup that goes past it, without a deadlock', async () => {
      const jobs = manager();
      const checked = jobs.submit('checked', {}, {
        validate: async () => {
          await jobs.wait(jobs.submit('lookup', {}, { express: true }).id, 2000);
        },
      });
      await jobs.wait(checked.id, 2000);
      expect(cli.sent).toEqual(['lookup', 'checked']);
    });

    it('ends with the error of the check, and the queue goes on', async () => {
      const check = gate();
      const jobs = manager();
      const refused = jobs.submit('refused', {}, { validate: () => check.closed });
      const next = jobs.submit('next', {});
      check.reject(Object.assign(new Error('no such parameter'), { kind: 'unknown_parameter' }));
      expect(await jobs.wait(refused.id, 2000)).toMatchObject({ state: 'failed', error: { kind: 'unknown_parameter', message: 'no such parameter' } });
      expect((await jobs.wait(next.id, 2000)).state).toBe('succeeded');
      expect(cli.sent).toEqual(['next']);
    });

    it('returns right away, so that a caller can stop waiting during the check', () => {
      const jobs = manager();
      const job = jobs.submit('checked', {}, { validate: () => new Promise(() => {}) });
      expect(job).toMatchObject({ state: 'queued', done: false });
    });

    it('can be withdrawn during the check', async () => {
      const check = gate();
      const jobs = manager();
      const job = jobs.submit('checked', {}, { validate: () => check.closed });
      expect(jobs.cancelQueued(job.id)).toBe(true);
      check.open();
      await sleep(20);
      expect(cli.sent).toEqual([]);
      expect((await jobs.get(job.id))?.error?.kind).toBe('cancelled');
    });
  });

  describe('a change of instance', () => {
    it('stops queued jobs that could hit an image of the same name somewhere else', async () => {
      const jobs = manager();
      const job = jobs.submit('run_process', {});
      target.generation = 1;
      target.notice = 'The instance is gone.';
      expect(await jobs.wait(job.id, 2000)).toMatchObject({ state: 'failed', error: { kind: 'instance_changed', message: expect.stringContaining('The instance is gone.') } });
      expect(cli.sent).toEqual([]);
      expect(target.notice).toBe('The instance is gone.');
    });

    it('stops a new job as well, until the assistant has been told', async () => {
      const jobs = manager();
      target.generation = 1;
      target.notice = 'The instance is gone.';
      const refused = jobs.submit('close_image', {});
      expect((await jobs.wait(refused.id, 2000)).error?.kind).toBe('instance_changed');
      target.takeNotice();
      const accepted = jobs.submit('close_image', {});
      expect((await jobs.wait(accepted.id, 2000)).state).toBe('succeeded');
    });

    it.each(['ping', 'list_images', 'describe_process', 'image_stats', 'preview', 'open_image'])('lets %s through, which changes nothing that exists', async (op) => {
      const jobs = manager();
      const job = jobs.submit(op, {});
      target.generation = 1;
      target.notice = 'The instance is gone.';
      expect((await jobs.wait(job.id, 2000)).state).toBe('succeeded');
    });
  });

  describe('what a lost instance held', () => {
    const seeing = (images: Array<{ view: string; unsaved: boolean }>) => async (jobDir: string, op: string) => {
      if (op === 'doomed') cli.instances = [{ slot: 7, pid: null, crashed: true }];
      else await writeResult(jobDir, JSON.stringify({ ok: true, value: 1, images }));
    };
    const some = [
      { view: 'a', unsaved: true },
      { view: 'b', unsaved: false },
      { view: 'c', unsaved: true },
    ];

    it('is named when the instance crashes during a job', async () => {
      cli.behaviour = seeing(some);
      const jobs = manager();
      await jobs.wait(jobs.submit('first', {}).id, 2000);
      const lost = await jobs.wait(jobs.submit('doomed', {}).id, 2000);
      expect(lost.error?.message).toMatch(/Unsaved work in that instance is gone\. When the server last looked, \d+ s ago, these images held unsaved work: a, c\.$/);
    });

    it('is named when the instance is found gone before a job', async () => {
      cli.behaviour = seeing(some);
      const jobs = manager();
      await jobs.wait(jobs.submit('first', {}).id, 2000);
      target.resolveError = new CliError('PixInsight is gone.', 'instance_not_running');
      const failed = await jobs.wait(jobs.submit('next', {}).id, 2000);
      expect(failed.error?.message).toMatch(/^PixInsight is gone\. When the server last looked, .* unsaved work: a, c\.$/);
    });

    it('says so if nothing was unsaved, which is worth knowing too', async () => {
      cli.behaviour = seeing([{ view: 'b', unsaved: false }]);
      const jobs = manager();
      await jobs.wait(jobs.submit('first', {}).id, 2000);
      expect((await jobs.wait(jobs.submit('doomed', {}).id, 2000)).error?.message).toMatch(/no image held unsaved work\.$/);
    });

    it('is not made up if no job ever saw the instance', async () => {
      cli.behaviour = seeing(some);
      const jobs = manager();
      expect((await jobs.wait(jobs.submit('doomed', {}).id, 2000)).error?.message).not.toMatch(/last looked/);
      expect(jobs.describeLoss(true)).toBe('');
    });

    it('goes into the announcement of a change once, even if the new instance has answered since', async () => {
      cli.behaviour = seeing(some);
      const jobs = manager();
      await jobs.wait(jobs.submit('first', {}).id, 2000);
      expect(jobs.takeLoss()).toBe('');

      target.generation = 1;
      cli.behaviour = seeing([{ view: 'new', unsaved: true }]);
      await jobs.wait(jobs.submit('list_images', {}).id, 2000);
      expect(jobs.takeLoss()).toMatch(/unsaved work: a, c\.$/);
      expect(jobs.takeLoss()).toBe('');
    });

    it('goes into the announcement if no job has run on the new instance yet', async () => {
      cli.behaviour = seeing(some);
      const jobs = manager();
      await jobs.wait(jobs.submit('first', {}).id, 2000);
      target.generation = 1;
      expect(jobs.takeLoss()).toMatch(/unsaved work: a, c\.$/);
      expect(jobs.takeLoss()).toBe('');
    });

    it('accompanies the refusal of a job after a change', async () => {
      cli.behaviour = seeing(some);
      const jobs = manager();
      await jobs.wait(jobs.submit('first', {}).id, 2000);
      target.generation = 1;
      target.notice = 'The instance is gone.';
      const refused = await jobs.wait(jobs.submit('close_image', {}).id, 2000);
      expect(refused.error?.message).toMatch(/The instance is gone\. When the server last looked, .* unsaved work: a, c\. Check list_images/);
    });

    it('does not pass off the images of the new instance as lost', async () => {
      cli.behaviour = seeing(some);
      const jobs = manager();
      await jobs.wait(jobs.submit('first', {}).id, 2000);
      target.generation = 1;
      target.notice = 'The instance is gone.';
      cli.behaviour = seeing([{ view: 'alive', unsaved: true }]);
      await jobs.wait(jobs.submit('list_images', {}).id, 2000);
      expect(jobs.takeLoss()).toMatch(/a, c/);
      const refused = await jobs.wait(jobs.submit('close_image', {}).id, 2000);
      expect(refused.error?.kind).toBe('instance_changed');
      expect(refused.error?.message).not.toMatch(/alive|last looked/);
    });
  });

  it('stops waiting when the caller gives up', async () => {
    cli.behaviour = () => {};
    const jobs = manager();
    const job = jobs.submit('slow', {});
    const controller = new AbortController();
    const waiting = jobs.wait(job.id, 60_000, undefined, controller.signal);
    controller.abort();
    expect((await waiting).done).toBe(false);
  });

  it('reports the job that is out at PixInsight as active, also while it is being sent', async () => {
    let deliver!: () => void;
    const delivered = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    cli.execute = async () => delivered;
    const jobs = manager();
    const job = jobs.submit('ping', {});
    await waitUntil(() => jobs.stats().active !== null);
    expect(jobs.stats()).toMatchObject({ queued: 0, active: { id: job.id } });
    deliver();
  });

  describe('on its way to PixInsight', () => {
    it('cannot be cancelled as if it had never left, and is still watched to its end', async () => {
      const jobs = manager();
      let cancelled: boolean | undefined;
      let job!: { id: string };
      cli.before = { script: '/runner.js', then: () => void (cancelled = jobs.cancelQueued(job.id)) };
      job = jobs.submit('close_image', {});
      expect(await jobs.wait(job.id, 2000)).toMatchObject({ state: 'succeeded', value: 'done' });
      expect(cancelled).toBe(false);
    });

    it('is not sent any more if the server gave up on it in the last moment', async () => {
      const jobs = manager();
      let job!: { id: string };
      cli.before = { script: '/begin_log.js', then: async () => void (await jobs.abandon(job.id)) };
      job = jobs.submit('start_script', {}, { validate: async () => ({ scriptAhead: { path: '/x/Solver.js' } }) });
      expect(await jobs.wait(job.id, 2000)).toMatchObject({ state: 'failed', error: { kind: 'abandoned' } });
      await sleep(30);
      // The log was started, so it is ended again. Neither the script nor the job went out.
      expect(cli.commands.map((command) => command.script)).toEqual(['/begin_log.js', '/end_log.js']);
    });
  });

  describe('a job with a script sent ahead', () => {
    const SCRIPT = '/opt/PixInsight/src/scripts/Solver.js';
    const ahead = (view?: string) => ({ validate: async () => ({ scriptAhead: { path: SCRIPT, view } }) });
    const scripts = () => cli.commands.map((command) => command.script);

    it('starts a console log, then the script, then the job that reports on it', async () => {
      const jobs = manager();
      const job = jobs.submit('start_script', {}, ahead('Ha'));
      expect(await jobs.wait(job.id, 2000)).toMatchObject({ state: 'succeeded' });
      expect(cli.commands).toEqual([
        // With the image to bring to the front once more, right before the script.
        { script: '/begin_log.js', args: [join(jobsDir, job.id, 'script.log'), 'Ha'] },
        { script: SCRIPT, args: [] },
        { script: '/runner.js', args: [join(jobsDir, job.id)] },
      ]);
    });

    it('goes out with what its check found, and sends nothing if the check fails', async () => {
      const jobs = manager();
      const job = jobs.submit('start_script', { script: 'solver' }, {
        validate: async () => {
          await sleep(10);
          return { args: { script: 'Solver', before: [1] }, scriptAhead: { path: SCRIPT } };
        },
      });
      await jobs.wait(job.id, 2000);
      expect(cli.commands[0]?.args).toEqual([join(jobsDir, job.id, 'script.log')]);
      expect(JSON.parse(await readFile(join(jobsDir, job.id, 'job.json'), 'utf8'))).toMatchObject({ op: 'start_script', args: { script: 'Solver', before: [1] } });

      const refused = jobs.submit('start_script', {}, {
        validate: async () => {
          throw Object.assign(new Error('no such script'), { kind: 'unknown_script' });
        },
      });
      expect(await jobs.wait(refused.id, 2000)).toMatchObject({ state: 'failed', error: { kind: 'unknown_script' } });
      expect(cli.commands).toHaveLength(3);
    });

    it('tells a check whether its job was withdrawn while it waited for its turn', async () => {
      cli.behaviour = () => undefined;
      const jobs = manager();
      jobs.submit('stuck', {});
      const seen: boolean[] = [];
      const waiting = jobs.submit('start_script', {}, {
        validate: async (job) => {
          seen.push(job.cancelled());
          await sleep(20);
          seen.push(job.cancelled());
          return {};
        },
      });
      // The check only starts when the job heads the queue, so this one is checked right away.
      const first = jobs.submit('start_script', {}, { validate: async () => ({}) });
      expect(jobs.cancelQueued(first.id)).toBe(true);
      expect(jobs.cancelQueued(waiting.id)).toBe(true);
      expect(seen).toEqual([]);
    });

    it('shows what the script writes to the console while the job waits for it, and as the log in the end', async () => {
      let finish!: () => Promise<void>;
      cli.behaviour = (jobDir) => {
        finish = async () => {
          await writeFile(join(jobDir, 'started.json'), '{}');
          await writeFile(join(jobDir, 'console.log'), 'what the job itself wrote\n');
          await writeResult(jobDir, JSON.stringify({ ok: true, value: {} }));
        };
      };
      const jobs = manager();
      const job = jobs.submit('start_script', {}, ahead());
      await waitUntil(() => cli.commands.length === 3);
      await writeFile(
        join(jobsDir, job.id, 'script.log'),
        '* IPC execute command received.\nrun -x=auto "/x/Solver.js"\nProcessing script file: /x/Solver.js\nSolving the image\n*** Error: no stars\n* IPC execute command received.\nrun -a="/home/jobs/1" -x=auto "/home/pjsr/runner.js"\n',
      );
      await waitUntil(async () => (await jobs.get(job.id))?.logTail !== undefined);
      expect(await jobs.get(job.id)).toMatchObject({ state: 'sent', logTail: ['Solving the image', '*** Error: no stars'] });

      await finish();
      expect(await jobs.wait(job.id, 2000)).toMatchObject({ state: 'succeeded', log: ['Solving the image', '*** Error: no stars'], console: ['*** Error: no stars'] });
    });

    it('reads only the end of a log that a script has written for hours', async () => {
      cli.behaviour = () => undefined;
      const jobs = manager();
      const job = jobs.submit('start_script', {}, ahead());
      await waitUntil(() => cli.commands.length === 3);
      await writeFile(join(jobsDir, job.id, 'script.log'), `${'an early line\n'.repeat(20_000)}the last line\n`);
      await waitUntil(async () => (await jobs.get(job.id))?.logTail !== undefined);
      const tail = (await jobs.get(job.id))?.logTail;
      expect(tail?.at(-1)).toBe('the last line');
      expect(tail).toHaveLength(8);
      // Cut at a line, never in the middle of one.
      expect(tail?.[0]).toBe('an early line');
    });

    it('counts a script that writes to the console as at work, not as waiting for input', async () => {
      cli.behaviour = () => undefined;
      const jobs = manager({ cpuSeconds: async () => 1 });
      const job = jobs.submit('start_script', {}, ahead());
      await waitUntil(async () => (await jobs.get(job.id))?.waitingForInput === true);
      await writeFile(join(jobsDir, job.id, 'script.log'), 'Solving\n');
      await waitUntil(async () => (await jobs.get(job.id))?.waitingForInput === false);
    });

    it('says that the script can still be open when the job is abandoned, and no other job is', async () => {
      cli.behaviour = () => undefined;
      const jobs = manager();
      const job = jobs.submit('start_script', {}, ahead());
      await waitUntil(() => cli.commands.length === 3);
      expect(jobs.unfinished('start_script')?.id).toBe(job.id);
      expect(jobs.unfinished('run_process')).toBeUndefined();
      expect(jobs.cancelQueued(job.id)).toBe(false);
      const abandoned = await jobs.abandon(job.id);
      expect(abandoned).toMatchObject({ started: false, stillRuns: true, message: expect.stringContaining('can still be open or at work') });
      expect((await jobs.get(job.id))?.error).toEqual({ kind: 'abandoned', message: abandoned?.message });
      expect(jobs.unfinished('start_script')).toBeUndefined();
    });

    it('ends the log again if the script could not be sent, and says that it may be there all the same', async () => {
      cli.failOn = { script: SCRIPT, times: 1 };
      const jobs = manager();
      const job = jobs.submit('start_script', {}, ahead());
      expect(await jobs.wait(job.id, 2000)).toMatchObject({ state: 'failed', error: { kind: 'cli_failed', message: expect.stringContaining('may have reached PixInsight all the same') } });
      expect(scripts()).toEqual(['/begin_log.js', '/end_log.js']);
    });

    it('tries once more to send the job behind a script that is out', async () => {
      cli.failOn = { script: '/runner.js', times: 1 };
      const jobs = manager();
      const job = jobs.submit('start_script', {}, ahead());
      expect(await jobs.wait(job.id, 2000)).toMatchObject({ state: 'succeeded' });
      expect(scripts()).toEqual(['/begin_log.js', SCRIPT, '/runner.js']);
    });

    it('says that the script is out if the job behind it cannot be sent, and ends the log', async () => {
      cli.failOn = { script: '/runner.js', times: 2 };
      const jobs = manager();
      const job = jobs.submit('start_script', {}, ahead());
      const done = await jobs.wait(job.id, 2000);
      expect(done).toMatchObject({ state: 'failed', error: { kind: 'cli_failed' } });
      expect(done.error?.message).toMatch(/script was started in PixInsight.*do not start it again/);
      expect(scripts()).toEqual(['/begin_log.js', SCRIPT, '/end_log.js']);
    });

    it('does not retry a job that has no script ahead of it', async () => {
      cli.failOn = { script: '/runner.js', times: 1 };
      const jobs = manager();
      expect(await jobs.wait(jobs.submit('ping', {}).id, 2000)).toMatchObject({ state: 'failed', error: { kind: 'cli_failed' } });
      expect(scripts()).toEqual([]);
    });

    it('sends other jobs with nothing ahead of them', async () => {
      const jobs = manager();
      await jobs.wait(jobs.submit('ping', {}).id, 2000);
      expect(scripts()).toEqual(['/runner.js']);
    });
  });

  it('removes the files of old jobs', async () => {
    const jobs = manager({ retainFinished: 1 });
    const first = jobs.submit('one', {});
    await jobs.wait(first.id, 2000);
    const second = jobs.submit('two', {});
    await jobs.wait(second.id, 2000);
    await waitUntil(async () => !(await exists(join(jobsDir, first.id))));
    expect(await jobs.get(first.id)).toBeUndefined();
    expect(await exists(join(jobsDir, second.id))).toBe(true);
  });
});

async function exists(path: string): Promise<boolean> {
  return readFile(join(path, 'job.json')).then(
    () => true,
    () => false,
  );
}
