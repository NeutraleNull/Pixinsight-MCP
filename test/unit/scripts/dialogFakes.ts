import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { createContext, runInContext, type Context } from 'node:vm';

/**
 * Stand-ins for what PixInsight gives a script, as far as `pjsr/dialogs/hook.js` uses it, so that the
 * logic of the hook runs in a unit test. A dialog that is executed keeps taking steps until it is
 * closed, the way PixInsight keeps handling events: in each step the test plays the server, then
 * every timer fires once. Whether the real PixInsight behaves like this is what the live tests check.
 */
export class Point {
  constructor(
    readonly x: number,
    readonly y: number,
  ) {}
}

export class Control {
  parent: Control | null = null;
  children: Control[] = [];
  shown = true;
  enabled = true;
  toolTip = '';
  /** Relative to the parent. */
  place = { x: 0, y: 0, w: 100, h: 20 };
  /** Made of parts that PixInsight has no object for, as a table and a text box are. */
  opaque = false;
  [handlerOrMember: string]: unknown;

  constructor(parent?: Control) {
    if (parent) {
      this.parent = parent;
      parent.children.push(this);
    }
  }

  at(x: number, y: number, w: number, h: number): this {
    this.place = { x, y, w, h };
    return this;
  }

  get visible(): boolean {
    return this.shown && (this.parent ? this.parent.visible : true);
  }

  get width(): number {
    return this.place.w;
  }

  get height(): number {
    return this.place.h;
  }

  get dialog(): Control | null {
    let control: Control | null = this;
    while (control && !(control instanceof Dialog)) control = control.parent;
    return control;
  }

  localToGlobal(point: Point): Point {
    let { x, y } = point;
    for (let control: Control | null = this; control; control = control.parent) {
      x += control.place.x;
      y += control.place.y;
    }
    return new Point(x, y);
  }

  /**
   * The direct child at a point, as the least a real control can answer. Like the real one, it
   * names nothing where a table or a text box lies: what is there is a part of the field that
   * PixInsight has no object for. And on the older engine it must not be asked at all: the real
   * PixInsight went down over such a question.
   */
  childByPos(x: number, y: number): Control | null {
    if (Dialog.env.engine !== 'v8') throw new Error('childByPos was called on the older engine, where it can take PixInsight down');
    for (const child of [...this.children].reverse()) {
      const { x: left, y: top, w, h } = child.place;
      if (child.shown && x >= left && y >= top && x < left + w && y < top + h) return child.opaque ? null : child;
    }
    return null;
  }

  setScaledMinWidth(): void {}
  adjustToContents(): void {}
}

export class Dialog extends Control {
  static env: Env;
  windowTitle = '';
  sizer: unknown = null;
  result = 0;
  /** In its wait for the window to be closed, which begins a moment after the window is there. */
  waiting = false;
  private ended = false;
  /** How often PixInsight's own way of running this dialog was used. */
  executed = 0;

  constructor(parent?: Control) {
    super(parent);
    this.shown = false;
    this.place = { x: 0, y: 0, w: 300, h: 200 };
    Dialog.env.made.push(this);
    // On V8 a dialog has this method on itself, where nothing can replace it.
    if (Dialog.env.engine === 'v8') Object.defineProperty(this, 'execute', { value: Dialog.prototype.execute, writable: false, configurable: false, enumerable: true });
  }

  /**
   * Like the real one, as far as it was measured: a timer that was started before fires once
   * before the window is there. With `unluckyTick` it fires once more while the window is there
   * and its wait has not begun, which is how a close can leave a window hidden and waiting.
   */
  execute(): number {
    this.executed++;
    this.shown = false;
    this.waiting = false;
    this.ended = false;
    Dialog.env.step();
    this.shown = true;
    if (Dialog.env.unluckyTick) Dialog.env.step();
    this.waiting = true;
    for (let steps = 0; !this.ended; steps++) {
      if (steps > 600) throw new Error(`The dialog "${this.windowTitle}" was never closed`);
      Dialog.env.step();
    }
    this.shown = false;
    this.waiting = false;
    return this.result;
  }

  /** Closing hides the window, and hiding a window that waits ends its wait. A hidden one stays as it is. */
  done(code: number): void {
    this.result = code;
    if (this.shown && this.waiting) this.ended = true;
    this.shown = false;
  }

  ok(): void {
    this.done(1);
  }

  cancel(): void {
    this.done(0);
  }

  show(): void {
    this.shown = true;
  }

  render(): Bitmap {
    return new Bitmap(this.width, this.height, `picture of ${this.windowTitle}`);
  }
}

/** A picture that remembers what was painted over it. */
export class Bitmap {
  covered: Array<[number, number, number, number]> = [];
  constructor(
    readonly width: number,
    readonly height: number,
    private readonly content: string,
  ) {}
  save(path: string): void {
    writeFileSync(path, `${this.content}${this.covered.map((rect) => ` covered ${rect.join(',')}`).join('')}`);
  }
}
export class Rect {
  constructor(
    readonly x0: number,
    readonly y0: number,
    readonly x1: number,
    readonly y1: number,
  ) {}
}
export class Brush {
  constructor(readonly color: number) {}
}
export class Graphics {
  constructor(private readonly bitmap: Bitmap) {}
  fillRect(rect: Rect): void {
    this.bitmap.covered.push([rect.x0, rect.y0, rect.x1, rect.y1]);
  }
  end(): void {}
}

export class Label extends Control {
  text = '';
  useRichText = false;
  wordWrapping = false;
}
export class Edit extends Control {
  text = '';
  passwordMode = false;
  readOnly = false;
}
export class TextBox extends Control {
  override opaque = true;
  text = '';
  readOnly = true;
}
export class CheckBox extends Control {
  text = '';
  checked = false;
}
export class RadioButton extends Control {
  text = '';
  checked = false;
}
export class PushButton extends Control {
  text = '';
  defaultButton = false;
}
export class ToolButton extends Control {
  text = '';
  checkable = false;
  checked = false;
}
export class ComboBox extends Control {
  items: string[] = [];
  currentItem = 0;
  editEnabled = false;
  editText = '';
  get numberOfItems(): number {
    return this.items.length;
  }
  itemText(index: number): string {
    return this.items[index] as string;
  }
}
export class SpinBox extends Control {
  value = 0;
  minValue = 0;
  maxValue = 100;
}
export class Slider extends Control {
  value = 0;
  minValue = 0;
  maxValue = 100;
}
/** Made of a label and an edit of its own, like the real one. */
export class NumericEdit extends Control {
  label = new Label(this).at(0, 0, 40, 20);
  edit = new Edit(this).at(44, 0, 40, 20);
  value = 0;
  lowerBound = 0;
  upperBound = 1;
  setValue(value: number): void {
    this.value = value;
  }
}
export class NumericControl extends NumericEdit {}
export class GroupBox extends Control {
  title = '';
  titleCheckBox = false;
  checked = false;
}
export class TabBox extends Control {
  pages: string[] = [];
  currentPageIndex = 0;
  addPage(_page: Control, label: string): void {
    this.pages.push(label);
  }
  get numberOfPages(): number {
    return this.pages.length;
  }
  pageLabel(index: number): string {
    return this.pages[index] as string;
  }
}
/** A box that shows a part of an area of its own, which a script draws on. */
export class ScrollBox extends Control {
  readonly viewport: Control;
  constructor(parent?: Control) {
    super(parent);
    this.viewport = new Control(this);
  }
  override at(x: number, y: number, w: number, h: number): this {
    this.viewport.place = { x: 0, y: 0, w, h };
    return super.at(x, y, w, h);
  }
}
export class TreeBoxNode {
  children: TreeBoxNode[] = [];
  parent: TreeBoxNode | null = null;
  selected = false;
  expanded = false;
  /** The real one says this of every row, with or without a box to tick. */
  checkable = true;
  checked = false;
  constructor(readonly cells: string[] = []) {}
  get numberOfChildren(): number {
    return this.children.length;
  }
  child(index: number): TreeBoxNode | undefined {
    return this.children[index];
  }
  text(column: number): string {
    return this.cells[column] ?? '';
  }
  /** A row inside this one. */
  add(...cells: string[]): TreeBoxNode {
    const node = new TreeBoxNode(cells);
    node.parent = this;
    this.children.push(node);
    return node;
  }
  each(visit: (node: TreeBoxNode) => void): void {
    visit(this);
    for (const child of this.children) child.each(visit);
  }
}
export class TreeBox extends Control {
  override opaque = true;
  headers: string[] = [];
  rows: TreeBoxNode[] = [];
  /** Columns the script has hidden. */
  hiddenColumns: number[] = [];
  /** The row that was last scrolled into view. */
  inView: unknown = null;
  private current: unknown = null;
  get currentNode(): unknown {
    return this.current;
  }
  /** On V8 the real one tells the script of a new current row by itself, on the older engine it does not. */
  set currentNode(node: unknown) {
    const before = this.current;
    this.current = node;
    for (const row of this.rows) row.each((each) => (each.selected = each === node));
    if (Dialog.env.engine !== 'v8') return;
    for (const [handler, args] of [['onCurrentNodeUpdated', [node, before]], ['onNodeSelectionUpdated', []]] as const) {
      if (typeof this[handler] === 'function') (this[handler] as (...given: unknown[]) => void)(...args);
    }
  }
  get numberOfColumns(): number {
    return this.headers.length;
  }
  get numberOfChildren(): number {
    return this.rows.length;
  }
  headerText(column: number): string {
    return this.headers[column] as string;
  }
  child(index: number): unknown {
    return this.rows[index];
  }
  isColumnVisible(column: number): boolean {
    return !this.hiddenColumns.includes(column);
  }
  /** On V8 the real one writes a warning for this older name of the method below. */
  setNodeIntoView(node: unknown): void {
    if (Dialog.env.engine === 'v8') Dialog.env.consoleLines.push('** Warning: TreeBox.setNodeIntoView() is deprecated: Use TreeBox.setNodeIntoViewport() instead.');
    this.inView = node;
  }
  setNodeIntoViewport(node: unknown): void {
    this.inView = node;
  }
  add(...cells: string[]): TreeBoxNode {
    const node = new TreeBoxNode(cells);
    this.rows.push(node);
    return node;
  }
}
type FakeView = { isNull: boolean; fullId: string };
export class ViewList extends Control {
  /** The views this list offers. Another one cannot be set. */
  offers: string[] = ['Ha', 'Oiii'];
  private current: FakeView = { isNull: true, fullId: '' };
  get currentView(): FakeView {
    return this.current;
  }
  /** Like the real one, this tells the script nothing when a view is set. */
  set currentView(view: FakeView) {
    if (!view.isNull && !this.offers.includes(view.fullId)) return;
    this.current = view;
  }
}
export class Sizer {
  spacing = 0;
  margin = 0;
  /** What was laid out with this sizer, in order. */
  items: unknown[] = [];
  add(item: unknown): void {
    this.items.push(item);
  }
  insert(index: number, item: unknown): void {
    this.items.splice(index, 0, item);
  }
  addStretch(): void {}
}

export class Timer {
  static env: Env;
  interval = 1;
  periodic = true;
  running = false;
  busy = false;
  onTimeout: (() => void) | null = null;
  start(): void {
    this.running = true;
    if (!Timer.env.timers.includes(this)) Timer.env.timers.push(this);
  }
  stop(): void {
    this.running = false;
  }
}

export class MessageBox {
  static env: Env;
  result = 0;
  firstButton: number;
  secondButton: number;
  thirdButton: number;
  defaultButton = 0;
  escapeButton = -1;
  constructor(
    public text = '',
    public caption = '',
    public icon = 0,
    first = 1,
    second = 0,
    third = 0,
  ) {
    this.firstButton = first;
    this.secondButton = second;
    this.thirdButton = third;
  }
  /** PixInsight's own message box, which nothing in a test could answer. */
  execute(): number {
    MessageBox.env.nativeWindows.push(`message: ${this.text}`);
    return this.firstButton;
  }
}

class Chooser {
  static env: Env;
  caption = '';
  initialPath = '';
  multipleSelections = false;
  fileName = '';
  fileNames: string[] = [];
  directory = '';
  filters: unknown[] = [];
  loadImageFilters(): void {
    this.filters = ['images'];
  }
  execute(): boolean {
    Chooser.env.nativeWindows.push(`chooser: ${this.caption}`);
    this.fileName = '/picked/by/the/user.xisf';
    this.fileNames = [this.fileName];
    this.directory = '/picked/by/the/user';
    return true;
  }
}
export class OpenFileDialog extends Chooser {}
export class SaveFileDialog extends Chooser {}
export class GetDirectoryDialog extends Chooser {}

/** What the hook replaces on the older engine, as it was before any test. */
const PRISTINE = { execute: Dialog.prototype.execute, ask: MessageBox.prototype.execute, add: Sizer.prototype.add, insert: Sizer.prototype.insert, addPage: TabBox.prototype.addPage };

export interface Reply {
  ok: boolean;
  result?: Record<string, any>;
  error?: { kind: string; message: string };
}

/** One script run: the scope the hook and the script share, the folder of the job, and the clock. */
export class Env {
  readonly jobDir = mkdtempSync(join(tmpdir(), 'pixinsight-mcp-hook-'));
  readonly timers: Timer[] = [];
  /** Windows of PixInsight's own that came up, which is what the hook is there to avoid. */
  readonly nativeWindows: string[] = [];
  readonly consoleLines: string[] = [];
  /** Every dialog that was made, also those the hook makes itself. */
  readonly made: Dialog[] = [];
  /** A timer fires while a window is there and its wait has not begun. */
  unluckyTick = false;
  now = 1_000_000;
  /** What the test does in each step, as the server would. Called until it returns true, then the next. */
  steps: Array<() => boolean> = [];
  readonly context: Context;
  private nextId = 1;

  constructor(readonly engine: 'v8' | 'classic') {
    Dialog.env = this;
    Timer.env = this;
    MessageBox.env = this;
    (Chooser as unknown as { env: Env }).env = this;
    this.beat();
    const file = {
      exists: (path: string) => existsSync(path),
      readTextFile: (path: string) => readFileSync(path, 'utf8'),
      writeTextFile: (path: string, text: string) => writeFileSync(path, text),
      remove: (path: string) => rmSync(path),
      move: (from: string, to: string) => renameSync(from, to),
      extractExtension: (path: string) => extname(path),
    };
    this.context = createContext({
      Control, Dialog, Label, Edit, TextBox, CheckBox, RadioButton, PushButton, ToolButton, ComboBox, SpinBox, Slider, NumericEdit, NumericControl,
      GroupBox, TabBox, TreeBox, TreeBoxNode, ScrollBox, ViewList, Sizer, Timer, Point, MessageBox, OpenFileDialog, SaveFileDialog, GetDirectoryDialog,
      Graphics, Rect, Brush,
      msleep: () => undefined,
      File: file,
      View: { viewById: (id: string) => (id === 'Ha' || id === 'Oiii' ? { isNull: false, fullId: id } : { isNull: true, fullId: '' }) },
      Date: { now: () => this.now },
      console: { writeln: (line: string) => this.consoleLines.push(line) },
    });
  }

  /** Loads the hook the way the generated file does, and tells it the engine this run stands for. */
  install(operate = true): void {
    const source = readFileSync(resolve('pjsr/dialogs/hook.js'), 'utf8');
    const hook = runInContext(`( ${source} )`, this.context) as (dir: string, operate: boolean, v8: boolean) => void;
    hook.call(runInContext('this', this.context), this.jobDir, operate, this.engine === 'v8');
  }

  /** Runs code of the script, in the scope it shares with the hook. */
  script<T = unknown>(code: string): T {
    return runInContext(code, this.context) as T;
  }

  step(): void {
    this.now += 100;
    while (this.steps.length && this.steps[0]!()) this.steps.shift();
    for (const timer of [...this.timers]) {
      if (!timer.running || timer.busy || !timer.onTimeout) continue;
      timer.busy = true;
      try {
        timer.onTimeout();
      } finally {
        timer.busy = false;
      }
    }
  }

  /** The server says that it still waits for the job, or with false that it has given up. */
  beat(waiting = true): void {
    writeFileSync(join(this.jobDir, 'awaited'), String(waiting ? this.now : 0));
  }

  state(): { dialog: string | null; title: string | null; question: Record<string, any> | null; serial: number } | null {
    const serials = readdirSync(this.jobDir).flatMap((name) => /^dialog-state-(\d+)\.json$/.exec(name)?.[1] ?? []).map(Number);
    return serials.length ? JSON.parse(readFileSync(join(this.jobDir, `dialog-state-${Math.max(...serials)}.json`), 'utf8')) : null;
  }

  /** Leaves a command, for the dialog on top unless it names another: a look names none. */
  post(command: Record<string, unknown>): number {
    const id = this.nextId++;
    const dialog = command['act'] === 'describe' ? null : (this.state()?.dialog ?? null);
    writeFileSync(join(this.jobDir, 'dialog-cmd.json'), JSON.stringify({ dialog, ...command, id }));
    return id;
  }

  reply(id: number): Reply | null {
    const path = join(this.jobDir, `dialog-reply-${id}.json`);
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Reply) : null;
  }

  answer(questionId: number, value: unknown): void {
    writeFileSync(join(this.jobDir, `dialog-answer-${questionId}.json`), JSON.stringify({ value }));
  }

  /** Steps that send a command once a dialog is open and nothing is asked, and keep its reply. */
  ask(command: Record<string, unknown>, replies: Reply[]): Array<() => boolean> {
    let id = 0;
    return [
      () => {
        if (!this.state()?.dialog || this.state()?.question) return false;
        id = this.post(command);
        return true;
      },
      () => {
        const reply = this.reply(id);
        if (reply) replies.push(reply);
        return reply !== null;
      },
    ];
  }

  /** Forgets what the hook has said so far, as a new job with a folder of its own would. */
  forgetStates(): void {
    for (const name of readdirSync(this.jobDir)) if (name.startsWith('dialog-state-')) rmSync(join(this.jobDir, name));
  }

  dispose(): void {
    // These classes are shared by all tests, the way the older engine shares its scope between scripts.
    Dialog.prototype.execute = PRISTINE.execute;
    MessageBox.prototype.execute = PRISTINE.ask;
    Sizer.prototype.add = PRISTINE.add;
    Sizer.prototype.insert = PRISTINE.insert;
    TabBox.prototype.addPage = PRISTINE.addPage;
    rmSync(this.jobDir, { recursive: true, force: true });
  }
}
