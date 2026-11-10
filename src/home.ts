import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeForIpc, renameWhenFree } from './platform.js';

export interface HomePaths {
  home: string;
  /** Puts the scripts back if another server has removed them, as a server of a newer version does after a week. */
  restoreScripts: () => Promise<void>;
  jobsDir: string;
  leasesDir: string;
  runnerPath: string;
  readyPath: string;
  closeAllPath: string;
  beginLogPath: string;
  endLogPath: string;
  /** Not a script of its own: the server puts its text in front of a script whose dialogs it serves. */
  dialogHookPath: string;
  dialogUnhookPath: string;
  opsDir: string;
  enumChecksPath: string;
}

const STALE_JOB_MS = 24 * 3600 * 1000;
const STALE_SCRIPTS_MS = 7 * STALE_JOB_MS;
const JOB_DIR_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Also what the layout before per-version folders left in the scripts folder. */
const SCRIPTS_DIR_NAME = /^([0-9a-f]{16}(\.[0-9a-f-]+\.tmp)?|ops|(runner|ready|lib|close_all)\.js)$/;
/** Files of calls and starts that a server did not live to remove. */
const LEFTOVER_FILE_NAME = /^(cli-[0-9a-f-]+\.txt|ready-[0-9a-f-]+\.json(\.tmp)?|enum-checks\.json\.\d+\.tmp)$/;

/**
 * Sets up the job home, and gives PixInsight paths that never depend on where this package happens
 * to be installed. Several servers can share a home, and scripts of one may be running while
 * another one starts, so nothing in use gets replaced here.
 */
export async function prepareHome(home: string, source: string = defaultScriptsSource()): Promise<HomePaths> {
  assertSafeForIpc(home);
  const jobsDir = join(home, 'jobs');
  const scriptsRoot = join(home, 'pjsr');
  await mkdir(jobsDir, { recursive: true });
  await mkdir(scriptsRoot, { recursive: true });
  const scripts = await installScripts(source, scriptsRoot);
  // Old versions go by when they were last used, not by when they were installed.
  const now = new Date();
  await utimes(scripts, now, now);
  await removeOlderThan(jobsDir, STALE_JOB_MS, JOB_DIR_NAME);
  await removeOlderThan(home, STALE_JOB_MS, LEFTOVER_FILE_NAME);
  await removeOlderThan(scriptsRoot, STALE_SCRIPTS_MS, SCRIPTS_DIR_NAME, scripts);
  return {
    home,
    restoreScripts: async () => {
      // Also if a file in it was changed: what the runner loads from here runs inside PixInsight,
      // so it has to be what this server came with. The name of the folder says what that is.
      if ((await hashFiles(scripts).catch(() => null)) === basename(scripts)) return;
      await rm(scripts, { recursive: true, force: true });
      await installScripts(source, scriptsRoot);
    },
    jobsDir,
    leasesDir: join(home, 'leases'),
    runnerPath: join(scripts, 'runner.js'),
    readyPath: join(scripts, 'ready.js'),
    closeAllPath: join(scripts, 'close_all.js'),
    beginLogPath: join(scripts, 'begin_log.js'),
    endLogPath: join(scripts, 'end_log.js'),
    dialogHookPath: join(scripts, 'dialogs', 'hook.js'),
    dialogUnhookPath: join(scripts, 'dialogs', 'unhook.js'),
    opsDir: join(scripts, 'ops'),
    enumChecksPath: join(home, 'enum-checks.json'),
  };
}

function defaultScriptsSource(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'pjsr');
}

/** One folder per content, which never changes once it exists. Returns its path. */
async function installScripts(source: string, scriptsRoot: string): Promise<string> {
  const target = join(scriptsRoot, await hashFiles(source));
  if (await pathExists(target)) return target;
  const temp = `${target}.${randomUUID()}.tmp`;
  await cp(source, temp, { recursive: true });
  try {
    await renameWhenFree(temp, target);
  } catch (error) {
    // Another server was faster.
    await rm(temp, { recursive: true, force: true });
    if (!(await pathExists(target))) throw error;
  }
  return target;
}

async function hashFiles(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const names = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  for (const name of names) {
    hash.update(name.slice(dir.length));
    hash.update(await readFile(name));
  }
  return hash.digest('hex').slice(0, 16);
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Only touches names this server creates itself, because a custom home may hold other things. */
async function removeOlderThan(dir: string, ageMs: number, ownName: RegExp, keep?: string): Promise<void> {
  const now = Date.now();
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if (!ownName.test(name) || path === keep) continue;
    const info = await stat(path).catch(() => null);
    if (info && now - info.mtimeMs > ageMs) await rm(path, { recursive: true, force: true });
  }
}
