import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';

const PJSR = resolve('pjsr');
const read = (path: string) => readFileSync(join(PJSR, path), 'utf8');
/** `#engine v8` only means something to PixInsight. */
const withoutDirective = (source: string) => source.replace(/^#engine v8$/m, '');

// A syntax error in these files only shows once PixInsight runs them, which unit tests never do.
describe('PJSR sources', () => {
  it.each(['runner.js', 'ready.js', 'close_all.js', 'begin_log.js', 'end_log.js', 'lib.js'])('%s parses', (file) => {
    expect(() => new Script(withoutDirective(read(file)))).not.toThrow();
  });

  it.each(readdirSync(join(PJSR, 'ops')))('ops/%s parses as the runner wraps it', (file) => {
    expect(() => new Script(`(function( args, ctx ){\n${read(join('ops', file))}\n})`)).not.toThrow();
  });

  it('uses its helpers only where a failure cannot keep the runner from writing a result', () => {
    const runner = read('runner.js');
    const helpers = [...read('lib.js').matchAll(/^ {3}ctx\.(\w+) = /gm)].map((match) => match[1] as string);
    expect(helpers.length).toBeGreaterThan(15);
    const used = helpers.filter((name) => new RegExp(`\\bctx\\.${name}\\b`).test(runner));
    expect(used).toEqual(['imageStates']);
    expect(runner).toMatch(/try\s*\{[^}]*ctx\.imageStates\(\)[^}]*\}\s*catch/);
  });

  it('marks its start first and then refuses a job the server no longer waits for, before it does anything', () => {
    const runner = read('runner.js');
    const started = runner.indexOf('writeAtomic( "started.json"');
    const refusal = runner.indexOf('if ( !isAwaited() )');
    expect(started).toBeGreaterThan(0);
    expect(refusal).toBeGreaterThan(started);
    expect(refusal).toBeLessThan(runner.indexOf('console.beginLog'));
    expect(refusal).toBeLessThan(runner.indexOf('job.json'));
  });

  it('runs only on the V8 engine, and includes nothing of PixInsight', () => {
    for (const file of ['runner.js', 'ready.js', 'close_all.js', 'begin_log.js', 'end_log.js']) expect(read(file), file).toMatch(/^#engine v8$/m);
    const sources = [...readdirSync(PJSR).filter((name) => name.endsWith('.js')), ...['ops', 'dialogs'].flatMap((folder) => readdirSync(join(PJSR, folder)).map((name) => join(folder, name)))];
    for (const file of sources) expect(read(file), file).not.toMatch(/^\s*#include/m);
    // Every file is either listed above as running on V8, the library of the runner, an operation, or one of the two that run with a script.
    expect(readdirSync(PJSR).sort()).toEqual(['begin_log.js', 'close_all.js', 'dialogs', 'end_log.js', 'lib.js', 'ops', 'ready.js', 'runner.js']);
    expect(readdirSync(join(PJSR, 'dialogs')).sort()).toEqual(['hook.js', 'unhook.js']);
  });

  // The files in dialogs/ are not for V8 alone: they run inside a script of the user, on the engine of that script.
  describe('what runs with a script of the Script menu', () => {
    const hook = read('dialogs/hook.js');
    const code = hook.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

    it('is one function, which the server calls in a file that then includes the script', () => {
      expect(() => new Script(`( ${hook} )( "/jobs/1", true, false );`)).not.toThrow();
      expect(code.trimStart().startsWith('function( jobDir, operate, v8 )')).toBe(true);
      // It is told its engine. The scope cannot say: on the older engine an earlier script can have left anything in it.
      expect(code).not.toMatch(/typeof globalThis/);
    });

    it('has no line that the preprocessor of PixInsight would take for one of its own', () => {
      expect(hook).not.toMatch(/^\s*#/m);
      expect(read('dialogs/unhook.js')).not.toMatch(/^\s*#/m);
    });

    it('is written in the JavaScript of the older engine, which runs most scripts', () => {
      for (const newer of [/=>/, /\b(const|let|class|async|await|of)\b/, /`/, /\.\.\./, /\?\?|\?\./]) expect(code, String(newer)).not.toMatch(newer);
      // On V8, what only that engine has is used behind a check for it.
      expect(hook.indexOf('new Proxy(')).toBeGreaterThan(hook.indexOf('if ( v8 )'));
    });

    it('reads no property that may be missing in a way the older engine warns about in the console', () => {
      // A comparison with true, false or a value reads the property. Only typeof, in and a plain condition ask first.
      expect(code).not.toMatch(/\b(command|error)\.\w+ (===|!==) (true|false|undefined)/);
      expect(code).not.toMatch(/\b(classes|baseNames)\[[^\]]+\] (&&|===)/);
    });

    it('cleans up after the older engine with a script that says nothing about its engine, so that it runs there', () => {
      const unhook = read('dialogs/unhook.js');
      expect(unhook).not.toMatch(/#engine/);
      expect(() => new Script(unhook)).not.toThrow();
      expect(hook).toContain('root.__mcpUnhookDialogs = unhook;');
      expect(unhook).toContain('__mcpUnhookDialogs();');
    });
  });

  it('has an operation for every name the server sends', () => {
    const sent = [...readFileSync(resolve('src/tools.ts'), 'utf8').matchAll(/submitAndWait\(session, ctx, '(\w+)'/g)].map((match) => match[1] as string);
    expect(sent.length).toBeGreaterThan(10);
    for (const op of [...sent, 'ping', 'list_processes', 'describe_process', 'run_process', 'check_enum', 'prepare_script', 'start_script', 'run_code']) {
      expect(readdirSync(join(PJSR, 'ops')), op).toContain(`${op}.js`);
    }
  });
});

// The parts of the scripts that are plain logic, run here with stand-ins for what PixInsight provides.
describe('what a script or code changed', () => {
  type Details = { view: string; historyIndex: number; width: number; height: number; channels: number; astrometry: boolean; previews: number; metadata: string; fingerprint: string };
  type Ctx = Record<string, any>;

  const image = (view: string, overrides: Partial<Details> = {}): Details => ({ view, historyIndex: 3, width: 64, height: 32, channels: 1, astrometry: false, previews: 0, metadata: '[]', fingerprint: '0.1,0.2', ...overrides });

  /** The helpers of lib.js, with the images given instead of read from PixInsight. */
  const helpers = (now: Details[]): Ctx => {
    const ctx: Ctx = {
      fail: (kind: string, message: string) => {
        throw Object.assign(new Error(message), { kind });
      },
      toJson: (value: unknown) => JSON.stringify(value, (_key, each) => (typeof each === 'bigint' ? each.toString() : each)),
    };
    (new Script(read('lib.js')).runInNewContext({}) as (ctx: Ctx) => void)(ctx);
    ctx['imageDetails'] = () => now;
    return ctx;
  };
  const changes = (before: Details[], now: Details[]) => helpers(now)['changesSince'](before) as { newViews: string[]; closedViews: string[]; changedViews: Array<Record<string, unknown>> };

  it('names new and closed images, and says nothing about one that is as it was', () => {
    expect(changes([image('a'), image('gone')], [image('a'), image('made')])).toEqual({ newViews: ['made'], closedViews: ['gone'], changedViews: [] });
  });

  it('counts the steps a script added to the history, so that they can be taken back', () => {
    const [change] = changes([image('a')], [image('a', { historyIndex: 5, fingerprint: '0.3,0.4' })]).changedViews;
    expect(change).toEqual({ view: 'a', changed: ['history'], historyIndex: 5, steps: 2 });
  });

  it('says what else is different: size, plate solution, previews, and metadata alone', () => {
    const now = image('a', { width: 32, astrometry: true, previews: 2, metadata: '[["RA","1"]]' });
    expect(changes([image('a')], [now]).changedViews).toEqual([{ view: 'a', changed: ['geometry', 'astrometry', 'previews', 'metadata'], historyIndex: 3, steps: 0 }]);
    // Solving an image that was solved before changes nothing but values.
    expect(changes([image('a', { astrometry: true })], [image('a', { astrometry: true, metadata: '[["RA","2"]]' })]).changedViews[0]?.['changed']).toEqual(['metadata']);
  });

  it('points out pixels that differ at the same place in the history, which undo usually cannot take back', () => {
    const [change] = changes([image('a')], [image('a', { fingerprint: '0.9,0.9' })]).changedViews;
    expect(change).toMatchObject({ view: 'a', changed: ['pixels'], steps: 0, note: expect.stringMatching(/no step in the history/) });
  });

  it('does not take a sample that is no number for a change', () => {
    expect(changes([image('a', { fingerprint: 'NaN,0.2' })], [image('a', { fingerprint: 'NaN,0.2' })]).changedViews).toEqual([]);
  });

  describe('for code of the assistant', () => {
    const runCode = (code: string, before: Details[] = [image('a')], now: Details[] = before) => {
      const ctx = helpers(before);
      let calls = 0;
      // The first look is the one before the code runs.
      ctx['imageDetails'] = () => (calls++ === 0 ? before : now);
      const op = new Script(`(function( args, ctx ){\n${read(join('ops', 'run_code.js'))}\n})`).runInNewContext({}) as (args: object, ctx: Ctx) => unknown;
      try {
        return { value: op({ code }, ctx) as Record<string, unknown> };
      } catch (error) {
        return { error: { kind: (error as { kind?: string }).kind, message: (error as Error).message } };
      }
    };

    it('returns the value with what changed', () => {
      expect(runCode('return 1 + 2;', [image('a')], [image('a'), image('b')]).value).toEqual({ value: 3, newViews: ['b'], closedViews: [], changedViews: [] });
      expect(runCode('const unused = 1;').value).toMatchObject({ value: null });
      expect(runCode('return 10n;').value).toMatchObject({ value: 10n });
    });

    it('explains code that does not compile', () => {
      expect(runCode('const a = ;').error).toMatchObject({ kind: 'code_error', message: expect.stringMatching(/^The code does not compile: /) });
    });

    it('does not let an error hide what the code did before it', () => {
      const failed = runCode('throw new Error( "no such view" );', [image('a')], [image('a', { historyIndex: 4 }), image('made')]);
      expect(failed.error?.kind).toBe('code_error');
      expect(failed.error?.message).toMatch(/The code threw.*: no such view Before that, the code left behind: new images made; changed images a\./);
    });

    it.each([
      ['null', 'throw null;', /The code threw: null$/],
      ['undefined', 'throw undefined;', /The code threw: undefined$/],
      ['a text', 'throw "plain";', /The code threw: plain$/],
    ])('copes with code that throws %s', (_name, code, message) => {
      expect(runCode(code).error).toMatchObject({ kind: 'code_error', message: expect.stringMatching(message) });
    });

    it('reports an abort by the user as that, with what was done until then', () => {
      const aborted = runCode('throw new Error( "Process aborted" );', [image('a')], [image('a', { historyIndex: 4 })]);
      expect(aborted.error).toEqual({ kind: 'aborted', message: 'The code was aborted in PixInsight. Before that, the code left behind: changed images a.' });
    });

    it.each([
      ['a promise', 'return Promise.resolve( 1 );', /promise/],
      ['a function', 'return function() {};', /returned a function/],
      ['a symbol', 'return Symbol( "x" );', /returned a symbol/],
      ['something circular', 'const a = {}; a.self = a; return a;', /cannot be turned into JSON/],
      ['more than fits', 'return "x".repeat( 70000 );', /70002 characters/],
    ])('refuses %s as a result', (_name, code, message) => {
      expect(runCode(code).error).toMatchObject({ kind: 'code_error', message: expect.stringMatching(message) });
    });

    it('still reports the error if the look at the images fails afterwards', () => {
      const ctx = helpers([image('a')]);
      let calls = 0;
      ctx['imageDetails'] = () => {
        if (calls++ > 0) throw new Error('PixInsight is gone');
        return [image('a')];
      };
      const op = new Script(`(function( args, ctx ){\n${read(join('ops', 'run_code.js'))}\n})`).runInNewContext({}) as (args: object, ctx: Ctx) => unknown;
      expect(() => op({ code: 'throw new Error( "first" );' }, ctx)).toThrow(/The code threw.*: first What the code changed before that could not be determined\./);
    });
  });
});
