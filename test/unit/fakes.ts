import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { InstanceInfo, LaunchOptions, PixInsightCli, ScriptRun, StartedRun } from '../../src/bridge/cli.js';

type JobFile = { op: string; args: Record<string, any> };

/** The way the runner leaves a result behind: the server never sees half a file. */
export async function writeResult(jobDir: string, content: string): Promise<void> {
  await writeFile(join(jobDir, 'result.json.tmp'), content);
  await rename(join(jobDir, 'result.json.tmp'), join(jobDir, 'result.json'));
}

/** What the fake does with a job: return a value, or undefined if it writes its own result. */
export type Script = (job: JobFile, jobDir: string, pixinsight: FakePixInsight) => unknown | Promise<unknown>;

export function isRunning(cli: FakePixInsight, slot: number): boolean {
  return cli.instances.some((instance) => instance.slot === slot && !instance.crashed);
}

/** A path as it reaches PixInsight: with forward slashes on every system. */
export const pix = (path: string): string => path.replaceAll('\\', '/');

/**
 * Plays the part of PixInsight behind its command line: instances come and go on slots, and jobs
 * are answered through the job's files. A kill is only ever recorded, so a test cannot reach a
 * real process through a made-up pid.
 */
export class FakePixInsight implements PixInsightCli {
  instances: InstanceInfo[] = [];
  listable = true;
  /** The operations that reached an instance, in order. */
  ran: Array<{ slot: number; op: string; args: Record<string, any> }> = [];
  launched: number[] = [];
  /** Slots whose images were closed before a stop. */
  closedAll: number[] = [];
  /** What the runner reports about open images with every result, if set. */
  images: Array<{ view: string; unsaved: boolean }> | undefined;
  terminated: number[] = [];
  killed: number[] = [];
  automation = true;
  /** Slots whose instance is busy or stuck: it takes commands and never answers. */
  silent = new Set<number>();
  /** How a start goes: when the instance shows in the list, and when it answers, or null for never. */
  startup: { listedAfterMs: number; readyAfterMs: number | null } = { listedAfterMs: 0, readyAfterMs: 0 };
  /** What the heartbeat file of each job held when the job arrived. */
  awaited: string[] = [];
  /** Every command that arrived, in order, by the name of its script file. */
  commands: string[] = [];
  /** The files that console logs were started into, and the image that was brought to the front with each. */
  logs: Array<{ file: string; view: string | undefined }> = [];
  /** How often a console log was ended from outside a job. */
  logsEnded = 0;
  /** How often the clean-up after a script of the older engine arrived. */
  unhooked = 0;
  /** Scripts of the installation that were started. */
  started: Array<{ slot: number; path: string }> = [];
  /** What a started script does until it ends. Like PixInsight, the fake takes one script after the other. */
  userScript: (path: string, logPath: string | undefined) => void | Promise<void> = () => undefined;
  /** Instances that were started to run scripts and then to exit: what they were given, and how a test ends them. */
  runs: Array<{ slot: number; pid: number; scripts: ScriptRun[]; outputPath: string; end: (code: number | null) => void }> = [];
  /** What makes a start of such an instance fail, as a path does that the command line cannot take. */
  refuseRun: string | undefined;
  private scriptsBefore: Promise<void> = Promise.resolve();
  private nextPid = 1000;

  constructor(public script: Script = () => ({})) {}

  addInstance(slot: number, pid: number = this.nextPid++): InstanceInfo {
    const instance = { slot, pid, crashed: false };
    this.instances.push(instance);
    return instance;
  }

  crash(slot: number): void {
    this.instances = this.instances.map((instance) => (instance.slot === slot ? { slot, pid: null, crashed: true } : instance));
  }

  remove(slot: number): void {
    this.instances = this.instances.filter((instance) => instance.slot !== slot);
  }

  async execute(slot: number, scriptPath: string, args: string[]): Promise<void> {
    if (!isRunning(this, slot)) {
      const { CliError } = await import('../../src/bridge/cli.js');
      throw new CliError(`Slot ${slot} is not running`, 'instance_not_running');
    }
    if (this.silent.has(slot)) return;
    if (scriptPath.endsWith('ready.js')) {
      await writeFile(args[0] as string, JSON.stringify({ automation: this.automation }));
      return;
    }
    if (scriptPath.endsWith('close_all.js')) {
      this.closedAll.push(slot);
      return;
    }
    this.commands.push(basename(scriptPath));
    if (scriptPath.endsWith('begin_log.js')) {
      this.logs.push({ file: args[0] as string, view: args[1] });
      return;
    }
    if (scriptPath.endsWith('end_log.js')) {
      this.logsEnded++;
      return;
    }
    if (scriptPath.endsWith('unhook.js')) {
      this.unhooked++;
      return;
    }
    if (!scriptPath.endsWith('runner.js')) {
      this.started.push({ slot, path: scriptPath });
      const log = this.logs.at(-1)?.file;
      this.scriptsBefore = this.scriptsBefore.then(() => this.userScript(scriptPath, log));
      return;
    }
    const jobDir = args[0] as string;
    const job = JSON.parse(await readFile(join(jobDir, 'job.json'), 'utf8')) as JobFile;
    this.awaited.push(await readFile(join(jobDir, 'awaited'), 'utf8').catch(() => 'missing'));
    this.ran.push({ slot, op: job.op, args: job.args });
    void this.scriptsBefore.then(() => this.answer(job, jobDir));
  }

  private async answer(job: JobFile, jobDir: string): Promise<void> {
    await writeFile(join(jobDir, 'started.json'), '{}');
    const value = await this.script(job, jobDir, this);
    if (value !== undefined) await writeResult(jobDir, JSON.stringify({ ok: true, value, images: this.images }));
  }

  /** How often PixInsight was asked for its instances, which is a call that has its price. */
  listings = 0;

  async enumerate(): Promise<InstanceInfo[] | null> {
    this.listings++;
    return this.listable ? this.instances : null;
  }

  launch(slot: number, options: LaunchOptions): void {
    this.launched.push(slot);
    const { listedAfterMs, readyAfterMs } = this.startup;
    setTimeout(() => this.addInstance(slot), listedAfterMs);
    if (readyAfterMs !== null) setTimeout(() => void writeFile(options.readyArg, JSON.stringify({ automation: true })).catch(() => undefined), readyAfterMs);
  }

  runToExit(slot: number, scripts: ScriptRun[], outputPath: string): StartedRun {
    if (this.refuseRun) throw new Error(this.refuseRun);
    const { pid } = this.addInstance(slot) as { pid: number };
    let end!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      end = (code) => {
        this.remove(slot);
        resolve(code);
      };
    });
    this.runs.push({ slot, pid, scripts, outputPath, end });
    return { pid, exited };
  }

  async terminate(slot: number): Promise<void> {
    this.terminated.push(slot);
    this.remove(slot);
  }

  /** Set to make ending a run fail. */
  refuseEndRun: string | undefined;
  ended: Array<number | undefined> = [];

  endRun(run: StartedRun): void {
    if (this.refuseEndRun) throw new Error(this.refuseEndRun);
    this.ended.push(run.pid);
    this.runs.find((each) => each.pid === run.pid)?.end(null);
  }

  kill(pid: number): void {
    this.killed.push(pid);
    this.instances = this.instances.filter((instance) => instance.pid !== pid);
    // An instance that runs scripts to its end is gone with them.
    this.runs.find((run) => run.pid === pid)?.end(null);
  }

  isRunning(pid: number): boolean {
    return this.instances.some((instance) => instance.pid === pid);
  }
}

/** Ends a job with an error, the way the runner does. */
export async function failJob(jobDir: string, kind: string, message: string): Promise<undefined> {
  await writeResult(jobDir, JSON.stringify({ ok: false, error: { kind, message } }));
  return undefined;
}

export async function makePaths(home: string): Promise<{ readyPath: string; closeAllPath: string; home: string; leasesDir: string }> {
  await mkdir(home, { recursive: true });
  return { readyPath: '/scripts/ready.js', closeAllPath: '/scripts/close_all.js', home, leasesDir: join(home, 'leases') };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Condition was not met in time');
    await sleep(5);
  }
}

/** What the hook inside a started script can do, for a test that plays its part. */
export interface HookPart {
  dir: string;
  /** Says what is open now. Without details: the first showing of one dialog, and no question. */
  say: (state?: object) => Promise<void>;
  /** The next command of the server, once it is there. */
  command: () => Promise<Record<string, any>>;
  reply: (id: number, body: object) => Promise<void>;
  /** What the server answers to a question, once it has. */
  answerTo: (questionId: number) => Promise<unknown>;
}

/**
 * Lets a test play the script that the server starts with access to its dialogs: the script runs
 * as long as `part` does, and talks to the server through the files in the folder of the job.
 */
export function playScript(cli: FakePixInsight, part: (hook: HookPart) => Promise<void>): void {
  cli.userScript = async (path) => {
    const dir = dirname(path);
    let serial = 0;
    const take = async (file: string): Promise<any> => {
      for (;;) {
        const content = JSON.parse(await readFile(join(dir, file), 'utf8').catch(() => 'null'));
        if (content) {
          await rm(join(dir, file));
          return content;
        }
        await sleep(3);
      }
    };
    await part({
      dir,
      say: async (state = {}) => {
        serial++;
        await writeFile(join(dir, `dialog-state-${serial}.json`), JSON.stringify({ serial, dialog: 'd1.1', title: 'Solver', question: null, ...state }));
      },
      command: () => take('dialog-cmd.json'),
      reply: (id, body) => writeFile(join(dir, `dialog-reply-${id}.json`), JSON.stringify(body)),
      answerTo: async (id) => (await take(`dialog-answer-${id}.json`)).value,
    });
  };
}

/**
 * A dialog with two fields that describes itself, takes every action, and ends the script when f2
 * is pressed or it is closed. Its text field shows what was last set, and can be read by itself.
 */
export const FORM_FIELDS = [
  { id: 'f1', type: 'Edit', value: 'initial', at: [8, 8, 100, 20] },
  { id: 'f2', type: 'PushButton', text: 'OK', at: [8, 40, 60, 20] },
];

export function playForm(cli: FakePixInsight, taken: Array<Record<string, any>> = []): void {
  playScript(cli, async (hook) => {
    const fields = FORM_FIELDS.map((field) => ({ ...field }));
    await hook.say();
    for (;;) {
      const command = await hook.command();
      taken.push(command);
      // Like the hook: what is meant for another dialog than the one on top is not done.
      if (command['dialog'] !== null && command['dialog'] !== 'd1.1') {
        await hook.reply(command['id'], { ok: false, error: { kind: 'dialog_changed', message: 'The script shows something else now.' } });
        continue;
      }
      const one = fields.find((field) => field.id === command['field']);
      if (command['act'] === 'describe' && command['field'] !== undefined) {
        if (one) await hook.reply(command['id'], { ok: true, result: { dialog: 'd1.1', title: 'Solver', field: { ...one, ...(command['from'] ? { from: command['from'] } : {}) } } });
        else await hook.reply(command['id'], { ok: false, error: { kind: 'unknown_field', message: `The dialog has no field ${command['field']}.` } });
      } else if (command['act'] === 'describe') await hook.reply(command['id'], { ok: true, result: { dialog: 'd1.1', title: 'Solver', size: [200, 80], fields: fields.map((field) => ({ ...field })) } });
      else if (command['act'] === 'render') await writeFile(command['path'], 'png').then(() => hook.reply(command['id'], { ok: true, result: { dialog: 'd1.1', size: [200, 80], covered: 0 } }));
      else if (command['field'] === 'f9') await hook.reply(command['id'], { ok: false, error: { kind: 'unknown_field', message: 'The dialog has no field f9.' } });
      else {
        if (command['act'] === 'set' && one) one.value = command['value'];
        await hook.reply(command['id'], { ok: true, result: { fired: ['onClick'] } });
      }
      if (command['act'] === 'close' || (command['act'] === 'press' && command['field'] === 'f2')) return hook.say({ dialog: null, title: null });
    }
  });
}
