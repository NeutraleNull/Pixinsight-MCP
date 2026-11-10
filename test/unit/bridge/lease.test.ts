import { mkdir, mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SlotLeases } from '../../../src/bridge/lease.js';

/** Several servers are played by several objects with pids of their own. None of them is a real process. */
describe('SlotLeases', () => {
  let dir: string;
  let alive: Set<number>;

  const server = (pid: number) => new SlotLeases(dir, (candidate) => alive.has(candidate), pid);
  const stored = async (slot: number) => JSON.parse(await readFile(join(dir, `slot-${slot}.json`), 'utf8')) as { server: number; instance: number | null };

  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), 'pixinsight-mcp-test-')), 'leases');
    alive = new Set([1, 2, 3]);
  });

  afterEach(async () => {
    await rm(join(dir, '..'), { recursive: true, force: true });
  });

  it('gives a free slot to the first server that asks, and to no other while that one runs', async () => {
    expect(await server(1).claim(200, null)).toEqual({ replaced: null });
    await server(1).setInstance(200, 500);
    expect(await server(2).claim(200, 500)).toBeNull();
    expect(await stored(200)).toMatchObject({ server: 1, instance: 500 });
  });

  it('lets a server claim its own slot again', async () => {
    await server(1).claim(200, null);
    await server(1).setInstance(200, 500);
    expect(await server(1).claim(200, 500)).toMatchObject({ replaced: { server: 1, instance: 500 } });
  });

  it.each([
    ['its server is gone', () => alive.delete(1), 500],
    ['its instance is gone', () => undefined, null],
    ['another instance is on the slot', () => undefined, 777],
  ])('hands a lease on if %s, and says what it replaced', async (_name, change, running) => {
    await server(1).claim(200, null);
    await server(1).setInstance(200, 500);
    change();
    expect(await server(2).claim(200, running)).toMatchObject({ replaced: { server: 1, instance: 500 } });
    expect((await stored(200)).server).toBe(2);
  });

  it('protects a server that is still starting its instance', async () => {
    await server(1).claim(200, null);
    expect(await server(2).claim(200, null)).toBeNull();
  });

  it('believes a running server where instances cannot be listed', async () => {
    await server(1).claim(200, undefined);
    expect(await server(2).claim(200, undefined)).toBeNull();
  });

  it('gives a stale lease to exactly one of several servers that reach for it at once', async () => {
    await server(9).claim(200, null);
    await server(9).setInstance(200, 500);
    const claims = await Promise.all([1, 2, 3].map((pid) => server(pid).claim(200, 500)));
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect((await stored(200)).server).toBe(claims.findIndex((claim) => claim !== null) + 1);
  });

  it('does not let a server release or change the lease of another', async () => {
    await server(1).claim(200, null);
    await server(1).setInstance(200, 500);
    await server(2).release(200);
    await server(2).setInstance(200, 999);
    expect(await stored(200)).toMatchObject({ server: 1, instance: 500 });
    await server(1).release(200);
    await expect(stored(200)).rejects.toThrow();
  });

  it('lists the slots that hold an instance of any server', async () => {
    expect(await server(1).slots()).toEqual([]);
    await server(1).claim(200, null);
    await server(2).claim(251, null);
    expect((await server(3).slots()).sort()).toEqual([200, 251]);
  });

  it('is not blocked for good by a lock that a dead server left', async () => {
    const lock = join(dir, 'slot-200.json.lock');
    await mkdir(lock, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await server(1).claim(200, null)).toEqual({ replaced: null });
  });
});
