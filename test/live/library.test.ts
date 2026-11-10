import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadLibrary, unknownParameters } from '../../src/guides.js';
import { EXECUTABLE, run, startLiveSession, type LiveSession } from './harness.js';

/**
 * Guides name parameters of processes, and those change between versions. A wrong name has cost a
 * real run each time, so every name in the library is checked against the PixInsight on this
 * machine. Processes that are not installed here cannot be checked, and are listed.
 */
describe.skipIf(!existsSync(EXECUTABLE))('the processing library against a real PixInsight', { timeout: 120_000 }, () => {
  let live: LiveSession;

  beforeAll(async () => {
    live = await startLiveSession();
    // Starting the instance takes longer than a quick lookup waits.
    await run(live.session, 'ping', {}, 90_000);
  }, 120_000);

  afterAll(async () => {
    await live?.cleanup();
  });

  it('names only parameters and constants that the installed processes have', async () => {
    const library = await loadLibrary([{ dir: resolve('processing'), builtIn: true }]);
    const wrong: string[] = [];
    const checked = new Set<string>();
    const notInstalled = new Set<string>();

    for (const guide of library.guides.values()) {
      const installation = await live.session.installation(guide.requires);
      expect(installation).not.toBeNull();
      for (const process of guide.requires) {
        if (!installation?.processes.has(process)) notInstalled.add(process);
        // A lookup that came too late must not pass for "not installed".
        else expect(installation.details.has(process), `${process} was not looked up`).toBe(true);
        if (installation?.details.has(process)) checked.add(process);
      }
      for (const name of unknownParameters(guide, installation)) wrong.push(`${guide.id}: ${name}`);
    }

    expect(wrong).toEqual([]);
    // The core processes are always there, so a run that checks nothing has gone wrong itself.
    expect([...checked]).toEqual(expect.arrayContaining(['HistogramTransformation', 'AutomaticBackgroundExtractor', 'Crop']));
    if (notInstalled.size) console.warn(`Not installed here, so not checked: ${[...notInstalled].join(', ')}`);
  });
});
