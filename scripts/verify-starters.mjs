/**
 * Verify the three built-in starter projects actually open and render.
 *
 * A starter project is only useful if it plays: this loads each one in the
 * render harness, renders a frame at several timestamps, and reports what it
 * found — clip count, effect count, keyframe count, audio connections and
 * whether the frames differ from each other (a static result would mean the
 * animation is not wired up).
 *
 * Usage: node scripts/verify-starters.mjs [--port 5451]
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserPage, findBrowser, findFreePort, sleep } from '../server/cdp.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = join(ROOT, 'workspace');
const portIndex = process.argv.indexOf('--port');
const PORT = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 5451;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

/**
 * @param {string} label
 * @param {boolean} condition
 * @param {string} [detail]
 */
function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${label}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  \u2717 ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

async function main() {
  const server = spawn(process.execPath, ['server/index.js', '--port', String(PORT)], {
    cwd: ROOT, stdio: 'ignore', windowsHide: true,
  });
  process.on('exit', () => { try { server.kill(); } catch { /* ignore */ } });
  await sleep(2500);

  const files = (await fs.readdir(join(WORKSPACE, 'projects')))
    // `.draft.json` files are autosave scratch, not projects, and carry no
    // `meta` block for the check below to read.
    .filter((name) => name.startsWith('proj_starter_') && name.endsWith('.json') && !name.includes('.draft.'))
    .sort();
  if (files.length === 0) {
    console.error('No starter projects found. Run: node scripts/make-starters.mjs');
    server.kill();
    process.exit(2);
  }

  const browser = findBrowser();
  const page = new BrowserPage({ profileDir: join(WORKSPACE, 'starters-chrome'), width: 1100, height: 800 });
  await page.launch(browser, await findFreePort(9960));
  await page.navigate(`${BASE}/harness.html`, 90000);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const ready = await page.evaluate(`typeof window.MotionLabHarness === 'object' && window.MotionLabHarness !== null`).catch(() => false);
    if (ready) break;
    await sleep(150);
  }

  for (const file of files) {
    const doc = JSON.parse(await fs.readFile(join(WORKSPACE, 'projects', file), 'utf8'));
    console.log(`\n\u25a0 ${doc.meta.name}`);

    const result = await page.evaluate(`(async () => {
      const { RenderContext, renderFrame } = await import('/core/render.js');
      const { buildMappingCurves } = await import('/core/audio.js');
      const { normalizeProject } = await import('/core/document.js');
      const { doc, issues } = normalizeProject(${JSON.stringify(doc)});
      const width = Math.round(doc.composition.width / 4);
      const height = Math.round(doc.composition.height / 4);
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const modulation = [...buildMappingCurves(doc, { rangeStart: 0, rangeEnd: doc.composition.duration }).values()];

      // Two harnesses: one per asset-lookup strategy. Procedural layers render
      // from the document alone, which is what this check exercises; media-backed
      // layers are covered by the export verification.
      const render = new RenderContext({ doc, width, height, modulation });
      const samples = [];
      for (const fraction of [0.05, 0.3, 0.55, 0.8]) {
        const time = doc.composition.duration * fraction;
        renderFrame(ctx, render, time);
        const data = ctx.getImageData(0, 0, width, height).data;
        let checksum = 0;
        for (let i = 0; i < data.length; i += 16) checksum = (checksum * 31 + data[i]) % 1000000007;
        samples.push({ time: Math.round(time * 100) / 100, checksum, debug: { ...render.debug } });
      }
      return {
        name: doc.meta.name,
        width: doc.composition.width,
        height: doc.composition.height,
        fps: doc.composition.fps,
        duration: doc.composition.duration,
        clips: doc.clips.length,
        effects: doc.clips.reduce((n, clip) => n + clip.effects.stack.length, 0),
        keyframes: doc.clips.reduce((n, clip) => n + clip.keyframes.reduce((m, channel) => m + channel.keys.length, 0), 0),
        masks: doc.clips.reduce((n, clip) => n + clip.masks.length, 0),
        mappings: doc.mappings.length,
        kinds: [...new Set(doc.clips.map((clip) => clip.kind))].sort(),
        issues: issues.filter((issue) => issue.level !== 'info').map((issue) => issue.message),
        samples,
        clipsDrawn: samples.map((sample) => sample.debug.clipsDrawn),
      };
    })()`, { awaitPromise: true, timeoutMs: 180000 });

    console.log(`    ${result.width}\u00d7${result.height} @ ${result.fps}fps, ${result.duration}s`);
    console.log(`    ${result.clips} clips (${result.kinds.join(', ')}), ${result.effects} effects, ${result.keyframes} keyframes, ${result.masks} masks, ${result.mappings} audio connections`);

    check('normalises without warnings', result.issues.length === 0, result.issues.join(' | '));
    check('has clips', result.clips >= 3, `${result.clips}`);
    check('has animation', result.keyframes >= 6, `${result.keyframes} keyframes`);
    check('draws something on every sample', result.clipsDrawn.every((count) => count > 0), `drawn: ${result.clipsDrawn.join(', ')}`);
    const distinct = new Set(result.samples.map((sample) => sample.checksum)).size;
    check('the rendered frames actually differ over time', distinct >= 2, `${distinct} distinct frames of ${result.samples.length}`);
  }

  await page.close();
  server.kill();
  console.log('\n=====================================');
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) for (const failure of failures) console.log(`  \u2022 ${failure}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Starter verification crashed:', error);
  process.exit(1);
});
