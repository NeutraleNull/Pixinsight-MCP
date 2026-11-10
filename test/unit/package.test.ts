import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;

// What ships is spread over several files that nothing else keeps in step.
describe('the package', () => {
  const pkg = json('package.json');
  const plugin = json('.claude-plugin/plugin.json');

  it('has one version, in the package and in the plugin', () => {
    expect(plugin['version']).toBe(pkg['version']);
  });

  it('ships everything the server reads at run time', () => {
    expect(pkg['files']).toEqual(expect.arrayContaining(['dist', 'pjsr', 'processing', 'skills', '.claude-plugin']));
  });

  it('starts the same server from the plugin as from the repository', () => {
    expect(plugin['mcpServers']['pixinsight']['args']).toEqual(['${CLAUDE_PLUGIN_ROOT}/dist/index.js']);
    expect(json('.mcp.json')['mcpServers']['pixinsight']['args']).toEqual(['dist/index.js']);
    expect(pkg['bin']['mcp-server-for-pixinsight']).toBe('dist/index.js');
  });

  it('offers the plugin under the name the marketplace lists', () => {
    const marketplace = json('.claude-plugin/marketplace.json');
    expect(marketplace['plugins'].map((entry: { name: string }) => entry.name)).toEqual([plugin['name']]);
  });

  it('has an entry skill that sends the assistant to the library, and holds no knowledge itself', () => {
    const skill = readFileSync('skills/pixinsight-processing/SKILL.md', 'utf8');
    expect(skill).toMatch(/^---\nname: pixinsight-processing\ndescription: .+\n---\n/);
    expect(skill).toMatch(/get_guide/);
    expect(skill.split('\n').length).toBeLessThan(25);
    expect(existsSync('skills/sho-processing')).toBe(false);
  });
});
