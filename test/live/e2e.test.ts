import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessCli } from '../../src/bridge/cli.js';
import { EXECUTABLE, jpegSize, removeFilesOfSlots, SHADOW_SLOT, WORKER_SLOT } from './harness.js';

const SERVER = resolve('dist/index.js');
const VIEW = 'mcp_e2e';

type Result = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };

/** Talks to the built server the way a real MCP host does: as a child process over stdio. */
describe.skipIf(!existsSync(EXECUTABLE))('over MCP', { timeout: 120_000 }, () => {
  let client: Client;
  let home: string;
  const startedAt = Date.now();

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Result> =>
    (await client.callTool({ name, arguments: args })) as Result;
  const json = (result: Result): any => JSON.parse(result.content.find((block) => block.type === 'text')?.text ?? 'null');

  const connect = async (settings: Record<string, string> = {}): Promise<Client> => {
    const connected = new Client({ name: 'live-test', version: '1.0.0' });
    await connected.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER],
        env: {
          ...(process.env as Record<string, string>),
          PIXINSIGHT_EXECUTABLE: EXECUTABLE,
          PIXINSIGHT_MCP_MODE: 'worker',
          PIXINSIGHT_MCP_WORKER_SLOT: String(WORKER_SLOT),
          PIXINSIGHT_MCP_SHADOW_SLOT: String(SHADOW_SLOT),
          PIXINSIGHT_MCP_HEADLESS: '1',
          PIXINSIGHT_MCP_HOME: home,
          ...settings,
        },
        stderr: 'ignore',
      }),
    );
    return connected;
  };

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-e2e-'));
    client = await connect();
  }, 60_000);

  afterAll(async () => {
    // A worker with unsaved images is left running on purpose, so they go first.
    const open = (json(await call('list_images')) as Array<{ view: string }>).map((image) => image.view);
    if (open.length) await call('close_image', { view: open, discardChanges: open });
    await client?.close();
    // Closing the pipe stops the server, which stops its own instances.
    await new Promise((done) => setTimeout(done, 4000));
    const stillThere = await new ProcessCli(EXECUTABLE, { headless: true, cwd: tmpdir() }).enumerate();
    await rm(home, { recursive: true, force: true });
    await removeFilesOfSlots([WORKER_SLOT, SHADOW_SLOT, SHADOW_SLOT + 1], startedAt);
    expect(stillThere?.filter((instance) => [WORKER_SLOT, SHADOW_SLOT].includes(instance.slot) && !instance.crashed)).toEqual([]);
  });

  it('offers the tools with usable schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'get_status',
        'list_processes',
        'describe_process',
        'run_process',
        'list_images',
        'get_preview',
        'undo',
        'get_job',
        'create_preview',
        'delete_preview',
        'duplicate_image',
        'export_image',
        'get_guide',
      ]),
    );
    const run = tools.find((tool) => tool.name === 'run_process');
    expect(run?.inputSchema.properties).toHaveProperty('processId');
    expect(run?.annotations?.destructiveHint).toBe(true);
    expect(client.getInstructions()).toMatch(/Never resend a pending job/);
  });

  it('starts its worker on demand and reports the status', async () => {
    // A start can take longer than get_status waits, and it then says so.
    const deadline = Date.now() + 60_000;
    let status = json(await call('get_status'));
    while (!status.pixinsight && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 500));
      status = json(await call('get_status'));
    }
    expect(status.mode).toBe('worker');
    expect(status.pixinsight.instance).toBe(WORKER_SLOT);
  });

  it('hands out the processing library, matched to this installation', async () => {
    const catalog = (await call('get_guide')).content[0]?.text ?? '';
    // The rules open the catalog, for a client that does not pass the instructions on to its model.
    expect(catalog).toMatch(/^# Working in PixInsight\n\nYou work in a PixInsight instance of your own/);
    expect(catalog.indexOf('Only the user can allow you')).toBeLessThan(catalog.indexOf('# Processing library'));
    expect(catalog).toMatch(/`workflows\/sho-narrowband`/);
    expect(catalog).toMatch(/`methods\/stretch\/histogram-transformation`: .* Needs `HistogramTransformation`\.$/m);
    expect(catalog).not.toMatch(/did not answer|Files with problems/);

    const method = (await call('get_guide', { name: 'methods/stretch/histogram-transformation' })).content[0]?.text ?? '';
    expect(method).toMatch(/^# Stretch with HistogramTransformation/);
    expect(method).not.toMatch(/WARNING/);
  });

  it('filters the process list', async () => {
    const processes = json(await call('list_processes', { search: 'pixelmath' }));
    expect(processes.map((process: { id: string }) => process.id)).toEqual(['PixelMath']);
  });

  it('marks blocked processes in the list and refuses them', async () => {
    const [preferences] = json(await call('list_processes', { search: 'Preferences' }));
    expect(preferences.blocked).toEqual(expect.any(String));
    const refused = await call('run_process', { processId: 'Preferences', global: true });
    expect(refused.isError).toBe(true);
    expect(json(refused).error).toBe('blocked_process');
  });

  it('works through a small session: create, process, look, undo', async () => {
    const created = await call('run_process', {
      processId: 'NewImage',
      global: true,
      params: { id: VIEW, width: 640, height: 480, numberOfChannels: 3, colorSpace: 'RGB', v0: 0.05, v1: 0.05, v2: 0.05 },
    });
    expect(created.isError).toBeUndefined();
    expect(json(created).newViews).toEqual([VIEW]);

    const processed = await call('run_process', {
      processId: 'PixelMath',
      view: VIEW,
      params: { expression: '0.03 + 0.5*exp(-((X()-0.5)^2 + (Y()-0.5)^2)/0.01)', useSingleExpression: true, createNewImage: false },
      description: 'e2e test',
    });
    expect(processed.isError).toBeUndefined();
    expect(json(processed)).toMatchObject({ pixelsChanged: true, stats: expect.any(Array), log: expect.any(Array) });
    expect(json(processed).hint).toBeUndefined();

    const idle = await call('run_process', {
      processId: 'PixelMath',
      view: VIEW,
      params: { expression: '$T', useSingleExpression: true, createNewImage: false },
    });
    expect(json(idle)).toMatchObject({ pixelsChanged: false, hint: expect.stringMatching(/did nothing/) });
    await call('undo', { view: VIEW });

    const stats = json(await call('get_image_stats', { view: VIEW }));
    expect(stats.channels).toHaveLength(3);

    const preview = await call('get_preview', { view: VIEW, maxSize: 320 });
    const image = preview.content.find((block) => block.type === 'image');
    expect(image?.mimeType).toBe('image/jpeg');
    expect(Buffer.from(image?.data ?? '', 'base64').subarray(0, 3).toString('hex')).toBe('ffd8ff');
    expect(json(preview)).toMatchObject({ width: 320, height: 240, stretch: 'auto' });
    expect(jpegSize(Buffer.from(image?.data ?? '', 'base64'))).toEqual({ width: 320, height: 240 });
    expect(JSON.stringify(json(preview))).not.toContain('imagePath');
    // For a client that does not hand pictures to its model: the same JPEG, as a file it can open.
    const { file } = json(preview);
    expect(file).toMatch(new RegExp(`^${join(home, 'jobs')}.[0-9a-f-]{36}.preview\\.jpg$`));
    expect((await readFile(file)).toString('base64')).toBe(image?.data);

    const images = json(await call('list_images'));
    expect(images[0]).toMatchObject({ view: VIEW, modified: true, canUndo: true });

    const kept = await call('close_image', { view: VIEW });
    expect(kept.isError).toBe(true);
    expect(json(kept).error).toBe('unsaved_changes');

    expect(json(await call('undo', { view: VIEW })).canRedo).toBe(true);
  });

  it('gives the model a readable error instead of a protocol failure', async () => {
    const refused = await call('run_process', { processId: 'PixelMath', view: VIEW, params: { expresion: '1' } });
    expect(refused.isError).toBe(true);
    expect(json(refused)).toMatchObject({ error: 'unknown_parameter' });
    expect(json(refused).message).toMatch(/silently ignore/);

    const failed = await call('run_process', { processId: 'PixelMath', view: VIEW, params: { expression: 'nope(', useSingleExpression: true } });
    expect(failed.isError).toBe(true);
    expect(json(failed).console.join('\n')).toMatch(/\*\*\* Error/);
  });

  it('offers code of the assistant only where the user has turned it on, and scripts only next to a window', async () => {
    const names = async (from: Client) => (await from.listTools()).tools.map((tool) => tool.name);
    expect(await names(client)).not.toContain('run_code');
    expect(await names(client)).not.toContain('start_script');

    // Listing tools needs no PixInsight, so these start none.
    const withCode = await connect({ PIXINSIGHT_MCP_ALLOW_CODE: '1' });
    expect(await names(withCode)).toContain('run_code');
    await withCode.close();

    // A slot outside those kept for shadow instances, which the server would refuse to work with.
    const shared = await connect({ PIXINSIGHT_MCP_MODE: 'shared', PIXINSIGHT_SLOT: String(WORKER_SLOT + 9) });
    expect(await names(shared)).toEqual(expect.arrayContaining(['list_scripts', 'start_script']));
    expect(await names(shared)).not.toContain('run_code');
    await shared.close();
  });

  it('leaves the instances of another server alone, as when a client opens a second session', async () => {
    await call('run_process', { processId: 'PixelMath', view: VIEW, params: { expression: '$T', useSingleExpression: true, createNewImage: false, newImageColorSpace: 'Gray' } });
    const before = json(await call('get_status')).instances;
    expect(before.map((instance: { role?: string }) => instance.role)).toEqual(expect.arrayContaining(['worker', 'shadow']));

    const second = await connect();
    const status = JSON.parse(((await second.callTool({ name: 'get_status', arguments: {} })) as Result).content[0]?.text ?? 'null');
    expect(status.pixinsight).toBeNull();
    expect(status.problem).toMatch(/another running server/);
    await second.close();
    await new Promise((done) => setTimeout(done, 3000));

    expect(json(await call('get_status')).instances).toEqual(before);
    expect(json(await call('list_images')).map((image: { view: string }) => image.view)).toContain(VIEW);
  });

  it('hands out a job id when a process takes longer than the caller wants to wait', async () => {
    const started = await call('run_process', {
      processId: 'NewImage',
      global: true,
      params: { id: 'mcp_e2e_later', width: 64, height: 64 },
      waitMs: 0,
    });
    expect(json(started)).toMatchObject({ pending: true, state: expect.any(String) });
    const { jobId } = json(started);
    const finished = await call('get_job', { jobId, waitMs: 15_000 });
    expect(json(finished).newViews).toEqual(['mcp_e2e_later']);
    expect((await call('get_job', { jobId: 'nope' })).isError).toBe(true);
  });
});
