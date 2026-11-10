import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError, type InstanceInfo, type PixInsightCli } from './cli.js';
import type { JobTarget } from './jobs.js';
import { SlotLeases } from './lease.js';


export interface ManagedInstanceOptions {
  /** False for an instance that never has images open, which saves a step when stopping. */
  holdsImages?: boolean;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** How long the instance is trusted to be there without looking. */
  recheckMs?: number;
  /** How long a leftover instance gets to say how it runs. */
  adoptTimeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(path: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readFile(path, 'utf8').catch(() => null);
    if (text !== null) return text;
    await sleep(100);
  }
  return null;
}

export interface ManagedInstancePaths {
  readyPath: string;
  closeAllPath: string;
  home: string;
  leasesDir: string;
}

/**
 * An instance this server owns, which makes it safe to stop and restart, unlike the user's
 * instance. It is only ever stopped if it is the very instance this server started or took over.
 */
export class ManagedInstance implements JobTarget {
  private readonly leases: SlotLeases;
  private starting: Promise<number> | null = null;
  private ready = false;
  private owned: { slot: number; pid: number | null } | null = null;
  private lossNotice: string | undefined;
  private changes = 0;
  private checkedAt = 0;
  /** A stop came in while the instance was starting. */
  private stopRequested = false;

  private readonly holdsImages: boolean;
  private readonly readyTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly recheckMs: number;
  private readonly adoptTimeoutMs: number;

  /** @param slots Candidates in order of preference, used by the first one that is free. */
  constructor(
    private readonly cli: PixInsightCli,
    private readonly slots: readonly number[],
    private readonly paths: ManagedInstancePaths,
    options: ManagedInstanceOptions = {},
  ) {
    this.leases = new SlotLeases(paths.leasesDir);
    this.holdsImages = options.holdsImages ?? true;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 90_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 1500;
    this.recheckMs = options.recheckMs ?? 3000;
    this.adoptTimeoutMs = options.adoptTimeoutMs ?? 5000;
  }

  get generation(): number {
    return this.changes;
  }

  get notice(): string | undefined {
    return this.lossNotice;
  }

  takeNotice(): string | undefined {
    const notice = this.lossNotice;
    this.lossNotice = undefined;
    return notice;
  }

  current(): { slot: number; pid: number | null } | null {
    return this.ready ? this.owned : null;
  }

  /** Returns the slot once the instance answers, starting it if necessary. */
  async resolve(): Promise<number> {
    if (this.ready && this.owned) {
      if (Date.now() - this.checkedAt < this.recheckMs) return this.owned.slot;
      // It can have died while nobody looked, and the slot can belong to another server by now.
      this.checkedAt = Date.now();
      if (await this.stillOurs(this.owned)) return this.owned.slot;
      this.invalidate();
    }
    this.stopRequested = false;
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    const slot = await this.starting;
    this.ready = true;
    this.checkedAt = Date.now();
    return slot;
  }

  /** The next `resolve()` looks again, because the job manager saw the instance go away. */
  invalidate(): void {
    if (this.ready) {
      this.changes++;
      this.lossNotice = 'The instance this server works in was lost. A new one starts with the next job. Images that were not saved are gone.';
    }
    this.ready = false;
  }

  private async start(): Promise<number> {
    const reasons: string[] = [];
    for (const slot of this.slots) {
      const instances = await this.cli.enumerate();
      const running = instances?.find((instance) => instance.slot === slot && !instance.crashed);
      const claim = await this.leases.claim(slot, instances === null ? undefined : (running?.pid ?? null));
      if (!claim) {
        reasons.push(`Slot ${slot} belongs to another running server.`);
        continue;
      }
      if (running) {
        // A leftover is what a server that is gone had recorded for this slot, or was just starting
        // when it died. Anything else may be the user's, and is left alone even if it runs unattended.
        const leftover = claim.replaced !== null && (claim.replaced.instance === running.pid || claim.replaced.instance === null);
        const answer = leftover ? await this.askHowItRuns(slot) : 'attended';
        if (answer === 'attended') {
          await this.leases.release(slot);
          reasons.push(`Slot ${slot} is occupied by another PixInsight instance.`);
          continue;
        }
        if (answer === 'silent') {
          if (!this.holdsImages && running.pid !== null) {
            // A leftover that never holds images and does not answer is stuck, and can only go.
            this.cli.kill(running.pid);
            await this.leases.release(slot);
            reasons.push(`Slot ${slot} held a stuck instance of an earlier server, which was ended.`);
            continue;
          }
          // It gave no answer, so it is busy or stuck. The lease stays as it was found, so that it
          // can be taken over once it answers. Without the lease nobody would ever claim it again.
          await this.leases.setInstance(slot, running.pid);
          reasons.push(`Slot ${slot} holds an instance that an earlier server left behind, and it does not answer (pid ${running.pid}). It may still be at work.`);
          continue;
        }
        await this.leases.setInstance(slot, running.pid);
        this.owned = { slot, pid: running.pid };
        return slot;
      }
      await this.launch(slot);
      return slot;
    }
    throw new CliError(reasons.join(' '), 'no_instance');
  }

  /** Asks an instance whether it runs in automation mode. A busy or stuck one gives no answer. */
  private async askHowItRuns(slot: number): Promise<'unattended' | 'attended' | 'silent'> {
    const marker = this.markerPath();
    try {
      await this.cli.execute(slot, this.paths.readyPath, [marker]);
      const answer = await waitForFile(marker, this.adoptTimeoutMs);
      if (answer === null) return 'silent';
      return (JSON.parse(answer) as { automation: boolean }).automation ? 'unattended' : 'attended';
    } finally {
      await rm(marker, { force: true });
    }
  }

  /**
   * Starts an instance and waits until it answers. Its pid goes into the lease as soon as it is
   * known, long before it is ready: a server that dies during a start then leaves a lease by which
   * the next one recognizes the instance.
   */
  private async launch(slot: number): Promise<void> {
    const marker = this.markerPath();
    this.owned = { slot, pid: null };
    try {
      this.cli.launch(slot, { readyScript: this.paths.readyPath, readyArg: marker });
      const deadline = Date.now() + this.readyTimeoutMs;
      for (;;) {
        const ready = (await waitForFile(marker, 300)) !== null;
        if (this.owned.pid === null) {
          const pid = (await this.instanceOn(slot))?.pid ?? null;
          if (pid !== null) {
            this.owned = { slot, pid };
            await this.leases.setInstance(slot, pid);
          }
        }
        if (ready) return;
        if (this.stopRequested) throw new CliError(`The start of PixInsight on slot ${slot} was called off.`, 'no_instance');
        if (Date.now() >= deadline) {
          // It may still come up, and then the next attempt recognizes it by the lease.
          throw new CliError(`PixInsight did not become ready on slot ${slot} within ${this.readyTimeoutMs / 1000} s.`, 'no_instance');
        }
      }
    } finally {
      await rm(marker, { force: true });
    }
  }

  private markerPath(): string {
    return join(this.paths.home, `ready-${randomUUID()}.json`);
  }

  private async instanceOn(slot: number): Promise<InstanceInfo | undefined> {
    const instances = await this.cli.enumerate();
    return instances?.find((instance) => instance.slot === slot);
  }

  /** Whether what is on the slot now is the instance this server owns, as far as it can be known. */
  private async stillOurs(owned: { slot: number; pid: number | null }): Promise<boolean> {
    const instances = await this.cli.enumerate();
    if (instances === null) return true;
    const current = instances.find((instance) => instance.slot === owned.slot);
    return current !== undefined && !current.crashed && current.pid === owned.pid;
  }

  /**
   * Graceful stop first, because only that removes the swap files. Closing all images keeps
   * `--terminate` from asking. It waits for the main thread, so a stuck instance gets killed.
   *
   * This has to be quick: a client that closes a server waits a few seconds and then kills it,
   * and an instance whose server died mid-stop stays behind until the next server takes it over.
   * So the wait goes by the pid, which costs nothing, and not by listing instances again.
   */
  async stop(): Promise<void> {
    if (this.starting) {
      // A server that exits has seconds, a start can take a minute. An instance that has not even
      // answered yet holds nothing, so it does not get the graceful way.
      this.stopRequested = true;
      const starting = this.owned;
      if (starting?.pid != null) this.cli.kill(starting.pid);
      await this.starting.catch(() => undefined);
    }
    this.ready = false;
    const owned = this.owned;
    if (!owned) return;
    this.owned = null;
    // Launched a moment ago and not listed yet: it cannot be stopped now. The lease stays, and by
    // it the next server recognizes the instance once it is up.
    if (owned.pid === null && (await this.cli.enumerate()) !== null) return;
    if (await this.stillOurs(owned)) {
      if (this.holdsImages) await this.cli.execute(owned.slot, this.paths.closeAllPath, []).catch(() => undefined);
      await this.cli.terminate(owned.slot).catch(() => undefined);
      if (owned.pid !== null) {
        const deadline = Date.now() + this.stopTimeoutMs;
        while (this.cli.isRunning(owned.pid) && Date.now() < deadline) await sleep(50);
        if (this.cli.isRunning(owned.pid)) this.cli.kill(owned.pid);
      }
    }
    await this.leases.release(owned.slot);
  }

  /**
   * Lets go of the instance without stopping it, and keeps the lease. The next server then takes
   * it over, with everything that is open in it. For when stopping would destroy unsaved work.
   */
  leaveRunning(): void {
    this.ready = false;
    this.owned = null;
  }

  /**
   * For when the instance is known to be stuck: skips the graceful attempt.
   *
   * @returns Whether the instance is gone now. Without a pid or a way to list instances, it may not be.
   */
  async killNow(): Promise<boolean> {
    this.ready = false;
    const owned = this.owned;
    if (!owned || owned.pid === null) return false;
    const instances = await this.cli.enumerate();
    if (instances === null) return false;
    const current = instances.find((instance) => instance.slot === owned.slot);
    if (current?.pid === owned.pid) this.cli.kill(owned.pid);
    this.owned = null;
    await this.leases.release(owned.slot);
    return true;
  }
}
