#!/usr/bin/env node
// Manual end-to-end check against a PixInsight you can watch, on any platform:
//
//   npm run build
//   PIXINSIGHT_SLOT=1 node scripts/smoke.mjs [preview.jpg] [--keep]
//
// Runs as a real MCP client in shared mode. It creates one test image, changes it, undoes the
// change and closes it again. It never touches other images. If PixInsight shows a dialog, the
// script waits and tells you, and goes on by itself once you have closed it.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const server = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const keep = process.argv.includes('--keep');
const previewPath = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const VIEW = 'mcp_smoke';
const STATUS_TIMEOUT_MS = 180_000;

const client = new Client({ name: 'smoke', version: '1.0.0' });
// The SDK only passes a minimal environment to the server unless told otherwise.
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: process.env, stderr: 'inherit' }));

const call = async (name, args = {}) => client.callTool({ name, arguments: args });
const json = (result) => JSON.parse(result.content.find((block) => block.type === 'text').text);

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

async function finished(result) {
  let value = json(result);
  while (value.pending) {
    console.log(`      waiting: ${value.state}${value.waitingForInput ? ', PixInsight seems to show a dialog' : ''}`);
    result = await call('get_job', { jobId: value.jobId, waitMs: 5000 });
    value = json(result);
  }
  return { result, value };
}

try {
  const deadline = Date.now() + STATUS_TIMEOUT_MS;
  let status = json(await call('get_status'));
  while (!status.pixinsight && Date.now() < deadline) {
    console.log(`      no answer yet: ${status.problem ?? 'unknown'}${status.waitingForInput ? ' (a dialog seems to be open)' : ''}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    status = json(await call('get_status'));
  }
  check('PixInsight answers', Boolean(status.pixinsight), JSON.stringify(status.pixinsight ?? status.problem));
  if (!status.pixinsight) process.exit(1);

  const { tools } = await client.listTools();
  check('tools are listed', tools.length > 5, `${tools.length} tools`);

  const processes = json(await call('list_processes'));
  check('processes come from the instance', processes.length > 50, `${processes.length} processes`);

  const existing = json(await call('list_images'));
  if (existing.some((entry) => entry.view === VIEW)) {
    console.log(`      ${VIEW} is already open in PixInsight. Close it, then run this again.`);
    process.exit(1);
  }

  const created = await finished(await call('run_process', {
    processId: 'NewImage',
    global: true,
    params: { id: VIEW, width: 1024, height: 768, numberOfChannels: 3, colorSpace: 'RGB', v0: 0.02, v1: 0.02, v2: 0.02 },
  }));
  check('creates a test image', created.value.newViews?.includes(VIEW), JSON.stringify(created.value.error ?? ''));

  const processed = await finished(await call('run_process', {
    processId: 'PixelMath',
    view: VIEW,
    params: {
      expression: '0.02 + 0.3*exp(-((X()-0.5)^2 + (Y()-0.5)^2)/0.02)',
      useSingleExpression: true,
      createNewImage: false,
      newImageColorSpace: 'RGB',
    },
    description: 'MCP smoke test',
  }));
  check('runs a process with an enum, after the shadow check', !processed.result.isError, JSON.stringify(processed.value.error ?? processed.value.seconds));

  const refused = await call('run_process', { processId: 'StarAlignment', global: true, params: { mode: 9999 } });
  check('refuses a numeric enum', refused.isError === true && json(refused).error === 'invalid_enum');

  const preview = await call('get_preview', { view: VIEW, maxSize: 800 });
  const image = preview.content.find((block) => block.type === 'image');
  check('returns a preview image', Boolean(image), image ? `${Math.round((image.data.length * 3) / 4 / 1024)} KB` : '');
  check('keeps the proportions of the image in the preview', json(preview).width === 800 && json(preview).height === 600);
  if (image && previewPath) writeFileSync(previewPath, Buffer.from(image.data, 'base64'));

  const images = json(await call('list_images'));
  check('lists the image as modified', images.find((entry) => entry.view === VIEW)?.modified === true);

  const blocked = await call('close_image', { view: VIEW });
  check('does not discard unsaved changes on its own', blocked.isError === true && json(blocked).error === 'unsaved_changes');

  const undone = json(await call('undo', { view: VIEW }));
  check('undoes the change', undone.canRedo === true);

  if (keep) {
    await call('redo', { view: VIEW });
    console.log(`      --keep: leaving ${VIEW} open in PixInsight`);
  } else {
    const closed = await call('close_image', { view: VIEW, discardChanges: true });
    check('closes the test image when told to', !closed.isError);
  }
} finally {
  await client.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
