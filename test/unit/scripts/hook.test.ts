import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Dialog, Env, MessageBox, OpenFileDialog, PushButton, Sizer, TabBox, type Reply } from './dialogFakes.js';

/** A dialog like those of scripts: some controls kept on the dialog, one not, one in a panel. */
const FORM = `
var log = [];
var form = new Dialog;
form.windowTitle = "Form";
form.at( 0, 0, 300, 240 );
form.title_Label = new Label( form ).at( 8, 8, 100, 14 );
form.title_Label.useRichText = true;
form.title_Label.text = "<b>Name</b> of the&nbsp;target:";
form.name_Edit = new Edit( form ).at( 120, 6, 150, 20 );
form.name_Edit.text = "initial";
form.name_Edit.toolTip = "<p>The name of the thing.</p>";
form.name_Edit.onEditCompleted = function() { log.push( "edit:" + this.text ); };
form.key_Edit = new Edit( form ).at( 8, 30, 150, 20 );
form.key_Edit.passwordMode = true;
form.key_Edit.text = "SECRET";
form.flag_CheckBox = new CheckBox( form ).at( 8, 54, 150, 16 );
form.flag_CheckBox.text = "Use the flag";
form.flag_CheckBox.onCheck = function( checked ) { log.push( "check:" + checked ); form.locked_Edit.enabled = checked; };
form.locked_Edit = new Edit( form ).at( 8, 74, 150, 20 );
form.locked_Edit.enabled = false;
form.mode_ComboBox = new ComboBox( form ).at( 8, 98, 150, 20 );
form.mode_ComboBox.items = [ "First", "Second", "Third" ];
form.mode_ComboBox.onItemSelected = function( index ) { log.push( "combo:" + index ); };
form.amount = new NumericControl( form ).at( 8, 122, 200, 20 );
form.amount.label.text = "Amount:";
form.amount.value = 0.25;
form.amount.onValueUpdated = function( value ) { log.push( "amount:" + value ); };
form.count = new SpinBox( form ).at( 8, 146, 60, 20 );
form.count.value = 3;
form.count.minValue = 1;
form.count.maxValue = 10;
form.count.onValueUpdated = function( value ) { log.push( "count:" + value ); };
form.table = new TreeBox( form ).at( 8, 170, 200, 30 );
form.table.headers = [ "What", "Value" ];
form.table.add( "Median", "80.0" );
form.table.add( "Count", "7" );
form.table.onCurrentNodeUpdated = function( node ) { log.push( "row:" + node.text( 0 ) ); };
form.hidden_Edit = new Edit( form ).at( 220, 170, 60, 20 );
form.hidden_Edit.shown = false;
( function() {
   // Kept nowhere, and laid out like every control of a real dialog.
   var unnamed = new CheckBox( form ).at( 8, 204, 150, 16 );
   unnamed.text = "Not a property";
   unnamed.onCheck = function( checked ) { log.push( "unnamed:" + checked ); };
   form.sizer = new Sizer;
   form.sizer.add( unnamed );
} )();
form.canvas = new Control( form ).at( 220, 30, 60, 40 );
form.canvas.onPaint = function() {};
form.canvas.onMousePress = function( x, y, button ) { log.push( "mouse:" + x + "," + y + "," + button ); };
form.panel = new Control( form ).at( 220, 80, 60, 40 );
form.inner_Button = new PushButton( form.panel ).at( 4, 4, 50, 20 );
form.inner_Button.text = "Inner";
form.inner_Button.onClick = function() { log.push( "inner" ); };
form.ask_Button = new PushButton( form ).at( 80, 222, 60, 16 );
form.ask_Button.text = "Ask";
form.ask_Button.onClick = function() { log.push( "ask:" + ( new MessageBox( "<p>Replace the <b>file</b>?</p>", "A question", 1, 3, 4 ) ).execute() ); };
form.pick_Button = new PushButton( form ).at( 150, 222, 60, 16 );
form.pick_Button.text = "Pick";
form.pick_Button.onClick = function() { var chooser = new OpenFileDialog; chooser.caption = "Pick a file"; chooser.loadImageFilters(); log.push( chooser.execute() ? "file:" + chooser.fileName + ":" + chooser.filters.length : "file:none" ); };
form.child_Button = new PushButton( form ).at( 220, 222, 60, 16 );
form.child_Button.text = "Child";
form.child_Button.onClick = function()
{
   var child = new Dialog;
   child.windowTitle = "Child";
   child.value_Edit = new Edit( child ).at( 8, 8, 100, 20 );
   child.value_Edit.text = "child value";
   log.push( "child:" + child.execute() + ":" + child.value_Edit.text );
};
form.fail_Button = new PushButton( form ).at( 220, 130, 60, 16 );
form.fail_Button.text = "Fail";
form.fail_Button.onClick = function() { throw new Error( "the handler failed" ); };
form.ok_Button = new PushButton( form ).at( 8, 222, 60, 16 );
form.ok_Button.text = "OK";
form.ok_Button.onClick = function() { form.ok(); };
`;

/** One of every kind of field that the first form does not have. */
const KINDS = `
var log = [];
var form = new Dialog;
form.windowTitle = "Kinds";
form.at( 0, 0, 300, 300 );
form.tabs = new TabBox( form ).at( 8, 8, 280, 20 );
form.tabs.pages = [ "Target", "Output" ];
form.tabs.onPageSelected = function( index ) { log.push( "page:" + index ); form.onSecondPage.shown = index === 1; };
form.onSecondPage = new CheckBox( form ).at( 8, 32, 150, 16 );
form.onSecondPage.text = "On the second page";
form.onSecondPage.shown = false;
form.group = new GroupBox( form ).at( 8, 56, 280, 16 );
form.group.title = "Reject outliers";
form.group.titleCheckBox = true;
form.group.onCheck = function( checked ) { log.push( "group:" + checked ); };
form.slider = new Slider( form ).at( 8, 80, 150, 16 );
form.slider.maxValue = 10;
form.slider.onValueUpdated = function( value ) { log.push( "slider:" + value ); };
form.radios = [ new RadioButton( form ).at( 8, 104, 80, 16 ), new RadioButton( form ).at( 96, 104, 80, 16 ) ];
form.radios[0].text = "Mean";
form.radios[1].text = "Median";
form.radios[1].onCheck = function( checked ) { log.push( "median:" + checked ); };
form.pin = new ToolButton( form ).at( 8, 128, 20, 20 );
form.pin.text = "Pin";
form.pin.checkable = true;
form.pin.onCheck = function( checked ) { log.push( "pin:" + checked ); };
form.idle = new ToolButton( form ).at( 40, 128, 20, 20 );
form.idle.text = "Idle";
form.idle.checkable = true;
form.notes = new TextBox( form ).at( 8, 152, 280, 30 );
form.notes.text = "x".repeat( 7000 );
form.fixed = new Edit( form ).at( 8, 188, 100, 20 );
form.fixed.text = "<computed>";
form.fixed.readOnly = true;
form.scale = new ComboBox( form ).at( 8, 212, 100, 20 );
form.scale.items = [ "1", "2", "4", "<Auto>" ];
form.scale.onItemSelected = function( index ) { log.push( "scale:" + index ); };
form.same = new ComboBox( form ).at( 120, 212, 100, 20 );
form.same.items = [ "Twin", "Twin", "Other" ];
form.free = new ComboBox( form ).at( 8, 236, 100, 20 );
form.free.items = [ "red" ];
form.free.editEnabled = true;
form.free.editText = "red";
form.free.onEditTextUpdated = function( text ) { log.push( "free:" + text ); };
form.free.onItemSelected = function( index ) { log.push( "freeItem:" + index ); };
form.views = new ViewList( form ).at( 120, 236, 150, 20 );
form.views.onViewSelected = function( view ) { log.push( "view:" + view.fullId ); };
form.many = new ComboBox( form ).at( 8, 260, 100, 20 );
for ( var i = 0; i < 70; i++ ) form.many.items.push( "option " + i );
form.table = new TreeBox( form ).at( 120, 260, 150, 30 );
form.table.headers = [ "n" ];
for ( var i = 0; i < 65; i++ ) form.table.add( "row " + i );
form.key = new Edit( form ).at( 180, 188, 100, 20 );
form.key.passwordMode = true;
form.key.text = "LICENSE-KEY";
form.show = new CheckBox( form ).at( 180, 128, 100, 16 );
form.show.text = "Show the key";
form.show.onCheck = function( checked ) { form.key.passwordMode = !checked; };
`;

describe.each(['v8', 'classic'] as const)('the hook in a script, on the %s engine', (engine) => {
  let env: Env;
  let replies: Reply[];

  /** Runs the form with the hook, while the steps play the server. The last step has to close the form. */
  const run = (steps: Array<() => boolean>, code = 'form.execute()', operate = true): string[] => {
    env.install(operate);
    env.script(FORM);
    env.steps = steps;
    env.script(code);
    // What only waited for the reply to the step that closed the dialog.
    while (env.steps.length && env.steps[0]!()) env.steps.shift();
    expect(env.steps, 'steps that never came to pass').toHaveLength(0);
    return env.script<string[]>('log');
  };
  const close = () => {
    env.script('form.done( 1 )');
    return true;
  };
  const described = () => {
    const fields = (replies[0]?.result?.['fields'] ?? []) as Array<Record<string, any>>;
    return { fields, id: (text: string) => fields.find((field) => field['text'] === text || field['value'] === text || field['type'] === text)?.['id'] as string };
  };
  /** Steps for an action on the field with this text or of this type, once the dialog has been described. */
  const act = (command: (id: string) => Record<string, unknown>, field: string): Array<() => boolean> => {
    const pending: Array<() => boolean> = [];
    return [
      () => {
        pending.push(...env.ask(command(described().id(field)), replies));
        return true;
      },
      () => pending[0]!() && Boolean(pending.shift()),
      () => pending[0]!(),
    ];
  };
  const set = (field: string, value: unknown) => act((id) => ({ act: 'set', field: id, value }), field);
  const press = (field: string) => act((id) => ({ act: 'press', field: id }), field);

  beforeEach(() => {
    env = new Env(engine);
    replies = [];
  });

  afterEach(() => {
    env.dispose();
  });

  it('describes a dialog in reading order, with what the script keeps on it and what only lies on its surface', () => {
    run([...env.ask({ act: 'describe', help: true }, replies), close]);
    expect(replies[0]).toMatchObject({ ok: true, result: { dialog: 'd1.1', title: 'Form', size: [300, 240] } });
    const { fields } = described();
    expect(fields.map((field) => [field['type'], field['text'] ?? field['value']])).toEqual([
      ['Label', 'Name of the target:'],
      ['Edit', 'initial'],
      ['Edit', undefined],
      ['Control', undefined],
      ['CheckBox', 'Use the flag'],
      ['Edit', ''],
      ['PushButton', 'Inner'],
      ['ComboBox', 'First'],
      ['NumericControl', 'Amount:'],
      ['PushButton', 'Fail'],
      ['SpinBox', 3],
      ['TreeBox', null],
      ['CheckBox', 'Not a property'],
      ['PushButton', 'OK'],
      ['PushButton', 'Ask'],
      ['PushButton', 'Pick'],
      ['PushButton', 'Child'],
    ]);
    // A password is never read out, a disabled field says so, and a tooltip comes as plain text.
    expect(fields[2]).toEqual({ id: expect.any(String), type: 'Edit', secret: true, at: [8, 30, 150, 20] });
    expect(JSON.stringify(replies[0])).not.toContain('SECRET');
    expect(fields[5]).toMatchObject({ type: 'Edit', enabled: false });
    expect(fields[1]).toMatchObject({ help: 'The name of the thing.', at: [120, 6, 150, 20] });
    expect(fields[3]).toMatchObject({ drawn: true });
    expect(fields[7]).toMatchObject({ options: ['First', 'Second', 'Third'], value: 'First' });
    // The parts of a control that is one field are no fields of their own.
    expect(fields[8]).toMatchObject({ value: 0.25, range: [0, 1] });
    expect(fields[10]).toMatchObject({ value: 3, range: [1, 10] });
    expect(fields[11]).toMatchObject({ columns: ['What', 'Value'], rows: [{ row: 0, cells: ['Median', '80.0'] }, { row: 1, cells: ['Count', '7'] }], value: null });
    // Where the button lies in the dialog, not in the panel it sits in.
    expect(fields[6]).toMatchObject({ at: [224, 84, 50, 20] });
    expect(new Set(fields.map((field) => field['id'])).size).toBe(fields.length);
  });

  it('sets values the way a user would, which means calling the handler of the script', () => {
    const log = run([
      ...env.ask({ act: 'describe', help: false }, replies),
      ...set('initial', 'M 31'),
      ...set('Use the flag', true),
      ...set('ComboBox', 'third'),
      ...set('ComboBox', 0),
      ...set('Amount:', 0.8),
      ...set('SpinBox', 7),
      ...set('TreeBox', 1),
      ...set('Not a property', true),
      // Nothing changes, so nothing is told to the script.
      ...set('Not a property', true),
      close,
    ]);
    expect(replies.map((reply) => reply.ok)).toEqual(Array.from({ length: 10 }, () => true));
    expect(log).toEqual(['edit:M 31', 'check:true', 'combo:2', 'combo:0', 'amount:0.8', 'count:7', 'row:Count', 'unnamed:true']);
    expect(replies[1]?.result).toEqual({ fired: ['onEditCompleted'] });
    expect(env.script('[ form.name_Edit.text, form.flag_CheckBox.checked, form.amount.value, form.count.value ]')).toEqual(['M 31', true, 0.8, 7]);
    // The user can read in the console what was done on their behalf.
    expect(env.consoleLines).toContain('MCP: set CheckBox "Use the flag" to true');
    expect(env.consoleLines).toContain('MCP: selected row 1 of a table (Count, 7)');
  });

  it('refuses what the user could not do either, and says what would work', () => {
    const nth = (index: number) => described().fields[index]!['id'] as string;
    const at = (index: number, command: (id: string) => Record<string, unknown>): Array<() => boolean> => {
      const pending: Array<() => boolean> = [];
      return [() => pending.push(...env.ask(command(nth(index)), replies)) > 0, () => pending[0]!() && Boolean(pending.shift()), () => pending[0]!()];
    };
    const log = run([
      ...env.ask({ act: 'describe', help: false }, replies),
      // The field for a key, and one that is disabled.
      ...at(2, (id) => ({ act: 'set', field: id, value: 'x' })),
      ...at(5, (id) => ({ act: 'set', field: id, value: 'x' })),
      ...set('ComboBox', 'Fourth'),
      ...set('Amount:', 3),
      ...set('SpinBox', 2.5),
      ...set('Use the flag', 'yes'),
      ...set('OK', true),
      ...env.ask({ act: 'set', field: 'f99', value: 1 }, replies),
      // An edit field has nothing to press.
      ...at(1, (id) => ({ act: 'press', field: id })),
      close,
    ]);
    expect(replies.slice(1).map((reply) => reply.error?.kind)).toEqual(['secret_field', 'field_disabled', 'invalid_value', 'invalid_value', 'invalid_value', 'invalid_value', 'not_settable', 'unknown_field', 'no_effect']);
    expect(replies[3]?.error?.message).toMatch(/It has: First, Second, Third\./);
    expect(replies[4]?.error?.message).toMatch(/from 0 to 1/);
    expect(log).toEqual([]);
    expect(env.script('form.key_Edit.text')).toBe('SECRET');
  });

  it('presses buttons, also one inside a panel, and reports a handler of the script that fails', () => {
    const log = run([...env.ask({ act: 'describe', help: false }, replies), ...press('Inner'), ...press('Fail'), ...press('OK')]);
    expect(replies.slice(1)).toEqual([
      { ok: true, result: { fired: ['onClick'] } },
      { ok: false, error: { kind: 'script_error', message: 'The script failed while it handled this (onClick): the handler failed' } },
      { ok: true, result: { fired: ['onClick'] } },
    ]);
    expect(log).toEqual(['inner']);
    // The script got the code of the OK button back.
    expect(env.script('form.result')).toBe(1);
  });

  it('clicks into an area the script draws itself, at the place that was meant', () => {
    const log = run([
      ...env.ask({ act: 'click', x: 230, y: 45 }, replies),
      // On a button a click is a press, and where nothing takes clicks it is refused.
      ...env.ask({ act: 'click', x: 230, y: 90 }, replies),
      ...env.ask({ act: 'click', x: 290, y: 5 }, replies),
      ...env.ask({ act: 'click', x: 400, y: 5 }, replies),
      close,
    ]);
    expect(log).toEqual(['mouse:10,15,1', 'inner']);
    expect(replies[0]?.result).toMatchObject({ fired: ['onMousePress'] });
    expect(replies.slice(2).map((reply) => reply.error?.kind)).toEqual(['no_effect', 'invalid_value']);
  });

  it('does not click on a field, which would tell the script of a click that changed nothing', () => {
    const log = run([
      // The check box, the edit field, and the label inside the control for a number.
      ...env.ask({ act: 'click', x: 20, y: 60 }, replies),
      ...env.ask({ act: 'click', x: 130, y: 12 }, replies),
      ...env.ask({ act: 'click', x: 12, y: 128 }, replies),
      close,
    ]);
    expect(replies.map((reply) => reply.error?.kind)).toEqual(['not_clickable', 'not_clickable', 'not_clickable']);
    expect(replies[0]?.error?.message).toMatch(/lies field f\d+, a CheckBox\. Give it a value with the action set\./);
    expect(replies[2]?.error?.message).toMatch(/a NumericControl/);
    expect(log).toEqual([]);
    expect(env.script('form.flag_CheckBox.checked')).toBe(false);
  });

  it('does nothing that was meant for another showing of the dialog, or for another dialog', () => {
    let stale = 0;
    const log = run(
      [
        ...env.ask({ act: 'describe', help: false }, replies),
        () => {
          // The script closes the dialog and opens it again, as one that loops over its dialog does.
          stale = env.post({ act: 'close', dialog: 'd1.1' });
          env.script('form.done( 1 )');
          return true;
        },
        () => env.state()?.dialog === 'd1.2',
        () => env.reply(stale) !== null,
        ...env.ask({ act: 'press', dialog: 'd7.1', field: 'f1' }, replies),
        close,
      ],
      'form.execute(); log.push( "again" ); form.execute();',
    );
    expect(env.reply(stale)).toMatchObject({ ok: false, error: { kind: 'dialog_changed' } });
    expect(replies[1]?.error?.kind).toBe('dialog_changed');
    expect(log).toEqual(['again']);
  });

  it('serves a dialog that a button opened, and the first one again once that is closed', () => {
    const child: Reply[] = [];
    let pressed = 0;
    const log = run([
      ...env.ask({ act: 'describe', help: false }, replies),
      () => {
        pressed = env.post({ act: 'press', field: described().id('Child') });
        return true;
      },
      // The press cannot be answered while the dialog it opened is up. That one answers instead.
      () => env.state()?.title === 'Child',
      ...env.ask({ act: 'describe', help: false }, child),
      () => {
        expect(env.reply(pressed)).toBeNull();
        return true;
      },
      ...env.ask({ act: 'set', field: 'f2', value: 'x' }, child),
      () => {
        const id = (child[0]?.result?.['fields'] as Array<{ id: string }>)[0]!.id;
        env.steps.splice(1, 0, ...env.ask({ act: 'set', field: id, value: 'typed into the child' }, child), ...env.ask({ act: 'close' }, child));
        return true;
      },
      () => env.state()?.title === 'Form' && env.reply(pressed) !== null,
      close,
    ]);
    expect(child[0]?.result).toMatchObject({ dialog: 'd2.1', title: 'Child', fields: [{ type: 'Edit', value: 'child value' }] });
    // A field of the dialog underneath cannot be reached while another one is on top.
    expect(child[1]?.error?.kind).toBe('unknown_field');
    expect(child.slice(2).map((reply) => reply.ok)).toEqual([true, true]);
    expect(log).toEqual(['child:0:typed into the child']);
  });

  it('shows a message of the script as a question, which the server answers with the name of a button', () => {
    let pressed = 0;
    const log = run([
      ...env.ask({ act: 'describe', help: false }, replies),
      () => {
        pressed = env.post({ act: 'press', field: described().id('Ask') });
        return true;
      },
      () => env.state()?.question !== null,
      () => {
        expect(env.state()?.question).toEqual({ id: 1, kind: 'message', text: 'Replace the file?', caption: 'A question', icon: 'question', buttons: ['yes', 'no'] });
        // While the script waits for an answer, nothing else is done to its dialog.
        env.answer(1, 'no');
        return true;
      },
      () => env.reply(pressed) !== null,
      close,
    ]);
    expect(log).toEqual(['ask:4']);
    expect(env.nativeWindows).toEqual([]);
    expect(env.state()?.question).toBeNull();
    expect(env.consoleLines).toContain('MCP: answered "Replace the file?" with no');
  });

  it('lets the user answer the same question in PixInsight, in a window that says what the script asked', () => {
    const log = run([
      ...env.ask({ act: 'describe', help: false }, replies),
      () => {
        env.post({ act: 'press', field: described().id('Ask') });
        return true;
      },
      () => env.state()?.question !== null && env.made.at(-1)!.waiting,
      () => {
        const prompt = env.made.at(-1) as Dialog;
        expect(prompt.windowTitle).toBe('A question');
        expect(prompt.visible).toBe(true);
        const buttons = prompt.children.filter((child): child is PushButton => child instanceof PushButton);
        expect(buttons.map((button) => button.text)).toEqual(['Yes', 'No']);
        (buttons[0]!['onClick'] as () => void)();
        return true;
      },
      () => env.state()?.question === null,
      close,
    ]);
    expect(log).toEqual(['ask:3']);
    expect(env.nativeWindows).toEqual([]);
  });

  it('takes an answer that is there before the window is, without leaving the window open for good', () => {
    const log = run(
      [
        () => {
          // Before anything is asked: the fastest answer there can be.
          env.answer(1, 'yes');
          return true;
        },
      ],
      'log.push( "ask:" + ( new MessageBox( "Go on?", "", 0, 3, 4 ) ).execute() )',
    );
    expect(log).toEqual(['ask:3']);
    expect(env.nativeWindows).toEqual([]);
  });

  it('counts a question that is closed without a choice as the button the Esc key stands for', () => {
    const closing = (code: string) => {
      const fresh = new Env(engine);
      fresh.install();
      fresh.steps = [
        () => fresh.state()?.question !== null && fresh.made.at(-1)!.visible,
        () => {
          fresh.made.at(-1)!.cancel();
          return true;
        },
      ];
      const result = fresh.script<number>(code);
      fresh.dispose();
      return result;
    };
    expect(closing('( new MessageBox( "a", "b", 0, 3, 4 ) ).execute()')).toBe(4);
    expect(closing('( new MessageBox( "a", "b", 0, 1, 2 ) ).execute()')).toBe(2);
    expect(closing('( new MessageBox( "a" ) ).execute()')).toBe(1);
    expect(closing('var box = new MessageBox( "a", "b", 0, 5, 6, 7 ); box.escapeButton = 1; box.execute()')).toBe(6);
  });

  it('asks again where no button stands for closing, instead of choosing one for the user', () => {
    env.install();
    let closed = 0;
    env.steps = [
      () => env.state()?.question?.['id'] === 1 && env.made.at(-1)!.visible && env.made.at(-1)!.waiting,
      () => {
        closed++;
        env.made.at(-1)!.cancel();
        return true;
      },
      () => env.state()?.question?.['id'] === 2 && env.made.at(-1)!.visible,
      () => {
        env.answer(2, 'retry');
        return true;
      },
    ];
    expect(env.script('( new MessageBox( "Abort, retry or ignore?", "b", 0, 5, 6, 7 ) ).execute()')).toBe(6);
    expect(closed).toBe(1);
  });

  it('gives the Enter key the button it has in the message box of the script', () => {
    env.install();
    env.steps = [
      () => env.state()?.question !== null && env.made.at(-1)!.visible,
      () => {
        const buttons = env.made.at(-1)!.children.filter((child): child is PushButton => child instanceof PushButton);
        expect(buttons.map((button) => [button.text, button.defaultButton])).toEqual([['Yes', false], ['No', true]]);
        env.answer(1, 'yes');
        return true;
      },
    ];
    expect(env.script('var box = new MessageBox( "a", "b", 0, 3, 4 ); box.defaultButton = 1; box.execute()')).toBe(3);
  });

  it('keeps the first question open while the script asks a second one on top of it', () => {
    env.install();
    const seen: unknown[] = [];
    let phase = 0;
    env.steps = [
      () => env.state()?.question?.['id'] === 1 && env.made.at(-1)!.waiting,
      () => {
        if (phase === 0) {
          phase = 1;
          // A timer of the script asks while the first window is still up. This step is called
          // again while that second window waits, and answers it there.
          env.script('second = ( new MessageBox( "second" ) ).execute()');
          seen.push(env.state()?.question?.['id']);
          env.answer(1, 'yes');
          return true;
        }
        if (phase === 1 && env.state()?.question?.['id'] === 2 && env.made.at(-1)!.waiting) {
          phase = 2;
          env.answer(2, 'ok');
        }
        return false;
      },
    ];
    expect(env.script('var second = 0; ( new MessageBox( "first", "", 0, 3, 4 ) ).execute()')).toBe(3);
    // After the second one was answered, the first is the open question again.
    expect(seen).toEqual([1]);
    expect(env.script('second')).toBe(1);
    expect(env.state()?.question).toBeNull();
  });

  it('closes a window again that an answer closed in the moment before its wait began', () => {
    env.unluckyTick = true;
    env.install();
    env.steps = [
      () => {
        env.answer(1, 'no');
        return true;
      },
    ];
    expect(env.script('( new MessageBox( "Go on?", "", 0, 3, 4 ) ).execute()')).toBe(4);
  });

  it('writes what the assistant chose to the console so that it cannot pass for markup or for another line', () => {
    run([...env.ask({ act: 'describe', help: false }, replies), ...set('initial', 'a<clrbol>b\nMCP: pressed PushButton "Delete all"'), close]);
    expect(env.consoleLines).toEqual(['MCP: set Edit to "a‹clrbol›b\\nMCP: pressed PushButton \\"Delete all\\""']);
    expect(env.script('form.name_Edit.text')).toBe('a<clrbol>b\nMCP: pressed PushButton "Delete all"');
  });

  it('keeps serving as long as the server says that it waits, however long that is', () => {
    let late = 0;
    run([
      ...env.ask({ act: 'describe', help: false }, replies),
      ...Array.from({ length: 40 }, () => () => {
        env.now += 900;
        env.beat();
        return true;
      }),
      () => {
        late = env.post({ act: 'describe', help: false });
        return true;
      },
      () => env.reply(late) !== null,
      close,
    ]);
    expect(env.reply(late)?.ok).toBe(true);
  });

  it('only reads where the user has not allowed more, and leaves the windows of PixInsight alone', () => {
    const log = run([...env.ask({ act: 'describe', help: false }, replies), ...set('initial', 'x'), ...press('Ask'), close], 'form.execute()', false);
    expect(replies[0]?.ok).toBe(true);
    expect(replies.slice(1).map((reply) => reply.error?.kind)).toEqual(['read_only', 'read_only']);
    expect(log).toEqual([]);
    // What a script asks then comes up as PixInsight's own window.
    expect(env.script('( new MessageBox( "plain" ) ).execute()')).toBe(1);
    expect(env.nativeWindows).toEqual(['message: plain']);
  });

  it('answers nothing once the server has given up, and shows a message as PixInsight would', () => {
    let posted = 0;
    const log = run([
      ...env.ask({ act: 'describe', help: false }, replies),
      () => {
        env.beat(false);
        env.now += 1000;
        return true;
      },
      () => {
        posted = env.post({ act: 'press', field: described().id('Inner') });
        return true;
      },
      () => (env.now += 500) > 0,
      () => (env.now += 500) > 0,
      () => {
        expect(env.reply(posted)).toBeNull();
        (env.script<PushButton>('form.ask_Button')['onClick'] as () => void)();
        return true;
      },
      close,
    ]);
    expect(log).toEqual(['ask:3']);
    expect(env.nativeWindows).toEqual(['message: <p>Replace the <b>file</b>?</p>']);
  });

  it('notices on its own that the server is gone, by the silence', () => {
    let posted = 0;
    run([
      ...env.ask({ act: 'describe', help: false }, replies),
      () => {
        env.now += 16_000;
        posted = env.post({ act: 'describe', help: false });
        return true;
      },
      () => (env.now += 500) > 0,
      () => (env.now += 500) > 0,
      () => {
        expect(env.reply(posted)).toBeNull();
        return true;
      },
      close,
    ]);
  });

  it('writes one file per state, and removes the one before', () => {
    run([() => env.state()?.dialog === 'd1.1', ...env.ask({ act: 'describe', help: false }, replies), close]);
    expect(readdirSync(env.jobDir).filter((name) => name.startsWith('dialog-state-'))).toHaveLength(1);
    expect(env.state()).toMatchObject({ dialog: null, title: null, question: null });
  });

  it('renders the dialog into the file the server names', () => {
    const path = join(env.jobDir, 'picture.png');
    run([...env.ask({ act: 'render', path }, replies), close]);
    expect(replies[0]).toEqual({ ok: true, result: { dialog: 'd1.1', size: [300, 240], covered: 1 } });
    // The field for a key is painted over, whatever it shows.
    expect(readFileSync(path, 'utf8')).toBe('picture of Form covered 8,30,158,50');
  });

  describe('with tables and long texts', () => {
    /** Tables as WBPP has them: kept on an object of the script, two of them in one place, and rows inside rows. */
    const TABLES = `
var log = [];
var form = new Dialog;
form.windowTitle = "Tables";
form.at( 0, 0, 400, 300 );
form.panel = { groups: [ new TreeBox( form ).at( 8, 8, 200, 60 ), new TreeBox( form ).at( 8, 8, 200, 60 ) ] };
for ( var t = 0; t < 2; t++ )
{
   form.panel.groups[t].headers = [ "#", "LIGHT", "Filter", "" ];
   form.panel.groups[t].add( "1", "10 frames", "H", "" );
   form.panel.groups[t].add( "2", "42 frames", "L", "" );
   form.panel.groups[t].onCurrentNodeUpdated = function( node ) { log.push( "group:" + node.text( 1 ) ); };
}
form.panel.groups[1].shown = false;
form.other = new TreeBox( form ).at( 8, 8, 200, 60 );
form.other.headers = [ "#", "FLAT" ];
form.other.shown = false;
form.redraw = new PushButton( form ).at( 220, 8, 80, 20 );
form.redraw.text = "Redraw";
form.redraw.onClick = function() { var groups = form.panel.groups; var on = groups[0].shown ? 0 : 1; groups[on].shown = false; groups[1 - on].shown = true; };
form.flats = new PushButton( form ).at( 220, 32, 80, 20 );
form.flats.text = "Flats";
form.flats.onClick = function() { form.panel.groups[0].shown = form.panel.groups[1].shown = false; form.other.shown = true; };
form.files = new TreeBox( form ).at( 8, 80, 200, 100 );
form.files.headers = [ "Light frames", "Time", "Internal" ];
form.files.hiddenColumns = [ 2 ];
( function() {
   var bin = form.files.add( "Binning 1" );
   var h = bin.add( "H" );
   var first = h.add( "SESSION: 1 (2 frames)" );
   first.add( "a.fits", "21:00", "x" );
   first.add( "b.fits", "21:05", "x" );
   h.add( "SESSION: 2 (1 frame)" ).add( "c.fits", "22:00", "x" );
   var many = bin.add( "O" ).add( "SESSION: 1 (70 frames)" );
   for ( var i = 0; i < 70; i++ )
      many.add( "o" + i + ".fits", "23:00", "x" );
} )();
form.files.onCurrentNodeUpdated = function( node ) { log.push( "file:" + node.text( 0 ) ); };
form.wide = new TreeBox( form ).at( 8, 190, 200, 40 );
for ( var c = 0; c < 20; c++ ) form.wide.headers.push( "c" + c );
form.gear = new ToolButton( form ).at( 220, 56, 20, 20 );
form.gear.toolTip = "<p>Settings of the <b>registration</b>.</p>";
form.gear.onClick = function() {};
form.report = new TextBox( form ).at( 8, 240, 380, 50 );
form.report.text = "0123456789".repeat( 2500 );
form.both = new PushButton( form ).at( 220, 56, 60, 20 );
form.both.text = "Both";
form.both.onClick = function() { form.panel.groups[0].shown = form.panel.groups[1].shown = true; form.panel.groups[1].at( 8, 240, 200, 40 ); };
form.elsewhere = new TreeBox( form ).at( 330, 8, 60, 60 );
form.elsewhere.headers = [ "#", "LIGHT", "Filter", "" ];
form.elsewhere.shown = false;
form.other_Button = new PushButton( form ).at( 290, 56, 60, 20 );
form.other_Button.text = "Elsewhere";
form.other_Button.onClick = function() { form.panel.groups[0].shown = form.panel.groups[1].shown = false; form.elsewhere.shown = true; };
form.long = new TreeBox( form ).at( 330, 130, 60, 40 );
form.long.headers = [ "Long" ];
for ( var n = 0; n < 450; n++ ) form.long.add( "line " + n );
( function() {
   // A preview as scripts have it: drawn on the area of a scroll box, which the script keeps nowhere by itself.
   var scroll = new ScrollBox( form ).at( 220, 180, 100, 50 );
   scroll.viewport.onPaint = function() {};
   scroll.viewport.onMousePress = function( x, y ) { log.push( "preview:" + x + "," + y ); };
   // A button that its panel cuts off, as one that is scrolled out of sight is.
   var clip = new Control( form ).at( 330, 180, 60, 20 );
   var cut = new PushButton( clip ).at( 0, 30, 60, 20 );
   cut.text = "Out of sight";
   cut.onClick = function() { log.push( "cut" ); };
   form.extras = new Sizer;
   form.extras.add( scroll );
   form.extras.add( clip );
   clip.sizer = new Sizer;
   clip.sizer.add( cut );
} )();
( function() {
   var local = new TreeBox( form ).at( 220, 80, 100, 40 );
   local.headers = [ "Kept nowhere" ];
   var loose = new TreeBox( form ).at( 220, 130, 100, 40 );
   loose.headers = [ "Neither kept nor laid out" ];
   var pages = new TabBox( form ).at( 330, 80, 60, 40 );
   var page = new Control( pages ).at( 0, 0, 60, 40 );
   var onPage = new CheckBox( page ).at( 2, 2, 50, 16 );
   onPage.text = "On a page";
   form.sizer = new Sizer;
   form.sizer.add( pages );
   form.sizer.insert( 0, local );
   pages.addPage( page, "Page" );
   page.sizer = new Sizer;
   page.sizer.add( onPage );
} )();
`;
    const fieldsOf = (reply: Reply): Array<Record<string, any>> => (reply.result?.['fields'] ?? []) as Array<Record<string, any>>;
    const table = (reply: Reply, heading: string) => fieldsOf(reply).find((field) => field['columns']?.includes(heading));
    const look = { act: 'describe', help: false };
    /** Runs the form while `plan` plays the server: it hands out one command after the other and gets each reply. */
    const drive = (plan: () => Generator<Record<string, unknown>, void, Reply>): string[] => {
      env.install();
      env.script(TABLES);
      const running = plan();
      let next = running.next();
      let id = 0;
      env.steps = [
        () => {
          for (;;) {
            if (next.done) return true;
            if (!id) {
              if (!env.state()?.dialog || env.state()?.question) return false;
              id = env.post(next.value);
              return false;
            }
            const reply = env.reply(id);
            if (!reply) return false;
            id = 0;
            next = running.next(reply);
          }
        },
        close,
      ];
      env.script('form.execute()');
      while (env.steps.length && env.steps[0]!()) env.steps.shift();
      expect(env.steps, 'steps that never came to pass').toHaveLength(0);
      return env.script<string[]>('log');
    };

    it('finds a table that the script keeps on an object of its own, where no place in the dialog names it', () => {
      drive(function* () {
        const first = yield look;
        // A row comes with the number it is selected by, and a last column that only fills the width is left out.
        expect(table(first, 'LIGHT')).toMatchObject({
          type: 'TreeBox',
          columns: ['#', 'LIGHT', 'Filter'],
          rows: [{ row: 0, cells: ['1', '10 frames', 'H'] }, { row: 1, cells: ['2', '42 frames', 'L'] }],
          value: null,
        });
        // A table that the script keeps nowhere is found by how it is laid out, also on a page of a tab box.
        expect(table(first, 'Kept nowhere')).toMatchObject({ type: 'TreeBox' });
        expect(fieldsOf(first).find((field) => field['text'] === 'On a page')).toMatchObject({ type: 'CheckBox' });
        // Only V8 lets the hook see what a script makes. On the older engine a table that is neither kept nor laid out with a sizer stays unseen.
        expect(Boolean(table(first, 'Neither kept nor laid out'))).toBe(engine === 'v8');
        // Two tables lie in that place, and the one that is hidden is no field.
        expect(fieldsOf(first).filter((field) => field['columns']?.includes('LIGHT'))).toHaveLength(1);
      });
    });

    it('selects a row by its number, shows which one that was, and keeps the name of a table that the script swaps for its twin', () => {
      const log = drive(function* () {
        const first = yield look;
        const id = table(first, 'LIGHT')!['id'] as string;
        expect((yield { act: 'set', field: id, value: 1 }).ok).toBe(true);
        // The table counts from 1 in a column of its own. The number of a row counts from 0, and the row is shown.
        expect(table(yield look, 'LIGHT')).toMatchObject({ id, value: 1, selected: ['2', '42 frames', 'L'] });
        expect((yield { act: 'press', field: fieldsOf(first).find((field) => field['text'] === 'Redraw')!['id'] }).ok).toBe(true);
        const redrawn = table(yield look, 'LIGHT')!;
        expect(redrawn).toMatchObject({ id, value: null });
        expect((yield { act: 'set', field: id, value: 0 }).ok).toBe(true);
        expect(env.script('[ form.panel.groups[0].currentNode, form.panel.groups[1].currentNode.text( 1 ) ]')).toEqual([expect.anything(), '10 frames']);
        // Another table in the same place is another field.
        expect((yield { act: 'press', field: fieldsOf(first).find((field) => field['text'] === 'Flats')!['id'] }).ok).toBe(true);
        const flats = table(yield look, 'FLAT')!;
        expect(flats['id']).not.toBe(id);
        expect(yield { act: 'set', field: id, value: 0 }).toMatchObject({ ok: false, error: { kind: 'unknown_field' } });
        expect(yield { act: 'set', field: flats['id'], value: 0 }).toMatchObject({ ok: false, error: { kind: 'invalid_value', message: expect.stringMatching(/has no rows/) } });
      });
      expect(log).toEqual(['group:42 frames', 'group:10 frames']);
      expect(env.consoleLines).toContain('MCP: selected row 1 of a table (2, 42 frames, L)');
    });

    it('gives two tables that took turns under one name a name each once both show, and no name to a table elsewhere', () => {
      drive(function* () {
        const first = yield look;
        const id = table(first, 'LIGHT')!['id'] as string;
        const button = (text: string) => fieldsOf(first).find((field) => field['text'] === text)!['id'] as string;
        yield { act: 'press', field: button('Redraw') };
        expect(table(yield look, 'LIGHT')).toMatchObject({ id });
        // Now the script shows both at once. Before the dialog is read again, the name stands for two fields.
        yield { act: 'press', field: button('Both') };
        expect(yield { act: 'set', field: id, value: 0 }).toMatchObject({ ok: false, error: { kind: 'unknown_field', message: expect.stringMatching(/stands for two fields now/) } });
        const both = fieldsOf(yield look).filter((field) => field['columns']?.includes('LIGHT'));
        expect(both).toHaveLength(2);
        expect(new Set(both.map((field) => field['id'])).size).toBe(2);
        expect(both.map((field) => field['id'])).toContain(id);
        expect((yield { act: 'set', field: both[0]!['id'], value: 0 }).ok).toBe(true);
        expect((yield { act: 'set', field: both[1]!['id'], value: 1 }).ok).toBe(true);
        // A table with the same columns in another place is another field, also while those two are hidden.
        yield { act: 'press', field: button('Elsewhere') };
        const elsewhere = table(yield look, 'LIGHT')!;
        expect(both.map((field) => field['id'])).not.toContain(elsewhere['id']);
      });
    });

    it('finds the area a scroll box shows, which a script draws its preview on, and clicks only what a user could reach', () => {
      const log = drive(function* () {
        const first = yield { ...look, help: false };
        const preview = fieldsOf(first).find((field) => field['drawn'] && field['clicks'] && field['at'][0] === 220 && field['at'][1] === 180);
        expect(preview).toMatchObject({ type: 'Control', drawn: true, clicks: true });
        expect(yield { act: 'click', x: 230, y: 190 }).toMatchObject({ ok: true, result: { fired: ['onMousePress'] } });
        // The button lies below what its panel shows. A click where it would be reaches nothing.
        expect(fieldsOf(first).find((field) => field['text'] === 'Out of sight')).toMatchObject({ at: [330, 210, 60, 20] });
        expect(yield { act: 'click', x: 340, y: 215 }).toMatchObject({ ok: false, error: { kind: 'no_effect' } });
      });
      expect(log).toEqual(['preview:10,10']);
    });

    it('reads a table of any length in parts, and says where it ends', () => {
      drive(function* () {
        const long = table(yield look, 'Long')!;
        expect(long['rows']).toHaveLength(60);
        expect(long).toMatchObject({ moreRows: 390 });
        const read = function* (from: number): Generator<Record<string, unknown>, Record<string, any>, Reply> {
          return (yield { ...look, dialog: env.state()?.dialog, field: long['id'], from }).result!['field'] as Record<string, any>;
        };
        const start = yield* read(0);
        expect(start['rows']).toHaveLength(200);
        expect(start).toMatchObject({ totalRows: 450, moreRows: 250 });
        const end = yield* read(400);
        expect(end['rows']).toHaveLength(50);
        expect(end['rows'][49]).toEqual({ row: 449, cells: ['line 449'] });
        expect(end).toMatchObject({ totalRows: 450, from: 400 });
        expect(end['moreRows']).toBeUndefined();
        // Beyond the end there are no rows, and nothing says that more would follow.
        const beyond = yield* read(900);
        expect(beyond).toMatchObject({ rows: [], totalRows: 450, from: 900 });
        expect(beyond['moreRows']).toBeUndefined();
        expect((yield { act: 'set', field: long['id'], value: 449 }).ok).toBe(true);
        expect(table(yield look, 'Long')).toMatchObject({ value: 449, selected: ['line 449'] });
      });
    });

    it('lists the rows inside rows as deep as they fit, and reads a table in full when it is asked for by itself', () => {
      const log = drive(function* () {
        const files = table(yield look, 'Light frames')!;
        // The hidden column is none. The 73 file rows do not fit, so the rows above them say how many they hold.
        expect(files).toMatchObject({ columns: ['Light frames', 'Time'], moreRows: 73, value: null });
        expect(files['rows']).toEqual([
          { row: 0, cells: ['Binning 1', ''] },
          { row: 1, level: 1, cells: ['H', ''] },
          { row: 2, level: 2, cells: ['SESSION: 1 (2 frames)', ''], inside: 2 },
          { row: 5, level: 2, cells: ['SESSION: 2 (1 frame)', ''], inside: 1 },
          { row: 7, level: 1, cells: ['O', ''] },
          { row: 8, level: 2, cells: ['SESSION: 1 (70 frames)', ''], inside: 70 },
        ]);
        const all = (yield { ...look, dialog: env.state()?.dialog, field: files['id'], from: 3 }).result!;
        expect(all).toMatchObject({ title: 'Tables', field: { id: files['id'], type: 'TreeBox', totalRows: 79, from: 3 } });
        const rows = (all['field'] as Record<string, any>)['rows'] as Array<Record<string, any>>;
        expect(rows).toHaveLength(76);
        expect(rows.slice(0, 3)).toEqual([
          { row: 3, level: 3, cells: ['a.fits', '21:00'] },
          { row: 4, level: 3, cells: ['b.fits', '21:05'] },
          { row: 5, level: 2, cells: ['SESSION: 2 (1 frame)', ''] },
        ]);
        expect((all['field'] as Record<string, any>)['moreRows']).toBeUndefined();
        // A row inside rows that are folded up is opened up and scrolled to, as a user would have to.
        expect((yield { act: 'set', field: files['id'], value: 4 }).ok).toBe(true);
        expect(table(yield look, 'Light frames')).toMatchObject({ value: 4, selected: ['b.fits', '21:05'] });
        expect(env.script('[ form.files.rows[0].expanded, form.files.rows[0].children[0].children[0].expanded, form.files.rows[0].children[1].expanded, form.files.inView.text( 0 ) ]')).toEqual([true, true, false, 'b.fits']);
        expect(yield { act: 'set', field: files['id'], value: 79 }).toMatchObject({ ok: false, error: { kind: 'invalid_value', message: expect.stringMatching(/rows 0 to 78/) } });
      });
      expect(log).toEqual(['file:b.fits']);
      // Nothing the hook calls makes PixInsight warn the user in the console.
      expect(env.consoleLines.join('\n')).not.toMatch(/\*\* Warning/);
    });

    it('says how many columns it left out, and shows them all when the table is read by itself', () => {
      drive(function* () {
        const wide = table(yield look, 'c0')!;
        expect(wide['columns']).toHaveLength(16);
        expect(wide).toMatchObject({ moreColumns: 4 });
        const all = (yield { ...look, dialog: env.state()?.dialog, field: wide['id'], from: 0 }).result!['field'] as Record<string, any>;
        expect(all['columns']).toHaveLength(20);
        expect(all['moreColumns']).toBeUndefined();
      });
    });

    it('reads a long text in parts, and says what a button without a word on it is for', () => {
      drive(function* () {
        const first = yield look;
        const report = fieldsOf(first).find((field) => field['type'] === 'TextBox')!;
        expect(report['value']).toHaveLength(6000);
        expect(report).toMatchObject({ more: 19001 });
        const start = (yield { ...look, dialog: env.state()?.dialog, field: report['id'], from: 0 }).result!['field'] as Record<string, any>;
        expect(start['value']).toHaveLength(20000);
        expect(start).toMatchObject({ more: 5000 });
        expect(start['from']).toBeUndefined();
        const rest = (yield { ...look, dialog: env.state()?.dialog, field: report['id'], from: 20000 }).result!['field'] as Record<string, any>;
        expect(rest).toMatchObject({ from: 20000, value: '0123456789'.repeat(500) });
        expect(rest['more']).toBeUndefined();
        expect(fieldsOf(first).find((field) => field['type'] === 'ToolButton')).toMatchObject({ text: '', help: 'Settings of the registration.' });
        // The name of a field that is not there says so, also for a read.
        expect(yield { ...look, dialog: env.state()?.dialog, field: 'f999', from: 0 }).toMatchObject({ ok: false, error: { kind: 'unknown_field' } });
      });
    });
  });

  describe('with the other kinds of fields', () => {
    const fieldsOf = (reply: Reply | undefined) => (reply?.result?.['fields'] ?? []) as Array<Record<string, any>>;
    const kinds = (steps: (id: (name: string) => string) => Array<() => boolean>): string[] => {
      env.install();
      env.script(KINDS);
      const pending: Array<() => boolean> = [];
      const id = (name: string) => fieldsOf(replies[0]).find((field) => field['text'] === name || field['type'] === name || field['value'] === name)?.['id'] as string;
      env.steps = [
        ...env.ask({ act: 'describe', help: false }, replies),
        () => {
          pending.push(...steps(id));
          return true;
        },
        () => {
          while (pending.length && pending[0]!()) pending.shift();
          return pending.length === 0;
        },
        close,
      ];
      env.script('form.execute()');
      return env.script<string[]>('log');
    };
    const doing = (command: Record<string, unknown>) => env.ask(command, replies);

    it('describes each of them, also those the script keeps in a list, and cuts what is long', () => {
      kinds(() => []);
      const fields = fieldsOf(replies[0]);
      const of = (name: string) => fields.find((field) => field['text'] === name || field['type'] === name);
      expect(of('TabBox')).toMatchObject({ options: ['Target', 'Output'], value: 'Target' });
      // What lies on a page that is not shown is no field, as for the user.
      expect(of('On the second page')).toBeUndefined();
      expect(of('Reject outliers')).toMatchObject({ type: 'GroupBox', value: false });
      expect(of('Slider')).toMatchObject({ value: 0, range: [0, 10] });
      expect(of('Median')).toMatchObject({ type: 'RadioButton', value: false });
      expect(of('Pin')).toMatchObject({ type: 'ToolButton', value: false });
      // The only text box of a dialog shows more than one of several would, and says how much is left.
      expect(of('TextBox')?.['value']).toHaveLength(6000);
      expect(of('TextBox')).toMatchObject({ readOnly: true, more: 1001 });
      // A text that PixInsight shows as it stands is no markup, whatever it looks like.
      expect(fields.find((field) => field['readOnly'] && field['type'] === 'Edit')).toMatchObject({ value: '<computed>' });
      expect(fields.find((field) => field['options']?.includes('<Auto>'))).toMatchObject({ options: ['1', '2', '4', '<Auto>'], value: '1' });
      expect(fields.find((field) => field['editable'])).toMatchObject({ value: 'red', options: ['red'] });
      expect(of('ViewList')).toMatchObject({ value: null });
      expect(fields.find((field) => field['moreOptions'])).toMatchObject({ moreOptions: 10 });
      expect(fields.find((field) => field['moreOptions'])?.['options']).toHaveLength(60);
      expect(of('TreeBox')).toMatchObject({ moreRows: 5 });
      expect(of('TreeBox')?.['rows']).toHaveLength(60);
      expect(of('TreeBox')?.['rows'][59]).toEqual({ row: 59, cells: ['row 59'] });
    });

    it('sets each of them the way its kind is set, and tells the script once', () => {
      const log = kinds((id) => [
        ...doing({ act: 'set', field: id('TabBox'), value: 'output' }),
        ...doing({ act: 'set', field: id('Reject outliers'), value: true }),
        ...doing({ act: 'set', field: id('Slider'), value: 7 }),
        ...doing({ act: 'set', field: id('Median'), value: true }),
        ...doing({ act: 'press', field: id('Pin') }),
        ...doing({ act: 'set', field: id('red'), value: 'deep red' }),
        ...doing({ act: 'set', field: id('red'), value: 'red' }),
        ...doing({ act: 'set', field: id('ViewList'), value: 'Ha' }),
      ]);
      expect(replies.slice(1).map((reply) => reply.error ?? reply.ok)).toEqual(Array.from({ length: 8 }, () => true));
      // The list of images tells the script by itself, so the hook must not tell it again.
      expect(log).toEqual(['page:1', 'group:true', 'slider:7', 'median:true', 'pin:true', 'free:deep red', 'freeItem:0', 'view:Ha']);
      expect(env.script('[ form.tabs.currentPageIndex, form.group.checked, form.slider.value, form.radios[1].checked, form.pin.checked, form.free.editText, form.views.currentView.fullId ]')).toEqual([1, true, 7, true, true, 'deep red', 'Ha']);
    });

    it('takes the text of an option before its number, because an option can be called 2', () => {
      const log = kinds(() => {
        const scale = fieldsOf(replies[0]).find((field) => field['options']?.includes('<Auto>'))!['id'] as string;
        const same = fieldsOf(replies[0]).find((field) => field['options']?.includes('Twin'))!['id'] as string;
        return [
          ...doing({ act: 'set', field: scale, value: 2 }),
          ...doing({ act: 'set', field: scale, value: '4' }),
          ...doing({ act: 'set', field: scale, value: 3 }),
          ...doing({ act: 'set', field: scale, value: '<auto>' }),
          ...doing({ act: 'set', field: same, value: 'Twin' }),
          ...doing({ act: 'set', field: same, value: 1 }),
        ];
      });
      // "2" is the option of that name, at place 1. 3 is no name, so it is a place.
      expect(log).toEqual(['scale:1', 'scale:2', 'scale:3', 'scale:3']);
      expect(replies[5]?.error).toMatchObject({ kind: 'invalid_value', message: expect.stringMatching(/2 options called "Twin"\. Pass the number/) });
      expect(replies[6]?.ok).toBe(true);
      expect(env.script('form.same.currentItem')).toBe(1);
    });

    it('leaves everything as it was where it refuses', () => {
      const log = kinds((id) => [
        ...doing({ act: 'press', field: id('Idle') }),
        ...doing({ act: 'set', field: id('ViewList'), value: 'Sii' }),
        ...doing({ act: 'set', field: id('ViewList'), value: 'Oiii' }),
        ...doing({ act: 'set', field: id('<computed>'), value: 'x' }),
        ...doing({ act: 'set', field: id('TextBox'), value: 'x' }),
        ...doing({ act: 'set', field: id('Slider'), value: 11 }),
      ]);
      expect(replies.slice(1).map((reply) => reply.error?.kind ?? 'ok')).toEqual(['no_effect', 'invalid_value', 'ok', 'not_settable', 'not_settable', 'invalid_value']);
      // The button with nothing to do was not toggled, and the list shows what it showed.
      expect(env.script('[ form.idle.checked, form.views.currentView.fullId, form.fixed.text, form.slider.value ]')).toEqual([false, 'Oiii', '<computed>', 0]);
      expect(log).toEqual(['view:Oiii']);
    });

    it('keeps a field secret for good that hid what is typed, also once the script shows its content', () => {
      const path = join(env.jobDir, 'kinds.png');
      kinds((id) => [
        ...doing({ act: 'set', field: id('Show the key'), value: true }),
        ...doing({ act: 'describe', help: false }),
        ...doing({ act: 'render', path }),
      ]);
      expect(env.script('form.key.passwordMode')).toBe(false);
      const key = fieldsOf(replies[2]).filter((field) => field['secret']);
      expect(key).toHaveLength(1);
      expect(JSON.stringify(replies)).not.toContain('LICENSE-KEY');
      expect(replies[3]?.result).toMatchObject({ covered: 1 });
      expect(readFileSync(path, 'utf8')).toBe('picture of Kinds covered 180,188,280,208');
      expect(replies.at(-1)).toBe(replies[3]);
    });
  });

  it('serves the dialog that was opened last, whichever was made first', () => {
    env.install();
    env.script(FORM);
    // Made before the main dialog, and opened from one of its buttons, as a settings dialog is.
    env.script('var settings = new Dialog; settings.windowTitle = "Settings"; settings.depth_Edit = new Edit( settings ).at( 8, 8, 100, 20 );');
    env.script('var main = new Dialog; main.windowTitle = "Main"; main.open_Button = new PushButton( main ).at( 8, 8, 100, 20 ); main.open_Button.text = "Settings"; main.open_Button.onClick = function() { log.push( "settings:" + settings.execute() ); };');
    const inner: Reply[] = [];
    let pressed = 0;
    env.steps = [
      ...env.ask({ act: 'describe', help: false }, replies),
      () => {
        pressed = env.post({ act: 'press', field: (replies[0]?.result?.['fields'] as Array<{ id: string }>)[0]!.id });
        return true;
      },
      () => env.state()?.title === 'Settings',
      ...env.ask({ act: 'describe', help: false }, inner),
      ...env.ask({ act: 'close' }, inner),
      () => env.reply(pressed) !== null && env.state()?.title === 'Main',
      () => {
        env.script('main.done( 1 )');
        return true;
      },
    ];
    env.script('main.execute()');
    expect(replies[0]?.result).toMatchObject({ title: 'Main' });
    expect(inner[0]?.result).toMatchObject({ title: 'Settings', fields: [{ type: 'Edit' }] });
    expect(env.script('log')).toEqual(['settings:0']);
  });

  if (engine === 'v8') {
    it('gets hold of a dialog that is a class of the script, as every script for V8 writes it', () => {
      env.install();
      env.steps = [...env.ask({ act: 'describe', help: false }, replies), ...env.ask({ act: 'close' }, replies)];
      env.script('class Mine extends Dialog { constructor() { super(); this.windowTitle = "A class"; this.name_Edit = new Edit( this ).at( 8, 8, 100, 20 ); } } ( new Mine ).execute();');
      expect(replies[0]?.result).toMatchObject({ title: 'A class', fields: [{ type: 'Edit' }] });
      // The method of the dialog is where PixInsight put it, and what it was.
      expect(Object.getOwnPropertyDescriptor(env.made[0], 'execute')).toMatchObject({ value: Dialog.prototype.execute, writable: false });
    });

    it('answers a file chooser with the path the server gives, as if the user had picked it', () => {
      let pressed = 0;
      const log = run([
        ...env.ask({ act: 'describe', help: false }, replies),
        () => {
          pressed = env.post({ act: 'press', field: described().id('Pick') });
          return true;
        },
        () => env.state()?.question !== null,
        () => {
          expect(env.state()?.question).toEqual({ id: 1, kind: 'open_file', caption: 'Pick a file' });
          env.answer(1, '/data/master.xisf');
          return true;
        },
        () => env.reply(pressed) !== null,
        close,
      ]);
      // The script still reached what the stand-in does not answer itself.
      expect(log).toEqual(['file:/data/master.xisf:1']);
      expect(env.nativeWindows).toEqual([]);
    });

    it('cancels a file chooser, or hands it to the user who wants to browse', () => {
      const pick = (how: (fresh: Env) => void, code = 'var c = new SaveFileDialog; c.caption = "Save as"; [ c.execute(), c.fileName ]') => {
        const fresh = new Env('v8');
        fresh.install();
        fresh.steps = [
          () => fresh.state()?.question !== null && fresh.made.at(-1)!.visible,
          () => {
            how(fresh);
            return true;
          },
        ];
        const result = fresh.script<[boolean, string]>(code);
        const windows = [...fresh.nativeWindows];
        const question = fresh.state()?.question;
        fresh.dispose();
        return { result, windows, question };
      };
      const buttonOf = (fresh: Env, text: string) => fresh.made.at(-1)!.children.find((child) => child instanceof PushButton && child.text === text) as PushButton;
      expect(pick((fresh) => fresh.answer(1, false)).result).toEqual([false, '']);
      expect(pick((fresh) => (buttonOf(fresh, 'Cancel')['onClick'] as () => void)()).result).toEqual([false, '']);
      expect(pick((fresh) => fresh.answer(1, '/out/result.xisf')).result).toEqual([true, '/out/result.xisf']);
      const browsed = pick((fresh) => (buttonOf(fresh, 'Browse…')['onClick'] as () => void)());
      expect(browsed).toMatchObject({ result: [true, '/picked/by/the/user.xisf'], windows: ['chooser: Save as'] });
      const several = pick((fresh) => fresh.answer(1, ['/a.xisf', '/b.xisf']), 'var c = new OpenFileDialog; c.multipleSelections = true; [ c.execute(), c.fileNames.join( "+" ) ]');
      expect(several.result).toEqual([true, '/a.xisf+/b.xisf']);
      const folder = pick((fresh) => fresh.answer(1, '/out'), 'var c = new GetDirectoryDialog; [ c.execute(), c.directory ]');
      expect(folder.result).toEqual([true, '/out']);
    });
  } else {
    it('replaces no constructor, which this engine does not survive, whatever an earlier script left in its scope', () => {
      // A script before this one made the scope look like that of V8.
      env.script('var globalThis = this;');
      const before = env.script<unknown[]>('[ Dialog, MessageBox, OpenFileDialog, SaveFileDialog, GetDirectoryDialog ]');
      run([...env.ask({ act: 'describe', help: false }, replies), close]);
      expect(replies[0]?.ok).toBe(true);
      expect(env.script<unknown[]>('[ Dialog, MessageBox, OpenFileDialog, SaveFileDialog, GetDirectoryDialog ]')).toEqual(before);
      expect(before).toEqual([Dialog, MessageBox, OpenFileDialog, expect.any(Function), expect.any(Function)]);
      expect(env.script('typeof __mcpUnhookDialogs')).toBe('function');
    });

    it('closes a dialog again that was closed in the moment before its wait began', () => {
      env.unluckyTick = true;
      env.install();
      env.script(FORM);
      // Sent so early that it is taken in the first tick in which the dialog may be worked.
      env.steps = [() => env.state()?.dialog === 'd1.1', () => env.post({ act: 'close' }) > 0];
      expect(env.script('form.execute()')).toBe(0);
    });

    it('leaves the file choosers of PixInsight what they are, because a path cannot be handed to them', () => {
      const log = run([...env.ask({ act: 'describe', help: false }, replies), ...press('Pick'), close]);
      expect(log).toEqual(['file:/picked/by/the/user.xisf:1']);
      expect(env.nativeWindows).toEqual(['chooser: Pick a file']);
    });

    it('puts back what it changed, because this engine keeps its scope for the scripts that follow', () => {
      const execute = Dialog.prototype.execute;
      const ask = MessageBox.prototype.execute;
      const layout = [Sizer.prototype.add, Sizer.prototype.insert, TabBox.prototype.addPage];
      run([...env.ask({ act: 'describe', help: false }, replies), close]);
      expect(Dialog.prototype.execute).not.toBe(execute);
      expect(MessageBox.prototype.execute).not.toBe(ask);
      // The methods through which it sees what a script lays out.
      expect([Sizer.prototype.add, Sizer.prototype.insert, TabBox.prototype.addPage].filter((method, index) => method === layout[index])).toEqual([]);
      // No timer may still run when the script ends: on this engine that breaks the scripts after it.
      expect(env.timers.filter((timer) => timer.running)).toEqual([]);

      // What the server sends right after the script.
      env.script(readFileSync(resolve('pjsr/dialogs/unhook.js'), 'utf8'));
      expect(Dialog.prototype.execute).toBe(execute);
      expect(MessageBox.prototype.execute).toBe(ask);
      expect([Sizer.prototype.add, Sizer.prototype.insert, TabBox.prototype.addPage]).toEqual(layout);
      expect(env.script('typeof __mcpUnhookDialogs')).toBe('undefined');
      // And once more does no harm.
      env.script(readFileSync(resolve('pjsr/dialogs/unhook.js'), 'utf8'));
    });

    it('puts it back by itself if that clean-up never ran, the first time a script of the user opens a dialog', () => {
      const execute = Dialog.prototype.execute;
      const ask = MessageBox.prototype.execute;
      const add = Sizer.prototype.add;
      run([...env.ask({ act: 'describe', help: false }, replies), close]);
      env.beat(false);
      env.now += 1000;

      // Later, a script the user starts by hand, in the same scope.
      env.steps = [
        () => env.made.at(-1)!.waiting,
        () => {
          env.script('later.done( 1 )');
          return true;
        },
      ];
      expect(env.script('var later = new Dialog; later.execute()')).toBe(1);
      expect(Dialog.prototype.execute).toBe(execute);
      expect(MessageBox.prototype.execute).toBe(ask);
      expect(Sizer.prototype.add).toBe(add);
      expect(existsSync(join(env.jobDir, 'dialog-cmd.json'))).toBe(false);
    });

    it('puts it back as soon as a later script lays out a control, also one that never opens a dialog', () => {
      const execute = Dialog.prototype.execute;
      const layout = [Sizer.prototype.add, Sizer.prototype.insert, TabBox.prototype.addPage];
      run([...env.ask({ act: 'describe', help: false }, replies), close]);
      // The server is gone without a word: its sign of life only grows old.
      env.now += 20_000;
      expect(Sizer.prototype.add).not.toBe(layout[0]);
      expect(env.script('var later = new Sizer; var laterLabel = new Label; later.add( laterLabel ); later.items.length')).toBe(1);
      expect([Sizer.prototype.add, Sizer.prototype.insert, TabBox.prototype.addPage]).toEqual(layout);
      expect(Dialog.prototype.execute).toBe(execute);
      expect(env.script('typeof __mcpUnhookDialogs')).toBe('undefined');
    });

    it('first removes what an earlier hook left in the scope, so that hooks never pile up', () => {
      const execute = Dialog.prototype.execute;
      run([...env.ask({ act: 'describe', help: false }, replies), close]);
      const second: Reply[] = [];
      // A later job, which has a folder of its own.
      env.forgetStates();
      env.install();
      env.steps = [...env.ask({ act: 'describe', help: false }, second), close];
      env.script('form.execute()');
      expect(second[0]?.ok).toBe(true);
      env.script('__mcpUnhookDialogs()');
      expect(Dialog.prototype.execute).toBe(execute);
    });
  }
});
