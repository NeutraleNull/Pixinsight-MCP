import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renameWhenFree } from '../platform.js';

export interface Lease {
  /** The server process that owns the instance on this slot. */
  server: number;
  /** The instance, once it runs. Null while it starts, and where instances cannot be listed. */
  instance: number | null;
  at: number;
}

const STARTING_MS = 120_000;
/** Nothing done under the lock takes long, so an older one was left by a server that died. */
const LOCK_STALE_MS = 10_000;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Records which server owns the instance on a slot, in one file per slot. A slot alone says
 * nothing about who an instance belongs to: it can be the user's, or another server's, and
 * several servers run at once as soon as a client opens a second session.
 */
export class SlotLeases {
  constructor(
    private readonly dir: string,
    private readonly isAlive: (pid: number) => boolean = processExists,
    private readonly self: number = process.pid,
  ) {}

  /**
   * Takes the slot unless another running server holds it, and returns the lease it replaced,
   * which tells whether an instance found on the slot is a leftover of an earlier run.
   *
   * @param running The instance now on the slot: its pid, null for none, undefined if unknown.
   */
  claim(slot: number, running: number | null | undefined): Promise<{ replaced: Lease | null } | null> {
    return this.locked(slot, async () => {
      const held = await this.read(slot);
      if (held && held.server !== this.self && this.holds(held, running)) return null;
      await this.write(slot, null);
      return { replaced: held };
    });
  }

  async setInstance(slot: number, instance: number | null): Promise<void> {
    await this.locked(slot, async () => {
      if ((await this.read(slot))?.server === this.self) await this.write(slot, instance);
    });
  }

  /** Gives the slot up. Does nothing if another server has taken it since. */
  async release(slot: number): Promise<void> {
    await this.locked(slot, async () => {
      if ((await this.read(slot))?.server === this.self) await rm(this.path(slot), { force: true });
    });
  }

  /** The slots with an instance of some server, running or left behind by one that is gone. */
  async slots(): Promise<number[]> {
    const names = await readdir(this.dir).catch(() => []);
    return names.flatMap((name) => {
      const match = /^slot-(\d+)\.json$/.exec(name);
      return match ? [Number(match[1])] : [];
    });
  }

  private holds(lease: Lease, running: number | null | undefined): boolean {
    if (!this.isAlive(lease.server)) return false;
    if (running === undefined) return true;
    if (lease.instance === null) return Date.now() - lease.at < STARTING_MS;
    return lease.instance === running;
  }

  /** Two servers that find the same stale lease must not both take it, so one at a time. */
  private async locked<T>(slot: number, action: () => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true });
    const lock = `${this.path(slot)}.lock`;
    for (;;) {
      try {
        await mkdir(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        // Renamed first, so that only one of several waiting servers gets to remove it.
        const aside = `${lock}.${randomUUID()}`;
        await rename(lock, aside).then(
          () => rmdir(aside),
          () => undefined,
        );
      } else {
        await sleep(20);
      }
    }
    try {
      return await action();
    } finally {
      await rmdir(lock).catch(() => undefined);
    }
  }

  private async write(slot: number, instance: number | null): Promise<void> {
    const temporary = `${this.path(slot)}.${this.self}.tmp`;
    await writeFile(temporary, JSON.stringify({ server: this.self, instance, at: Date.now() } satisfies Lease));
    await renameWhenFree(temporary, this.path(slot));
  }

  private path(slot: number): string {
    return join(this.dir, `slot-${slot}.json`);
  }

  private async read(slot: number): Promise<Lease | null> {
    return readFile(this.path(slot), 'utf8')
      .then((text) => JSON.parse(text) as Lease)
      .catch(() => null);
  }
}
