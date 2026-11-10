import { readFile, writeFile } from 'node:fs/promises';
import { renameWhenFree } from '../platform.js';
import type { ManagedInstance } from './instance.js';
import type { JobManager } from './jobs.js';

export type EnumVerdict = { safe: true } | { safe: false; reason: string };

/** The check could not be carried out, which says nothing about the value being checked. */
export class EnumCheckInconclusive extends Error {}

export interface EnumGuardTimeouts {
  /** How long an assignment may take before it counts as hanging. */
  checkMs: number;
  /** How long a job may take to end after its instance was killed. */
  cleanupMs: number;
}

const TIMEOUTS: EnumGuardTimeouts = { checkMs: 6000, cleanupMs: 3000 };

/**
 * Assigning a value outside a parameter's enumeration can hang or crash PixInsight on plain
 * assignment, for some processes even with small values, and PJSR does not reveal which
 * constants belong to which parameter. So a combination that is not known to be safe is first
 * tried in a disposable instance, and the verdict is remembered per PixInsight build.
 *
 * A remembered verdict lasts as long as the build, so only clear outcomes are kept. A crash or
 * hang can have other causes, and has to happen twice to count. A hang is only a missing answer,
 * which a machine busy with a long process produces too, so it is believed for this session only.
 */
export class EnumGuard {
  private verdicts: Record<string, EnumVerdict> | null = null;
  private readonly forThisSession = new Map<string, EnumVerdict>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly shadow: ManagedInstance,
    private readonly jobs: JobManager,
    private readonly cachePath: string,
    private readonly build: string,
    private readonly timeouts: EnumGuardTimeouts = TIMEOUTS,
  ) {}

  /** Stops the shadow instance, after the check that is running, and before the next one. */
  stopShadow(): Promise<void> {
    const stopped = this.tail.then(() => this.shadow.stop()).catch(() => undefined);
    this.tail = stopped;
    return stopped;
  }

  /** Checks run one at a time because a failed check takes the shadow instance down. */
  check(processId: string, param: string, constant: string): Promise<EnumVerdict> {
    const result = this.tail.then(() => this.checkNow(processId, param, constant));
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async checkNow(processId: string, param: string, constant: string): Promise<EnumVerdict> {
    const key = `${this.build}:${processId}.${param}=${constant}`;
    this.verdicts ??= await this.readCache();
    const known = this.verdicts[key] ?? this.forThisSession.get(key);
    if (known) return known;

    const { verdict, lasting } = await this.tryInShadow(processId, param, constant);
    if (lasting) await this.remember(key, verdict);
    else this.forThisSession.set(key, verdict);
    return verdict;
  }

  private async tryInShadow(processId: string, param: string, constant: string): Promise<{ verdict: EnumVerdict; lasting: boolean }> {
    const first = await this.attempt(processId, param, constant);
    if (!('failure' in first)) return { verdict: first, lasting: true };
    const second = await this.attempt(processId, param, constant);
    if (!('failure' in second)) return { verdict: second, lasting: true };
    return {
      verdict: {
        safe: false,
        reason: `${processId}.${param} = ${constant} ${second.failure} PixInsight, so it was not applied. The constant most likely belongs to another parameter.`,
      },
      lasting: second.failure === 'crashes',
    };
  }

  private async attempt(processId: string, param: string, constant: string): Promise<EnumVerdict | { failure: 'crashes' | 'hangs' }> {
    await this.shadow.resolve();
    const job = this.jobs.submit('check_enum', { processId, param, constant });
    const snapshot = await this.jobs.wait(job.id, this.timeouts.checkMs);
    if (snapshot.state === 'succeeded') return { safe: true };
    if (snapshot.error?.kind === 'invalid_parameter_value') return { safe: false, reason: snapshot.error.message };
    if (snapshot.state === 'lost') return { failure: 'crashes' };
    if (snapshot.done) throw new EnumCheckInconclusive(snapshot.error?.message ?? `The check ended as ${snapshot.state}.`);

    // Clean up, so that the next attempt starts on a healthy instance.
    const gone = await this.shadow.killNow();
    const after = await this.jobs.wait(job.id, this.timeouts.cleanupMs);
    if (!after.done) await this.jobs.abandon(job.id);
    if (!gone) throw new EnumCheckInconclusive('The helper instance did not answer and could not be restarted.');
    return { failure: 'hangs' };
  }

  /**
   * Other servers write to the same file, so this adds to what is there now. The file wins over
   * memory: an entry that someone has removed from it stays removed.
   */
  private async remember(key: string, verdict: EnumVerdict): Promise<void> {
    this.verdicts = { ...(await this.readCache()), [key]: verdict };
    const temp = `${this.cachePath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(this.verdicts, null, 1));
    await renameWhenFree(temp, this.cachePath);
  }

  private async readCache(): Promise<Record<string, EnumVerdict>> {
    return readFile(this.cachePath, 'utf8')
      .then((text) => JSON.parse(text) as Record<string, EnumVerdict>)
      .catch(() => ({}));
  }
}
