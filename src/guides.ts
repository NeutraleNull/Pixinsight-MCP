import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

/**
 * The processing library: what an assistant should know about working on images, in small files
 * that anyone can add to. A file's place in the folders says what it is, and its front matter
 * says when to use it, so that nothing has to be registered anywhere else.
 */
const KINDS = ['workflows', 'stages', 'methods', 'practices'] as const;
export type GuideKind = (typeof KINDS)[number];

export interface ParameterRef {
  process: string;
  parameter: string;
  /** An enumeration constant the guide passes for this parameter. */
  constant?: string;
}

export interface Guide {
  /** The path below the library folder, without the extension. */
  id: string;
  kind: GuideKind;
  /** For a method, the stage it belongs to. */
  stage?: string;
  title: string;
  summary: string;
  status?: string;
  evidence?: string;
  /** Processes that must be installed. */
  requires: string[];
  /** Parameters the guide names, which can be checked against an installation. */
  parameters: ParameterRef[];
  appliesTo: string[];
  /** For a workflow, its stages in order. */
  stages: string[];
  body: string;
  file: string;
  /** Whether it comes with the server, or from an additional folder. */
  builtIn: boolean;
  /** It stands in for a guide of the same id that comes with the server. */
  replacesBuiltIn?: boolean;
}

export interface Problem {
  file: string;
  message: string;
}

export interface Library {
  guides: Map<string, Guide>;
  /** Files that were left out, and references that lead nowhere. */
  problems: Problem[];
}

export interface LibraryDir {
  dir: string;
  builtIn: boolean;
}

/** What is known about the PixInsight a guide is about to be used with. */
export interface Installation {
  processes: Set<string>;
  /** Only for the processes that were looked up. */
  details: Map<string, { parameters: Set<string>; constants: Set<string> }>;
}

const STATUSES = ['tested', 'experimental'];
const APPLIES_TO = ['narrowband', 'broadband', 'mono', 'color', 'linear', 'stretched', 'starless', 'stars'];
const MAX_SUMMARY_LENGTH = 160;
const MAX_BODY_LINES: Record<GuideKind, number> = { workflows: 120, stages: 80, methods: 80, practices: 80 };

const LIST_FIELDS = ['requires', 'parameters', 'applies_to', 'stages'];
const FIELDS: Record<GuideKind, { required: string[]; optional: string[] }> = {
  workflows: { required: ['title', 'summary', 'status', 'evidence', 'stages'], optional: ['applies_to'] },
  stages: { required: ['title', 'summary'], optional: [] },
  methods: { required: ['title', 'summary', 'status', 'evidence'], optional: ['requires', 'parameters', 'applies_to'] },
  practices: { required: ['title', 'summary'], optional: [] },
};
/** A method must say how to do it and how to tell that it worked. */
const METHOD_HEADINGS = ['## Steps', '## Check the result'];

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PROCESS_ID = /^[A-Za-z][A-Za-z0-9]*$/;
const PARAMETER_REF = /^([A-Za-z][A-Za-z0-9]*)\.([A-Za-z_][A-Za-z0-9_]*)(?:=([A-Za-z_][A-Za-z0-9_]*))?$/;
const GUIDE_REFERENCE = /`((?:workflows|stages|methods|practices)\/[a-z0-9/-]+)`/g;

type FrontMatter = Map<string, string | string[]>;

/**
 * A value from a file, for a message. Messages reach the assistant, and a file from somewhere
 * else must not get to speak to it that way, so only plain names are repeated.
 */
function named(value: string): string {
  return /^[\w.=-]{1,40}$/.test(value) ? `"${value}"` : 'a value that is not a plain name';
}

function unquote(value: string): string {
  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
  return quoted ? (quoted[1] as string) : value;
}

/**
 * Reads the small part of YAML that guides use: `key: text` and `key: [a, b]`. Anything else is
 * an error, because a value that is silently misread would be worse than a refused file.
 */
export function parseFrontMatter(text: string): { fields: FrontMatter; body: string } | { error: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { error: 'The file must start with front matter between two lines of ---.' };
  const fields: FrontMatter = new Map();
  for (const [index, line] of (match[1] as string).split(/\r?\n/).entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const field = /^([a-z_]+):\s*(.*?)\s*$/.exec(line);
    if (!field) return { error: `Line ${index + 2} of the front matter is not understood. Use "key: text" or "key: [a, b]".` };
    const [, key, value] = field as unknown as [string, string, string];
    if (fields.has(key)) return { error: `Front matter has ${named(key)} twice.` };
    const list = /^\[(.*)\]$/.exec(value);
    if (list) {
      const items = (list[1] as string).split(',').map((item) => unquote(item.trim()));
      fields.set(key, items.length === 1 && items[0] === '' ? [] : items);
    } else {
      fields.set(key, unquote(value));
    }
  }
  return { fields, body: text.slice(match[0].length).trim() };
}

/** Where a file may be: `stages/<name>` and the like, and `methods/<stage>/<name>`. */
function placeOf(id: string): { kind: GuideKind; stage?: string } | { error: string } {
  const parts = id.split('/');
  const kind = KINDS.find((each) => each === parts[0]);
  if (!kind) return { error: `A guide belongs in one of the folders ${KINDS.join(', ')}.` };
  const depth = kind === 'methods' ? 3 : 2;
  if (parts.length !== depth) {
    return { error: kind === 'methods' ? 'A method belongs in methods/<stage>/<name>.md.' : `A file in ${kind} belongs directly in that folder.` };
  }
  if (!parts.every((part) => NAME.test(part))) return { error: 'Folder and file names use lowercase letters, digits and hyphens.' };
  return kind === 'methods' ? { kind, stage: parts[1] as string } : { kind };
}

/** Checks one file on its own. References to other guides are checked once all are loaded. */
export function parseGuide(id: string, text: string, file: string, builtIn: boolean): { guide: Guide } | { problems: string[] } {
  const place = placeOf(id);
  if ('error' in place) return { problems: [place.error] };
  const parsed = parseFrontMatter(text);
  if ('error' in parsed) return { problems: [parsed.error] };
  const { fields, body } = parsed;
  const { required, optional } = FIELDS[place.kind];
  const problems: string[] = [];

  for (const key of required) if (!fields.has(key)) problems.push(`Front matter lacks "${key}".`);
  for (const [key, value] of fields) {
    if (!required.includes(key) && !optional.includes(key)) problems.push(`Front matter has ${named(key)}, which ${place.kind} do not use.`);
    else if (LIST_FIELDS.includes(key) !== Array.isArray(value)) {
      problems.push(LIST_FIELDS.includes(key) ? `"${key}" must be a list: [a, b].` : `"${key}" must be text, not a list.`);
    } else if (value.length === 0 || (Array.isArray(value) && value.includes(''))) problems.push(`"${key}" is empty.`);
  }
  if (problems.length) return { problems };

  const textOf = (key: string) => fields.get(key) as string | undefined;
  const list = (key: string) => (fields.get(key) as string[] | undefined) ?? [];
  const summary = textOf('summary') as string;
  if (summary.length > MAX_SUMMARY_LENGTH) problems.push(`The summary has ${summary.length} characters. The limit is ${MAX_SUMMARY_LENGTH}.`);
  const status = textOf('status');
  if (status !== undefined && !STATUSES.includes(status)) problems.push(`The status must be one of: ${STATUSES.join(', ')}.`);
  for (const tag of list('applies_to')) if (!APPLIES_TO.includes(tag)) problems.push(`applies_to has ${named(tag)}. Use: ${APPLIES_TO.join(', ')}.`);
  for (const process of list('requires')) if (!PROCESS_ID.test(process)) problems.push(`requires has ${named(process)}, which is not a process name.`);
  for (const stage of list('stages')) if (!NAME.test(stage)) problems.push(`stages has ${named(stage)}, which is not the name of a stage.`);

  const parameters: ParameterRef[] = [];
  for (const entry of list('parameters')) {
    const match = PARAMETER_REF.exec(entry);
    if (!match) {
      problems.push(`parameters has ${named(entry)}. Use Process.parameter, or Process.parameter=Constant.`);
      continue;
    }
    const [, process, parameter, constant] = match as unknown as [string, string, string, string | undefined];
    if (!list('requires').includes(process)) problems.push(`parameters names ${process}, so requires must list it too.`);
    parameters.push({ process, parameter, ...(constant ? { constant } : {}) });
  }

  const lines = body.split(/\r?\n/);
  if (body === '') problems.push('The file has no text after its front matter.');
  if (lines.some((line) => /^# /.test(line))) problems.push('Leave out the top heading: the title of the front matter becomes it.');
  if (lines.length > MAX_BODY_LINES[place.kind]) {
    problems.push(`The text has ${lines.length} lines. The limit for ${place.kind} is ${MAX_BODY_LINES[place.kind]}: split it up.`);
  }
  if (place.kind === 'methods') {
    for (const heading of METHOD_HEADINGS) if (!lines.includes(heading)) problems.push(`A method needs the heading "${heading}".`);
  }
  if (problems.length) return { problems };

  return {
    guide: {
      id,
      ...place,
      title: textOf('title') as string,
      summary,
      ...(status ? { status } : {}),
      ...(textOf('evidence') ? { evidence: textOf('evidence') as string } : {}),
      requires: list('requires'),
      parameters,
      appliesTo: list('applies_to'),
      stages: list('stages'),
      body,
      file,
      builtIn,
    },
  };
}

function referencesIn(guide: Guide): string[] {
  return [...guide.body.matchAll(GUIDE_REFERENCE)].map((match) => match[1] as string);
}

/** Checks what only shows once all guides are known: that every reference leads somewhere. */
function crossCheck(guides: Map<string, Guide>): Problem[] {
  const problems: Problem[] = [];
  for (const guide of guides.values()) {
    const add = (message: string) => problems.push({ file: guide.file, message });
    if (guide.stage && !guides.has(`stages/${guide.stage}`)) add(`There is no stage "${guide.stage}". Add stages/${guide.stage}.md, or move the method.`);
    for (const reference of new Set(referencesIn(guide))) {
      if (!guides.has(reference)) add(`The text refers to \`${reference}\`, which does not exist.`);
    }
    for (const stage of guide.stages) {
      if (!guides.has(`stages/${stage}`)) add(`stages lists "${stage}", but there is no stages/${stage}.md.`);
      else if (!referencesIn(guide).includes(`stages/${stage}`)) add(`stages lists "${stage}", but the text never mentions \`stages/${stage}\`.`);
    }
  }
  return problems;
}

async function markdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/**
 * Loads all guides, from the folders in order. A guide in a later folder replaces one with the same
 * id, so that users can adapt what comes with the server. A file with a mistake is left out and
 * reported, because one bad contribution must not take the library down.
 */
export async function loadLibrary(dirs: readonly LibraryDir[]): Promise<Library> {
  const guides = new Map<string, Guide>();
  const problems: Problem[] = [];
  for (const { dir, builtIn } of dirs) {
    const root = resolve(dir);
    for (const kind of KINDS) {
      for (const file of await markdownFiles(join(root, kind))) {
        const id = relative(root, file).slice(0, -'.md'.length).split(sep).join('/');
        const parsed = await readFile(file, 'utf8').then(
          (text) => parseGuide(id, text, file, builtIn),
          (error: Error) => ({ problems: [`The file could not be read: ${error.message}`] }),
        );
        if ('problems' in parsed) {
          for (const message of parsed.problems) problems.push({ file, message });
          continue;
        }
        if (!builtIn && guides.get(id)?.builtIn) parsed.guide.replacesBuiltIn = true;
        guides.set(id, parsed.guide);
      }
    }
  }
  problems.push(...crossCheck(guides));
  return { guides, problems };
}

export function methodsOf(library: Library, stage: string): Guide[] {
  return [...library.guides.values()].filter((guide) => guide.kind === 'methods' && guide.stage === stage);
}

/** The processes whose parameters matter when this guide is shown. */
export function processesToCheck(library: Library, guide: Guide): string[] {
  const shown = guide.kind === 'stages' ? inlined(library, guide) : [guide];
  return [...new Set(shown.flatMap((each) => each.requires))];
}

/** A stage with a single method shows it right away, which saves a call. */
function inlined(library: Library, stage: Guide): Guide[] {
  const methods = methodsOf(library, stage.id.slice('stages/'.length));
  return methods.length === 1 ? methods : [];
}

function code(names: readonly string[]): string {
  return names.map((name) => `\`${name}\``).join(', ');
}

function needs(guide: Guide, installed: Set<string> | null): string {
  if (!guide.requires.length) return '';
  const missing = installed ? guide.requires.filter((process) => !installed.has(process)) : [];
  return ` Needs ${code(guide.requires)}${missing.length ? `. Not installed here: ${code(missing)}` : ''}.`;
}

/** Where a guide comes from, if not from the server: an assistant must be able to tell. */
function origin(guide: Guide): string {
  if (guide.builtIn) return '';
  return guide.replacesBuiltIn ? 'from an additional folder, replaces the guide of the server' : 'from an additional folder';
}

function entry(guide: Guide, installed: Set<string> | null): string {
  const tags = [guide.status === 'experimental' ? 'experimental' : '', origin(guide)].filter(Boolean);
  return `- \`${guide.id}\`: ${guide.summary}${needs(guide, installed)}${tags.length ? ` (${tags.join(', ')})` : ''}`;
}

function byId(a: Guide, b: Guide): number {
  return a.id.localeCompare(b.id);
}

/** Every guide with its id and summary, methods below their stage. */
export function renderListing(library: Library, installed: Set<string> | null): string[] {
  const of = (kind: GuideKind) => [...library.guides.values()].filter((guide) => guide.kind === kind).sort(byId);
  const lines = [
    '## Workflows',
    '',
    ...of('workflows').map((guide) => entry(guide, installed)),
    '',
    '## Practices',
    '',
    'They apply to every task, so read them once before you start.',
    '',
    ...of('practices').map((guide) => entry(guide, installed)),
    '',
    '## Stages and their methods',
    '',
  ];
  for (const stage of of('stages')) {
    lines.push(entry(stage, installed));
    for (const method of methodsOf(library, stage.id.slice('stages/'.length)).sort(byId)) lines.push(`  ${entry(method, installed)}`);
  }
  return lines;
}

/** The list of everything there is, short enough to read in full. */
export function renderCatalog(library: Library, installed: Set<string> | null): string {
  const lines = [
    '# Processing library',
    '',
    'For a whole image, read the workflow that fits the data. Read each stage when you get to it, and then the method you choose. `name` takes one id or a list of ids. The values in the guides are starting points from real runs: measure your own data.',
    '',
    ...renderListing(library, installed),
  ];
  if (!installed) lines.push('', 'PixInsight did not answer, so the methods are not matched to the installed processes.');
  if (library.problems.length) {
    lines.push('', '## Files with problems', '', 'These were left out, or refer to something that does not exist:', '');
    for (const { file, message } of library.problems) lines.push(`- ${file}: ${message}`);
  }
  return lines.join('\n');
}

/** Whether everything the guide needs could be compared with the installation. */
function wasChecked(guide: Guide, installation: Installation | null): boolean {
  if (!guide.requires.length) return true;
  if (!installation) return false;
  return guide.parameters.every(({ process }) => !installation.processes.has(process) || installation.details.has(process));
}

/** Parameters and constants a guide names that the installed version of a process does not have. */
export function unknownParameters(guide: Guide, installation: Installation | null): string[] {
  const missing: string[] = [];
  for (const { process, parameter, constant } of guide.parameters) {
    const details = installation?.details.get(process);
    if (!details) continue;
    if (!details.parameters.has(parameter)) missing.push(`${process}.${parameter}`);
    else if (constant && !details.constants.has(constant)) missing.push(`${process}.${constant}`);
  }
  return missing;
}

function renderOne(guide: Guide, installation: Installation | null): string[] {
  const facts: string[] = [];
  if (guide.stage) facts.push(`- Stage: \`stages/${guide.stage}\``);
  if (guide.requires.length) facts.push(`-${needs(guide, installation?.processes ?? null)}`);
  if (guide.appliesTo.length) facts.push(`- Applies to: ${guide.appliesTo.join(', ')}`);
  if (guide.status) facts.push(`- Status: ${guide.status}. Evidence: ${guide.evidence}`);
  if (!wasChecked(guide, installation)) facts.push('- Not checked against this installation, because PixInsight is busy or did not answer.');
  if (!guide.builtIn) facts.push(`- Not shipped with the server: ${origin(guide)}, ${guide.file}`);

  const missing = unknownParameters(guide, installation);
  const warning = missing.length
    ? ['', `> [!WARNING]`, `> This installation has no ${code(missing)}. The guide may be written for another version: check with describe_process before you use these names.`]
    : [];
  return [`# ${guide.title}`, '', guide.summary, ...(facts.length ? ['', ...facts] : []), ...warning, '', guide.body];
}

/** One guide as the assistant reads it. A stage also lists its methods. */
export function renderGuide(library: Library, guide: Guide, installation: Installation | null): string {
  const lines = renderOne(guide, installation);
  if (guide.kind === 'stages') {
    const methods = methodsOf(library, guide.id.slice('stages/'.length)).sort(byId);
    const single = inlined(library, guide);
    if (single.length) {
      lines.push('', '---', '', 'This stage has one method:', '', ...renderOne(single[0] as Guide, installation).map((line) => (line.startsWith('#') ? `#${line}` : line)));
    } else if (methods.length) {
      lines.push('', '## Methods', '', 'Read the one you choose with get_guide:', '', ...methods.map((method) => entry(method, installation?.processes ?? null)));
    }
  }
  return lines.join('\n');
}
