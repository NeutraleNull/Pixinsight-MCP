import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { InstanceInfo, LaunchOptions, PixInsightCli } from '../../src/bridge/cli.js';

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
  /** Scripts of the installation that were started. */
  started: Array<{ slot: number; path: string }> = [];
  /** What a started script does until it ends. Like PixInsight, the fake takes one script after the other. */
  userScript: (path: string, logPath: string | undefined) => void | Promise<void> = () => undefined;
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

  async enumerate(): Promise<InstanceInfo[] | null> {
    return this.listable ? this.instances : null;
  }

  launch(slot: number, options: LaunchOptions): void {
    this.launched.push(slot);
    const { listedAfterMs, readyAfterMs } = this.startup;
    setTimeout(() => this.addInstance(slot), listedAfterMs);
    if (readyAfterMs !== null) setTimeout(() => void writeFile(options.readyArg, JSON.stringify({ automation: true })).catch(() => undefined), readyAfterMs);
  }

  async terminate(slot: number): Promise<void> {
    this.terminated.push(slot);
    this.remove(slot);
  }

  kill(pid: number): void {
    this.killed.push(pid);
    this.instances = this.instances.filter((instance) => instance.pid !== pid);
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
