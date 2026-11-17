/**
 * Capture reference screenshots of the workspace.
 *
 * Useful after a styling change: it opens each starter project, waits for the
 * preview to settle, and writes a PNG of the whole window plus a close-up of the
 * composition, so the four-stage layout can be eyeballed without clicking
 * through the app by hand.
 *
 * Usage: node scripts/screenshots.mjs [--port 5461]
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserPage, findBrowser, findFreePort, sleep } from '../server/cdp.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = join(ROOT, 'workspace');
const SHOTS = join(ROOT, 'screenshots');
const portIndex = process.argv.indexOf('--port');
const PORT = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 5461;
const BASE = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1800, height: 1200 };

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  const server = spawn(process.execPath, ['server/index.js', '--port', String(PORT)], {
    cwd: ROOT, stdio: 'ignore', windowsHide: true,
  });
  process.on('exit', () => { try { server.kill(); } catch { /* ignore */ } });
  await sleep(2500);

  const page = new BrowserPage({ profileDir: join(WORKSPACE, 'shots-chrome'), width: VIEWPORT.width, height: VIEWPORT.height });
  await page.launch(findBrowser(), await findFreePort(9970));
  await page.navigate(`${BASE}/index.html`, 90000);

  const ready = async () => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const ok = await page.evaluate('Boolean(window.__motionLab && window.__motionLab.ready)').catch(() => false);
      if (ok) return true;
      await sleep(150);
    }
    return false;
  };
  if (!(await ready())) throw new Error('the editor never finished booting');

  /** @param {string} name @param {{x:number,y:number,width:number,height:number}} clip */
  const shoot = async (name, clip) => {
    const buffer = await page.captureClip(clip);
    await fs.writeFile(join(SHOTS, name), buffer);
    console.log(`  ${name}  ${(buffer.length / 1024).toFixed(0)} KB`);
  };

  const full = { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height };

  // Load each starter project in turn and photograph it.
  const projects = await page.evaluate(`(async () => (await (await fetch('/api/projects')).json()).projects)()`, { awaitPromise: true, timeoutMs: 30000 });
  const starters = projects.filter((project) => String(project.id).startsWith('proj_starter_'));
  if (starters.length === 0) throw new Error('No starter projects found. Run: node scripts/make-starters.mjs');
  for (const [index, starter] of starters.entries()) {
    await page.evaluate(`(async () => {
      const { store } = window.__motionLab;
      const response = await fetch('/api/projects/${starter.id}');
      const { doc } = await response.json();
      store.loadDocument(doc, { projectId: doc.meta.id });
      const { media } = window.__motionLab;
      await media.preloadDocument();
      window.__motionLab.preview.layout();
      window.__motionLab.preview.invalidate(true);
      window.__motionLab.timeline.rebuildHeads();
      window.__motionLab.timeline.fit();
    })()`, { awaitPromise: true, timeoutMs: 300000 });
    await sleep(1200);
    // Park the playhead somewhere interesting rather than at frame zero.
    await page.evaluate(`window.__motionLab.preview.seek(${(starter.duration * 0.35).toFixed(2)})`, { timeoutMs: 30000 });
    await sleep(1500);
    const slug = String(starter.name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await shoot(`workspace-${index + 1}-${slug}.png`, full);
  }

  // A close-up of the composition, the timeline and the media library. The
  // timeline crop is taller than the panel so it reaches the bottom of the
  // viewport even when the window is shorter than the browser's own viewport.
  await shoot('closeup-preview.png', { x: 280, y: 90, width: 1060, height: 510 });
  await shoot('closeup-timeline.png', { x: 0, y: 585, width: VIEWPORT.width, height: VIEWPORT.height - 585 });
  await shoot('closeup-library.png', { x: 0, y: 46, width: 280, height: 540 });

  await page.close();
  server.kill();
  console.log(`\nScreenshots written to ${SHOTS}`);
  process.exit(0);
}

main().catch((error) => {
  console.error('Screenshot run failed:', error);
  process.exit(1);
});
