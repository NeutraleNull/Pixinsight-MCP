import { describe, expect, it } from 'vitest';
import { CliError, type InstanceInfo, type PixInsightCli } from '../../src/bridge/cli.js';
import { SharedTarget } from '../../src/bridge/target.js';

const SHADOW = 250;
const WORKER = 200;

function fakeCli(initial: InstanceInfo[] | null): PixInsightCli & { instances: InstanceInfo[] | null; lists: number } {
  return {
    instances: initial,
    lists: 0,
    async enumerate() {
      this.lists++;
      return this.instances;
    },
    async execute() {},
    launch() {},
    async terminate() {},
    kill() {},
    isRunning: () => true,
  };
}

const running = (slot: number, pid = 1000 + slot): InstanceInfo => ({ slot, pid, crashed: false });
const crashed = (slot: number): InstanceInfo => ({ slot, pid: null, crashed: true });

function target(cli: PixInsightCli, slot?: number): SharedTarget & { clock: { t: number } } {
  const clock = { t: 1000 };
  const shared = new SharedTarget(cli, { slot, ownSlots: [SHADOW, WORKER], now: () => clock.t }) as SharedTarget & { clock: { t: number } };
  shared.clock = clock;
  return shared;
}

describe('SharedTarget', () => {
  it('takes the first running instance', async () => {
    const shared = target(fakeCli([running(1), running(5)]));
    expect(await shared.resolve()).toBe(1);
    expect(shared.takeNotice()).toBeUndefined();
  });

  it('never targets the helper instances of this server', async () => {
    const shared = target(fakeCli([running(SHADOW), running(WORKER), running(7)]));
    expect(await shared.resolve()).toBe(7);
  });

  it('refuses when only helper instances run, instead of working in them', async () => {
    const shared = target(fakeCli([running(SHADOW)]));
    await expect(shared.resolve()).rejects.toThrow(/No running PixInsight/);
    await expect(shared.resolve()).rejects.toBeInstanceOf(CliError);
  });

  it('says what happened when its instance crashed and only the shadow is left', async () => {
    const cli = fakeCli([running(1), running(SHADOW)]);
    const shared = target(cli);
    await shared.resolve();
    cli.instances = [crashed(1), running(SHADOW)];
    shared.invalidate();
    await expect(shared.resolve()).rejects.toThrow(/slot 1 is gone.*not saved are lost/);
  });

  it('stays with its instance when another one appears on a lower slot', async () => {
    const cli = fakeCli([running(3)]);
    const shared = target(cli);
    await shared.resolve();
    cli.instances = [running(1), running(3)];
    shared.clock.t += 60_000;
    expect(await shared.resolve()).toBe(3);
    expect(shared.takeNotice()).toBeUndefined();
  });

  it('announces a restart on the same slot, once', async () => {
    const cli = fakeCli([running(1, 111)]);
    const shared = target(cli);
    await shared.resolve();
    cli.instances = [running(1, 222)];
    shared.clock.t += 60_000;
    expect(await shared.resolve()).toBe(1);
    expect(shared.takeNotice()).toMatch(/slot 1 is gone.*not saved are lost/);
    expect(shared.takeNotice()).toBeUndefined();
  });

  it('counts each change of instance, and keeps the notice readable until it is taken', async () => {
    const cli = fakeCli([running(1, 111)]);
    const shared = target(cli);
    await shared.resolve();
    expect(shared.generation).toBe(0);
    cli.instances = [running(1, 222)];
    shared.clock.t += 60_000;
    await shared.resolve();
    expect(shared.generation).toBe(1);
    expect(shared.notice).toMatch(/gone/);
    expect(shared.notice).toMatch(/gone/);
    shared.takeNotice();
    expect(shared.notice).toBeUndefined();
    await shared.resolve();
    expect(shared.generation).toBe(1);
  });

  it('announces a move to another instance after a crash', async () => {
    const cli = fakeCli([running(1)]);
    const shared = target(cli);
    await shared.resolve();
    cli.instances = [crashed(1), running(4)];
    shared.invalidate();
    expect(await shared.resolve()).toBe(4);
    expect(shared.takeNotice()).toMatch(/Now working with slot 4/);
  });

  it('still announces the loss if the new instance only comes later', async () => {
    const cli = fakeCli([running(1)]);
    const shared = target(cli);
    await shared.resolve();
    cli.instances = [];
    shared.invalidate();
    await expect(shared.resolve()).rejects.toThrow(/gone/);
    cli.instances = [running(1, 999)];
    expect(await shared.resolve()).toBe(1);
    expect(shared.takeNotice()).toMatch(/gone/);
  });

  it('never leaves a configured slot', async () => {
    const shared = target(fakeCli([running(1), running(9)]), 9);
    expect(await shared.resolve()).toBe(9);
    const missing = target(fakeCli([running(1)]), 9);
    await expect(missing.resolve()).rejects.toThrow(/slot 9.*PIXINSIGHT_SLOT/);
  });

  it('does not list instances for every job, because each listing starts a process', async () => {
    const cli = fakeCli([running(1)]);
    const shared = target(cli);
    await shared.resolve();
    await shared.resolve();
    await shared.resolve();
    expect(cli.lists).toBe(1);
    shared.clock.t += 60_000;
    await shared.resolve();
    expect(cli.lists).toBe(2);
  });

  it('never targets the helper of another server either, whatever slot that one chose', async () => {
    const cli = fakeCli([running(210), running(7)]);
    const shared = new SharedTarget(cli, { slot: undefined, ownSlots: [SHADOW, WORKER], leasedSlots: async () => [210] });
    expect(await shared.resolve()).toBe(7);
    cli.instances = [running(210)];
    const alone = new SharedTarget(cli, { slot: undefined, ownSlots: [SHADOW, WORKER], leasedSlots: async () => [210] });
    await expect(alone.resolve()).rejects.toThrow(/No running PixInsight/);
  });

  it('announces a possible restart where instances cannot be listed, once a job has found none', async () => {
    const shared = target(fakeCli(null));
    expect(await shared.resolve()).toBe(1);
    expect(shared.generation).toBe(0);
    shared.invalidate();
    expect(await shared.resolve()).toBe(1);
    expect(shared.generation).toBe(1);
    expect(shared.takeNotice()).toMatch(/may have been restarted/);
    expect(await shared.resolve()).toBe(1);
    expect(shared.generation).toBe(1);
  });

  it('works without listing on Windows', async () => {
    expect(await target(fakeCli(null)).resolve()).toBe(1);
    expect(await target(fakeCli(null), 3).resolve()).toBe(3);
  });

  it('reports its current instance', async () => {
    const shared = target(fakeCli([running(2, 77)]));
    expect(shared.current()).toBeNull();
    await shared.resolve();
    expect(shared.current()).toEqual({ slot: 2, pid: 77 });
  });
});
