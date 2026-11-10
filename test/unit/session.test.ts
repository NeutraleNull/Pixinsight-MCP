import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { Session, type ProcessInfo } from '../../src/session.js';
import { FakePixInsight, failJob, isRunning, sleep, waitUntil, type Script } from './fakes.js';

const USER = 1;
const SHADOW = 250;

const PROCESSES: Record<string, Partial<ProcessInfo>> = {
  PixelMath: {
    parameters: [
      { id: 'expression', type: 'String', readOnly: false, default: '' },
      { id: 'mode', type: 'int', readOnly: false, enum: true, default: 'A' },
      { id: 'result', type: 'float', readOnly: true },
    ],
    constants: [
      { name: 'A', value: 0 },
      { name: 'B', value: 1 },
    ],
  },
  ImageCalibration: { parameters: [{ id: 'overwriteExistingFiles', type: 'boolean', readOnly: false, default: false }] },
  CometAlignment: { parameters: [{ id: 'overwrite', type: 'boolean', readOnly: false, default: true }] },
  GraXpert: { parameters: [{ id: 'appPath', type: 'String', readOnly: false, default: '' }] },
  RGBWorkingSpace: { categories: ['ColorSpaces'] },
  Preferences: { categories: ['Global'] },
  Mount: { categories: ['Instrumentation'] },
};

/** Answers what the server asks before a job, so that each test only says what is special about it. */
const answers: Script = async ({ op, args }, jobDir) => {
  if (op === 'ping') return { build: 1713 };
  if (op === 'describe_process') {
    const known = PROCESSES[args['processId'] as string];
    if (!known) return failJob(jobDir, 'unknown_process', 'No such process.');
    return { id: args['processId'], categories: [], canProcessViews: true, canProcessGlobal: true, parameters: [], constants: [], ...known };
  }
  return { done: op };
};

describe('Session', () => {
  let home: string;
  let cli: FakePixInsight;
  let session: Session;

  const config = (overrides: Partial<Config> = {}): Config => ({
    executable: '/nowhere',
    mode: 'shared',
    slot: undefined,
    workerSlot: 200,
    shadowSlot: SHADOW,
    headless: true,
    home,
    allowedPrograms: ['/opt/GraXpert'],
    guideDirs: [], scriptDirs: [], allowCode: false,
    ...overrides,
  });

  const errorOf = async (request: Parameters<Session['runProcess']>[0]) => (await session.jobs.wait(session.runProcess(request).id, 2000)).error?.kind;
  const runOps = () => cli.ran.map((job) => job.op).filter((op) => !['ping', 'describe_process'].includes(op));

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-test-'));
    cli = new FakePixInsight(answers);
    cli.addInstance(USER);
    session = await Session.create(config(), cli);
  });

  afterEach(async () => {
    await session.close();
    await rm(home, { recursive: true, force: true });
  });

  describe('what it refuses before a job gets near the image', () => {
    it.each([
      ['no target', { processId: 'PixelMath' }, 'invalid_target'],
      ['two targets', { processId: 'PixelMath', view: 'a', global: true }, 'invalid_target'],
      ['a mask on a global run', { processId: 'PixelMath', global: true, mask: { view: 'm' } }, 'invalid_target'],
      ['an unknown process', { processId: 'Nope', view: 'a' }, 'unknown_process'],
      ['a blocked process', { processId: 'Preferences', global: true }, 'blocked_process'],
      ['a blocked category', { processId: 'Mount', view: 'a' }, 'blocked_process'],
      ['a process blocked in the global context', { processId: 'RGBWorkingSpace', global: true }, 'blocked_process'],
      ['an unknown parameter', { processId: 'PixelMath', view: 'a', params: { expresion: '1' } }, 'unknown_parameter'],
      ['a read-only parameter', { processId: 'PixelMath', view: 'a', params: { result: 1 } }, 'read_only_parameter'],
      ['a number for an enumeration', { processId: 'PixelMath', view: 'a', params: { mode: 1 } }, 'invalid_enum'],
      ['an unknown constant', { processId: 'PixelMath', view: 'a', params: { mode: 'Z' } }, 'invalid_enum'],
      ['a program nobody allowed', { processId: 'GraXpert', view: 'a', params: { appPath: '/bin/sh' } }, 'blocked_parameter'],
      ['overwriting files', { processId: 'ImageCalibration', global: true, params: { overwriteExistingFiles: true } }, 'blocked_parameter'],
      ['a process that overwrites by default', { processId: 'CometAlignment', global: true }, 'blocked_parameter'],
    ])('%s', async (_name, request, kind) => {
      expect(await errorOf(request)).toBe(kind);
      expect(runOps()).toEqual([]);
    });

    it('caches what it has looked up', async () => {
      await session.jobs.wait(session.runProcess({ processId: 'PixelMath', view: 'a' }).id, 2000);
      await session.jobs.wait(session.runProcess({ processId: 'PixelMath', view: 'b' }).id, 2000);
      expect(cli.ran.filter((job) => job.op === 'describe_process')).toHaveLength(1);
    });

    it('does not cache a failed lookup', async () => {
      expect(await errorOf({ processId: 'Nope', view: 'a' })).toBe('unknown_process');
      expect(await errorOf({ processId: 'Nope', view: 'a' })).toBe('unknown_process');
      expect(cli.ran.filter((job) => job.op === 'describe_process')).toHaveLength(2);
    });
  });

  describe('what it lets through', () => {
    it('runs a checked process', async () => {
      expect(await errorOf({ processId: 'PixelMath', view: 'a', params: { expression: '1' } })).toBeUndefined();
      expect(cli.ran.at(-1)).toMatchObject({ slot: USER, op: 'run_process', args: { view: 'a' } });
    });

    it('accepts an allowed program', async () => {
      expect(await errorOf({ processId: 'GraXpert', view: 'a', params: { appPath: '/opt/GraXpert' } })).toBeUndefined();
    });

    it('accepts overwriting if the request says so', async () => {
      expect(await errorOf({ processId: 'CometAlignment', global: true, allowOverwrite: true })).toBeUndefined();
    });

    it('needs no shadow instance for the default of an enumeration', async () => {
      expect(await errorOf({ processId: 'PixelMath', view: 'a', params: { mode: 'A' } })).toBeUndefined();
      expect(cli.launched).toEqual([]);
    });
  });

  it('keeps the order of a process that has to be checked and a save right behind it', async () => {
    const run = session.runProcess({ processId: 'PixelMath', view: 'a', params: { mode: 'B' } });
    const save = session.jobs.submit('save_image', { view: 'a' });
    await session.jobs.wait(save.id, 3000);
    expect((await session.jobs.get(run.id))?.state).toBe('succeeded');
    expect(runOps().filter((op) => op !== 'check_enum')).toEqual(['run_process', 'save_image']);
  });

  it('does not let a process run without its checks, whoever submits it', () => {
    expect(() => session.jobs.submit('run_process', { processId: 'Preferences', global: true })).toThrow(/without its check/);
  });

  it('checks a process only when its turn has come, so that a long job before it cannot make the check time out', async () => {
    let finishLong!: () => void;
    cli.script = async (job, dir, pixinsight) => {
      if (job.op === 'long') return new Promise((resolve) => (finishLong = () => resolve({})));
      return answers(job, dir, pixinsight);
    };
    session.jobs.submit('long', {});
    const run = session.runProcess({ processId: 'PixelMath', view: 'a' });
    const save = session.jobs.submit('save_image', { view: 'a' });
    await waitUntil(() => finishLong !== undefined);
    await sleep(30);
    expect(cli.ran.map((job) => job.op)).toEqual(['long']);
    finishLong();
    await session.jobs.wait(save.id, 2000);
    expect((await session.jobs.get(run.id))?.state).toBe('succeeded');
    expect(cli.ran.map((job) => job.op)).toEqual(['long', 'describe_process', 'run_process', 'save_image']);
  });

  it('hands out a job before the check has finished', async () => {
    cli.script = async (job, dir, pixinsight) => {
      if (job.op === 'describe_process') await sleep(50);
      return answers(job, dir, pixinsight);
    };
    const job = session.runProcess({ processId: 'PixelMath', view: 'a' });
    expect(job).toMatchObject({ state: 'queued', done: false });
    expect((await session.jobs.wait(job.id, 2000)).state).toBe('succeeded');
  });

  describe('the shadow instance', () => {
    it('tries a new constant there, not in the instance of the user', async () => {
      expect(await errorOf({ processId: 'PixelMath', view: 'a', params: { mode: 'B' } })).toBeUndefined();
      expect(cli.ran.find((job) => job.op === 'check_enum')).toMatchObject({ slot: SHADOW, args: { constant: 'B' } });
      expect(cli.launched).toEqual([SHADOW]);
    });

    it('turns a check that could not be carried out into busy, and remembers nothing', async () => {
      cli.addInstance(SHADOW);
      for (let slot = SHADOW + 1; slot <= 256; slot++) cli.addInstance(slot);
      const done = await session.jobs.wait(session.runProcess({ processId: 'PixelMath', view: 'a', params: { mode: 'B' } }).id, 2000);
      expect(done.error).toMatchObject({ kind: 'busy', message: expect.stringContaining('occupied') });
      for (let slot = SHADOW; slot <= 256; slot++) cli.remove(slot);
      expect(await errorOf({ processId: 'PixelMath', view: 'a', params: { mode: 'B' } })).toBeUndefined();
    });

    it('is stopped when the session closes, and the instance of the user is not', async () => {
      await errorOf({ processId: 'PixelMath', view: 'a', params: { mode: 'B' } });
      expect(isRunning(cli, SHADOW)).toBe(true);
      await session.close();
      expect(isRunning(cli, SHADOW)).toBe(false);
      expect(isRunning(cli, USER)).toBe(true);
      expect(cli.terminated).toEqual([SHADOW]);
    });

    it('marks helper instances in the list, also those of other servers', async () => {
      cli.addInstance(SHADOW + 2);
      const instances = await session.instances();
      expect(instances?.find((instance) => instance.slot === SHADOW + 2)?.role).toBe('shadow');
      expect(instances?.find((instance) => instance.slot === USER)?.role).toBeUndefined();
    });
  });

  describe('when the instance of the user goes away', () => {
    const lostInstance = async () => {
      await session.jobs.wait(session.jobs.submit('ping', {}).id, 2000);
      cli.crash(USER);
      session.target.invalidate();
      cli.remove(USER);
      cli.addInstance(USER + 1);
    };

    it('refuses a mutating job, and says why', async () => {
      await lostInstance();
      const done = await session.jobs.wait(session.jobs.submit('close_image', { view: 'a' }).id, 2000);
      expect(done.error).toMatchObject({ kind: 'instance_changed', message: expect.stringContaining('Now working with slot 2') });
      expect(runOps()).toEqual([]);
    });

    it('does not fall over to the shadow instance', async () => {
      await errorOf({ processId: 'PixelMath', view: 'a', params: { mode: 'B' } });
      cli.crash(USER);
      session.target.invalidate();
      const done = await session.jobs.wait(session.jobs.submit('ping', {}).id, 2000);
      expect(done.error?.kind).toBe('instance_not_running');
      expect(cli.ran.filter((job) => job.op === 'ping').every((job) => job.slot === USER)).toBe(true);
    });

    it('announces the change together with what the old instance held', async () => {
      cli.images = [{ view: 'nebula', unsaved: true }];
      await lostInstance();
      cli.images = [];
      await session.jobs.wait(session.jobs.submit('list_images', {}).id, 2000);
      expect(session.takeNotice()).toMatch(/Now working with slot 2\..* When the server last looked, \d+ s ago, these images held unsaved work: nebula\.$/);
      expect(session.takeNotice()).toBeUndefined();
    });

    it('forgets what it knew about the old instance, which can have other processes and versions', async () => {
      await errorOf({ processId: 'PixelMath', view: 'a', params: { mode: 'B' } });
      await session.installation(['PixelMath']);
      const lookups = (op: string) => cli.ran.filter((job) => job.op === op).length;
      expect([lookups('describe_process'), lookups('list_processes'), lookups('ping')]).toEqual([1, 1, 1]);

      // Losing the instance takes one ping of its own in this test.
      await lostInstance();
      await session.jobs.wait(session.jobs.submit('list_images', {}).id, 2000);
      session.takeNotice();
      await errorOf({ processId: 'PixelMath', view: 'a', params: { mode: 'B' } });
      await session.installation(['PixelMath']);
      expect([lookups('describe_process'), lookups('list_processes'), lookups('ping')]).toEqual([2, 2, 3]);
    });

    it('works again once the assistant has been told', async () => {
      await lostInstance();
      await session.jobs.wait(session.jobs.submit('list_images', {}).id, 2000);
      expect(session.target.takeNotice()).toMatch(/Now working with slot 2/);
      const done = await session.jobs.wait(session.jobs.submit('close_image', { view: 'a' }).id, 2000);
      expect(done).toMatchObject({ state: 'succeeded', slot: USER + 1 });
    });
  });

  describe('with helpers of other servers around', () => {
    const lease = async (slot: number) => {
      await mkdir(join(home, 'leases'), { recursive: true });
      await writeFile(join(home, 'leases', `slot-${slot}.json`), JSON.stringify({ server: process.ppid, instance: 4242, at: Date.now() }));
    };

    it('never takes the worker of another server for the instance of the user, whatever slot it is on', async () => {
      cli.remove(USER);
      cli.addInstance(210, 4242);
      await lease(210);
      const done = await session.jobs.wait(session.jobs.submit('ping', {}).id, 2000);
      expect(done.error?.kind).toBe('instance_not_running');
      expect(cli.ran).toEqual([]);
    });

    it('marks it as a helper in the list of instances', async () => {
      cli.addInstance(210, 4242);
      await lease(210);
      const instances = await session.instances();
      expect(instances?.find((instance) => instance.slot === 210)?.role).toBe('worker');
      expect(instances?.find((instance) => instance.slot === USER)?.role).toBeUndefined();
    });
  });

  describe('in worker mode', () => {
    let worker: Session;

    beforeEach(async () => {
      worker = await Session.create(config({ mode: 'worker' }), cli);
    });

    afterEach(async () => {
      await worker.close();
    });

    it('starts its instance on demand and stops it at the end', async () => {
      const done = await worker.jobs.wait(worker.jobs.submit('ping', {}).id, 2000);
      expect(done.slot).toBe(200);
      await worker.close();
      expect(isRunning(cli, 200)).toBe(false);
      expect(isRunning(cli, USER)).toBe(true);
    });

    it('leaves its instance running at the end if it holds unsaved work, and the next server takes it over', async () => {
      cli.images = [{ view: 'stack', unsaved: true }];
      await worker.jobs.wait(worker.jobs.submit('ping', {}).id, 2000);
      await worker.close();
      expect(isRunning(cli, 200)).toBe(true);
      expect(cli.closedAll).toEqual([]);

      const next = await Session.create(config({ mode: 'worker' }), cli);
      const done = await next.jobs.wait(next.jobs.submit('ping', {}).id, 2000);
      expect(done).toMatchObject({ state: 'succeeded', slot: 200 });
      expect(cli.launched).toEqual([200]);
      cli.images = [];
      await next.jobs.wait(next.jobs.submit('ping', {}).id, 2000);
      await next.close();
      expect(isRunning(cli, 200)).toBe(false);
    });

    it('leaves its instance running at the end if a job is still at work in it', async () => {
      cli.script = (job, dir, pixinsight) => (job.op === 'long' ? undefined : answers(job, dir, pixinsight));
      await worker.jobs.wait(worker.jobs.submit('ping', {}).id, 2000);
      worker.jobs.submit('long', {});
      await waitUntil(() => cli.ran.some((job) => job.op === 'long'));
      await worker.close();
      expect(isRunning(cli, 200)).toBe(true);
    });

    it('refuses a queued job after losing its instance, and announces the loss', async () => {
      await worker.jobs.wait(worker.jobs.submit('ping', {}).id, 2000);
      cli.crash(200);
      const job = worker.jobs.submit('close_image', { view: 'a' });
      worker.target.invalidate();
      expect((await worker.jobs.wait(job.id, 2000)).error?.kind).toBe('instance_changed');
      await waitUntil(() => isRunning(cli, 200));
      expect(worker.target.takeNotice()).toMatch(/not saved are gone/);
    });
  });

  describe('scripts of the Script menu', () => {
    const before = [{ view: 'Ha', historyIndex: 2 }];
    let shipped: string;
    let mine: string;
    /** A session whose user has added a folder of scripts. */
    let own: Session;

    const feature = async (dir: string, file: string, id: string) => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, file), `#feature-id ${id}\n`);
    };
    const start = (request: Parameters<Session['startScript']>[0], from = session) => from.jobs.wait(from.startScript(request).id, 2000);

    beforeEach(async () => {
      shipped = join(home, 'shipped');
      mine = join(home, 'mine');
      await feature(shipped, 'Solver.js', 'Solver : Astrometry > Solver');
      await feature(shipped, 'Mount.js', 'Mount : Instrumentation > Mount');
      await feature(shipped, 'Keys.js', 'Keys : Utilities > Keys | Development > Keys');
      await feature(mine, 'Mine.js', 'Mine : Utilities > Mine');
      await feature(mine, 'Solver.js', 'Solver : Utilities > Not the real one');
      cli.script = (job, dir, pixinsight) => {
        if (job.op === 'ping') return { build: 1713, scriptsDir: shipped };
        if (job.op === 'prepare_script') return job.args['view'] === 'gone' ? failJob(dir, 'unknown_view', 'No view named gone.') : { startedOn: job.args['view'] ?? 'Oiii', images: before };
        return answers(job, dir, pixinsight);
      };
      own = await Session.create(config({ scriptDirs: [mine] }), cli);
    });

    afterEach(async () => {
      await own.close();
    });

    it('finds those PixInsight ships, by asking it where they are, and those in the folders of the user', async () => {
      expect((await own.scripts()).map((script) => [script.name, script.source, script.path])).toEqual([
        ['Keys', 'shipped', join(shipped, 'Keys.js')],
        ['Mine', 'user', join(mine, 'Mine.js')],
        ['Mount', 'shipped', join(shipped, 'Mount.js')],
        ['Solver', 'shipped', join(shipped, 'Solver.js')],
      ]);
      await own.scripts();
      expect(cli.ran.filter((job) => job.op === 'ping')).toHaveLength(1);
    });

    it('makes the image active, starts a log and the script, and lets the report follow', async () => {
      const done = await start({ script: 'solver', view: 'Ha' });
      expect(done).toMatchObject({ state: 'succeeded', op: 'start_script' });
      expect(cli.commands).toEqual(['runner.js', 'runner.js', 'begin_log.js', 'Solver.js', 'runner.js']);
      expect(runOps()).toEqual(['prepare_script', 'start_script']);
      expect(cli.ran.find((job) => job.op === 'prepare_script')?.args).toEqual({ view: 'Ha' });
      expect(cli.started).toEqual([{ slot: USER, path: join(shipped, 'Solver.js') }]);
      // The image comes to the front once more right before the script, in case the user clicked elsewhere.
      expect(cli.logs).toEqual([{ file: join(home, 'jobs', done.id, 'script.log'), view: 'Ha' }]);
      // The report compares with what the images were like before the script.
      expect(cli.ran.at(-1)?.args).toEqual({ script: 'Solver', startedOn: 'Ha', before });
    });

    it('reports only when the script has ended, however long the user takes, and starts no second one meanwhile', async () => {
      let close!: () => void;
      cli.userScript = () =>
        new Promise<void>((resolve) => {
          close = resolve;
        });
      const job = session.startScript({ script: 'Solver' });
      await waitUntil(() => cli.started.length === 1);
      await sleep(40);
      expect(await session.jobs.get(job.id)).toMatchObject({ state: 'sent', done: false });
      // It would open right after the first one, on images the first one has changed.
      expect(() => session.startScript({ script: 'Solver' })).toThrow(expect.objectContaining({ kind: 'script_open', message: expect.stringContaining(job.id) }));
      cli.userScript = () => undefined;
      close();
      expect(await session.jobs.wait(job.id, 2000)).toMatchObject({ state: 'succeeded' });
      expect(cli.ran.at(-1)?.args).toMatchObject({ startedOn: 'Oiii' });
      expect((await start({ script: 'Solver' })).state).toBe('succeeded');
    });

    it.each([
      ['a script that does not exist', { script: 'Nope' }, 'unknown_script'],
      ['a script that controls equipment', { script: 'Mount' }, 'blocked_script'],
      ['a script that also sits in a blocked menu', { script: 'Keys' }, 'blocked_script'],
      ['an image that is not there', { script: 'Solver', view: 'gone' }, 'unknown_view'],
    ])('starts nothing for %s', async (_name, request, kind) => {
      expect((await start(request)).error?.kind).toBe(kind);
      expect(cli.started).toEqual([]);
      expect(cli.logs).toEqual([]);
      expect(runOps()).not.toContain('start_script');
    });

    it('names scripts that are meant, and never one from a folder that only shares the name', async () => {
      expect((await start({ script: 'Solv' }, own)).error?.message).toMatch(/Did you mean Solver\?/);
      expect((await start({ script: 'Sovler' }, own)).error?.message).toMatch(/Did you mean Solver\?/);
      expect((await start({ script: 'Something else entirely' }, own)).error?.message).toBe('No script named Something else entirely. Use list_scripts.');
      await start({ script: 'Solver' }, own);
      expect(cli.started).toEqual([{ slot: USER, path: join(shipped, 'Solver.js') }]);
    });

    describe('so that writing a file is no way to run code', () => {
      it('does not start a script of the user that was changed after the server started', async () => {
        expect((await start({ script: 'Mine' }, own)).state).toBe('succeeded');
        await writeFile(join(mine, 'Mine.js'), '#feature-id Mine : Utilities > Mine\nFile.remove( "/everything" );\n');
        const refused = await start({ script: 'Mine' }, own);
        expect(refused.error).toMatchObject({ kind: 'script_changed', message: expect.stringMatching(/since the server started.*Only the user/) });
        expect(cli.started).toHaveLength(1);
        expect(runOps().filter((op) => op === 'prepare_script')).toHaveLength(1);
      });

      it('does not start a script of the user that was changed before the server first listed the scripts', async () => {
        await writeFile(join(mine, 'Mine.js'), '#feature-id Mine : Utilities > Mine\n// changed before anything was asked\n');
        expect((await start({ script: 'Mine' }, own)).error?.kind).toBe('script_changed');
        expect(cli.started).toEqual([]);
      });

      it('does not know a script that was put into the folder after the server started', async () => {
        await feature(mine, 'Later.js', 'Later : Utilities > Later');
        expect((await own.scripts()).map((script) => script.name)).not.toContain('Later');
        expect((await start({ script: 'Later' }, own)).error?.kind).toBe('unknown_script');
      });

      it('does not start a shipped script that was changed after it was listed', async () => {
        await session.scripts();
        await writeFile(join(shipped, 'Solver.js'), '#feature-id Solver : Astrometry > Solver\n// changed\n');
        expect((await start({ script: 'Solver' })).error).toMatchObject({ kind: 'script_changed', message: expect.stringContaining('since the server listed it') });
        expect(cli.started).toEqual([]);
      });
    });

    it('refuses a script whose path the command line of PixInsight cannot carry', async () => {
      await feature(join(shipped, 'odd (x86)'), 'Odd.js', 'Odd : Utilities > Odd');
      const done = await start({ script: 'Odd' });
      expect(done.error).toMatchObject({ kind: 'blocked_script', message: expect.stringContaining('odd (x86)') });
      expect(cli.started).toEqual([]);
    });

    it('does not bring an image to the front for a job that was withdrawn while it waited', async () => {
      cli.script = (job, dir, pixinsight) => (job.op === 'stuck' ? undefined : job.op === 'ping' ? { build: 1713, scriptsDir: shipped } : answers(job, dir, pixinsight));
      await session.scripts();
      const stuck = session.jobs.submit('stuck', {});
      await waitUntil(() => cli.ran.some((job) => job.op === 'stuck'));
      const waiting = session.startScript({ script: 'Solver', view: 'Ha' });
      expect(session.jobs.cancelQueued(waiting.id)).toBe(true);
      await session.jobs.abandon(stuck.id);
      await sleep(40);
      expect(runOps()).toEqual(['stuck']);
      expect(cli.started).toEqual([]);
    });

    it('does not start a script in an instance that replaced the one the assistant knows, before it has heard of that', async () => {
      await session.jobs.wait(session.jobs.submit('ping', {}).id, 2000);
      session.target.invalidate();
      cli.remove(USER);
      cli.addInstance(USER);
      await session.jobs.wait(session.jobs.submit('ping', {}).id, 2000);
      expect(session.target.notice).toBeDefined();

      const done = await start({ script: 'Solver', view: 'Ha' });
      expect(done.error?.kind).toBe('instance_changed');
      expect(cli.started).toEqual([]);
      // Not even the step that brings the image to the front.
      expect(runOps()).not.toContain('prepare_script');
    });

    it('takes back the step that brings the image to the front if PixInsight does not get to it in time', async () => {
      cli.script = (job, dir, pixinsight) => (job.op === 'prepare_script' ? undefined : job.op === 'ping' ? { build: 1713, scriptsDir: shipped } : answers(job, dir, pixinsight));
      const quick = await Session.create(config(), cli);
      (quick as unknown as { lookupTimeoutMs: number }).lookupTimeoutMs = 60;
      const done = await quick.jobs.wait(quick.startScript({ script: 'Solver', view: 'Ha' }).id, 3000);
      expect(done.error?.kind).toBe('busy');
      // Withdrawn, so that it cannot run much later with nobody waiting, and the queue is free again.
      expect(quick.jobs.stats()).toEqual({ queued: 0, active: null });
      expect(cli.started).toEqual([]);
      await quick.close();
    });

    it('starts none in an instance of its own, where nobody could work the dialog', async () => {
      const worker = await Session.create(config({ mode: 'worker' }), cli);
      expect(() => worker.startScript({ script: 'Solver' })).toThrow(expect.objectContaining({ kind: 'needs_window' }));
      expect(worker.jobs.stats()).toEqual({ queued: 0, active: null });
      await worker.close();
    });

    it('cannot be made to start a script without these checks', () => {
      expect(() => session.jobs.submit('start_script', { script: 'Solver' })).toThrow(/must not be submitted without its check/);
    });
  });

  describe('code of the assistant', () => {
    it('does not run unless the user has turned it on', async () => {
      const done = await session.jobs.wait(session.runCode('return 1;').id, 2000);
      expect(done.error).toMatchObject({ kind: 'blocked_code', message: expect.stringContaining('PIXINSIGHT_MCP_ALLOW_CODE') });
      expect(runOps()).toEqual([]);
      expect(() => session.jobs.submit('run_code', { code: 'return 1;' })).toThrow(/must not be submitted without its check/);
    });

    it('runs once the user has turned it on', async () => {
      const allowed = await Session.create(config({ allowCode: true }), cli);
      expect(await allowed.jobs.wait(allowed.runCode('return 1;').id, 2000)).toMatchObject({ state: 'succeeded' });
      expect(cli.ran.at(-1)).toMatchObject({ op: 'run_code', args: { code: 'return 1;' } });
      await allowed.close();
    });
  });
});
