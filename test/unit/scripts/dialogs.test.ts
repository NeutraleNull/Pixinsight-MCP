import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changesIn, DialogFiles, engineOf, wrapperFor, type Field } from '../../../src/scripts/dialogs.js';

describe('what is different in a dialog since it was last read', () => {
  const before = (fields: Field[]) => new Map(fields.map((field) => [field.id, field]));

  it('names new fields in full, fields that are gone by their id, and counts the rest', () => {
    const was: Field[] = [{ id: 'f1', type: 'Edit', value: 'a' }, { id: 'f2', type: 'PushButton', text: 'OK' }, { id: 'f3', type: 'Label', text: 'Old' }];
    const now: Field[] = [{ id: 'f1', type: 'Edit', value: 'a' }, { id: 'f2', type: 'PushButton', text: 'OK' }, { id: 'f4', type: 'Label', text: 'New', at: [1, 2, 3, 4] }];
    expect(changesIn(before(was), now)).toEqual({ added: [{ id: 'f4', type: 'Label', text: 'New', at: [1, 2, 3, 4] }], changed: [], gone: ['f3'], unchanged: 2, partly: [] });
  });

  it('gives of a field that differs its id, its type, its label, and only the details that differ', () => {
    const was: Field[] = [{ id: 'f1', type: 'CheckBox', text: 'Solve', value: false, enabled: false }, { id: 'f2', type: 'ComboBox', options: ['a', 'b'], value: 'a' }];
    const now: Field[] = [{ id: 'f1', type: 'CheckBox', text: 'Solve', value: true }, { id: 'f2', type: 'ComboBox', options: ['a', 'b', 'c'], value: 'a' }];
    expect(changesIn(before(was), now).changed).toEqual([
      // A field without the detail is enabled, so that is what a detail that is gone says.
      { id: 'f1', type: 'CheckBox', text: 'Solve', value: true, enabled: true },
      { id: 'f2', type: 'ComboBox', options: ['a', 'b', 'c'] },
    ]);
  });

  it('says null for any other detail that a field no longer has, and takes a new kind under an old name for a change', () => {
    const was: Field[] = [{ id: 'f1', type: 'TreeBox', columns: ['n'], rows: [{ row: 0, cells: ['x'] }], value: 0, selected: ['x'] }, { id: 'f2', type: 'Edit', value: '1' }];
    const now: Field[] = [{ id: 'f1', type: 'TreeBox', columns: ['n'], rows: [{ row: 0, cells: ['x'] }], value: null }, { id: 'f2', type: 'SpinBox', value: 1, range: [0, 9] }];
    expect(changesIn(before(was), now).changed).toEqual([
      { id: 'f1', type: 'TreeBox', value: null, selected: null },
      { id: 'f2', type: 'SpinBox', value: 1, range: [0, 9] },
    ]);
  });

  it('does not count where a field lies or what explains it, which is not what the field shows', () => {
    const was: Field[] = [{ id: 'f1', type: 'Edit', value: 'a', at: [8, 8, 100, 20], help: 'The name.' }];
    expect(changesIn(before(was), [{ id: 'f1', type: 'Edit', value: 'a', at: [8, 40, 100, 20] }])).toMatchObject({ changed: [], unchanged: 1 });
  });

  it('names the unchanged fields of which only a part is listed, because only that part was compared', () => {
    const table: Field = { id: 'f1', type: 'TreeBox', columns: ['n'], rows: [{ row: 0, cells: ['x'] }], value: null, moreRows: 140 };
    const text: Field = { id: 'f2', type: 'TextBox', value: 'start…', more: 9000 };
    const whole: Field = { id: 'f3', type: 'Edit', value: 'all of it' };
    expect(changesIn(before([table, text, whole]), [table, { ...text, value: 'other…' }, whole])).toMatchObject({ changed: [{ id: 'f2', type: 'TextBox', value: 'other…' }], unchanged: 2, partly: ['f1'] });
  });
});

describe('the engine a script runs on', () => {
  it('is V8 only where the script says so at the start of a line', () => {
    expect(engineOf('#engine v8\n#feature-id A : B > A\n')).toBe('v8');
    expect(engineOf('// A script.\r\n  #engine   v8\r\nconsole.writeln( 1 );')).toBe('v8');
    expect(engineOf('#feature-id A : B > A\nvar d = new Dialog;')).toBe('classic');
    expect(engineOf('// run with #engine v8\nvar a = "#engine v8";')).toBe('classic');
    expect(engineOf('#engine v80\n')).toBe('classic');
  });

  it('reads the directive the way PixInsight does: in any case, and behind the mark that some editors put first', () => {
    expect(engineOf('#engine V8\nclass A {}\n')).toBe('v8');
    expect(engineOf('\uFEFF#engine v8\n')).toBe('v8');
    // The same mark, in a file that was read byte by byte.
    expect(engineOf(Buffer.from('\uFEFF#engine v8\n', 'utf8').toString('latin1'))).toBe('v8');
  });
});

describe('the file that is sent in place of a script', () => {
  const hook = '// The hook.\nfunction( jobDir, operate )\n{\n}\n';

  it('calls the hook with the folder of the job, then includes the script from where it is', () => {
    expect(wrapperFor(hook, '/home/a/jobs/1', '/opt/PixInsight/src/scripts/Solver.js', 'classic', 'operate')).toBe(
      '( // The hook.\nfunction( jobDir, operate )\n{\n} )( "/home/a/jobs/1", true, false );\n#include "/opt/PixInsight/src/scripts/Solver.js"\n',
    );
  });

  it('runs on V8 exactly where the script does, and says whether dialogs may be worked', () => {
    const wrapper = wrapperFor(hook, '/jobs/1', '/scripts/New.js', 'v8', 'read');
    expect(wrapper.split('\n')[0]).toBe('#engine v8');
    // The hook is told its engine: it could not tell by itself.
    expect(wrapper).toContain('( "/jobs/1", false, true );');
  });

  it('gives PixInsight its paths with forward slashes', () => {
    const wrapper = wrapperFor(hook, 'C:\\Users\\a\\jobs\\1', 'C:\\Program Files\\PixInsight\\src\\scripts\\Solver.js', 'classic', 'operate');
    expect(wrapper).toContain('( "C:/Users/a/jobs/1", true, false );');
    expect(wrapper).toContain('#include "C:/Program Files/PixInsight/src/scripts/Solver.js"');
  });
});

describe('DialogFiles', () => {
  let dir: string;
  let files: DialogFiles;
  const state = (serial: number, extra: object = {}) => writeFile(join(dir, `dialog-state-${serial}.json`), JSON.stringify({ serial, dialog: 'd1', title: 'Form', question: null, ...extra }));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-dialog-'));
    files = new DialogFiles(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('knows nothing before the script has said anything', async () => {
    expect(await files.state()).toBeNull();
    expect(await new DialogFiles(join(dir, 'gone')).state()).toBeNull();
  });

  it('reads the newest state, by its number and not by its name', async () => {
    await state(9);
    await state(10, { title: 'Child' });
    expect(await files.state()).toMatchObject({ serial: 10, title: 'Child' });
  });

  it('keeps the last state while the next one is being written', async () => {
    await state(3);
    expect((await files.state())?.serial).toBe(3);
    // The hook has removed the old file, and the new one is not whole yet.
    await rm(join(dir, 'dialog-state-3.json'));
    await writeFile(join(dir, 'dialog-state-4.json'), '{"serial":4,');
    expect((await files.state())?.serial).toBe(3);
  });

  it('numbers its commands, and hands out each reply once', async () => {
    const first = await files.post({ act: 'describe', dialog: null, help: false });
    const second = await files.post({ act: 'press', dialog: 'd1.1', field: 'f3' });
    expect(second).toBe(first + 1);
    // One command at a time: the later one replaces the one that was not taken.
    expect(JSON.parse(await readFile(join(dir, 'dialog-cmd.json'), 'utf8'))).toEqual({ act: 'press', dialog: 'd1.1', field: 'f3', id: second });

    expect(await files.reply(second)).toBeUndefined();
    await writeFile(join(dir, `dialog-reply-${second}.json`), JSON.stringify({ ok: true, result: { fired: ['onClick'] } }));
    expect(await files.reply(second)).toEqual({ ok: true, result: { fired: ['onClick'] } });
    expect(await files.reply(second)).toBeUndefined();
  });

  it('takes back a command only while it is the one that waits, and says whether it was still there', async () => {
    const first = await files.post({ act: 'close', dialog: 'd1.1' });
    const second = await files.post({ act: 'describe', dialog: null, help: true });
    expect(await files.withdraw(first)).toBe(false);
    expect(JSON.parse(await readFile(join(dir, 'dialog-cmd.json'), 'utf8')).id).toBe(second);
    // Still there, so it was not carried out, and now it never will be.
    expect(await files.withdraw(second)).toBe(true);
    await expect(readFile(join(dir, 'dialog-cmd.json'), 'utf8')).rejects.toThrow();
    // Gone, as after the script has taken it.
    expect(await files.withdraw(second)).toBe(false);
  });

  it('writes an answer for the question that was asked, and for no other', async () => {
    await files.answer({ id: 4, kind: 'message', buttons: ['yes', 'no'] }, 'yes');
    expect(JSON.parse(await readFile(join(dir, 'dialog-answer-4.json'), 'utf8'))).toEqual({ value: 'yes' });
  });
});
