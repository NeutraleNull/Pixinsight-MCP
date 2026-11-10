import { isAbsolute } from 'node:path';
import type { DialogAccess } from './scripts/dialogs.js';
import { defaultExecutable, defaultHome, splitPathList } from './platform.js';

export type Mode = 'shared' | 'worker';

export interface Config {
  /** PixInsight executable, or its launcher script on Linux. */
  executable: string;
  /**
   * shared: attach to an instance the user runs, and never start or stop it.
   * worker: use an own instance on `workerSlot`, in automation mode.
   */
  mode: Mode;
  /** Instance to attach to in shared mode. Unset means the first running instance. */
  slot: number | undefined;
  workerSlot: number;
  /** First slot for the disposable instance that checks risky parameter values. See EnumGuard. */
  shadowSlot: number;
  /** First slot for the instance that a preprocessing run starts for itself and that ends with the run. */
  preprocessSlot: number;
  /** Run own instances without a window. Only works where the Qt offscreen plugin ships. */
  headless: boolean;
  home: string;
  /** Programs that processes may be told to run, such as GraXpert. */
  allowedPrograms: string[];
  /** More folders with guides, laid out like the processing library that comes with the server. */
  guideDirs: string[];
  /** More folders with scripts the assistant may start, besides those PixInsight ships. */
  scriptDirs: string[];
  /** The assistant may run JavaScript of its own inside PixInsight. Off unless the user turns it on. */
  allowCode: boolean;
  /**
   * Whether the assistant can read the dialog of a script it started, and work it as the user
   * would. It reads unless the user sets it otherwise: working a dialog can make a script do
   * anything, and no check of the server stands behind that.
   */
  scriptDialogs: DialogAccess;
}

const LAST_SLOT = 256;
const SHADOW_SLOTS = 7;
const PREPROCESS_SLOTS = 3;

/** Every running server has a shadow instance of its own, on the first of these that is free. */
export function shadowSlots(config: Pick<Config, 'shadowSlot'>): number[] {
  const slots: number[] = [];
  for (let slot = config.shadowSlot; slot < config.shadowSlot + SHADOW_SLOTS && slot <= LAST_SLOT; slot++) slots.push(slot);
  return slots;
}

/** A preprocessing run takes the first of these that is free, so that several servers can run one each. */
export function preprocessSlots(config: Pick<Config, 'preprocessSlot'>): number[] {
  const slots: number[] = [];
  for (let slot = config.preprocessSlot; slot < config.preprocessSlot + PREPROCESS_SLOTS && slot <= LAST_SLOT; slot++) slots.push(slot);
  return slots;
}

function slotFrom(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const slot = Number(value);
  if (!Number.isInteger(slot) || slot < 1 || slot > LAST_SLOT) {
    throw new Error(`${name} must be an instance slot between 1 and ${LAST_SLOT}, got ${value}`);
  }
  return slot;
}

function flagFrom(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error(`${name} must be 1 or 0, got ${value}`);
}

/**
 * Folders whose scripts the assistant may start. Relative ones are refused: the server would look
 * them up from its own folder, and PixInsight from another.
 */
function scriptDirsFrom(value: string | undefined, platform: NodeJS.Platform): string[] {
  const dirs = splitPathList(value, platform);
  const relative = dirs.find((dir) => !isAbsolute(dir) && !/^[A-Za-z]:[\\/]/.test(dir));
  if (relative) throw new Error(`PIXINSIGHT_MCP_SCRIPT_DIRS must hold absolute paths, got ${relative}`);
  return dirs;
}

function dialogAccessFrom(value: string | undefined): DialogAccess {
  if (value === undefined || value === '') return 'read';
  if (value === 'operate' || value === 'read' || value === 'off') return value;
  throw new Error(`PIXINSIGHT_MCP_SCRIPT_DIALOGS must be "operate", "read" or "off", got ${value}`);
}

/** The shadow instance gets killed when a check goes wrong, so it must never share a slot with work. */
function assertSlotsApart(config: Config): void {
  const shadows = shadowSlots(config);
  const [name, slot] = config.mode === 'worker' ? ['PIXINSIGHT_MCP_WORKER_SLOT', config.workerSlot] : ['PIXINSIGHT_SLOT', config.slot];
  if (slot !== undefined && shadows.includes(slot)) {
    throw new Error(`${name} is ${slot}, but slots ${shadows[0]} to ${shadows.at(-1)} are reserved for shadow instances. Choose another slot, or move them with PIXINSIGHT_MCP_SHADOW_SLOT.`);
  }
  // An instance of a preprocessing run is ended when the run is cancelled, so it shares a slot with nothing either.
  const runs = preprocessSlots(config);
  const taken = [...shadows, config.workerSlot, ...(config.slot === undefined ? [] : [config.slot])];
  const shared = runs.find((each) => taken.includes(each));
  if (shared !== undefined) {
    throw new Error(`Slot ${shared} is one of the slots ${runs[0]} to ${runs.at(-1)} for preprocessing runs, and is also used for something else. Move them with PIXINSIGHT_MCP_PREPROCESS_SLOT.`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Config {
  const mode = env['PIXINSIGHT_MCP_MODE'] ?? 'shared';
  if (mode !== 'shared' && mode !== 'worker') {
    throw new Error(`PIXINSIGHT_MCP_MODE must be "shared" or "worker", got ${mode}`);
  }
  const config: Config = {
    executable: env['PIXINSIGHT_EXECUTABLE'] ?? defaultExecutable(platform),
    mode,
    slot: slotFrom(env['PIXINSIGHT_SLOT'], 'PIXINSIGHT_SLOT'),
    workerSlot: slotFrom(env['PIXINSIGHT_MCP_WORKER_SLOT'], 'PIXINSIGHT_MCP_WORKER_SLOT') ?? 200,
    shadowSlot: slotFrom(env['PIXINSIGHT_MCP_SHADOW_SLOT'], 'PIXINSIGHT_MCP_SHADOW_SLOT') ?? 250,
    preprocessSlot: slotFrom(env['PIXINSIGHT_MCP_PREPROCESS_SLOT'], 'PIXINSIGHT_MCP_PREPROCESS_SLOT') ?? 240,
    headless: flagFrom(env['PIXINSIGHT_MCP_HEADLESS'], 'PIXINSIGHT_MCP_HEADLESS') ?? platform === 'linux',
    home: env['PIXINSIGHT_MCP_HOME'] ?? defaultHome(platform, env),
    allowedPrograms: splitPathList(env['PIXINSIGHT_MCP_ALLOWED_PROGRAMS'], platform),
    guideDirs: splitPathList(env['PIXINSIGHT_MCP_GUIDE_DIRS'], platform),
    scriptDirs: scriptDirsFrom(env['PIXINSIGHT_MCP_SCRIPT_DIRS'], platform),
    allowCode: flagFrom(env['PIXINSIGHT_MCP_ALLOW_CODE'], 'PIXINSIGHT_MCP_ALLOW_CODE') ?? false,
    scriptDialogs: dialogAccessFrom(env['PIXINSIGHT_MCP_SCRIPT_DIALOGS']),
  };
  assertSlotsApart(config);
  return config;
}
