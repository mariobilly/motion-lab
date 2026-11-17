/**
 * Isolate what each effect in a look is doing to the frame.
 *
 * Renders one look's source with progressively more of its stack enabled and
 * reports the mean luminance at each step, so a recipe that crushes the picture
 * can be pinned on a specific effect rather than guessed at.
 *
 * Usage: node scripts/diagnose-look.mjs --source <folder of photos> --look 32 [--port 5470]
 *
 * `--source` must be the folder the look set was generated from, so the look is
 * paired with the same photograph `generate-looks.mjs` used.
 */

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserPage, findBrowser, findFreePort, sleep } from '../server/cdp.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const LOOK_INDEX = Number(arg('look', '32'));
const sourceDirArg = arg('source');
if (!sourceDirArg) {
  console.error('Usage: node scripts/diagnose-look.mjs --source <folder of photos> --look 32 [--port 5470]');
  process.exit(2);
}
const PORT = Number(arg('port', '5470'));
const BASE = `http://127.0.0.1:${PORT}`;

/* ---- read the look table and the source pick ---- */
const generator = await fs.readFile(join(ROOT, 'scripts', 'generate-looks.mjs'), 'utf8');
const table = generator.slice(generator.indexOf('const LOOKS = ['), generator.indexOf('\n];', generator.indexOf('const LOOKS = [')));

/**
 * Parse one look's stack out of the source table.
 * @param {number} oneBased
 */
function parseLook(oneBased) {
  const entries = [...table.matchAll(/\{ name: '([^']+)', group: '([^']+)', base: (\d+),[^]*?\n?\s*stack: \[([^\]]*)\]/g)];
  const entry = entries[oneBased - 1];
  if (!entry) return null;
  const stack = [...entry[4].matchAll(/\{ type: '(\w+)', params: (\{.*?\}) \}/g)].map((match) => ({
    type: match[1],
    params: JSON.parse(match[2].replace(/([{,]\s*)([a-zA-Z]+):/g, '$1"$2":').replace(/'/g, '"')),
  }));
  return { name: entry[1], group: entry[2], base: Number(entry[3]), stack };
}

const look = parseLook(LOOK_INDEX);
if (!look) {
  console.error(`No look ${LOOK_INDEX} in the table`);
  process.exit(1);
}
console.log(`Look ${LOOK_INDEX}: ${look.name} (${look.group})`);
for (const [index, effect] of look.stack.entries()) {
  console.log(`  ${index + 1}. ${effect.type}  ${JSON.stringify(effect.params)}`);
}

/* ---- find the source --- */
const files = (await fs.readdir(sourceDirArg)).filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).sort();
/** @type {Map<string, string[]>} */
const groups = new Map();
for (const name of files) {
  const match = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(\d+)\./i.exec(name);
  const key = match ? match[1] : name;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(name);
}
const sets = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
let state = 0x2f6e2b1;
const next = () => {
  state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
  return ((state >>> 0) % 1000000) / 1000000;
};
for (let i = sets.length - 1; i > 0; i -= 1) {
  const j = Math.floor(next() * (i + 1));
  const swap = sets[i];
  sets[i] = sets[j];
  sets[j] = swap;
}
const [, list] = sets[look.base % sets.length];
const sourceName = list[Math.floor(look.base / sets.length) % list.length] ?? list[0];
const sourcePath = join(sourceDirArg, sourceName);

/* ---- upload and render every prefix of the stack ---- */
const data = await fs.readFile(sourcePath);
const form = new FormData();
form.append('file', new Blob([data]), sourceName);
form.append('kindHint', 'image');
const uploaded = await (await fetch(`${BASE}/api/assets`, { method: 'POST', body: form })).json();
const asset = uploaded.assets[0];
console.log(`\nsource: ${sourceName}  (${asset.width}x${asset.height})`);

const page = new BrowserPage({ profileDir: join(ROOT, 'workspace', 'diagnose-chrome'), width: 1000, height: 700 });
await page.launch(findBrowser(), await findFreePort(9890));
try {
  await page.navigate(`${BASE}/harness.html`, 90000);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const ready = await page.evaluate(`typeof window.MotionLabHarness === 'object'`).catch(() => false);
    if (ready) break;
    await sleep(150);
  }

  // Load a one-clip session so the harness decodes the source image; the probe
  // then borrows that decoded image for every variant it renders.
  const session = {
    projectId: 'diagnose',
    doc: {
      format: 'motion-lab',
      version: 4,
      meta: { id: 'diagnose', name: 'diagnose', createdAt: 0, updatedAt: 0 },
      composition: { width: 540, height: 675, fps: 30, duration: 2, background: '#000000', aspect: 'portrait' },
      assets: [{ id: asset.id, kind: 'image', name: sourceName, fileName: sourceName, size: 0, mime: 'image/png', width: asset.width, height: asset.height, duration: 0, origin: 'library', status: 'ok', addedAt: '' }],
      folders: [], compositions: [], audio: {}, mappings: [], audioSettings: {}, presets: [],
      exportRange: { in: 0, out: 2 }, loopRange: { in: 0, out: 2 },
      timeline: { snap: true, snapToMarkers: true, zoom: 42, scroll: 0 }, notes: [],
      tracks: [{ id: 'track_main', name: 'Main', kind: 'visual', muted: false, solo: false, locked: false, hidden: false, height: 70, volume: 1, collapsed: false }],
      clips: [{
        id: 'clip_1', name: 'source', kind: 'image', trackId: 'track_main', start: 0, duration: 2, inPoint: 0,
        transform: { x: 0, y: 0, scaleX: 1.04, scaleY: 1.04, rotation: 0, opacity: 1, anchorX: 0.5, anchorY: 0.5, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 },
        blend: 'normal', volume: 1, pan: 0, fadeIn: 0, fadeOut: 0,
        effects: { enabled: true, stack: [] }, masks: [], keyframes: [], seed: 1,
      }],
    },
    options: {
      width: 540, height: 675, fps: 30, rangeStart: 0, rangeEnd: 2, frameCount: 60,
      assets: { [asset.id]: { kind: 'image', url: `/api/assets/${asset.id}/file`, width: asset.width, height: asset.height } },
      modulation: [],
    },
  };
  const loaded = await page.evaluate(`window.MotionLabHarness.load(${JSON.stringify(session)})`, { awaitPromise: true, timeoutMs: 180000 });
  if (!loaded?.ok) throw new Error(`harness could not load the probe session: ${loaded?.error ?? 'unknown'}`);
  console.log('probe session loaded');

  /** The harness can render arbitrary documents, so the document is rebuilt
   * here at 540x675 with a chosen number of effects enabled. */
  const measure = async (/** @type {number} */ count) => page.evaluate(`(async () => {
    const { createProject, defaultClip, neutralTransform, uid } = await import('/core/schema.js');
    const { defaultParams } = await import('/core/effectRegistry.js');
    const { RenderContext, renderFrame } = await import('/core/render.js');
    const stack = ${JSON.stringify(look.stack)}.slice(0, ${count});

    // The harness holds the decoded image; borrow its FrameSource rather than
    // building one here, which is what an earlier version of this probe got
    // wrong -- it rendered an empty raster and reported a flat 10.4 mean.
    const session = window.MotionLabHarness.state;
    if (!session) throw new Error('the harness has no session loaded -- pass a job id or session JSON');
    const frameSource = session.render.frameSource;

    const doc = createProject({ name: 'diag' }, { width: 540, height: 675, fps: 30, duration: 2 });
    const track = doc.tracks.find((t) => t.kind === 'visual');
    doc.tracks = [track];
    const clip = defaultClip({ name: 'look', kind: 'image', assetId: ${JSON.stringify(asset.id)}, trackId: track.id, start: 0, duration: 2 });
    clip.transform = { ...neutralTransform(), scaleX: 1.04, scaleY: 1.04 };
    for (const effect of stack) {
      clip.effects.stack.push({ id: uid('fx'), type: effect.type, enabled: true, seed: 900, params: { ...defaultParams(effect.type), ...effect.params } });
    }
    doc.clips.push(clip);

    const canvas = document.createElement('canvas');
    canvas.width = 540; canvas.height = 675;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const render = new RenderContext({ doc, width: 540, height: 675, frameSource });
    renderFrame(ctx, render, 1.0);
    const pixels = ctx.getImageData(0, 0, 540, 675).data;
    let sum = 0, n = 0, min = 255, max = 0, ink = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const l = pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722;
      sum += l; n += 1;
      if (l < min) min = l;
      if (l > max) max = l;
      if (l < 90) ink += 1;
    }
    return { mean: sum / n, min, max, inkFraction: ink / n, passes: render.debug.effectPasses, drawn: render.debug.clipsDrawn };
  })()`, { awaitPromise: true, timeoutMs: 120000 });

  console.log('\nstack prefix                      mean   min   max   dark%  passes');
  for (let count = 0; count <= look.stack.length; count += 1) {
    const result = await measure(count);
    const label = count === 0 ? '(no effects)' : look.stack.slice(0, count).map((effect) => effect.type).join('+');
    console.log(
      `${label.padEnd(32)} ${result.mean.toFixed(1).padStart(5)} ${String(result.min).padStart(5)} ${String(result.max).padStart(5)} ${(result.inkFraction * 100).toFixed(1).padStart(6)} ${String(result.passes).padStart(6)}`,
    );
  }
} finally {
  await page.close();
}
process.exit(0);
