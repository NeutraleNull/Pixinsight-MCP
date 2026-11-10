// Part of `npm version`: the plugin manifest carries the version too, and has to say the same.
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const path = '.claude-plugin/plugin.json';
const plugin = JSON.parse(readFileSync(path, 'utf8'));
if (plugin.version !== version) {
  writeFileSync(path, `${JSON.stringify({ ...plugin, version }, null, 2)}\n`);
  console.log(`${path}: ${plugin.version} -> ${version}`);
}
