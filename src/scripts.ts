import { createHash } from 'node:crypto';
import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A script of the Script menu, as its own directives describe it. */
export interface ScriptInfo {
  /** What the assistant calls it by. */
  name: string;
  /** Where it sits in the Script menu, such as "Astrometry > ImageSolver". A script can sit in several places. */
  menus: string[];
  /** What the script says about itself, as plain text. */
  info?: string;
  path: string;
  /** Whether PixInsight ships it, or it comes from a folder the user has added. */
  source: 'shipped' | 'user';
  /** Of the file as it was when the server listed it. What runs later has to be the same. */
  sha256: string;
}

export interface ScriptFolder {
  dir: string;
  source: ScriptInfo['source'];
}

export interface ScanLimits {
  /** How many folders below the given one are searched. PixInsight ships its scripts one folder down. */
  maxDepth: number;
  maxFiles: number;
}

/** The directives come after a license header at most, so the start of a file is enough. */
const HEAD_BYTES = 32 * 1024;
const DEFAULT_LIMITS: ScanLimits = { maxDepth: 2, maxFiles: 2000 };
const MAX_INFO_LENGTH = 240;
/** Longer ones are not names and menus any more, but text that would go to the assistant. */
const MAX_NAME_LENGTH = 80;
const MAX_MENU_LENGTH = 120;
const MAX_MENUS = 6;

const ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  copy: '©',
  reg: '®',
  deg: '°',
  micro: 'µ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  alpha: 'α',
  beta: 'β',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  ntilde: 'ñ',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  szlig: 'ß',
};

/** The text of a directive, with the lines it continues on. */
function directive(head: string, name: string): string | null {
  const lines = head.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`#${name}`) && /\s/.test(line.charAt(name.length + 1)));
  if (start < 0) return null;
  const parts: string[] = [];
  for (let index = start; index < lines.length; index++) {
    const line = lines[index] as string;
    const continued = line.trimEnd().endsWith('\\');
    parts.push(continued ? line.trimEnd().slice(0, -1) : line);
    if (!continued) break;
  }
  return parts.join(' ').slice(name.length + 1).replace(/\s+/g, ' ').trim();
}

function plainText(html: string): string {
  const text = html
    // A break separates words, while a tag such as <b> can sit inside one, or before a full stop.
    .replace(/<\/?(br|p|li|ul|ol|div|h\d)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_all, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_all, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (all, name: string) => (Object.hasOwn(ENTITIES, name) ? (ENTITIES[name] as string) : all))
    // Last, so that an escaped entity such as &amp;lt; stays the text &lt; and does not become a tag.
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_INFO_LENGTH ? `${text.slice(0, MAX_INFO_LENGTH - 1).trimEnd()}…` : text;
}

/**
 * Reads how a script wants to be featured: `Name : Menu > Item | Menu > Item`, or in the older
 * form only `Menu > Item`, where the item is the name. Null for a file that is not a featured
 * script, such as one that others include, and for one whose name or menus are not plausible.
 */
export function parseFeature(head: string): Pick<ScriptInfo, 'name' | 'menus' | 'info'> | null {
  const id = directive(head, 'feature-id');
  if (!id) return null;
  const colon = id.indexOf(':');
  const named = colon >= 0 && !id.slice(0, colon).includes('>');
  const menus = (named ? id.slice(colon + 1) : id)
    .split('|')
    .map((menu) =>
      menu
        .split('>')
        .map((part) => part.trim())
        .filter(Boolean)
        .join(' > '),
    )
    .filter(Boolean);
  const name = named ? id.slice(0, colon).trim() : (menus[0]?.split(' > ').at(-1) ?? '');
  if (!name || !menus.length) return null;
  if (name.length > MAX_NAME_LENGTH || menus.length > MAX_MENUS || menus.some((menu) => menu.length > MAX_MENU_LENGTH)) return null;
  const info = plainText(directive(head, 'feature-info') ?? '');
  return { name, menus, ...(info ? { info } : {}) };
}

/** Older scripts are not UTF-8. Their directives are still readable as Latin-1. */
function decode(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

async function readHead(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(HEAD_BYTES), 0, HEAD_BYTES, 0);
    // Up to the last whole line: a cut inside a character would make the text count as not UTF-8.
    const end = bytesRead < HEAD_BYTES ? bytesRead : buffer.lastIndexOf(0x0a, bytesRead - 1) + 1;
    return decode(buffer.subarray(0, end));
  } finally {
    await file.close();
  }
}

/** What identifies the content of a script file. */
export async function hashOfFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function scriptFiles(dir: string, limits: ScanLimits, depth = 0, found: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (found.length >= limits.maxFiles) break;
    const path = join(dir, entry.name);
    // Links are not followed: a folder of scripts must not reach files that lie somewhere else.
    if (entry.isDirectory() && depth < limits.maxDepth) await scriptFiles(path, limits, depth + 1, found);
    else if (entry.isFile() && entry.name.endsWith('.js')) found.push(path);
  }
  return found;
}

/**
 * The featured scripts in these folders, by name. A name that comes up again is left out, so that a
 * script in a later folder cannot take the place of one that PixInsight ships.
 */
export async function findScripts(folders: readonly ScriptFolder[], limits: ScanLimits = DEFAULT_LIMITS): Promise<ScriptInfo[]> {
  const byName = new Map<string, ScriptInfo>();
  for (const { dir, source } of folders) {
    for (const path of await scriptFiles(dir, limits)) {
      const feature = parseFeature(await readHead(path).catch(() => ''));
      if (!feature || byName.has(feature.name.toLowerCase())) continue;
      const sha256 = await hashOfFile(path).catch(() => null);
      if (sha256) byName.set(feature.name.toLowerCase(), { ...feature, path, source, sha256 });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
