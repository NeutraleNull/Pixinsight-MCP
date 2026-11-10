import { chmod, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError, ProcessCli, type CliOptions } from '../../../src/bridge/cli.js';
import { waitUntil } from '../fakes.js';

/** A stand-in for the PixInsight launcher, which is what the server calls on Linux. */
describe.skipIf(process.platform === 'win32')('ProcessCli', () => {
  let dir: string;

  const cli = async (script: string, options: Partial<CliOptions> = {}) => {
    const executable = join(dir, 'fake.sh');
    await writeFile(executable, `#!/bin/sh\n${script}\n`);
    await chmod(executable, 0o755);
    return new ProcessCli(executable, { headless: true, cwd: dir, platform: 'linux', lockPath: join(dir, 'cli.lock'), ...options });
  };
  const lines = async (name: string): Promise<string[]> => (await readFile(join(dir, name), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** A client that says when it begins and ends, and takes a moment in between. */
  const slow = (): string => `echo "begin $1" >> '${dir}/calls.txt'; sleep 0.2; echo "end $1" >> '${dir}/calls.txt'; printf ' 1 1\\n'`;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the list of instances from what the client prints', async () => {
    const pixinsight = await cli(`printf 'slot      pid\\n---- --------\\n   1  4242\\n 200 crashed\\n'`);
    expect(await pixinsight.enumerate()).toEqual([
      { slot: 1, pid: 4242, crashed: false },
      { slot: 200, pid: null, crashed: true },
    ]);
  });

  it('gives the client a file for its output, because it crashes when a pipe goes away', async () => {
    const pixinsight = await cli(`if [ -p /dev/stdout ]; then printf ' 1 1\\n'; else printf ' 2 2\\n'; fi`);
    expect(await pixinsight.enumerate()).toEqual([{ slot: 2, pid: 2, crashed: false }]);
  });

  it('leaves no output files behind', async () => {
    const pixinsight = await cli(`printf ' 1 1\\n'`);
    await pixinsight.enumerate();
    await pixinsight.terminate(1);
    expect((await readdir(dir)).filter((name) => name.startsWith('cli-'))).toEqual([]);
  });

  it('passes the script and its arguments the way PixInsight expects them', async () => {
    const argv = join(dir, 'argv.txt');
    const pixinsight = await cli(`printf '%s' "$1" > '${argv}'`);
    await pixinsight.execute(7, '/a b/runner.js', ['/jobs/1']);
    expect(await readFile(argv, 'utf8')).toBe('-x=7:/a b/runner.js,/jobs/1');
  });

  it('refuses a path that would change the command line', async () => {
    const pixinsight = await cli('exit 0');
    await expect(pixinsight.execute(7, '/a,b/runner.js', [])).rejects.toThrow(/PIXINSIGHT_MCP_HOME/);
  });

  it('recognizes an instance that is not there, also on stderr', async () => {
    const pixinsight = await cli(`echo '*** Fatal Error: instance 7 is not running' >&2; exit 255`);
    const error = await pixinsight.execute(7, '/runner.js', []).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: 'instance_not_running' });
  });

  it('reports any other failure as such', async () => {
    const pixinsight = await cli('exit 3');
    await expect(pixinsight.terminate(1)).rejects.toMatchObject({ code: 'cli_failed', message: expect.stringContaining('exit code 3') });
  });

  it('reports a missing executable', async () => {
    const pixinsight = new ProcessCli(join(dir, 'nowhere'), { headless: true, cwd: dir, platform: 'linux', lockPath: null });
    await expect(pixinsight.terminate(1)).rejects.toMatchObject({ code: 'cli_failed' });
    expect((await readdir(dir)).filter((name) => name.startsWith('cli-'))).toEqual([]);
  });

  it('calls one client at a time, because two at once can leave a lock of PixInsight behind for good', async () => {
    const pixinsight = await cli(slow());
    await Promise.all([pixinsight.execute(7, '/a.js', []), pixinsight.terminate(7), pixinsight.enumerate(), pixinsight.execute(7, '/b.js', [])]);
    const calls = await lines('calls.txt');
    expect(calls).toHaveLength(8);
    // Never two that have begun and not ended.
    calls.forEach((call, index) => expect(call.startsWith(index % 2 ? 'end' : 'begin')).toBe(true));
  });

  it('gives everyone who asks before a listing has begun that one listing, and a new one to who asks later', async () => {
    const pixinsight = await cli(slow());
    const first = pixinsight.execute(7, '/a.js', []);
    const asked = [pixinsight.enumerate(), pixinsight.enumerate(), pixinsight.enumerate()];
    await first;
    expect(await Promise.all(asked)).toEqual(Array.from({ length: 3 }, () => [{ slot: 1, pid: 1, crashed: false }]));
    expect((await lines('calls.txt')).filter((call) => call === 'begin -e')).toHaveLength(1);
    await pixinsight.enumerate();
    expect((await lines('calls.txt')).filter((call) => call === 'begin -e')).toHaveLength(2);
  });

  it('takes its turn among the servers of a machine, by a lock they share', async () => {
    const one = await cli(slow());
    const other = new ProcessCli(join(dir, 'fake.sh'), { headless: true, cwd: dir, platform: 'linux', lockPath: join(dir, 'cli.lock') });
    await Promise.all([one.enumerate(), other.enumerate(), one.terminate(1), other.terminate(1)]);
    const calls = await lines('calls.txt');
    expect(calls).toHaveLength(8);
    calls.forEach((call, index) => expect(call.startsWith(index % 2 ? 'end' : 'begin')).toBe(true));
    expect(await readdir(dir)).not.toContain('cli.lock');
  });

  it('waits while another server holds the lock, and takes over one that a server left behind', async () => {
    const pixinsight = await cli(slow());
    const lock = join(dir, 'cli.lock');
    await writeFile(lock, '1');
    const call = pixinsight.enumerate();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await lines('calls.txt')).toEqual([]);
    // Older than any call can last: whoever wrote it is gone.
    const long = new Date(Date.now() - 3_600_000);
    await utimes(lock, long, long);
    expect(await call).toEqual([{ slot: 1, pid: 1, crashed: false }]);
    expect(await readdir(dir)).not.toContain('cli.lock');
  });

  it('ends a client that does not come back, with what the launcher started, and says what that means', async () => {
    const pixinsight = await cli(`sleep 600 &\necho $! > '${dir}/child.pid'\nwait`, { timeoutMs: 400 });
    const error = await pixinsight.enumerate().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: 'cli_timeout', message: expect.stringMatching(/did not answer within 0 s when it was called with -e.*lock of PixInsight.*troubleshooting/s) });
    const child = Number((await lines('child.pid'))[0]);
    expect(child).toBeGreaterThan(0);
    // Not only the launcher: the client it started would otherwise stay for good.
    await waitUntil(async () => !alive(child));
    expect((await readdir(dir)).filter((name) => name.startsWith('cli-') || name === 'cli.lock')).toEqual([]);
  });

  it('does not ask for a listing again right after one that did not come back', async () => {
    const pixinsight = await cli(`echo called >> '${dir}/calls.txt'\nsleep 600`, { timeoutMs: 300 });
    await expect(pixinsight.enumerate()).rejects.toMatchObject({ code: 'cli_timeout' });
    const before = Date.now();
    await expect(pixinsight.enumerate()).rejects.toMatchObject({ code: 'cli_timeout' });
    expect(Date.now() - before).toBeLessThan(250);
    expect(await lines('calls.txt')).toHaveLength(1);
    // Other calls are tried as before.
    await expect(pixinsight.terminate(1)).rejects.toMatchObject({ code: 'cli_timeout' });
    expect(await lines('calls.txt')).toHaveLength(2);
  });

  it('starts an instance that runs scripts in order and then exits, with its output in a file', async () => {
    const pixinsight = await cli(`for each in "$@"; do echo "$each" >> '${dir}/argv.txt'; done\necho said`);
    const run = pixinsight.runToExit(240, [{ path: '/s/begin_log.js', args: ['/jobs/1/console.log'] }, { path: '/s/WBPP.js', args: ['automationMode=true', 'keywords=NIGHT post', 'dir=/data/my frames'] }, { path: '/s/end_log.js', args: [] }], join(dir, 'output.txt'));
    expect(await run.exited).toBe(0);
    expect(await lines('argv.txt')).toEqual([
      '-n=240',
      '--automation-mode',
      '--no-focus-stealing',
      '--no-startup-scripts',
      '-r=/s/begin_log.js,/jobs/1/console.log',
      '-r=/s/WBPP.js,automationMode=true,keywords=NIGHT post,dir=/data/my frames',
      '-r=/s/end_log.js',
      '--force-exit',
    ]);
    expect(await lines('output.txt')).toEqual(['said']);
  });

  it('starts no instance with an argument that would change the command line', async () => {
    const pixinsight = await cli(`echo called >> '${dir}/calls.txt'`);
    for (const bad of ['a,b', 'a;b', '$(x)', 'a\\b', 'a\u0000b', 'a\rb', 'a<b']) {
      expect(() => pixinsight.runToExit(240, [{ path: '/s/WBPP.js', args: [`x=${bad}`] }], join(dir, 'output.txt'))).toThrow(/command line/);
    }
    expect(await lines('calls.txt')).toEqual([]);
  });

  it('ends a run with everything the launcher started for it, and is fine with one that is gone', async () => {
    const pixinsight = await cli(`sleep 600 &\necho $! > '${dir}/child.pid'\nwait`);
    const run = pixinsight.runToExit(240, [{ path: '/s/WBPP.js', args: [] }], join(dir, 'output.txt'));
    await waitUntil(async () => (await lines('child.pid')).length === 1);
    const child = Number((await lines('child.pid'))[0]);
    expect(alive(child)).toBe(true);
    pixinsight.endRun(run);
    expect(await run.exited).toBeNull();
    await waitUntil(async () => !alive(child));
    expect(() => pixinsight.endRun(run)).not.toThrow();
    expect(() => pixinsight.endRun({ pid: undefined, exited: Promise.resolve(null) })).not.toThrow();
  });

  it('says so when the executable for a run is not there', async () => {
    const pixinsight = new ProcessCli(join(dir, 'nowhere'), { headless: true, cwd: dir, platform: 'linux', lockPath: null });
    expect(await pixinsight.runToExit(240, [{ path: '/s/WBPP.js', args: [] }], join(dir, 'output.txt')).exited).toBeNull();
  });

  it('does not list instances on Windows, where that opens a message box', async () => {
    const pixinsight = new ProcessCli(join(dir, 'nowhere'), { headless: false, cwd: dir, platform: 'win32' });
    expect(await pixinsight.enumerate()).toBeNull();
  });
});
