import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessCli } from '../../src/bridge/cli.js';
import { ManagedInstance } from '../../src/bridge/instance.js';
import type { JobSnapshot } from '../../src/bridge/jobs.js';
import type { Config } from '../../src/config.js';
import { prepareHome } from '../../src/home.js';
import { scriptBlockReason } from '../../src/policy.js';
import { Session } from '../../src/session.js';
import { EXECUTABLE, removeFilesOfSlots, removeSwapFilesSince, run, slotsOf, startLiveSession, WORKER_SLOT, type LiveSession } from './harness.js';

type Stats = { channels: Array<{ median: number }> };
type Report = {
  newViews: string[];
  closedViews: string[];
  changedViews: Array<{ view: string; changed: string[]; historyIndex: number; steps: number; note?: string }>;
  script?: string;
  startedOn?: string | null;
  activeAfter?: string | null;
  value?: unknown;
};

/** A script of the user as it is when the server starts. */
const CHANGING = '#feature-id McpLiveChanging : Utilities > McpLiveChanging\nconsole.writeln( "MCPLIVE as the user left it" );\n';

const median = async (session: Session, view: string) => (await run<Stats>(session, 'image_stats', { view })).channels[0]!.median;

// Stands in for the PixInsight a user sits at. Its slot is always set explicitly, because otherwise
// these tests would attach to whatever PixInsight the developer has open.
const USER_SLOT = WORKER_SLOT + 5;
const SHADOW_SLOT = WORKER_SLOT + 6;

describe.skipIf(!existsSync(EXECUTABLE))('scripts of the Script menu, in shared mode', { timeout: 120_000 }, () => {
  const startedAt = Date.now();
  let home: string;
  let userHome: string;
  let scriptsDir: string;
  let session: Session;
  let user: ManagedInstance;

  const config = (): Config => ({
    executable: EXECUTABLE,
    mode: 'shared',
    slot: USER_SLOT,
    workerSlot: WORKER_SLOT,
    shadowSlot: SHADOW_SLOT,
    headless: true,
    home,
    allowedPrograms: [],
    guideDirs: [],
    scriptDirs: [scriptsDir],
    allowCode: false,
  });

  const newImage = async (id: string, level: number) => {
    const created = await session.jobs.wait(
      session.runProcess({ processId: 'NewImage', global: true, params: { id, width: 64, height: 32, numberOfChannels: 3, colorSpace: 'RGB', v0: level, v1: level, v2: level } }).id,
      30_000,
    );
    expect(created.state).toBe('succeeded');
  };

  const start = (script: string, view?: string, timeoutMs = 60_000): Promise<JobSnapshot> => session.jobs.wait(session.startScript({ script, view }).id, timeoutMs);

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-scripts-'));
    userHome = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-user-'));
    scriptsDir = join(home, 'my-scripts');
    await mkdir(scriptsDir, { recursive: true });

    // In the classic engine, like nearly every script of the Script menu.
    await writeFile(
      join(scriptsDir, 'McpLiveStep.js'),
      `#feature-id    McpLiveStep : Utilities > McpLiveStep
#feature-info  Changes the active image in one step and makes a new one, \\
               for a <b>test</b>.
var w = ImageWindow.activeWindow;
console.writeln( "MCPLIVE active=" + w.mainView.id + " viewTarget=" + Parameters.isViewTarget + " globalTarget=" + Parameters.isGlobalTarget + " args=" + jsArguments.length );
var P = new PixelMath;
P.expression = "$T*0.5 + 0.1";
P.useSingleExpression = true;
P.createNewImage = false;
P.executeOn( w.mainView );
var made = new ImageWindow( 16, 8, 1, 32, true, false, "mcp_script_made" );
made.show();
`,
    );
    await writeFile(
      join(scriptsDir, 'McpLiveSilent.js'),
      `#engine v8
#feature-id McpLiveSilent : Utilities > McpLiveSilent
const view = ImageWindow.activeWindow.mainView;
view.beginProcess( UndoFlag.NoSwapFile );
view.image.fill( 0.75 );
view.endProcess();
`,
    );
    await writeFile(
      join(scriptsDir, 'McpLiveKeyword.js'),
      `#engine v8
#feature-id McpLiveKeyword : Utilities > McpLiveKeyword
const window = ImageWindow.activeWindow;
window.keywords = window.keywords.concat( [ new FITSKeyword( "MCPLIVE", "1", "from a test" ) ] );
`,
    );
    await writeFile(join(scriptsDir, 'McpLiveMount.js'), '#feature-id McpLiveMount : Instrumentation > McpLiveMount\nconsole.writeln( "MCPLIVE must not run" );\n');
    await writeFile(join(scriptsDir, 'McpLiveChanging.js'), CHANGING);
    await writeFile(
      join(scriptsDir, 'McpLiveRecursion.js'),
      `#feature-id McpLiveRecursion : Utilities > McpLiveRecursion
var P = new Script;
P.filePath = "${join(scriptsDir, 'McpLiveStep.js')}";
console.writeln( "MCPLIVE recursion=" + P.executeGlobal() );
`,
    );
    await writeFile(
      join(scriptsDir, 'McpLiveDialog.js'),
      `#feature-id McpLiveDialog : Utilities > McpLiveDialog
var dialog = new Dialog;
dialog.windowTitle = "MCP live test";
dialog.execute();
`,
    );

    const cli = new ProcessCli(EXECUTABLE, { headless: true, cwd: userHome });
    user = new ManagedInstance(cli, [USER_SLOT], await prepareHome(userHome));
    await user.resolve();
    session = await Session.create(config());
    await newImage('mcp_script_a', 0.4);
    // Made last, so this is the active image, and not the one the scripts are started on.
    await newImage('mcp_script_b', 0.6);
  }, 120_000);

  afterAll(async () => {
    await session?.close();
    await user?.stop();
    await rm(home, { recursive: true, force: true });
    await rm(userHome, { recursive: true, force: true });
    await removeFilesOfSlots([USER_SLOT, ...slotsOf(config())], startedAt);
    await removeSwapFilesSince(startedAt);
  });

  it('finds the scripts PixInsight ships where PixInsight says they are, and those in a folder of the user', async () => {
    const ping = await run<{ scriptsDir: string }>(session, 'ping');
    expect(existsSync(ping.scriptsDir)).toBe(true);

    const scripts = await session.scripts();
    expect(scripts.length).toBeGreaterThan(20);
    const solver = scripts.find((script) => script.name === 'ImageSolver');
    expect(solver?.path.startsWith(ping.scriptsDir)).toBe(true);
    expect(solver?.menus.length).toBeGreaterThan(0);
    expect(scripts.find((script) => script.name === 'McpLiveStep')).toEqual({
      name: 'McpLiveStep',
      menus: ['Utilities > McpLiveStep'],
      info: 'Changes the active image in one step and makes a new one, for a test.',
      path: join(scriptsDir, 'McpLiveStep.js'),
      source: 'user',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(solver?.source).toBe('shipped');

    // Two scripts that PixInsight ships carry one name, and differ in their menu item only.
    const twin = join(ping.scriptsDir, 'NoiseEvaluation', 'NoiseEvaluationCFA.js');
    if (existsSync(twin)) {
      expect(scripts.find((script) => script.path === twin)?.name).toBe('NoiseEvaluation (CFA Bayer)');
      expect(scripts.find((script) => script.name === 'NoiseEvaluation')?.path).toBe(join(ping.scriptsDir, 'NoiseEvaluation', 'NoiseEvaluation.js'));
    }
    expect(new Set(scripts.map((script) => script.name.toLowerCase())).size).toBe(scripts.length);
  });

  it('runs a script on the image it was started on, and reports what the script did and wrote', async () => {
    const before = await median(session, 'mcp_script_a');
    const done = await start('McpLiveStep', 'mcp_script_a');
    expect(done.state).toBe('succeeded');
    const report = done.value as Report;

    expect(report).toMatchObject({ script: 'McpLiveStep', startedOn: 'mcp_script_a', activeAfter: 'mcp_script_made', newViews: ['mcp_script_made'], closedViews: [] });
    expect(report.changedViews).toEqual([{ view: 'mcp_script_a', changed: ['history'], historyIndex: expect.any(Number), steps: 1 }]);
    // PixInsight gives a script from the command line its arguments, and no target to run on.
    expect(done.log).toContain('MCPLIVE active=mcp_script_a viewTarget=false globalTarget=false args=0');
    // Only what the script wrote, without what PixInsight notes about commands from outside.
    expect(done.log?.join('\n')).not.toMatch(/IPC execute command|Processing script file|^run -/m);

    // The real effect, on this image and not on the one that was active before.
    expect(await median(session, 'mcp_script_a')).toBeCloseTo(before * 0.5 + 0.1, 4);
    expect(await median(session, 'mcp_script_b')).toBeCloseTo(0.6, 4);
    // The step is in the history, so the assistant can take it back.
    await run(session, 'undo', { view: 'mcp_script_a', count: report.changedViews[0]!.steps, historyIndex: report.changedViews[0]!.historyIndex });
    expect(await median(session, 'mcp_script_a')).toBeCloseTo(before, 4);
  });

  it('runs a script that PixInsight ships, and keeps the note about its signature out of the log', async () => {
    const done = await start('NoiseEvaluation', 'mcp_script_a');
    expect(done.state).toBe('succeeded');
    expect(done.log?.length).toBeGreaterThan(0);
    expect(done.log?.join('\n')).not.toMatch(/Code signature verified|^developer-id|^script-id/m);
    expect((done.value as Report).changedViews).toEqual([]);
  });

  it('says so when a script changed pixels with no step in the history', async () => {
    const done = await start('McpLiveSilent', 'mcp_script_b');
    expect(done.state).toBe('succeeded');
    expect((done.value as Report).changedViews).toEqual([
      { view: 'mcp_script_b', changed: ['pixels'], historyIndex: expect.any(Number), steps: 0, note: expect.stringMatching(/no step in the history/) },
    ]);
    expect(await median(session, 'mcp_script_b')).toBeCloseTo(0.75, 4);
  });

  it('notices a script that only changed a value in the metadata, as solving an image again does', async () => {
    const done = await start('McpLiveKeyword', 'mcp_script_b');
    expect(done.state).toBe('succeeded');
    expect((done.value as Report).changedViews).toEqual([{ view: 'mcp_script_b', changed: ['metadata'], historyIndex: expect.any(Number), steps: 0 }]);
  });

  it('brings the image to the front once more right before the script, and ends the log it started', async () => {
    await run(session, 'prepare_script', { view: 'mcp_script_b' });
    const log = join(home, 'front.log');
    await session.cli.execute(USER_SLOT, session.paths.beginLogPath, [log, 'mcp_script_a']);
    await session.cli.execute(USER_SLOT, session.paths.endLogPath, []);
    const images = await run<Array<{ view: string; active: boolean }>>(session, 'list_images');
    expect(images.find((image) => image.active)?.view).toBe('mcp_script_a');
    expect(existsSync(log)).toBe(true);
  });

  it('does not start a script of the user that was changed after the server started, which would be a way to run code', async () => {
    expect((await start('McpLiveChanging')).log).toContain('MCPLIVE as the user left it');
    await writeFile(join(scriptsDir, 'McpLiveChanging.js'), `${CHANGING}new ImageWindow( 8, 8, 1, 32, true, false, "mcp_script_smuggled" ).show();\n`);
    expect((await start('McpLiveChanging')).error?.kind).toBe('script_changed');
    await writeFile(join(scriptsDir, 'McpLiveLater.js'), '#feature-id McpLiveLater : Utilities > McpLiveLater\n');
    expect((await start('McpLiveLater')).error?.kind).toBe('unknown_script');
    // Back to what it was, it is the script of the user again.
    await writeFile(join(scriptsDir, 'McpLiveChanging.js'), CHANGING);
    expect((await start('McpLiveChanging')).state).toBe('succeeded');
  });

  it('still cannot run a script with parameters from another script, which is why there is no unattended way', async () => {
    const done = await start('McpLiveRecursion');
    expect(done.state).toBe('succeeded');
    expect(done.log).toContain('MCPLIVE recursion=false');
    expect(done.log?.join('\n')).toMatch(/recursively/);
    // The script it tried to run would have made this image again.
    expect((done.value as Report).newViews).toEqual([]);
  });

  it('refuses what it must not start, and starts nothing', async () => {
    expect((await start('McpLiveNoSuchScript')).error?.kind).toBe('unknown_script');
    expect((await start('McpLiveStep', 'mcp_no_such_image')).error?.kind).toBe('unknown_view');
    expect((await start('McpLiveMount')).error?.kind).toBe('blocked_script');
    // The same holds for what PixInsight ships in such a menu, if it ships any.
    const shipped = (await session.scripts()).find((script) => script.source === 'shipped' && scriptBlockReason(script.menus));
    if (shipped) expect((await start(shipped.name)).error?.kind).toBe('blocked_script');
    const images = await run<Array<{ view: string }>>(session, 'list_images');
    expect(images.map((image) => image.view).sort()).toEqual(['mcp_script_a', 'mcp_script_b', 'mcp_script_made']);
  });

  // Last, because nobody can close a dialog in an instance without a window: it has to be ended.
  it('waits while a script shows its dialog, lets nothing else through, and reports the loss of the instance', async () => {
    const job = session.startScript({ script: 'McpLiveDialog' });
    const pending = await session.jobs.wait(job.id, 3000);
    expect(pending).toMatchObject({ done: false, state: 'sent' });

    const behind = session.jobs.submit('list_images', {});
    const deadline = Date.now() + 20_000;
    while (!(await session.jobs.get(job.id))?.waitingForInput && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await session.jobs.get(job.id)).toMatchObject({ done: false, state: 'sent', waitingForInput: true });
    expect((await session.jobs.get(behind.id))?.state).toBe('queued');

    // Only ever the instance this test started itself.
    const pid = user.current()?.pid;
    expect(pid).toEqual(expect.any(Number));
    expect((await session.instances())?.find((instance) => instance.slot === USER_SLOT)?.pid).toBe(pid);
    process.kill(pid as number, 'SIGKILL');
    user.invalidate();

    expect(await session.jobs.wait(job.id, 20_000)).toMatchObject({ state: 'lost', error: { kind: 'instance_lost' } });
  });
});

describe.skipIf(!existsSync(EXECUTABLE))('code of the assistant', { timeout: 120_000 }, () => {
  let live: LiveSession;
  const code = async (source: string): Promise<JobSnapshot> => live.session.jobs.wait(live.session.runCode(source).id, 60_000);

  beforeAll(async () => {
    live = await startLiveSession({ allowCode: true });
  }, 120_000);

  afterAll(async () => {
    await live?.cleanup();
  });

  it('returns what the code returns, also values that JSON has no type for', async () => {
    const done = await code('return { build: CoreApplication.versionBuild, big: 12345678901234567890n, typed: new Float32Array( [ 0.5, 0.25 ] ) };');
    expect(done.state).toBe('succeeded');
    expect(done.value).toMatchObject({ value: { build: expect.any(Number), big: '12345678901234567890', typed: [0.5, 0.25] }, newViews: [], closedViews: [], changedViews: [] });
    expect((await code('const nothing = 1;')).value).toMatchObject({ value: null });
  });

  it('reports the images the code made and changed, and what it wrote to the console', async () => {
    const made = await code(`
      const window = new ImageWindow( 24, 12, 1, 32, true, false, "mcp_code" );
      window.show();
      const view = window.mainView;
      view.beginProcess();
      view.image.fill( 0.25 );
      view.endProcess();
      console.writeln( "MCPCODE filled" );
      return view.image.median();`);
    expect(made.state).toBe('succeeded');
    expect(made.value).toMatchObject({ value: 0.25, newViews: ['mcp_code'] });
    expect(made.log).toContain('MCPCODE filled');

    const changed = await code('const view = View.viewById( "mcp_code" ); view.beginProcess(); view.image.fill( 0.5 ); view.endProcess(); return 1;');
    const [change] = (changed.value as Report).changedViews;
    expect(change).toEqual({ view: 'mcp_code', changed: ['history'], historyIndex: expect.any(Number), steps: 1 });
    expect(await median(live.session, 'mcp_code')).toBeCloseTo(0.5, 5);
    // A step between beginProcess and endProcess is in the history, as the tool tells the assistant.
    await run(live.session, 'undo', { view: 'mcp_code', count: change!.steps, historyIndex: change!.historyIndex });
    expect(await median(live.session, 'mcp_code')).toBeCloseTo(0.25, 5);
  });

  it('says so when the code changed pixels with no step in the history', async () => {
    const done = await code('const view = View.viewById( "mcp_code" ); view.beginProcess( UndoFlag.NoSwapFile ); view.image.fill( 0.9 ); view.endProcess(); return 1;');
    expect((done.value as Report).changedViews).toEqual([
      { view: 'mcp_code', changed: ['pixels'], historyIndex: expect.any(Number), steps: 0, note: expect.stringMatching(/no step in the history/) },
    ]);
    expect(await median(live.session, 'mcp_code')).toBeCloseTo(0.9, 5);
  });

  it('explains code that does not compile, and code that throws, with the line and with what it left behind', async () => {
    const broken = await code('const a = ;');
    expect(broken).toMatchObject({ state: 'failed', error: { kind: 'code_error', message: expect.stringMatching(/does not compile/) } });

    const thrown = await code('const a = 1;\nnew ImageWindow( 8, 8, 1, 32, true, false, "mcp_code_left" ).show();\nnoSuchFunction();\nreturn a;');
    expect(thrown.state).toBe('failed');
    expect(thrown.error?.kind).toBe('code_error');
    expect(thrown.error?.message).toMatch(/The code threw \(line 3\): .*noSuchFunction/);
    expect(thrown.error?.message).toMatch(/left behind: new images mcp_code_left\./);
  });

  it('refuses a value that would flood the conversation, and one that is no value', async () => {
    expect((await code('return "x".repeat( 70000 );')).error).toMatchObject({ kind: 'code_error', message: expect.stringMatching(/70002 characters/) });
    expect((await code('return Promise.resolve( 1 );')).error).toMatchObject({ kind: 'code_error', message: expect.stringMatching(/promise/) });
    expect((await code('const a = {}; a.self = a; return a;')).error).toMatchObject({ kind: 'code_error', message: expect.stringMatching(/cannot be turned into JSON/) });
  });

  it('does not run in a server where the user has not turned it on', async () => {
    const config = { ...live.config, allowCode: false };
    const plain = await Session.create(config);
    const done = await plain.jobs.wait(plain.runCode('return 1;').id, 30_000);
    expect(done.error?.kind).toBe('blocked_code');
    // Not close(): that would stop the instance both sessions use.
    await plain.jobs.close();
  });
});
