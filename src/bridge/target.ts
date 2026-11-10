import { CliError, type InstanceInfo, type PixInsightCli } from './cli.js';
import type { JobTarget } from './jobs.js';

const RECHECK_MS = 3000;

/**
 * Decides which instance jobs go to in shared mode, and stays with it. Falling over silently to
 * whatever else is running would make the assistant work on the wrong images, or in this server's
 * own hidden helper instances, while everything looks fine. So a change of instance is always
 * announced, and instances this server owns are never a target.
 */
export class SharedTarget implements JobTarget {
  private pinned: { slot: number; pid: number | null } | null = null;
  private lost = false;
  private checkedAt = 0;
  private pendingNotice: string | undefined;
  private changes = 0;

  constructor(
    private readonly cli: PixInsightCli,
    private readonly options: {
      slot: number | undefined;
      /** Slots this server uses for its own instances. */
      ownSlots: readonly number[];
      /** Slots that hold an instance of any server, which can be on other slots than this server's. */
      leasedSlots?: () => Promise<readonly number[]>;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get generation(): number {
    return this.changes;
  }

  get notice(): string | undefined {
    return this.pendingNotice;
  }

  /** The instance vanished or crashed while a job was running on it. */
  invalidate(): void {
    this.lost = this.pinned !== null;
    this.checkedAt = 0;
  }

  /** The instance jobs currently go to, for status reports. */
  current(): { slot: number; pid: number | null } | null {
    return this.pinned;
  }

  /** Returns a pending announcement once, for the next result the assistant gets. */
  takeNotice(): string | undefined {
    const notice = this.pendingNotice;
    this.pendingNotice = undefined;
    return notice;
  }

  async resolve(): Promise<number> {
    if (this.pinned && !this.lost && this.now() - this.checkedAt < RECHECK_MS) return this.pinned.slot;

    const instances = await this.cli.enumerate();
    this.checkedAt = this.now();
    // Windows cannot list instances, so there is nothing to compare against. What can be known is
    // that a job found no instance there: whatever answers now may be another one.
    if (instances === null) {
      const slot = this.pinned?.slot ?? this.options.slot ?? 1;
      if (this.lost) {
        this.changes++;
        this.pendingNotice =
          `PixInsight on slot ${slot} was not reachable, so it may have been restarted. ` +
          'Images that were open and not saved may be lost, so check list_images before going on.';
        this.lost = false;
      }
      this.pinned ??= { slot, pid: null };
      return slot;
    }

    const next = this.pick(instances, new Set([...this.options.ownSlots, ...((await this.options.leasedSlots?.()) ?? [])]));
    if (!next) {
      if (this.pinned) this.lost = true;
      throw new CliError(this.missingMessage(), 'instance_not_running');
    }
    if (this.pinned && (this.lost || next.slot !== this.pinned.slot || next.pid !== this.pinned.pid)) {
      this.changes++;
      this.pendingNotice =
        `The PixInsight instance on slot ${this.pinned.slot} is gone: it crashed or was closed. ` +
        `Now working with slot ${next.slot}. Images that were open and not saved are lost, so check list_images before going on.`;
    }
    this.pinned = { slot: next.slot, pid: next.pid };
    this.lost = false;
    return next.slot;
  }

  private pick(instances: InstanceInfo[], helpers: ReadonlySet<number>): InstanceInfo | undefined {
    const running = instances.filter((instance) => !instance.crashed);
    if (this.options.slot !== undefined) return running.find((instance) => instance.slot === this.options.slot);
    const candidates = running.filter((instance) => !helpers.has(instance.slot));
    const same = this.pinned && candidates.find((instance) => instance.slot === this.pinned?.slot);
    return same || candidates[0];
  }

  private missingMessage(): string {
    if (this.options.slot !== undefined) {
      return `PixInsight is not running on slot ${this.options.slot}, the slot set by PIXINSIGHT_SLOT.`;
    }
    return this.pinned
      ? `The PixInsight instance on slot ${this.pinned.slot} is gone: it crashed or was closed. Images that were open and not saved are lost. Please start PixInsight again.`
      : 'No running PixInsight instance found. Please start PixInsight first.';
  }
}
