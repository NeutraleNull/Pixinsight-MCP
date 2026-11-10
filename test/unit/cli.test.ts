import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError, ProcessCli } from '../../src/bridge/cli.js';

/** A stand-in for the PixInsight launcher, which is what the server calls on Linux. */
describe.skipIf(process.platform === 'win32')('ProcessCli', () => {
  let dir: string;

  const cli = async (script: string) => {
    const executable = join(dir, 'fake.sh');
    await writeFile(executable, `#!/bin/sh\n${script}\n`);
    await chmod(executable, 0o755);
    return new ProcessCli(executable, { headless: true, cwd: dir, platform: 'linux' });
  };

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
    const pixinsight = new ProcessCli(join(dir, 'nowhere'), { headless: true, cwd: dir, platform: 'linux' });
    await expect(pixinsight.terminate(1)).rejects.toMatchObject({ code: 'cli_failed' });
    expect((await readdir(dir)).filter((name) => name.startsWith('cli-'))).toEqual([]);
  });

  it('does not list instances on Windows, where that opens a message box', async () => {
    const pixinsight = new ProcessCli(join(dir, 'nowhere'), { headless: false, cwd: dir, platform: 'win32' });
    expect(await pixinsight.enumerate()).toBeNull();
  });
});
