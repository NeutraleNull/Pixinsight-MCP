import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSafeForIpc, toPixPath } from '../platform.js';

export interface InstanceInfo {
  slot: number;
  /** Null for a crashed instance. */
  pid: number | null;
  crashed: boolean;
}

export interface LaunchOptions {
  readyScript: string;
  readyArg: string;
}

/** Everything the server does to PixInsight goes through its documented command line. */
export interface PixInsightCli {
  /** Resolves once the IPC command is delivered, long before the script has finished. */
  execute(slot: number, scriptPath: string, args: string[]): Promise<void>;
  /** Null where instances cannot be listed: on Windows `-e` opens a message box instead. */
  enumerate(): Promise<InstanceInfo[] | null>;
  /** Starts an own instance in automation mode. */
  launch(slot: number, options: LaunchOptions): void;
  /** Graceful: only takes effect while the instance is idle, and a GUI instance may still ask. */
  terminate(slot: number): Promise<void>;
  /** Not graceful. Leaves swap files behind. */
  kill(pid: number): void;
  /** Whether a process with this pid exists, which costs far less than listing instances. */
  isRunning(pid: number): boolean;
}

export class CliError extends Error {
  constructor(
    message: string,
    /** `no_instance`: an instance of the server's own could not be started or taken over. */
    readonly code: 'instance_not_running' | 'no_instance' | 'cli_failed',
  ) {
    super(message);
  }
}

const CLIENT_TIMEOUT_MS = 30_000;

/** Reads the table printed by `PixInsight -e`. */
export function parseEnumerate(stdout: string): InstanceInfo[] {
  const instances: InstanceInfo[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+|crashed)\s*$/.exec(line);
    if (!match) continue;
    const crashed = match[2] === 'crashed';
    instances.push({ slot: Number(match[1]), pid: crashed ? null : Number(match[2]), crashed });
  }
  return instances;
}

export class ProcessCli implements PixInsightCli {
  constructor(
    private readonly executable: string,
    private readonly options: { headless: boolean; cwd: string; platform?: NodeJS.Platform },
  ) {}

  private env(): NodeJS.ProcessEnv {
    return this.options.headless ? { ...process.env, QT_QPA_PLATFORM: 'offscreen' } : process.env;
  }

  /**
   * The output goes to a file instead of a pipe, because the client segfaults when the reader of
   * its output goes away, which happens if this server exits during a call.
   */
  private async run(args: string[]): Promise<string> {
    const path = join(this.options.cwd, `cli-${randomUUID()}.txt`);
    try {
      const failure = await new Promise<string | null>((resolve, reject) => {
        const output = openSync(path, 'w');
        const child = spawn(this.executable, args, {
          env: this.env(),
          cwd: this.options.cwd,
          stdio: ['ignore', output, output],
          timeout: CLIENT_TIMEOUT_MS,
          windowsHide: true,
        });
        closeSync(output);
        child.once('error', (error) => reject(new CliError(`PixInsight command failed: ${error.message}`, 'cli_failed')));
        child.once('close', (code, signal) => resolve(code === 0 ? null : (signal ?? `exit code ${code}`)));
      });
      const output = await readFile(path, 'utf8');
      if (failure === null) return output;
      const fatal = output.split('\n').find((line) => line.includes('Fatal Error'))?.trim();
      if (fatal?.includes('is not running') || fatal?.includes('has crashed')) {
        throw new CliError(fatal, 'instance_not_running');
      }
      throw new CliError(fatal ?? `PixInsight command failed: ${failure}`, 'cli_failed');
    } finally {
      await rm(path, { force: true });
    }
  }

  async execute(slot: number, scriptPath: string, args: string[]): Promise<void> {
    const parts = [scriptPath, ...args].map(toPixPath);
    parts.forEach(assertSafeForIpc);
    await this.run([`-x=${slot}:${parts.join(',')}`]);
  }

  async enumerate(): Promise<InstanceInfo[] | null> {
    if ((this.options.platform ?? process.platform) === 'win32') return null;
    return parseEnumerate(await this.run(['-e']));
  }

  launch(slot: number, options: LaunchOptions): void {
    const script = [options.readyScript, options.readyArg].map(toPixPath);
    script.forEach(assertSafeForIpc);
    const child = spawn(
      this.executable,
      [`-n=${slot}`, '--automation-mode', '--no-focus-stealing', '--no-startup-scripts', `-r=${script.join(',')}`],
      { env: this.env(), cwd: this.options.cwd, detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.on('error', (error) => console.error(`Could not start PixInsight on slot ${slot}: ${error.message}`));
    child.unref();
  }

  async terminate(slot: number): Promise<void> {
    await this.run([`--terminate=${slot}`]);
  }

  kill(pid: number): void {
    process.kill(pid, 'SIGKILL');
  }

  isRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}
