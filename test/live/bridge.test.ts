import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { blockReason, parameterRefusal } from '../../src/policy.js';
import { Refusal } from '../../src/session.js';
import { EXECUTABLE, jpegSize, run, SHADOW_SLOT, startLiveSession, type LiveSession } from './harness.js';

/** A real image with an astrometric solution and extra images, such as a WBPP master. Optional. */
const SOLVED_IMAGE = process.env['PIXINSIGHT_TEST_SOLVED_IMAGE'];

/**
 * Pins down the PixInsight behaviour this server relies on, against a real, windowless instance.
 * Run these after every PixInsight update.
 *
 * The test image is deliberately not square: a square one hid distorted previews until the
 * first real run.
 */
describe.skipIf(!existsSync(EXECUTABLE))('against a real PixInsight', { timeout: 120_000 }, () => {
  let live: LiveSession;
  const VIEW = 'mcp_live';
  const WIDTH = 800;
  const HEIGHT = 400;

  type Stats = { channels: Array<{ median: number; mean: number; fractionBelowLow?: number; fractionAboveHigh?: number }> };
  type Image = {
    view: string;
    active: boolean;
    modified: boolean;
    unsaved: boolean;
    filePath: string;
    sourcePath?: string;
    previews: string[];
    astrometry: boolean;
    mask?: { view: string; enabled: boolean; inverted: boolean };
  };

  const refusal = async (promise: Promise<unknown>): Promise<Refusal> => {
    const outcome = await promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    if (!('error' in outcome)) throw new Error(`Expected a refusal, got ${JSON.stringify(outcome.value)}`);
    expect(outcome.error).toBeInstanceOf(Refusal);
    return outcome.error as Refusal;
  };

  const runProcess = (request: Parameters<LiveSession['session']['runProcess']>[0]) =>
    live.session.jobs.wait(live.session.runProcess(request).id, 60_000);

  const failing = (op: string, args: unknown) => live.session.jobs.wait(live.session.jobs.submit(op, args).id, 15_000);

  /** For a state no tool can produce, such as a mask the user has set up in PixInsight. */
  const inPixInsight = <T>(code: string) => run<T>(live.session, 'test_eval', { code });

  const newImage = async (id: string, value = 0.1, width = WIDTH, height = HEIGHT, channels = 3) => {
    const created = await runProcess({
      processId: 'NewImage',
      global: true,
      params: { id, width, height, numberOfChannels: channels, colorSpace: channels === 1 ? 'Grayscale' : 'RGB', v0: value, v1: value, v2: value },
    });
    expect(created.state).toBe('succeeded');
  };

  const pixelMath = (expression: string) => ({ expression, useSingleExpression: true, createNewImage: false });

  const close = (view: string) => run(live.session, 'close_image', { view, discardChanges: true });

  const stats = (view = VIEW, extra: object = {}) => run<Stats>(live.session, 'image_stats', { view, ...extra });

  const median = async (view = VIEW) => (await stats(view)).channels[0]!.median;

  const images = () => run<Image[]>(live.session, 'list_images');

  beforeAll(async () => {
    live = await startLiveSession({}, { test_eval: 'return ( 0, eval )( args.code );' });
    await newImage(VIEW);
  }, 120_000);

  afterAll(async () => {
    await live?.cleanup();
  });

  describe('runner', () => {
    it('reports the PixInsight version', async () => {
      const ping = await run<{ version: string; automationMode: boolean; processes: number }>(live.session, 'ping');
      expect(ping.automationMode).toBe(true);
      expect(ping.processes).toBeGreaterThan(50);
    });

    it('turns a missing operation into a structured failure instead of silence', async () => {
      expect(await failing('no_such_op', {})).toMatchObject({ state: 'failed', error: { kind: 'script_error' } });
    });

    it('runs only the operations the server came with, not one that was put into its folder later', async () => {
      await writeFile(join(live.session.paths.opsDir, 'smuggled.js'), 'new ImageWindow( 8, 8, 1, 32, true, false, "mcp_smuggled" ).show(); return true;');
      await writeFile(join(live.session.paths.opsDir, 'ping.js'), 'new ImageWindow( 8, 8, 1, 32, true, false, "mcp_smuggled" ).show(); return {};');
      expect(await failing('smuggled', {})).toMatchObject({ state: 'failed', error: { kind: 'script_error' } });
      // The operation that was changed is the real one again.
      expect((await run<{ processes: number }>(live.session, 'ping')).processes).toBeGreaterThan(50);
      expect((await images()).map((image) => image.view)).not.toContain('mcp_smuggled');
    });

    describe('a job the server no longer waits for', () => {
      const send = async (name: string, awaited: string | null) => {
        const dir = join(live.config.home, 'jobs', name);
        await mkdir(dir, { recursive: true });
        // Something that would be seen if it ran.
        await writeFile(join(dir, 'job.json'), JSON.stringify({ op: 'test_eval', args: { code: `new ImageWindow( 8, 8, 1, 32, true, false, "mcp_must_not_exist" ); true` }, opsDir: live.session.paths.opsDir }));
        if (awaited !== null) await writeFile(join(dir, 'awaited'), awaited);
        await live.session.cli.execute(live.config.workerSlot, live.session.paths.runnerPath, [dir]);
        // A job of the usual kind behind it: when that is done, the one above has had its turn.
        await run(live.session, 'ping');
        return { dir, result: JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')) as { ok: boolean; error?: { kind: string } } };
      };

      it.each([
        ['that it has withdrawn', '0'],
        ['whose server stopped saying that it waits', String(Date.now() - 60_000)],
        ['without any sign of a server', null],
      ])('is not run: one %s', async (name, awaited) => {
        const { dir, result } = await send(`stale-${name.length}`, awaited);
        expect(result).toMatchObject({ ok: false, error: { kind: 'withdrawn' } });
        // It marks its start before it looks, so that the server can tell for sure what it did.
        expect(existsSync(join(dir, 'started.json'))).toBe(true);
        expect((await images()).map((image) => image.view)).not.toContain('mcp_must_not_exist');
      });

      it('runs while the server says that it waits', async () => {
        const { result } = await send('fresh', String(Date.now()));
        expect(result.ok).toBe(true);
        await close('mcp_must_not_exist');
      });
    });

    it('handles many jobs in a row', async () => {
      const jobs = Array.from({ length: 5 }, () => live.session.jobs.submit('ping', {}));
      const results = await Promise.all(jobs.map((job) => live.session.jobs.wait(job.id, 30_000)));
      expect(results.map((result) => result.state)).toEqual(Array(5).fill('succeeded'));
    });

    it('saves after a process that was sent first, however long its check takes', async () => {
      await newImage('mcp_order');
      const path = join(live.config.home, 'order.xisf');
      // A constant that has not been checked yet, which takes much longer than a save.
      live.session.runProcess({ processId: 'PixelMath', view: 'mcp_order', params: { ...pixelMath('0.77'), newImageColorSpace: 'RGB' } });
      const saved = live.session.jobs.submit('save_image', { view: 'mcp_order', path });
      expect((await live.session.jobs.wait(saved.id, 60_000)).state).toBe('succeeded');
      await close('mcp_order');
      await run(live.session, 'open_image', { path, id: 'mcp_order_back' });
      expect(await median('mcp_order_back')).toBeCloseTo(0.77, 5);
      await close('mcp_order_back');
    });
  });

  describe('introspection', () => {
    it('lists installed processes without hand-written tables', async () => {
      const processes = await run<Array<{ id: string; parameters: number }>>(live.session, 'list_processes');
      const ids = processes.map((process) => process.id);
      expect(ids).toContain('PixelMath');
      expect(ids).toContain('ImageIntegration');
      expect(processes.length).toBeGreaterThan(50);
    });

    it('describes types, enumerations and table columns', async () => {
      const info = await live.session.describe('StarAlignment');
      const parameter = (id: string) => info.parameters.find((candidate) => candidate.id === id);
      expect(parameter('mode')).toMatchObject({ type: 'int', enum: true, default: 'RegisterMatch' });
      expect(parameter('structureLayers')?.enum).toBeUndefined();
      expect(parameter('outputData')?.readOnly).toBe(true);
      expect(info.constants.map((constant) => constant.name)).toContain('RegisterUnion');
      expect(info.constants.map((constant) => constant.name)).not.toContain('targets_image');
    });

    it('lists table columns in their real order, not alphabetically', async () => {
      const histogram = await live.session.describe('HistogramTransformation');
      expect(histogram.parameters.find((parameter) => parameter.id === 'H')?.columns).toEqual(['c0', 'm', 'c1', 'r0', 'r1']);
      const alignment = await live.session.describe('StarAlignment');
      expect(alignment.parameters.find((parameter) => parameter.id === 'targets')?.columns).toEqual(['enabled', 'isFile', 'image']);
    });

    it('gates every parameter of the installed processes that runs programs, replaces files or picks a server', async () => {
      type Found = { process: string; id: string; value: unknown; categories: string };
      const found = await inPixInsight<Found[]>(`
        const out = [];
        for ( const process of MetaObject.externalObjects ) {
           const P = new globalThis[process];
           for ( const p of MetaObject.objectById( process ).properties )
              if ( !p.readOnly ) { const v = P[p.id]; out.push( { process, id: p.id, value: (typeof v == "string" || typeof v == "boolean") ? v : null, categories: P.processCategory() } ); }
        }
        out`);
      // Words of a name such as serverURL or overwriteExistingFiles.
      const words = (id: string) => id.split(/(?<=[a-z])(?=[A-Z])|_/).map((word) => word.toLowerCase());
      const risky = ['exe', 'executable', 'command', 'script', 'program', 'app', 'url', 'server', 'host', 'overwrite'];
      const candidates = found.filter(({ process, id, categories }) => !blockReason(process, categories.split(',').map((each) => each.trim())) && words(id).some((word) => risky.includes(word)));
      expect(candidates.length).toBeGreaterThan(15);

      const strict = { allowedPrograms: [], allowOverwrite: false };
      const open = candidates.filter(({ process, id, value }) => {
        const changed = typeof value === 'boolean' ? true : 'something else';
        return parameterRefusal(process, [{ id, default: value }], { [id]: changed }, strict) === null;
      });
      // A new name here means: decide whether an assistant may set it, and teach src/policy.ts.
      expect(open.map(({ process, id }) => `${process}.${id}`)).toEqual([]);
    });

    it('refuses an unknown process', async () => {
      expect((await refusal(live.session.describe('NoSuchProcess'))).kind).toBe('unknown_process');
    });
  });

  describe('run_process guards', () => {
    const target = { processId: 'PixelMath', view: VIEW };

    it('refuses an unknown parameter, which PixInsight would silently ignore', async () => {
      expect((await runProcess({ ...target, params: { expresion: '0.5' } })).error?.kind).toBe('unknown_parameter');
    });

    it('refuses a read-only parameter', async () => {
      expect((await runProcess({ processId: 'StarAlignment', global: true, params: { outputData: [] } })).error?.kind).toBe('read_only_parameter');
    });

    it('refuses a number for an enumeration, which could hang PixInsight', async () => {
      expect((await runProcess({ processId: 'StarAlignment', global: true, params: { mode: 9999 } })).error?.kind).toBe('invalid_enum');
    });

    it('refuses a constant the process does not have', async () => {
      expect((await runProcess({ processId: 'StarAlignment', global: true, params: { mode: 'Nonsense' } })).error?.kind).toBe('invalid_enum');
    });

    it('refuses blocked processes', async () => {
      expect((await runProcess({ processId: 'Preferences', global: true })).error?.kind).toBe('blocked_process');
    });

    it('refuses to change the default RGB working space, but not that of an image', async () => {
      expect((await runProcess({ processId: 'RGBWorkingSpace', global: true })).error?.kind).toBe('blocked_process');
      expect((await runProcess({ processId: 'RGBWorkingSpace', view: VIEW })).state).toBe('succeeded');
      await run(live.session, 'undo', { view: VIEW });
    });

    it('refuses to replace files, also for a process that does so by default', async () => {
      expect((await runProcess({ processId: 'StarAlignment', global: true, params: { overwriteExistingFiles: true } })).error?.kind).toBe('blocked_parameter');
      expect((await runProcess({ processId: 'CometAlignment', global: true })).error?.kind).toBe('blocked_parameter');
    });

    it('requires exactly one target', async () => {
      expect((await runProcess({ processId: 'PixelMath' })).error?.kind).toBe('invalid_target');
      expect((await runProcess({ ...target, global: true })).error?.kind).toBe('invalid_target');
    });

    it('passes on the range error of PixInsight', async () => {
      const done = await runProcess({ processId: 'TGVDenoise', view: VIEW, params: { maxIterationsL: 99999 } });
      expect(done.state).toBe('failed');
      expect(done.error?.kind).toBe('invalid_parameter_value');
      expect(done.error?.message).toMatch(/out of range/);
    });

    it('passes on the type error of PixInsight', async () => {
      const done = await runProcess({ ...target, params: { useSingleExpression: 'banana' } });
      expect(done.error?.kind).toBe('invalid_parameter_value');
    });

    it('reports a failure that PixInsight only signals with a false return value', async () => {
      const done = await runProcess({ ...target, params: pixelMath('this_is_not_defined(') });
      expect(done.state).toBe('failed');
      expect(done.error?.kind).toBe('process_failed');
      expect(done.console?.join('\n')).toMatch(/Mismatched left parenthesis/);
    });
  });

  describe('what a process run reports', () => {
    const IMAGE = 'mcp_report';
    const value = <T>(done: { value?: unknown }) => done.value as T;

    beforeEach(() => newImage(IMAGE));

    afterEach(() => close(IMAGE));

    it('tells whether the pixels changed, with the statistics afterwards', async () => {
      const changed = await runProcess({ processId: 'PixelMath', view: IMAGE, params: pixelMath('0.3') });
      expect(value<{ pixelsChanged: boolean; stats: Stats['channels'] }>(changed)).toMatchObject({ pixelsChanged: true });
      expect(value<{ stats: Stats['channels'] }>(changed).stats[0]!.median).toBeCloseTo(0.3, 3);
    });

    it('notices a process that reports success but does nothing', async () => {
      const same = await runProcess({ processId: 'PixelMath', view: IMAGE, params: pixelMath('$T') });
      expect(same.state).toBe('succeeded');
      expect(value<{ pixelsChanged: boolean; metadataChanged?: boolean }>(same)).toMatchObject({ pixelsChanged: false });
      expect(value<{ metadataChanged?: boolean }>(same).metadataChanged).toBeUndefined();
    });

    it('tells a process that only writes metadata from one that did nothing', async () => {
      const done = await runProcess({ processId: 'FITSHeader', view: IMAGE, params: { keywords: [['OBJECT', "'M31'", '']] } });
      expect(done.value).toMatchObject({ pixelsChanged: false, metadataChanged: true });
    });

    it('returns the process log, without progress noise', async () => {
      const done = await runProcess({ processId: 'PixelMath', view: IMAGE, params: pixelMath('0.3') });
      expect(done.log?.join('\n')).toMatch(/PixelMath: Processing view: mcp_report/);
      expect(done.log?.join('\n')).not.toMatch(/swap files|MiB\/s|\*{10}/);
    });

    it('reports the values really applied, not the rounded display of the source code', async () => {
      // A background model needs an image with some variation to work on.
      await runProcess({ processId: 'PixelMath', view: IMAGE, params: pixelMath('0.1+0.05*X()') });
      const done = await runProcess({
        processId: 'AutomaticBackgroundExtractor',
        view: IMAGE,
        params: { maxBackground: 0.000597, minBackground: 0.00055, targetCorrection: 'Correction_Subtract' },
      });
      expect(done).toMatchObject({ state: 'succeeded' });
      const applied = value<{ applied: Record<string, unknown> }>(done).applied;
      expect(applied['maxBackground']).toBe(0.000597);
      expect(applied['minBackground']).toBe(0.00055);
      expect(applied['targetCorrection']).toBe('Correction_Subtract');
      for (const view of value<{ newViews: string[] }>(done).newViews) await close(view);
    });

    it('sees a mirror, which keeps all statistics the same', async () => {
      await runProcess({ processId: 'PixelMath', view: IMAGE, params: pixelMath('X()') });
      const mirrored = await runProcess({ processId: 'FastRotation', view: IMAGE, params: { mode: 'HorizontalMirror' } });
      expect(mirrored.state).toBe('succeeded');
      expect(value<{ pixelsChanged: boolean }>(mirrored).pixelsChanged).toBe(true);
    });

    it('reports the outputs a run has set, and leaves out those it has not', async () => {
      const dir = join(live.config.home, 'integration');
      await mkdir(dir);
      const paths: string[] = [];
      for (const index of [1, 2, 3]) {
        const id = `mcp_frame${index}`;
        await newImage(id, 0.2, 200, 100, 1);
        await runProcess({ processId: 'PixelMath', view: id, params: pixelMath('$T+0.05*random()') });
        const path = join(dir, `${id}.xisf`);
        await run(live.session, 'save_image', { view: id, path });
        await close(id);
        paths.push(path);
      }

      const done = await runProcess({
        processId: 'ImageIntegration',
        global: true,
        // Synthetic frames have no stars, so the default weighting by PSF signal has nothing to go by.
        params: { images: paths.map((path) => [true, path, '', '']), weightMode: 'DontCare', rejection: 'NoRejection', generateRejectionMaps: false },
      });
      expect(done.state).toBe('succeeded');
      const { outputs, newViews } = value<{ outputs: Record<string, unknown>; newViews: string[] }>(done);
      expect(Object.keys(outputs).length).toBeGreaterThan(0);
      expect(Object.keys(outputs).length).toBeLessThan(60);
      expect(Object.values(outputs)).not.toContain(0);
      for (const view of newViews) await close(view);
    });

    it('says which mask was in effect, if the image had one that the caller did not ask for', async () => {
      await newImage('mcp_report_mask', 1, WIDTH, HEIGHT, 1);
      await inPixInsight(`ImageWindow.windowById( "${IMAGE}" ).mask = ImageWindow.windowById( "mcp_report_mask" ); true`);
      const done = await runProcess({ processId: 'PixelMath', view: IMAGE, params: pixelMath('0.6') });
      expect(value<{ activeMask: object }>(done).activeMask).toEqual({ view: 'mcp_report_mask', inverted: false });
      await inPixInsight(`ImageWindow.windowById( "${IMAGE}" ).removeMask(); true`);
      const plain = await runProcess({ processId: 'PixelMath', view: IMAGE, params: pixelMath('0.7') });
      expect(value<{ activeMask?: object }>(plain).activeMask).toBeUndefined();
      await close('mcp_report_mask');
    });

    it('names the images a failed process left behind', async () => {
      const before = (await images()).length;
      // A model image is made first, and then the correction fails on a nonsense expression.
      const done = await runProcess({ processId: 'PixelMath', view: IMAGE, params: { expression: 'nope(', useSingleExpression: true, createNewImage: true, newImageId: 'mcp_left' } });
      expect(done.state).toBe('failed');
      const left = (await images()).map((image) => image.view).filter((view) => view.startsWith('mcp_left'));
      if (left.length) {
        expect(done.error?.message).toMatch(/left new images behind: .*mcp_left/);
        await run(live.session, 'close_image', { view: left, discardChanges: left });
      } else {
        expect((await images()).length).toBe(before);
        expect(done.error?.message).not.toMatch(/left new images behind/);
      }
    });

    it('reports the state of the history, by which undo can tell its own step from a later one', async () => {
      const mine = value<{ historyIndex: number }>(await runProcess({ processId: 'PixelMath', view: IMAGE, params: pixelMath('0.3') }));
      expect(mine.historyIndex).toBe(1);
      // As if the user had added a step in PixInsight in the meantime.
      await inPixInsight(`const P = new PixelMath; P.expression = "0.9"; P.useSingleExpression = true; P.createNewImage = false; P.executeOn( View.viewById( "${IMAGE}" ) )`);
      expect((await failing('undo', { view: IMAGE, historyIndex: mine.historyIndex })).error?.kind).toBe('history_changed');
      expect(await median(IMAGE)).toBeCloseTo(0.9, 3);
      expect(await run(live.session, 'undo', { view: IMAGE, historyIndex: 2 })).toMatchObject({ historyIndex: 1 });
      expect(await median(IMAGE)).toBeCloseTo(0.3, 3);
    });

    describe('a change of geometry, which PixInsight would ask about', () => {
      const crop = { processId: 'Crop', params: { mode: 'AbsolutePixels', leftMargin: -50 } };

      it('goes ahead without the question, and says what it cost', async () => {
        await newImage('mcp_geo_mask', 1, WIDTH, HEIGHT, 1);
        await run(live.session, 'create_preview', { view: IMAGE, rect: { x0: 10, y0: 10, x1: 110, y1: 110 } });
        await inPixInsight(`ImageWindow.windowById( "${IMAGE}" ).mask = ImageWindow.windowById( "mcp_geo_mask" ); true`);

        const done = await runProcess({ ...crop, view: IMAGE });
        expect(done.state).toBe('succeeded');
        expect(done.value).toMatchObject({ pixelsChanged: true, previewsRemoved: 1, maskRemoved: 'mcp_geo_mask' });
        expect(value<{ activeMask?: object }>(done).activeMask).toBeUndefined();
        const cropped = (await images()).find((image) => image.view === IMAGE)!;
        expect(cropped).toMatchObject({ width: WIDTH - 50, previews: [] });

        // Undo brings back what the image itself had.
        await run(live.session, 'undo', { view: IMAGE });
        expect((await images()).find((image) => image.view === IMAGE)).toMatchObject({ width: WIDTH, previews: [expect.any(String)] });
        await inPixInsight(`ImageWindow.windowById( "${IMAGE}" ).removeMask(); true`);
        await close('mcp_geo_mask');
      });

      it('is refused on an image that others use as their mask, because undo does not bring that back', async () => {
        await newImage('mcp_geo_masked');
        await newImage('mcp_geo_as_mask', 1, WIDTH, HEIGHT, 1);
        await inPixInsight(`ImageWindow.windowById( "mcp_geo_masked" ).mask = ImageWindow.windowById( "mcp_geo_as_mask" ); true`);
        const done = await runProcess({ ...crop, view: 'mcp_geo_as_mask' });
        expect(done.error).toMatchObject({ kind: 'mask_in_use', message: expect.stringContaining('mcp_geo_masked') });
        expect((await images()).find((image) => image.view === 'mcp_geo_masked')?.mask?.view).toBe('mcp_geo_as_mask');
        await inPixInsight(`ImageWindow.windowById( "mcp_geo_masked" ).removeMask(); true`);
        await close('mcp_geo_masked');
        await close('mcp_geo_as_mask');
      });

      it('does not silence questions of processes it was not measured on', async () => {
        const described = await live.session.describe('Debayer');
        expect(described.parameters.find((parameter) => parameter.id === 'noGUIMessages')?.default).toBe(true);
        for (const id of ['Crop', 'DynamicCrop', 'FastRotation', 'Rotation', 'Resample', 'IntegerResample']) {
          expect((await live.session.describe(id)).parameters.find((parameter) => parameter.id === 'noGUIMessages')?.default, id).toBe(false);
        }
      });
    });

    it('does not mistake numeric noise for a change', async () => {
      await newImage('mcp_noise', 0.05, 640, 480);
      await runProcess({ processId: 'PixelMath', view: 'mcp_noise', params: pixelMath('0.03+0.5*exp(-((X()-0.5)^2+(Y()-0.5)^2)/0.01)') });
      const same = await runProcess({ processId: 'PixelMath', view: 'mcp_noise', params: pixelMath('$T') });
      expect(value<{ pixelsChanged: boolean }>(same).pixelsChanged).toBe(false);
      const tiny = await runProcess({ processId: 'PixelMath', view: 'mcp_noise', params: pixelMath('$T*1.001') });
      expect(value<{ pixelsChanged: boolean }>(tiny).pixelsChanged).toBe(true);
      await close('mcp_noise');
    });
  });

  describe('masks', () => {
    const MASK = 'mcp_mask';
    const IMAGE = 'mcp_masked';
    const left = { x0: 0, y0: 0, x1: WIDTH / 4, y1: HEIGHT };
    const right = { x0: (3 * WIDTH) / 4, y0: 0, x1: WIDTH, y1: HEIGHT };

    const sides = async () => [
      (await stats(IMAGE, { rect: left })).channels[0]!.median,
      (await stats(IMAGE, { rect: right })).channels[0]!.median,
    ];

    beforeAll(async () => {
      await newImage(MASK, 0, WIDTH, HEIGHT, 1);
      const done = await runProcess({ processId: 'PixelMath', view: MASK, params: pixelMath('iif(X()<0.5,0,1)') });
      expect(done.state).toBe('succeeded');
    }, 60_000);

    afterAll(async () => {
      await close(MASK);
    });

    beforeEach(() => newImage(IMAGE));

    afterEach(() => close(IMAGE));

    it('applies a process through a mask', async () => {
      const done = await runProcess({ processId: 'PixelMath', view: IMAGE, params: pixelMath('0.9'), mask: { view: MASK } });
      expect(done.state).toBe('succeeded');
      const [dark, bright] = await sides();
      expect(dark).toBeCloseTo(0.1, 3);
      expect(bright).toBeCloseTo(0.9, 3);
    });

    it('can invert the mask', async () => {
      await runProcess({ processId: 'PixelMath', view: IMAGE, params: pixelMath('0.9'), mask: { view: MASK, inverted: true } });
      const [dark, bright] = await sides();
      expect(dark).toBeCloseTo(0.9, 3);
      expect(bright).toBeCloseTo(0.1, 3);
    });

    it('removes the mask again, also after an undo, which would bring it back by itself', async () => {
      await runProcess({ processId: 'PixelMath', view: IMAGE, params: pixelMath('0.9'), mask: { view: MASK } });
      await run(live.session, 'undo', { view: IMAGE });
      await runProcess({ processId: 'PixelMath', view: IMAGE, params: pixelMath('0.7') });
      const [dark, bright] = await sides();
      expect(dark).toBeCloseTo(0.7, 3);
      expect(bright).toBeCloseTo(0.7, 3);
    });

    it('refuses a mask of the wrong size, and a mask on a global run', async () => {
      await newImage('mcp_small_mask', 0, 16, 16, 1);
      const done = await runProcess({ processId: 'Invert', view: IMAGE, mask: { view: 'mcp_small_mask' } });
      expect(done.error?.kind).toBe('invalid_mask');
      await close('mcp_small_mask');
      expect((await runProcess({ processId: 'NewImage', global: true, mask: { view: MASK } })).error?.kind).toBe('invalid_target');
    });

    describe('that the user has set up', () => {
      const setMask = (image: string, mask: string) =>
        inPixInsight(`ImageWindow.windowById( "${image}" ).mask = ImageWindow.windowById( "${mask}" ); true`);
      const maskOf = (image: string) =>
        inPixInsight<string>(`const w = ImageWindow.windowById( "${image}" ); w.mask.isNull ? "none" : w.mask.mainView.id`);

      it('stays in place through a process with a mask of its own, and through undo', async () => {
        await newImage('mcp_own_mask', 0.5, WIDTH, HEIGHT, 1);
        await setMask(IMAGE, 'mcp_own_mask');
        expect((await images()).find((image) => image.view === IMAGE)?.mask).toEqual({ view: 'mcp_own_mask', enabled: true, inverted: false });
        await runProcess({ processId: 'PixelMath', view: IMAGE, params: pixelMath('0.9'), mask: { view: MASK } });
        expect(await maskOf(IMAGE)).toBe('mcp_own_mask');
        await run(live.session, 'undo', { view: IMAGE });
        expect(await maskOf(IMAGE)).toBe('mcp_own_mask');
        await inPixInsight(`ImageWindow.windowById( "${IMAGE}" ).removeMask(); true`);
        await close('mcp_own_mask');
      });

      it('undoes a crop once and warns, if the mask no longer fits the old size', async () => {
        await newImage('mcp_crop', 0.2, 64, 32, 1);
        await runProcess({ processId: 'Crop', view: 'mcp_crop', params: { mode: 'AbsolutePixels', leftMargin: -10, rightMargin: -10 } });
        await newImage('mcp_crop_mask', 0.5, 44, 32, 1);
        await setMask('mcp_crop', 'mcp_crop_mask');

        const undone = await run<{ historyIndex: number; warning?: string }>(live.session, 'undo', { view: 'mcp_crop' });
        expect(undone.warning).toMatch(/mcp_crop_mask no longer fits/);
        expect(undone.historyIndex).toBe(0);
        expect(await maskOf('mcp_crop')).toBe('none');
        expect((await stats('mcp_crop')).channels).toHaveLength(1);

        await close('mcp_crop');
        await close('mcp_crop_mask');
      });

      it('reports closing an image that another one uses as its mask', async () => {
        await newImage('mcp_used_mask', 0.5, WIDTH, HEIGHT, 1);
        await setMask(IMAGE, 'mcp_used_mask');
        expect(await close('mcp_used_mask')).toEqual({ closed: ['mcp_used_mask'], discarded: ['mcp_used_mask'], removedAsMaskFrom: [IMAGE] });
        expect(await maskOf(IMAGE)).toBe('none');
      });
    });
  });

  describe('previews', () => {
    const rect = { x0: 100, y0: 50, x1: 300, y1: 150 };

    it('lets a process run on a part of the image, with its own history', async () => {
      const created = await run<{ view: string; width: number; height: number }>(live.session, 'create_preview', { view: VIEW, rect, id: 'mcp_try' });
      expect(created).toMatchObject({ view: `${VIEW}->mcp_try`, width: 200, height: 100 });
      expect((await images()).find((image) => image.view === VIEW)?.previews).toEqual([created.view]);

      const before = await median();
      const done = await runProcess({ processId: 'PixelMath', view: created.view, params: pixelMath('0.8') });
      expect(done.state).toBe('succeeded');
      expect(await median(created.view)).toBeCloseTo(0.8, 3);
      expect(await median()).toBe(before);

      expect(await run(live.session, 'undo', { view: created.view })).toMatchObject({ canRedo: true });
      expect(await median(created.view)).toBeCloseTo(before, 3);
      await run(live.session, 'redo', { view: created.view });
      expect(await median(created.view)).toBeCloseTo(0.8, 3);

      expect(await run(live.session, 'delete_preview', { view: created.view })).toEqual({ deleted: created.view });
      expect((await images()).find((image) => image.view === VIEW)?.previews).toEqual([]);
      expect(await median()).toBe(before);
    });

    it('starts each run from the main image, so steps do not add up', async () => {
      await newImage('mcp_steps', 0.4);
      const { view } = await run<{ view: string }>(live.session, 'create_preview', { view: 'mcp_steps', rect });
      for (const _ of [1, 2]) {
        const halved = await runProcess({ processId: 'PixelMath', view, params: pixelMath('$T*0.5') });
        expect(halved.value).toMatchObject({ pixelsChanged: true, startedFromMainImage: true });
        expect(await median(view)).toBeCloseTo(0.2, 3);
      }
      const other = await runProcess({ processId: 'PixelMath', view, params: pixelMath('$T+0.1') });
      expect(other.value).toMatchObject({ pixelsChanged: true });
      expect(await median(view)).toBeCloseTo(0.5, 3);

      // Compared with the main image, so an unchanged result counts as unchanged, whatever ran before.
      const same = await runProcess({ processId: 'PixelMath', view, params: pixelMath('$T') });
      expect(same.value).toMatchObject({ pixelsChanged: false, startedFromMainImage: true });
      expect(await median('mcp_steps')).toBeCloseTo(0.4, 3);
      await close('mcp_steps');
    });

    it('refuses to delete a main view as a preview', async () => {
      expect((await failing('delete_preview', { view: VIEW })).error?.kind).toBe('not_a_preview');
    });
  });

  describe('statistics', () => {
    const GRADIENT = 'mcp_gradient';

    beforeAll(async () => {
      await newImage(GRADIENT, 0, WIDTH, HEIGHT, 1);
      await runProcess({ processId: 'PixelMath', view: GRADIENT, params: pixelMath('0.1+0.5*X()') });
    }, 60_000);

    afterAll(async () => {
      await close(GRADIENT);
    });

    it('names no control at a place inside a table or a text box, which is why a dialog is not read by places alone', async () => {
      const found = await inPixInsight<string[]>(`
        var dialog = new Dialog;
        var label = new Label( dialog );
        label.text = "A label";
        var table = new TreeBox( dialog );
        table.numberOfColumns = 1;
        table.setScaledMinSize( 240, 120 );
        ( new TreeBoxNode( table ) ).setText( 0, "A row" );
        var text = new TextBox( dialog );
        text.text = "A text";
        text.setScaledMinSize( 240, 80 );
        dialog.sizer = new Sizer( true );
        dialog.sizer.add( label );
        dialog.sizer.add( table );
        dialog.sizer.add( text );
        dialog.show();
        processEvents();
        var origin = dialog.localToGlobal( new Point( 0, 0 ) );
        var at = function( control )
        {
           var corner = control.localToGlobal( new Point( 0, 0 ) );
           var hit = dialog.childByPos( corner.x - origin.x + ( control.width >> 1 ), corner.y - origin.y + ( control.height >> 1 ) );
           return hit === control ? "itself" : hit == null ? "nothing" : "another";
        };
        var result = [ at( label ), at( table ), at( text ) ];
        dialog.hide();
        result`);
      expect(found).toEqual(['itself', 'nothing', 'nothing']);
    });

    it('reads what a file says about how it was taken, as the file holds it', async () => {
      type Metadata = {
        view: string;
        keywords: Array<{ name: string; value: string | number | boolean; comment?: string }>;
        properties: Array<{ id: string; value: string | number | boolean }>;
        textLines?: number;
        otherProperties?: number;
      };
      const dir = await mkdtemp(join(tmpdir(), 'mcp-live-metadata-'));
      const path = join(dir, 'frame.xisf');
      try {
        await newImage('mcp_meta', 0.1, 48, 32, 1);
        await inPixInsight(`
          var window = ImageWindow.windowById( "mcp_meta" );
          window.keywords = [
             new FITSKeyword( "FILTER", "'Ha'", "Filter name" ),
             new FITSKeyword( "INSTRUME", "'A camera with a long name'", "" ),
             new FITSKeyword( "GAIN", "100", "Sensor gain" ),
             new FITSKeyword( "OFFSET", "400", "" ),
             new FITSKeyword( "EXPTIME", "300.5", "[s] Exposure" ),
             new FITSKeyword( "COOLED", "T", "" ),
             new FITSKeyword( "GUIDED", "F", "" ),
             new FITSKeyword( "SLOT", "'7'", "A text that looks like a number" ),
             new FITSKeyword( "HISTORY", "", "Calibrated by a test" ),
             new FITSKeyword( "COMMENT", "", "A line of text" )
          ];
          window.mainView.setPropertyValue( "Instrument:Telescope:FocalLength", 0.75, PropertyType.Float64, PropertyAttribute.Storable | PropertyAttribute.Permanent );
          window.mainView.setPropertyValue( "Instrument:Filter:Name", "Ha", PropertyType.String, PropertyAttribute.Storable | PropertyAttribute.Permanent );
          window.mainView.setPropertyValue( "MCP:Table", new Vector( [ 1, 2, 3 ] ), PropertyType.F64Vector, PropertyAttribute.Storable | PropertyAttribute.Permanent );
          true`);
        // Through a file, so that this is what PixInsight stores and reads back, not what the test put there.
        await run(live.session, 'save_image', { view: 'mcp_meta', path });
        await close('mcp_meta');
        await run(live.session, 'open_image', { path, id: 'mcp_meta_back' });

        const all = await run<Metadata>(live.session, 'image_metadata', { view: 'mcp_meta_back' });
        const keyword = (name: string) => all.keywords.find((each) => each.name === name);
        // A text without its quotes, a number as a number, and a flag as true or false.
        expect(keyword('FILTER')).toEqual({ name: 'FILTER', value: 'Ha', comment: 'Filter name' });
        expect(keyword('INSTRUME')).toEqual({ name: 'INSTRUME', value: 'A camera with a long name' });
        expect(keyword('GAIN')).toEqual({ name: 'GAIN', value: 100, comment: 'Sensor gain' });
        expect(keyword('OFFSET')).toEqual({ name: 'OFFSET', value: 400 });
        expect(keyword('EXPTIME')).toMatchObject({ value: 300.5 });
        expect(keyword('COOLED')).toMatchObject({ value: true });
        expect(keyword('GUIDED')).toMatchObject({ value: false });
        // What stands in quotes is a text, whatever it looks like.
        expect(keyword('SLOT')).toEqual({ name: 'SLOT', value: '7', comment: 'A text that looks like a number' });
        // Lines of text are counted, not listed, until they are asked for.
        expect(keyword('HISTORY')).toBeUndefined();
        expect(all.textLines).toBeGreaterThanOrEqual(2);
        expect(all.properties).toEqual(expect.arrayContaining([{ id: 'Instrument:Telescope:FocalLength', value: 0.75 }, { id: 'Instrument:Filter:Name', value: 'Ha' }]));
        // What holds a table says nothing in one line.
        expect(all.properties.some((property) => property.id === 'MCP:Table')).toBe(false);
        expect(all.otherProperties).toBeGreaterThanOrEqual(1);

        const some = await run<Metadata>(live.session, 'image_metadata', { view: 'mcp_meta_back', search: 'FILT' });
        expect(some.keywords.map((each) => each.name)).toEqual(['FILTER']);
        expect(some.properties.map((property) => property.id)).toEqual(['Instrument:Filter:Name']);
        const lines = await run<Metadata>(live.session, 'image_metadata', { view: 'mcp_meta_back', search: 'history' });
        expect(lines.keywords).toEqual([{ name: 'HISTORY', value: '', comment: 'Calibrated by a test' }]);
        expect((await failing('image_metadata', { view: 'mcp_no_such_image' })).error?.kind).toBe('unknown_view');
      } finally {
        await close('mcp_meta_back').catch(() => undefined);
        await close('mcp_meta').catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('measures a region without any intermediate images', async () => {
      const windows = (await images()).length;
      const leftEdge = await stats(GRADIENT, { rect: { x0: 0, y0: 0, x1: 80, y1: HEIGHT } });
      const rightEdge = await stats(GRADIENT, { rect: { x0: WIDTH - 80, y0: 0, x1: WIDTH, y1: HEIGHT } });
      expect(leftEdge.channels[0]!.mean).toBeCloseTo(0.125, 2);
      expect(rightEdge.channels[0]!.mean).toBeCloseTo(0.575, 2);
      expect((await images()).length).toBe(windows);
    });

    it('reports the fraction of pixels beyond clipping limits', async () => {
      const result = await stats(GRADIENT, { clipping: { low: 0.2, high: 0.5 } });
      expect(result.channels[0]!.fractionBelowLow).toBeCloseTo(0.2, 2);
      expect(result.channels[0]!.fractionAboveHigh).toBeCloseTo(0.2, 2);
    });

    it('measures several regions in one call', async () => {
      const windows = (await images()).length;
      const first = { x0: 0, y0: 0, x1: 80, y1: HEIGHT };
      const second = { x0: WIDTH - 80, y0: 0, x1: WIDTH, y1: HEIGHT };
      const result = await run<{ regions: Array<{ rect: object; channels: Stats['channels'] }>; channels?: unknown }>(live.session, 'image_stats', {
        view: GRADIENT,
        rects: [first, second],
        clipping: { high: 0.5 },
      });
      expect(result.channels).toBeUndefined();
      expect(result.regions.map((region) => region.rect)).toEqual([first, second]);
      expect(result.regions[0]!.channels[0]!.mean).toBeCloseTo(0.125, 2);
      expect(result.regions[1]!.channels[0]!.mean).toBeCloseTo(0.575, 2);
      expect(result.regions[0]!.channels[0]!.fractionAboveHigh).toBe(0);
      expect(result.regions[1]!.channels[0]!.fractionAboveHigh).toBe(1);
      expect((await images()).length).toBe(windows);
    });

    it('does not count saturated pixels as low', async () => {
      await newImage('mcp_white', 1, 32, 32, 1);
      const result = await stats('mcp_white', { clipping: { low: 0.5, high: 0.5 } });
      expect(result.channels[0]!.fractionBelowLow).toBe(0);
      expect(result.channels[0]!.fractionAboveHigh).toBe(1);
      await close('mcp_white');
    });

    it('uses the normalized range for integer images too', async () => {
      const created = await runProcess({
        processId: 'NewImage',
        global: true,
        params: { id: 'mcp_int', width: 64, height: 32, sampleFormat: 'i16', v0: 0.25 },
      });
      expect(created.state).toBe('succeeded');
      const result = await stats('mcp_int', { clipping: { low: 0.5, high: 0.1 } });
      expect(result.channels[0]!.median).toBeCloseTo(0.25, 3);
      expect(result.channels[0]!.fractionBelowLow).toBe(1);
      expect(result.channels[0]!.fractionAboveHigh).toBe(1);
      await close('mcp_int');
    });

    it('refuses a region outside the image', async () => {
      expect((await failing('image_stats', { view: VIEW, rect: { x0: 5000, y0: 5000, x1: 6000, y1: 6000 } })).error?.kind).toBe('invalid_region');
    });
  });

  describe('enum guard', () => {
    it('accepts a valid constant after trying it in the shadow instance', async () => {
      const done = await runProcess({
        processId: 'PixelMath',
        view: VIEW,
        params: { ...pixelMath('$T'), newImageColorSpace: 'Gray' },
      });
      expect(done.state).toBe('succeeded');
      expect((done.value as { applied: Record<string, unknown> }).applied['newImageColorSpace']).toBe('Gray');
      await run(live.session, 'undo', { view: VIEW });
    });

    it('stops a constant of another enumeration that crashes PixInsight, and the target survives', async () => {
      const info = await live.session.describe('ACDNR');
      const wrong = info.constants.find((constant) => constant.value === 3);
      expect(wrong).toBeDefined();

      const done = await runProcess({ processId: 'ACDNR', view: VIEW, params: { prefilterMethodC: wrong!.name } });
      expect(done.error?.kind).toBe('invalid_parameter_value');
      expect((await run<{ automationMode: boolean }>(live.session, 'ping')).automationMode).toBe(true);
    });

    it('does not try a value again in the same session that has just taken the shadow instance down', async () => {
      const info = await live.session.describe('ACDNR');
      const wrong = info.constants.find((constant) => constant.value === 3)!;
      const startedAt = Date.now();
      const done = await runProcess({ processId: 'ACDNR', view: VIEW, params: { prefilterMethodC: wrong.name } });
      expect(done.error?.kind).toBe('invalid_parameter_value');
      // Trying it would take two rounds in the shadow instance, of several seconds each.
      expect(Date.now() - startedAt).toBeLessThan(3000);
      expect((await live.session.instances())?.find((instance) => instance.slot === SHADOW_SLOT && !instance.crashed)).toBeUndefined();
    });

    it('writes a clear verdict where other servers and later sessions read it', async () => {
      const cache = JSON.parse(await readFile(live.session.paths.enumChecksPath, 'utf8')) as Record<string, { safe: boolean }>;
      expect(Object.entries(cache).find(([key]) => key.endsWith(':PixelMath.newImageColorSpace=Gray'))?.[1]).toEqual({ safe: true });
    });
  });

  describe('history', () => {
    it('applies a process with undo and redo', async () => {
      const before = await median();
      const done = await runProcess({ processId: 'PixelMath', view: VIEW, params: pixelMath('0.5'), description: 'live test' });
      expect(done.state).toBe('succeeded');
      expect((done.value as { applied: Record<string, unknown> }).applied['expression']).toBe('0.5');
      expect(await median()).toBeCloseTo(0.5, 3);

      expect((await images()).find((image) => image.view === VIEW)?.modified).toBe(true);

      expect(await run<{ canRedo: boolean }>(live.session, 'undo', { view: VIEW })).toMatchObject({ canRedo: true });
      expect(await median()).toBeCloseTo(before, 3);
      await run(live.session, 'redo', { view: VIEW });
      expect(await median()).toBeCloseTo(0.5, 3);
      await run(live.session, 'undo', { view: VIEW });
    });

    it('can step back several states at once', async () => {
      const before = await median();
      await runProcess({ processId: 'PixelMath', view: VIEW, params: pixelMath('0.4') });
      await runProcess({ processId: 'PixelMath', view: VIEW, params: pixelMath('0.6') });
      await run(live.session, 'undo', { view: VIEW, count: 2 });
      expect(await median()).toBeCloseTo(before, 3);
    });

    it('fails cleanly for an unknown view', async () => {
      const done = await runProcess({ processId: 'Invert', view: 'no_such_view' });
      expect(done.error?.kind).toBe('unknown_view');
    });
  });

  describe('preview images', () => {
    type Preview = { imagePath: string; width: number; height: number; stretch: string; stf?: number[][]; crop: unknown; note?: string };

    const preview = (args: object) => run<Preview>(live.session, 'preview', { view: VIEW, ...args });

    it('keeps the aspect ratio when scaling down, in the actual file', async () => {
      const result = await preview({ maxSize: 256 });
      expect(result).toMatchObject({ width: 256, height: 128, stretch: 'auto' });
      expect(jpegSize(await readFile(result.imagePath))).toEqual({ width: 256, height: 128 });
    });

    it('keeps the aspect ratio with strong reduction and with a crop', async () => {
      const small = await preview({ maxSize: 64 });
      expect(jpegSize(await readFile(small.imagePath))).toEqual({ width: 64, height: 32 });
      const cropped = await preview({ crop: { x0: 100, y0: 100, x1: 500, y1: 300 }, maxSize: 100 });
      expect(jpegSize(await readFile(cropped.imagePath))).toEqual({ width: 100, height: 50 });
    });

    it('renders without touching the image', async () => {
      const before = await images();
      const medianBefore = await median();
      await preview({ maxSize: 256 });
      expect(await median()).toBe(medianBefore);
      expect(await images()).toEqual(before);
    });

    it('crops at full resolution', async () => {
      const result = await preview({ crop: { x0: 100, y0: 100, x1: 200, y1: 150 } });
      expect(result).toMatchObject({ width: 100, height: 50, crop: { x0: 100, y0: 100, x1: 200, y1: 150 } });
    });

    it('refuses a crop outside the image', async () => {
      expect((await failing('preview', { view: VIEW, crop: { x0: 5000, y0: 5000, x1: 6000, y1: 6000 } })).error?.kind).toBe('invalid_region');
    });

    it('returns the stretch it used, and can repeat it exactly', async () => {
      await runProcess({ processId: 'PixelMath', view: VIEW, params: pixelMath('0.1+0.05*X()') });
      const first = await preview({ maxSize: 128 });
      expect(first.stf).toHaveLength(4);
      const again = await preview({ maxSize: 128, stf: first.stf });
      expect(again.stretch).toBe('fixed');
      expect(await readFile(again.imagePath)).toEqual(await readFile(first.imagePath));
      await run(live.session, 'undo', { view: VIEW });
    });

    it('compares two images under the same stretch', async () => {
      await newImage('mcp_brighter', 0.3);
      const own = await run<Preview>(live.session, 'preview', { view: 'mcp_brighter', maxSize: 128 });
      const shared = await run<Preview>(live.session, 'preview', { view: 'mcp_brighter', maxSize: 128, stretchFrom: VIEW });
      const reference = await preview({ maxSize: 128 });
      expect(shared.stretch).toBe(`from ${VIEW}`);
      expect(shared.stf).toEqual(reference.stf);
      expect(shared.stf).not.toEqual(own.stf);
      await close('mcp_brighter');
    });

    it('can use one stretch for all channels', async () => {
      await newImage('mcp_color', 0.1);
      await runProcess({ processId: 'PixelMath', view: 'mcp_color', params: { expression: '0.1', expression1: '0.2', expression2: '0.3', useSingleExpression: false, createNewImage: false } });
      const unlinked = await run<Preview>(live.session, 'preview', { view: 'mcp_color', maxSize: 128 });
      const linked = await run<Preview>(live.session, 'preview', { view: 'mcp_color', maxSize: 128, linked: true });
      expect(linked.stretch).toBe('auto linked');
      expect(linked.stf![0]).toEqual(linked.stf![1]);
      expect(unlinked.stf![0]).not.toEqual(unlinked.stf![1]);
      await close('mcp_color');
    });

    describe('of an almost empty image, such as a star layer', () => {
      const STARS = 'mcp_stars';
      /** The brightest value in the JPEG a preview returned, measured by PixInsight itself. */
      const brightest = async (result: Preview) => {
        await run(live.session, 'open_image', { path: result.imagePath, id: 'mcp_jpeg' });
        const { channels } = await run<{ channels: Array<{ max: number }> }>(live.session, 'image_stats', { view: 'mcp_jpeg' });
        await close('mcp_jpeg');
        return Math.max(...channels.map((channel) => channel.max));
      };

      beforeAll(async () => {
        await newImage(STARS, 0, 800, 400, 1);
        // One faint "star" in 1600 pixels, on a background of exactly zero.
        await runProcess({ processId: 'PixelMath', view: STARS, params: pixelMath('iif(x()%40==20 && y()%40==20, 0.002, 0)') });
      }, 60_000);

      afterAll(async () => {
        await close(STARS);
      });

      it('shows the stars, by a stretch that follows the brightest pixels', async () => {
        const result = await run<Preview>(live.session, 'preview', { view: STARS, maxSize: 800 });
        expect(result.stretch).toBe('auto sparse');
        expect(result.note).toMatch(/follows the brightest pixels/);
        expect(result.stf?.[0]?.[0]).toBeCloseTo(0.002, 5);
        expect(await brightest(result)).toBeCloseTo(0.5, 1);

        const unstretched = await run<Preview>(live.session, 'preview', { view: STARS, maxSize: 800, stretch: 'none' });
        expect(await brightest(unstretched)).toBeLessThan(0.02);
      });

      it('leaves a star layer that is already stretched almost as it is', async () => {
        await run(live.session, 'duplicate_image', { view: STARS, id: 'mcp_stars_stretched' });
        await runProcess({ processId: 'PixelMath', view: 'mcp_stars_stretched', params: pixelMath('iif($T>0, 0.8, 0)') });
        const result = await run<Preview>(live.session, 'preview', { view: 'mcp_stars_stretched', maxSize: 800 });
        expect(result.stf?.[0]?.[0]).toBe(0.5);
        expect(await brightest(result)).toBeCloseTo(0.8, 1);
        await close('mcp_stars_stretched');
      });

      it('copes with an image that holds nothing at all', async () => {
        await newImage('mcp_empty', 0);
        const result = await run<Preview>(live.session, 'preview', { view: 'mcp_empty', maxSize: 64 });
        expect(result).toMatchObject({ stretch: 'auto sparse', width: 64, height: 32 });
        expect(await brightest(result)).toBe(0);
        await close('mcp_empty');
      });

      it('says nothing of the kind for an ordinary image', async () => {
        const result = await preview({ maxSize: 64 });
        expect(result.stretch).toBe('auto');
        expect(result.note).toBeUndefined();
      });

      it('can lend its stretch to another image', async () => {
        const result = await preview({ maxSize: 64, stretchFrom: STARS });
        expect(result.stretch).toBe(`from ${STARS}`);
        expect(result.stf?.[0]?.[0]).toBeCloseTo(0.002, 5);
      });
    });
  });

  describe('duplicates', () => {
    const KEYWORD = 'OBJECT';

    it('keeps metadata, which a PixelMath copy loses', async () => {
      await newImage('mcp_meta');
      const header = await runProcess({
        processId: 'FITSHeader',
        view: 'mcp_meta',
        params: { keywords: [[KEYWORD, "'IC 1871'", 'test']] },
      });
      expect(header.state).toBe('succeeded');

      const copy = await run<{ view: string; keywords: number; width: number; height: number }>(live.session, 'duplicate_image', { view: 'mcp_meta', id: 'mcp_meta_copy' });
      expect(copy).toMatchObject({ view: 'mcp_meta_copy', keywords: 1, width: WIDTH, height: HEIGHT });
      expect(await median('mcp_meta_copy')).toBe(await median('mcp_meta'));

      const viaPixelMath = await runProcess({
        processId: 'PixelMath',
        view: 'mcp_meta',
        params: { expression: '$T', useSingleExpression: true, createNewImage: true, newImageId: 'mcp_meta_pm' },
      });
      expect((viaPixelMath.value as { newViews: string[] }).newViews).toEqual(['mcp_meta_pm']);
      const secondCopy = await run<{ keywords: number }>(live.session, 'duplicate_image', { view: 'mcp_meta_pm' });
      expect(secondCopy.keywords).toBe(0);

      for (const view of ['mcp_meta', 'mcp_meta_copy', 'mcp_meta_pm', 'mcp_meta_pm_copy']) await close(view);
    });

    it('does not pass off a copy of processed work as safe to close', async () => {
      await newImage('mcp_dup_source');
      const path = join(live.config.home, 'dup_source.xisf');
      await run(live.session, 'save_image', { view: 'mcp_dup_source', path });
      await close('mcp_dup_source');
      await run(live.session, 'open_image', { path, id: 'mcp_dup_opened' });
      await runProcess({ processId: 'PixelMath', view: 'mcp_dup_opened', params: pixelMath('0.6') });

      await run(live.session, 'duplicate_image', { view: 'mcp_dup_opened', id: 'mcp_dup_copy' });
      const copy = (await images()).find((image) => image.view === 'mcp_dup_copy');
      expect(copy).toMatchObject({ unsaved: true });
      expect(copy?.sourcePath).toBeUndefined();
      expect((await failing('close_image', { view: 'mcp_dup_copy' })).error?.kind).toBe('unsaved_changes');

      await close('mcp_dup_copy');
      await close('mcp_dup_opened');
    });

    it('keeps the RGB working space of the image', async () => {
      await newImage('mcp_rgbws');
      await runProcess({ processId: 'RGBWorkingSpace', view: 'mcp_rgbws', params: { gamma: 1, sRGBGamma: false } });
      await run(live.session, 'duplicate_image', { view: 'mcp_rgbws', id: 'mcp_rgbws_copy' });
      expect(await inPixInsight<number>('ImageWindow.windowById( "mcp_rgbws_copy" ).rgbWorkingSpace.gamma')).toBe(1);
      await close('mcp_rgbws');
      await close('mcp_rgbws_copy');
    });

    it('does not carry the position in the sky over to a part of the image', async () => {
      await newImage('mcp_wcs');
      await runProcess({ processId: 'FITSHeader', view: 'mcp_wcs', params: { keywords: [['CRVAL1', '10.5', ''], ['CRPIX1', '400', ''], [KEYWORD, "'M31'", '']] } });
      const preview = await run<{ view: string }>(live.session, 'create_preview', { view: 'mcp_wcs', rect: { x0: 0, y0: 0, x1: 100, y1: 100 } });

      const whole = await run<{ keywords: number }>(live.session, 'duplicate_image', { view: 'mcp_wcs', id: 'mcp_wcs_whole' });
      expect(whole.keywords).toBe(3);
      const part = await run<{ keywords: number }>(live.session, 'duplicate_image', { view: preview.view, id: 'mcp_wcs_part' });
      expect(part.keywords).toBe(1);
      const exported = await run<{ keywords: number }>(live.session, 'export_image', { view: preview.view, path: join(live.config.home, 'part.xisf') });
      expect(exported.keywords).toBe(1);

      expect(await close('mcp_wcs')).toMatchObject({ closed: ['mcp_wcs'], closedPreviews: 1 });
      for (const view of ['mcp_wcs_whole', 'mcp_wcs_part']) await close(view);
    });

    it('copies a region, where steps do add up', async () => {
      await newImage('mcp_region');
      await runProcess({ processId: 'PixelMath', view: 'mcp_region', params: pixelMath('0.2+0.6*X()') });
      const rect = { x0: 100, y0: 50, x1: 300, y1: 150 };
      const copy = await run<{ view: string; width: number; height: number; astrometry: boolean }>(live.session, 'duplicate_image', { view: 'mcp_region', id: 'mcp_part', rect });
      expect(copy).toMatchObject({ view: 'mcp_part', width: 200, height: 100, astrometry: false });

      const same = async (channel: number) => {
        const whole = (await stats('mcp_region', { rect })).channels[channel]!;
        const part = (await stats('mcp_part')).channels[channel]!;
        expect(part.median).toBe(whole.median);
        expect(part.mean).toBeCloseTo(whole.mean, 6);
      };
      expect((await stats('mcp_part')).channels).toHaveLength(3);
      for (const channel of [0, 1, 2]) await same(channel);

      const start = await median('mcp_part');
      await runProcess({ processId: 'PixelMath', view: 'mcp_part', params: pixelMath('$T*0.5') });
      await runProcess({ processId: 'PixelMath', view: 'mcp_part', params: pixelMath('$T*0.5') });
      expect(await median('mcp_part')).toBeCloseTo(start * 0.25, 5);

      await close('mcp_part');
      await close('mcp_region');
    });

    it('does not keep the position in the sky for a region of an image either', async () => {
      await newImage('mcp_wcs2');
      await runProcess({ processId: 'FITSHeader', view: 'mcp_wcs2', params: { keywords: [['CRVAL1', '10.5', ''], [KEYWORD, "'M31'", '']] } });
      const part = await run<{ keywords: number }>(live.session, 'duplicate_image', { view: 'mcp_wcs2', id: 'mcp_wcs2_part', rect: { x0: 0, y0: 0, x1: 100, y1: 100 } });
      expect(part.keywords).toBe(1);
      await close('mcp_wcs2_part');
      await close('mcp_wcs2');
    });

    it('can copy a preview as a new image', async () => {
      const preview = await run<{ view: string }>(live.session, 'create_preview', { view: VIEW, rect: { x0: 0, y0: 0, x1: 300, y1: 100 } });
      const copy = await run<{ view: string; width: number; height: number; astrometry: boolean }>(live.session, 'duplicate_image', { view: preview.view, id: 'mcp_part' });
      expect(copy).toMatchObject({ width: 300, height: 100, astrometry: false });
      await close('mcp_part');
      await run(live.session, 'delete_preview', { view: preview.view });
    });
  });

  describe('files', () => {
    const file = (name: string) => join(live.config.home, name);

    it('saves working formats without dialogs, protects existing files and refuses the rest', async () => {
      await newImage('mcp_saved');
      const path = file('saved image.xisf');
      await run(live.session, 'save_image', { view: 'mcp_saved', path });
      expect(existsSync(path)).toBe(true);
      expect((await images()).find((image) => image.view === 'mcp_saved')?.filePath).toBe(path);

      expect((await failing('save_image', { view: 'mcp_saved', path })).error?.kind).toBe('file_exists');
      await runProcess({ processId: 'FITSHeader', view: 'mcp_saved', params: { keywords: [['OBJECT', "'M31'", '']] } });
      const saved = await run<{ keywords: number; astrometry: boolean }>(live.session, 'save_image', { view: 'mcp_saved', path, overwrite: true });
      expect(saved).toMatchObject({ keywords: 1, astrometry: false });

      expect((await failing('save_image', { view: 'mcp_saved', path: file('x.jpg') })).error?.kind).toBe('use_export');
      await close('mcp_saved');
    });

    it('opens a protected copy, so that Save in PixInsight cannot hit the source', async () => {
      await newImage('mcp_source');
      await runProcess({ processId: 'PixelMath', view: 'mcp_source', params: pixelMath('0.25') });
      const path = file('source.xisf');
      await run(live.session, 'save_image', { view: 'mcp_source', path });
      await close('mcp_source');

      const opened = await run<{ views: Array<{ view: string; width: number; height: number }>; protectsSource: boolean }>(live.session, 'open_image', { path, id: 'mcp_opened' });
      expect(opened.protectsSource).toBe(true);
      expect(opened.views).toEqual([expect.objectContaining({ view: 'mcp_opened', width: WIDTH, height: HEIGHT })]);
      expect(await median('mcp_opened')).toBeCloseTo(0.25, 5);

      const listed = (await images()).find((image) => image.view === 'mcp_opened')!;
      expect(listed).toMatchObject({ filePath: '', sourcePath: path, unsaved: false });

      await runProcess({ processId: 'PixelMath', view: 'mcp_opened', params: pixelMath('0.9') });
      // The image still knows its source after a process, which is what protects the file.
      expect((await images()).find((image) => image.view === 'mcp_opened')).toMatchObject({ unsaved: true, sourcePath: path });
      await close('mcp_opened');

      const original = await run<{ views: Array<{ view: string }>; protectsSource: boolean }>(live.session, 'open_image', { path, id: 'mcp_original', editOriginal: true });
      expect(original.protectsSource).toBe(false);
      expect((await images()).find((image) => image.view === 'mcp_original')?.filePath).toBe(path);
      await close('mcp_original');
    });

    it('does not store the source path in saved files', async () => {
      await newImage('mcp_chain');
      const first = file('chain.xisf');
      await run(live.session, 'save_image', { view: 'mcp_chain', path: first });
      await close('mcp_chain');
      await run(live.session, 'open_image', { path: first, id: 'mcp_chain_a' });
      const second = file('chain2.xisf');
      await run(live.session, 'save_image', { view: 'mcp_chain_a', path: second });
      expect((await images()).find((image) => image.view === 'mcp_chain_a')?.sourcePath).toBeUndefined();
      await close('mcp_chain_a');
      expect(await readFile(second)).not.toContain('MCP:SourcePath');
    });

    it('counts undone steps of a protected copy as work that closing would lose', async () => {
      await newImage('mcp_redo_source');
      const path = file('redo.xisf');
      await run(live.session, 'save_image', { view: 'mcp_redo_source', path });
      await close('mcp_redo_source');
      await run(live.session, 'open_image', { path, id: 'mcp_redo' });
      await runProcess({ processId: 'PixelMath', view: 'mcp_redo', params: pixelMath('0.4') });
      await run(live.session, 'undo', { view: 'mcp_redo' });
      expect((await images()).find((image) => image.view === 'mcp_redo')).toMatchObject({ modified: false, unsaved: true });
      expect((await failing('close_image', { view: 'mcp_redo' })).error?.kind).toBe('unsaved_changes');
      await close('mcp_redo');
    });

    it('never writes over the file an image was opened from', async () => {
      await newImage('mcp_master_source');
      const master = file('master.xisf');
      await run(live.session, 'save_image', { view: 'mcp_master_source', path: master });
      await close('mcp_master_source');
      const before = await readFile(master);

      await run(live.session, 'open_image', { path: master, id: 'mcp_master' });
      await runProcess({ processId: 'PixelMath', view: 'mcp_master', params: pixelMath('0.9') });
      for (const tool of ['save_image', 'export_image']) {
        expect((await failing(tool, { view: 'mcp_master', path: master, overwrite: true })).error?.kind, tool).toBe('protected_source');
      }
      expect(await readFile(master)).toEqual(before);
      await close('mcp_master');
    });

    it('creates the folder for a result, and wants an absolute path', async () => {
      await newImage('mcp_folder');
      const saved = await run<{ createdFolder?: string }>(live.session, 'save_image', { view: 'mcp_folder', path: file('stage 1/sub/a.xisf') });
      expect(saved.createdFolder).toBe(file('stage 1/sub'));
      expect(existsSync(file('stage 1/sub/a.xisf'))).toBe(true);
      const exported = await run<{ createdFolder?: string }>(live.session, 'export_image', { view: 'mcp_folder', path: file('stage 2/a.jpg') });
      expect(exported.createdFolder).toBe(file('stage 2'));
      const again = await run<{ createdFolder?: string }>(live.session, 'export_image', { view: 'mcp_folder', path: file('stage 2/b.jpg') });
      expect(again.createdFolder).toBeUndefined();

      for (const tool of ['save_image', 'export_image']) {
        expect((await failing(tool, { view: 'mcp_folder', path: 'relative/a.xisf' })).error?.kind, tool).toBe('invalid_path');
      }
      expect((await failing('open_image', { path: 'relative/a.xisf' })).error?.kind).toBe('invalid_path');
      await close('mcp_folder');
    });

    it('replaces a file only once the new one is written, and says which file the image belonged to before', async () => {
      await newImage('mcp_replace');
      const first = file('replaced/first.xisf');
      const second = file('replaced/second.xisf');
      await run(live.session, 'save_image', { view: 'mcp_replace', path: first });
      const moved = await run<{ previousPath?: string }>(live.session, 'save_image', { view: 'mcp_replace', path: second });
      expect(moved.previousPath).toBe(first);
      await runProcess({ processId: 'PixelMath', view: 'mcp_replace', params: pixelMath('0.6') });
      const replaced = await run<{ previousPath?: string }>(live.session, 'save_image', { view: 'mcp_replace', path: second, overwrite: true });
      expect(replaced.previousPath).toBeUndefined();
      expect((await readdir(file('replaced'))).sort()).toEqual(['first.xisf', 'second.xisf']);
      await close('mcp_replace');
      await run(live.session, 'open_image', { path: second, id: 'mcp_replaced' });
      expect(await median('mcp_replaced')).toBeCloseTo(0.6, 5);
      await close('mcp_replaced');
    });

    it('reports a missing file', async () => {
      expect((await failing('open_image', { path: '/no/such/file.xisf' })).error?.kind).toBe('file_not_found');
    });

    it('does not count an unsaved new image as safe to close', async () => {
      await newImage('mcp_unsaved');
      expect((await images()).find((image) => image.view === 'mcp_unsaved')).toMatchObject({ modified: false, unsaved: true, filePath: '' });
      expect((await failing('close_image', { view: 'mcp_unsaved' })).error?.kind).toBe('unsaved_changes');
      await close('mcp_unsaved');
    });

    it('closes several images at once, or none of them', async () => {
      await newImage('mcp_many_saved');
      await run(live.session, 'save_image', { view: 'mcp_many_saved', path: file('many.xisf') });
      await newImage('mcp_many_new');

      const refused = await failing('close_image', { view: ['mcp_many_saved', 'mcp_many_new'] });
      expect(refused.error).toMatchObject({ kind: 'unsaved_changes', message: expect.stringMatching(/^mcp_many_new holds/) });
      expect((await images()).map((image) => image.view)).toEqual(expect.arrayContaining(['mcp_many_saved', 'mcp_many_new']));

      expect((await failing('close_image', { view: ['mcp_many_saved', 'no_such_image'] })).error?.kind).toBe('unknown_view');
      expect((await images()).map((image) => image.view)).toContain('mcp_many_saved');

      // A plain "discard" for a list would also cover work the caller does not know about.
      expect((await failing('close_image', { view: ['mcp_many_saved', 'mcp_many_new'], discardChanges: true })).error?.kind).toBe('invalid_arguments');
      expect((await failing('close_image', { view: ['mcp_many_saved', 'mcp_many_new'], discardChanges: ['mcp_many_saved'] })).error?.kind).toBe('unsaved_changes');
      expect((await images()).map((image) => image.view)).toEqual(expect.arrayContaining(['mcp_many_saved', 'mcp_many_new']));

      const closed = await run<{ closed: string[]; discarded: string[] }>(live.session, 'close_image', {
        view: ['mcp_many_saved', 'mcp_many_new'],
        discardChanges: ['mcp_many_new'],
      });
      expect(closed).toEqual({ closed: ['mcp_many_saved', 'mcp_many_new'], discarded: ['mcp_many_new'] });
      expect((await images()).map((image) => image.view)).not.toContain('mcp_many_saved');
    });

    it('closes a saved image without being told to discard anything', async () => {
      await newImage('mcp_clean');
      await run(live.session, 'save_image', { view: 'mcp_clean', path: file('clean.xisf') });
      expect(await run(live.session, 'close_image', { view: 'mcp_clean' })).toEqual({ closed: ['mcp_clean'] });
    });

    describe('export', () => {
      type Export = { bytes: number; bitsPerSample: number; floatSample: boolean; keywords: number; properties: number; astrometry: boolean; filePathOfWindow: string };

      beforeAll(async () => {
        await newImage('mcp_export');
        await runProcess({ processId: 'PixelMath', view: 'mcp_export', params: pixelMath('0.2+0.6*abs(sin(X()*40)*cos(Y()*40))') });
      }, 60_000);

      afterAll(async () => {
        await close('mcp_export');
      });

      it('honors the JPEG quality and keeps the proportions', async () => {
        const low = await run<Export>(live.session, 'export_image', { view: 'mcp_export', path: file('low.jpg'), quality: 20 });
        const high = await run<Export>(live.session, 'export_image', { view: 'mcp_export', path: file('high.jpg'), quality: 98 });
        expect(high.bytes).toBeGreaterThan(low.bytes * 2);
        expect(high.bitsPerSample).toBe(8);
        expect(high).toMatchObject({ keywords: 0, properties: 0, astrometry: false });
        expect(jpegSize(await readFile(file('high.jpg')))).toEqual({ width: WIDTH, height: HEIGHT });
      });

      it('writes the requested bit depth', async () => {
        const tiff = await run<Export>(live.session, 'export_image', { view: 'mcp_export', path: file('out.tif'), bitsPerSample: 16 });
        expect(tiff).toMatchObject({ bitsPerSample: 16, floatSample: false });
        expect(statSync(file('out.tif')).size).toBeGreaterThanOrEqual(WIDTH * HEIGHT * 3 * 2);
        expect(statSync(file('out.tif')).size).toBeLessThan(WIDTH * HEIGHT * 3 * 2 + 200_000);
      });

      it('keeps floating point samples at 32 bits unless told otherwise', async () => {
        const kept = await run<Export>(live.session, 'export_image', { view: 'mcp_export', path: file('float.xisf'), bitsPerSample: 32 });
        expect(kept).toMatchObject({ bitsPerSample: 32, floatSample: true });
        const integer = await run<Export>(live.session, 'export_image', { view: 'mcp_export', path: file('int.xisf'), bitsPerSample: 32, floatSample: false });
        expect(integer.floatSample).toBe(false);
      });

      it('leaves the window alone', async () => {
        const before = (await images()).find((image) => image.view === 'mcp_export');
        const result = await run<Export>(live.session, 'export_image', { view: 'mcp_export', path: file('leave.jpg') });
        expect(result.filePathOfWindow).toBe('');
        expect((await images()).find((image) => image.view === 'mcp_export')).toEqual(before);
      });

      it('leaves no temporary file behind, and replaces the old file', async () => {
        const dir = join(live.config.home, 'replace');
        await mkdir(dir);
        const path = join(dir, 'image.xisf');
        await run(live.session, 'export_image', { view: 'mcp_export', path });
        const { mtimeMs } = statSync(path);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await run(live.session, 'export_image', { view: 'mcp_export', path, overwrite: true });
        expect(statSync(path).mtimeMs).toBeGreaterThan(mtimeMs);
        expect(await readdir(dir)).toEqual(['image.xisf']);
      });

      it('keeps the old file if the new one cannot be written', async () => {
        const dir = join(live.config.home, 'readonly');
        await mkdir(dir);
        const path = join(dir, 'keep.jpg');
        await run(live.session, 'export_image', { view: 'mcp_export', path });
        const before = await readFile(path);
        await chmod(dir, 0o555);
        try {
          const done = await failing('export_image', { view: 'mcp_export', path, quality: 10, overwrite: true });
          expect(done.state).toBe('failed');
          expect(await readFile(path)).toEqual(before);
          expect(await readdir(dir)).toEqual(['keep.jpg']);
        } finally {
          await chmod(dir, 0o755);
        }
      });

      it('protects existing files, and refuses what a format cannot store', async () => {
        const path = file('again.jpg');
        await run(live.session, 'export_image', { view: 'mcp_export', path });
        expect((await failing('export_image', { view: 'mcp_export', path })).error?.kind).toBe('file_exists');
        await run(live.session, 'export_image', { view: 'mcp_export', path, overwrite: true });

        expect((await failing('export_image', { view: 'mcp_export', path: file('deep.jpg'), bitsPerSample: 32, floatSample: true })).error?.kind).toBe('invalid_format');
        expect((await failing('export_image', { view: 'mcp_export', path: file('x.nosuchformat') })).error?.kind).toBe('invalid_format');
      });
    });
  });

  describe.skipIf(!SOLVED_IMAGE)('with a real plate-solved master', () => {
    type Opened = { views: Array<{ view: string; astrometry: boolean; keywords: number }>; closedExtras?: string[] };

    it('keeps astrometry and keywords through opening, duplicating and exporting', async () => {
      const opened = await run<Opened>(live.session, 'open_image', { path: SOLVED_IMAGE, id: 'mcp_real' });
      expect(opened.views).toHaveLength(1);
      expect(opened.views[0]).toMatchObject({ view: 'mcp_real', astrometry: true });
      expect(opened.views[0]!.keywords).toBeGreaterThan(0);
      const stored = (await images()).find((image) => image.view === 'mcp_real')!;
      expect(stored.filePath).toBe('');

      const copy = await run<{ view: string; astrometry: boolean; skippedProperties: string[] }>(live.session, 'duplicate_image', { view: 'mcp_real', id: 'mcp_real_copy' });
      expect(copy.astrometry).toBe(true);

      const path = join(live.config.home, 'real.xisf');
      const exported = await run<{ properties: number; keywords: number; astrometry: boolean }>(live.session, 'export_image', { view: 'mcp_real_copy', path });
      expect(exported.keywords).toBeGreaterThan(0);
      expect(exported.properties).toBeGreaterThan(0);
      expect(exported.astrometry).toBe(true);

      // A format can accept all properties and store none, so only the file counts.
      const jpeg = await run<{ properties: number; astrometry: boolean }>(live.session, 'export_image', { view: 'mcp_real_copy', path: join(live.config.home, 'real.jpg') });
      expect(jpeg).toMatchObject({ properties: 0, astrometry: false });
      const saved = await run<{ properties: number; astrometry: boolean }>(live.session, 'save_image', { view: 'mcp_real_copy', path: join(live.config.home, 'real_saved.xisf') });
      expect(saved.astrometry).toBe(true);
      expect(saved.properties).toBeGreaterThan(0);
      const reopened = await run<Opened>(live.session, 'open_image', { path, id: 'mcp_real_again' });
      expect(reopened.views[0]).toMatchObject({ astrometry: true });

      for (const view of ['mcp_real', 'mcp_real_copy', 'mcp_real_again']) await close(view);
    }, 180_000);

    const openReal = async (id: string) => {
      await run<Opened>(live.session, 'open_image', { path: SOLVED_IMAGE, id });
    };

    it('crops without a question, says what that cost, and can undo it', async () => {
      await openReal('mcp_crop_real');
      const astrometry = async () => (await images()).find((image) => image.view === 'mcp_crop_real')?.astrometry;
      expect(await astrometry()).toBe(true);

      const done = await runProcess({ processId: 'Crop', view: 'mcp_crop_real', params: { mode: 'AbsolutePixels', leftMargin: -100, rightMargin: -100 } });
      expect(done.state).toBe('succeeded');
      expect(done.value).toMatchObject({ pixelsChanged: true, metadataChanged: true, astrometryRemoved: true });
      expect(done.console?.join('\n')).toMatch(/astrometric solution will be deleted/);
      expect(await astrometry()).toBe(false);

      await run(live.session, 'undo', { view: 'mcp_crop_real' });
      expect(await astrometry()).toBe(true);
      await close('mcp_crop_real');
    }, 120_000);

    it('still lets the caller ask for the question, which automation mode answers with No', async () => {
      await openReal('mcp_crop_ask');
      const done = await runProcess({ processId: 'Crop', view: 'mcp_crop_ask', params: { mode: 'AbsolutePixels', leftMargin: -100, noGUIMessages: false } });
      expect(done.error?.kind).toBe('process_error');
      await close('mcp_crop_ask');
    }, 120_000);

    it('gets a star layer from a copy of a region, without the error a preview causes', async () => {
      const installed = await run<Array<{ id: string }>>(live.session, 'list_processes');
      if (!installed.some((process) => process.id === 'StarXTerminator')) return;
      const stars = { stars: true, unscreen: false };
      const rect = { x0: 300, y0: 1800, x1: 900, y1: 2200 };
      await openReal('mcp_sx');

      const part = await run<{ view: string }>(live.session, 'duplicate_image', { view: 'mcp_sx', id: 'mcp_sx_part', rect });
      const onCopy = await runProcess({ processId: 'StarXTerminator', view: part.view, params: stars });
      expect(onCopy.state).toBe('succeeded');
      const fromCopy = (onCopy.value as { newViews: string[] }).newViews;
      expect(fromCopy).toHaveLength(1);
      expect(onCopy.log?.join('\n')).not.toMatch(/AstrometricMetadata/);

      // The behaviour of PixInsight this depends on. In the GUI this error is a modal dialog.
      const preview = await run<{ view: string }>(live.session, 'create_preview', { view: 'mcp_sx', rect });
      const onPreview = await runProcess({ processId: 'StarXTerminator', view: preview.view, params: stars });
      expect(onPreview.log?.join('\n')).toMatch(/AstrometricMetadata/);

      const fromPreview = (onPreview.value as { newViews?: string[] } | undefined)?.newViews ?? [];
      const all = ['mcp_sx', 'mcp_sx_part', ...fromCopy, ...fromPreview];
      await run(live.session, 'close_image', { view: all, discardChanges: all });
    }, 180_000);
  });

  describe('instance loss', () => {
    it('leaves its instance running at the end if it holds unsaved work, and stops it once that is gone', async () => {
      // Not those that an earlier run left behind, whose instance was ended from outside.
      const inSwap = async () => (await readdir(tmpdir())).filter((name) => /^~PI~.*~mcp_stop/.test(name));
      const old = new Set(await inSwap());
      const swapFiles = async () => (await inSwap()).filter((name) => !old.has(name));
      await newImage('mcp_stop');
      await runProcess({ processId: 'PixelMath', view: 'mcp_stop', params: pixelMath('0.5') });
      expect((await swapFiles()).length).toBeGreaterThan(0);
      const onSlot = async () => (await live.session.instances())?.find((instance) => instance.slot === live.config.workerSlot && !instance.crashed);
      const { pid } = (await onSlot())!;

      // Stopping it would close the images without saving them, at every end of a session.
      await live.session.close();
      expect((await onSlot())?.pid).toBe(pid);
      expect((await images()).map((image) => image.view)).toContain('mcp_stop');
      expect((await onSlot())?.pid).toBe(pid);

      const all = (await images()).map((image) => image.view);
      await run(live.session, 'close_image', { view: all, discardChanges: all });
      const before = Date.now();
      await live.session.close();
      // A client gives a server four seconds before it kills it.
      expect(Date.now() - before).toBeLessThan(3500);
      expect(await onSlot()).toBeUndefined();
      expect(await swapFiles()).toEqual([]);

      // The next job brings the instance back.
      expect((await run<{ instance: number }>(live.session, 'ping', {}, 60_000)).instance).toBe(live.config.workerSlot);
      await newImage(VIEW);
    }, 120_000);

    it('notices a crash, restarts its own instance and says so', async () => {
      const instances = await live.session.instances();
      const worker = instances?.find((instance) => instance.slot === live.config.workerSlot);
      expect(worker?.pid).toBeTruthy();
      // Only ever the instance this session started itself.
      expect(worker?.pid).toBe(live.session.target.current()?.pid);

      await live.session.jobs.wait(live.session.jobs.submit('ping', {}).id, 15_000);
      process.kill(worker!.pid!, 'SIGKILL');

      const lost = await live.session.jobs.wait(live.session.jobs.submit('ping', {}).id, 20_000);
      expect(lost.state).not.toBe('succeeded');
      expect(lost.error?.message).toMatch(new RegExp(`these images held unsaved work: .*${VIEW}`));
      const done = await live.session.jobs.wait(live.session.jobs.submit('ping', {}).id, 60_000);
      expect(done.state).toBe('succeeded');
      expect((done.value as { instance: number }).instance).toBe(live.config.workerSlot);
      expect(live.session.takeNotice()).toMatch(new RegExp(`was lost.*not saved are gone.*held unsaved work: .*${VIEW}`));
      expect(live.session.takeNotice()).toBeUndefined();
    });
  });
});
