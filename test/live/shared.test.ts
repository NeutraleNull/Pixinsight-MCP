import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProcessCli } from '../../src/bridge/cli.js';
import { ManagedInstance } from '../../src/bridge/instance.js';
import type { Config } from '../../src/config.js';
import { prepareHome } from '../../src/home.js';
import { Session } from '../../src/session.js';
import { EXECUTABLE, PREPROCESS_SLOT, removeFilesOfSlots, removeSwapFilesSince, slotsOf, WORKER_SLOT } from './harness.js';

// Stands in for the instance a user runs. The slot is always set explicitly here, because
// otherwise this test would attach to whatever PixInsight the developer has open.
const USER_SLOT = WORKER_SLOT + 2;
const SHADOW_SLOT = WORKER_SLOT + 3;

describe.skipIf(!existsSync(EXECUTABLE))('shared mode', { timeout: 120_000 }, () => {
  const startedAt = Date.now();
  let home: string;
  let userHome: string;
  let session: Session;
  let user: ManagedInstance;

  const config = (overrides: Partial<Config> = {}): Config => ({
    executable: EXECUTABLE,
    mode: 'shared',
    slot: USER_SLOT,
    workerSlot: WORKER_SLOT,
    shadowSlot: SHADOW_SLOT,
    preprocessSlot: PREPROCESS_SLOT,
    headless: true,
    home,
    allowedPrograms: [],
    guideDirs: [], scriptDirs: [], allowCode: false, scriptDialogs: 'operate',
    ...overrides,
  });

  const ping = (from: Session = session) => from.jobs.wait(from.jobs.submit('ping', {}).id, 30_000);

  const userInstance = async () => (await session.instances())?.find((instance) => instance.slot === USER_SLOT && !instance.crashed);

  /** A check of a constant, which brings up a shadow instance if the verdict is not known yet. */
  const bringUpShadow = async (from: Session) => {
    await rm(from.paths.enumChecksPath, { force: true });
    const done = await from.jobs.wait(
      from.runProcess({
        processId: 'PixelMath',
        view: 'mcp_shared',
        params: { expression: '$T', useSingleExpression: true, createNewImage: false, newImageColorSpace: 'RGB' },
      }).id,
      30_000,
    );
    expect(done.state).toBe('succeeded');
  };

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-shared-'));
    // Its own home, because the user's instance has nothing to do with this server's leases.
    userHome = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-user-'));
    const cli = new ProcessCli(EXECUTABLE, { headless: true, cwd: userHome });
    user = new ManagedInstance(cli, [USER_SLOT], await prepareHome(userHome));
    await user.resolve();
  }, 120_000);

  beforeEach(async () => {
    session = await Session.create(config());
    if (!(await userInstance())) {
      user.invalidate();
      await user.resolve();
    }
    // The instance outlives the tests, so the image is only made where it is missing.
    const open = await session.jobs.wait(session.jobs.submit('list_images', {}).id, 30_000);
    if (!(open.value as Array<{ view: string }>).some((image) => image.view === 'mcp_shared')) {
      const created = await session.jobs.wait(
        session.runProcess({
          processId: 'NewImage',
          global: true,
          params: { id: 'mcp_shared', width: 64, height: 32, numberOfChannels: 3, colorSpace: 'RGB' },
        }).id,
        30_000,
      );
      expect(created.state).toBe('succeeded');
    }
    session.target.takeNotice();
  }, 120_000);

  afterAll(async () => {
    await session?.close();
    await user?.stop();
    await rm(home, { recursive: true, force: true });
    await rm(userHome, { recursive: true, force: true });
    await removeFilesOfSlots([USER_SLOT, ...slotsOf(config())], startedAt);
    await removeSwapFilesSince(startedAt);
  });

  it('works with the instance it was pointed at', async () => {
    const done = await ping();
    expect(done.value).toMatchObject({ instance: USER_SLOT });
    expect(session.target.notice).toBeUndefined();
    expect(session.target.current()?.slot).toBe(USER_SLOT);
    await session.close();
  });

  it('marks its own helper instances in the list', async () => {
    await bringUpShadow(session);
    const instances = await session.instances();
    expect(instances?.find((instance) => instance.slot === SHADOW_SLOT)?.role).toBe('shadow');
    expect(instances?.find((instance) => instance.slot === USER_SLOT)?.role).toBeUndefined();
    await session.close();
  });

  it('does not touch the user instance when it closes', async () => {
    const { pid } = (await userInstance())!;
    await bringUpShadow(session);
    await session.close();
    expect((await userInstance())?.pid).toBe(pid);
    expect((await session.instances())?.find((instance) => instance.slot === SHADOW_SLOT && !instance.crashed)).toBeUndefined();
  });

  it('never takes the instance of a user for its shadow, even if it runs unattended on that slot', async () => {
    const { pid } = (await userInstance())!;
    const other = await Session.create(config({ slot: USER_SLOT, shadowSlot: USER_SLOT }));
    await bringUpShadow(other);
    const instances = await other.instances();
    expect(instances?.find((instance) => instance.slot === USER_SLOT + 1 && !instance.crashed)).toBeDefined();
    await other.close();
    expect((await userInstance())?.pid).toBe(pid);
    expect((await session.instances())?.find((instance) => instance.slot === USER_SLOT + 1 && !instance.crashed)).toBeUndefined();
    await session.close();
  });

  it('refuses to go on after its instance is gone, even with the shadow still running, and says so after a restart', async () => {
    // Bring the shadow up, so that a helper instance is the only thing left running.
    await bringUpShadow(session);

    const { pid } = (await userInstance())!;
    // Only ever the instance this test started itself.
    expect(pid).toBe(user.current()?.pid);
    process.kill(pid as number, 'SIGKILL');
    user.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 3500));

    const gone = await ping();
    expect(gone.state).toBe('failed');
    expect(gone.error?.kind).toBe('instance_not_running');
    expect((await session.instances())?.some((instance) => instance.slot === SHADOW_SLOT && !instance.crashed)).toBe(true);

    await user.resolve();
    const back = await ping();
    expect(back.state).toBe('succeeded');
    expect(back.value).toMatchObject({ instance: USER_SLOT });
    expect(session.target.notice).toMatch(/gone.*not saved are lost/);

    // Nothing that changes an image goes through before the assistant has heard about it.
    const refused = await session.jobs.wait(session.jobs.submit('close_image', { view: 'mcp_shared', discardChanges: true }).id, 10_000);
    // The refusal already says what the old instance held, in case the notice is read later.
    expect(refused.error?.message).toMatch(/these images held unsaved work: mcp_shared\./);
    expect(refused.error?.kind).toBe('instance_changed');

    expect(session.takeNotice()).toMatch(/gone.*not saved are lost.*these images held unsaved work: mcp_shared\./);
    expect(session.target.notice).toBeUndefined();
    await session.close();
  });
});
