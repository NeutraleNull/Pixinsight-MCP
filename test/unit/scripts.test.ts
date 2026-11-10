import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findScripts, hashOfFile, parseFeature } from '../../src/scripts.js';

describe('parseFeature', () => {
  it('reads a name with its menu', () => {
    expect(parseFeature('#feature-id    Solver : Astrometry > Solver\n')).toEqual({ name: 'Solver', menus: ['Astrometry > Solver'] });
  });

  it('reads the older form, where the last part of the menu is the name', () => {
    expect(parseFeature('// header\n#feature-id Utilities > Batch Converter\n')).toEqual({ name: 'Batch Converter', menus: ['Utilities > Batch Converter'] });
  });

  it('reads several menus, also across continued lines', () => {
    const head = '#feature-id   Annotate : Astrometry > Annotate | \\\n                Render  >  Annotate\n#feature-info  x\n';
    expect(parseFeature(head)).toMatchObject({ name: 'Annotate', menus: ['Astrometry > Annotate', 'Render > Annotate'] });
  });

  it('turns the description into plain text of a bounded length', () => {
    const head = `#feature-id A : Utilities > A\n#feature-info  <b>Does</b> this &amp; <i>that</i>.<br/>Then<br>this.<br/>\\\n   ${'More. '.repeat(100)}\n`;
    const { info } = parseFeature(head) ?? {};
    expect(info).toMatch(/^Does this & that\. Then this\. More\. /);
    expect(info?.length).toBeLessThanOrEqual(240);
    expect(info).toMatch(/…$/);
  });

  it('decodes what HTML encodes, and leaves an escaped tag as text', () => {
    const { info } = parseFeature('#feature-id A : Utilities > A\n#feature-info Copyright &copy; 2026 Andr&eacute;s &#47; M&#x00fc;ller &amp;lt;b&amp;gt; &unknown; 5&deg;\n') ?? {};
    expect(info).toBe('Copyright © 2026 Andrés / Müller &lt;b&gt; &unknown; 5°');
  });

  it('reads files with Windows line ends', () => {
    expect(parseFeature('// x\r\n#feature-id A : Utilities > A | \\\r\n   Render > A\r\n#feature-info Does it.\r\n')).toEqual({
      name: 'A',
      menus: ['Utilities > A', 'Render > A'],
      info: 'Does it.',
    });
  });

  it('takes no script whose name or menus are long enough to be a message to the assistant', () => {
    expect(parseFeature(`#feature-id ${'N'.repeat(81)} : Utilities > A\n`)).toBeNull();
    expect(parseFeature(`#feature-id A : Utilities > ${'long '.repeat(30)}\n`)).toBeNull();
    expect(parseFeature(`#feature-id A : ${Array.from({ length: 7 }, (_, index) => `Menu > Item${index}`).join(' | ')}\n`)).toBeNull();
    expect(parseFeature(`#feature-id ${'N'.repeat(80)} : Utilities > A\n`)).not.toBeNull();
  });

  it('does not take a later line for part of the directive', () => {
    expect(parseFeature('#feature-id A : Utilities > A\n#include <x.jsh>\nvar b = "Menu > Item";\n')).toEqual({ name: 'A', menus: ['Utilities > A'] });
  });

  it.each([
    ['a file that others include', '#include <x.jsh>\nfunction f() {}\n'],
    ['a directive in a comment', '// #feature-id A : Utilities > A\n'],
    ['another directive that starts the same', '#feature-identity A : Utilities > A\n'],
    ['a directive without a menu', '#feature-id \n'],
  ])('finds no featured script in %s', (_name, head) => {
    expect(parseFeature(head)).toBeNull();
  });
});

describe('findScripts', () => {
  let root: string;
  const write = async (path: string, content: string | Buffer) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  const shipped = (name: string) => ({ dir: join(root, name), source: 'shipped' as const });
  const user = (name: string) => ({ dir: join(root, name), source: 'user' as const });
  const names = async (...folders: Parameters<typeof findScripts>[0]) => (await findScripts(folders)).map((script) => script.name);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds the featured scripts in a folder and below, sorted by name, with their files and what identifies their content', async () => {
    const alpha = '/* license */\n#feature-id Alpha : Render > Alpha\n#feature-info Draws.\n';
    await write('shipped/b/Zeta.js', '#feature-id Zeta : Utilities > Zeta\n');
    await write('shipped/Alpha.js', alpha);
    await write('shipped/b/helper.js', 'function helper() {}\n');
    await write('shipped/b/notes.txt', '#feature-id Notes : Utilities > Notes\n');
    await write('shipped/b/include.jsh', '#feature-id Include : Utilities > Include\n');

    const found = await findScripts([shipped('shipped')]);
    expect(found).toEqual([
      { name: 'Alpha', menus: ['Render > Alpha'], info: 'Draws.', path: join(root, 'shipped', 'Alpha.js'), source: 'shipped', sha256: createHash('sha256').update(alpha).digest('hex') },
      { name: 'Zeta', menus: ['Utilities > Zeta'], path: join(root, 'shipped', 'b', 'Zeta.js'), source: 'shipped', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(await hashOfFile(join(root, 'shipped', 'Alpha.js'))).toBe(found[0]?.sha256);
  });

  it('does not let a later folder replace a script of an earlier one, whatever the case of the name', async () => {
    await write('shipped/Solver.js', '#feature-id Solver : Astrometry > Solver\n');
    await write('mine/solver.js', '#feature-id SOLVER : Utilities > Other\n');
    await write('mine/Extra.js', '#feature-id Extra : Utilities > Extra\n');

    const found = await findScripts([shipped('shipped'), user('mine')]);
    expect(found.map((script) => [script.name, script.source, script.path])).toEqual([
      ['Extra', 'user', join(root, 'mine', 'Extra.js')],
      ['Solver', 'shipped', join(root, 'shipped', 'Solver.js')],
    ]);
  });

  it('reads a script that is not UTF-8, one that is, and one whose directive comes after a long header', async () => {
    await write('a/Latin.js', Buffer.concat([Buffer.from('// caf\xe9 \xfc\n', 'latin1'), Buffer.from('#feature-id Latin : Utilities > Latin\n#feature-info Caf\xe9.\n', 'latin1')]));
    await write('a/Utf.js', '#feature-id Utf : Utilities > Utf\n#feature-info Für Hα und Café.\n');
    await write('a/Long.js', `/*\n${' * license with an ü in it\n'.repeat(1100)}*/\n#feature-id Long : Utilities > Long\n${'// é\n'.repeat(4000)}`);
    expect((await findScripts([shipped('a')])).map((script) => [script.name, script.info])).toEqual([
      ['Latin', 'Café.'],
      ['Long', undefined],
      ['Utf', 'Für Hα und Café.'],
    ]);
  });

  it('searches two folders down and no further, and passes over a folder that does not exist', async () => {
    await write('a/Top.js', '#feature-id Top : Utilities > Top\n');
    await write('a/1/2/Deep.js', '#feature-id Deep : Utilities > Deep\n');
    await write('a/1/2/3/Deeper.js', '#feature-id Deeper : Utilities > Deeper\n');
    expect(await names(shipped('missing'), shipped('a'))).toEqual(['Deep', 'Top']);
  });

  it('stops at its limit of files instead of reading a whole disk', async () => {
    for (const name of ['A', 'B', 'C', 'D']) await write(`a/${name}.js`, `#feature-id ${name} : Utilities > ${name}\n`);
    expect((await findScripts([shipped('a')], { maxDepth: 2, maxFiles: 3 })).map((script) => script.name)).toEqual(['A', 'B', 'C']);
  });

  it('follows no links, so that a folder of scripts cannot reach files that lie somewhere else', async () => {
    await write('elsewhere/Outside.js', '#feature-id Outside : Utilities > Outside\n');
    await write('a/Inside.js', '#feature-id Inside : Utilities > Inside\n');
    await symlink(join(root, 'elsewhere', 'Outside.js'), join(root, 'a', 'Link.js'));
    await symlink(join(root, 'elsewhere'), join(root, 'a', 'linked-folder'));
    expect(await names(user('a'))).toEqual(['Inside']);
  });

  it('takes the first of two files in one folder that claim the same name, in the order of their file names', async () => {
    await write('a/b.js', '#feature-id Same : Utilities > Second\n');
    await write('a/a.js', '#feature-id Same : Utilities > First\n');
    expect((await findScripts([shipped('a')])).map((script) => script.menus)).toEqual([['Utilities > First']]);
  });
});
