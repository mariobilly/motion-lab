/**
 * Before / after comparisons for a generated look set.
 *
 * For every output this produces a side-by-side pair — the untouched source
 * photograph on the left, the treated frame on the right — so the effect of each
 * recipe is legible at a glance. It also rebuilds:

 *   _meta/comparison-sheet.png    all pairs in one image
 *   _meta/comparison/<n>-<look>-vs-source.png   one full pair per look
 *   _meta/sources/<n>-<look>-source.png         the framed source on its own
 *
 * The "source" side is not the raw file: it is the same photograph put through
 * the same composition (same crop, same scale, same drift, same frame time) with
 * every treatment disabled. That makes the comparison honest — the only
 * difference between the two halves is the effect stack, not a different crop or
 * a different moment.
 *
 * Usage:
 *   node scripts/make-comparisons.mjs --source <folder of photos> [--dir <look set folder>]
 *
 * `--source` must be the folder the look set was generated from, and `--dir`
 * the folder `generate-looks.mjs` wrote to (default: Pictures\Motion Lab\look-set
 * in your user folder).
 */

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const SOURCE_DIR = arg('source');
if (!SOURCE_DIR) {
  console.error('Usage: node scripts/make-comparisons.mjs --source <folder of photos> [--dir <look set folder>]');
  process.exit(2);
}
const OUT_DIR = resolve(arg('dir', join(homedir(), 'Pictures', 'Motion Lab', 'look-set')));
const PORT = Number(arg('port', '5470'));
const BASE = `http://127.0.0.1:${PORT}`;
const FFMPEG = process.env.MOTION_LAB_FFMPEG || 'ffmpeg';

/* ------------------------------------------------------------------ *
 * The look table's base indices
 *
 * Only `base` is needed here, and the generator's own table is the source of
 * truth, so it is parsed out rather than duplicated. Each entry is a
 * `name`/`group`/`base` triple in source order.
 * ------------------------------------------------------------------ */

/**
 * @returns {Promise<Array<{name:string, base:number}>>}
 */
async function readLookTable() {
  const source = await fs.readFile(join(ROOT, 'scripts', 'generate-looks.mjs'), 'utf8');
  const start = source.indexOf('const LOOKS = [');
  const end = source.indexOf('\n];', start);
  const table = source.slice(start, end);
  /** @type {Array<{name:string, base:number}>} */
  const looks = [];
  for (const match of table.matchAll(/name: '([^']+)', group: '[^']+', base: (\d+)/g)) {
    looks.push({ name: match[1], base: Number(match[2]) });
  }
  return looks;
}

/**
 * Reproduce the generator's deterministic source pick.
 * @param {string} dir
 * @param {number} count
 * @returns {Promise<string[]>}
 */
async function pickSources(dir, count) {
  const files = (await fs.readdir(dir)).filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).sort();
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  for (const name of files) {
    const match = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(\d+)\./i.exec(name);
    const key = match ? match[1] : name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(name);
  }
  const sets = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  // The generator's deterministic shuffle, reproduced exactly so each output is
  // paired with the photograph it was actually built from.
  const shuffled = [...sets];
  let state = 0x2f6e2b1;
  const next = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return ((state >>> 0) % 1000000) / 1000000;
  };
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const swap = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = swap;
  }
  const chosen = [];
  for (let index = 0; index < count; index += 1) {
    const [, list] = shuffled[index % shuffled.length];
    const variant = list[Math.floor(index / shuffled.length) % list.length];
    chosen.push(join(dir, variant ?? list[0]));
  }
  return chosen;
}

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
function ffmpeg(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(FFMPEG, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise(code ?? -1));
  });
}

async function main() {
  const looks = await readLookTable();
  const outputs = (await fs.readdir(OUT_DIR)).filter((name) => /^[0-9]{2}-.+\.png$/.test(name)).sort();
  if (outputs.length === 0) {
    console.error(`No numbered outputs in ${OUT_DIR}`);
    process.exit(1);
  }
  console.log(`Motion Lab — before/after comparisons`);
  console.log(`  ${outputs.length} outputs in ${OUT_DIR}\n`);

  const sources = await pickSources(SOURCE_DIR, outputs.length);

  /* ---- health check ---- */
  try {
    await fetch(`${BASE}/api/health`);
  } catch {
    console.error(`No Motion Lab server on ${BASE}. Start it with:  node server/index.js --port ${PORT}`);
    process.exit(2);
  }

  const metaDir = join(OUT_DIR, '_meta');
  const pairDir = join(metaDir, 'comparison');
  const sourceDir = join(metaDir, 'sources');
  await fs.mkdir(pairDir, { recursive: true });
  await fs.mkdir(sourceDir, { recursive: true });

  /* ---- render an untreated version of every source ---- */
  console.log('\u25a0 Rendering the untreated frames');
  const { BrowserPage, findBrowser, findFreePort, sleep } = await import('../server/cdp.js');
  const page = new BrowserPage({ profileDir: join(ROOT, 'workspace', 'compare-chrome'), width: 1200, height: 800 });
  await page.launch(findBrowser(), await findFreePort(9880));
  try {
    await page.navigate(`${BASE}/harness.html`, 90000);
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const ready = await page.evaluate(`typeof window.MotionLabHarness === 'object' && window.MotionLabHarness !== null`).catch(() => false);
      if (ready) break;
      await sleep(150);
    }

    // Upload the sources so the export pipeline can serve them to the harness.
    /** @type {Array<{id:string, name:string, width:number, height:number}>} */
    const assets = [];
    for (const path of sources) {
      const data = await fs.readFile(path);
      const form = new FormData();
      form.append('file', new Blob([data]), basename(path));
      form.append('kindHint', 'image');
      const response = await fetch(`${BASE}/api/assets`, { method: 'POST', body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(`Upload failed: ${body?.error?.message ?? response.status}`);
      assets.push(body.assets[0]);
    }
    console.log(`  ${assets.length} source images ready`);

    const SLOT = 2;
    const bundle = {
      assets: assets.map((asset) => ({ id: asset.id, name: asset.name, width: asset.width, height: asset.height })),
      composition: { width: 1080, height: 1350, fps: 30, duration: outputs.length * SLOT, background: '#000000' },
      slot: SLOT,
      looks: looks.slice(0, outputs.length).map((look, index) => ({ name: look.name, base: look.base % assets.length, index })),
    };

    const doc = JSON.parse(await page.evaluate(`(async () => {
      const { createProject, defaultClip, neutralTransform } = await import('/core/schema.js');
      const { setKeyframe, easingPreset } = await import('/core/keyframes.js');
      const bundle = ${JSON.stringify(bundle).replace(/<\//g, '<\\/')};
      const doc = createProject({ name: 'Before/after sources' }, bundle.composition);
      doc.assets = bundle.assets.map((asset) => ({
        id: asset.id, kind: 'image', name: asset.name, fileName: asset.name,
        size: 0, mime: 'image/png', width: asset.width, height: asset.height,
        duration: 0, origin: 'library', status: 'ok', addedAt: new Date().toISOString(),
      }));
      const [overlay, main] = doc.tracks.filter((track) => track.kind === 'visual');
      doc.tracks = [overlay, main];
      for (const look of bundle.looks) {
        const start = look.index * bundle.slot;
        const asset = bundle.assets[look.base];
        const photo = defaultClip({
          name: look.name, kind: 'image', assetId: asset.id, trackId: main.id,
          start, duration: bundle.slot, seed: 100 + look.index,
        });
        // Identical framing and drift to the treated version: the only
        // difference between the two halves is the effect stack and the
        // overlays, so the comparison is honest.
        photo.transform = { ...neutralTransform(), scaleX: 1.04, scaleY: 1.04 };
        setKeyframe(photo, 'transform.scale.x', start, 1.02, easingPreset('Linear'));
        setKeyframe(photo, 'transform.scale.x', start + bundle.slot, 1.02 + 0.06 + (look.index % 5) * 0.012, easingPreset('Linear'));
        setKeyframe(photo, 'transform.scale.y', start, 1.02, easingPreset('Linear'));
        setKeyframe(photo, 'transform.scale.y', start + bundle.slot, 1.02 + 0.06 + (look.index % 5) * 0.012, easingPreset('Linear'));
        setKeyframe(photo, 'transform.position.x', start, -18, easingPreset('Linear'));
        setKeyframe(photo, 'transform.position.x', start + bundle.slot, 18, easingPreset('Linear'));
        doc.clips.push(photo);
      }
      return JSON.stringify(doc);
    })()`, { awaitPromise: true, timeoutMs: 300000 }));

    const items = outputs.map((name, index) => ({ time: index * SLOT + SLOT / 2, fileName: `${String(index + 1).padStart(2, '0')}-source.png` }));
    const { job } = await (await fetch(`${BASE}/api/exports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        doc, kind: 'stills', items,
        width: 1080, height: 1350, fps: 30,
        rangeStart: 0, rangeEnd: doc.composition.duration,
        fileName: 'sources',
      }),
    })).json();

    for (;;) {
      const { job: current } = await (await fetch(`${BASE}/api/exports/${job.id}`)).json();
      if (['done', 'failed', 'cancelled'].includes(current.status)) {
        if (current.status !== 'done') {
          console.error(`  export failed: ${current.error ?? current.status}`);
          process.exit(1);
        }
        break;
      }
      await sleep(500);
    }

    const rendered = join(ROOT, 'workspace', 'exports', job.id, 'out');
    const files = (await fs.readdir(rendered)).filter((name) => name.endsWith('.png')).sort();
    console.log(`  ${files.length} untreated frames rendered`);
    for (const name of files) await fs.copyFile(join(rendered, name), join(sourceDir, name));

    /* ---- build the pairs ---- */
    console.log('\n\u25a0 Building pairs');
    /** @type {string[]} */
    const pairs = [];
    for (const [index, output] of outputs.entries()) {
      const sourceName = `${String(index + 1).padStart(2, '0')}-source.png`;
      const sourcePath = join(sourceDir, sourceName);
      if (!(await exists(sourcePath))) continue;
      const pairPath = join(pairDir, `${output.replace(/\.png$/, '')}-vs-source.png`);
      const code = await ffmpeg([
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', sourcePath, '-i', join(OUT_DIR, output),
        '-filter_complex',
        // A thin divider so the two halves read as one comparison rather than
        // two photographs that happen to be adjacent.
        '[0:v]pad=iw+6:ih:0:0:color=0x5ce1ff[a];[a][1:v]hstack=inputs=2[out]',
        '-map', '[out]', '-frames:v', '1', pairPath,
      ]);
      if (code === 0) pairs.push(pairPath);
      if ((index + 1) % 10 === 0) process.stdout.write(`  ${index + 1}/${outputs.length} pairs\r`);
    }
    console.log(`  ${pairs.length} pairs written`);

    /* ---- one sheet with every pair ---- */
    console.log('\n\u25a0 Building the comparison sheet');
    const listPath = join(metaDir, 'pairs.txt');
    await fs.writeFile(listPath, pairs.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    const sheet = join(metaDir, 'comparison-sheet.png');
    const columns = 2;
    const rows = Math.ceil(pairs.length / columns);
    const tileWidth = 720;
    const tileHeight = Math.round((tileWidth / 2) * (1350 / 1080) * 2 * 0.5) + 0;
    const code = await ffmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-vf', `scale=${tileWidth}:-2,tile=${columns}x${rows}:margin=12:padding=8:color=0x08080c`,
      '-frames:v', '1', sheet,
    ]);
    await fs.rm(listPath, { force: true }).catch(() => {});
    if (code === 0) {
      const stat = await fs.stat(sheet);
      console.log(`  _meta/comparison-sheet.png  ${columns}x${rows} pairs, ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
    } else {
      console.log('  ! comparison sheet failed');
    }
    void tileHeight;

    /* ---- written summary ---- */
    const lines = [
      '# Before / after — Motion Lab look set',
      '',
      'Every pair shows the same photograph at the same moment with the same framing:',
      'the left half has the effect stack disabled, the right half is the finished output.',
      'The only difference between the halves is the treatment.',
      '',
      '- `comparison-sheet.png` — every pair in one image',
      '- `comparison/<n>-<look>-vs-source.png` — one full pair per look',
      '- `sources/<n>-source.png` — the untreated frame on its own',
      '',
      '| # | Look | Pair | Source |',
      '| --- | --- | --- | --- |',
    ];
    for (const [index, output] of outputs.entries()) {
      const look = looks[index];
      lines.push(`| ${index + 1} | ${look ? look.name : output} | comparison/${output.replace(/\.png$/, '')}-vs-source.png | sources/${String(index + 1).padStart(2, '0')}-source.png |`);
    }
    lines.push('');
    await fs.writeFile(join(metaDir, 'comparisons.md'), lines.join('\n'), 'utf8');
    console.log('  _meta/comparisons.md');
  } finally {
    await page.close();
  }

  console.log(`\nDone. Comparisons in ${pairDir}`);
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error('\nComparison build failed:', error);
  process.exit(1);
});
