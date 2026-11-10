import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renameWhenFree, toPixPath } from '../platform.js';

/** PixInsight runs a script on its V8 engine if the script says so, and on its older one otherwise. */
export type ScriptEngine = 'v8' | 'classic';

/** Whether a script's dialogs can be read through the server, and worked. */
export type DialogAccess = 'operate' | 'read' | 'off';

/** Something a script asks in a window of PixInsight's own, which the server shows in its place. */
export interface Question {
  id: number;
  kind: 'message' | 'open_file' | 'save_file' | 'directory';
  text?: string;
  caption?: string;
  icon?: string;
  /** The buttons of a message, by name. */
  buttons?: string[];
  /** A file chooser that takes several files. */
  multiple?: boolean;
  initialPath?: string;
}

/** What the hook inside the script last said about itself. */
export interface DialogState {
  serial: number;
  /**
   * The dialog on top, by the name the hook gave this showing of it, or null while none is open.
   * A dialog that is closed and opened again has another name then.
   */
  dialog: string | null;
  title: string | null;
  question: Question | null;
}

export interface Field {
  id: string;
  type: string;
  [detail: string]: unknown;
}

export interface DialogDescription {
  dialog: string;
  title: string;
  size: [number, number];
  fields: Field[];
  moreFields?: number;
}

/** What is different in a dialog since it was last read, in place of all of it. */
export interface DialogChanges {
  /** Fields that were not there before. */
  added: Field[];
  /** Fields of before, each with what is different about it now. */
  changed: Field[];
  /** The ids of fields that are not there any more. */
  gone: string[];
  unchanged: number;
  /**
   * The ids of fields that count as unchanged and are listed only in part, such as a long table.
   * Only the listed part of them was compared.
   */
  partly: string[];
}

/** The details that say a field holds more than its description lists. */
const LISTED_IN_PART = ['moreRows', 'moreColumns', 'moreOptions', 'more'];

/** What says where a field lies or explains it, which is not part of what it shows. */
const BESIDE_THE_POINT = new Set(['at', 'help']);

/**
 * Compares a dialog with what it showed before. A field that differs comes with its id, its
 * type, its label, and only the details that differ. A detail that is gone comes as null, and
 * `enabled` as true, which is what a field without that detail is.
 */
export function changesIn(before: ReadonlyMap<string, Field>, now: readonly Field[]): DialogChanges {
  const changes: DialogChanges = { added: [], changed: [], gone: [], unchanged: 0, partly: [] };
  const ids = new Set<string>();
  for (const field of now) {
    ids.add(field.id);
    const old = before.get(field.id);
    if (!old) {
      changes.added.push(field);
      continue;
    }
    const delta: Field = { id: field.id, type: field.type, ...(typeof field['text'] === 'string' && field['text'] ? { text: field['text'] } : {}) };
    let differs = false;
    for (const key of new Set([...Object.keys(old), ...Object.keys(field)])) {
      if (BESIDE_THE_POINT.has(key) || JSON.stringify(old[key]) === JSON.stringify(field[key])) continue;
      differs = true;
      delta[key] = key in field ? field[key] : key === 'enabled' ? true : null;
    }
    if (differs) changes.changed.push(delta);
    else {
      changes.unchanged++;
      if (LISTED_IN_PART.some((detail) => detail in field)) changes.partly.push(field.id);
    }
  }
  for (const id of before.keys()) if (!ids.has(id)) changes.gone.push(id);
  return changes;
}

/**
 * What the hook is asked to do. Everything but a look names the dialog it is meant for, and the
 * hook does nothing if another one is on top by the time it takes the command.
 */
export type Command =
  | { act: 'describe'; dialog: null; help: boolean }
  /** One field by itself and in full, from a row of its table or a character of its text on. */
  | { act: 'describe'; dialog: string; help: boolean; field: string; from: number }
  | { act: 'render'; dialog: string; path: string }
  | { act: 'set'; dialog: string; field: string; value: string | number | boolean }
  | { act: 'press'; dialog: string; field: string }
  | { act: 'click'; dialog: string; x: number; y: number }
  | { act: 'close'; dialog: string };

export type Reply = { ok: true; result: Record<string, unknown> } | { ok: false; error: { kind: string; message: string } };

/** The directive counts wherever it stands at the start of a line, in any case, as PixInsight reads it. */
export function engineOf(source: string): ScriptEngine {
  return /^(?:\uFEFF|\u00EF\u00BB\u00BF)?[ \t]*#engine[ \t]+v8\b/im.test(source) ? 'v8' : 'classic';
}

/**
 * The file that is sent to PixInsight in place of a script: the hook, then the script itself,
 * which PixInsight includes from where it is. So the script runs unchanged, with its own path and
 * its own includes, in one scope with the hook.
 *
 * @param hook The source of `pjsr/dialogs/hook.js`, a function expression.
 */
export function wrapperFor(hook: string, jobDir: string, scriptPath: string, engine: ScriptEngine, access: 'operate' | 'read'): string {
  return [
    ...(engine === 'v8' ? ['#engine v8'] : []),
    `( ${hook.trimEnd()} )( ${JSON.stringify(toPixPath(jobDir))}, ${access === 'operate'}, ${engine === 'v8'} );`,
    `#include "${toPixPath(scriptPath)}"`,
    '',
  ].join('\n');
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(value));
  await renameWhenFree(`${path}.tmp`, path);
}

/**
 * The files through which the server talks to the hook inside a running script, in the folder of
 * the job. The hook reads a command while a dialog is open, and writes a reply with the same
 * number. What it says by itself, such as a question of the script, it puts into state files.
 */
export class DialogFiles {
  private nextId = 1;
  private last: DialogState | null = null;

  constructor(readonly dir: string) {}

  /** What the hook last said, or null if it has said nothing yet. */
  async state(): Promise<DialogState | null> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const serials = names.flatMap((name) => /^dialog-state-(\d+)\.json$/.exec(name)?.[1] ?? []).map(Number);
    // The newest first: the hook removes the one before as soon as the next is written.
    for (const serial of serials.sort((a, b) => b - a)) {
      const state = await readJson<DialogState>(join(this.dir, `dialog-state-${serial}.json`));
      if (state) {
        this.last = state;
        break;
      }
    }
    return this.last;
  }

  /** Leaves a command for the hook, in place of one it has not taken yet. Returns its number. */
  async post(command: Command): Promise<number> {
    const id = this.nextId++;
    await writeAtomic(join(this.dir, 'dialog-cmd.json'), { ...command, id });
    return id;
  }

  /** The reply to a command, once it is there. */
  async reply(id: number): Promise<Reply | undefined> {
    const path = join(this.dir, `dialog-reply-${id}.json`);
    const reply = await readJson<Reply>(path);
    if (reply) await rm(path, { force: true }).catch(() => undefined);
    return reply;
  }

  /**
   * Takes a command back. The hook takes a command by removing its file, so whoever removes the
   * file has it.
   *
   * @returns Whether the command was still there, which means that it was not carried out and
   *   will not be.
   */
  async withdraw(id: number): Promise<boolean> {
    const path = join(this.dir, 'dialog-cmd.json');
    if ((await readJson<{ id: number }>(path))?.id !== id) return false;
    return rm(path).then(
      () => true,
      () => false,
    );
  }

  async answer(question: Question, value: string | string[] | false): Promise<void> {
    await writeAtomic(join(this.dir, `dialog-answer-${question.id}.json`), { value });
  }
}
