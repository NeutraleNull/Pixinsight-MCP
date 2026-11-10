import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareHome } from '../../src/home.js';

describe('prepareHome', () => {
  let root: string;
  let home: string;
  let source: string;

  const age = async (path: string, days: number) => {
    const then = new Date(Date.now() - days * 24 * 3600 * 1000);
    await utimes(path, then, then);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-test-'));
    home = join(root, 'home');
    source = join(root, 'pjsr');
    await mkdir(join(source, 'ops'), { recursive: true });
    await writeFile(join(source, 'runner.js'), '// one');
    await writeFile(join(source, 'ops', 'ping.js'), '// ping');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('copies the scripts and returns paths that exist', async () => {
    const paths = await prepareHome(home, source);
    expect(existsSync(paths.runnerPath)).toBe(true);
    expect(existsSync(join(paths.opsDir, 'ping.js'))).toBe(true);
    expect(existsSync(paths.jobsDir)).toBe(true);
  });

  it('finds every script it names among those that ship with the server', async () => {
    const paths = await prepareHome(home);
    for (const path of [paths.runnerPath, paths.readyPath, paths.closeAllPath, paths.beginLogPath, paths.endLogPath]) expect(existsSync(path), path).toBe(true);
  });

  it('keeps the scripts of a running server in place when another one starts', async () => {
    const first = await prepareHome(home, source);
    const second = await prepareHome(home, source);
    expect(second.runnerPath).toBe(first.runnerPath);

    await writeFile(join(source, 'runner.js'), '// two');
    const newer = await prepareHome(home, source);
    expect(newer.runnerPath).not.toBe(first.runnerPath);
    expect(existsSync(first.runnerPath)).toBe(true);
    expect(existsSync(newer.runnerPath)).toBe(true);
  });

  it('copes with servers starting at the same moment', async () => {
    const all = await Promise.all(Array.from({ length: 6 }, () => prepareHome(home, source)));
    expect(new Set(all.map((paths) => paths.runnerPath)).size).toBe(1);
    expect(existsSync(all[0]!.runnerPath)).toBe(true);
    expect((await readdir(join(home, 'pjsr'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('removes old jobs and old script versions, but nothing it did not create', async () => {
    const first = await prepareHome(home, source);
    const oldScripts = dirname(first.runnerPath);
    await writeFile(join(source, 'runner.js'), '// two');

    const oldJob = join(first.jobsDir, randomUUID());
    const recentJob = join(first.jobsDir, randomUUID());
    const foreign = join(first.jobsDir, 'my-own-folder');
    const foreignScripts = join(home, 'pjsr', 'notes');
    for (const dir of [oldJob, recentJob, foreign, foreignScripts]) await mkdir(dir);
    await age(oldJob, 2);
    await age(foreign, 30);
    await age(foreignScripts, 30);
    await age(oldScripts, 30);

    const oldOutput = join(home, `cli-${randomUUID()}.txt`);
    const foreignFile = join(home, 'notes.txt');
    for (const file of [oldOutput, foreignFile]) {
      await writeFile(file, '');
      await age(file, 2);
    }

    const current = await prepareHome(home, source);
    expect(existsSync(oldOutput)).toBe(false);
    expect(existsSync(foreignFile)).toBe(true);
    expect(existsSync(oldJob)).toBe(false);
    expect(existsSync(recentJob)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(foreignScripts)).toBe(true);
    expect(existsSync(oldScripts)).toBe(false);
    expect(existsSync(current.runnerPath)).toBe(true);
  });

  it('counts a version as used whenever a server starts with it', async () => {
    const first = await prepareHome(home, source);
    const scripts = dirname(first.runnerPath);
    await age(scripts, 30);
    await prepareHome(home, source);
    await writeFile(join(source, 'runner.js'), '// two');
    await prepareHome(home, source);
    expect(existsSync(first.runnerPath)).toBe(true);
  });

  it('puts its scripts back if a server of another version has removed them', async () => {
    const paths = await prepareHome(home, source);
    await paths.restoreScripts();
    await rm(dirname(paths.runnerPath), { recursive: true, force: true });
    expect(existsSync(paths.runnerPath)).toBe(false);
    await paths.restoreScripts();
    expect(existsSync(paths.runnerPath)).toBe(true);
    expect(existsSync(join(paths.opsDir, 'ping.js'))).toBe(true);
  });

  it('puts its scripts back if one of them was changed, because they run inside PixInsight', async () => {
    const paths = await prepareHome(home, source);
    await writeFile(join(paths.opsDir, 'ping.js'), '// something else');
    await writeFile(join(paths.opsDir, 'added.js'), '// not ours');
    await paths.restoreScripts();
    expect(await readFile(join(paths.opsDir, 'ping.js'), 'utf8')).toBe('// ping');
    expect(existsSync(join(paths.opsDir, 'added.js'))).toBe(false);
    expect(existsSync(paths.runnerPath)).toBe(true);
  });

  it('clears away what a server left that did not live to do it, and the layout of older versions', async () => {
    const paths = await prepareHome(home, source);
    const leftovers = [`ready-${randomUUID()}.json`, 'enum-checks.json.4711.tmp', join('pjsr', 'runner.js'), join('pjsr', 'ops')];
    for (const name of leftovers) {
      if (name.endsWith('ops')) await mkdir(join(home, name));
      else await writeFile(join(home, name), '');
      await age(join(home, name), 30);
    }
    await writeFile(join(home, 'enum-checks.json'), '{}');
    await age(join(home, 'enum-checks.json'), 30);
    await prepareHome(home, source);
    for (const name of leftovers) expect(existsSync(join(home, name)), name).toBe(false);
    expect(existsSync(join(home, 'enum-checks.json'))).toBe(true);
    expect(existsSync(paths.runnerPath)).toBe(true);
  });

  it('does not remove the scripts in use, however old they are', async () => {
    const first = await prepareHome(home, source);
    await age(dirname(first.runnerPath), 30);
    await prepareHome(home, source);
    expect(existsSync(first.runnerPath)).toBe(true);
  });

  it('refuses a home that cannot go over the command line of PixInsight', async () => {
    await expect(prepareHome(join(root, 'a(b'), source)).rejects.toThrow(/PIXINSIGHT_MCP_HOME/);
  });
});
