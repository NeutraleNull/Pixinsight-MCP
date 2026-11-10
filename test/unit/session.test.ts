import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { Session, type ProcessInfo, type ScriptView } from '../../src/session.js';
import { pix, FakePixInsight, FORM_FIELDS, failJob, isRunning, playForm, playScript, sleep, waitUntil, type HookPart, type Script } from './fakes.js';

const USER = 1;
const SHADOW = 250;
const PREPROCESS = 240;

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
    preprocessSlot: PREPROCESS,
    headless: true,
    home,
    allowedPrograms: ['/opt/GraXpert'],
    guideDirs: [], scriptDirs: [], allowCode: false, scriptDialogs: 'off',
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
      // With the file, whose signature PixInsight checks before the script may start.
      // Paths reach PixInsight with forward slashes on every system, so they are compared that way.
      const prepared = cli.ran.find((job) => job.op === 'prepare_script')?.args;
      expect({ ...prepared, script: pix(String(prepared?.['script'])) }).toEqual({ view: 'Ha', script: pix(join(shipped, 'Solver.js')) });
      expect(cli.started.map(({ slot, path }) => ({ slot, path: pix(path) }))).toEqual([{ slot: USER, path: pix(join(shipped, 'Solver.js')) }]);
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

    it('starts nothing if PixInsight finds that the script does not match its signature', async () => {
      const prepare = cli.script;
      cli.script = (job, dir, pixinsight) => (job.op === 'prepare_script' ? failJob(dir, 'bad_signature', 'The file of this script does not match its signature.') : prepare(job, dir, pixinsight));
      expect((await start({ script: 'Solver' })).error?.kind).toBe('bad_signature');
      expect(cli.started).toEqual([]);
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

    describe('preprocessing with WBPP in its automation mode', () => {
      let frames: string;
      let out: string;
      const refusal = (request: Parameters<Session['startPreprocessing']>[0], platform?: NodeJS.Platform) =>
        session.startPreprocessing(request, platform).then(
          () => ({ kind: 'not refused', message: '' }),
          (error: { kind?: string; message: string }) => ({ kind: error.kind ?? 'no kind', message: error.message }),
        );

      beforeEach(async () => {
        await feature(shipped, 'WBPP.js', 'WeightedBatchPreprocessing : Batch Processing > WeightedBatchPreprocessing');
        frames = join(home, 'frames');
        out = join(home, 'out');
        await mkdir(join(frames, 'session 1'), { recursive: true });
        await writeFile(join(frames, 'master bias.xisf'), 'x');
      });

      afterEach(() => {
        for (const run of cli.runs) run.end(null);
      });

      it('puts folders, files, keywords and options onto the command line of an instance of its own, and nothing onto that of the user', async () => {
        const run = await session.startPreprocessing({
          inputs: [`${join(frames, 'session 1')}/`, join(frames, 'master bias.xisf')],
          outputDirectory: out,
          keywords: ['SESSION', ' PANEL post '],
          options: { platesolve: false, minWeight: 0.1, 'frameSelection.FWHM.enabled': true, referenceImage: join(frames, 'master bias.xisf') },
        });
        expect(run).toMatchObject({ op: 'preprocess', state: 'running', slot: PREPROCESS });
        expect(cli.runs).toHaveLength(1);
        // A folder is read as a whole, a file as one frame. A keyword each, because their own separator means something on a command line.
        expect(cli.runs[0]!.scripts[1]).toEqual({
          path: join(shipped, 'WBPP.js'),
          args: [
            'automationMode=true',
            `outputDirectory=${pix(out)}`,
            'keywords=SESSION',
            'keywords=PANEL post',
            'platesolve=false',
            'minWeight=0.1',
            'frameSelection.FWHM.enabled=true',
            `referenceImage=${join(frames, 'master bias.xisf')}`,
            `dir=${pix(join(frames, 'session 1'))}`,
            `file=${pix(join(frames, 'master bias.xisf'))}`,
          ],
        });
        // Nothing went to the instance the user works in, apart from the question where its scripts are.
        expect(cli.started).toEqual([]);
        expect(runOps()).toEqual([]);
      });

      it('refuses what would mean something else on a command line, or lead somewhere else', async () => {
        const fine = { inputs: [frames], outputDirectory: out };
        expect(await refusal({ ...fine, inputs: ['frames'] })).toMatchObject({ kind: 'invalid_path', message: expect.stringMatching(/absolute paths, with nothing around them, not "frames"/) });
        expect(await refusal({ ...fine, inputs: [join(home, 'nothing')] })).toMatchObject({ kind: 'no_such_file' });
        expect(await refusal({ ...fine, outputDirectory: 'out' })).toMatchObject({ kind: 'invalid_path' });
        expect(await refusal({ ...fine, outputDirectory: join(frames, 'master bias.xisf') })).toMatchObject({ kind: 'invalid_path', message: expect.stringMatching(/is a file/) });
        // WBPP reads a folder with everything below it, so its own output there would be input the next time.
        expect(await refusal({ ...fine, outputDirectory: join(frames, 'out') })).toMatchObject({ kind: 'invalid_path', message: expect.stringMatching(/lies in the input folder/) });
        expect(await refusal({ ...fine, outputDirectory: frames })).toMatchObject({ kind: 'invalid_path' });
        // A character that means something on a command line: the answer names it, because no other spelling of the path helps.
        expect(await refusal({ ...fine, outputDirectory: join(home, 'out,put') })).toMatchObject({ kind: 'invalid_path', message: expect.stringMatching(/The output folder .*out,put cannot go onto the command line of PixInsight, because "," has a meaning there/) });
        await writeFile(join(frames, 'masterLight_(1).xisf'), 'x');
        expect(await refusal({ ...fine, inputs: [join(frames, 'masterLight_(1).xisf')] })).toMatchObject({ kind: 'invalid_path', message: expect.stringMatching(/because "\(" has a meaning there\. Tell the user/) });
        expect(await refusal({ ...fine, inputs: [] })).toMatchObject({ kind: 'invalid_value' });
        expect(await refusal({ ...fine, inputs: [` ${frames}`] })).toMatchObject({ kind: 'invalid_path', message: expect.stringMatching(/nothing around them/) });
        expect(await refusal({ ...fine, outputDirectory: `${out} ` })).toMatchObject({ kind: 'invalid_path', message: expect.stringMatching(/nothing around it/) });
        for (const keyword of ['SESSION;PANEL', 'SESSION both', '', 'A,B', '$(x)']) expect(await refusal({ ...fine, keywords: [keyword] })).toMatchObject({ kind: 'invalid_value' });
        expect(await refusal({ ...fine, options: { 'plate solve': true } })).toMatchObject({ kind: 'invalid_value' });
        expect(await refusal({ ...fine, options: { platesolve: 'a,file=/etc/passwd' } })).toMatchObject({ kind: 'invalid_value' });
        expect(await refusal({ ...fine, options: { minWeight: Number.NaN } })).toMatchObject({ kind: 'invalid_value' });
        expect(await refusal({ ...fine, options: { rejection_4: { a: 1 } } })).toMatchObject({ kind: 'invalid_value' });
        expect(cli.runs).toEqual([]);
      });

      it.skipIf(process.platform === 'win32')('refuses a backslash in a name elsewhere than on Windows, where the launcher of PixInsight would take it away', async () => {
        await writeFile(join(home, 'a\\b.fits'), 'x');
        expect(await refusal({ inputs: [join(home, 'a\\b.fits')], outputDirectory: out })).toMatchObject({ kind: 'invalid_path', message: expect.stringMatching(/because "\\\\" has a meaning there/) });
        expect(cli.runs).toEqual([]);
      });

      it.skipIf(process.platform === 'win32')('follows a link to see where the output and the inputs really are', async () => {
        await symlink(frames, join(home, 'link'));
        expect(await refusal({ inputs: [frames], outputDirectory: join(home, 'link', 'out') })).toMatchObject({ kind: 'invalid_path', message: expect.stringMatching(/lies in the input folder/) });
        expect(await refusal({ inputs: [join(home, 'link')], outputDirectory: join(frames, 'out') })).toMatchObject({ kind: 'invalid_path', message: expect.stringMatching(/lies in the input folder/) });
        expect(cli.runs).toEqual([]);
      });

      it('sees through other spellings of a path that would put the output among the inputs, or the inputs into the output', async () => {
        const fine = { inputs: [frames], outputDirectory: out };
        const inside = /lies in the input folder/;
        expect(await refusal({ ...fine, outputDirectory: `${home}/x/../frames/out` })).toMatchObject({ kind: 'invalid_path', message: expect.stringMatching(inside) });
        expect(await refusal({ ...fine, outputDirectory: `${home}//frames///out` })).toMatchObject({ kind: 'invalid_path', message: expect.stringMatching(inside) });
        // The other way round: a folder that the run writes into is no folder to read.
        await mkdir(join(out, 'master'), { recursive: true });
        await writeFile(join(out, 'master', 'masterFlat.xisf'), 'x');
        expect(await refusal({ inputs: [frames, join(out, 'master')], outputDirectory: out })).toMatchObject({ kind: 'invalid_path', message: expect.stringMatching(/lies in the output folder.*Name single files/) });
        expect(cli.runs).toEqual([]);
        // A single file from there is fine: a master of an earlier run.
        expect((await session.startPreprocessing({ inputs: [frames, join(out, 'master', 'masterFlat.xisf')], outputDirectory: out })).state).toBe('running');
        // What reaches PixInsight is the path without its detours.
        expect(cli.runs[0]!.scripts[1]!.args).toContain(`outputDirectory=${pix(out)}`);
      });

      it('counts the command line in bytes, as the system does', async () => {
        const long = join(home, 'ü'.repeat(120));
        await mkdir(long);
        await writeFile(join(long, 'frame.fits'), 'x');
        // 420 paths of some 150 letters each fit by letters, and not by bytes.
        expect(await refusal({ inputs: Array.from({ length: 420 }, () => join(long, 'frame.fits')), outputDirectory: out })).toMatchObject({ kind: 'invalid_value', message: expect.stringMatching(/bytes.*Name folders instead of single files/) });
      });

      it('names frames on Windows by drive or share, with either kind of slash', async () => {
        const fine = { inputs: [frames], outputDirectory: out };
        expect(await refusal({ ...fine, inputs: ['frames\\night 1'] }, 'win32')).toMatchObject({ kind: 'invalid_path', message: expect.stringMatching(/absolute paths/) });
        // Read as paths of Windows, which this machine may not have: they get as far as the look for the folder.
        expect(await refusal({ ...fine, inputs: ['C:\\astro\\night 1\\'] }, 'win32')).toMatchObject({ kind: 'no_such_file', message: expect.stringContaining('C:/astro/night 1.') });
        // Not asked on Windows itself, where the look for a share that is not there takes its time.
        if (process.platform !== 'win32') {
          expect(await refusal({ ...fine, inputs: ['\\\\nas\\astro\\..\\astro\\night 1'] }, 'win32')).toMatchObject({ kind: 'no_such_file', message: expect.stringContaining('//nas/astro/night 1.') });
        }
      });

      it('lets no option through that runs a script file or that the tool sets itself', async () => {
        const fine = { inputs: [frames], outputDirectory: out };
        for (const name of ['usePipelineScript', 'pipelineScriptFile', 'usePipelineBuilderScript', 'pipelineBuilderScriptFile']) {
          expect(await refusal({ ...fine, options: { [name]: 'x' } })).toMatchObject({ kind: 'blocked_parameter', message: expect.stringMatching(/running code/) });
        }
        for (const name of ['automationMode', 'dir', 'file', 'keywords', 'outputDirectory', 'outputDir', 'testFile', 'loadOnly', 'recordTest', 'fileSearchRootPath', 'paramList', 'AUTOMATIONMODE', 'Dir']) {
          expect(await refusal({ ...fine, options: { [name]: 'x' } })).toMatchObject({ kind: 'blocked_parameter' });
        }
        // WBPP compiles this one into a function.
        expect(await refusal({ ...fine, options: { 'frameSelection.custom.formula': 'SNR/FWHM' } })).toMatchObject({ kind: 'blocked_parameter', message: expect.stringMatching(/evaluates its value as code/) });
        expect(cli.runs).toEqual([]);
      });

      it('says so when the frames are too many to name one by one, where a folder would do', async () => {
        const long = join(home, 'x'.repeat(200));
        await mkdir(long);
        await writeFile(join(long, 'frame.fits'), 'x');
        expect(await refusal({ inputs: Array.from({ length: 480 }, () => join(long, 'frame.fits')), outputDirectory: out })).toMatchObject({ kind: 'invalid_value', message: expect.stringMatching(/Name folders instead of single files/) });
      });

      it('passes on why a run cannot begin: one is under way, or the script is not what the server listed', async () => {
        const first = await session.startPreprocessing({ inputs: [frames], outputDirectory: out });
        expect(await refusal({ inputs: [frames], outputDirectory: out })).toMatchObject({ kind: 'busy', message: expect.stringContaining(first.id) });
        cli.runs[0]!.end(0);
        await waitUntil(async () => (await session.preprocessing.get(first.id))?.done === true);
        await writeFile(join(shipped, 'WBPP.js'), '// Changed after the server listed it.\n#feature-id WeightedBatchPreprocessing : Batch Processing > WeightedBatchPreprocessing\n');
        expect(await refusal({ inputs: [frames], outputDirectory: out })).toMatchObject({ kind: 'script_changed' });
      });
    });

    it('cannot be made to start a script without these checks', () => {
      expect(() => session.jobs.submit('start_script', { script: 'Solver' })).toThrow(/must not be submitted without its check/);
    });

    describe('whose dialogs the assistant may read and work', () => {
      let working: Session;
      const look = { waitMs: 2000 };
      const FIELDS = FORM_FIELDS;
      const json = async (path: string): Promise<any> => JSON.parse(await readFile(path, 'utf8').catch(() => 'null'));
      const playing = (part: (hook: HookPart) => Promise<void>) => playScript(cli, part);
      const form = (taken: Array<Record<string, any>> = []) => playForm(cli, taken);
      const kindOf = (view: ScriptView | null) => view?.kind;

      beforeEach(async () => {
        await writeFile(join(shipped, 'New.js'), '// Runs on the newer engine.\n#engine v8\n#feature-id New : Utilities > New\n');
        working = await Session.create(config({ scriptDialogs: 'operate' }), cli);
      });

      afterEach(async () => {
        cli.userScript = () => undefined;
        await working.close();
      });

      it('sends a file of its own that runs the script from inside, and cleans up after a script of the older engine', async () => {
        const done = await start({ script: 'Solver', view: 'Ha' }, working);
        expect(done.state).toBe('succeeded');
        const wrapper = join(home, 'jobs', done.id, 'start.js');
        expect(cli.started).toEqual([{ slot: USER, path: wrapper }]);
        expect(cli.commands.slice(-4)).toEqual(['begin_log.js', 'start.js', 'unhook.js', 'runner.js']);
        const source = await readFile(wrapper, 'utf8');
        expect(source.startsWith('( //')).toBe(true);
        // With the folder of the job, leave to work the dialogs, and the engine, which the hook cannot tell by itself.
        expect(source).toContain(`)( ${JSON.stringify(pix(join(home, 'jobs', done.id)))}, true, false );\n#include "${pix(join(shipped, 'Solver.js'))}"\n`);
        // The hook is the one this server came with.
        expect(source).toContain((await readFile(working.paths.dialogHookPath, 'utf8')).trimEnd());
      });

      it('runs that file on V8 where the script does, where nothing is left to clean up', async () => {
        const done = await start({ script: 'New' }, working);
        const source = await readFile(join(home, 'jobs', done.id, 'start.js'), 'utf8');
        expect(source.split('\n')[0]).toBe('#engine v8');
        expect(source).toContain(', true, true );\n#include');
        expect(cli.commands.slice(-3)).toEqual(['begin_log.js', 'start.js', 'runner.js']);
        expect(cli.unhooked).toBe(0);
      });

      it('starts a script as PixInsight does by itself if that is asked for, and then cannot look into it', async () => {
        let close!: () => void;
        cli.userScript = () => new Promise<void>((resolve) => (close = resolve));
        const job = working.startScript({ script: 'Solver', plain: true });
        expect(await working.watchScript(job.id, look)).toBeNull();
        await waitUntil(() => cli.started.length === 1);
        expect(cli.started).toEqual([{ slot: USER, path: join(shipped, 'Solver.js') }]);
        await expect(working.scriptDialog(look)).rejects.toMatchObject({ kind: 'no_dialog_access' });
        await expect(working.useScriptDialog({ action: 'close' }, look)).rejects.toMatchObject({ kind: 'no_dialog_access' });
        close();
        expect((await working.jobs.wait(job.id, 2000)).state).toBe('succeeded');
        expect(cli.unhooked).toBe(0);
      });

      it('shows the dialog as soon as the script does, and what one action after the other makes of it', async () => {
        const taken: Array<Record<string, any>> = [];
        form(taken);
        const job = working.startScript({ script: 'Solver' });
        const first = await working.watchScript(job.id, look);
        expect(first).toMatchObject({ kind: 'dialog', job: { id: job.id, done: false }, dialog: { title: 'Solver', fields: FIELDS } });

        expect(kindOf(await working.useScriptDialog({ action: 'set', field: 'f1', value: 'M 31' }, look))).toBe('dialog');
        expect(kindOf(await working.useScriptDialog({ action: 'click', x: 10, y: 12 }, look))).toBe('dialog');
        const again = await working.scriptDialog({ ...look, picture: true, help: true });
        expect(again).toMatchObject({ kind: 'dialog', picture: join(home, 'jobs', job.id, 'dialog-1.png') });
        expect(await readFile((again as { picture: string }).picture, 'utf8')).toBe('png');

        // The button ends the script, so what comes back is the report of the job.
        const end = await working.useScriptDialog({ action: 'press', field: 'f2' }, look);
        expect(end).toMatchObject({ kind: 'done', job: { state: 'succeeded', op: 'start_script' } });
        // Every action names the showing of the dialog it is meant for, and so does the picture.
        expect(taken.map(({ id: _id, path: _path, ...command }) => command)).toEqual([
          { act: 'describe', dialog: null, help: false },
          { act: 'set', dialog: 'd1.1', field: 'f1', value: 'M 31' },
          { act: 'describe', dialog: null, help: false },
          { act: 'click', dialog: 'd1.1', x: 10, y: 12 },
          { act: 'describe', dialog: null, help: false },
          { act: 'describe', dialog: null, help: true },
          { act: 'render', dialog: 'd1.1' },
          { act: 'press', dialog: 'd1.1', field: 'f2' },
        ]);
      });

      it('passes on what the script refuses, and what an action lacks', async () => {
        form();
        const job = working.startScript({ script: 'Solver' });
        await working.watchScript(job.id, look);
        await expect(working.useScriptDialog({ action: 'press', field: 'f9' }, look)).rejects.toMatchObject({ kind: 'unknown_field', message: 'The dialog has no field f9.' });
        await expect(working.useScriptDialog({ action: 'set', field: 'f1' }, look)).rejects.toMatchObject({ kind: 'invalid_value' });
        await expect(working.useScriptDialog({ action: 'press' }, look)).rejects.toMatchObject({ kind: 'invalid_value' });
        await expect(working.useScriptDialog({ action: 'click', x: 3 }, look)).rejects.toMatchObject({ kind: 'invalid_value' });
        await expect(working.useScriptDialog({ action: 'answer', value: 'yes' }, look)).rejects.toMatchObject({ kind: 'no_question' });
        expect(kindOf(await working.useScriptDialog({ action: 'close' }, look))).toBe('done');
        // Once the script has ended, a look returns its report, and an action says where that is.
        expect(await working.scriptDialog(look)).toMatchObject({ kind: 'done', job: { id: job.id, state: 'succeeded' } });
        await expect(working.useScriptDialog({ action: 'close' }, look)).rejects.toMatchObject({ kind: 'no_script', message: expect.stringContaining(job.id) });
      });

      it('knows no script before one was started', async () => {
        await expect(working.scriptDialog(look)).rejects.toMatchObject({ kind: 'no_script', message: expect.stringContaining('start_script') });
        await expect(working.useScriptDialog({ action: 'close' }, look)).rejects.toMatchObject({ kind: 'no_script' });
      });

      it('shows a question of the script, and gives the script the answer if it is one the question allows', async () => {
        const answers: unknown[] = [];
        playing(async (hook) => {
          const question = { id: 1, kind: 'message', text: 'Replace the file?', buttons: ['yes', 'no'] };
          await hook.say({ dialog: null, title: null, question });
          answers.push(await hook.answerTo(1));
          await hook.say({ dialog: null, title: null });
        });
        const job = working.startScript({ script: 'Solver' });
        expect(await working.watchScript(job.id, look)).toMatchObject({ kind: 'question', question: { kind: 'message', text: 'Replace the file?', buttons: ['yes', 'no'] } });
        // Nothing else can be done while the script waits for this.
        await expect(working.useScriptDialog({ action: 'press', field: 'f2' }, look)).rejects.toMatchObject({ kind: 'question_open', message: expect.stringContaining('Replace the file?') });
        await expect(working.useScriptDialog({ action: 'answer', value: 'maybe' }, look)).rejects.toMatchObject({ kind: 'invalid_value', message: expect.stringContaining('yes, no') });
        await expect(working.useScriptDialog({ action: 'close' }, look)).rejects.toMatchObject({ kind: 'question_open' });
        expect(kindOf(await working.useScriptDialog({ action: 'answer', value: ' Yes ' }, look))).toBe('done');
        expect(answers).toEqual(['yes']);
      });

      it('checks a path before the script gets it, and never lets a file be replaced on its own word', async () => {
        const existing = join(home, 'existing.xisf');
        await writeFile(existing, 'x');
        const answers: unknown[] = [];
        playing(async (hook) => {
          const ask = async (id: number, question: object) => {
            await hook.say({ dialog: null, title: null, question: { id, ...question } });
            answers.push(await hook.answerTo(id));
          };
          await ask(1, { kind: 'open_file', caption: 'Open' });
          await ask(2, { kind: 'save_file', caption: 'Save' });
          await ask(3, { kind: 'directory', caption: 'Folder' });
          await ask(4, { kind: 'open_file', caption: 'Open several', multiple: true });
          await ask(5, { kind: 'save_file', caption: 'Save' });
          await hook.say({ dialog: null, title: null });
        });
        const job = working.startScript({ script: 'Solver' });
        const answer = (value: string | string[] | boolean, allowOverwrite?: boolean) => working.useScriptDialog({ action: 'answer', value, allowOverwrite }, look);
        expect(kindOf(await working.watchScript(job.id, look))).toBe('question');

        await expect(answer(join(home, 'missing.xisf'))).rejects.toMatchObject({ kind: 'no_such_file' });
        await expect(answer('existing.xisf')).rejects.toMatchObject({ kind: 'invalid_path', message: expect.stringContaining('absolute') });
        await expect(answer([existing, existing])).rejects.toMatchObject({ kind: 'invalid_value' });
        await expect(answer(true)).rejects.toMatchObject({ kind: 'invalid_value' });
        expect(await answer(existing)).toMatchObject({ kind: 'question', question: { kind: 'save_file' } });

        await expect(answer(existing)).rejects.toMatchObject({ kind: 'file_exists', message: expect.stringContaining('allowOverwrite') });
        await expect(answer(join(home, 'no-folder', 'new.xisf'))).rejects.toMatchObject({ kind: 'no_such_file' });
        await expect(answer(home)).rejects.toMatchObject({ kind: 'invalid_path' });
        expect(await answer(join(home, 'new.xisf'))).toMatchObject({ kind: 'question', question: { kind: 'directory' } });

        await expect(answer(existing)).rejects.toMatchObject({ kind: 'no_such_file' });
        expect(await answer(home)).toMatchObject({ kind: 'question', question: { multiple: true } });
        expect(await answer([existing, existing])).toMatchObject({ kind: 'question', question: { kind: 'save_file' } });
        expect(kindOf(await answer(existing, true))).toBe('done');
        // As PixInsight takes paths: with forward slashes on every system.
        expect(answers).toEqual([pix(existing), pix(join(home, 'new.xisf')), pix(home), [pix(existing), pix(existing)], pix(existing)]);
      });

      it('cancels a file chooser by closing, and by the answer false', async () => {
        const answers: unknown[] = [];
        playing(async (hook) => {
          for (const id of [1, 2]) {
            await hook.say({ dialog: null, title: null, question: { id, kind: 'open_file', caption: 'Open' } });
            answers.push(await hook.answerTo(id));
          }
          await hook.say({ dialog: null, title: null });
        });
        const job = working.startScript({ script: 'Solver' });
        await working.watchScript(job.id, look);
        expect(kindOf(await working.useScriptDialog({ action: 'close' }, look))).toBe('question');
        expect(kindOf(await working.useScriptDialog({ action: 'answer', value: false }, look))).toBe('done');
        expect(answers).toEqual([false, false]);
      });

      it('does not answer a question the user has answered in the meantime', async () => {
        let answered!: () => void;
        const taken: unknown[] = [];
        playing(async (hook) => {
          await hook.say({ dialog: null, title: null, question: { id: 1, kind: 'message', text: 'Go on?', buttons: ['ok'] } });
          await new Promise<void>((resolve) => (answered = resolve));
          await hook.say();
          taken.push(await hook.command());
        });
        const job = working.startScript({ script: 'Solver' });
        expect(kindOf(await working.watchScript(job.id, look))).toBe('question');
        answered();
        await waitUntil(async () => (await json(join(home, 'jobs', job.id, 'dialog-state-2.json'))) !== null);
        await expect(working.useScriptDialog({ action: 'answer', value: 'ok' }, look)).rejects.toMatchObject({ kind: 'no_question' });
        await expect(readFile(join(home, 'jobs', job.id, 'dialog-answer-1.json'))).rejects.toThrow();
      });

      it('says that nothing is shown while the script is at work, and takes back what nobody took', async () => {
        let end: (() => void) | undefined;
        playing(async (hook) => {
          await hook.say({ dialog: null, title: null });
          await new Promise<void>((resolve) => (end = resolve));
        });
        const job = working.startScript({ script: 'Solver' });
        expect(await working.watchScript(job.id, { waitMs: 80 })).toMatchObject({ kind: 'none', job: { done: false } });
        await expect(working.useScriptDialog({ action: 'press', field: 'f2' }, look)).rejects.toMatchObject({ kind: 'no_dialog' });
        await expect(readFile(join(home, 'jobs', job.id, 'dialog-cmd.json'))).rejects.toThrow();
        await waitUntil(() => end !== undefined);
        end?.();
        expect(kindOf(await working.scriptDialog(look))).toBe('done');
      });

      it('shows the dialog that a button opened in place of an answer to the press, which comes when that is closed', async () => {
        playing(async (hook) => {
          await hook.say();
          const describe = async (title: string) => {
            const command = await hook.command();
            await hook.reply(command['id'], { ok: true, result: { dialog: title === 'Child' ? 'd2.1' : 'd1.1', title, size: [100, 50], fields: [] } });
          };
          await describe('Solver');
          await hook.command();
          await hook.say({ dialog: 'd2.1', title: 'Child' });
          await describe('Child');
          await hook.command();
          await hook.say({ dialog: null, title: null });
        });
        const job = working.startScript({ script: 'Solver' });
        await working.watchScript(job.id, look);
        expect(await working.useScriptDialog({ action: 'press', field: 'f2' }, look)).toMatchObject({ kind: 'dialog', dialog: { title: 'Child' } });
        expect(kindOf(await working.useScriptDialog({ action: 'close' }, look))).toBe('done');
      });

      describe('so that nothing is done to something the assistant has not seen', () => {
        const exists = (job: { id: string }, file: string) => readFile(join(home, 'jobs', job.id, file)).then(() => true, () => false);
        const describing = async (hook: HookPart, name = 'd1.1', title = 'Solver') => {
          const command = await hook.command();
          await hook.reply(command['id'], { ok: true, result: { dialog: name, title, size: [100, 50], fields: FIELDS } });
        };

        it('reads one field of the dialog it last showed in full, and no field of a dialog it has not shown', async () => {
          const taken: Array<Record<string, any>> = [];
          form(taken);
          const job = working.startScript({ script: 'Solver' });
          await waitUntil(() => exists(job, 'dialog-state-1.json'));
          await expect(working.scriptField({ field: 'f1' }, look)).rejects.toMatchObject({ kind: 'dialog_changed', message: expect.stringMatching(/a dialog that you have not read yet.*get_script_dialog first, without a field/) });
          expect(taken).toEqual([]);

          await working.watchScript(job.id, look);
          expect(await working.scriptField({ field: 'f1', from: 5 }, look)).toMatchObject({ kind: 'field', title: 'Solver', job: { id: job.id }, field: { id: 'f1', type: 'Edit', value: 'initial', from: 5 } });
          // It is asked of the very dialog that was read, so that the name of a field cannot mean another one.
          expect(taken.at(-1)).toMatchObject({ act: 'describe', dialog: 'd1.1', field: 'f1', from: 5, help: false });
          await expect(working.scriptField({ field: 'f9' }, look)).rejects.toMatchObject({ kind: 'unknown_field' });
          await working.useScriptDialog({ action: 'close' }, look);
          expect(kindOf(await working.scriptField({ field: 'f1' }, look))).toBe('done');
        });

        it('waits for a field of the dialog it last showed, such as the button that ends a long run', async () => {
          let looks = 0;
          let finish: (() => void) | undefined;
          playing(async (hook) => {
            await hook.say();
            for (;;) {
              const command = await hook.command();
              if (command['act'] !== 'describe') {
                await hook.reply(command['id'], { ok: true, result: { fired: [] } });
                return hook.say({ dialog: null, title: null });
              }
              // The run ends between the third look and the fourth. Until then its button is there, and greyed out.
              const done = ++looks > 3;
              if (looks === 3) finish?.();
              await hook.reply(command['id'], { ok: true, result: { dialog: 'd1.1', title: 'Monitor', size: [200, 80], fields: [{ id: 'f1', type: 'PushButton', text: 'Cancel' }, { id: 'f2', type: 'PushButton', text: 'DONE', ...(done ? {} : { enabled: false }) }] } });
            }
          });
          working.untilPollMs = 20;
          const job = working.startScript({ script: 'Solver' });
          await working.watchScript(job.id, look);
          expect(looks).toBe(1);
          await expect(working.scriptDialog({ waitMs: 1000, until: '  ' })).rejects.toMatchObject({ kind: 'invalid_value' });
          // A text that no field has is waited for in vain: no dialog comes back, only that it is not there yet.
          expect(await working.scriptDialog({ waitMs: 1000, until: 'Finished' })).toMatchObject({ kind: 'none', why: 'not_yet', job: { id: job.id } });
          const before = looks;
          expect(before).toBeGreaterThan(2);
          const shown = await working.scriptDialog({ waitMs: 5000, until: ' done ' });
          expect(shown).toMatchObject({ kind: 'dialog', dialog: { title: 'Monitor', fields: [{ text: 'Cancel' }, { id: 'f2', text: 'DONE' }] } });
          expect((shown as { dialog: { fields: Array<Record<string, unknown>> } }).dialog.fields[1]).not.toHaveProperty('enabled');
          await working.useScriptDialog({ action: 'close' }, look);
        });

        it('compares with what it last showed, not with what it only looked at while it waited or with what it refused', async () => {
          let label = 'Step 1';
          playing(async (hook) => {
            await hook.say();
            for (;;) {
              const command = await hook.command();
              if (command['act'] === 'describe') {
                await hook.reply(command['id'], { ok: true, result: { dialog: 'd1.1', title: 'Monitor', size: [200, 80], fields: [{ id: 'f1', type: 'Label', text: label }, { id: 'f2', type: 'PushButton', text: 'Next' }] } });
                // The script goes on by itself between two looks.
                label = label === 'Step 1' ? 'Step 2' : 'Step 3';
              } else if (command['field'] === 'f9') await hook.reply(command['id'], { ok: false, error: { kind: 'unknown_field', message: 'The dialog has no field f9.' } });
              else if (command['act'] === 'close') {
                await hook.reply(command['id'], { ok: true, result: { fired: [] } });
                return hook.say({ dialog: null, title: null });
              } else await hook.reply(command['id'], { ok: true, result: { fired: [] } });
            }
          });
          working.untilPollMs = 20;
          const job = working.startScript({ script: 'Solver' });
          expect(await working.watchScript(job.id, look)).toMatchObject({ dialog: { fields: [{ text: 'Step 1' }, { text: 'Next' }] } });
          // Several looks, none of which is shown. And an action that is refused shows nothing either.
          expect(await working.scriptDialog({ waitMs: 1000, until: 'Finished' })).toMatchObject({ kind: 'none', why: 'not_yet' });
          await expect(working.useScriptDialog({ action: 'press', field: 'f9' }, look)).rejects.toMatchObject({ kind: 'unknown_field' });
          // So the next answer says what is different from the first description, however often the label changed meanwhile.
          const view = await working.useScriptDialog({ action: 'press', field: 'f2' }, look);
          expect(view).toMatchObject({ changes: { changed: [{ id: 'f1', type: 'Label', text: 'Step 3' }], unchanged: 1 } });
          await working.useScriptDialog({ action: 'close' }, look);
        });

        it('says that an action was carried out where it cannot show what came of it', async () => {
          let described = 0;
          playing(async (hook) => {
            await hook.say();
            for (;;) {
              const command = await hook.command();
              if (command['act'] === 'close') {
                await hook.reply(command['id'], { ok: true, result: { fired: [] } });
                return hook.say({ dialog: null, title: null });
              }
              if (command['act'] !== 'describe') await hook.reply(command['id'], { ok: true, result: { fired: ['onClick'] } });
              // The first look works. The one after the action fails in the script, and the one after that is never answered.
              else if (++described === 1) await hook.reply(command['id'], { ok: true, result: { dialog: 'd1.1', title: 'Solver', size: [200, 80], fields: FIELDS } });
              else if (described === 2) await hook.reply(command['id'], { ok: false, error: { kind: 'script_error', message: 'The dialog could not be described.' } });
            }
          });
          const job = working.startScript({ script: 'Solver' });
          await working.watchScript(job.id, look);
          await expect(working.useScriptDialog({ action: 'press', field: 'f2' }, look)).rejects.toMatchObject({
            kind: 'script_error',
            message: expect.stringMatching(/^Your action \(press f2\) was carried out, so do not repeat it\. But the dialog could not be read afterwards: The dialog could not be described\.$/),
          });
          expect(await working.useScriptDialog({ action: 'set', field: 'f1', value: 'x' }, { waitMs: 1000 })).toMatchObject({ kind: 'none', why: 'not_answering', notes: ['Your action (set f1) was carried out. Do not repeat it.'] });
          cli.userScript = () => undefined;
        });

        it('says after an action only what is different in the dialog it last showed', async () => {
          let fields: Array<Record<string, unknown>> = [
            { id: 'f1', type: 'Edit', value: 'initial', at: [8, 8, 100, 20] },
            { id: 'f2', type: 'PushButton', text: 'OK', at: [8, 40, 60, 20] },
            { id: 'f3', type: 'CheckBox', text: 'Solve', value: false, enabled: false, at: [8, 70, 60, 20] },
          ];
          playing(async (hook) => {
            await hook.say();
            for (;;) {
              const command = await hook.command();
              if (command['act'] === 'describe') {
                await hook.reply(command['id'], { ok: true, result: { dialog: 'd1.1', title: 'Solver', size: [200, 100], fields } });
                continue;
              }
              if (command['act'] === 'close') {
                await hook.reply(command['id'], { ok: true, result: { fired: [] } });
                return hook.say({ dialog: null, title: null });
              }
              // The first change enables a field, adds one and moves the button. The second takes the new field away again.
              fields =
                command['value'] === 'M 31'
                  ? [{ ...fields[0], value: 'M 31' }, { ...fields[1], at: [8, 60, 60, 20] }, { id: 'f3', type: 'CheckBox', text: 'Solve', value: false, at: [8, 90, 60, 20] }, { id: 'f4', type: 'Label', text: 'Found in the catalog', at: [8, 40, 100, 14] }]
                  : fields.slice(0, 3);
              await hook.reply(command['id'], { ok: true, result: { fired: [] } });
            }
          });
          const job = working.startScript({ script: 'Solver' });
          expect(await working.watchScript(job.id, look)).not.toHaveProperty('changes');
          const first = await working.useScriptDialog({ action: 'set', field: 'f1', value: 'M 31' }, look);
          // Where a field lies is not what it shows, so a button that only moved has not changed.
          expect(first).toMatchObject({
            kind: 'dialog',
            changes: {
              added: [{ id: 'f4', type: 'Label', text: 'Found in the catalog' }],
              changed: [{ id: 'f1', type: 'Edit', value: 'M 31' }, { id: 'f3', type: 'CheckBox', text: 'Solve', enabled: true }],
              gone: [],
              unchanged: 1,
            },
          });
          expect((first as { changes: { changed: unknown[] } }).changes.changed[0]).toEqual({ id: 'f1', type: 'Edit', value: 'M 31' });
          expect(await working.useScriptDialog({ action: 'set', field: 'f1', value: 'M 31 again' }, look)).toMatchObject({ changes: { added: [], changed: [], gone: ['f4'], unchanged: 3 } });
          // A look shows all of it, and is what the next action is compared with.
          expect(await working.scriptDialog(look)).not.toHaveProperty('changes');
          await working.useScriptDialog({ action: 'close' }, look);
        });

        it('does not act on a dialog that came up after the one it last read', async () => {
          let change: (() => void) | undefined;
          playing(async (hook) => {
            await hook.say();
            await describing(hook);
            await new Promise<void>((resolve) => (change = resolve));
            // The user closed the dialog, and the script shows its next one.
            await hook.say({ dialog: 'd2.1', title: 'Results' });
            await describing(hook, 'd2.1', 'Results');
            await hook.command();
            await hook.say({ dialog: null, title: null });
          });
          const job = working.startScript({ script: 'Solver' });
          await working.watchScript(job.id, look);
          change?.();
          await waitUntil(async () => (await json(join(home, 'jobs', job.id, 'dialog-state-2.json'))) !== null);
          await expect(working.useScriptDialog({ action: 'close' }, look)).rejects.toMatchObject({ kind: 'dialog_changed', message: expect.stringContaining('"Results"') });
          expect(await exists(job, 'dialog-cmd.json')).toBe(false);
          // Once it has read the new one, it can.
          expect(await working.scriptDialog(look)).toMatchObject({ kind: 'dialog', dialog: { title: 'Results' } });
          expect(kindOf(await working.useScriptDialog({ action: 'close' }, look))).toBe('done');
        });

        it('does not answer a question that took the place of the one it was shown', async () => {
          const answers: unknown[] = [];
          let next: (() => void) | undefined;
          playing(async (hook) => {
            await hook.say({ dialog: null, title: null, question: { id: 1, kind: 'message', text: 'Replace A?', buttons: ['yes', 'no'] } });
            await new Promise<void>((resolve) => (next = resolve));
            // The user answered the first one in PixInsight, and the script asks the next.
            await hook.say({ dialog: null, title: null, question: { id: 2, kind: 'message', text: 'Replace B?', buttons: ['yes', 'no'] } });
            answers.push(await hook.answerTo(2));
            await hook.say({ dialog: null, title: null });
          });
          const job = working.startScript({ script: 'Solver' });
          expect(await working.watchScript(job.id, look)).toMatchObject({ kind: 'question', question: { text: 'Replace A?' } });
          next?.();
          await waitUntil(async () => (await json(join(home, 'jobs', job.id, 'dialog-state-2.json'))) !== null);
          await expect(working.useScriptDialog({ action: 'answer', value: 'yes' }, look)).rejects.toMatchObject({ kind: 'question_changed', message: expect.stringContaining('Replace B?') });
          expect(await exists(job, 'dialog-answer-2.json')).toBe(false);
          // The refusal has shown it the new question, so now the answer is for that one.
          expect(kindOf(await working.useScriptDialog({ action: 'answer', value: 'no' }, look))).toBe('done');
          expect(answers).toEqual(['no']);
        });

        it('takes back an action that the dialog does not take in time, and says that nothing was done', async () => {
          let end: (() => void) | undefined;
          playing(async (hook) => {
            await hook.say();
            await describing(hook);
            // Busy in a handler: the dialog is there and takes nothing.
            await new Promise<void>((resolve) => (end = resolve));
          });
          const job = working.startScript({ script: 'Solver' });
          await working.watchScript(job.id, look);
          await expect(working.useScriptDialog({ action: 'press', field: 'f2' }, { waitMs: 0 })).rejects.toMatchObject({ kind: 'not_taken', message: expect.stringMatching(/press f2.*nothing was done/) });
          expect(await exists(job, 'dialog-cmd.json')).toBe(false);
          // A look says that a dialog is there and does not answer, which is not the same as none.
          expect(await working.scriptDialog({ waitMs: 0 })).toMatchObject({ kind: 'none', why: 'not_answering' });
          end?.();
        });

        it('says that the script is still at work on an action it took, and later what became of it', async () => {
          let finish: (() => void) | undefined;
          playing(async (hook) => {
            await hook.say();
            await describing(hook);
            const pressed = await hook.command();
            // The button asks before it goes on, and what it then does fails.
            await hook.say({ question: { id: 1, kind: 'message', text: 'Overwrite?', buttons: ['yes', 'no'] } });
            await hook.answerTo(1);
            await hook.say();
            await new Promise<void>((resolve) => (finish = resolve));
            await hook.reply(pressed['id'], { ok: false, error: { kind: 'script_error', message: 'The script failed while it handled this (onClick): disk full' } });
            for (;;) {
              const command = await hook.command();
              if (command['act'] !== 'describe') return hook.say({ dialog: null, title: null });
              await hook.reply(command['id'], { ok: true, result: { dialog: 'd1.1', title: 'Solver', size: [100, 50], fields: FIELDS } });
            }
          });
          const job = working.startScript({ script: 'Solver' });
          await working.watchScript(job.id, look);
          expect(kindOf(await working.useScriptDialog({ action: 'press', field: 'f2' }, look))).toBe('question');
          // The dialog is back, and the press that asked has not come to its end.
          await expect(working.useScriptDialog({ action: 'answer', value: 'yes' }, { waitMs: 0 })).resolves.toMatchObject({ kind: 'none', why: 'not_answering' });
          finish?.();
          const after = await working.scriptDialog(look);
          expect(after).toMatchObject({ kind: 'dialog', notes: [expect.stringMatching(/earlier action \(press f2\) failed.*disk full/)] });
          // Told once.
          expect((await working.scriptDialog(look)).notes).toBeUndefined();
          await working.useScriptDialog({ action: 'close' }, look);
        });

        it('says so when an action was not carried out because the dialog closed first', async () => {
          let closeIt: (() => void) | undefined;
          playing(async (hook) => {
            await hook.say();
            await describing(hook);
            await new Promise<void>((resolve) => (closeIt = resolve));
            // The user closes the dialog while the action is on its way, and the script ends.
            await hook.say({ dialog: null, title: null });
          });
          const job = working.startScript({ script: 'Solver' });
          await working.watchScript(job.id, look);
          const acting = working.useScriptDialog({ action: 'set', field: 'f1', value: 'x' }, look);
          await waitUntil(() => exists(job, 'dialog-cmd.json'));
          closeIt?.();
          expect(await acting).toMatchObject({ kind: 'done', notes: ['Your action (set f1) was not carried out, because the dialog closed first.'] });
        });

        it('says so when another dialog came up before an action was taken, and shows that dialog', async () => {
          let change: (() => void) | undefined;
          playing(async (hook) => {
            await hook.say();
            await describing(hook);
            await new Promise<void>((resolve) => (change = resolve));
            await hook.say({ dialog: 'd2.1', title: 'Another' });
            // The server takes back what it sent for the first dialog. Then the new one is looked at.
            await waitUntil(async () => (await json(join(hook.dir, 'dialog-cmd.json')))?.act === 'describe');
            for (;;) {
              const command = await hook.command();
              if (command['act'] === 'describe') await hook.reply(command['id'], { ok: true, result: { dialog: 'd2.1', title: 'Another', size: [100, 50], fields: [] } });
              else return hook.say({ dialog: null, title: null });
            }
          });
          const job = working.startScript({ script: 'Solver' });
          await working.watchScript(job.id, look);
          const acting = working.useScriptDialog({ action: 'press', field: 'f2' }, look);
          await waitUntil(() => exists(job, 'dialog-cmd.json'));
          change?.();
          const view = await acting;
          expect(view).toMatchObject({
            kind: 'dialog',
            dialog: { title: 'Another' },
            notes: ['Your action (press f2) was not carried out, because the script showed this dialog first.', expect.stringMatching(/another dialog now.*Only the field ids of this description apply/)],
          });
          // A dialog that is new comes in full.
          expect(view).not.toHaveProperty('changes');
          await working.useScriptDialog({ action: 'close' }, look);
        });

        it('reports what the script cannot describe, instead of saying that it shows nothing', async () => {
          let end: (() => void) | undefined;
          playing(async (hook) => {
            await hook.say();
            const command = await hook.command();
            await hook.reply(command['id'], { ok: false, error: { kind: 'script_error', message: 'The dialog could not be read.' } });
            await new Promise<void>((resolve) => (end = resolve));
          });
          const job = working.startScript({ script: 'Solver' });
          await expect(working.watchScript(job.id, look)).rejects.toMatchObject({ kind: 'script_error', message: 'The dialog could not be read.' });
          end?.();
        });

        it('returns the dialog without a picture, and says why, if none could be taken', async () => {
          playing(async (hook) => {
            await hook.say();
            for (;;) {
              const command = await hook.command();
              if (command['act'] === 'describe') await hook.reply(command['id'], { ok: true, result: { dialog: 'd1.1', title: 'Solver', size: [100, 50], fields: FIELDS } });
              else if (command['act'] === 'render') await hook.reply(command['id'], { ok: false, error: { kind: 'dialog_changed', message: 'The script shows something else now.' } });
              else return hook.say({ dialog: null, title: null });
            }
          });
          const job = working.startScript({ script: 'Solver' });
          const shown = await working.watchScript(job.id, { ...look, picture: true });
          expect(shown).toMatchObject({ kind: 'dialog', notes: ['No picture: The script shows something else now.'] });
          expect((shown as { picture?: string }).picture).toBeUndefined();
          await working.useScriptDialog({ action: 'close' }, look);
        });

        it('waits as long as a dialog needs to answer, however short the wait that was asked for', async () => {
          playing(async (hook) => {
            await hook.say();
            await sleep(300);
            await describing(hook);
            await sleep(300);
            await hook.reply((await hook.command())['id'], { ok: true, result: { fired: [] } });
            await hook.say({ dialog: null, title: null });
          });
          const job = working.startScript({ script: 'Solver' });
          // A script that was just started may be waited for as briefly as the caller likes.
          await waitUntil(async () => (await json(join(home, 'jobs', job.id, 'dialog-state-1.json'))) !== null);
          expect(kindOf(await working.scriptDialog({ waitMs: 0 }))).toBe('dialog');
          expect(kindOf(await working.useScriptDialog({ action: 'close' }, { waitMs: 0 }))).toBe('done');
        });

        it('sends nothing for a call the client has given up on', async () => {
          form();
          const job = working.startScript({ script: 'Solver' });
          await working.watchScript(job.id, look);
          const given = new AbortController();
          given.abort();
          expect(kindOf(await working.useScriptDialog({ action: 'press', field: 'f2' }, { ...look, signal: given.signal }))).toBe('none');
          expect(await exists(job, 'dialog-cmd.json')).toBe(false);
          await working.useScriptDialog({ action: 'close' }, look);
        });

        it.skipIf(process.platform === 'win32')('checks a path as the script gets it, where a backslash is part of a name and no separator', async () => {
          const existing = join(home, 'existing.xisf');
          await writeFile(existing, 'x');
          playing(async (hook) => {
            await hook.say({ dialog: null, title: null, question: { id: 1, kind: 'save_file', caption: 'Save' } });
            await hook.answerTo(1);
            await hook.say({ dialog: null, title: null });
          });
          const job = working.startScript({ script: 'Solver' });
          await working.watchScript(job.id, look);
          // Read with a slash for the backslash, this would name the existing file.
          await expect(working.useScriptDialog({ action: 'answer', value: `${home}\\existing.xisf` }, look)).rejects.toMatchObject({ kind: 'invalid_path' });
          await expect(working.useScriptDialog({ action: 'answer', value: 'C:\\out\\new.xisf' }, look)).rejects.toMatchObject({ kind: 'invalid_path' });
          await expect(working.useScriptDialog({ action: 'answer', value: existing }, look)).rejects.toMatchObject({ kind: 'file_exists' });
          expect(await exists(job, 'dialog-answer-1.json')).toBe(false);
          await working.useScriptDialog({ action: 'close' }, look);
        });
      });

      it.skipIf(process.platform === 'win32')('does not start a script whose path PixInsight would read as another one', async () => {
        await feature(shipped, 'Back\\slash.js', 'Backslash : Utilities > Backslash');
        const fresh = await Session.create(config({ scriptDialogs: 'operate' }), cli);
        expect((await start({ script: 'Backslash' }, fresh)).error).toMatchObject({ kind: 'blocked_script' });
        await fresh.close();
      });

      it('knows which job has a dialog that can be looked at', async () => {
        form();
        const job = working.startScript({ script: 'Solver' });
        expect(working.dialogAccessOf(job.id)).toBe('operate');
        expect(working.dialogAccessOf('another')).toBe('off');
        await working.watchScript(job.id, look);
        await working.useScriptDialog({ action: 'close' }, look);
        let close: (() => void) | undefined;
        cli.userScript = () => new Promise<void>((resolve) => (close = resolve));
        const plain = working.startScript({ script: 'Solver', plain: true });
        expect(working.dialogAccessOf(plain.id)).toBe('off');
        await waitUntil(() => close !== undefined);
        close?.();
        await working.jobs.wait(plain.id, 2000);
      });

      it('only reads if the user has set it so: the script is told, and nothing can be done', async () => {
        const reading = await Session.create(config({ scriptDialogs: 'read' }), cli);
        const done = await start({ script: 'Solver' }, reading);
        expect(await readFile(join(home, 'jobs', done.id, 'start.js'), 'utf8')).toContain(', false, false );\n#include');
        // And the server sends nothing to a dialog, whoever asks.
        const taken: Array<Record<string, any>> = [];
        form(taken);
        const job = reading.startScript({ script: 'Solver' });
        expect(kindOf(await reading.watchScript(job.id, look))).toBe('dialog');
        await expect(reading.useScriptDialog({ action: 'close' }, look)).rejects.toMatchObject({ kind: 'read_only' });
        expect(taken.map((command) => command['act'])).toEqual(['describe']);
        // The user closes the dialog.
        await writeFile(join(home, 'jobs', job.id, 'dialog-cmd.json'), JSON.stringify({ act: 'close', dialog: 'd1.1', id: 99 }));
        await reading.jobs.wait(job.id, 2000);
        await reading.close();
      });
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
