import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, posix } from 'node:path';
import { toPixPath, unsafeForIpc } from '../platform.js';
import { preprocessOptionRefusal } from '../policy.js';
import { RunError } from './runs.js';

/** A run of WBPP over raw frames, without its dialog. */
export interface PreprocessRequest {
  /** Folders and files with the frames: lights and calibration frames, raw or masters. */
  inputs: string[];
  outputDirectory: string;
  /** Grouping keywords, each with its mode behind a space if it is not `pre`. */
  keywords?: string[] | undefined;
  /** Options of the automation mode of WBPP, by their names there. A text, a number, or true or false each. */
  options?: Record<string, unknown> | undefined;
}

/** The script that preprocesses, by its name in the Script menu. */
export const WBPP = 'WeightedBatchPreprocessing';
/** What one argument of a command line may hold at most. The launcher on Linux hands them all on as one. */
const MAX_COMMAND_LENGTH = { win32: 30_000, other: 100_000 };

/**
 * Checks a request, and turns it into the arguments that WBPP takes in its automation mode.
 * Everything that goes onto the command line of PixInsight is checked here: paths, names and values.
 *
 * @throws RunError with the kind of the refusal and a message for the assistant.
 */
export async function argumentsOf(request: PreprocessRequest, platform: NodeJS.Platform = process.platform): Promise<{ args: string[]; outputDirectory: string }> {
  /** The path as PixInsight takes it, or null if it is not absolute. Elsewhere than on Windows a backslash is part of a name. */
  const absolute = (given: string): string | null => {
    const path = (platform === 'win32' ? toPixPath(given) : given).replace(/(?<=.)\/+$/, '');
    if (!(platform === 'win32' ? /^([A-Za-z]:\/|\/\/)/.test(path) : isAbsolute(path))) return null;
    // Without the steps back and the doubled separators, which would hide where a path leads. The two in front of a share stay.
    return (platform === 'win32' && path.startsWith('//') ? '/' : '') + posix.normalize(path);
  };
  /** Refuses what cannot go onto the command line, and says which character it is: a name with it cannot be passed in any way. */
  const argument = (value: string, shown: string, what: string, kind: 'invalid_path' | 'invalid_value'): string => {
    const bad = unsafeForIpc(value, platform);
    if (bad === null) return value;
    const advice = kind === 'invalid_path' ? ' Tell the user: the file or folder has to be renamed, or the frames named another way, such as by the folder above.' : '';
    throw new RunError(kind, `${what} ${shown} cannot go onto the command line of PixInsight, because ${JSON.stringify(bad)} has a meaning there.${advice}`);
  };
  /** Where a path leads once links are followed, as far as it exists, for comparing two of them. */
  const real = async (path: string): Promise<string> => {
    let rest = '';
    for (let at = path; ; at = dirname(at)) {
      const found = await realpath(at).catch(() => null);
      if (found !== null || dirname(at) === at) {
        const whole = toPixPath(found ?? at).replace(/\/+$/, '') + rest;
        // Where names differ only by case, they are the same file.
        return platform === 'win32' || platform === 'darwin' ? whole.toLowerCase() : whole;
      }
      rest = `/${basename(at)}${rest}`;
    }
  };
  const within = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);
  if (!request.inputs.length) throw new RunError('invalid_value', 'Name at least one folder or file with frames.');
  const folders: string[] = [];
  const inputs: string[] = [];
  for (const given of request.inputs) {
    const path = absolute(given);
    if (path === null || given !== given.trim()) throw new RunError('invalid_path', `Name the frames by absolute paths, with nothing around them, not ${JSON.stringify(given)}.`);
    const found = await stat(path).catch(() => null);
    if (!found) throw new RunError('no_such_file', `There is no file or folder ${path}.`);
    if (found.isDirectory()) folders.push(path);
    inputs.push(argument(`${found.isDirectory() ? 'dir' : 'file'}=${path}`, path, 'The path', 'invalid_path'));
  }
  const output = absolute(request.outputDirectory);
  if (output === null || request.outputDirectory !== request.outputDirectory.trim()) {
    throw new RunError('invalid_path', `Name the output folder by an absolute path, with nothing around it, not ${JSON.stringify(request.outputDirectory)}.`);
  }
  const there = await stat(output).catch(() => null);
  if (there && !there.isDirectory()) throw new RunError('invalid_path', `${output} is a file. Name a folder for the output.`);
  // WBPP reads a folder with everything below it, so its own output there would be input the next time.
  const realOutput = await real(output);
  for (const folder of folders) {
    const realFolder = await real(folder);
    if (within(realOutput, realFolder)) {
      throw new RunError('invalid_path', `The output folder ${output} lies in the input folder ${folder}, where the next run would read its files as frames. Name a folder outside the inputs.`);
    }
    if (within(realFolder, realOutput)) {
      throw new RunError('invalid_path', `The input folder ${folder} lies in the output folder ${output}, so the run would write into the folder it reads. Name single files from there, or another output folder.`);
    }
  }
  const keywords = (request.keywords ?? []).map((keyword) => {
    const text = keyword.trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]*( (pre|post|prepost))?$/.test(text)) {
      throw new RunError('invalid_value', `A grouping keyword is a name, with pre, post or prepost behind a space if it is not meant for the calibration alone. Got ${JSON.stringify(keyword)}.`);
    }
    return `keywords=${text}`;
  });
  const options = Object.entries(request.options ?? {}).map(([name, value]) => {
    if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(name)) throw new RunError('invalid_value', `${JSON.stringify(name)} is no name of an option of WBPP.`);
    const blocked = preprocessOptionRefusal(name);
    if (blocked) throw new RunError('blocked_parameter', `The option ${name} cannot be set: ${blocked}.`);
    if (!(typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) {
      throw new RunError('invalid_value', `The option ${name} takes a text, a number, or true or false.`);
    }
    return argument(`${name}=${String(value)}`, String(value), `The value of ${name}:`, 'invalid_value');
  });
  const args = [argument(`outputDirectory=${output}`, output, 'The output folder', 'invalid_path'), ...keywords, ...options, ...inputs];
  // In bytes, which is what the system counts: a path can hold letters that take several.
  const length = args.reduce((sum, each) => sum + Buffer.byteLength(each) + 1, 0);
  if (length > (platform === 'win32' ? MAX_COMMAND_LENGTH.win32 : MAX_COMMAND_LENGTH.other)) {
    throw new RunError('invalid_value', `These inputs make a command line of ${length} bytes, which is more than PixInsight can be started with here. Name folders instead of single files.`);
  }
  return { args, outputDirectory: output };
}
