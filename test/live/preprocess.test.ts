import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunSnapshot } from '../../src/preprocessing/runs.js';
import { Refusal } from '../../src/session.js';
import { EXECUTABLE, PREPROCESS_SLOT, run, startLiveSession, type LiveSession } from './harness.js';

// Frames that are not square, so that a mixed-up width and height would show.
const WIDTH = 480;
const HEIGHT = 320;
const BIAS = 500;
const SKY = 1200;

/** How much light reaches a pixel: all of it in the middle, a little more than half in the corners. */
const vignette = (x: number, y: number): number => 1 - (0.45 * ((x - WIDTH / 2) ** 2 + (y - HEIGHT / 2) ** 2)) / ((WIDTH / 2) ** 2 + (HEIGHT / 2) ** 2);

/** The same numbers on every run, so that a failure can be repeated. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const STARS = (() => {
  const next = random(7);
  return Array.from({ length: 90 }, () => ({ x: 14 + next() * (WIDTH - 28), y: 14 + next() * (HEIGHT - 28), peak: 2500 + next() ** 3 * 40000 }));
})();

/** The light of the stars at a pixel of a frame that is shifted by a few pixels. */
function starlight(x: number, y: number, dx: number, dy: number): number {
  let sum = 0;
  for (const star of STARS) {
    const distance = (x - star.x - dx) ** 2 + (y - star.y - dy) ** 2;
    if (distance < 64) sum += star.peak * Math.exp(-distance / (2 * 1.6 ** 2));
  }
  return sum;
}

/** A FITS file with 16 bits per pixel, as a camera program writes it. */
async function writeFits(path: string, pixel: (x: number, y: number) => number, keywords: Record<string, string | number>): Promise<void> {
  const card = (name: string, value: string | number | boolean): string => {
    const text = typeof value === 'boolean' ? (value ? 'T' : 'F').padStart(20) : typeof value === 'number' ? String(value).padStart(20) : `'${value.padEnd(8)}'`;
    return `${name.padEnd(8)}= ${text}`.padEnd(80);
  };
  const cards = [card('SIMPLE', true), card('BITPIX', 16), card('NAXIS', 2), card('NAXIS1', WIDTH), card('NAXIS2', HEIGHT), card('BZERO', 32768), card('BSCALE', 1), ...Object.entries(keywords).map(([name, value]) => card(name, value)), 'END'.padEnd(80)];
  const header = Buffer.from(cards.join('').padEnd(Math.ceil((cards.length * 80) / 2880) * 2880), 'latin1');
  const data = Buffer.alloc(Math.ceil((WIDTH * HEIGHT * 2) / 2880) * 2880);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) data.writeInt16BE(Math.max(0, Math.min(65535, Math.round(pixel(x, y)))) - 32768, (y * WIDTH + x) * 2);
  await writeFile(path, Buffer.concat([header, data]));
}

interface Frames {
  bias: number;
  flats: number;
  /** How far each light is shifted against the first, in pixels. */
  lights: Array<[number, number]>;
  filter?: string;
}

/** Writes the frames of one night into a folder, each kind into a folder of its own. */
async function writeNight(dir: string, frames: Frames, seed: number): Promise<void> {
  const noise = random(seed);
  const common = { XBINNING: 1, YBINNING: 1, ...(frames.filter ? { FILTER: frames.filter } : {}) };
  for (const kind of ['BIAS', 'FLAT', 'LIGHT']) await mkdir(join(dir, kind), { recursive: true });
  for (let i = 0; i < frames.bias; i++) await writeFits(join(dir, 'BIAS', `bias_${i}.fits`), () => BIAS + (noise() - 0.5) * 16, { IMAGETYP: 'Bias Frame', EXPTIME: 0, XBINNING: 1, YBINNING: 1 });
  for (let i = 0; i < frames.flats; i++) await writeFits(join(dir, 'FLAT', `flat_${i}.fits`), (x, y) => BIAS + 30000 * vignette(x, y) + (noise() - 0.5) * 120, { IMAGETYP: 'Flat Field', EXPTIME: 2, ...common });
  for (const [i, [dx, dy]] of frames.lights.entries()) {
    await writeFits(join(dir, 'LIGHT', `light_${i}.fits`), (x, y) => BIAS + (SKY + starlight(x, y, dx, dy)) * vignette(x, y) + (noise() - 0.5) * 50, { IMAGETYP: 'Light Frame', EXPTIME: 60, ...common });
  }
}

const SHIFTS: Array<[number, number]> = [[0, 0], [2, 1], [-1, 2], [1, -2], [3, 0], [-2, -1]];
/** Patches of sky in the middle and in a corner, away from the edge that a registration cuts off. */
const MIDDLE = { x0: WIDTH / 2 - 40, y0: HEIGHT / 2 - 30, x1: WIDTH / 2 + 40, y1: HEIGHT / 2 + 30 };
const CORNER = { x0: 12, y0: 12, x1: 72, y1: 62 };

type Stats = { regions: Array<{ channels: Array<{ median: number }> }> };

describe.skipIf(!existsSync(EXECUTABLE))('preprocessing with WBPP in its automation mode', { timeout: 400_000 }, () => {
  let live: LiveSession;
  let data: string;

  const ended = async (id: string, timeoutMs = 300_000): Promise<RunSnapshot> => {
    const run = await live.session.preprocessing.wait(id, timeoutMs);
    if (!run?.done) throw new Error(`The run did not end in time: ${JSON.stringify(run)}`);
    return run;
  };
  /** How dark the sky is in a corner, against the middle. */
  const falloff = async (path: string, id: string): Promise<number> => {
    await run(live.session, 'open_image', { path, id });
    const stats = await run<Stats>(live.session, 'image_stats', { view: id, rects: [MIDDLE, CORNER] });
    await run(live.session, 'close_image', { view: id, discardChanges: true });
    return stats.regions[1]!.channels[0]!.median / stats.regions[0]!.channels[0]!.median;
  };
  const onRunSlots = async () => (await live.session.cli.enumerate())?.filter((instance) => instance.slot >= PREPROCESS_SLOT && instance.slot < PREPROCESS_SLOT + 3 && !instance.crashed) ?? [];

  beforeAll(async () => {
    live = await startLiveSession();
    data = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-live-frames-'));
    await writeNight(join(data, 'one'), { bias: 4, flats: 4, lights: SHIFTS, filter: 'L' }, 11);
    // Two nights for a keyword, the first of them without flats of its own.
    await writeNight(join(data, 'two', 'night_1'), { bias: 3, flats: 0, lights: SHIFTS.slice(0, 3), filter: 'L' }, 21);
    await writeNight(join(data, 'two', 'night_2'), { bias: 0, flats: 3, lights: SHIFTS.slice(3), filter: 'L' }, 22);
    // Calibration frames that belong to no night, and the lights of two.
    await writeNight(join(data, 'three', 'cal'), { bias: 3, flats: 3, lights: [], filter: 'L' }, 31);
    await writeNight(join(data, 'three', 'night_1'), { bias: 0, flats: 0, lights: SHIFTS.slice(0, 3), filter: 'L' }, 32);
    await writeNight(join(data, 'three', 'night_2'), { bias: 0, flats: 0, lights: SHIFTS.slice(3), filter: 'L' }, 33);
    await mkdir(join(data, 'empty'));
  }, 180_000);

  afterAll(async () => {
    // A test that failed half way leaves its run: a session does not end the runs it started.
    const left = await live?.session.preprocessing.current();
    if (left) {
      await live.session.preprocessing.cancel(left.id).catch(() => undefined);
      await live.session.preprocessing.wait(left.id, 30_000);
    }
    await live?.cleanup();
    await rm(data, { recursive: true, force: true });
  });

  it('calibrates, registers and integrates raw frames in an instance of its own, which is gone afterwards', async () => {
    const out = join(data, 'out-one');
    const started = await live.session.startPreprocessing({ inputs: [join(data, 'one')], outputDirectory: out, options: { platesolve: false } });
    expect(started).toMatchObject({ state: 'running', slot: PREPROCESS_SLOT });
    const done = await ended(started.id);
    expect(done.error).toBeUndefined();
    expect(done.state).toBe('succeeded');
    const result = done.value!;
    expect(result.summary[0]).toMatch(/^\d+ operation\(s\) completed, 0 failed, 0 canceled or not executed\.$/);
    // What each group was calibrated with, read from the report of WBPP.
    const lights = result.groups?.find((group) => /light/i.test(group.step));
    expect(lights).toMatchObject({ frames: expect.stringMatching(/^6 Light frames/), filter: 'L', masterBias: expect.stringMatching(/^masterBias/), masterFlat: expect.stringMatching(/^masterFlat/) });
    expect(result.groups?.find((group) => /flat generation/i.test(group.step))).toMatchObject({ frames: expect.stringMatching(/^4 Flat frames/), masterBias: expect.stringMatching(/^masterBias/) });
    expect(existsSync(result.log!)).toBe(true);
    expect(existsSync(result.report!)).toBe(true);
    // The frame that all lights were registered to, which is one of the calibrated ones.
    expect(result.registrationReferences).toHaveLength(1);
    expect(existsSync(result.registrationReferences![0]!)).toBe(true);

    // The real effect: a raw light is dark in the corners, and the master is not, so the flat was applied.
    const master = result.masters.find((path) => /masterLight/.test(path) && !/autocrop/.test(path));
    expect(master, `a master light among ${JSON.stringify(result.masters)}`).toBeDefined();
    expect(result.masters.every((path) => existsSync(path))).toBe(true);
    const raw = await falloff(join(data, 'one', 'LIGHT', 'light_0.fits'), 'mcp_raw_light');
    expect(raw).toBeGreaterThan(0.55);
    expect(raw).toBeLessThan(0.85);
    const flat = await falloff(master!, 'mcp_master_light');
    expect(flat).toBeGreaterThan(0.93);
    expect(flat).toBeLessThan(1.07);
    // The instance ended with the run, and the slot is free for the next one.
    expect(await onRunSlots()).toEqual([]);
  });

  it('keeps the frames of nights apart by a keyword from the path, and says which lights got no flat', async () => {
    const started = await live.session.startPreprocessing({ inputs: [join(data, 'two')], outputDirectory: join(data, 'out-two'), keywords: ['NIGHT'], options: { platesolve: false } });
    const done = await ended(started.id);
    expect(done.error).toBeUndefined();
    const lights = (done.value!.groups ?? []).filter((group) => /light/i.test(group.step));
    expect(lights.map((group) => [group.keywords, group.masterFlat === 'none' ? 'no flat' : 'flat']).sort()).toEqual([
      ['[NIGHT: 1]', 'no flat'],
      ['[NIGHT: 2]', 'flat'],
    ]);
  });

  it('takes a keyword with its mode behind a space, and then integrates each night by itself with the calibration of both', async () => {
    // The space goes through the launcher of PixInsight, which puts such an argument into quotes.
    const started = await live.session.startPreprocessing({ inputs: [join(data, 'two')], outputDirectory: join(data, 'out post'), keywords: ['NIGHT post'], options: { platesolve: false } });
    const done = await ended(started.id);
    expect(done.error).toBeUndefined();
    const result = done.value!;
    const lights = (result.groups ?? []).filter((group) => /light/i.test(group.step));
    expect(lights.length).toBeGreaterThan(0);
    for (const group of lights) expect(group.masterFlat, JSON.stringify(group)).toMatch(/^masterFlat/);
    // A master per night, and the real effect in both: the night without flats of its own is flat as well.
    const masters = result.masters.filter((path) => /masterLight/.test(path) && !/autocrop/.test(path));
    expect(masters.map((path) => /NIGHT-(\d)/.exec(path)?.[1]).sort(), JSON.stringify(result.masters)).toEqual(['1', '2']);
    for (const [index, master] of masters.entries()) {
      const flat = await falloff(master, `mcp_night_${index}`);
      expect(flat).toBeGreaterThan(0.93);
      expect(flat).toBeLessThan(1.07);
    }
  });

  it('gives calibration frames without a value for the keyword to every night, and takes a finished master as what it is', async () => {
    const started = await live.session.startPreprocessing({ inputs: [join(data, 'three')], outputDirectory: join(data, 'out-three'), keywords: ['NIGHT'], options: { platesolve: false } });
    const done = await ended(started.id);
    expect(done.error).toBeUndefined();
    const lights = (done.value!.groups ?? []).filter((group) => /light/i.test(group.step));
    expect(lights.map((group) => group.keywords).sort()).toEqual(['[NIGHT: 1]', '[NIGHT: 2]']);
    for (const group of lights) expect(group, JSON.stringify(group)).toMatchObject({ masterBias: expect.stringMatching(/^masterBias/), masterFlat: expect.stringMatching(/^masterFlat/) });
    // The real effect: the master of both nights is flat.
    const master = done.value!.masters.find((path) => /masterLight/.test(path) && !/autocrop/.test(path))!;
    const flat = await falloff(master, 'mcp_both_nights');
    expect(flat).toBeGreaterThan(0.93);
    expect(flat).toBeLessThan(1.07);

    // The master bias of that run, in place of the bias frames, and the frame it registered to, so that the masters of both runs lie on one another.
    const bias = done.value!.masters.find((path) => /masterBias/.test(path))!;
    expect(bias).toBeDefined();
    const [reference] = done.value!.registrationReferences!;
    const again = await live.session.startPreprocessing({
      inputs: [bias, join(data, 'three', 'cal', 'FLAT'), join(data, 'three', 'night_1'), join(data, 'three', 'night_2')],
      outputDirectory: join(data, 'out-three-master'),
      options: { platesolve: false, bestFrameReferenceMethod: 0, referenceImage: reference! },
    });
    const withMaster = await ended(again.id);
    expect(withMaster.error).toBeUndefined();
    const groups = withMaster.value!.groups ?? [];
    expect(groups.filter((group) => /bias generation/i.test(group.step))).toEqual([]);
    expect(withMaster.value!.masters.filter((path) => /masterBias/.test(path))).toEqual([]);
    const name = bias.slice(bias.lastIndexOf('/') + 1);
    expect(groups.find((group) => /flat generation/i.test(group.step))).toMatchObject({ masterBias: name });
    expect(groups.find((group) => /light/i.test(group.step))).toMatchObject({ frames: expect.stringMatching(/^6 Light frames/), masterBias: name, masterFlat: expect.stringMatching(/^masterFlat/) });
    expect(withMaster.value!.registrationReferences).toEqual([reference]);
  });

  it('says why WBPP does not start a run, and leaves nothing running', async () => {
    const started = await live.session.startPreprocessing({ inputs: [join(data, 'empty')], outputDirectory: join(data, 'out-empty') });
    const done = await ended(started.id, 120_000);
    expect(done).toMatchObject({ state: 'failed', error: { kind: 'not_started', message: expect.stringMatching(/not started.*No input frames/) } });
    const wrong = await live.session.startPreprocessing({ inputs: [join(data, 'one')], outputDirectory: join(data, 'out-wrong'), options: { platesolve: 'maybe' } });
    expect(await ended(wrong.id, 120_000)).toMatchObject({ state: 'failed', error: { kind: 'not_started', message: expect.stringMatching(/Invalid automation parameters/) } });
    expect(await onRunSlots()).toEqual([]);
  });

  it('runs one at a time, and stops a run by ending the instance of that run', async () => {
    const started = await live.session.startPreprocessing({ inputs: [join(data, 'one')], outputDirectory: join(data, 'out-stopped'), options: { platesolve: false } });
    await expect(live.session.startPreprocessing({ inputs: [join(data, 'one')], outputDirectory: join(data, 'out-second') })).rejects.toBeInstanceOf(Refusal);
    // Once WBPP is at work, which its log shows.
    const deadline = Date.now() + 120_000;
    while (!(await live.session.preprocessing.get(started.id))?.step && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await live.session.preprocessing.get(started.id))?.state).toBe('running');
    // The instance itself, which is a child of the launcher that the server started.
    const [instance] = await onRunSlots();
    expect(instance?.pid).toBeGreaterThan(0);
    expect(await live.session.preprocessing.cancel(started.id)).toBe('stopped');
    expect(await live.session.preprocessing.get(started.id)).toMatchObject({ state: 'cancelled', done: true });
    // Ending the group of the launcher ends the instance with it, and not the launcher alone.
    const gone = Date.now() + 20_000;
    while (live.session.cli.isRunning(instance!.pid!) && Date.now() < gone) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(live.session.cli.isRunning(instance!.pid!)).toBe(false);
    expect(await onRunSlots()).toEqual([]);
    // The worker of the session is untouched, and the next run finds its slot free.
    expect(await run<unknown[]>(live.session, 'list_images')).toEqual([]);
    const next = await live.session.startPreprocessing({ inputs: [join(data, 'empty')], outputDirectory: join(data, 'out-next') });
    expect(next.slot).toBe(PREPROCESS_SLOT);
    await ended(next.id, 120_000);
  });
});
