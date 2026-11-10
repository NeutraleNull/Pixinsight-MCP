import { describe, expect, it } from 'vitest';
import { parseEnumerate } from '../../src/bridge/cli.js';
import { loadConfig, shadowSlots } from '../../src/config.js';
import {
  assertSafeForIpc,
  defaultExecutable,
  defaultHome,
  parseProcStatCpuSeconds,
  parsePsCpuTime,
  renameWhenFree,
  toPixPath,
} from '../../src/platform.js';

describe('platform defaults', () => {
  it('knows the standard install location per platform', () => {
    expect(defaultExecutable('linux')).toBe('/opt/PixInsight/bin/PixInsight.sh');
    expect(defaultExecutable('darwin')).toBe('/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight');
    expect(defaultExecutable('win32')).toBe('C:\\Program Files\\PixInsight\\bin\\PixInsight.exe');
  });

  it('keeps job files outside the installation, in the per-user location', () => {
    expect(defaultHome('linux', {}, '/home/a')).toBe('/home/a/.local/state/mcp-server-for-pixinsight');
    expect(defaultHome('linux', { XDG_STATE_HOME: '/x' }, '/home/a')).toBe('/x/mcp-server-for-pixinsight');
    expect(defaultHome('darwin', {}, '/Users/a')).toBe('/Users/a/Library/Application Support/mcp-server-for-pixinsight');
    expect(defaultHome('win32', {}, 'C:\\Users\\a')).toBe('C:\\Users\\a\\AppData\\Local\\mcp-server-for-pixinsight');
    expect(defaultHome('win32', { LOCALAPPDATA: 'D:\\Data' }, 'C:\\Users\\a')).toBe('D:\\Data\\mcp-server-for-pixinsight');
  });

  it('converts Windows paths for PJSR', () => {
    expect(toPixPath('C:\\Users\\a\\job')).toBe('C:/Users/a/job');
  });
});

describe('assertSafeForIpc', () => {
  it('accepts plain paths, including spaces', () => {
    expect(() => assertSafeForIpc('/home/a b/jobs/1')).not.toThrow();
  });

  it.each([',', '$', '`', '"', "'", ';', '&', '|', '(', ')', '*', '?', '[', ']', '{', '}', '\t', '\n'])('rejects %j, which would change the command line', (character) => {
    expect(() => assertSafeForIpc(`/home/a${character}b`)).toThrow(/PIXINSIGHT_MCP_HOME/);
  });
});

describe('renameWhenFree', () => {
  const failing = (code: string, times: number) => {
    const calls: Array<[string, string]> = [];
    const rename = async (from: string, to: string) => {
      calls.push([from, to]);
      if (calls.length <= times) throw Object.assign(new Error(`${code}: operation not permitted`), { code });
    };
    return { calls, rename };
  };

  it.each(['EPERM', 'EACCES', 'EBUSY'])('tries again after %s, which Windows answers while a scanner or a reader has the file open', async (code) => {
    const { calls, rename } = failing(code, 2);
    await renameWhenFree('a.tmp', 'a', 20, rename);
    expect(calls).toEqual([['a.tmp', 'a'], ['a.tmp', 'a'], ['a.tmp', 'a']]);
  });

  it('gives up at once on an error that waiting does not cure', async () => {
    const { calls, rename } = failing('ENOENT', 5);
    await expect(renameWhenFree('a.tmp', 'a', 20, rename)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toHaveLength(1);
  });

  it('gives up after the tries it was given, with the error it got', async () => {
    const { calls, rename } = failing('EPERM', 99);
    await expect(renameWhenFree('a.tmp', 'a', 3, rename)).rejects.toMatchObject({ code: 'EPERM' });
    expect(calls).toHaveLength(3);
  });
});

describe('cpu time parsing', () => {
  it('reads /proc stat even if the command name contains spaces', () => {
    const fields = Array.from({ length: 30 }, (_, index) => String(index + 3));
    fields[11] = '250';
    fields[12] = '50';
    expect(parseProcStatCpuSeconds(`123 (Pix Insight) ${fields.join(' ')}`)).toBe(3);
  });

  it('reads the forms printed by ps', () => {
    expect(parsePsCpuTime('01:30')).toBe(90);
    expect(parsePsCpuTime('  1:02:03.50 ')).toBe(3723.5);
    expect(parsePsCpuTime('2-00:00:01')).toBe(172801);
    expect(parsePsCpuTime('nonsense')).toBeNull();
  });
});

describe('parseEnumerate', () => {
  it('reads running and crashed instances from the table', () => {
    const stdout = '\nPixInsight Core 1.9.6 Lockhart (x64)\nCopyright\n\nslot      pid\n---- --------\n 200  1349330\n 201 crashed\n\n';
    expect(parseEnumerate(stdout)).toEqual([
      { slot: 200, pid: 1349330, crashed: false },
      { slot: 201, pid: null, crashed: true },
    ]);
  });

  it('returns nothing for an empty table', () => {
    expect(parseEnumerate('slot      pid\n---- --------\n\n')).toEqual([]);
  });
});

describe('loadConfig', () => {
  it('defaults to sharing the user instance', () => {
    const config = loadConfig({}, 'linux');
    expect(config.mode).toBe('shared');
    expect(config.slot).toBeUndefined();
    expect(config.headless).toBe(true);
  });

  it('does not assume the offscreen plugin exists on other platforms', () => {
    expect(loadConfig({}, 'win32').headless).toBe(false);
  });

  it('takes the windowless setting as 1 or 0, and nothing that only looks like it', () => {
    expect(loadConfig({ PIXINSIGHT_MCP_HEADLESS: '0' }, 'linux').headless).toBe(false);
    expect(loadConfig({ PIXINSIGHT_MCP_HEADLESS: 'true' }, 'win32').headless).toBe(true);
    expect(() => loadConfig({ PIXINSIGHT_MCP_HEADLESS: 'yes' }, 'linux')).toThrow(/PIXINSIGHT_MCP_HEADLESS/);
  });

  it('reads folders with guides of the user', () => {
    expect(loadConfig({}, 'linux').guideDirs).toEqual([]);
    expect(loadConfig({ PIXINSIGHT_MCP_GUIDE_DIRS: '/a/b:/c/' }, 'linux').guideDirs).toEqual(['/a/b', '/c/']);
  });

  it('reads folders with scripts of the user', () => {
    expect(loadConfig({}, 'linux').scriptDirs).toEqual([]);
    expect(loadConfig({ PIXINSIGHT_MCP_SCRIPT_DIRS: 'C:\\Astro\\scripts;D:\\more' }, 'win32').scriptDirs).toEqual(['C:\\Astro\\scripts', 'D:\\more']);
  });

  it('takes only absolute folders for scripts, because PixInsight would resolve another one differently', () => {
    expect(() => loadConfig({ PIXINSIGHT_MCP_SCRIPT_DIRS: '/abs/scripts:relative/scripts' }, 'linux')).toThrow(/absolute paths, got relative\/scripts/);
    expect(() => loadConfig({ PIXINSIGHT_MCP_SCRIPT_DIRS: '.' }, 'linux')).toThrow(/absolute/);
  });

  it('lets the assistant run code of its own only on a plain yes', () => {
    expect(loadConfig({}, 'linux').allowCode).toBe(false);
    expect(loadConfig({ PIXINSIGHT_MCP_ALLOW_CODE: '0' }, 'linux').allowCode).toBe(false);
    expect(loadConfig({ PIXINSIGHT_MCP_ALLOW_CODE: '1' }, 'linux').allowCode).toBe(true);
    expect(() => loadConfig({ PIXINSIGHT_MCP_ALLOW_CODE: 'maybe' }, 'linux')).toThrow(/PIXINSIGHT_MCP_ALLOW_CODE/);
  });

  it('rejects bad values', () => {
    expect(() => loadConfig({ PIXINSIGHT_MCP_MODE: 'nope' }, 'linux')).toThrow(/PIXINSIGHT_MCP_MODE/);
    expect(() => loadConfig({ PIXINSIGHT_SLOT: '999' }, 'linux')).toThrow(/PIXINSIGHT_SLOT/);
  });

  it('keeps the slots of work away from those of shadow instances, which get killed', () => {
    expect(() => loadConfig({ PIXINSIGHT_SLOT: '250' }, 'linux')).toThrow(/reserved for shadow/);
    expect(() => loadConfig({ PIXINSIGHT_SLOT: '253' }, 'linux')).toThrow(/reserved for shadow/);
    expect(() => loadConfig({ PIXINSIGHT_MCP_MODE: 'worker', PIXINSIGHT_MCP_WORKER_SLOT: '250' }, 'linux')).toThrow(/reserved for shadow/);
    expect(() => loadConfig({ PIXINSIGHT_SLOT: '5', PIXINSIGHT_MCP_SHADOW_SLOT: '3' }, 'linux')).toThrow(/slots 3 to 9/);
    expect(loadConfig({ PIXINSIGHT_SLOT: '249' }, 'linux').slot).toBe(249);
    expect(loadConfig({ PIXINSIGHT_SLOT: '250', PIXINSIGHT_MCP_SHADOW_SLOT: '240' }, 'linux').slot).toBe(250);
  });

  it('reserves slots for shadow instances only up to the last slot', () => {
    expect(shadowSlots({ shadowSlot: 250 })).toEqual([250, 251, 252, 253, 254, 255, 256]);
    expect(shadowSlots({ shadowSlot: 255 })).toEqual([255, 256]);
  });

  it('reads the list of allowed programs with the separator of the platform', () => {
    expect(loadConfig({}, 'linux').allowedPrograms).toEqual([]);
    expect(loadConfig({ PIXINSIGHT_MCP_ALLOWED_PROGRAMS: '/a/b:/c/d' }, 'linux').allowedPrograms).toEqual(['/a/b', '/c/d']);
    expect(loadConfig({ PIXINSIGHT_MCP_ALLOWED_PROGRAMS: 'C:\\a\\b.exe;D:\\c.exe' }, 'win32').allowedPrograms).toEqual(['C:\\a\\b.exe', 'D:\\c.exe']);
  });
});
