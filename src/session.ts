import { CliError, ProcessCli, type InstanceInfo, type PixInsightCli } from './bridge/cli.js';
import { EnumCheckInconclusive, EnumGuard } from './bridge/enumGuard.js';
import { ManagedInstance } from './bridge/instance.js';
import { JobManager, type JobSnapshot, type JobTarget } from './bridge/jobs.js';
import { SlotLeases } from './bridge/lease.js';
import { SharedTarget } from './bridge/target.js';
import { shadowSlots, type Config } from './config.js';
import type { Installation } from './guides.js';
import { prepareHome, type HomePaths } from './home.js';
import { assertSafeForIpc } from './platform.js';
import { blockReason, parameterRefusal, scriptBlockReason } from './policy.js';
import { findScripts, hashOfFile, type ScriptFolder, type ScriptInfo } from './scripts.js';

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
        ownSlots: [...shadowSlots(config), config.workerSlot],
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
    return new Session(config, paths, pixinsight, jobs, target, worker, shadow, shadowJobs, leases, userScripts);
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
   * dialog, which only the user can work, so this is for the PixInsight the user sits at. The job
   * ends when the script has, and reports what is different then.
   */
  startScript(request: StartScriptRequest): JobSnapshot {
    if (this.config.mode !== 'shared') {
      throw new Refusal(
        'needs_window',
        'A script opens a dialog that only the user can work, and this PixInsight instance has no window. Scripts can be started in shared mode only.',
      );
    }
    // A second one would open right after the first, on images the first one has changed.
    const open = this.jobs.unfinished('start_script');
    if (open) {
      throw new Refusal('script_open', `A script is still open or waiting in PixInsight (job ${open.id}). Wait for it with get_job before you start another one.`);
    }
    const generation = this.target.generation;
    return this.jobs.submit('start_script', request, {
      validate: async (job) => {
        const found = await this.findScript(request.script);
        // The step below brings an image to the front, which a job that will not run must not do.
        if (job.cancelled()) return {};
        if (this.target.generation !== generation || this.target.notice) {
          throw new Refusal('instance_changed', 'The script was not started, because the PixInsight instance changed after it was asked for. Check list_images, then start it again if it still applies.');
        }
        const prepared = await this.lookup<{ startedOn: string | null; images: unknown }>('prepare_script', { view: request.view });
        return {
          args: { script: found.name, startedOn: prepared.startedOn, before: prepared.images },
          scriptAhead: { path: found.path, view: request.view },
        };
      },
    });
  }

  private async findScript(name: string): Promise<ScriptInfo> {
    const scripts = await this.scripts();
    const wanted = name.trim().toLowerCase();
    const found = scripts.find((script) => script.name.toLowerCase() === wanted);
    if (!found) {
      const similar = scripts.filter((script) => script.name.toLowerCase().includes(wanted) || wanted.includes(script.name.toLowerCase())).map((script) => script.name);
      throw new Refusal('unknown_script', `No script named ${name}.${similar.length ? ` Did you mean ${similar.slice(0, 5).join(', ')}?` : ''} Use list_scripts.`);
    }
    const blocked = scriptBlockReason(found.menus);
    if (blocked) throw new Refusal('blocked_script', `${found.name} cannot be started through this tool: ${blocked}.`);
    try {
      assertSafeForIpc(found.path);
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
  async instances(): Promise<Array<InstanceInfo & { role?: 'shadow' | 'worker' }> | null> {
    const instances = await this.cli.enumerate();
    const shadows = shadowSlots(this.config);
    // A lease outside the shadow slots is the worker of some server, whatever slot it chose.
    const workers = new Set([...(await this.leases.slots()), ...(this.worker ? [this.config.workerSlot] : [])]);
    return (
      instances?.map((instance) => {
        if (shadows.includes(instance.slot)) return { ...instance, role: 'shadow' as const };
        if (workers.has(instance.slot)) return { ...instance, role: 'worker' as const };
        return instance;
      }) ?? null
    );
  }
}
