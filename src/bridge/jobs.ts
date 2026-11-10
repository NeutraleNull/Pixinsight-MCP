import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cpuSeconds as platformCpuSeconds, renameWhenFree, toPixPath } from '../platform.js';
import { CliError, type PixInsightCli } from './cli.js';

export type JobState = 'queued' | 'sent' | 'running' | 'succeeded' | 'failed' | 'aborted' | 'lost';

/** What the instance appears to be doing while a job is unfinished. */
export type Activity = 'computing' | 'idle' | 'unknown';

export interface JobError {
  kind: string;
  message: string;
}

export interface JobSnapshot {
  id: string;
  op: string;
  state: JobState;
  done: boolean;
  slot?: number;
  activity: Activity;
  /** The job has not advanced for a while and the instance uses no CPU: most likely a dialog is open. */
  waitingForInput: boolean;
  value?: unknown;
  error?: JobError;
  /** Errors and warnings PixInsight wrote to its console during the job. */
  console?: string[];
  /** The console output of a finished job, without progress noise. */
  log?: string[];
  /** The newest console lines of an unfinished job. */
  logTail?: string[];
  elapsedMs: number;
}

/** Where jobs go, and how to tell that this has changed. */
export interface JobTarget {
  /** The slot of the instance to use, called per job so that a later instance is picked up. */
  resolve(): Promise<number>;
  current(): { slot: number; pid: number | null } | null;
  /** The instance turned out not to be there any more. */
  invalidate(): void;
  /** Increases whenever jobs start going to a different instance. */
  readonly generation: number;
  /** An announcement the assistant has not received yet. */
  readonly notice: string | undefined;
  takeNotice(): string | undefined;
}

export interface JobManagerOptions {
  cli: PixInsightCli;
  jobsDir: string;
  opsDir: string;
  runnerPath: string;
  /** The scripts that start and end a console log, for jobs that send a script of the installation ahead. */
  beginLogPath: string;
  endLogPath: string;
  target: JobTarget;
  /** Operations that may only be submitted with a check, so that no caller can leave it out. */
  needsValidation?: readonly string[];
  /** Called before a job goes out, to put back scripts that something has removed. */
  ensureScripts?: () => Promise<void>;
  cpuSeconds?: (pid: number) => Promise<number | null>;
  pollMs?: number;
  livenessMs?: number;
  /** No CPU use for this long counts as waiting for input. */
  idleThresholdMs?: number;
  retainFinished?: number;
}

/**
 * A script of the installation to send right ahead of a job. PixInsight runs one script after the
 * other, so the job itself runs when that script has ended, which can be long after: the user may
 * be working in its dialog.
 */
export interface ScriptAhead {
  path: string;
  /** The image to bring to the front right before the script, which works on the active image. */
  view?: string | undefined;
}

/** What only the check of a job could find out. */
export interface Checked {
  /** The arguments the job goes out with, in place of those it was submitted with. */
  args?: unknown;
  scriptAhead?: ScriptAhead;
}

export interface SubmitOptions {
  /**
   * Runs before the job may go out. A rejection with a `kind` property ends the job with that
   * error. A check with side effects asks `cancelled` first, because the job can have been
   * withdrawn while it waited for its turn.
   */
  validate?: (job: { cancelled(): boolean }) => Promise<Checked | void>;
  /** May overtake a job that is still being validated, whose validation can be waiting for this one. */
  express?: boolean;
}

interface Job {
  id: string;
  op: string;
  dir: string;
  /** Validates the job and writes its file. Started when the job heads the queue, or at once without a check. */
  prepare: () => Promise<void>;
  prepared: Promise<void> | null;
  /** The job file exists and validation is over, so the job can go out. */
  settled: boolean;
  /** The server has given up on it: the runner must not start it any more. */
  withdrawn: boolean;
  /** Writes of the heartbeat file, one after the other. */
  beating: Promise<void>;
  scriptAhead?: ScriptAhead;
  /** The script has gone to PixInsight, and nothing calls it back. */
  scriptSent: boolean;
  /** On its way to PixInsight: from here on it can be abandoned, but no longer cancelled as if it had never left. */
  sending: boolean;
  /** The file with the console output to show: that of the job, or that of the script sent ahead. */
  logName: string;
  logSize: number;
  express: boolean;
  generation: number;
  state: JobState;
  createdAt: number;
  finishedAt?: number;
  slot?: number;
  activity: Activity;
  idleSince?: number;
  value?: unknown;
  error?: JobError;
  console?: string[];
  log?: string[];
  listeners: Array<() => void>;
}

interface JobResult {
  ok: boolean;
  value?: unknown;
  error?: JobError;
  /** The open images after the job, which the runner adds to every result. */
  images?: Array<{ view: string; unsaved: boolean }>;
}

/** The images of an instance as a job last saw them, for when that instance is gone. */
interface ImagesSeen {
  generation: number;
  at: number;
  unsaved: string[];
}

/**
 * Nothing here changes an image or a file, so these can go to a different instance than the one
 * the assistant has in mind. Anything else could hit an image there that only has the same name.
 */
const SAFE_ON_ANY_INSTANCE = new Set(['ping', 'list_processes', 'describe_process', 'list_images', 'image_stats', 'preview', 'open_image', 'check_enum']);

/** How often the server tells the runner that it still waits. The runner gives up after 15 s of silence. */
const HEARTBEAT_MS = 1000;
const JOB_LOG = 'console.log';
/** What a script sent ahead of a job writes to the console. The job's own log has nothing of interest then. */
const SCRIPT_LOG = 'script.log';
const CPU_BUSY_CORES = 0.05;
const LOG_TAIL_LINES = 8;
/** A long log is shown by its start, which says what ran on what, and its end, which holds the outcome. */
const LOG_LINES = 30;
const LOG_HEAD_LINES = 6;
/** For the start of a log that is longer than what is read of its end. */
const LOG_START_BYTES = 16 * 1024;
/** A script can write for hours, so only the end of a log is ever read. */
const LOG_TAIL_BYTES = 64 * 1024;
const LOG_END_BYTES = 1024 * 1024;
const PROBLEM_LINES = 12;
const MAX_LINE_LENGTH = 300;
/** Banners, swap file reports, transfer rates, and what PixInsight notes when it takes a script from the command line. */
const LOG_NOISE = /^(\*+|PixInsight Core .*|(Writing|Reading) swap files.*|[\d.]+ [KMG]iB\/s|\* IPC execute command received\.|run -[ax]=.*|Processing script file: .*)$/;

function isDone(state: JobState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'aborted' || state === 'lost';
}

/** Undefined while the file does not exist, so that a damaged file does not pass for a missing one. */
async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The end of a text file, from the start of a line. Empty if the file is not there. */
async function readEnd(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, 'r').catch(() => null);
  if (!file) return '';
  try {
    const { size } = await file.stat();
    const length = Math.min(size, maxBytes);
    const { buffer } = await file.read(Buffer.alloc(length), 0, length, size - length);
    const text = buffer.toString('utf8');
    return size > length ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    await file.close();
  }
}

/** The start of a text file, up to its last whole line. Empty if the file is not there. */
async function readStart(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, 'r').catch(() => null);
  if (!file) return '';
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(maxBytes), 0, maxBytes, 0);
    const text = buffer.toString('utf8', 0, bytesRead);
    return bytesRead < maxBytes ? text : text.slice(0, text.lastIndexOf('\n') + 1);
  } catch {
    return '';
  } finally {
    await file.close();
  }
}

function isJobResult(value: unknown): value is JobResult {
  return typeof value === 'object' && value !== null && typeof (value as JobResult).ok === 'boolean';
}

/** Console text without timestamps, color codes and the lines that only report progress. */
function cleanLog(text: string): string[] {
  const lines = text
    .split(/\r?\n|\r/)
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\[[^\]]*\]\s?/, '').trim())
    .filter((line) => line.length > 0 && !LOG_NOISE.test(line));
  // PixInsight notes for every signed script who signed it and when, which is not part of its output.
  const kept: string[] = [];
  let inSignature = false;
  for (const line of lines) {
    if (/^\* Code signature verified:?$/.test(line)) inSignature = true;
    else if (inSignature && /^(script-id|developer-id|timestamp)\s*:/.test(line)) continue;
    else {
      inSignature = false;
      kept.push(line.substring(0, MAX_LINE_LENGTH));
    }
  }
  return kept;
}

/** The lines to show of a finished log: all of a short one, the start and the end of a long one. */
function summarizeLog(lines: string[], start: string[] | null): string[] {
  // `start` is given if only the end of the file was read, so that nobody knows how much lies between.
  if (!start && lines.length <= LOG_LINES) return lines;
  const head = (start ?? lines).slice(0, LOG_HEAD_LINES);
  const tail = lines.slice(-(LOG_LINES - LOG_HEAD_LINES - 1));
  const between = start ? 'many' : String(lines.length - head.length - tail.length);
  return [...head, `… ${between} lines left out …`, ...tail];
}

/**
 * Many failures are only visible in the log. Plugins that run external programs report their
 * exit code as plain text, for example, and still count as a successful process.
 */
function isProblem(line: string): boolean {
  return /^\*\*\*? /.test(line) || /exit (error )?code\s*[1-9]/i.test(line) || /\bfailed\b/i.test(line);
}

/**
 * Serializes jobs for one instance. PixInsight queues `-x` scripts by itself, but concurrent
 * clients arrive in arbitrary order, so only one job is handed over at a time.
 */
export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private readonly finished: Job[] = [];
  private active: Job | null = null;
  private pumping = false;
  private seen: ImagesSeen | null = null;
  /** Of an instance that has been replaced since, until someone has been told. */
  private seenBefore: ImagesSeen | null = null;
  private readonly pollMs: number;
  private readonly livenessMs: number;
  private readonly idleThresholdMs: number;
  private readonly retainFinished: number;
  private readonly cpuSeconds: (pid: number) => Promise<number | null>;

  constructor(private readonly options: JobManagerOptions) {
    this.pollMs = options.pollMs ?? 50;
    this.livenessMs = options.livenessMs ?? 1500;
    this.idleThresholdMs = options.idleThresholdMs ?? 3000;
    this.retainFinished = options.retainFinished ?? 100;
    this.cpuSeconds = options.cpuSeconds ?? ((pid) => platformCpuSeconds(pid));
  }

  /**
   * Takes the job's place in the queue right away, so that jobs run in the order they came in.
   *
   * A check runs when the job heads the queue, not before. Its lookups then find PixInsight free,
   * where behind a long process they would time out and fail a job that has not even had its turn.
   */
  submit(op: string, args: unknown, options: SubmitOptions = {}): JobSnapshot {
    if (this.options.needsValidation?.includes(op) && !options.validate) {
      throw new Error(`${op} must not be submitted without its check.`);
    }
    const id = randomUUID();
    const dir = join(this.options.jobsDir, id);
    const job: Job = {
      id,
      op,
      dir,
      prepare: async () => {
        const checked = (await options.validate?.({ cancelled: () => isDone(job.state) })) ?? {};
        if (checked.scriptAhead) {
          job.scriptAhead = checked.scriptAhead;
          job.logName = SCRIPT_LOG;
        }
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'job.json'), JSON.stringify({ op, args: 'args' in checked ? checked.args : args, opsDir: toPixPath(this.options.opsDir) }));
      },
      prepared: null,
      settled: false,
      withdrawn: false,
      beating: Promise.resolve(),
      scriptSent: false,
      sending: false,
      logName: JOB_LOG,
      logSize: 0,
      express: options.express ?? false,
      generation: this.options.target.generation,
      state: 'queued',
      createdAt: Date.now(),
      activity: 'unknown',
      listeners: [],
    };
    this.jobs.set(id, job);
    this.queue.push(job);
    if (!options.validate) this.startPreparing(job);
    void this.pump();
    return this.snapshot(job);
  }

  private startPreparing(job: Job): Promise<void> {
    job.prepared ??= job.prepare().finally(() => {
      job.settled = true;
      void this.pump();
    });
    job.prepared.catch(() => undefined);
    return job.prepared;
  }

  /**
   * Tells the runner that the server still waits for this job, or that it has given up. PixInsight
   * can get to a job long after it was sent, and what nobody waits for must not run.
   */
  private beat(job: Job): Promise<void> {
    const path = join(job.dir, 'awaited');
    job.beating = job.beating
      .then(async () => {
        await writeFile(`${path}.tmp`, String(job.withdrawn || isDone(job.state) ? 0 : Date.now()));
        // Only a few tries: the next sign of life follows in a second anyway.
        await renameWhenFree(`${path}.tmp`, path, 5);
      })
      .catch(() => undefined);
    return job.beating;
  }

  get(id: string): Promise<JobSnapshot | undefined> {
    const job = this.jobs.get(id);
    return job ? this.snapshotWithLog(job) : Promise.resolve(undefined);
  }

  /** Resolves when the job is done, the time is up or the signal fires, whichever comes first. */
  async wait(
    id: string,
    timeoutMs: number,
    onTick?: (snapshot: JobSnapshot) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<JobSnapshot> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    const deadline = Date.now() + timeoutMs;
    while (!isDone(job.state) && Date.now() < deadline && !signal?.aborted) {
      const remaining = deadline - Date.now();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, onTick ? 1000 : remaining));
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        job.listeners.push(wake);
        signal?.addEventListener('abort', wake, { once: true });
      });
      if (onTick && !isDone(job.state) && !signal?.aborted) await onTick(await this.snapshotWithLog(job));
    }
    return this.snapshotWithLog(job);
  }

  /** The job of this operation that has not ended yet, if there is one. */
  unfinished(op: string): JobSnapshot | undefined {
    const job = [this.active, ...this.queue].find((each) => each && each.op === op && !isDone(each.state));
    return job ? this.snapshot(job) : undefined;
  }

  /**
   * Withdraws a job that has not been handed to PixInsight: one in the queue, or the one whose
   * instance is still being found or started. Not one that is on its way there: its commands go
   * out one by one, and saying "never sent" in the middle of that would be a lie. See the Abort
   * notes in the docs for the rest.
   */
  cancelQueued(id: string): boolean {
    const index = this.queue.findIndex((job) => job.id === id);
    const waiting = this.active?.id === id && this.active.state === 'queued' && !this.active.sending;
    const job = index >= 0 ? this.queue.splice(index, 1)[0] : waiting ? (this.active ?? undefined) : undefined;
    if (!job) return false;
    this.finish(job, 'aborted', { error: { kind: 'cancelled', message: 'Cancelled before it was sent to PixInsight.' } });
    return true;
  }

  /**
   * Stops waiting for the job that is out at PixInsight, so that the queue moves on. Nothing else
   * can free the queue if the instance is stuck, or crashed where crashes cannot be seen.
   *
   * @returns Whether PixInsight had already started the job, whether anything of it still runs
   *   there, and what that means in words. A job that was not started will not run any more. One
   *   that was goes on, because nothing can stop it from outside, and so does a script that was
   *   sent ahead of the job. Null if this is not the job that is out.
   */
  async abandon(id: string): Promise<{ started: boolean; stillRuns: boolean; message: string } | null> {
    const job = this.active;
    if (job?.id !== id || isDone(job.state)) return null;
    // First withdraw, then look: the runner marks its start before it checks for a withdrawal, so
    // a job that shows no start by now will see the withdrawal, and cannot run.
    job.withdrawn = true;
    await this.beat(job);
    const started = await access(join(job.dir, 'started.json')).then(
      () => true,
      () => false,
    );
    if (isDone(job.state)) return null;
    const message = job.scriptSent
      ? 'The server stopped waiting for the script. It can still be open or at work in PixInsight: ask the user to close it. What it changes will not be reported, so look at the images before you go on.'
      : started
        ? 'The server stopped waiting for this job. PixInsight had started it, so it goes on there, and its result will not be reported. Look at the image before you go on.'
        : 'The server stopped waiting for this job. PixInsight had not started it, and it will not run any more.';
    this.finish(job, 'failed', { error: { kind: 'abandoned', message } });
    return { started, stillRuns: started || job.scriptSent, message };
  }

  /**
   * For when the server exits. Nothing may be left that PixInsight would run later, after a
   * dialog was closed, with no server there to see it.
   */
  async close(): Promise<void> {
    for (const job of this.queue.splice(0)) {
      this.finish(job, 'aborted', { error: { kind: 'cancelled', message: 'The server shut down before the job was sent.' } });
    }
    const job = this.active;
    if (job && !isDone(job.state)) {
      job.withdrawn = true;
      await this.beat(job);
      this.finish(job, 'failed', { error: { kind: 'abandoned', message: 'The server shut down while it waited for this job.' } });
    }
  }

  /** Images that held unsaved work when a job last saw the instance, if it is the one in use now. */
  unsavedSeen(): string[] {
    return this.seen?.generation === this.options.target.generation ? this.seen.unsaved : [];
  }

  /**
   * What an instance that is gone held when a job last saw it, as a sentence, or nothing if no job
   * ever saw it. Not what it held when it went: the user may have saved or changed images since.
   *
   * @param currentIsGone The instance in use has just been found gone, which the target only
   *   counts as a change once it has found another one.
   */
  describeLoss(currentIsGone: boolean): string {
    const current = this.seen?.generation === this.options.target.generation;
    const seen = this.seenBefore ?? (current && !currentIsGone ? null : this.seen);
    if (!seen) return '';
    const age = Math.round((Date.now() - seen.at) / 1000);
    const when = `When the server last looked, ${age < 120 ? `${age} s` : `${Math.round(age / 60)} min`} ago,`;
    return seen.unsaved.length ? `${when} these images held unsaved work: ${seen.unsaved.join(', ')}.` : `${when} no image held unsaved work.`;
  }

  /** The same, once, for the announcement that the instance has changed. */
  takeLoss(): string {
    const loss = this.describeLoss(false);
    if (!this.seenBefore && loss) this.seen = null;
    this.seenBefore = null;
    return loss;
  }

  private remember(images: NonNullable<JobResult['images']>): void {
    const generation = this.options.target.generation;
    if (this.seen && this.seen.generation !== generation) this.seenBefore = this.seen;
    this.seen = { generation, at: Date.now(), unsaved: images.filter((image) => image.unsaved).map((image) => image.view) };
  }

  stats(): { queued: number; active: JobSnapshot | null } {
    return { queued: this.queue.length, active: this.active ? this.snapshot(this.active) : null };
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let job = this.takeNext(); job; job = this.takeNext()) {
        this.active = job;
        await this.run(job);
      }
    } finally {
      this.active = null;
      this.pumping = false;
    }
  }

  private takeNext(): Job | undefined {
    const head = this.queue[0];
    if (!head) return undefined;
    if (head.settled) return this.queue.shift();
    // Its turn has come, so its check can start. Lookups that the check makes go past it.
    void this.startPreparing(head);
    const index = this.queue.findIndex((job) => job.express && job.settled);
    return index < 0 ? undefined : this.queue.splice(index, 1)[0];
  }

  private async run(job: Job): Promise<void> {
    try {
      await this.startPreparing(job);
    } catch (error) {
      const { kind, message } = error as Error & { kind?: string };
      this.finish(job, 'failed', { error: { kind: kind ?? 'job_setup_failed', message } });
      return;
    }
    const { target, cli, runnerPath } = this.options;
    try {
      job.slot = await target.resolve();
      // Finding or starting the instance can take long, and the job may have been withdrawn since.
      if (isDone(job.state)) return;
      if (!SAFE_ON_ANY_INSTANCE.has(job.op) && (job.generation !== target.generation || target.notice)) {
        const message = [
          'This job was not run, because the PixInsight instance changed after it was sent.',
          target.notice,
          this.describeLoss(false),
          'Check list_images, then send it again if it still applies.',
        ];
        this.finish(job, 'failed', { error: { kind: 'instance_changed', message: message.filter(Boolean).join(' ') } });
        return;
      }
      await this.options.ensureScripts?.();
      if (isDone(job.state)) return;
      // From here on the job is on its way. It can still be abandoned, and each step below looks
      // for that, but it cannot be cancelled as if it had never left: see cancelQueued.
      job.sending = true;
      await this.beat(job);
      if (job.scriptAhead) await this.sendScript(job, job.slot, job.scriptAhead);
      if (isDone(job.state)) {
        // The script is out, and no job follows to end the log that was started for it.
        if (job.scriptSent) await cli.execute(job.slot, this.options.endLogPath, []).catch(() => undefined);
        return;
      }
      await this.sendRunner(job, job.slot);
    } catch (error) {
      const kind = error instanceof CliError ? error.code : 'internal_error';
      if (kind === 'instance_not_running') target.invalidate();
      const loss = kind === 'instance_not_running' ? this.describeLoss(true) : '';
      this.finish(job, 'failed', { error: { kind, message: [(error as Error).message, loss].filter(Boolean).join(' ') } });
      return;
    }
    if (isDone(job.state)) return;
    job.state = 'sent';
    await this.watch(job, job.slot);
  }

  /**
   * Two commands in a row, which PixInsight takes in this order, with the job that reports on
   * the script as the third: the log, and the script.
   */
  private async sendScript(job: Job, slot: number, script: ScriptAhead): Promise<void> {
    const { cli, beginLogPath, endLogPath } = this.options;
    await cli.execute(slot, beginLogPath, [join(job.dir, SCRIPT_LOG), ...(script.view ? [script.view] : [])]);
    try {
      // Given up on in the meantime: the script must not start with nobody to report on it.
      if (!isDone(job.state)) {
        await cli.execute(slot, script.path, []);
        job.scriptSent = true;
      }
    } catch (error) {
      await cli.execute(slot, endLogPath, []).catch(() => undefined);
      if (error instanceof CliError && error.code === 'cli_failed') {
        throw new CliError(`${error.message} The script may have reached PixInsight all the same: if its dialog is open there, close it before you try again.`, error.code);
      }
      throw error;
    }
    // Nothing else would end the log that was just started.
    if (!job.scriptSent) await cli.execute(slot, endLogPath, []).catch(() => undefined);
  }

  private async sendRunner(job: Job, slot: number): Promise<void> {
    const { cli, runnerPath, endLogPath } = this.options;
    try {
      await cli.execute(slot, runnerPath, [job.dir]);
    } catch (error) {
      if (!job.scriptSent) throw error;
      // The script is out, and only its report is missing, so this is worth one more try.
      try {
        await cli.execute(slot, runnerPath, [job.dir]);
      } catch (again) {
        await cli.execute(slot, endLogPath, []).catch(() => undefined);
        const code = again instanceof CliError ? again.code : 'cli_failed';
        throw new CliError(
          `The script was started in PixInsight, but the job that reports on it could not be sent: ${(again as Error).message} The script can be open or at work there, so do not start it again. Look at the images once it has ended.`,
          code,
        );
      }
    }
  }

  private async watch(job: Job, slot: number): Promise<void> {
    let nextLiveness = Date.now() + this.livenessMs;
    let nextBeat = Date.now() + HEARTBEAT_MS;
    let cpuSample: { at: number; seconds: number } | null = null;
    while (!isDone(job.state)) {
      if (Date.now() >= nextBeat) {
        nextBeat = Date.now() + HEARTBEAT_MS;
        await this.beat(job);
      }
      if (job.state === 'sent' && (await readJson(join(job.dir, 'started.json'))) !== undefined) {
        job.state = 'running';
        job.idleSince = undefined;
      }
      const result = await readJson(join(job.dir, 'result.json'));
      if (result !== undefined) {
        await this.finishFromResult(job, result);
        return;
      }
      if (Date.now() >= nextLiveness) {
        nextLiveness = Date.now() + this.livenessMs;
        const instances = await this.options.cli.enumerate().catch(() => null);
        if (instances) {
          const instance = instances.find((candidate) => candidate.slot === slot);
          if (!instance || instance.crashed) {
            this.options.target.invalidate();
            this.finish(job, 'lost', {
              error: {
                kind: 'instance_lost',
                message: [
                  `PixInsight on slot ${slot} ${instance ? 'crashed' : 'exited'} before the job finished. Unsaved work in that instance is gone.`,
                  this.describeLoss(true),
                ]
                  .filter(Boolean)
                  .join(' '),
              },
            });
            return;
          }
          if (instance.pid !== null) cpuSample = await this.sampleCpu(job, instance.pid, cpuSample);
          await this.noteLogGrowth(job);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  private async finishFromResult(job: Job, result: unknown): Promise<void> {
    if (!isJobResult(result)) {
      this.finish(job, 'failed', { error: { kind: 'script_error', message: 'The job left an unreadable result behind.' } });
      return;
    }
    if (Array.isArray(result.images)) this.remember(result.images);
    const logPath = join(job.dir, job.logName);
    const lines = cleanLog(await readEnd(logPath, LOG_END_BYTES));
    const whole = ((await stat(logPath).catch(() => null))?.size ?? 0) <= LOG_END_BYTES;
    const start = whole ? null : cleanLog(await readStart(logPath, LOG_START_BYTES));
    const state: JobState = result.ok ? 'succeeded' : result.error?.kind === 'aborted' ? 'aborted' : 'failed';
    this.finish(job, state, {
      value: result.value,
      error: result.error,
      console: lines.filter(isProblem).slice(-PROBLEM_LINES),
      log: summarizeLog(lines, start),
    });
  }

  /**
   * A process that waits for a program it has started, or for a download, uses no CPU itself.
   * While it writes to its console it is at work all the same, and not waiting for the user.
   */
  private async noteLogGrowth(job: Job): Promise<void> {
    const size = (await stat(join(job.dir, job.logName)).catch(() => null))?.size ?? 0;
    if (size > job.logSize) {
      job.logSize = size;
      job.idleSince = undefined;
      if (job.activity === 'idle') job.activity = 'computing';
    }
  }

  private async sampleCpu(
    job: Job,
    pid: number,
    previous: { at: number; seconds: number } | null,
  ): Promise<{ at: number; seconds: number } | null> {
    const seconds = await this.cpuSeconds(pid);
    if (seconds === null) {
      job.activity = 'unknown';
      return null;
    }
    const sample = { at: Date.now(), seconds };
    if (previous && sample.at > previous.at) {
      const cores = (seconds - previous.seconds) / ((sample.at - previous.at) / 1000);
      if (cores >= CPU_BUSY_CORES) {
        job.activity = 'computing';
        job.idleSince = undefined;
      } else {
        job.activity = 'idle';
        job.idleSince ??= previous.at;
      }
    }
    return sample;
  }

  private finish(job: Job, state: JobState, outcome: Pick<Job, 'value' | 'error' | 'console' | 'log'>): void {
    if (isDone(job.state)) return;
    job.state = state;
    job.value = outcome.value;
    job.error = outcome.error;
    job.console = outcome.console;
    job.log = outcome.log;
    job.finishedAt = Date.now();
    for (const listener of job.listeners.splice(0)) listener();
    this.finished.push(job);
    this.prune();
  }

  private prune(): void {
    while (this.finished.length > this.retainFinished) {
      const old = this.finished.shift();
      if (!old) break;
      this.jobs.delete(old.id);
      void rm(old.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private snapshot(job: Job): JobSnapshot {
    const done = isDone(job.state);
    const waitingForInput =
      !done && job.idleSince !== undefined && Date.now() - job.idleSince >= this.idleThresholdMs;
    return {
      id: job.id,
      op: job.op,
      state: job.state,
      done,
      ...(job.slot !== undefined ? { slot: job.slot } : {}),
      activity: done ? 'unknown' : job.activity,
      waitingForInput,
      ...(job.value !== undefined ? { value: job.value } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.console?.length ? { console: job.console } : {}),
      ...(job.log?.length ? { log: job.log } : {}),
      elapsedMs: (job.finishedAt ?? Date.now()) - job.createdAt,
    };
  }

  private async snapshotWithLog(job: Job): Promise<JobSnapshot> {
    const snapshot = this.snapshot(job);
    // A script sent ahead writes while the job itself has not started yet.
    if (snapshot.done || (job.state !== 'running' && !(job.state === 'sent' && job.scriptAhead))) return snapshot;
    const lines = cleanLog(await readEnd(join(job.dir, job.logName), LOG_TAIL_BYTES));
    return lines.length ? { ...snapshot, logTail: lines.slice(-LOG_TAIL_LINES) } : snapshot;
  }
}
