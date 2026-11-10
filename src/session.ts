import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { CliError, ProcessCli, type InstanceInfo, type PixInsightCli } from './bridge/cli.js';
import { EnumCheckInconclusive, EnumGuard } from './bridge/enumGuard.js';
import { ManagedInstance } from './bridge/instance.js';
import { JobManager, type JobSnapshot, type JobTarget, type ScriptAhead } from './bridge/jobs.js';
import { SlotLeases } from './bridge/lease.js';
import { argumentsOf, WBPP, type PreprocessRequest } from './preprocessing/request.js';
import { PreprocessRuns, RunError, type RunSnapshot } from './preprocessing/runs.js';
import { SharedTarget } from './bridge/target.js';
import { preprocessSlots, shadowSlots, type Config } from './config.js';
import { changesIn, DialogFiles, engineOf, wrapperFor, type Command, type DialogAccess, type DialogChanges, type DialogDescription, type DialogState, type Field, type Question } from './scripts/dialogs.js';
import type { Installation } from './guides.js';
import { prepareHome, type HomePaths } from './home.js';
import { assertSafeForIpc, toPixPath } from './platform.js';
import { blockReason, parameterRefusal, scriptBlockReason } from './policy.js';
import { findScripts, hashOfFile, similarNames, type ScriptFolder, type ScriptInfo } from './scripts/catalog.js';

export interface ParameterInfo {
  id: string;
  type: string;
  readOnly: boolean;
  default?: unknown;
  enum?: boolean;
  columns?: string[];
}

export interface ProcessInfo {
  id: string;
  categories: string[];
  canProcessViews: boolean;
  canProcessGlobal: boolean;
  parameters: ParameterInfo[];
  constants: Array<{ name: string; value: number }>;
}

export interface RunProcessRequest {
  processId: string;
  view?: string | undefined;
  global?: boolean | undefined;
  params?: Record<string, unknown> | undefined;
  description?: string | undefined;
  mask?: { view: string; inverted?: boolean | undefined } | undefined;
  allowOverwrite?: boolean | undefined;
}

export interface StartScriptRequest {
  script: string;
  view?: string | undefined;
  /** Start the script as PixInsight would by itself, with a dialog that only the user can work. */
  plain?: boolean | undefined;
}

/** What a script that was started shows right now. */
export type ScriptView = (
  | { kind: 'done' }
  /** `changes`: what is different since the assistant last read this dialog, which then stands for all of it. */
  | { kind: 'dialog'; dialog: DialogDescription; picture?: string; changes?: DialogChanges }
  /** One field of the dialog, read by itself and in full. */
  | { kind: 'field'; title: string; field: Field }
  | { kind: 'question'; question: Question }
  /**
   * Neither a dialog nor a question could be read. `no_dialog`: none is open, so the script is at
   * work, has not started yet, or shows a window of PixInsight. `not_answering`: a dialog is open,
   * but the script is busy in it. `working`: the script took an action and has not finished it.
   * `not_yet`: the dialog does not show the field that was waited for.
   */
  | { kind: 'none'; why: 'no_dialog' | 'not_answering' | 'working' | 'not_yet' }
) & {
  job: JobSnapshot;
  /** What else the assistant has to know, such as an earlier action that failed in the script. */
  notes?: string[];
};

export interface DialogAction {
  action: 'set' | 'press' | 'click' | 'answer' | 'close';
  field?: string | undefined;
  value?: string | number | boolean | string[] | undefined;
  x?: number | undefined;
  y?: number | undefined;
  allowOverwrite?: boolean | undefined;
}

export interface DialogLook {
  waitMs: number;
  picture?: boolean | undefined;
  help?: boolean | undefined;
  /**
   * The text of a field that the dialog has to show before it is returned, such as the button
   * that ends a long run. Only for the dialog that the assistant last read: another one, a
   * question and the end of the script are returned at once.
   */
  until?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface FieldRequest {
  field: string;
  /** The row of a table, or the character of a text, to read from. */
  from?: number | undefined;
  help?: boolean | undefined;
}

/** The value, or null if it fails or takes longer than a quick lookup may. */
function soon<T>(promise: Promise<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), QUICK_LOOKUP_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** A request that was turned down, with a code the assistant can act on. */
export class Refusal extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

const METADATA_TIMEOUT_MS = 20_000;
/** For facts that are nice to have, such as what is installed: not worth holding up an answer. */
const QUICK_LOOKUP_MS = 4000;
const SHADOW_IDLE_MS = 5 * 60_000;
/** How often the files of a dialog are looked at. The hook in the script looks ten times a second. */
const DIALOG_POLL_MS = 40;
/** A picture is taken at once, or something is wrong. */
const PICTURE_WAIT_MS = 5000;
/** The hook looks every 100 ms and does nothing in the tick a dialog appears in, so less is never enough. */
const MIN_DIALOG_WAIT_MS = 1000;
/** How often a dialog is looked at while a field of it is waited for. A look takes a script a few tenths of a second. */
const UNTIL_POLL_MS = 2000;

/** The script that was started last with access to its dialogs, and what the assistant knows of it. */
interface OpenScript {
  jobId: string;
  files: DialogFiles;
  /**
   * The dialog and the question that a result last showed to the assistant. It may only act on
   * these. `fields` is what that dialog showed then, which the next result of an action is
   * compared with.
   */
  shown: { dialog: string | null; question: number | null; fields: Map<string, Field> | null };
  /** Actions the script took and has not answered, because it asked or opened a dialog first. */
  late: Array<{ id: number; what: string }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What is known about the instance in use. Another one can have other processes and versions. */
interface InstanceFacts {
  generation: number;
  processes: Map<string, Promise<ProcessInfo>>;
  installed: Set<string> | null;
  guard: Promise<EnumGuard> | null;
  scripts: Promise<ScriptInfo[]> | null;
}

export class Session {
  private known: InstanceFacts = { generation: -1, processes: new Map(), installed: null, guard: null, scripts: null };
  private shadowIdleTimer: NodeJS.Timeout | null = null;
  /** How long a check waits for something it needs from PixInsight. */
  private lookupTimeoutMs = METADATA_TIMEOUT_MS;
  /** The files to the dialogs of the script that was started last, if it was started with them. */
  private script: OpenScript | null = null;
  /** One look or action at a time: the script takes one command after the other. */
  private dialogTurn: Promise<unknown> = Promise.resolve();
  private pictures = 0;

  private constructor(
    readonly config: Config,
    readonly paths: HomePaths,
    readonly cli: PixInsightCli,
    readonly jobs: JobManager,
    readonly target: JobTarget,
    private readonly worker: ManagedInstance | null,
    private readonly shadow: ManagedInstance,
    private readonly shadowJobs: JobManager,
    private readonly leases: SlotLeases,
    /** The scripts in the folders of the user, as they were when the server started. */
    private readonly userScripts: readonly ScriptInfo[],
    /** Runs of WBPP in instances of their own. They go on when this server ends. */
    readonly preprocessing: PreprocessRuns,
  ) {}

  /**
   * @param scriptsSource The folder with the scripts for PixInsight, if not the one that ships
   *   with the server. For tests that need an operation of their own: one that is only put into
   *   the installed folder is removed again before the next job.
   */
  static async create(config: Config, cli?: PixInsightCli, scriptsSource?: string): Promise<Session> {
    const paths = await prepareHome(config.home, scriptsSource);
    const pixinsight = cli ?? new ProcessCli(config.executable, { headless: config.headless, cwd: config.home });
    const leases = new SlotLeases(paths.leasesDir);
    const worker = config.mode === 'worker' ? new ManagedInstance(pixinsight, [config.workerSlot], paths) : null;
    const target =
      worker ??
      new SharedTarget(pixinsight, {
        slot: config.slot,
        ownSlots: [...shadowSlots(config), ...preprocessSlots(config), config.workerSlot],
        leasedSlots: () => leases.slots(),
      });
    const files = {
      cli: pixinsight,
      jobsDir: paths.jobsDir,
      opsDir: paths.opsDir,
      runnerPath: paths.runnerPath,
      beginLogPath: paths.beginLogPath,
      endLogPath: paths.endLogPath,
      ensureScripts: paths.restoreScripts,
    };
    const jobs = new JobManager({ ...files, target, needsValidation: ['run_process', 'start_script', 'run_code'] });
    const shadow = new ManagedInstance(pixinsight, shadowSlots(config), paths, { holdsImages: false });
    const shadowJobs = new JobManager({ ...files, target: shadow, livenessMs: 500 });
    // Read now, and to the end, before the assistant can do anything: a script that is added or
    // changed later in such a folder is not one the user had there when the session began.
    const userScripts = await findScripts(config.scriptDirs.map((dir) => ({ dir, source: 'user' })));
    const preprocessing = new PreprocessRuns(pixinsight, {
      slots: preprocessSlots(config),
      runsDir: paths.jobsDir,
      leasesDir: paths.leasesDir,
      beginLogPath: paths.beginLogPath,
      endLogPath: paths.endLogPath,
    });
    return new Session(config, paths, pixinsight, jobs, target, worker, shadow, shadowJobs, leases, userScripts, preprocessing);
  }

  /**
   * A pending announcement that the instance has changed, with what the old one held, once.
   * The assistant must get it with its next result, whatever tool that is.
   */
  takeNotice(): string | undefined {
    const notice = this.target.takeNotice();
    return notice ? [notice, this.jobs.takeLoss()].filter(Boolean).join(' ') : undefined;
  }

  /**
   * Stops only instances this server started. The user's instance is never touched.
   *
   * A worker with unsaved images, or in the middle of a job, is left running with its lease: the
   * next server takes it over. Stopping it would close the images without saving them, on every
   * end of a session.
   */
  async close(): Promise<void> {
    if (this.shadowIdleTimer) clearTimeout(this.shadowIdleTimer);
    const unsaved = this.jobs.unsavedSeen();
    const busy = this.jobs.stats().active !== null;
    await Promise.all([this.jobs.close(), this.shadowJobs.close()]);
    if (this.worker && (busy || unsaved.length > 0)) {
      console.error(
        `Left the PixInsight instance on slot ${this.config.workerSlot} running, because ` +
          (busy ? 'a job is still at work in it.' : `these images hold unsaved work: ${unsaved.join(', ')}.`) +
          ' The next server in worker mode takes it over.',
      );
      this.worker.leaveRunning();
    }
    await Promise.all([this.shadow.stop().catch(() => undefined), this.worker?.stop().catch(() => undefined)]);
  }

  private facts(): InstanceFacts {
    if (this.known.generation !== this.target.generation) {
      this.known = { generation: this.target.generation, processes: new Map(), installed: null, guard: null, scripts: null };
    }
    return this.known;
  }

  /**
   * What is installed, and for the given processes their parameters, to match guides to this
   * installation. Null, or fewer details, if PixInsight does not answer soon: a guide is still
   * worth reading without that.
   */
  async installation(processIds: readonly string[] = []): Promise<Installation | null> {
    const facts = this.facts();
    facts.installed ??= await this.listInstalled();
    const { installed } = facts;
    if (!installed) return null;
    const details: Installation['details'] = new Map();
    for (const id of processIds) {
      if (!installed.has(id) || (!facts.processes.has(id) && this.jobs.stats().active)) continue;
      const info = await soon(this.describe(id));
      if (info) {
        details.set(id, {
          parameters: new Set(info.parameters.map((parameter) => parameter.id)),
          constants: new Set(info.constants.map((constant) => constant.name)),
        });
      }
    }
    return { processes: installed, details };
  }

  private async listInstalled(): Promise<Set<string> | null> {
    // Behind a running job the answer would come too late anyway.
    if (this.jobs.stats().active) return null;
    const job = this.jobs.submit('list_processes', {}, { express: true });
    const snapshot = await this.jobs.wait(job.id, QUICK_LOOKUP_MS);
    if (!snapshot.done) this.jobs.cancelQueued(job.id);
    if (snapshot.state !== 'succeeded' || !Array.isArray(snapshot.value)) return null;
    return new Set((snapshot.value as Array<{ id: string }>).map((process) => process.id));
  }

  async describe(processId: string): Promise<ProcessInfo> {
    const { processes } = this.facts();
    let cached = processes.get(processId);
    if (!cached) {
      cached = this.lookup<ProcessInfo>('describe_process', { processId });
      processes.set(processId, cached);
      cached.catch(() => processes.delete(processId));
    }
    return cached;
  }

  /** Gets something from PixInsight that a check depends on. Nothing is left waiting if it takes too long. */
  private async lookup<T>(op: string, args: unknown): Promise<T> {
    const job = this.jobs.submit(op, args, { express: true });
    const snapshot = await this.jobs.wait(job.id, this.lookupTimeoutMs);
    if (snapshot.state === 'succeeded') return snapshot.value as T;
    if (snapshot.error) throw new Refusal(snapshot.error.kind, snapshot.error.message);
    const ahead = this.jobs.stats().active;
    // Also one that is already out: PixInsight would get to it much later, when nobody waits for
    // its answer any more, and a lookup can do something, such as bringing an image to the front.
    if (!this.jobs.cancelQueued(job.id)) await this.jobs.abandon(job.id);
    const why =
      ahead && ahead.id !== job.id
        ? `, because it is busy with an earlier job (${ahead.op})${ahead.waitingForInput ? ' and seems to be waiting for input in a dialog' : ''}`
        : snapshot.waitingForInput
          ? ' and seems to be waiting for input in a dialog'
          : '';
    throw new Refusal('busy', `PixInsight did not answer within ${this.lookupTimeoutMs / 1000} s${why}.`);
  }

  /** Queues the job right away, so that it keeps its place while it is being checked. */
  runProcess(request: RunProcessRequest): JobSnapshot {
    return this.jobs.submit('run_process', request, {
      validate: () =>
        this.validate(request).catch((error: Error) => {
          throw error instanceof Refusal ? error : new Refusal('internal_error', error.message);
        }),
    });
  }

  /**
   * The scripts of the Script menu: those the running PixInsight ships, which only it can say
   * where to find, and those that were in the folders of the user when the server started.
   */
  scripts(): Promise<ScriptInfo[]> {
    const facts = this.facts();
    facts.scripts ??= this.findAllScripts();
    facts.scripts.catch(() => {
      facts.scripts = null;
    });
    return facts.scripts;
  }

  private async findAllScripts(): Promise<ScriptInfo[]> {
    const { scriptsDir } = await this.lookup<{ scriptsDir?: string | null }>('ping', {});
    const atStart = new Map(this.userScripts.map((script) => [script.path, script]));
    const folders: ScriptFolder[] = [
      ...(scriptsDir ? [{ dir: scriptsDir, source: 'shipped' as const }] : []),
      ...this.config.scriptDirs.map((dir) => ({ dir, source: 'user' as const })),
    ];
    // A script of the user counts as what it was at the start, and one that came later does not count.
    return (await findScripts(folders)).flatMap((script) => (script.source === 'shipped' ? [script] : atStart.has(script.path) ? [atStart.get(script.path) as ScriptInfo] : []));
  }

  /**
   * Starts a script of the Script menu in the user's PixInsight. An ordinary script opens its
   * dialog, which the user works, and the assistant too if the script was started for that. The
   * job ends when the script has, and reports what is different then.
   */
  startScript(request: StartScriptRequest): JobSnapshot {
    if (this.config.mode !== 'shared') {
      throw new Refusal(
        'needs_window',
        'A script opens a dialog for the user, and this PixInsight instance has no window. Scripts can be started in shared mode only.',
      );
    }
    // A second one would open right after the first, on images the first one has changed.
    const open = this.jobs.unfinished('start_script');
    if (open) {
      throw new Refusal('script_open', `A script is still open or waiting in PixInsight (job ${open.id}). Wait for it with get_job before you start another one.`);
    }
    const generation = this.target.generation;
    const access = request.plain ? 'off' : this.config.scriptDialogs;
    const submitted = this.jobs.submit('start_script', request, {
      validate: async (job) => {
        const found = await this.findScript(request.script);
        // The step below brings an image to the front, which a job that will not run must not do.
        if (job.cancelled()) return {};
        if (this.target.generation !== generation || this.target.notice) {
          throw new Refusal('instance_changed', 'The script was not started, because the PixInsight instance changed after it was asked for. Check list_images, then start it again if it still applies.');
        }
        const prepared = await this.lookup<{ startedOn: string | null; images: unknown }>('prepare_script', { view: request.view, script: toPixPath(found.path) });
        const scriptAhead: ScriptAhead = { path: found.path, view: request.view };
        if (access !== 'off') {
          // The file that goes to PixInsight runs the script from inside, on the engine the script asks for.
          const engine = engineOf(await readFile(found.path, 'latin1'));
          scriptAhead.wrap = async (jobDir) => {
            const path = join(jobDir, 'start.js');
            await writeFile(path, wrapperFor(await readFile(this.paths.dialogHookPath, 'utf8'), jobDir, found.path, engine, access));
            return path;
          };
          if (engine === 'classic') scriptAhead.then = this.paths.dialogUnhookPath;
        }
        return { args: { script: found.name, startedOn: prepared.startedOn, before: prepared.images }, scriptAhead };
      },
    });
    this.script =
      access === 'off' ? null : { jobId: submitted.id, files: new DialogFiles(join(this.paths.jobsDir, submitted.id)), shown: { dialog: null, question: null, fields: null }, late: [] };
    return submitted;
  }

  /** Whether the dialogs of this job can be read through the server, and worked. */
  dialogAccessOf(jobId: string): DialogAccess {
    return this.script?.jobId === jobId ? this.config.scriptDialogs : 'off';
  }

  /**
   * Starts WBPP in its automation mode over these frames, in an instance of its own, once the
   * request is checked: see `preprocessing/request.ts`.
   */
  async startPreprocessing(request: PreprocessRequest, platform: NodeJS.Platform = process.platform): Promise<RunSnapshot> {
    const script = await this.findScript(WBPP);
    await this.paths.restoreScripts();
    try {
      const { args, outputDirectory } = await argumentsOf(request, platform);
      return await this.preprocessing.start({ script: script.path, args, outputDirectory });
    } catch (error) {
      if (error instanceof RunError) throw new Refusal(error.kind, error.message);
      throw error;
    }
  }

  /**
   * Waits for what a script shows: one that was just started, or one that is asked about by its
   * job. Null if the script was started without access to its dialogs, where only its end can be
   * waited for.
   */
  async watchScript(jobId: string, look: DialogLook): Promise<ScriptView | null> {
    const script = this.script?.jobId === jobId ? this.script : null;
    return script ? this.inTurn(() => this.settle(script, look)) : null;
  }

  /** How often a dialog is looked at while a field of it is waited for. */
  untilPollMs = UNTIL_POLL_MS;

  /** What the script that is open shows right now, after waiting for it if need be. */
  async scriptDialog(look: DialogLook): Promise<ScriptView> {
    if (look.until !== undefined && !look.until.trim()) throw new Refusal('invalid_value', 'until needs the text of the field to wait for, such as the text on a button.');
    const { script, ended } = await this.openScript();
    if (ended) return { kind: 'done', job: ended };
    return this.inTurn(() => this.settle(script, { ...look, waitMs: Math.max(look.waitMs, MIN_DIALOG_WAIT_MS) }));
  }

  /** One field of the dialog that the assistant last read, by itself and in full. */
  async scriptField(request: FieldRequest, look: DialogLook): Promise<ScriptView> {
    const { script, job, ended } = await this.openScript();
    if (ended) return { kind: 'done', job: ended };
    const { files, shown } = script;
    const waitMs = Math.max(look.waitMs, MIN_DIALOG_WAIT_MS);
    return this.inTurn(async () => {
      const state = await files.state();
      // What the script asks comes first, and a dialog that was not read has other fields.
      if (state?.question || !state?.dialog) return this.settle(script, { ...look, waitMs });
      if (state.dialog !== shown.dialog) {
        throw new Refusal('dialog_changed', `The script shows ${shown.dialog ? 'another dialog than the one you last read' : 'a dialog that you have not read yet'} (${JSON.stringify(state.title ?? '')}). Read it with get_script_dialog first, without a field.`);
      }
      const id = await files.post({ act: 'describe', dialog: state.dialog, help: request.help === true, field: request.field, from: request.from ?? 0 });
      const deadline = Date.now() + waitMs;
      for (;;) {
        const reply = await files.reply(id);
        if (reply && !reply.ok) throw new Refusal(reply.error.kind, reply.error.message);
        if (reply) return { kind: 'field', job, title: String(reply.result['title'] ?? ''), field: reply.result['field'] as Field };
        const now = await this.jobs.get(job.id);
        if (now?.done) return { kind: 'done', job: now };
        // The dialog closed, or the script asks something: that is what there is to show then.
        const current = await files.state();
        if (current?.question || current?.dialog !== state.dialog) {
          await files.withdraw(id);
          return this.settle(script, { ...look, waitMs });
        }
        if (Date.now() >= deadline || look.signal?.aborted) {
          await files.withdraw(id);
          return { kind: 'none', why: 'not_answering', job: now ?? job };
        }
        await sleep(DIALOG_POLL_MS);
      }
    });
  }

  /** Does one thing in the dialog of the script that is open, as the user would, and shows what came of it. */
  async useScriptDialog(action: DialogAction, look: DialogLook): Promise<ScriptView> {
    // The script was told the same and would refuse by itself. Nothing is sent to it all the same.
    if (this.config.scriptDialogs !== 'operate') throw new Refusal('read_only', 'The dialogs of scripts can only be read here, because the user has set it so. Say what to set, and the user works the dialog.');
    const { script, job, ended } = await this.openScript();
    if (ended) throw new Refusal('no_script', `The script has ended, so it has no dialog any more. Its report: get_job with the job ${ended.id}.`);
    const { files, shown } = script;
    const wait = { ...look, waitMs: Math.max(look.waitMs, MIN_DIALOG_WAIT_MS) };
    return this.inTurn(async () => {
      if (look.signal?.aborted) return { kind: 'none', why: 'no_dialog', job };
      const state = await files.state();
      const question = state?.question ?? null;
      if (action.action === 'answer' || (action.action === 'close' && question && question.kind !== 'message')) {
        if (!question) throw new Refusal('no_question', 'The script asks nothing right now. Read what it shows with get_script_dialog.');
        if (shown.question !== question.id) {
          // From here on the assistant has read it, in this message.
          shown.question = question.id;
          throw new Refusal('question_changed', `The script asks something you have not read yet (${this.inWords(question)}). Nothing was answered. Answer this question if you mean to.`);
        }
        const value = action.action === 'close' ? false : await this.checkedAnswer(question, action);
        // The user sees the question too, and may have answered it in the meantime.
        if ((await files.state())?.question?.id !== question.id) {
          throw new Refusal('no_question', 'The question is no longer open: the user has probably answered it in PixInsight. Read what the script shows now with get_script_dialog.');
        }
        await files.answer(question, value);
        const deadline = Date.now() + PICTURE_WAIT_MS;
        while ((await files.state())?.question?.id === question.id && Date.now() < deadline && !(await this.jobs.get(job.id))?.done) await sleep(DIALOG_POLL_MS);
        const view = await this.settle(script, { ...wait, changesOnly: true });
        if (view.kind === 'question' && view.question.id === question.id) {
          view.notes = [...(view.notes ?? []), 'Your answer was handed over, and the script has not taken it yet. Look again with get_script_dialog.'];
        }
        return view;
      }
      if (question) {
        shown.question = question.id;
        throw new Refusal('question_open', `The script asks something first (${this.inWords(question)}). Answer it with action "answer"${question.buttons ? ` and one of: ${question.buttons.join(', ')}` : ''}.`);
      }
      if (!state?.dialog) throw new Refusal('no_dialog', 'The script shows no dialog right now. It may be at work: check with get_script_dialog or get_job.');
      if (state.dialog !== shown.dialog) {
        throw new Refusal('dialog_changed', `The script shows ${shown.dialog ? 'another dialog than the one you last read' : 'a dialog that you have not read yet'} (${JSON.stringify(state.title ?? '')}). Nothing was done. Read it with get_script_dialog first.`);
      }
      const command = this.commandFor(action, state.dialog);
      const id = await files.post(command);
      return this.settle(script, { ...wait, changesOnly: true, sent: { id, dialog: state.dialog, what: `${action.action}${action.field ? ` ${action.field}` : ''}` } });
    });
  }

  /** The script whose dialogs can be worked, or the job it ended as. */
  private async openScript(): Promise<{ script: OpenScript; job: JobSnapshot; ended?: JobSnapshot }> {
    const job = this.jobs.unfinished('start_script');
    if (!job) {
      const last = this.script ? await this.jobs.get(this.script.jobId) : undefined;
      if (this.script && last?.done) return { script: this.script, job: last, ended: last };
      throw new Refusal('no_script', 'No script is open. Start one with start_script.');
    }
    if (this.script?.jobId !== job.id) {
      throw new Refusal('no_dialog_access', 'This script was started without access to its dialog, so only the user can work it. Say what to set there, and wait for the job.');
    }
    return { script: this.script, job };
  }

  private inWords(question: Question): string {
    return JSON.stringify(question.text ?? question.caption ?? question.kind);
  }

  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.dialogTurn.then(work, work);
    this.dialogTurn = turn.catch(() => undefined);
    return turn;
  }

  private commandFor(action: DialogAction, dialog: string): Command {
    const field = () => {
      if (!action.field) throw new Refusal('invalid_value', `Action "${action.action}" needs the id of a field, from get_script_dialog.`);
      return action.field;
    };
    switch (action.action) {
      case 'set':
        if (action.value === undefined || Array.isArray(action.value)) throw new Refusal('invalid_value', 'Action "set" needs a value: a text, a number, or true or false.');
        return { act: 'set', dialog, field: field(), value: action.value };
      case 'press':
        return { act: 'press', dialog, field: field() };
      case 'click':
        if (action.x === undefined || action.y === undefined) throw new Refusal('invalid_value', 'Action "click" needs x and y, in pixels of the dialog picture.');
        return { act: 'click', dialog, x: action.x, y: action.y };
      default:
        return { act: 'close', dialog };
    }
  }

  /**
   * What may be handed to the script as the answer to its question. A path is checked in the very
   * form the script gets it in, so that what is checked is what is used.
   */
  private async checkedAnswer(question: Question, action: DialogAction, platform: NodeJS.Platform = process.platform): Promise<string | string[] | false> {
    const { value } = action;
    if (question.kind === 'message') {
      const wanted = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (!question.buttons?.includes(wanted)) throw new Refusal('invalid_value', `Answer this message with one of its buttons: ${question.buttons?.join(', ')}.`);
      return wanted;
    }
    if (value === false) return false;
    const given = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    if (given.length === 0) throw new Refusal('invalid_value', 'Answer with an absolute path, or with false to cancel.');
    if (given.length > 1 && !question.multiple) throw new Refusal('invalid_value', 'The script asks for one path here.');
    const paths: string[] = [];
    for (const each of given) {
      // PixInsight takes forward slashes everywhere. Elsewhere than on Windows a backslash is part of a name.
      const path = platform === 'win32' ? toPixPath(each) : each;
      const absolute = platform === 'win32' ? /^([A-Za-z]:\/|\/\/)/.test(path) : isAbsolute(path) && !path.includes('\\');
      if (!absolute) throw new Refusal('invalid_path', `Answer with an absolute path, not ${each}.`);
      const found = await stat(path).catch(() => null);
      if (question.kind === 'open_file' && !found?.isFile()) throw new Refusal('no_such_file', `There is no file ${path}.`);
      if (question.kind === 'directory' && !found?.isDirectory()) throw new Refusal('no_such_file', `There is no folder ${path}.`);
      if (question.kind === 'save_file') {
        if (found?.isDirectory()) throw new Refusal('invalid_path', `${path} is a folder. Answer with the path of a file.`);
        if (!(await stat(dirname(path)).catch(() => null))?.isDirectory()) throw new Refusal('no_such_file', `There is no folder ${dirname(path)}.`);
        if (found && action.allowOverwrite !== true) {
          throw new Refusal('file_exists', `${path} exists, and the script would replace it. Only the user can allow that: then pass allowOverwrite: true.`);
        }
      }
      paths.push(path);
    }
    return question.multiple ? paths : (paths[0] as string);
  }

  /** What actions that the script answered late came to, for those that failed. */
  private async lateNotes(script: OpenScript): Promise<string[]> {
    const notes: string[] = [];
    for (const late of [...script.late]) {
      const reply = await script.files.reply(late.id);
      if (!reply) continue;
      script.late.splice(script.late.indexOf(late), 1);
      if (!reply.ok) notes.push(`An earlier action (${late.what}) failed in the script after it had asked or opened something: ${reply.error.message}`);
    }
    return notes;
  }

  /**
   * Waits until the script shows a dialog or asks something, has ended, or the time is up.
   *
   * @param look.sent An action that is out. Its reply comes when the script has handled it, which
   *   can be long after: a button can open another dialog, and that one then counts.
   * @param look.changesOnly After an action: for the dialog that the assistant last read, say
   *   what is different now, in place of all of it.
   */
  private async settle(script: OpenScript, look: DialogLook & { changesOnly?: boolean; sent?: { id: number; dialog: string; what: string } }): Promise<ScriptView> {
    const { files, jobId } = script;
    const deadline = Date.now() + look.waitMs;
    const notes: string[] = [];
    let sent = look.sent;
    let asked: number | null = null;
    /** An action the script has carried out, in case what follows cannot be shown. */
    let carried: string | null = null;
    // While a field is waited for: when to look at the dialog again, and whether it was missing.
    const wanted = look.until?.trim().toLowerCase();
    const waitedIn = script.shown.dialog;
    let lookAgainAt = 0;
    let missing = false;
    /** An action that is no longer waited for: taken back if the script has not taken it, noted for later if it has. */
    const letGo = async (reason: string): Promise<void> => {
      if (!sent) return;
      if (await files.withdraw(sent.id)) notes.push(`Your action (${sent.what}) was not carried out, because ${reason}.`);
      else script.late.push({ id: sent.id, what: sent.what });
      sent = undefined;
    };
    const finish = async (view: ScriptView): Promise<ScriptView> => {
      notes.push(...(await this.lateNotes(script)));
      if (view.kind === 'dialog') {
        const { shown } = script;
        const same = shown.dialog === view.dialog.dialog && shown.fields !== null;
        // A picture and tooltips are asked for to read all of a dialog, never after an action.
        if (look.changesOnly && same && shown.fields) view = { ...view, changes: changesIn(shown.fields, view.dialog.fields) };
        else if (look.changesOnly && shown.dialog !== null) notes.push('The script shows another dialog now than the one you worked, or the same one opened anew. Only the field ids of this description apply.');
        // A result that the client has given up on is never read, so it is not what the next one is compared with.
        if (!look.signal?.aborted) {
          shown.dialog = view.dialog.dialog;
          shown.fields = new Map(view.dialog.fields.map((field) => [field.id, field]));
        }
      }
      if (view.kind === 'question' && !look.signal?.aborted) script.shown.question = view.question.id;
      // Said where the result does not show it by itself.
      if (carried && view.kind === 'none') notes.push(`Your action (${carried}) was carried out. Do not repeat it.`);
      return notes.length ? { ...view, notes } : view;
    };
    try {
      for (;;) {
        const job = await this.jobs.get(jobId);
        if (!job) throw new Refusal('unknown_job', `No job ${jobId}.`);
        if (job.done) {
          if (asked !== null) await files.withdraw(asked);
          asked = null;
          if (sent) {
            // The script can end before this loop has seen its dialog go, or over the action itself.
            if (await files.withdraw(sent.id)) notes.push(`Your action (${sent.what}) was not carried out, because the dialog closed first.`);
            else {
              const reply = await files.reply(sent.id);
              if (reply && !reply.ok) notes.push(`Your action (${sent.what}) failed in the script: ${reply.error.message}`);
            }
            sent = undefined;
          }
          return await finish({ kind: 'done', job });
        }
        if (sent) {
          const reply = await files.reply(sent.id);
          if (reply && !reply.ok) throw new Refusal(reply.error.kind, reply.error.message);
          if (reply) {
            carried = sent.what;
            sent = undefined;
          }
        }
        const state: DialogState | null = await files.state();
        if (state?.question) {
          if (asked !== null) await files.withdraw(asked);
          asked = null;
          await letGo('the script asked this first');
          return await finish({ kind: 'question', job, question: state.question });
        }
        if (state?.dialog && (!sent || state.dialog !== sent.dialog)) {
          await letGo('the script showed this dialog first');
          if (asked === null && Date.now() >= lookAgainAt) asked = await files.post({ act: 'describe', dialog: null, help: look.help === true });
          const reply = asked === null ? undefined : await files.reply(asked);
          // What the hook cannot describe is a fault to report, not a dialog that is not there.
          if (reply && !reply.ok) {
            throw new Refusal(reply.error.kind, carried ? `Your action (${carried}) was carried out, so do not repeat it. But the dialog could not be read afterwards: ${reply.error.message}` : reply.error.message);
          }
          if (reply) {
            asked = null;
            const dialog = reply.result as unknown as DialogDescription;
            missing = Boolean(wanted) && dialog.dialog === waitedIn && !dialog.fields.some((field) => field['enabled'] !== false && [field['text'], field['value']].some((text) => typeof text === 'string' && text.trim().toLowerCase() === wanted));
            if (!missing) {
              const picture = look.picture ? await this.pictureOf(jobId, files, dialog.dialog, notes) : undefined;
              return await finish({ kind: 'dialog', job, dialog, ...(picture ? { picture } : {}) });
            }
            lookAgainAt = Date.now() + this.untilPollMs;
          }
        } else if (!state?.dialog) {
          // The dialog went away: before it could be read, or before it took what was sent.
          if (asked !== null) await files.withdraw(asked);
          asked = null;
          if (sent && (await files.withdraw(sent.id))) {
            notes.push(`Your action (${sent.what}) was not carried out, because the dialog closed first.`);
            sent = undefined;
          }
        }
        if (Date.now() >= deadline || look.signal?.aborted) {
          if (asked !== null) await files.withdraw(asked);
          asked = null;
          if (sent) {
            const what = sent.what;
            if (await files.withdraw(sent.id)) {
              sent = undefined;
              throw new Refusal('not_taken', `The dialog did not take your action (${what}) in time, so nothing was done. The script is busy in it. Look again with get_script_dialog, then try once more.`);
            }
            script.late.push({ id: sent.id, what });
            sent = undefined;
            return await finish({ kind: 'none', why: 'working', job });
          }
          return await finish({ kind: 'none', why: !state?.dialog ? 'no_dialog' : missing ? 'not_yet' : 'not_answering', job });
        }
        await sleep(DIALOG_POLL_MS);
      }
    } catch (error) {
      // Nothing may stay behind that the script would take later, with nobody waiting for it.
      if (asked !== null) await files.withdraw(asked).catch(() => false);
      if (sent) await files.withdraw(sent.id).catch(() => false);
      throw error;
    }
  }

  /** A picture of the dialog that was described, as PixInsight paints it, or nothing with a note why not. */
  private async pictureOf(jobId: string, files: DialogFiles, dialog: string, notes: string[]): Promise<string | undefined> {
    const path = join(files.dir, `dialog-${++this.pictures}.png`);
    const id = await files.post({ act: 'render', dialog, path: toPixPath(path) });
    const deadline = Date.now() + PICTURE_WAIT_MS;
    while (Date.now() < deadline && !(await this.jobs.get(jobId))?.done) {
      const reply = await files.reply(id);
      if (reply?.ok) return path;
      if (reply) {
        notes.push(`No picture: ${reply.error.message}`);
        return undefined;
      }
      await sleep(DIALOG_POLL_MS);
    }
    await files.withdraw(id);
    notes.push('No picture: the dialog did not answer in time.');
    return undefined;
  }

  private async findScript(name: string): Promise<ScriptInfo> {
    const scripts = await this.scripts();
    const wanted = name.trim().toLowerCase();
    const found = scripts.find((script) => script.name.toLowerCase() === wanted);
    if (!found) {
      const similar = similarNames(name, scripts.map((script) => script.name));
      throw new Refusal('unknown_script', `No script named ${name}.${similar.length ? ` Did you mean ${similar.join(', ')}?` : ''} Use list_scripts.`);
    }
    const blocked = scriptBlockReason(found.menus);
    if (blocked) throw new Refusal('blocked_script', `${found.name} cannot be started through this tool: ${blocked}.`);
    try {
      assertSafeForIpc(found.path);
      // PixInsight is given paths with forward slashes, which would name another file here.
      if (process.platform !== 'win32' && found.path.includes('\\')) throw new Error('backslash');
    } catch {
      throw new Refusal('blocked_script', `${found.name} cannot be started, because the path of its file has a character that PixInsight's command line does not take: ${found.path}`);
    }
    // What PixInsight is about to read has to be what was listed, and for a folder of the user
    // what was there when the server started. Otherwise writing a file would be a way to run code.
    if ((await hashOfFile(found.path).catch(() => null)) !== found.sha256) {
      throw new Refusal(
        'script_changed',
        `The file of ${found.name} has changed since ${found.source === 'user' ? 'the server started' : 'the server listed it'}, so it was not started. Only the user can take the change over, by restarting the server.`,
      );
    }
    return found;
  }

  /** Runs code of the assistant's own, which the user has to have turned on. */
  runCode(code: string): JobSnapshot {
    return this.jobs.submit('run_code', { code }, {
      validate: async () => {
        if (!this.config.allowCode) {
          throw new Refusal('blocked_code', 'Running code is turned off. Only the user can turn it on, with PIXINSIGHT_MCP_ALLOW_CODE=1 in the configuration of the server.');
        }
      },
    });
  }

  /** Checks everything that can be checked before the job gets near the target instance. */
  private async validate(request: RunProcessRequest): Promise<void> {
    const { processId, params = {} } = request;
    if (Boolean(request.view) === Boolean(request.global)) {
      throw new Refusal('invalid_target', 'Specify either a view or global: true.');
    }
    if (request.mask && request.global) {
      throw new Refusal('invalid_target', 'A mask only applies when running on a view.');
    }
    const info = await this.describe(processId);
    const blocked = blockReason(processId, info.categories, request.global);
    if (blocked) throw new Refusal('blocked_process', `${processId} cannot be run through this tool: ${blocked}.`);

    const byId = new Map(info.parameters.map((parameter) => [parameter.id, parameter]));
    const constants = new Set(info.constants.map((constant) => constant.name));
    const pending: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(params)) {
      const parameter = byId.get(name);
      if (!parameter) throw new Refusal('unknown_parameter', `${processId} has no parameter "${name}". PixInsight would silently ignore it.`);
      if (parameter.readOnly) throw new Refusal('read_only_parameter', `${processId}.${name} is read-only.`);
      if (!parameter.enum) continue;
      if (typeof value !== 'string' || !constants.has(value)) {
        throw new Refusal(
          'invalid_enum',
          `${processId}.${name} is an enumeration: pass one of the process's constant names as a string, not ${JSON.stringify(value)}. Use describe_process to list them.`,
        );
      }
      if (value !== parameter.default) pending.push([name, value]);
    }

    const refused = parameterRefusal(processId, info.parameters, params, {
      allowedPrograms: this.config.allowedPrograms,
      allowOverwrite: request.allowOverwrite === true,
    });
    if (refused) throw new Refusal('blocked_parameter', refused);

    if (pending.length) await this.checkEnums(processId, pending);
  }

  private async checkEnums(processId: string, pending: Array<[string, string]>): Promise<void> {
    const guard = await this.enumGuard();
    if (this.shadowIdleTimer) clearTimeout(this.shadowIdleTimer);
    try {
      for (const [name, constant] of pending) {
        const verdict = await guard.check(processId, name, constant);
        if (!verdict.safe) throw new Refusal('invalid_parameter_value', verdict.reason);
      }
    } catch (error) {
      // Only what says "could not check" is worth another try. Anything else is a fault in here.
      if (error instanceof EnumCheckInconclusive || error instanceof CliError) {
        throw new Refusal('busy', `Could not check the enumerated parameters of ${processId}: ${error.message}`);
      }
      throw error;
    } finally {
      this.scheduleShadowStop(guard);
    }
  }

  private enumGuard(): Promise<EnumGuard> {
    const facts = this.facts();
    facts.guard ??= this.lookup<{ build: number }>('ping', {}).then(
      ({ build }) => new EnumGuard(this.shadow, this.shadowJobs, this.paths.enumChecksPath, String(build)),
    );
    facts.guard.catch(() => {
      facts.guard = null;
    });
    return facts.guard;
  }

  /**
   * The shadow instance costs memory, so it only stays around while it is likely to be needed.
   * The guard stops it between two checks, never during one.
   */
  private scheduleShadowStop(guard: EnumGuard): void {
    if (this.shadowIdleTimer) clearTimeout(this.shadowIdleTimer);
    this.shadowIdleTimer = setTimeout(() => void guard.stopShadow(), SHADOW_IDLE_MS);
    this.shadowIdleTimer.unref();
  }

  /** Lists instances and says which of them are helpers, of this server or of another one. */
  async instances(): Promise<Array<InstanceInfo & { role?: 'shadow' | 'worker' | 'preprocessing' }> | null> {
    const instances = await this.cli.enumerate();
    const shadows = shadowSlots(this.config);
    const runs = preprocessSlots(this.config);
    // A lease outside the shadow slots is the worker of some server, whatever slot it chose.
    const workers = new Set([...(await this.leases.slots()), ...(this.worker ? [this.config.workerSlot] : [])]);
    return (
      instances?.map((instance) => {
        if (shadows.includes(instance.slot)) return { ...instance, role: 'shadow' as const };
        if (runs.includes(instance.slot)) return { ...instance, role: 'preprocessing' as const };
        if (workers.has(instance.slot)) return { ...instance, role: 'worker' as const };
        return instance;
      }) ?? null
    );
  }
}
