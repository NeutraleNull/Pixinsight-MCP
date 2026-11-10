import { isAbsolute } from 'node:path';
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
}

const LAST_SLOT = 256;
const SHADOW_SLOTS = 7;

/** Every running server has a shadow instance of its own, on the first of these that is free. */
export function shadowSlots(config: Pick<Config, 'shadowSlot'>): number[] {
  const slots: number[] = [];
  for (let slot = config.shadowSlot; slot < config.shadowSlot + SHADOW_SLOTS && slot <= LAST_SLOT; slot++) slots.push(slot);
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

/** The shadow instance gets killed when a check goes wrong, so it must never share a slot with work. */
function assertSlotsApart(config: Config): void {
  const shadows = shadowSlots(config);
  const [name, slot] = config.mode === 'worker' ? ['PIXINSIGHT_MCP_WORKER_SLOT', config.workerSlot] : ['PIXINSIGHT_SLOT', config.slot];
  if (slot !== undefined && shadows.includes(slot)) {
    throw new Error(`${name} is ${slot}, but slots ${shadows[0]} to ${shadows.at(-1)} are reserved for shadow instances. Choose another slot, or move them with PIXINSIGHT_MCP_SHADOW_SLOT.`);
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
    headless: flagFrom(env['PIXINSIGHT_MCP_HEADLESS'], 'PIXINSIGHT_MCP_HEADLESS') ?? platform === 'linux',
    home: env['PIXINSIGHT_MCP_HOME'] ?? defaultHome(platform, env),
    allowedPrograms: splitPathList(env['PIXINSIGHT_MCP_ALLOWED_PROGRAMS'], platform),
    guideDirs: splitPathList(env['PIXINSIGHT_MCP_GUIDE_DIRS'], platform),
    scriptDirs: scriptDirsFrom(env['PIXINSIGHT_MCP_SCRIPT_DIRS'], platform),
    allowCode: flagFrom(env['PIXINSIGHT_MCP_ALLOW_CODE'], 'PIXINSIGHT_MCP_ALLOW_CODE') ?? false,
  };
  assertSlotsApart(config);
  return config;
}
