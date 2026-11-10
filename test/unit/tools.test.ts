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
import { FakePixInsight, sleep, waitUntil, writeResult, type Script } from './fakes.js';

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
      { executable: '/nowhere', mode: 'shared', slot: undefined, workerSlot: 200, shadowSlot: 250, headless: true, home, allowedPrograms: [], guideDirs: [], scriptDirs: [], allowCode: false, ...config },
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
      const { tools: registered } = await client.listTools();
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
      const notInTheList = ['get_job', 'cancel_job', 'get_guide', 'list_scripts', 'start_script'];
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
