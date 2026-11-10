import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { toPixPath } from '../platform.js';
import { CliError, type PixInsightCli, type StartedRun } from '../bridge/cli.js';
import { cleanLog, readEnd, readStart } from '../bridge/jobs.js';
import { SlotLeases } from '../bridge/lease.js';

export type RunState = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RunRequest {
  /** The script of WBPP in the installation. */
  script: string;
  /** Its arguments, without the one that turns on its automation mode. */
  args: string[];
  outputDirectory: string;
}

/** What a group of frames was calibrated with, as the report of WBPP says it. */
export interface CalibratedGroup {
  step: string;
  frames: string;
  filter?: string;
  exposure?: string;
  keywords?: string;
  masterBias?: string;
  masterDark?: string;
  masterFlat?: string;
}

export interface RunResult {
  outputDirectory: string;
  /** What WBPP says about the run as a whole: operations that completed and failed, and frames it left out. */
  summary: string[];
  /** What WBPP found before it started. */
  problems?: string[];
  groups?: CalibratedGroup[];
  /** How many lines of the summary and how many groups the report has beyond those that are listed here. */
  moreSummaryLines?: number;
  moreGroups?: number;
  /** The masters this run wrote. */
  masters: string[];
  /** The frames that the lights were registered to, which a later run can name to get masters that lie on these. */
  registrationReferences?: string[];
  /** The log and the report of WBPP, for whoever can read files. */
  log?: string;
  report?: string;
  seconds: number;
}

export interface RunSnapshot {
  id: string;
  op: 'preprocess';
  state: RunState;
  done: boolean;
  slot: number;
  elapsedMs: number;
  /** What a run that is under way works on. */
  step?: string;
  logTail?: string[];
  value?: RunResult;
  error?: { kind: string; message: string };
}

export class RunError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PreprocessOptions {
  /** Candidates in order of preference. Used by nothing else of this server. */
  slots: readonly number[];
  runsDir: string;
  leasesDir: string;
  beginLogPath: string;
  endLogPath: string;
  /** How long a cancelled run gets to be gone. */
  stopTimeoutMs?: number;
}

interface Run {
  id: string;
  dir: string;
  slot: number;
  request: RunRequest;
  startedAt: number;
  endedAt: number | null;
  state: RunState;
  cancelled: boolean;
  child: StartedRun;
  /** The process of the run has ended. From then on nothing is done to its pid or its slot. */
  exited: boolean;
  settled: Promise<void>;
  /** The masters and logs that the output folder held before the run, which are not its own. */
  before: { masters: Set<string>; logs: Set<string> };
  /** The log that WBPP writes, once it has said where. */
  log?: string;
  value?: RunResult;
  error?: { kind: string; message: string };
}

const TAIL_BYTES = 16_384;
const STEP_BYTES = 262_144;
const END_BYTES = 1_048_576;
const START_BYTES = 65_536;
const TAIL_LINES = 8;
const MAX_SUMMARY_LINES = 40;
const MAX_GROUPS = 200;
const MAX_REFERENCES = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The groups of a report of WBPP, with the masters each was calibrated with. Nothing if the report reads otherwise. */
export function groupsIn(report: string): CalibratedGroup[] {
  const groups: CalibratedGroup[] = [];
  let step: string | null = null;
  let group: CalibratedGroup | null = null;
  const field = (line: string, name: RegExp): string | undefined => name.exec(line)?.[1]?.trim();
  for (const raw of report.split(/\r?\n/)) {
    const line = raw.trim();
    const title = /^\*{3,}\s*(.+?)\s*\*{3,}$/.exec(line);
    if (title) {
      step = title[1] as string;
      group = null;
      continue;
    }
    if (step === null || !/CALIBRATION|GENERATION/i.test(step)) continue;
    const frames = field(line, /^Group of (.+)$/);
    if (frames) {
      group = { step: step.toLowerCase(), frames };
      groups.push(group);
      continue;
    }
    if (!group) continue;
    const master = /^Master (bias|dark|flat)\s*:\s*(.+)$/i.exec(line);
    if (master) {
      const kind = (master[1] as string).toLowerCase();
      // A group of flats has no flat of its own to be calibrated with, and so on: that line says nothing.
      if (new RegExp(`\\b${kind} frames`, 'i').test(group.frames)) continue;
      // Of a master, its file says which one it is. The folder is the same for all of them.
      group[`master${kind[0]?.toUpperCase()}${kind.slice(1)}` as 'masterBias'] = basename((master[2] as string).trim().replaceAll('\\', '/'));
      continue;
    }
    if (/^Filter\s*:/i.test(line)) group.filter = field(line, /^Filter\s*:\s*(.*)$/i) ?? '';
    else if (/^Exposure\s*:/i.test(line)) group.exposure = field(line, /^Exposure\s*:\s*(.*)$/i) ?? '';
    else if (/^Keywords\s*:/i.test(line)) group.keywords = field(line, /^Keywords\s*:\s*(.*)$/i) ?? '';
  }
  return groups;
}

/** The frames that WBPP registered to, as its log names them: one that it chose, or the one it was given. */
export function referencesIn(log: string): string[] {
  const found = [...log.matchAll(/Best reference frame(?: for registration - auto selection completed|, manually selected): *(.+?)\s*$/gm)].map((match) => toPixPath(match[1] as string));
  return [...new Set(found)];
}

/**
 * What a run that has ended said about itself. WBPP writes its diagnostics and whether it starts
 * to the console, and a summary and its report to the log that it keeps of a run.
 *
 * @param start The first lines of the console, then those of the log of WBPP.
 * @param end The last lines of the log of WBPP.
 */
export function outcomeIn(start: string[], end: string[]): { summary: string[]; problems: string[]; complete: boolean; notStarted: string | null; stopped: string | null } {
  const all = [...start, ...end];
  // As an error of WBPP, and not anywhere in a line: WBPP repeats the values it was given, and one of them can read like this.
  const refusal = /^\*+ ?Error: .*automation run (has )?not (been )?started/i;
  const notStartedAt = all.findIndex((line) => refusal.test(line));
  const stoppedLine = all.find((line) => /^\*\*\* Error: .* has stopped:/.test(line)) ?? null;
  const problems: string[] = [];
  // Before the first step: what the diagnostics found. An error there keeps the run from starting.
  for (const line of start) {
    if (/^\* Begin /.test(line)) break;
    const found = /^\*{2,3} ?(?:Warning|Error): (.+)$/.exec(line);
    // The console and the log of WBPP say the same thing, one of them with a word in front.
    if (found && !/^Problems found before the execution/.test(found[1] as string) && !refusal.test(line)) problems.push((found[1] as string).replace(/^Diagnostics: /, ''));
  }
  const summary: string[] = [];
  const at = end.lastIndexOf('Execution summary');
  if (at >= 0) {
    for (const line of end.slice(at + 1)) {
      if (/^Smart report result$/i.test(line)) break;
      summary.push(line);
    }
  }
  // A reason can run over several lines of the console, such as a value that could not be read.
  let notStarted: string | null = null;
  if (notStartedAt >= 0) {
    notStarted = (all[notStartedAt] as string).replace(/^\*+ ?Error: /, '');
    for (let next = notStartedAt + 1; next <= notStartedAt + 3 && next < all.length && !notStarted.endsWith('.'); next++) notStarted += ` ${all[next]}`;
  }
  return {
    summary,
    problems: [...new Set(problems)],
    complete: at >= 0,
    notStarted,
    stopped: stoppedLine ? stoppedLine.replace(/^\*+ ?Error: /, '') : null,
  };
}

/**
 * Runs of WBPP in its automation mode, each in an instance of its own that PixInsight starts for
 * it and that exits when the run has ended. So a run holds neither the instance of the user nor
 * the worker, asks nothing, and leaves the settings of the user's WBPP alone. One run at a time.
 */
export class PreprocessRuns {
  private readonly leases: SlotLeases;
  private readonly runs = new Map<string, Run>();
  private readonly stopTimeoutMs: number;
  /** A run is being started, which takes a moment in which a second one must not slip in. */
  private starting = false;

  constructor(
    private readonly cli: PixInsightCli,
    private readonly options: PreprocessOptions,
  ) {
    this.leases = new SlotLeases(options.leasesDir);
    this.stopTimeoutMs = options.stopTimeoutMs ?? 8000;
  }

  private active(): Run | undefined {
    return [...this.runs.values()].find((run) => run.state === 'running');
  }

  async start(request: RunRequest): Promise<RunSnapshot> {
    const under = this.active();
    if (under) throw new RunError('busy', `A preprocessing run is under way (job ${under.id}). Wait for it with get_job, or stop it with cancel_job.`);
    if (this.starting) throw new RunError('busy', 'A preprocessing run is being started. Wait for the answer to that call.');
    this.starting = true;
    try {
      return await this.begin(request);
    } finally {
      this.starting = false;
    }
  }

  private async begin(request: RunRequest): Promise<RunSnapshot> {
    const id = randomUUID();
    const dir = join(this.options.runsDir, id);
    await mkdir(dir, { recursive: true });
    const names = async (folder: string): Promise<Set<string>> => new Set(await readdir(join(request.outputDirectory, folder)).catch(() => [] as string[]));
    const before = { masters: await names('master'), logs: await names('logs') };
    const slot = await this.freeSlot();
    let child: StartedRun;
    try {
      child = this.cli.runToExit(
        slot,
        [
          // The console goes to a file of the server, which also holds what WBPP says if it does not start.
          { path: this.options.beginLogPath, args: [toPixPath(join(dir, 'console.log'))] },
          { path: request.script, args: ['automationMode=true', ...request.args] },
          { path: this.options.endLogPath, args: [] },
        ],
        join(dir, 'output.txt'),
      );
    } catch (error) {
      await this.leases.release(slot);
      throw new RunError('cli_failed', `PixInsight could not be started for the run: ${error instanceof Error ? error.message : String(error)}`);
    }
    const run: Run = { id, dir, slot, request, startedAt: Date.now(), endedAt: null, state: 'running', cancelled: false, child, exited: false, settled: Promise.resolve(), before };
    run.settled = child.exited
      .then((code) => {
        // At once, before anything is read: from here on the pid and the slot can be someone else's.
        run.exited = true;
        return this.finish(run, code);
      })
      .catch((error: unknown) => {
        run.exited = true;
        run.state = 'failed';
        run.endedAt ??= Date.now();
        run.error = { kind: 'internal_error', message: error instanceof Error ? error.message : String(error) };
      });
    this.runs.set(id, run);
    // For the servers that look at the slot: the process that was started lives as long as the instance, so it says whether
    // the run is still there. PixInsight is not asked for the instance, which it lists only seconds later.
    if (child.pid !== undefined) await this.leases.setInstance(slot, child.pid);
    return this.snapshot(run);
  }

  /** The first slot that holds no instance and that no other server has taken. */
  private async freeSlot(): Promise<number> {
    const instances = await this.cli.enumerate().catch((error: unknown) => {
      throw new RunError(error instanceof CliError ? error.code : 'cli_failed', `PixInsight could not be asked which slots are in use: ${error instanceof Error ? error.message : String(error)}`);
    });
    for (const slot of this.options.slots) {
      // An instance that runs there is not this server's: a run ends with its instance. One that crashed is gone, and its slot is free.
      if (instances?.some((instance) => instance.slot === slot && !instance.crashed)) continue;
      // A run outlives its server. Where instances cannot be listed, only its lease says that it is still there.
      const left = await this.leases.instanceOn(slot);
      if (left !== null && this.cli.isRunning(left)) continue;
      if (await this.leases.claim(slot, instances === null ? undefined : null)) return slot;
    }
    throw new RunError(
      'no_instance',
      `None of the slots ${this.options.slots[0]} to ${this.options.slots.at(-1)} is free for a preprocessing run: other servers have runs under way there, or something else runs on them. Wait, or move the slots with PIXINSIGHT_MCP_PREPROCESS_SLOT.`,
    );
  }

  /**
   * The log of WBPP, which it names in its output when a run begins. The console is logged to a
   * file of the server only until then: PixInsight writes one log at a time, and WBPP starts its own.
   */
  private async logOf(run: Run): Promise<string | undefined> {
    // Of what the output names, only the name of the file is taken: a log lies in the output folder, whatever else a path there says.
    const named = basename((/:LOGFILE:(.+?):LOGFILE:/.exec(await readFile(join(run.dir, 'output.txt'), 'utf8').catch(() => ''))?.[1] ?? '').replaceAll('\\', '/'));
    if (/^\d+\.log$/.test(named)) run.log = join(run.request.outputDirectory, 'logs', named);
    if (run.log) return run.log;
    // The output of an instance reaches its file only when the instance ends. Until then: the log that was not there before the run.
    // By its name, which is the time it was begun, and not by a time of the file system, whose clock can differ.
    const dir = join(run.request.outputDirectory, 'logs');
    const own = (await readdir(dir).catch(() => [] as string[])).filter((name) => /^\d+\.log$/.test(name) && !run.before.logs.has(name)).sort();
    return own.length ? join(dir, own.at(-1) as string) : undefined;
  }

  private async finish(run: Run, code: number | null): Promise<void> {
    run.endedAt = Date.now();
    await this.leases.release(run.slot);
    const console = join(run.dir, 'console.log');
    const log = await this.logOf(run);
    // Of the console both ends: after many lines about the frames it read, its last ones say whether WBPP started.
    const outcome = outcomeIn(
      [...cleanLog(await readStart(console, START_BYTES)), ...cleanLog(await readEnd(console, START_BYTES)), ...(log ? cleanLog(await readStart(log, START_BYTES)) : [])],
      log ? cleanLog(await readEnd(log, END_BYTES)) : [],
    );
    if (run.cancelled) {
      run.state = 'cancelled';
      run.error = { kind: 'cancelled', message: `The run was stopped. What it had written to ${run.request.outputDirectory} is still there.` };
      return;
    }
    if (outcome.notStarted) {
      run.state = 'failed';
      // What the diagnostics found, unless the reason says it already.
      const more = outcome.problems.filter((problem) => !outcome.notStarted?.includes(problem.replace(/[:.]$/, '')));
      const reasons = more.length ? ` ${more.join(' ')}` : '';
      run.error = { kind: 'not_started', message: `WBPP did not start the run: ${outcome.notStarted}${reasons}` };
      return;
    }
    if (!outcome.complete) {
      run.state = 'failed';
      const last = cleanLog(await readEnd(log ?? console, TAIL_BYTES)).slice(-TAIL_LINES);
      const why = outcome.stopped ?? (code === null ? 'PixInsight could not be started, or was ended from outside' : `PixInsight ended with exit code ${code} before WBPP had finished`);
      run.error = { kind: 'run_failed', message: `${why}.${last.length ? ` The last lines of its console: ${last.join(' | ')}` : ' Its console is empty.'}` };
      return;
    }
    const report = log?.replace(/\.log$/i, '_SmartReport.txt');
    const groups = report ? groupsIn(await readFile(report, 'utf8').catch(() => '')) : [];
    // In the middle of a log of many megabytes, so the whole of it is read for this one line.
    const references = log ? referencesIn(await readFile(log, 'utf8').catch(() => '')).slice(0, MAX_REFERENCES) : [];
    run.state = 'succeeded';
    run.value = {
      outputDirectory: run.request.outputDirectory,
      summary: outcome.summary.slice(0, MAX_SUMMARY_LINES),
      ...(outcome.summary.length > MAX_SUMMARY_LINES ? { moreSummaryLines: outcome.summary.length - MAX_SUMMARY_LINES } : {}),
      ...(outcome.problems.length ? { problems: outcome.problems } : {}),
      ...(groups.length ? { groups: groups.slice(0, MAX_GROUPS) } : {}),
      ...(groups.length > MAX_GROUPS ? { moreGroups: groups.length - MAX_GROUPS } : {}),
      masters: await this.mastersOf(run),
      ...(references.length ? { registrationReferences: references } : {}),
      ...(log ? { log } : {}),
      ...(report && groups.length ? { report } : {}),
      seconds: Math.round((run.endedAt - run.startedAt) / 1000),
    };
  }

  /** The masters that were not there before the run. WBPP keeps those of earlier runs beside them. */
  private async mastersOf(run: Run): Promise<string[]> {
    const dir = join(run.request.outputDirectory, 'master');
    const masters: string[] = [];
    for (const name of (await readdir(dir).catch(() => [] as string[])).sort()) {
      if (!/^master/i.test(name) || run.before.masters.has(name)) continue;
      if ((await stat(join(dir, name)).catch(() => null))?.isFile()) masters.push(toPixPath(join(dir, name)));
    }
    return masters;
  }

  private async snapshot(run: Run): Promise<RunSnapshot> {
    const base = { id: run.id, op: 'preprocess' as const, state: run.state, done: run.state !== 'running', slot: run.slot, elapsedMs: (run.endedAt ?? Date.now()) - run.startedAt };
    if (run.state !== 'running') return { ...base, ...(run.value ? { value: run.value } : {}), ...(run.error ? { error: run.error } : {}) };
    const source = (await this.logOf(run)) ?? join(run.dir, 'console.log');
    const tail = cleanLog(await readEnd(source, TAIL_BYTES)).slice(-TAIL_LINES);
    const step = cleanLog(await readEnd(source, STEP_BYTES)).findLast((line) => /^\* Begin /.test(line))?.replace(/^\* Begin /, '');
    return { ...base, ...(step ? { step } : {}), ...(tail.length ? { logTail: tail } : {}) };
  }

  /** The run that is under way, if there is one. */
  async current(): Promise<RunSnapshot | undefined> {
    const run = this.active();
    return run ? this.snapshot(run) : undefined;
  }

  async get(id: string): Promise<RunSnapshot | undefined> {
    const run = this.runs.get(id);
    return run ? this.snapshot(run) : undefined;
  }

  /** Waits for the end of a run, at most this long. */
  async wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<RunSnapshot | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;
    const deadline = Date.now() + timeoutMs;
    while (run.state === 'running' && Date.now() < deadline && !signal?.aborted) await sleep(Math.min(200, Math.max(0, deadline - Date.now())));
    return this.snapshot(run);
  }

  /**
   * Ends the instance of a run, which is this server's own and holds nothing but the run: by the
   * process that this server started for it, and only while that process has not ended.
   *
   * @returns `stopped` once the run has ended, `stopping` if that takes longer than a moment,
   *   `finished` for a run that had ended by itself, and nothing for an id that is no run.
   */
  async cancel(id: string): Promise<'stopped' | 'stopping' | 'finished' | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;
    if (run.state !== 'running' || run.exited) return 'finished';
    run.cancelled = true;
    try {
      this.cli.endRun(run.child);
    } catch (error) {
      run.cancelled = false;
      throw new RunError('cli_failed', `The run could not be stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
    const deadline = Date.now() + this.stopTimeoutMs;
    while (run.state === 'running' && Date.now() < deadline) await sleep(50);
    return run.state === 'running' ? 'stopping' : 'stopped';
  }
}
