import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import type { LibraryDir } from '../../src/guides.js';
import { Session } from '../../src/session.js';
import { createServer } from '../../src/tools.js';
import { FakePixInsight, pix, FORM_FIELDS, playForm, playScript, sleep, waitUntil, writeResult, type Script } from './fakes.js';

type Result = { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean };

describe('the tools, as a client sees them', () => {
  let home: string;
  let cli: FakePixInsight;
  let session: Session;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;
  const blocks = (result: Result) => result.content.filter((block) => block.type === 'text').map((block) => JSON.parse(block.text as string) as any);

  /** A result with a console log, the way the runner leaves it behind. */
  const withLog = (value: unknown, log: string): Script => async (_job, jobDir) => {
    await writeFile(join(jobDir, 'console.log'), log);
    await writeResult(jobDir, JSON.stringify({ ok: true, value }));
    return undefined;
  };

  const processInfo = { id: 'P', categories: [], canProcessViews: true, canProcessGlobal: true, parameters: [], constants: [] };

  /** Answers the lookups the server makes on its own, and leaves the rest to the given script. */
  const script = (rest: Script, described: object = {}): Script => (job, dir, pixinsight) => {
    if (job.op === 'describe_process') return { ...processInfo, ...described };
    if (job.op === 'ping') return { build: 1 };
    return rest(job, dir, pixinsight);
  };

  /** A server with a client, as one session of an MCP host. */
  const connect = async (config: Partial<Config> = {}, library?: LibraryDir[]) => {
    const ownSession = await Session.create(
      { executable: '/nowhere', mode: 'shared', slot: undefined, workerSlot: 200, shadowSlot: 250, preprocessSlot: 240, headless: true, home, allowedPrograms: [], guideDirs: [], scriptDirs: [], allowCode: false, scriptDialogs: 'off', ...config },
      cli,
    );
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await createServer(ownSession, '0.0.0', library).connect(serverSide);
    const ownClient = new Client({ name: 'test', version: '1.0.0' });
    await ownClient.connect(clientSide);
    return {
      session: ownSession,
      client: ownClient,
      close: async () => {
        await ownClient.close();
        await ownSession.close();
      },
    };
  };
  let connection: Awaited<ReturnType<typeof connect>>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-test-'));
    cli = new FakePixInsight();
    cli.addInstance(1);
    connection = await connect();
    ({ session, client } = connection);
  });

  afterEach(async () => {
    await connection.close();
    await rm(home, { recursive: true, force: true });
  });

  it('tells the assistant in worker mode that nobody else sees its instance', async () => {
    const worker = await connect({ mode: 'worker' });
    expect(worker.client.getInstructions()).toMatch(/^You work in a PixInsight instance of your own, without a window/);
    expect(worker.client.getInstructions()?.length).toBeLessThan(2048);
    await worker.close();
  });

  it('gives the assistant short standing instructions', () => {
    const instructions = client.getInstructions();
    expect(instructions).toMatch(/^You work in the user's PixInsight/);
    expect(instructions).toMatch(/Never resend a pending job/);
    expect(instructions).toMatch(/Only the user can allow you to discard unsaved work, replace a file or run a program/);
    expect(instructions).toMatch(/call get_guide/);
    // Clients cut longer ones off, and all of it is in every session's context.
    expect(instructions?.length).toBeLessThan(2048);
  });

  describe('for any assistant, whatever client and model it runs on', () => {
    // What OpenAI, Gemini and local models all accept as the schema of a function. Anything else
    // makes some client refuse the tool, or the whole server.
    const KEYWORDS = new Set(['type', 'properties', 'required', 'items', 'enum', 'anyOf', 'description', 'minimum', 'maximum', 'minItems', 'maxItems', 'additionalProperties']);

    const keywordsOf = (schema: unknown, found = new Set<string>()): Set<string> => {
      if (Array.isArray(schema)) schema.forEach((item) => keywordsOf(item, found));
      else if (schema && typeof schema === 'object') {
        for (const [key, value] of Object.entries(schema)) {
          found.add(key);
          // The keys of properties are parameter names, not keywords.
          if (key === 'properties') Object.values(value as object).forEach((property) => keywordsOf(property, found));
          else keywordsOf(value, found);
        }
      }
      return found;
    };

    it('describes every tool with a schema that all of them accept', async () => {
      // With everything the user can turn on, so that no tool is left out.
      const everything = await connect({ allowCode: true, scriptDialogs: 'operate' });
      const { tools: registered } = await everything.client.listTools();
      await everything.close();
      expect(registered.map((tool) => tool.name)).toEqual(expect.arrayContaining(['run_code', 'start_script', 'get_script_dialog', 'use_script_dialog']));
      for (const tool of registered) {
        const { $schema: _dialect, ...schema } = tool.inputSchema as Record<string, unknown>;
        expect(schema['type'], tool.name).toBe('object');
        expect([...keywordsOf(schema)].filter((keyword) => !KEYWORDS.has(keyword)), tool.name).toEqual([]);
        expect(tool.name).toMatch(/^[a-z_]{1,64}$/);
        // OpenAI cuts a description off at 1,024 characters.
        expect(tool.description?.length, tool.name).toBeLessThan(1024);
        for (const parameter of Object.keys(schema['properties'] as object)) expect(parameter, tool.name).toMatch(/^[A-Za-z]{1,64}$/);
      }
    });

    it('opens the catalog with the rules, for a client that keeps the instructions to itself', async () => {
      cli.script = script(() => []);
      const result = await call('get_guide');
      const catalog = result.content[0]?.text ?? '';
      const instructions = client.getInstructions() ?? '';
      const rules = instructions.slice(0, instructions.indexOf('\n\nBefore you process'));
      expect(rules).toMatch(/Only the user can allow you/);
      expect(catalog).toContain(rules);
      expect(catalog.indexOf(rules)).toBeLessThan(catalog.indexOf('# Processing library'));
    });

    it('says in the tool itself where to start, and what to do without a picture', async () => {
      const { tools: registered } = await client.listTools();
      const description = (name: string) => registered.find((tool) => tool.name === name)?.description;
      expect(description('get_guide')).toMatch(/Start every session by calling it without a name/);
      expect(description('get_preview')).toMatch(/If no picture reaches you/);
    });
  });

  describe('every tool', () => {
    const rect = { x0: 0, y0: 0, x1: 10, y1: 10 };
    const tools: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
      ['get_status', {}, 'ping', {}],
      ['list_processes', { search: 'x' }, 'list_processes', {}],
      ['describe_process', { processId: 'P' }, 'describe_process', { processId: 'P' }],
      ['run_process', { processId: 'P', view: 'a', params: {}, waitMs: 500 }, 'run_process', { processId: 'P', view: 'a', params: {} }],
      ['list_images', {}, 'list_images', {}],
      ['get_image_stats', { view: 'a', rects: [rect], clipping: { low: 0.1 }, waitMs: 500 }, 'image_stats', { view: 'a', rects: [rect], clipping: { low: 0.1 } }],
      ['get_image_metadata', { view: 'a', search: 'filt', waitMs: 500 }, 'image_metadata', { view: 'a', search: 'filt' }],
      ['get_preview', { view: 'a', maxSize: 256, crop: rect, stretchFrom: 'b', waitMs: 500 }, 'preview', { view: 'a', maxSize: 256, crop: rect, stretchFrom: 'b' }],
      ['undo', { view: 'a', count: 2, historyIndex: 3 }, 'undo', { view: 'a', count: 2, historyIndex: 3 }],
      ['redo', { view: 'a', historyIndex: 1 }, 'redo', { view: 'a', historyIndex: 1 }],
      ['open_image', { path: '/data/a.xisf', id: 'a', allImages: true, waitMs: 500 }, 'open_image', { path: '/data/a.xisf', id: 'a', allImages: true }],
      ['save_image', { view: 'a', path: '/data/a.xisf', overwrite: true, waitMs: 500 }, 'save_image', { view: 'a', path: '/data/a.xisf', overwrite: true }],
      ['close_image', { view: ['a', 'b'], discardChanges: ['a'] }, 'close_image', { view: ['a', 'b'], discardChanges: ['a'] }],
      ['close_image', { view: 'a', discardChanges: true }, 'close_image', { view: 'a', discardChanges: true }],
      ['export_image', { view: 'a', path: '/data/a.jpg', quality: 90, bitsPerSample: 8, waitMs: 500 }, 'export_image', { view: 'a', path: '/data/a.jpg', quality: 90, bitsPerSample: 8 }],
      ['duplicate_image', { view: 'a', id: 'b', rect, waitMs: 500 }, 'duplicate_image', { view: 'a', id: 'b', rect }],
      ['create_preview', { view: 'a', rect, id: 'p' }, 'create_preview', { view: 'a', rect, id: 'p' }],
      ['delete_preview', { view: 'a->p' }, 'delete_preview', { view: 'a->p' }],
    ];

    it.each(tools)('%s with %j sends the operation %s, with these arguments and no others', async (tool, args, op, sent) => {
      cli.script = script(() => (op === 'list_processes' ? [] : {}));
      const result = await call(tool, args);
      expect(result.isError).toBeUndefined();
      expect(cli.ran.at(-1)).toMatchObject({ slot: 1, op });
      expect(cli.ran.at(-1)?.args).toEqual(sent);
      expect(existsSync(join('pjsr', 'ops', `${op}.js`))).toBe(true);
    });

    it('is covered by the list above', async () => {
      const { tools: registered } = await client.listTools();
      // Without an operation of their own, or with more than one, which have tests of their own.
      const notInTheList = ['get_job', 'cancel_job', 'get_guide', 'list_scripts', 'start_script', 'start_preprocessing'];
      expect(registered.map((tool) => tool.name).sort()).toEqual([...new Set(tools.map(([name]) => name)), ...notInTheList].sort());
    });

    it('says truthfully whether it can destroy something', async () => {
      const { tools: registered } = await client.listTools();
      const destructive = registered.filter((tool) => tool.annotations?.destructiveHint !== false && tool.annotations?.readOnlyHint !== true).map((tool) => tool.name);
      expect(destructive.sort()).toEqual(['close_image', 'delete_preview', 'export_image', 'run_process', 'save_image', 'start_script']);
    });
  });

  describe('scripts of the Script menu', () => {
    const changes = { newViews: [], closedViews: [], changedViews: [{ view: 'Ha', changed: ['astrometry', 'metadata'], historyIndex: 2, steps: 0 }], script: 'Solver', startedOn: 'Ha', activeAfter: 'Ha' };
    /** The fake installation: one script to start, and one that is off limits. */
    const installation = (report: object | undefined): Script => async (job, jobDir) => {
      if (job.op === 'ping') return { build: 1, scriptsDir: join(home, 'shipped') };
      if (job.op === 'prepare_script') return { startedOn: job.args['view'] ?? null, images: [] };
      if (job.op === 'stuck') return undefined;
      if (job.op === 'start_script' && report) await writeFile(join(jobDir, 'script.log'), 'Solving Ha\nRMS error: 0.12 px\n');
      return report;
    };

    beforeEach(async () => {
      await mkdir(join(home, 'shipped'), { recursive: true });
      await writeFile(join(home, 'shipped', 'Solver.js'), '#feature-id Solver : Astrometry > Solver\n#feature-info <b>Solves</b> the image.\n');
      await writeFile(join(home, 'shipped', 'Mount.js'), '#feature-id Mount : Instrumentation > Mount\n');
      cli.script = installation(changes);
    });

    describe('and preprocessing, which runs WBPP without its dialog', () => {
      const frames = () => join(home, 'frames');
      const out = () => join(home, 'out');
      /** What WBPP leaves of a run that completed, as far as the result is read from it. */
      const wbppCompletes = async (): Promise<void> => {
        await mkdir(join(out(), 'logs'), { recursive: true });
        await mkdir(join(out(), 'master'), { recursive: true });
        await writeFile(join(out(), 'master', 'masterLight_FILTER-L.xisf'), 'x');
        const log = join(out(), 'logs', '20261110185414.log');
        await writeFile(log, ['* Begin integration of Light frames', 'Execution summary', '3 operation(s) completed, 0 failed, 0 canceled or not executed.', 'No frames have been excluded from the execution.', 'Smart report result'].map((line) => `[2026-11-10 18:54:14] ${line}`).join('\n'));
        await writeFile(
          join(out(), 'logs', '20261110185414_SmartReport.txt'),
          '******************** LIGHT FRAMES CALIBRATION ********************\nGroup of 6 Light frames (6 active)\nFilter   : L\nKeywords : []\nMaster bias: /m/masterBias.xisf\nMaster dark: none\nMaster flat: none\n',
        );
        await writeFile(cli.runs.at(-1)!.outputPath, `:LOGFILE:${log}:LOGFILE:`);
        cli.runs.at(-1)!.end(0);
      };

      beforeEach(async () => {
        await writeFile(join(home, 'shipped', 'WBPP.js'), '#feature-id WeightedBatchPreprocessing : Batch Processing > WeightedBatchPreprocessing\n');
        await mkdir(frames(), { recursive: true });
      });

      afterEach(() => {
        for (const run of cli.runs) run.end(null);
      });

      it('starts a run, says how far it is, and reports it once it has ended, with a word on lights that got no flat', async () => {
        const first = await call('start_preprocessing', { inputs: [frames()], outputDirectory: out(), keywords: ['SESSION'], options: { platesolve: false }, waitMs: 100 });
        expect(first.isError).toBeUndefined();
        const [pending] = blocks(first);
        expect(pending).toEqual({ pending: true, jobId: expect.any(String), state: 'running', elapsedMs: expect.any(Number), hint: expect.stringMatching(/instance of its own.*get_job.*Do not start the run again/) });
        expect(cli.runs[0]!.scripts[1]!.args).toEqual(['automationMode=true', `outputDirectory=${pix(out())}`, 'keywords=SESSION', 'platesolve=false', `dir=${pix(frames())}`]);
        // The job tools know a run by its id.
        expect(blocks(await call('get_job', { jobId: pending.jobId, waitMs: 100 }))[0]).toMatchObject({ pending: true, jobId: pending.jobId });
        await wbppCompletes();
        const done = await call('get_job', { jobId: pending.jobId, waitMs: 5000 });
        expect(done.isError).toBeUndefined();
        expect(blocks(done)[0]).toEqual({
          outputDirectory: pix(out()),
          summary: ['3 operation(s) completed, 0 failed, 0 canceled or not executed.', 'No frames have been excluded from the execution.'],
          groups: [{ step: 'light frames calibration', frames: '6 Light frames (6 active)', filter: 'L', keywords: '[]', masterBias: 'masterBias.xisf', masterDark: 'none', masterFlat: 'none' }],
          masters: [pix(join(out(), 'master', 'masterLight_FILTER-L.xisf'))],
          log: join(out(), 'logs', '20261110185414.log'),
          report: join(out(), 'logs', '20261110185414_SmartReport.txt'),
          seconds: expect.any(Number),
          hint: expect.stringMatching(/^1 group\(s\) of lights got no flat: read groups\..*open_image/),
        });
        expect(blocks(await call('cancel_job', { jobId: pending.jobId }))[0]).toMatchObject({ error: 'already_finished' });
      });

      it('stops a run on request, which the server can do because the instance is its own', async () => {
        const [pending] = blocks(await call('start_preprocessing', { inputs: [frames()], outputDirectory: out(), waitMs: 100 }));
        const { pid } = cli.runs[0]!;
        expect(blocks(await call('cancel_job', { jobId: pending.jobId }))[0]).toEqual({ cancelled: true, message: expect.stringMatching(/stopped.*still there/) });
        expect(cli.ended).toEqual([pid]);
        expect(cli.killed).toEqual([]);
        const after = await call('get_job', { jobId: pending.jobId });
        expect(after.isError).toBe(true);
        expect(blocks(after)[0]).toMatchObject({ error: 'cancelled' });
      });

      it('says so when a run cannot be stopped, as a result and not as a failure of the protocol', async () => {
        const [pending] = blocks(await call('start_preprocessing', { inputs: [frames()], outputDirectory: out(), waitMs: 100 }));
        cli.refuseEndRun = 'kill EPERM';
        const refused = await call('cancel_job', { jobId: pending.jobId });
        expect(refused.isError).toBe(true);
        expect(blocks(refused)[0]).toMatchObject({ error: 'cli_failed', message: expect.stringContaining('kill EPERM') });
        expect(blocks(await call('get_job', { jobId: pending.jobId, waitMs: 50 }))[0]).toMatchObject({ pending: true });
      });

      it('shows a run that is under way in the status, which is where its id is found again', async () => {
        expect(blocks(await call('get_status'))[0]).not.toHaveProperty('preprocessing');
        const [pending] = blocks(await call('start_preprocessing', { inputs: [frames()], outputDirectory: out(), waitMs: 100 }));
        const status = blocks(await call('get_status'))[0]!;
        expect(status).toMatchObject({ preprocessing: { jobId: pending.jobId, state: 'running', elapsedMs: expect.any(Number) } });
        // Its instance is marked as what it is, and not taken for a worker.
        expect((status.instances as Array<{ slot: number; role?: string }>).find((instance) => instance.slot === cli.runs[0]!.slot)).toMatchObject({ role: 'preprocessing' });
        cli.runs[0]!.end(1);
        await waitUntil(async () => !('preprocessing' in blocks(await call('get_status'))[0]!));
      });

      it('starts no run for a call that was given up before it began', async () => {
        const given = new AbortController();
        given.abort();
        await client.callTool({ name: 'start_preprocessing', arguments: { inputs: [frames()], outputDirectory: out() } }, { signal: given.signal }).catch(() => undefined);
        // What the server made of it is seen in what it did not do.
        await call('get_status');
        expect(cli.runs).toEqual([]);
      });

      it('returns a refusal as a result the assistant can act on, and starts nothing', async () => {
        const refused = await call('start_preprocessing', { inputs: [join(home, 'nothing')], outputDirectory: out() });
        expect(refused.isError).toBe(true);
        expect(blocks(refused)[0]).toMatchObject({ error: 'no_such_file' });
        expect(blocks(await call('start_preprocessing', { inputs: [frames()], outputDirectory: out(), options: { pipelineScriptFile: '/x.js' } }))[0]).toMatchObject({ error: 'blocked_parameter' });
        expect(cli.runs).toEqual([]);
      });
    });

    it('lists them by name and menu, marks the blocked ones, and keeps their paths to itself', async () => {
      const [list] = blocks(await call('list_scripts'));
      expect(list).toEqual([
        { name: 'Mount', menus: ['Instrumentation > Mount'], source: 'shipped', blocked: expect.stringContaining('equipment') },
        { name: 'Solver', menus: ['Astrometry > Solver'], info: 'Solves the image.', source: 'shipped' },
      ]);
      expect(blocks(await call('list_scripts', { search: 'ASTROMETRY' }))[0]).toHaveLength(1);
      expect(blocks(await call('list_scripts', { search: 'solves the' }))[0]).toHaveLength(1);
      expect(blocks(await call('list_scripts', { search: 'nothing like it' }))[0]).toEqual([]);
    });

    it('starts one, and returns what changed together with what the script wrote', async () => {
      const result = await call('start_script', { script: 'Solver', view: 'Ha' });
      expect(result.isError).toBeUndefined();
      expect(blocks(result)[0]).toEqual({ ...changes, log: ['Solving Ha', 'RMS error: 0.12 px'] });
      expect(cli.started.map((started) => started.path)).toEqual([join(home, 'shipped', 'Solver.js')]);
    });

    it('says so if nothing is different afterwards, which is what a cancelled dialog looks like', async () => {
      cli.script = installation({ newViews: [], closedViews: [], changedViews: [], script: 'Solver', startedOn: null, activeAfter: null });
      expect(blocks(await call('start_script', { script: 'Solver' }))[0]).toMatchObject({ hint: expect.stringMatching(/may have cancelled/) });
    });

    it('comes back soon while the script waits for the user, and says what that means', async () => {
      cli.script = installation(undefined);
      const startedAt = Date.now();
      const [first] = blocks(await call('start_script', { script: 'Solver', waitMs: 150 }));
      // Soon, compared with the 20 s a process gets.
      expect(Date.now() - startedAt).toBeLessThan(4000);
      expect(first).toMatchObject({ pending: true, jobId: expect.any(String) });
      // The hint about the dialog comes once the script has gone out, however long the machine takes for that.
      await waitUntil(() => cli.started.length === 1, 5000);
      await waitUntil(async () => (await session.jobs.get(first.jobId))?.state !== 'queued', 5000);
      const [pending] = blocks(await call('get_job', { jobId: first.jobId, waitMs: 0 }));
      expect(pending).toMatchObject({ pending: true, jobId: first.jobId, hint: expect.stringMatching(/Tell the user what to set there.*Do not start the script again/) });

      // Nothing takes a script back once it is in PixInsight.
      expect(blocks(await call('cancel_job', { jobId: pending.jobId }))[0]).toMatchObject({ error: 'already_running', message: expect.stringContaining('close its dialog') });
      expect(blocks(await call('cancel_job', { jobId: pending.jobId, abandon: true }))[0]).toMatchObject({
        abandoned: true,
        stillRuns: true,
        message: expect.stringContaining('can still be open or at work'),
      });
    });

    it('waits three seconds for the script by default, not as long as for a process', async () => {
      cli.script = installation(undefined);
      const startedAt = Date.now();
      const [pending] = blocks(await call('start_script', { script: 'Solver' }));
      const waited = Date.now() - startedAt;
      expect(pending).toMatchObject({ pending: true });
      expect(waited).toBeGreaterThan(2500);
      expect(waited).toBeLessThan(8000);
      const { tools: registered } = await client.listTools();
      const schema = registered.find((tool) => tool.name === 'start_script')?.inputSchema as unknown as { properties: { waitMs: { description: string } } };
      expect(schema.properties.waitMs.description).toMatch(/Default 3000/);
    }, 20_000);

    it('does not send the user to a dialog while the script still waits for its turn', async () => {
      session.jobs.submit('stuck', {});
      await waitUntil(() => cli.ran.some((job) => job.op === 'stuck'));
      const [pending] = blocks(await call('start_script', { script: 'Solver', waitMs: 100 }));
      expect(pending).toMatchObject({ pending: true, state: 'queued', hint: expect.stringMatching(/waits behind an earlier one \(stuck, job [0-9a-f-]+\).*Do not send it again/) });
      // Not sent, so it can still be taken back.
      expect(blocks(await call('cancel_job', { jobId: pending.jobId }))[0]).toEqual({ cancelled: true });
      expect(cli.started).toEqual([]);
    });

    it('tells a job that waits behind an open script why it waits', async () => {
      cli.script = installation(undefined);
      const [script] = blocks(await call('start_script', { script: 'Solver', waitMs: 100 }));
      await waitUntil(() => cli.started.length === 1, 5000);
      await waitUntil(async () => (await session.jobs.get(script.jobId))?.state !== 'queued', 5000);
      const [waiting] = blocks(await call('get_image_stats', { view: 'a', waitMs: 100 }));
      expect(waiting).toMatchObject({ pending: true, state: 'queued' });
      expect(waiting.hint).toMatch(new RegExp(`waits behind a script that is open in PixInsight \\(job ${script.jobId}\\).*runs by itself once the script has ended`));
    });

    it('starts no second script while one is open', async () => {
      cli.script = installation(undefined);
      const [pending] = blocks(await call('start_script', { script: 'Solver', waitMs: 100 }));
      const second = await call('start_script', { script: 'Solver', waitMs: 100 });
      expect(second.isError).toBe(true);
      expect(blocks(second)[0]).toMatchObject({ error: 'script_open', message: expect.stringContaining(pending.jobId) });
      await waitUntil(() => cli.started.length === 1);
      await sleep(30);
      expect(cli.started).toHaveLength(1);
    });

    it('turns a refusal into a result the assistant can act on', async () => {
      expect(blocks(await call('start_script', { script: 'Mount' }))[0]).toMatchObject({ error: 'blocked_script' });
      expect(blocks(await call('start_script', { script: 'Solvr' }))[0]).toMatchObject({ error: 'unknown_script', message: expect.stringContaining('list_scripts') });
    });

    describe('whose dialog the assistant may read and work', () => {
      let working: Awaited<ReturnType<typeof connect>>;
      const use = async (name: string, args: Record<string, unknown> = {}) => (await working.client.callTool({ name, arguments: args })) as Result;

      beforeEach(async () => {
        working = await connect({ scriptDialogs: 'operate' });
      });

      afterEach(async () => {
        cli.userScript = () => undefined;
        await working.close();
      });

      it('is offered as far as the user has set it', async () => {
        const names = async (config: Partial<Config>) => {
          const each = await connect(config);
          const found = (await each.client.listTools()).tools.map((tool) => tool.name).filter((name) => name.includes('script'));
          await each.close();
          return found.sort();
        };
        expect(await names({ scriptDialogs: 'off' })).toEqual(['list_scripts', 'start_script']);
        expect(await names({ scriptDialogs: 'read' })).toEqual(['get_script_dialog', 'list_scripts', 'start_script']);
        expect(await names({ scriptDialogs: 'operate' })).toEqual(['get_script_dialog', 'list_scripts', 'start_script', 'use_script_dialog']);
        expect(await names({ scriptDialogs: 'operate', mode: 'worker' })).toEqual([]);
      });

      it('says in the tool what the user has allowed, so that the assistant does not send the user to a dialog it can work itself', async () => {
        const description = async (config: Partial<Config>) => {
          const each = await connect(config);
          const found = (await each.client.listTools()).tools.find((tool) => tool.name === 'start_script')?.description;
          await each.close();
          return found;
        };
        expect(await description({ scriptDialogs: 'off' })).toMatch(/only the user can work/);
        expect(await description({ scriptDialogs: 'read' })).toMatch(/the result describes it, and the user works it/);
        expect(await description({ scriptDialogs: 'operate' })).toMatch(/work it with use_script_dialog/);
      });

      it('answers the start of a script with its dialog, without the places that only a picture gives meaning to', async () => {
        playForm(cli);
        const result = await use('start_script', { script: 'Solver' });
        expect(result.isError).toBeUndefined();
        const [shown] = blocks(result);
        expect(shown).toEqual({
          pending: true,
          jobId: expect.any(String),
          dialog: { title: 'Solver', size: [200, 80], fields: FORM_FIELDS.map(({ at: _at, ...field }) => field) },
          // What a rule of the session says once is said again where it applies.
          hint: expect.stringMatching(/use_script_dialog.*write, replace or delete files or start a program.*ask the user first.*Never enter a password or a license key/),
        });
        await use('use_script_dialog', { action: 'close' });
      });

      it('returns a picture of the dialog with where the fields lie in it, and the file for a client without eyes', async () => {
        playForm(cli);
        const [{ jobId }] = blocks(await use('start_script', { script: 'Solver' }));
        const result = await use('get_script_dialog', { picture: true });
        expect(result.content[0]).toEqual({ type: 'image', mimeType: 'image/png', data: Buffer.from('png').toString('base64') });
        expect(blocks(result)[0]).toMatchObject({ dialog: { fields: FORM_FIELDS }, file: join(home, 'jobs', jobId, 'dialog-1.png') });
        await use('use_script_dialog', { action: 'close' });
      });

      it('does one thing in the dialog and shows it afterwards, and reports like any job once the script has ended', async () => {
        const taken: Array<Record<string, any>> = [];
        playForm(cli, taken);
        await use('start_script', { script: 'Solver', view: 'Ha' });
        // Only what is different now, and of that field only what differs, without where it lies.
        expect(blocks(await use('use_script_dialog', { action: 'set', field: 'f1', value: 'M 31' }))[0]).toEqual({
          pending: true,
          jobId: expect.any(String),
          dialog: { title: 'Solver', changed: [{ id: 'f1', type: 'Edit', value: 'M 31' }], unchanged: 1 },
          hint: expect.stringMatching(/Only what is different.*get_script_dialog shows all of it/),
        });
        expect(taken.at(-2)).toMatchObject({ act: 'set', field: 'f1', value: 'M 31' });
        expect(blocks(await use('use_script_dialog', { action: 'click', x: 10, y: 12 }))[0]).toMatchObject({ dialog: { title: 'Solver', changed: [], unchanged: 2 }, hint: expect.stringMatching(/Nothing that the dialog lists is different/) });
        // One field by itself, for a table or a text that the dialog shows only the start of.
        expect(blocks(await use('get_script_dialog', { field: 'f1', from: 3 }))[0]).toEqual({ pending: true, jobId: expect.any(String), dialog: { title: 'Solver' }, field: { id: 'f1', type: 'Edit', value: 'M 31', from: 3 } });
        // What cannot be meant together is refused, and nothing is asked of the script.
        const asked = taken.length;
        for (const args of [{ from: 3 }, { field: 'f1', picture: true }, { field: 'f1', until: 'OK' }]) {
          const refused = await use('get_script_dialog', args);
          expect(refused.isError).toBe(true);
          expect(blocks(refused)[0]).toMatchObject({ error: 'invalid_value' });
        }
        expect(blocks(await use('get_script_dialog', { until: ' ' }))[0]).toMatchObject({ error: 'invalid_value' });
        expect(taken).toHaveLength(asked);
        expect(blocks(await use('get_script_dialog'))[0]).toMatchObject({ dialog: { fields: [{ id: 'f1', value: 'M 31' }, { id: 'f2' }] } });
        // A wait for a field that does not come says so, and how to go on waiting.
        expect(blocks(await use('get_script_dialog', { until: 'Finished', waitMs: 1000 }))[0]).toMatchObject({ pending: true, hint: expect.stringMatching(/does not show the field you wait for yet.*same until again, or without until to see what it shows/) });
        expect(blocks(await use('get_script_dialog', { until: 'ok', waitMs: 1000 }))[0]).toMatchObject({ dialog: { title: 'Solver' } });

        const refused = await use('use_script_dialog', { action: 'press', field: 'f9' });
        expect(refused.isError).toBe(true);
        expect(blocks(refused)[0]).toEqual({ error: 'unknown_field', message: 'The dialog has no field f9.' });

        const [done] = blocks(await use('use_script_dialog', { action: 'press', field: 'f2' }));
        expect(done).toMatchObject({ ...changes, log: ['Solving Ha', 'RMS error: 0.12 px'] });
        // A look after the end returns the report once more, and an action says that the script has ended.
        expect(blocks(await use('get_script_dialog'))[0]).toMatchObject(changes);
        expect(blocks(await use('use_script_dialog', { action: 'close' }))[0]).toMatchObject({ error: 'no_script', message: expect.stringMatching(/has ended.*get_job/) });
      });

      it('says where to read on in a field that holds more, and which unchanged fields it compared only in part', async () => {
        playScript(cli, async (hook) => {
          await hook.say();
          for (;;) {
            const command = await hook.command();
            const reply = (result: object) => hook.reply(command['id'], { ok: true, result });
            if (command['act'] === 'close') {
              await reply({ fired: [] });
              return hook.say({ dialog: null, title: null });
            }
            if (command['act'] !== 'describe') await reply({ fired: [] });
            else if (command['field'] === 'f1') await reply({ dialog: 'd1.1', title: 'Report', field: { id: 'f1', type: 'TextBox', value: 'x'.repeat(10), from: command['from'], more: 7 } });
            else if (command['field'] === 'f2') {
              await reply({ dialog: 'd1.1', title: 'Report', field: { id: 'f2', type: 'TreeBox', columns: ['n'], value: null, rows: [{ row: 3, cells: ['a'] }, { row: 4, cells: ['b'] }], totalRows: 7, from: 3, moreRows: 2 } });
            } else {
              await reply({ dialog: 'd1.1', title: 'Report', size: [200, 80], moreFields: 4, fields: [{ id: 'f1', type: 'TextBox', value: 'x…', more: 16 }, { id: 'f2', type: 'TreeBox', columns: ['n'], rows: [], value: null, moreRows: 7 }, { id: 'f3', type: 'Edit', value: '' }] });
            }
          }
        });
        await use('start_script', { script: 'Solver' });
        // After the last character, and after the last row that is listed.
        expect(blocks(await use('get_script_dialog', { field: 'f1', from: 5 }))[0]).toMatchObject({ field: { id: 'f1', more: 7 }, hint: 'There is more of this field. Read on with from: 15.' });
        expect(blocks(await use('get_script_dialog', { field: 'f2', from: 3 }))[0]).toMatchObject({ field: { id: 'f2', moreRows: 2 }, hint: 'There is more of this field. Read on with from: 5.' });
        expect(blocks(await use('use_script_dialog', { action: 'set', field: 'f3', value: 'y' }))[0]).toMatchObject({
          dialog: { changed: [], unchanged: 3, listedInPart: ['f1', 'f2'], moreFields: 4 },
          hint: expect.stringMatching(/Nothing that the dialog lists is different.*listedInPart.*only the part that the dialog lists was compared/),
        });
        await use('use_script_dialog', { action: 'close' });
      });

      it('passes on a question of the script with how to answer it, and keeps its number to itself', async () => {
        playScript(cli, async (hook) => {
          await hook.say({ dialog: null, title: null, question: { id: 7, kind: 'message', text: 'Replace the file?', buttons: ['yes', 'no'] } });
          await hook.answerTo(7);
          await hook.say({ dialog: null, title: null });
        });
        const [asked] = blocks(await use('start_script', { script: 'Solver' }));
        expect(asked).toEqual({
          pending: true,
          jobId: expect.any(String),
          question: { kind: 'message', text: 'Replace the file?', buttons: ['yes', 'no'] },
          hint: expect.stringMatching(/action "answer": the name of one of its buttons.*ask the user first.*The user sees the question too/),
        });
        expect(blocks(await use('use_script_dialog', { action: 'answer', value: 'no' }))[0]).toMatchObject(changes);
      });

      it('says that the script shows nothing while it is at work, and where to look again', async () => {
        let end: (() => void) | undefined;
        playScript(cli, async (hook) => {
          await hook.say({ dialog: null, title: null });
          await new Promise<void>((resolve) => (end = resolve));
        });
        let [pending] = blocks(await use('start_script', { script: 'Solver', waitMs: 100 }));
        // On a slow machine the script is not in PixInsight yet, and the answer says that its job still waits.
        await waitUntil(async () => {
          if (/waits behind/.test(String(pending!.hint))) [pending] = blocks(await use('get_job', { jobId: pending!.jobId, waitMs: 100 }));
          return !/waits behind/.test(String(pending!.hint));
        }, 10_000);
        expect(pending).toMatchObject({ pending: true, jobId: expect.any(String), hint: expect.stringMatching(/shows no dialog of its own right now.*get_script_dialog/) });
        expect(pending.dialog).toBeUndefined();
        // Another tool hears why it has to wait, and that the script can be looked at.
        const [behind] = blocks(await use('open_image', { path: '/data/Ha.xisf', waitMs: 100 }));
        expect(behind).toMatchObject({ pending: true, hint: expect.stringMatching(/waits behind a script.*get_script_dialog/) });
        await waitUntil(() => end !== undefined);
        end?.();
        expect(blocks(await use('get_job', { jobId: pending.jobId }))[0]).toMatchObject(changes);
      });

      it('shows the dialog to whoever checks on the job, which says more than that the job is not done', async () => {
        playForm(cli);
        const [{ jobId }] = blocks(await use('start_script', { script: 'Solver' }));
        expect(blocks(await use('get_job', { jobId }))[0]).toMatchObject({ pending: true, jobId, dialog: { title: 'Solver' } });
        await use('use_script_dialog', { action: 'close' });
        expect(blocks(await use('get_job', { jobId }))[0]).toMatchObject(changes);
      });

      it('tells apart a dialog that does not answer, an action that is still at work, and no dialog', async () => {
        let end: (() => void) | undefined;
        playScript(cli, async (hook) => {
          await hook.say();
          const first = await hook.command();
          await hook.reply(first['id'], { ok: true, result: { dialog: 'd1.1', title: 'Solver', size: [200, 80], fields: FORM_FIELDS } });
          // It takes the press and is busy with it from then on.
          await hook.command();
          await new Promise<void>((resolve) => (end = resolve));
        });
        const [{ jobId }] = blocks(await use('start_script', { script: 'Solver' }));
        const [working] = blocks(await use('use_script_dialog', { action: 'press', field: 'f2', waitMs: 1000 }));
        expect(working).toMatchObject({ pending: true, jobId, hint: expect.stringMatching(/still at work on what you just did/) });
        const [silent] = blocks(await use('get_script_dialog', { waitMs: 1000 }));
        expect(silent).toMatchObject({ pending: true, hint: expect.stringMatching(/dialog of the script is open, but the script is busy in it/) });
        await waitUntil(() => end !== undefined);
        end?.();
      });

      it('passes on what the assistant has to know besides, such as an action that was not carried out', async () => {
        let closeIt: (() => void) | undefined;
        playScript(cli, async (hook) => {
          await hook.say();
          const first = await hook.command();
          await hook.reply(first['id'], { ok: true, result: { dialog: 'd1.1', title: 'Solver', size: [200, 80], fields: FORM_FIELDS } });
          await new Promise<void>((resolve) => (closeIt = resolve));
          await hook.say({ dialog: null, title: null });
        });
        const [{ jobId }] = blocks(await use('start_script', { script: 'Solver' }));
        const acting = use('use_script_dialog', { action: 'set', field: 'f1', value: 'x' });
        await waitUntil(() => readFile(join(home, 'jobs', jobId, 'dialog-cmd.json')).then(() => true, () => false));
        closeIt?.();
        expect(blocks(await acting)[0]).toMatchObject({ ...changes, notes: ['Your action (set f1) was not carried out, because the dialog closed first.'] });
      });

      it('takes no wait for a dialog that is too short for one to answer', async () => {
        const { tools: registered } = await working.client.listTools();
        for (const name of ['get_script_dialog', 'use_script_dialog']) {
          const schema = registered.find((tool) => tool.name === name)?.inputSchema as unknown as { properties: { waitMs: { minimum: number } } };
          expect(schema.properties.waitMs.minimum, name).toBe(1000);
        }
      });

      it('only shows the dialog where the user allows no more, and says who works it', async () => {
        const reading = await connect({ scriptDialogs: 'read' });
        playForm(cli);
        const [shown] = blocks((await reading.client.callTool({ name: 'start_script', arguments: { script: 'Solver' } })) as Result);
        expect(shown).toMatchObject({ dialog: { title: 'Solver' }, hint: expect.stringMatching(/waits for the user to work it/) });
        // The user closes it.
        await writeFile(join(home, 'jobs', shown.jobId, 'dialog-cmd.json'), JSON.stringify({ act: 'close', id: 99 }));
        await reading.session.jobs.wait(shown.jobId, 2000);
        await reading.close();
      });

      it('starts a script without that access if asked to, and then waits for the user as before', async () => {
        let close: (() => void) | undefined;
        cli.userScript = () => new Promise<void>((resolve) => (close = resolve));
        const [pending] = blocks(await use('start_script', { script: 'Solver', plain: true, waitMs: 100 }));
        expect(pending).toMatchObject({ pending: true });
        expect(pending.dialog).toBeUndefined();
        await waitUntil(() => cli.started.length === 1);
        expect(cli.started).toEqual([{ slot: 1, path: join(home, 'shipped', 'Solver.js') }]);
        // The hint is for this script, whose dialog only the user can work, whatever the setting allows for others.
        const [later] = blocks(await use('get_job', { jobId: pending.jobId, waitMs: 100 }));
        expect(later.hint).toMatch(/a dialog that only the user can work here/);
        expect(later.hint).not.toMatch(/get_script_dialog/);
        const [behind] = blocks(await use('open_image', { path: '/data/Ha.xisf', waitMs: 100 }));
        expect(behind.hint).toMatch(/waits behind a script.*when the user has finished its dialog/);
        expect(behind.hint).not.toMatch(/get_script_dialog/);
        expect(blocks(await use('get_script_dialog'))[0]).toMatchObject({ error: 'no_dialog_access' });
        await waitUntil(() => close !== undefined);
        close?.();
        await working.session.jobs.wait(pending.jobId, 2000);
      });

      it('tells how to end a script that cannot be cancelled from outside', async () => {
        playForm(cli);
        const [{ jobId }] = blocks(await use('start_script', { script: 'Solver' }));
        expect(blocks(await use('cancel_job', { jobId }))[0]).toMatchObject({ error: 'already_running', message: expect.stringMatching(/use_script_dialog and action "close"/) });
        await use('use_script_dialog', { action: 'close' });
      });
    });

    it('is not offered in an instance without a window, where a dialog would block for good', async () => {
      const worker = await connect({ mode: 'worker' });
      const names = (await worker.client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain('start_script');
      expect(names).not.toContain('list_scripts');
      await worker.close();
    });
  });

  describe('code of the assistant', () => {
    it('is not offered unless the user has turned it on', async () => {
      expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('run_code');
      const refused = (await client.callTool({ name: 'run_code', arguments: { code: 'return 1;' } }).catch((error: Error) => ({ isError: true, content: [{ type: 'text', text: error.message }] }))) as Result;
      expect(refused.isError).toBe(true);
      expect(cli.ran.map((job) => job.op)).not.toContain('run_code');
    });

    it('runs with the setting, in either mode, and returns the value, the changes and the console output', async () => {
      for (const mode of ['shared', 'worker'] as const) {
        const allowed = await connect({ allowCode: true, mode });
        cli.script = script(withLog({ value: 42, newViews: ['made'], closedViews: [], changedViews: [] }, 'made an image\n'));
        const result = (await allowed.client.callTool({ name: 'run_code', arguments: { code: 'return 42;', waitMs: 2000 } })) as Result;
        expect(blocks(result)[0]).toEqual({ value: 42, newViews: ['made'], closedViews: [], changedViews: [], log: ['made an image'] });
        expect(cli.ran.at(-1)).toMatchObject({ op: 'run_code', args: { code: 'return 42;' } });
        const tool = (await allowed.client.listTools()).tools.find((each) => each.name === 'run_code');
        expect(tool?.description).toMatch(/beginProcess\(\).*Never change settings.*never open a dialog/);
        await allowed.close();
      }
    });
  });

  describe('results', () => {
    it('always has a list as the first block, with console messages beside it', async () => {
      cli.script = script(withLog([{ view: 'a' }], '** Warning: failed to read something\n'));
      const result = await call('list_images');
      const [first, second] = blocks(result);
      expect(first).toEqual([{ view: 'a' }]);
      expect(second.console).toEqual(['** Warning: failed to read something']);
    });

    it('returns a plain list without console messages', async () => {
      cli.script = script(() => [{ view: 'a' }]);
      expect(blocks(await call('list_images'))).toEqual([[{ view: 'a' }]]);
    });

    it('merges the log into the result of a process', async () => {
      cli.script = script(withLog({ pixelsChanged: true, newViews: [] }, 'P: Processing\n'));
      const [result] = blocks(await call('run_process', { processId: 'P', view: 'a' }));
      expect(result).toMatchObject({ pixelsChanged: true, log: ['P: Processing'] });
    });

    it('says that a process did nothing, if it left no pixels changed', async () => {
      cli.script = script(() => ({ pixelsChanged: false, newViews: [] }));
      expect(blocks(await call('run_process', { processId: 'P', view: 'a' }))[0].hint).toMatch(/did nothing/);
    });

    it('does not say so for a process that made a new image instead', async () => {
      cli.script = script(() => ({ pixelsChanged: false, newViews: ['b'] }));
      expect(blocks(await call('run_process', { processId: 'P', view: 'a' }))[0].hint).toBeUndefined();
    });

    it('does not say so for a process that only writes metadata', async () => {
      cli.script = script(() => ({ pixelsChanged: false, newViews: [], metadataChanged: true }));
      expect(blocks(await call('run_process', { processId: 'P', view: 'a' }))[0].hint).toBeUndefined();
    });

    it('turns a refusal into a readable error', async () => {
      const result = await call('run_process', { processId: 'P' });
      expect(result.isError).toBe(true);
      expect(blocks(result)[0]).toMatchObject({ error: 'invalid_target', message: expect.any(String) });
    });

    it('returns an image with its data beside it', async () => {
      const imagePath = join(home, 'preview.jpg');
      await writeFile(imagePath, 'jpeg');
      cli.script = script(() => ({ imagePath, width: 2 }));
      const result = await call('get_preview', { view: 'a' });
      expect(result.content[0]).toMatchObject({ type: 'image', data: Buffer.from('jpeg').toString('base64') });
      // Not every client hands the picture to its model, and such a model can open the file.
      const [{ file, ...rest }] = blocks(result);
      expect(rest).toEqual({ width: 2 });
      expect((await readFile(file)).toString('base64')).toBe((result.content[0] as { data: string }).data);
    });
  });

  describe('the processing library', () => {
    const text = (result: Result) => result.content[0]?.text ?? '';
    const get = async (from: Client, name?: string | string[]) => text((await from.callTool({ name: 'get_guide', arguments: name === undefined ? {} : { name } })) as Result);
    const method = (title: string, needs: string) =>
      `---\ntitle: ${title}\nsummary: One way.\nstatus: tested\nevidence: One run.\nrequires: [${needs}]\nparameters: [${needs}.amount, ${needs}.detail]\n---\n\n## Steps\n\n1. Do it.\n\n## Check the result\n\n- Look.\n`;

    /** A small library of its own, so that these tests do not depend on which guides ship. */
    let library: LibraryDir[];
    let other: Awaited<ReturnType<typeof connect>>;
    /** What the fake installation has: one process of the library, with these parameters. */
    const installed = (parameters: string[]): Script =>
      script((job) => (job.op === 'list_processes' ? [{ id: 'Sharpener' }] : {}), { parameters: parameters.map((id) => ({ id, type: 'float', readOnly: false })) });

    beforeEach(async () => {
      const dir = join(home, 'library');
      const write = async (id: string, content: string) => {
        await mkdir(dirname(join(dir, id)), { recursive: true });
        await writeFile(join(dir, `${id}.md`), content);
      };
      await write('stages/sharpen', '---\ntitle: Sharpen\nsummary: Make it sharper.\n---\nSharpen first.\n');
      await write('methods/sharpen/sharpener', method('Sharpen with Sharpener', 'Sharpener'));
      await write('methods/sharpen/other', method('Sharpen another way', 'Other'));
      await write('practices/measure', '---\ntitle: Measure\nsummary: Numbers decide.\n---\nMeasure it.\n');
      await write('practices/look', '---\ntitle: Look\nsummary: Then look.\n---\nLook at it.\n');
      library = [{ dir, builtIn: true }];
      other = await connect({}, library);
    });

    afterEach(async () => {
      await other.close();
    });

    it('hands out a catalog, matched to what is installed', async () => {
      cli.script = installed([]);
      const catalog = await get(other.client);
      expect(catalog).toMatch(/^# Processing library$/m);
      expect(catalog).toMatch(/`methods\/sharpen\/sharpener`: One way\. Needs `Sharpener`\.$/m);
      expect(catalog).toMatch(/`methods\/sharpen\/other`: One way\. Needs `Other`\. Not installed here: `Other`\./);
    });

    it('still hands it out without PixInsight, and says that it could not match it', async () => {
      cli.remove(1);
      expect(await get(other.client)).toMatch(/PixInsight did not answer/);
      expect(await get(other.client, 'methods/sharpen/sharpener')).toMatch(/^# Sharpen with Sharpener[\s\S]*Not checked against this installation/);
    });

    it('does not trip over an answer that is no list of processes', async () => {
      cli.script = script(() => ({ unexpected: true }));
      expect(await get(other.client)).toMatch(/PixInsight did not answer/);
    });

    it('returns a guide as text to read, not as JSON', async () => {
      cli.script = installed(['amount', 'detail']);
      const guide = await get(other.client, 'methods/sharpen/sharpener');
      expect(guide).toMatch(/^# Sharpen with Sharpener\n/);
      expect(guide).toMatch(/## Check the result/);
      expect(guide).not.toMatch(/^---$|^title:|WARNING|Not checked/m);
    });

    it('warns if the installed version of a process has other parameters than the guide names', async () => {
      cli.script = installed(['amount']);
      expect(await get(other.client, 'methods/sharpen/sharpener')).toMatch(/\[!WARNING\]\n> This installation has no `Sharpener\.detail`\./);
    });

    it('says so if it could not compare a guide, because PixInsight is busy with a job', async () => {
      cli.script = (job, dir, pixinsight) => (job.op === 'long' ? undefined : installed(['amount', 'detail'])(job, dir, pixinsight));
      await get(other.client);
      other.session.jobs.submit('long', {});
      await waitUntil(() => cli.ran.some((job) => job.op === 'long'));
      expect(await get(other.client, 'methods/sharpen/sharpener')).toMatch(/Not checked against this installation, because PixInsight is busy/);
    });

    it('returns several guides in one call', async () => {
      expect(await get(other.client, ['practices/measure', 'practices/look'])).toMatch(/^# Measure[\s\S]*\n---\n\n# Look/);
    });

    it('shows the methods of a stage', async () => {
      expect(await get(other.client, 'stages/sharpen')).toMatch(/## Methods[\s\S]*`methods\/sharpen\/other`[\s\S]*`methods\/sharpen\/sharpener`/);
    });

    it('names similar guides when an id is wrong', async () => {
      const result = (await other.client.callTool({ name: 'get_guide', arguments: { name: 'sharpener' } })) as Result;
      expect(result.isError).toBe(true);
      expect(blocks(result)[0]).toMatchObject({ error: 'unknown_guide', message: expect.stringContaining('Did you mean methods/sharpen/sharpener?') });
    });

    it('serves the library that ships with the server by default', async () => {
      expect(text(await call('get_guide'))).toMatch(/## Workflows\n\n- `workflows\//);
    });

    it('adds the guides of a folder the user has set, says where they are from, and reads them anew on every call', async () => {
      const own = join(home, 'own-guides');
      const file = join(own, 'methods', 'stretch', 'mine.md');
      const mine = (title: string) =>
        `---\ntitle: ${title}\nsummary: My way.\nstatus: experimental\nevidence: One run.\n---\n\n## Steps\n\n1. Do it.\n\n## Check the result\n\n- Look.\n`;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, mine('First title'));
      const third = await connect({ guideDirs: [`${own}/`] });
      expect(await get(third.client, 'methods/stretch/mine')).toMatch(/^# First title[\s\S]*Not shipped with the server: from an additional folder/);
      await writeFile(file, mine('Second title'));
      expect(await get(third.client, 'methods/stretch/mine')).toMatch(/^# Second title/);
      await third.close();
    });
  });

  describe('a job that takes longer', () => {
    it('hands out a job id, and the result later', async () => {
      let finish!: () => Promise<void>;
      cli.script = script((_job, jobDir) => {
        finish = () => writeResult(jobDir, JSON.stringify({ ok: true, value: { pixelsChanged: true } }));
        return undefined;
      });
      const [pending] = blocks(await call('run_process', { processId: 'P', view: 'a', waitMs: 0 }));
      expect(pending).toMatchObject({ pending: true, jobId: expect.any(String) });
      await waitUntil(() => finish !== undefined);
      await finish();
      expect(blocks(await call('get_job', { jobId: pending.jobId, waitMs: 2000 }))[0]).toMatchObject({ pixelsChanged: true });
    });

    it('waits for the result when asked again, instead of answering "pending" at once', async () => {
      cli.script = script((_job, jobDir) => {
        setTimeout(() => void writeResult(jobDir, JSON.stringify({ ok: true, value: { late: true } })), 150);
        return undefined;
      });
      const [pending] = blocks(await call('get_image_stats', { view: 'a', waitMs: 0 }));
      expect(pending.pending).toBe(true);
      expect(blocks(await call('get_job', { jobId: pending.jobId }))[0]).toEqual({ late: true });
    });

    it('gives no job id for the list of processes, whose later result would lack the filter', async () => {
      const { tools: registered } = await client.listTools();
      expect(JSON.stringify(registered.find((tool) => tool.name === 'list_processes')?.inputSchema)).not.toMatch(/waitMs/);
    });

    it('reports an unknown job', async () => {
      expect(blocks(await call('get_job', { jobId: 'nope' }))[0].error).toBe('unknown_job');
    });
  });

  describe('cancel_job', () => {
    it('withdraws a queued job', async () => {
      cli.script = script(() => undefined);
      session.jobs.submit('stuck', {});
      await waitUntil(() => cli.ran.length === 1);
      const job = session.jobs.submit('close_image', {});
      expect(blocks(await call('cancel_job', { jobId: job.id }))[0]).toEqual({ cancelled: true });
    });

    it('explains the options for a job already in PixInsight, and can stop waiting for it', async () => {
      cli.script = script(() => undefined);
      const stuck = session.jobs.submit('stuck', {});
      await waitUntil(() => cli.ran.length === 1);
      const refused = await call('cancel_job', { jobId: stuck.id });
      expect(blocks(refused)[0]).toMatchObject({ error: 'already_running', message: expect.stringContaining('abandon') });
      expect(blocks(await call('cancel_job', { jobId: stuck.id, abandon: true }))[0]).toMatchObject({ abandoned: true, stillRuns: true, message: expect.stringContaining('goes on there') });
      expect((await session.jobs.get(stuck.id))?.error?.kind).toBe('abandoned');
    });
  });

  describe('a notice about a change of instance', () => {
    const changeInstance = async () => {
      cli.script = script(() => ({ pong: true }));
      await session.jobs.wait(session.jobs.submit('ping', {}).id, 2000);
      session.target.invalidate();
      cli.remove(1);
      cli.addInstance(2);
      await session.jobs.wait(session.jobs.submit('ping', {}).id, 2000);
      expect(session.target.notice).toBeDefined();
    };

    it.each([
      ['a tool that uses a job', 'list_images', {}],
      ['a tool that filters a job result', 'list_processes', {}],
      ['a tool that only reads a cache', 'describe_process', { processId: 'P' }],
      ['a tool that does not wait for anything', 'get_job', { jobId: 'nope' }],
    ])('reaches the assistant through %s, once', async (_name, tool, args) => {
      cli.script = script(() => []);
      await changeInstance();
      cli.script = script(() => []);
      const first = blocks(await call(tool, args));
      expect(first.at(-1).notice).toMatch(/Now working with slot 2/);
      const second = blocks(await call(tool, args));
      expect(second.at(-1).notice).toBeUndefined();
    });

    it('is not lost with a call that the client gave up on', async () => {
      await changeInstance();
      cli.script = script(() => undefined);
      const controller = new AbortController();
      const abandoned = client.callTool({ name: 'get_image_stats', arguments: { view: 'a' } }, { signal: controller.signal });
      await waitUntil(() => cli.ran.some((job) => job.op === 'image_stats'));
      controller.abort();
      await abandoned.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(session.target.notice).toBeDefined();
      expect(blocks(await call('get_status')).at(-1).notice).toMatch(/Now working with slot 2/);
    });

    it('accompanies the refusal of a job, and then lets the next one go', async () => {
      await changeInstance();
      const refused = await call('close_image', { view: 'a' });
      expect(refused.isError).toBe(true);
      const [error, notice] = blocks(refused);
      expect(error.error).toBe('instance_changed');
      expect(notice.notice).toMatch(/Now working with slot 2/);
      expect((await call('close_image', { view: 'a' })).isError).toBeUndefined();
    });
  });
});
