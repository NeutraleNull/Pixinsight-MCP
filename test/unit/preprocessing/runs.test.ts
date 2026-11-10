import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SlotLeases } from '../../../src/bridge/lease.js';
import { groupsIn, outcomeIn, PreprocessRuns, referencesIn, type RunSnapshot } from '../../../src/preprocessing/runs.js';
import { FakePixInsight, pix, waitUntil } from '../fakes.js';

/** Lines as PixInsight writes them to a log: each with the time in front. */
const logged = (lines: string[]): string => `${lines.map((line) => `[2026-11-10 18:54:14] ${line}`).join('\n')}\n`;

/** A report as WBPP 3.2.0 writes it, cut down to what is read from it. */
const REPORT = `** Warning: 1 problem(s) found before the execution; see the log file.
******************** MASTER FLAT GENERATION ********************
Group of 4 Flat frames (4 active)
SIZE  : 480x320
BINNING  : 1
Filter   : L
Exposure : 2.00s
Keywords : [SESSION: 2]
Mode     : calibration

Master bias: /data/out/master/masterBias_BIN-1_480x320.xisf
Master dark: none
Master flat: none

Calibration completed: 4 Flat frames calibrated.
****************************************************************

******************** LIGHT FRAMES CALIBRATION ********************
Group of 6 Light frames (6 active)
Filter   : L
Exposure : 60.00s
Keywords : [SESSION: 1]
Master bias: C:\\data\\out\\master\\masterBias_BIN-1_480x320.xisf
Master dark: none
Master flat: none
******************************************************************
******************** LIGHT FRAMES CALIBRATION ********************
Group of 6 Light frames (5 active)
Filter   : L
Exposure : 60.00s
Keywords : [SESSION: 2]
Master bias: /data/out/master/masterBias_BIN-1_480x320.xisf
Master dark: none
Master flat: /data/out/master/masterFlat_BIN-1_480x320_FILTER-L_mono_SESSION-2.xisf
******************************************************************
******************** IMAGE REGISTRATION ********************
Group of 12 Light frames (11 active)
Keywords : []
`;

describe('what a report of WBPP says about the calibration', () => {
  it('names for each group what it was calibrated with, by the file of each master', () => {
    expect(groupsIn(REPORT)).toEqual([
      // A group of flats has no flat to be calibrated with, so that line is not a finding.
      { step: 'master flat generation', frames: '4 Flat frames (4 active)', filter: 'L', exposure: '2.00s', keywords: '[SESSION: 2]', masterBias: 'masterBias_BIN-1_480x320.xisf', masterDark: 'none' },
      { step: 'light frames calibration', frames: '6 Light frames (6 active)', filter: 'L', exposure: '60.00s', keywords: '[SESSION: 1]', masterBias: 'masterBias_BIN-1_480x320.xisf', masterDark: 'none', masterFlat: 'none' },
      {
        step: 'light frames calibration',
        frames: '6 Light frames (5 active)',
        filter: 'L',
        exposure: '60.00s',
        keywords: '[SESSION: 2]',
        masterBias: 'masterBias_BIN-1_480x320.xisf',
        masterDark: 'none',
        masterFlat: 'masterFlat_BIN-1_480x320_FILTER-L_mono_SESSION-2.xisf',
      },
    ]);
  });

  it('finds nothing in a text that reads otherwise, instead of guessing', () => {
    expect(groupsIn('')).toEqual([]);
    expect(groupsIn('Group of 3 Light frames\nMaster flat: none\n')).toEqual([]);
    expect(groupsIn('***** SOMETHING NEW *****\nGroup of 3 Light frames\nMaster flat: none\n')).toEqual([]);
  });
});

describe('the frame that a run registered to', () => {
  it('is read from the log, whether WBPP chose it or was given it, once each', () => {
    const chosen = '[2026-11-10 20:29:13] Best reference frame for registration - auto selection completed: /out/calibrated/Light_FILTER-R/r_0002_c.xisf';
    const given = '[2026-11-10 20:43:26] Best reference frame, manually selected: /first/calibrated/Light_FILTER-R/r_0002_c.xisf  ';
    expect(referencesIn(`* Begin selection of the best reference frame\n${chosen}\nReference image: /out/other.xisf\n`)).toEqual(['/out/calibrated/Light_FILTER-R/r_0002_c.xisf']);
    expect(referencesIn(`${given}\r\n${given}\n`)).toEqual(['/first/calibrated/Light_FILTER-R/r_0002_c.xisf']);
    expect(referencesIn('* Begin registration of light frames\n')).toEqual([]);
  });
});

describe('what a run says about itself', () => {
  it('reads the summary with what failed, and what was found before the run, once', () => {
    const outcome = outcomeIn(
      ['WBPP AUTOMATION MODE', 'Diagnostics:', 'Warning: Cosmetic Correction requires a master dark.', '** Warning: Problems found before the execution:', '** Warning: Diagnostics: Cosmetic Correction requires a master dark.', '* Begin integration of Bias frames', '** Warning: not before the run'],
      ['* End autocrop of master light frames.', 'Execution summary', '14 operation(s) completed, 2 failed, 0 canceled or not executed.', '*** Failed: Integration [Light frames, L]: Error closing output file', 'No frames have been excluded from the execution.', 'Smart report result', 'Group of 3 Bias frames (3 active)', '* Weighted Batch Preprocessing: 48.208 s'],
    );
    expect(outcome).toEqual({
      summary: ['14 operation(s) completed, 2 failed, 0 canceled or not executed.', '*** Failed: Integration [Light frames, L]: Error closing output file', 'No frames have been excluded from the execution.'],
      problems: ['Cosmetic Correction requires a master dark.'],
      complete: true,
      notStarted: null,
      stopped: null,
    });
  });

  it('takes a reason that runs over several lines as one, and tells a run that stopped from one that never started', () => {
    const refused = outcomeIn(
      ['automation mode parameter: platesolve = maybe', '*** Error: Invalid automation parameters: Parsing integer expression: conversion error:', 'maybe', '^', '*** Error: Weighted Batch Preprocessing automation run not started: Invalid automation parameters: Parsing integer expression: conversion error:', 'maybe', '^.'],
      [],
    );
    expect(refused).toMatchObject({ complete: false, notStarted: 'Weighted Batch Preprocessing automation run not started: Invalid automation parameters: Parsing integer expression: conversion error: maybe ^.' });
    expect(outcomeIn([], ['*** Error: Weighted Batch Preprocessing has stopped: Out of memory'])).toMatchObject({ complete: false, notStarted: null, stopped: 'Weighted Batch Preprocessing has stopped: Out of memory' });
  });

  it('does not take a value that WBPP repeats for its refusal', () => {
    const echoed = outcomeIn(['automation mode parameter: bestFrameReferenceKeyword = automation run not started', '* Begin integration of Bias frames'], ['Execution summary', '3 operation(s) completed, 0 failed, 0 canceled or not executed.']);
    expect(echoed).toMatchObject({ complete: true, notStarted: null });
  });
});

describe('runs of WBPP in an instance of their own', () => {
  let home: string;
  let out: string;
  let cli: FakePixInsight;
  let runs: PreprocessRuns;
  const SLOTS = [240, 241, 242];
  const request = () => ({ script: '/opt/PixInsight/src/scripts/BatchPreprocessing/WBPP.js', args: [`outputDirectory=${out}`, 'keywords=SESSION', `dir=${join(home, 'frames')}`], outputDirectory: out });
  const started = () => cli.runs.at(-1)!;
  /** What WBPP leaves of a run that it started: where its log is, the log, and its report. */
  const wbppWrites = async (log: string[], report = REPORT): Promise<void> => {
    await mkdir(join(out, 'logs'), { recursive: true });
    await writeFile(join(out, 'logs', '20261110185414.log'), logged(log));
    await writeFile(join(out, 'logs', '20261110185414_SmartReport.txt'), report);
  };
  const says = (text: string): Promise<void> => writeFile(started().outputPath, text);
  const ended = async (id: string): Promise<RunSnapshot> => {
    await waitUntil(async () => (await runs.get(id))?.done === true);
    return (await runs.get(id)) as RunSnapshot;
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-preprocess-'));
    out = join(home, 'out');
    cli = new FakePixInsight();
    runs = new PreprocessRuns(cli, { slots: SLOTS, runsDir: join(home, 'jobs'), leasesDir: join(home, 'leases'), beginLogPath: '/scripts/begin_log.js', endLogPath: '/scripts/end_log.js', stopTimeoutMs: 2000 });
  });

  afterEach(async () => {
    for (const run of cli.runs) run.end(null);
    await rm(home, { recursive: true, force: true });
  });

  it('starts an instance that logs its console, runs WBPP in its automation mode, and exits', async () => {
    const run = await runs.start(request());
    expect(run).toMatchObject({ op: 'preprocess', state: 'running', done: false, slot: 240 });
    expect(started().slot).toBe(240);
    expect(started().scripts).toEqual([
      { path: '/scripts/begin_log.js', args: [join(home, 'jobs', run.id, 'console.log')] },
      { path: '/opt/PixInsight/src/scripts/BatchPreprocessing/WBPP.js', args: ['automationMode=true', `outputDirectory=${out}`, 'keywords=SESSION', `dir=${join(home, 'frames')}`] },
      { path: '/scripts/end_log.js', args: [] },
    ]);
    expect(dirname(started().outputPath)).toBe(join(home, 'jobs', run.id));
    // The slot is this server's while the run lasts, so that no other server takes the instance for a leftover.
    const leases = new SlotLeases(join(home, 'leases'));
    expect(await leases.slots()).toEqual([240]);
    // With the process that was started, at once: it lives as long as the instance, and PixInsight lists the instance only later.
    expect(await leases.instanceOn(240)).toBe(started().pid);
  });

  it('asks PixInsight for its instances once, to find a slot, and never while the run lasts', async () => {
    const run = await runs.start(request());
    await runs.get(run.id);
    await runs.wait(run.id, 120);
    await runs.cancel(run.id);
    await runs.get(run.id);
    expect(cli.listings).toBe(1);
  });

  it('leaves a slot alone whose run goes on after the server that started it', async () => {
    const first = await runs.start(request());
    // Another server, where instances cannot be listed: the lease of the first one, which is gone, names a process that lives.
    cli.listable = false;
    const later = new PreprocessRuns(cli, { slots: SLOTS, runsDir: join(home, 'jobs2'), leasesDir: join(home, 'leases'), beginLogPath: '/b.js', endLogPath: '/e.js' });
    const leases = new SlotLeases(join(home, 'leases'), () => false);
    expect(await leases.instanceOn(first.slot)).toBe(started().pid);
    expect((await later.start(request())).slot).toBe(241);
  });

  it('takes the first slot that holds nothing and that no other server has taken, also one where an instance crashed', async () => {
    cli.addInstance(240);
    cli.instances.push({ slot: 241, pid: null, crashed: true });
    expect((await runs.start(request())).slot).toBe(241);
    started().end(0);
    await waitUntil(async () => (await new SlotLeases(join(home, 'leases')).slots()).length === 0);

    // Another server, which is alive, holds the next one.
    const other = new SlotLeases(join(home, 'leases'), () => true, process.pid + 1);
    cli.instances = cli.instances.filter((instance) => instance.slot !== 241);
    cli.addInstance(241);
    await other.claim(242, null);
    await expect(runs.start(request())).rejects.toMatchObject({ kind: 'no_instance', message: expect.stringMatching(/slots 240 to 242.*PIXINSIGHT_MCP_PREPROCESS_SLOT/) });
  });

  it('runs one at a time', async () => {
    const first = await runs.start(request());
    await expect(runs.start(request())).rejects.toMatchObject({ kind: 'busy', message: expect.stringContaining(first.id) });
    started().end(0);
    await ended(first.id);
    expect((await runs.start(request())).state).toBe('running');
  });

  it('says what a run is at, from the console first and then from the log that WBPP starts', async () => {
    const run = await runs.start(request());
    await writeFile(join(home, 'jobs', run.id, 'console.log'), logged(['WBPP AUTOMATION MODE', 'add file: /data/light_001.fits']));
    expect(await runs.get(run.id)).toMatchObject({ state: 'running', logTail: ['WBPP AUTOMATION MODE', 'add file: /data/light_001.fits'] });
    expect(await runs.get(run.id)).not.toHaveProperty('step');
    // The instance says where the log is only when it ends. Until then it is the log that appeared in the output folder.
    await wbppWrites(['* Begin integration of Flat frames', 'numberOfImages: 4', '* End integration of Flat frames', '* Begin registration of light frames', 'Registering 3 of 6']);
    expect(await runs.get(run.id)).toMatchObject({ state: 'running', step: 'registration of light frames', logTail: expect.arrayContaining(['Registering 3 of 6']) });
    expect((await runs.wait(run.id, 60))?.done).toBe(false);
  });

  it('reports a run that completed: the summary, what each group was calibrated with, and the masters it wrote', async () => {
    // What an earlier run left there is not of this one, whatever its file says about when it was written.
    await mkdir(join(out, 'master'), { recursive: true });
    await mkdir(join(out, 'logs'), { recursive: true });
    await writeFile(join(out, 'master', 'masterLight_BIN-1_480x320_FILTER-L_mono_(1).xisf'), 'old');
    await writeFile(join(out, 'logs', '20991231235959.log'), logged(['Execution summary', 'of an earlier run']));
    const run = await runs.start(request());
    for (const name of ['masterLight_BIN-1_480x320_FILTER-L_mono.xisf', 'masterFlat_BIN-1_480x320_FILTER-L_mono_SESSION-2.xisf', 'LN_Reference_Light.xisf']) await writeFile(join(out, 'master', name), 'new');
    await wbppWrites([
      '** Warning: Problems found before the execution:',
      '** Warning: Diagnostics: Cosmetic Correction requires a master dark.',
      '* Begin integration of Flat frames',
      `Best reference frame for registration - auto selection completed: ${join(out, 'calibrated', 'Light', 'light_2_c.xisf')}`,
      'Execution summary',
      '5 operation(s) completed, 0 failed, 0 canceled or not executed.',
      '1 frame(s) have been excluded from the execution.',
      'Smart report result',
      '* Weighted Batch Preprocessing: 27.325 s',
    ]);
    await says(`PixInsight Core\n\n:LOGFILE:${join(out, 'logs', '20261110185414.log')}:LOGFILE:\n`);
    started().end(0);
    const done = await ended(run.id);
    expect(done).toMatchObject({ state: 'succeeded', done: true });
    expect(done.value).toEqual({
      outputDirectory: out,
      summary: ['5 operation(s) completed, 0 failed, 0 canceled or not executed.', '1 frame(s) have been excluded from the execution.'],
      problems: ['Cosmetic Correction requires a master dark.'],
      groups: groupsIn(REPORT),
      // Only what this run wrote, and only masters.
      masters: [join(out, 'master', 'masterFlat_BIN-1_480x320_FILTER-L_mono_SESSION-2.xisf'), join(out, 'master', 'masterLight_BIN-1_480x320_FILTER-L_mono.xisf')].map(pix),
      registrationReferences: [pix(join(out, 'calibrated', 'Light', 'light_2_c.xisf'))],
      log: join(out, 'logs', '20261110185414.log'),
      report: join(out, 'logs', '20261110185414_SmartReport.txt'),
      seconds: expect.any(Number),
    });
    expect(await new SlotLeases(join(home, 'leases')).slots()).toEqual([]);
  });

  it('reads no log but one in the output folder, whatever the output of the instance names', async () => {
    const elsewhere = join(home, 'secret.log');
    await writeFile(elsewhere, logged(['a line that is nobody\'s business']));
    const run = await runs.start(request());
    await says(`:LOGFILE:${elsewhere}:LOGFILE:\n:LOGFILE:${join(out, 'logs', 'notes.txt')}:LOGFILE:\n`);
    started().end(1);
    const done = await ended(run.id);
    expect(done).toMatchObject({ state: 'failed', error: { kind: 'run_failed' } });
    expect(done.error?.message).not.toContain('business');
  });

  it('says how much of a long summary and of many groups it left out', async () => {
    const run = await runs.start(request());
    const failed = Array.from({ length: 45 }, (_, index) => `*** Failed: Integration ${index}`);
    const groups = Array.from({ length: 203 }, (_, index) => `Group of ${index + 1} Light frames\nMaster flat: none\n`).join('');
    await wbppWrites(['Execution summary', ...failed, 'Smart report result'], `******** LIGHT FRAMES CALIBRATION ********\n${groups}`);
    started().end(0);
    const { value } = await ended(run.id);
    expect(value?.summary).toHaveLength(40);
    expect(value?.moreSummaryLines).toBe(5);
    expect(value?.groups).toHaveLength(200);
    expect(value?.moreGroups).toBe(3);
  });

  it('says why WBPP did not start a run, from the console, which is the only place that holds it', async () => {
    const run = await runs.start(request());
    await writeFile(
      join(home, 'jobs', run.id, 'console.log'),
      logged(['WBPP AUTOMATION MODE', 'Diagnostics:', '==== Check bias/dark/flat/light groups', '*** Error: No input frames have been provided.', '*** Error: Weighted Batch Preprocessing automation run not started: 1 error(s) found by the diagnostics prevent the execution.']),
    );
    started().end(0);
    expect(await ended(run.id)).toMatchObject({
      state: 'failed',
      error: { kind: 'not_started', message: 'WBPP did not start the run: Weighted Batch Preprocessing automation run not started: 1 error(s) found by the diagnostics prevent the execution. No input frames have been provided.' },
    });
  });

  it('tells a run that broke off from one that completed, by the summary that only a complete run has', async () => {
    const crashed = await runs.start(request());
    await wbppWrites(['* Begin integration of Light frames', 'Integrating pixel rows']);
    started().end(139);
    expect(await ended(crashed.id)).toMatchObject({ state: 'failed', error: { kind: 'run_failed', message: expect.stringMatching(/exit code 139 before WBPP had finished.*Integrating pixel rows/) } });

    await rm(out, { recursive: true, force: true });
    const never = await runs.start(request());
    started().end(null);
    expect(await ended(never.id)).toMatchObject({ state: 'failed', error: { kind: 'run_failed', message: expect.stringMatching(/could not be started, or was ended from outside.*console is empty/) } });
  });

  it('stops a run by ending the process it started for it, and nothing else', async () => {
    cli.addInstance(1, 4242);
    const run = await runs.start(request());
    const { pid } = started();
    expect(await runs.cancel(run.id)).toBe('stopped');
    expect(cli.ended).toEqual([pid]);
    expect(await runs.get(run.id)).toMatchObject({ state: 'cancelled', done: true, error: { kind: 'cancelled', message: expect.stringContaining(out) } });
    // Once more, and for a run that nobody knows.
    expect(await runs.cancel(run.id)).toBe('finished');
    expect(await runs.cancel('no-such-run')).toBeUndefined();
    expect(cli.ended).toEqual([pid]);
    // Nothing is ended by what a slot holds: only the process that was started is known to be the run.
    expect(cli.killed).toEqual([]);
    expect(cli.instances.map((instance) => instance.slot)).toEqual([1]);
  });

  it('stops a run whose instance PixInsight does not list yet, and where it lists none at all', async () => {
    const starting = await runs.start(request());
    cli.instances.splice(cli.instances.findIndex((instance) => instance.slot === starting.slot), 1);
    expect(await runs.cancel(starting.id)).toBe('stopped');
    expect(cli.ended).toEqual([cli.runs[0]?.pid]);

    cli.listable = false;
    const unlisted = await runs.start(request());
    expect(await runs.cancel(unlisted.id)).toBe('stopped');
    expect(cli.ended).toEqual([cli.runs[0]?.pid, cli.runs[1]?.pid]);
  });

  it('touches nothing once the process of a run has ended, whatever runs on its slot by then', async () => {
    const run = await runs.start(request());
    started().end(0);
    // The run is still being read, and something else has taken its slot and, as far as anyone knows, its pid.
    cli.addInstance(run.slot, started().pid);
    await Promise.resolve();
    await Promise.resolve();
    expect(await runs.cancel(run.id)).toBe('finished');
    await ended(run.id);
    expect(await runs.cancel(run.id)).toBe('finished');
    expect(cli.ended).toEqual([]);
    expect(cli.killed).toEqual([]);
    expect(cli.instances.map((instance) => instance.slot)).toEqual([run.slot]);
  });

  it('says so if a run cannot be stopped, and does not call it cancelled when it ends by itself', async () => {
    const run = await runs.start(request());
    cli.refuseEndRun = 'kill EPERM';
    await expect(runs.cancel(run.id)).rejects.toMatchObject({ kind: 'cli_failed', message: expect.stringContaining('kill EPERM') });
    expect((await runs.get(run.id))?.state).toBe('running');
    await wbppWrites(['Execution summary', '1 operation(s) completed, 0 failed, 0 canceled or not executed.', 'Smart report result']);
    started().end(0);
    expect((await ended(run.id)).state).toBe('succeeded');
  });

  it('says that a run is being stopped if that takes longer than a moment', async () => {
    const slow = new PreprocessRuns(cli, { slots: SLOTS, runsDir: join(home, 'jobs'), leasesDir: join(home, 'leases'), beginLogPath: '/b.js', endLogPath: '/e.js', stopTimeoutMs: 60 });
    const run = await slow.start(request());
    const end = started().end;
    // The signal is out, and the process takes its time to go.
    started().end = () => undefined;
    expect(await slow.cancel(run.id)).toBe('stopping');
    expect((await slow.get(run.id))?.state).toBe('running');
    end(null);
    await waitUntil(async () => (await slow.get(run.id))?.done === true);
    expect((await slow.get(run.id))?.state).toBe('cancelled');
  });

  it('stops waiting for a run when the call is given up', async () => {
    const run = await runs.start(request());
    const given = new AbortController();
    given.abort();
    const before = Date.now();
    expect((await runs.wait(run.id, 60_000, given.signal))?.state).toBe('running');
    expect(Date.now() - before).toBeLessThan(5000);
  });

  it('lets no second run slip in while the first one is being started', async () => {
    const both = await Promise.allSettled([runs.start(request()), runs.start(request())]);
    expect(both.map((each) => each.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(both.find((each) => each.status === 'rejected')).toMatchObject({ reason: { kind: 'busy' } });
    expect(cli.runs).toHaveLength(1);
  });

  it('gives the slot back if PixInsight cannot be started with these arguments', async () => {
    cli.refuseRun = 'Path cannot be passed over PixInsight\'s command line because it contains ","';
    await expect(runs.start(request())).rejects.toMatchObject({ kind: 'cli_failed', message: expect.stringContaining('contains ","') });
    expect(await new SlotLeases(join(home, 'leases')).slots()).toEqual([]);
    cli.refuseRun = undefined;
    expect((await runs.start(request())).slot).toBe(240);
  });
});
