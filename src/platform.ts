import { execFile } from 'node:child_process';
import { readFile, rename as renameNow } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

const APP_DIR = 'mcp-server-for-pixinsight';

/** Standard install locations, as listed by PixInsight's own WBPP automation help. */
export function defaultExecutable(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'darwin':
      return '/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight';
    case 'win32':
      return 'C:\\Program Files\\PixInsight\\bin\\PixInsight.exe';
    default:
      return '/opt/PixInsight/bin/PixInsight.sh';
  }
}

/** Per-user directory for job files. Deliberately outside the PixInsight installation. */
export function defaultHome(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  // In the way of the platform asked for, which is not always the one this runs on.
  const { join } = platform === 'win32' ? win32 : posix;
  switch (platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', APP_DIR);
    case 'win32':
      return join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), APP_DIR);
    default:
      return join(env['XDG_STATE_HOME'] ?? join(home, '.local', 'state'), APP_DIR);
  }
}

/** What Windows answers while a virus scanner or another reader still has a file open. */
const IN_USE = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Gives a file or folder its final name, in place of what was there. On Windows that fails for a
 * moment while a virus scanner or another program has one of the two open, which is common right
 * after a file was written. So it is tried again, for about two seconds by default, before the
 * error counts.
 */
export async function renameWhenFree(
  from: string,
  to: string,
  attempts = 20,
  rename: (from: string, to: string) => Promise<void> = renameNow,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts || !IN_USE.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
    }
  }
}

/** PJSR uses forward slashes on every platform. */
export function toPixPath(path: string): string {
  return path.replaceAll('\\', '/');
}

/** Splits a list of paths the way PATH is split on the platform. */
export function splitPathList(value: string | undefined, platform: NodeJS.Platform = process.platform): string[] {
  return (value ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
}

/**
 * The first character of a value that cannot go onto the command line of PixInsight, or null.
 *
 * `-x=<slot>:<script>,<arg>` separates arguments with commas, and the launcher that PixInsight
 * comes with elsewhere than on Windows re-evaluates its command line with `eval`, so these
 * characters would change its meaning. It puts an argument with a space into double quotes, which
 * is why a space is fine and a tab is not, and it takes a backslash away unless the argument has
 * a space. No command line holds a control character.
 */
export function unsafeForIpc(value: string, platform: NodeJS.Platform = process.platform): string | null {
  const bad = /[,"'`$;&|<>()*?[\]{}\u0000-\u001f\u007f]/.exec(value)?.[0];
  return bad ?? (platform !== 'win32' && value.includes('\\') ? '\\' : null);
}

export function assertSafeForIpc(value: string, platform: NodeJS.Platform = process.platform): void {
  const bad = unsafeForIpc(value, platform);
  if (bad !== null) {
    throw new Error(
      `Path cannot be passed over PixInsight's command line because it contains ${JSON.stringify(bad)}: ${value}. ` +
        'Set PIXINSIGHT_MCP_HOME to a plain directory.',
    );
  }
}

/** Parses `/proc/<pid>/stat`; the command name may contain spaces, so it splits after the last `)`. */
export function parseProcStatCpuSeconds(stat: string, ticksPerSecond = 100): number | null {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  return Number.isFinite(utime) && Number.isFinite(stime) ? (utime + stime) / ticksPerSecond : null;
}

/** Parses the `[[dd-]hh:]mm:ss[.cc]` form printed by `ps -o cputime=`. */
export function parsePsCpuTime(text: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/** Total CPU seconds a process has used, or null where that cannot be determined. */
export async function cpuSeconds(pid: number, platform: NodeJS.Platform = process.platform): Promise<number | null> {
  try {
    if (platform === 'linux') {
      return parseProcStatCpuSeconds(await readFile(`/proc/${pid}/stat`, 'utf8'));
    }
    if (platform === 'darwin') {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile('ps', ['-o', 'cputime=', '-p', String(pid)], (error, out) => (error ? reject(error) : resolve(out)));
      });
      return parsePsCpuTime(stdout);
    }
  } catch {
    return null;
  }
  return null;
}
