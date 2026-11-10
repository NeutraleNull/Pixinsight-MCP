#!/usr/bin/env node
// Checks the processing library, and prints what an assistant gets to see of it:
//
//   npm run guides:check                     the library in this repository
//   npm run guides:check -- ~/my-methods     the same, plus a folder of your own
//
// It needs no PixInsight. Parameter names are checked against a real installation by
// `npm run test:live`, and by the server whenever it hands out a guide.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLibrary, renderListing } from '../dist/guides.js';

const builtIn = join(dirname(fileURLToPath(import.meta.url)), '..', 'processing');
const extra = process.argv.slice(2).map((dir) => resolve(dir));
const library = await loadLibrary([{ dir: builtIn, builtIn: true }, ...extra.map((dir) => ({ dir, builtIn: false }))]);

console.log(renderListing(library, null).join('\n'));
console.log(`\n${library.guides.size} guides.`);
if (library.problems.length) {
  console.error(`\n${library.problems.length} problem(s):`);
  for (const { file, message } of library.problems) console.error(`  ${file}\n    ${message}`);
  process.exit(1);
}
console.log('No problems found.');
