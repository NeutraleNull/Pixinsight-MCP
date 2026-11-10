import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
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

/** A script to run with its arguments, as PixInsight takes them on its command line. */
export interface ScriptRun {
  path: string;
  args: string[];
}

/** An own instance that was started to run scripts and then to exit by itself. */
export interface StartedRun {
  /** The process that was started. On Linux that is the launcher, not the instance. */
  pid: number | undefined;
  /** Resolves once that process has ended: with its exit code, or with null if it could not be started or a signal ended it. */
  exited: Promise<number | null>;
}

/** Everything the server does to PixInsight goes through its documented command line. */
export interface PixInsightCli {
  /** Resolves once the IPC command is delivered, long before the script has finished. */
  execute(slot: number, scriptPath: string, args: string[]): Promise<void>;
  /** Null where instances cannot be listed: on Windows `-e` opens a message box instead. */
  enumerate(): Promise<InstanceInfo[] | null>;
  /** Starts an own instance in automation mode. */
  launch(slot: number, options: LaunchOptions): void;
  /**
   * Starts an own instance in automation mode that runs these scripts one after the other and
   * then exits by itself, with or without unsaved images. What it writes to its output goes to the file.
   */
  runToExit(slot: number, scripts: ScriptRun[], outputPath: string): StartedRun;
  /**
   * Ends what `runToExit` started, with everything that it started in turn. Only for a run that
   * has not ended yet: its process is this server's child until then, so nothing else has its pid.
   */
  endRun(run: StartedRun): void;
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
    /**
     * `no_instance`: an instance of the server's own could not be started or taken over.
     * `cli_timeout`: PixInsight's client did not come back, and was ended.
     */
    readonly code: 'instance_not_running' | 'no_instance' | 'cli_failed' | 'cli_timeout',
  ) {
    super(message);
  }
}

const CLIENT_TIMEOUT_MS = 30_000;
/** How long a listing that did not come back is not tried again. */
const STUCK_PAUSE_MS = 20_000;
/** A lock that is older than any call can last was left behind by a server that is gone. */
const LOCK_STALE_MS = CLIENT_TIMEOUT_MS + 15_000;

export interface CliOptions {
  headless: boolean;
  cwd: string;
  platform?: NodeJS.Platform;
  /** How long a client of PixInsight may take before it is ended. */
  timeoutMs?: number;
  /**
   * The file that says a client of PixInsight is running, for all servers of this user. Null for
   * none. The default is in the folder for temporary files, which is where PixInsight keeps the
   * names of what its instances share, so servers that can reach the same instances meet there.
   */
  lockPath?: string | null;
}

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
  private readonly platform: NodeJS.Platform;
  private readonly timeoutMs: number;
  private readonly lockPath: string | null;
  /** The calls of this server, one after the other. */
  private queue: Promise<unknown> = Promise.resolve();
  /** A listing that waits for its turn, which everyone who asks until then shares. */
  private listing: Promise<InstanceInfo[]> | undefined;
  /** A listing that did not come back, which is not tried again for a while: each try costs its whole time, and ends the same way. */
  private stuck: { error: CliError; until: number } | undefined;

  constructor(
    private readonly executable: string,
    private readonly options: CliOptions,
  ) {
    this.platform = options.platform ?? process.platform;
    this.timeoutMs = options.timeoutMs ?? CLIENT_TIMEOUT_MS;
    // On Windows nothing of what the lock is for exists: see run().
    this.lockPath = options.lockPath !== undefined ? options.lockPath : this.platform === 'win32' ? null : join(tmpdir(), `pixinsight-mcp-${userInfo().uid}-cli.lock`);
  }

  private env(): NodeJS.ProcessEnv {
    return this.options.headless ? { ...process.env, QT_QPA_PLATFORM: 'offscreen' } : process.env;
  }

  /**
   * Calls a client of PixInsight: one at a time, in this server and among the servers of this user.
   *
   * Two clients that run at the same time can leave a lock of PixInsight behind that nothing
   * releases, and from then on every listing of instances on the machine waits for it without
   * end. `docs/reference/pixinsight-behaviour.md` has what was measured.
   */
  private run(args: string[], onStart?: () => void): Promise<string> {
    const call = this.queue.then(async () => {
      const locked = await this.lock();
      try {
        onStart?.();
        return await this.call(args);
      } finally {
        // Only its own: a call that outlasted the lock finds the lock of someone else there.
        if (locked && this.lockPath && (await readFile(this.lockPath, 'utf8').catch(() => '')) === String(process.pid)) await rm(this.lockPath, { force: true });
      }
    });
    this.queue = call.catch(() => undefined);
    return call;
  }

  /** Takes the lock of all servers. False if it cannot be had: the call is then made without it, since waiting longer helps nobody. */
  private async lock(): Promise<boolean> {
    if (!this.lockPath) return false;
    const giveUp = Date.now() + LOCK_STALE_MS + 5_000;
    for (;;) {
      try {
        // Exclusive, which also refuses a link that someone put there.
        await writeFile(this.lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      }
      const held = await lstat(this.lockPath).catch(() => null);
      if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
        // Renamed first, so that only one of several waiting servers gets to remove it.
        const aside = `${this.lockPath}.${randomUUID()}`;
        await rename(this.lockPath, aside).then(
          () => rm(aside, { force: true }),
          () => undefined,
        );
      } else if (Date.now() > giveUp) return false;
      else await sleep(15 + Math.random() * 25);
    }
  }

  /**
   * The output goes to a file instead of a pipe, because the client segfaults when the reader of
   * its output goes away, which happens if this server exits during a call.
   */
  private async call(args: string[]): Promise<string> {
    const path = join(this.options.cwd, `cli-${randomUUID()}.txt`);
    // Elsewhere than on Windows the executable is a launcher, and ending it leaves the client it
    // started. As the leader of a group of its own, it can be ended together with that client.
    const grouped = this.platform !== 'win32';
    try {
      const failure = await new Promise<string | null>((resolve, reject) => {
        const output = openSync(path, 'w');
        let child;
        try {
          child = spawn(this.executable, args, { env: this.env(), cwd: this.options.cwd, detached: grouped, stdio: ['ignore', output, output], windowsHide: true });
        } finally {
          closeSync(output);
        }
        const started = child;
        const timer = setTimeout(() => {
          try {
            if (grouped && started.pid !== undefined) process.kill(-started.pid, 'SIGKILL');
            else started.kill('SIGKILL');
          } catch {
            // Gone in this moment.
          }
          reject(
            new CliError(
              `PixInsight did not answer within ${Math.round(this.timeoutMs / 1000)} s when it was called with ${args[0]?.split('=')[0] ?? 'no argument'}, and the call was ended. ` +
                'If this repeats with every call, a lock of PixInsight was left behind on this machine and blocks its command line: ' +
                'tell the user, and point to the troubleshooting section of the documentation. Calling again does not help.',
              'cli_timeout',
            ),
          );
        }, this.timeoutMs);
        started.once('error', (error) => {
          clearTimeout(timer);
          reject(new CliError(`PixInsight command failed: ${error.message}`, 'cli_failed'));
        });
        started.once('close', (code, signal) => {
          clearTimeout(timer);
          resolve(code === 0 ? null : (signal ?? `exit code ${code}`));
        });
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
    parts.forEach((part) => assertSafeForIpc(part, this.platform));
    await this.run([`-x=${slot}:${parts.join(',')}`]);
  }

  async enumerate(): Promise<InstanceInfo[] | null> {
    if (this.platform === 'win32') return null;
    if (this.stuck && Date.now() < this.stuck.until) throw this.stuck.error;
    // Whoever asks before a listing has begun gets that listing: it shows a state that is no older than the question.
    if (this.listing) return this.listing;
    const listing: Promise<InstanceInfo[]> = this.run(['-e'], () => {
      if (this.listing === listing) this.listing = undefined;
    }).then(parseEnumerate);
    this.listing = listing;
    listing.then(
      () => (this.stuck = undefined),
      (error: unknown) => {
        if (this.listing === listing) this.listing = undefined;
        if (error instanceof CliError && error.code === 'cli_timeout') this.stuck = { error, until: Date.now() + STUCK_PAUSE_MS };
      },
    );
    return listing;
  }

  launch(slot: number, options: LaunchOptions): void {
    const script = [options.readyScript, options.readyArg].map(toPixPath);
    script.forEach((part) => assertSafeForIpc(part, this.platform));
    const child = spawn(
      this.executable,
      [`-n=${slot}`, '--automation-mode', '--no-focus-stealing', '--no-startup-scripts', `-r=${script.join(',')}`],
      { env: this.env(), cwd: this.options.cwd, detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.on('error', (error) => console.error(`Could not start PixInsight on slot ${slot}: ${error.message}`));
    child.unref();
  }

  runToExit(slot: number, scripts: ScriptRun[], outputPath: string): StartedRun {
    const runs = scripts.map(({ path, args }) => {
      const parts = [toPixPath(path), ...args];
      parts.forEach((part) => assertSafeForIpc(part, this.platform));
      return `-r=${parts.join(',')}`;
    });
    // To a file and not to a pipe, like every output of PixInsight: see run().
    const output = openSync(outputPath, 'w');
    let child;
    try {
      // Detached, so that the run goes on if this server ends, and so that the launcher leads a
      // process group of its own, with the instance in it.
      child = spawn(this.executable, [`-n=${slot}`, '--automation-mode', '--no-focus-stealing', '--no-startup-scripts', ...runs, '--force-exit'], {
        env: this.env(),
        cwd: this.options.cwd,
        detached: true,
        stdio: ['ignore', output, output],
        windowsHide: true,
      });
    } finally {
      closeSync(output);
    }
    const exited = new Promise<number | null>((resolve) => {
      child.once('error', (error) => {
        console.error(`Could not start PixInsight on slot ${slot}: ${error.message}`);
        resolve(null);
      });
      child.once('close', (code) => resolve(code));
    });
    child.unref();
    return { pid: child.pid, exited };
  }

  endRun(run: StartedRun): void {
    if (run.pid === undefined) return;
    try {
      // On Windows the process that was started is the instance. Elsewhere it is the launcher, and the group it leads holds the instance.
      process.kill(this.platform === 'win32' ? run.pid : -run.pid, 'SIGKILL');
    } catch (error) {
      // Gone already, which is what was asked for.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
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
