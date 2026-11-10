/** Processes an assistant must not run through the generic tool. */
const BLOCKED_PROCESSES: Readonly<Record<string, string>> = {
  Preferences: 'it changes global preferences, including security settings',
  ColorManagementSetup: 'it changes global color management settings',
  ReadoutOptions: 'it changes global readout settings',
  FilterManager: 'it changes the filter database of PixInsight',
  Script: 'it runs arbitrary scripts',
  ProcessContainer: 'it can bundle processes that are not allowed on their own',
  NetworkService: 'it acts on tasks from a network service',
  UnknownProcess: 'it is only a placeholder',
};

const BLOCKED_CATEGORIES: Readonly<Record<string, string>> = {
  Instrumentation: 'it controls physical equipment such as cameras and mounts',
};

/** Menus of the Script menu whose scripts an assistant must not start, in lower case. */
const BLOCKED_SCRIPT_MENUS: Readonly<Record<string, string>> = {
  instrumentation: 'its menu is for physical equipment such as cameras and mounts',
  development: 'its menu is for developer tools, such as the one for code signing keys',
};

/** A name can also be `constructor`, which every object has. */
function reasonFor(table: Readonly<Record<string, string>>, name: string): string | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined;
}

/** These are fine on a view, but change a program-wide setting in the global context. */
const BLOCKED_GLOBALLY: Readonly<Record<string, string>> = {
  RGBWorkingSpace: 'in the global context it changes the default RGB working space of PixInsight',
};

/** A parameter with such a name makes PixInsight run the program it points to. */
const PROGRAM_PARAMETER = /^(appPath|executable|program)$/i;
/** Batch processes write files directly, which no image history can undo. */
const OVERWRITE_PARAMETER = /^overwrite/i;
/**
 * Such a parameter decides what a process does besides processing, or which server it talks to.
 * `command` of the catalog processes is one, and its other values are not known here.
 */
const MODE_PARAMETER = /^(command|.*url)$/i;

/** Returns why a process is off limits, or null if it may run. */
export function blockReason(processId: string, categories: readonly string[], global = false): string | null {
  const direct = reasonFor(BLOCKED_PROCESSES, processId);
  if (direct) return direct;
  for (const category of categories) {
    const reason = reasonFor(BLOCKED_CATEGORIES, category);
    if (reason) return reason;
  }
  return (global && reasonFor(BLOCKED_GLOBALLY, processId)) || null;
}

/** Returns why a script of the Script menu is off limits, or null if it may be started. */
export function scriptBlockReason(menus: readonly string[]): string | null {
  for (const menu of menus) {
    const reason = reasonFor(BLOCKED_SCRIPT_MENUS, (menu.split('>')[0] ?? '').trim().toLowerCase());
    if (reason) return reason;
  }
  return null;
}

export interface ParameterPolicy {
  /** Programs the user allows processes to run. */
  allowedPrograms: readonly string[];
  /** The request explicitly accepts that existing files get replaced. */
  allowOverwrite: boolean;
}

/** Returns why these settings may not run, or null if they may. Some processes default to overwriting. */
export function parameterRefusal(
  processId: string,
  parameters: ReadonlyArray<{ id: string; default?: unknown }>,
  params: Readonly<Record<string, unknown>>,
  policy: ParameterPolicy,
): string | null {
  for (const { id, default: fallback } of parameters) {
    const value = id in params ? params[id] : fallback;
    if (PROGRAM_PARAMETER.test(id) && id in params && !policy.allowedPrograms.includes(String(value))) {
      return `${processId}.${id} makes PixInsight run a program, and ${JSON.stringify(value)} is not on the list of allowed programs. The user can allow it with PIXINSIGHT_MCP_ALLOWED_PROGRAMS.`;
    }
    if (MODE_PARAMETER.test(id) && id in params && value !== fallback) {
      return `${processId}.${id} decides what the process does besides processing, or which server it talks to, so it has to stay at its default. The user can change it in PixInsight.`;
    }
    // Anything but a plain false counts, so that no other spelling of "yes" gets through.
    if (OVERWRITE_PARAMETER.test(id) && value !== false && value !== undefined && !policy.allowOverwrite) {
      return `${processId}.${id} is ${JSON.stringify(value)}, so existing files would be replaced, and that cannot be undone. Set it to false, or pass allowOverwrite: true once you are sure.`;
    }
  }
  return null;
}
