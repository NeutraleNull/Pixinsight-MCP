#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { Session } from './session.js';
import { createServer } from './tools.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const session = await Session.create(loadConfig());

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await session.close();
  process.exit(0);
}

const handle = serveStdio(() => {
  const server = createServer(session, version);
  server.server.onclose = () => void shutdown();
  return server;
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void handle.close().finally(() => void shutdown());
  });
}

// stdout is the protocol channel, so everything else goes to stderr.
console.error(`PixInsight MCP server ${version} ready (mode: ${session.config.mode})`);
