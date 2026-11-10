import { cp, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { preprocessSlots, shadowSlots, type Config } from '../../src/config.js';
import { defaultExecutable } from '../../src/platform.js';
import { Session } from '../../src/session.js';

// Not the slots a server uses by default, so that a run of these tests cannot meet a server at work.
export const WORKER_SLOT = Number(process.env['PIXINSIGHT_TEST_SLOT'] ?? 230);
export const SHADOW_SLOT = WORKER_SLOT + 1;
/** Behind every slot that the tests put a shadow instance on. */
export const PREPROCESS_SLOT = WORKER_SLOT + 14;
export const EXECUTABLE = process.env['PIXINSIGHT_EXECUTABLE'] ?? defaultExecutable();

/** PixInsight leaves one small settings file per slot. These tests clean up after themselves. */
export function settingsFile(slot: number): string {
  return join(homedir(), '.PixInsight', `core-${String(slot).padStart(3, '0')}-pxi.settings`);
}

/** Settings and caches PixInsight wrote for these slots during the tests, such as that of ImageIntegration. */
export async function removeFilesOfSlots(slots: readonly number[], startedAt: number): Promise<void> {
  const dir = join(homedir(), '.PixInsight');
  for (const name of await readdir(dir)) {
    const match = /-(\d{3})-pxi\.\w+$/.exec(name);
    if (!match || !slots.includes(Number(match[1]))) continue;
    const info = await stat(join(dir, name)).catch(() => null);
    if (info && info.birthtimeMs >= startedAt - 1000) await rm(join(dir, name), { force: true });
  }
}

/** The slots a session in these tests can put an instance on. */
export function slotsOf(config: Config): number[] {
  return [config.workerSlot, ...shadowSlots(config), ...preprocessSlots(config)];
}

/**
 * For instances a test has killed, which cannot remove their swap files any more. The names do not
 * say which instance they belong to, so this goes by their age, and leaves alone what others wrote.
 */
export async function removeSwapFilesSince(startedAt: number): Promise<void> {
  for (const name of await readdir(tmpdir())) {
    if (!/^~PI~.*~mcp_/.test(name)) continue;
    const path = join(tmpdir(), name);
    const info = await stat(path).catch(() => null);
    if (info && info.mtimeMs >= startedAt) await rm(path, { force: true });
  }
}

export interface LiveSession {
  session: Session;
  config: Config;
  cleanup: () => Promise<void>;
}

/**
 * @param testOps Operations of a test's own, by name. They have to be part of the scripts the
 *   server installs: it puts its scripts folder back before each job if anything in it differs.
 */
export async function startLiveSession(overrides: Partial<Config> = {}, testOps: Record<string, string> = {}): Promise<LiveSession> {
  const startedAt = Date.now();
  const home = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-live-'));
  const source = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-live-source-'));
  await cp(resolve('pjsr'), source, { recursive: true });
  for (const [name, body] of Object.entries(testOps)) await writeFile(join(source, 'ops', `${name}.js`), body);
  const config: Config = {
    executable: EXECUTABLE,
    mode: 'worker',
    slot: undefined,
    workerSlot: WORKER_SLOT,
    shadowSlot: SHADOW_SLOT,
    preprocessSlot: PREPROCESS_SLOT,
    headless: true,
    home,
    allowedPrograms: [],
    guideDirs: [],
    scriptDirs: [],
    allowCode: false,
    scriptDialogs: 'operate',
    ...overrides,
  };
  const session = await Session.create(config, undefined, source);
  return {
    session,
    config,
    cleanup: async () => {
      // A worker with unsaved images is left running on purpose, so they go first.
      const open = await session.jobs.wait(session.jobs.submit('list_images', {}).id, 20_000);
      const views = Array.isArray(open.value) ? (open.value as Array<{ view: string }>).map((image) => image.view) : [];
      if (views.length) await session.jobs.wait(session.jobs.submit('close_image', { view: views, discardChanges: views }).id, 20_000);
      await session.close();
      await rm(home, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
      await removeFilesOfSlots(slotsOf(config), startedAt);
      await removeSwapFilesSince(startedAt);
    },
  };
}

/** The real pixel size stored in a JPEG, so that tests do not have to trust what a tool reports. */
export function jpegSize(bytes: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset < bytes.length) {
    const marker = bytes[offset + 1] as number;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  throw new Error('No frame header found in JPEG');
}

/** Runs one operation and insists that it finishes. */
export async function run<T>(session: Session, op: string, args: unknown = {}, timeoutMs = 30_000): Promise<T> {
  const job = session.jobs.submit(op, args);
  const done = await session.jobs.wait(job.id, timeoutMs);
  if (done.state !== 'succeeded') throw new Error(`${op} ended as ${done.state}: ${JSON.stringify(done.error)}`);
  return done.value as T;
}
