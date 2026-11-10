import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManagedInstance, type ManagedInstancePaths } from '../../src/bridge/instance.js';
import { FakePixInsight, makePaths, waitUntil } from './fakes.js';

/** A pid no process has, for a server that has gone away. Only ever tested with signal 0. */
const DEAD_SERVER = 2 ** 31 - 2;

describe('ManagedInstance', () => {
  let home: string;
  let paths: ManagedInstancePaths;
  let cli: FakePixInsight;

  const lease = async (slot: number) => JSON.parse(await readFile(join(paths.leasesDir, `slot-${slot}.json`), 'utf8')) as { server: number; instance: number | null };

  const writeLease = async (slot: number, server: number, instance: number | null) => {
    await mkdir(paths.leasesDir, { recursive: true });
    await writeFile(join(paths.leasesDir, `slot-${slot}.json`), JSON.stringify({ server, instance, at: Date.now() }));
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-test-'));
    paths = await makePaths(home);
    cli = new FakePixInsight();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('starts an instance on demand and records that it owns it', async () => {
    const instance = new ManagedInstance(cli, [200], paths);
    expect(await instance.resolve()).toBe(200);
    expect(cli.launched).toEqual([200]);
    expect(await lease(200)).toMatchObject({ server: process.pid, instance: cli.instances[0]?.pid });
    expect(await instance.resolve()).toBe(200);
    expect(cli.launched).toEqual([200]);
  });

  describe('what it refuses to touch', () => {
    it('does not stop anything if it never started anything', async () => {
      cli.addInstance(200);
      await new ManagedInstance(cli, [200], paths).stop();
      expect(cli.terminated).toEqual([]);
      expect(cli.killed).toEqual([]);
      expect(cli.instances).toHaveLength(1);
    });

    it('does not kill anything if it never started anything', async () => {
      cli.addInstance(200);
      expect(await new ManagedInstance(cli, [200], paths).killNow()).toBe(false);
      expect(cli.killed).toEqual([]);
    });

    it('does not take over an instance without a lease, even one that runs unattended', async () => {
      cli.addInstance(200);
      const instance = new ManagedInstance(cli, [200], paths);
      await expect(instance.resolve()).rejects.toThrow(/Slot 200 is occupied/);
      await instance.stop();
      expect(cli.terminated).toEqual([]);
    });

    it('does not take over an instance whose pid differs from the lease', async () => {
      cli.addInstance(200, 111);
      await writeLease(200, DEAD_SERVER, 222);
      await expect(new ManagedInstance(cli, [200], paths).resolve()).rejects.toThrow(/occupied/);
    });

    it('does not take over a leftover that turns out to have a GUI', async () => {
      cli.addInstance(200, 111);
      await writeLease(200, DEAD_SERVER, 111);
      cli.automation = false;
      await expect(new ManagedInstance(cli, [200], paths).resolve()).rejects.toThrow(/occupied/);
      await expect(lease(200)).rejects.toThrow();
    });

    it('reports that it has no instance with a code of its own', async () => {
      cli.addInstance(200);
      await expect(new ManagedInstance(cli, [200], paths).resolve()).rejects.toMatchObject({ code: 'no_instance' });
    });

    it('leaves the slot of another running server alone', async () => {
      cli.addInstance(200, 111);
      await writeLease(200, process.ppid, 111);
      const instance = new ManagedInstance(cli, [200], paths);
      await expect(instance.resolve()).rejects.toThrow(/another running server/);
      await instance.stop();
      expect(cli.instances).toHaveLength(1);
      expect((await lease(200)).server).toBe(process.ppid);
    });

    it('does not stop what came onto the slot after its own instance went away', async () => {
      const instance = new ManagedInstance(cli, [200], paths);
      await instance.resolve();
      cli.remove(200);
      cli.addInstance(200, 999);
      await instance.stop();
      expect(cli.terminated).toEqual([]);
      expect(cli.killed).toEqual([]);
    });

    it('does not kill what came onto the slot after its own instance went away', async () => {
      const instance = new ManagedInstance(cli, [200], paths);
      await instance.resolve();
      cli.remove(200);
      cli.addInstance(200, 999);
      await instance.killNow();
      expect(cli.killed).toEqual([]);
    });
  });

  describe('sharing slots with other servers', () => {
    it('moves on to the next free slot', async () => {
      cli.addInstance(250, 111);
      await writeLease(250, process.ppid, 111);
      const shadow = new ManagedInstance(cli, [250, 251], paths);
      expect(await shadow.resolve()).toBe(251);
      expect(cli.launched).toEqual([251]);
    });

    it('moves on past an instance it knows nothing about', async () => {
      cli.addInstance(250);
      expect(await new ManagedInstance(cli, [250, 251], paths).resolve()).toBe(251);
    });

    it('takes over the leftover of a server that is gone', async () => {
      cli.addInstance(200, 111);
      await writeLease(200, DEAD_SERVER, 111);
      const instance = new ManagedInstance(cli, [200], paths);
      expect(await instance.resolve()).toBe(200);
      expect(cli.launched).toEqual([]);
      await instance.stop();
      expect(cli.terminated).toEqual([200]);
    });

    it('takes over what a server left that died while it was starting the instance', async () => {
      cli.addInstance(200, 111);
      await writeLease(200, DEAD_SERVER, null);
      const instance = new ManagedInstance(cli, [200], paths);
      expect(await instance.resolve()).toBe(200);
      expect(cli.launched).toEqual([]);
      expect(await lease(200)).toMatchObject({ server: process.pid, instance: 111 });
    });

    it('keeps the lease of a leftover that is busy and gives no answer, and takes it over later', async () => {
      cli.addInstance(200, 111);
      await writeLease(200, DEAD_SERVER, 111);
      cli.silent.add(200);
      const instance = new ManagedInstance(cli, [200], paths, { adoptTimeoutMs: 50 });
      await expect(instance.resolve()).rejects.toThrow(/left behind, and it does not answer \(pid 111\)/);
      expect(cli.killed).toEqual([]);
      expect((await lease(200)).instance).toBe(111);

      cli.silent.clear();
      expect(await instance.resolve()).toBe(200);
      expect(cli.launched).toEqual([]);
    });

    it('ends a leftover that never holds images and gives no answer, and moves on', async () => {
      cli.addInstance(250, 111);
      await writeLease(250, DEAD_SERVER, 111);
      cli.silent.add(250);
      const shadow = new ManagedInstance(cli, [250, 251], paths, { holdsImages: false, adoptTimeoutMs: 50 });
      expect(await shadow.resolve()).toBe(251);
      expect(cli.killed).toEqual([111]);
      await expect(lease(250)).rejects.toThrow();
    });

    it('can take a slot whose lease is void because its instance is gone', async () => {
      await writeLease(200, process.ppid, 111);
      expect(await new ManagedInstance(cli, [200], paths).resolve()).toBe(200);
      expect((await lease(200)).server).toBe(process.pid);
    });
  });

  describe('stopping', () => {
    it('stops its own instance gracefully and gives up the slot', async () => {
      const instance = new ManagedInstance(cli, [200], paths);
      await instance.resolve();
      await instance.stop();
      expect(cli.terminated).toEqual([200]);
      expect(cli.killed).toEqual([]);
      await expect(lease(200)).rejects.toThrow();
    });

    it('closes the images first, because an instance with unsaved images refuses to exit', async () => {
      const instance = new ManagedInstance(cli, [200], paths);
      await instance.resolve();
      await instance.stop();
      expect(cli.closedAll).toEqual([200]);
    });

    it('skips that for an instance that never holds images, to be done before the client loses patience', async () => {
      const shadow = new ManagedInstance(cli, [250], paths, { holdsImages: false });
      await shadow.resolve();
      await shadow.stop();
      expect(cli.closedAll).toEqual([]);
      expect(cli.terminated).toEqual([250]);
    });

    it('does not list instances again while it waits for the exit', async () => {
      const instance = new ManagedInstance(cli, [200], paths);
      await instance.resolve();
      let listings = 0;
      const enumerate = cli.enumerate.bind(cli);
      cli.enumerate = async () => {
        listings++;
        return enumerate();
      };
      cli.terminate = async () => {
        setTimeout(() => cli.remove(200), 300);
      };
      await instance.stop();
      expect(listings).toBe(1);
      expect(cli.killed).toEqual([]);
    });

    it('kills its own instance if it does not react', async () => {
      const instance = new ManagedInstance(cli, [200], paths, { stopTimeoutMs: 100 });
      await instance.resolve();
      const pid = cli.instances[0]?.pid as number;
      cli.terminate = async () => {};
      await instance.stop();
      expect(cli.killed).toEqual([pid]);
    });

    describe('during a start', () => {
      it('records the instance as soon as it shows, long before it answers', async () => {
        cli.startup = { listedAfterMs: 0, readyAfterMs: 700 };
        const instance = new ManagedInstance(cli, [200], paths);
        const starting = instance.resolve();
        await waitUntil(async () => (await lease(200).catch(() => null))?.instance != null);
        expect(cli.instances).toHaveLength(1);
        await starting;
      });

      it('does not wait for the start, and ends what has not even answered yet', async () => {
        cli.startup = { listedAfterMs: 0, readyAfterMs: null };
        const instance = new ManagedInstance(cli, [200], paths);
        const starting = instance.resolve();
        starting.catch(() => undefined);
        await waitUntil(async () => (await lease(200).catch(() => null))?.instance != null);
        const pid = cli.instances[0]?.pid as number;

        const before = Date.now();
        await instance.stop();
        // Not the two minutes a start may take.
        expect(Date.now() - before).toBeLessThan(5000);
        expect(cli.killed).toEqual([pid]);
        await expect(starting).rejects.toMatchObject({ code: 'no_instance', message: expect.stringContaining('called off') });
        await expect(lease(200)).rejects.toThrow();
      });

      it('leaves the lease if the instance is not even listed yet, so that the next server knows it', async () => {
        cli.startup = { listedAfterMs: 10_000, readyAfterMs: null };
        const instance = new ManagedInstance(cli, [200], paths);
        const starting = instance.resolve();
        starting.catch(() => undefined);
        await waitUntil(() => cli.launched.length === 1);
        await instance.stop();
        expect(cli.killed).toEqual([]);
        expect(await lease(200)).toMatchObject({ server: process.pid, instance: null });
      });

      it('gives up after its time, with the lease in place', async () => {
        cli.startup = { listedAfterMs: 0, readyAfterMs: null };
        const instance = new ManagedInstance(cli, [200], paths, { readyTimeoutMs: 400 });
        await expect(instance.resolve()).rejects.toThrow(/did not become ready on slot 200/);
        expect((await lease(200)).instance).toBe(cli.instances[0]?.pid);
      });
    });

    it('starts a new instance after a stop', async () => {
      const instance = new ManagedInstance(cli, [200], paths);
      await instance.resolve();
      await instance.stop();
      expect(await instance.resolve()).toBe(200);
      expect(cli.launched).toEqual([200, 200]);
    });
  });

  describe('losing the instance', () => {
    it('announces the loss once and counts it as a change', async () => {
      const instance = new ManagedInstance(cli, [200], paths);
      await instance.resolve();
      expect(instance.generation).toBe(0);
      cli.crash(200);
      instance.invalidate();
      expect(instance.generation).toBe(1);
      expect(instance.notice).toMatch(/was lost/);
      expect(instance.takeNotice()).toMatch(/not saved are gone/);
      expect(instance.takeNotice()).toBeUndefined();
      instance.invalidate();
      expect(instance.generation).toBe(1);
    });

    it('starts over on the slot of a crashed instance', async () => {
      const instance = new ManagedInstance(cli, [200], paths);
      await instance.resolve();
      cli.crash(200);
      instance.invalidate();
      cli.remove(200);
      expect(await instance.resolve()).toBe(200);
      expect(cli.launched).toEqual([200, 200]);
    });
  });

  describe('an instance that went away while nobody looked', () => {
    it('is noticed at the next job, announced, and replaced', async () => {
      const instance = new ManagedInstance(cli, [200], paths, { recheckMs: 0 });
      await instance.resolve();
      cli.remove(200);
      expect(await instance.resolve()).toBe(200);
      expect(cli.launched).toEqual([200, 200]);
      expect(instance.generation).toBe(1);
      expect(instance.takeNotice()).toMatch(/was lost/);
    });

    it('is not mistaken for the instance another server has put on the slot since', async () => {
      const instance = new ManagedInstance(cli, [200, 201], paths, { recheckMs: 0 });
      await instance.resolve();
      cli.remove(200);
      cli.addInstance(200, 999);
      await writeLease(200, process.ppid, 999);
      expect(await instance.resolve()).toBe(201);
      expect(cli.terminated).toEqual([]);
    });

    it('is not looked for at every job', async () => {
      const instance = new ManagedInstance(cli, [200], paths);
      await instance.resolve();
      let listings = 0;
      const enumerate = cli.enumerate.bind(cli);
      cli.enumerate = async () => {
        listings++;
        return enumerate();
      };
      await instance.resolve();
      await instance.resolve();
      expect(listings).toBe(0);
    });
  });

  it('can be left running with its lease, for a server that comes later', async () => {
    const instance = new ManagedInstance(cli, [200], paths);
    await instance.resolve();
    const pid = cli.instances[0]?.pid;
    instance.leaveRunning();
    await instance.stop();
    expect(cli.terminated).toEqual([]);
    expect(cli.closedAll).toEqual([]);
    expect(await lease(200)).toMatchObject({ server: process.pid, instance: pid });
  });

  it('works where instances cannot be listed, as on Windows', async () => {
    cli.listable = false;
    const instance = new ManagedInstance(cli, [200], paths);
    expect(await instance.resolve()).toBe(200);
    expect(await instance.killNow()).toBe(false);
    expect(cli.killed).toEqual([]);
  });

  it('stops its instance on platforms that cannot list instances', async () => {
    cli.listable = false;
    const instance = new ManagedInstance(cli, [200], paths);
    await instance.resolve();
    await instance.stop();
    expect(cli.terminated).toEqual([200]);
  });
});
