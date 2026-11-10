// Starts the server the way an MCP client does, and checks that it offers its tools and its
// processing library. Needs no PixInsight, so it can run anywhere: `node scripts/check-start.mjs`,
// or with the path of an installed `dist/index.js` to check a package.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const server = resolve(process.argv[2] ?? 'dist/index.js');
const home = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-check-'));
const client = new Client({ name: 'check-start', version: '1.0.0' });

function check(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [server],
      // An executable that does not exist, so that nothing here can reach a PixInsight on this machine.
      env: { ...process.env, PIXINSIGHT_MCP_HOME: home, PIXINSIGHT_EXECUTABLE: join(home, 'no-pixinsight-here') },
      stderr: 'inherit',
    }),
  );

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  for (const expected of ['get_status', 'run_process', 'get_preview', 'get_guide', 'list_scripts', 'start_script']) {
    check(names.includes(expected), `The server does not offer ${expected}.`);
  }
  check(!names.includes('run_code'), 'The server offers run_code although nobody turned it on.');

  const catalog = (await client.callTool({ name: 'get_guide', arguments: {} })).content[0]?.text ?? '';
  check(catalog.includes('# Working in PixInsight'), 'The catalog does not open with the rules.');
  check(catalog.includes('`workflows/'), 'The catalog lists no workflow, so the processing library is missing from this package.');

  const status = JSON.parse((await client.callTool({ name: 'get_status', arguments: {} })).content[0]?.text ?? '{}');
  check(status.mode === 'shared', `Expected shared mode by default, got ${status.mode}.`);

  console.log(`${server}: ${tools.length} tools, and the processing library is there.`);
} finally {
  await client.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
}
