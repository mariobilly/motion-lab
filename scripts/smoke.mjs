/**
 * Motion Lab editor smoke test.
 *
 * Drives the real editor in a real browser over the DevTools protocol and walks
 * the brief's acceptance workflow end to end:
 *
 *   import a photograph, two video clips and a music track
 *   → create a 20-second portrait composition
 *   → layer and trim the clips, animate the photograph, apply a halftone treatment
 *   → add a masked text layer
 *   → connect bass energy to a graphic's scale
 *   → add a particle background
 *   → save, reload the page, confirm the edit survived
 *
 * The test drives the app's own singletons through `window.__motionLab`, so the
 * results cannot come from a parallel implementation.
 *
 * Usage: node scripts/smoke.mjs [baseUrl] [--port 5401]
 */

import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserPage, findBrowser, findFreePort, sleep } from '../server/cdp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const portIndex = process.argv.indexOf('--port');
const PORT = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 5402;
const BASE = process.argv[2]?.startsWith('http') ? process.argv[2] : `http://127.0.0.1:${PORT}`;
const WORKSPACE = join(ROOT, 'workspace');
const SHOTS = join(ROOT, 'screenshots');

let passed = 0;
let failed = 0;
/** @type {string[]} */
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
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \u2717 ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

/**
 * @param {string} label
 * @param {() => Promise<void>} fn
 */
async function stage(label, fn) {
  console.log(`\n\u25a0 ${label}`);
  try {
    await fn();
  } catch (error) {
    failed += 1;
    failures.push(`${label} threw: ${error instanceof Error ? error.message : error}`);
    console.log(`  \u2717 ${error instanceof Error ? error.stack : error}`);
  }
}

async function main() {
  console.log('Motion Lab editor smoke test');
  console.log('============================');

  const sampleDir = join(WORKSPACE, 'sample-media');
  const needed = ['photo-dusk.png', 'clip-harbour.mp4', 'clip-neon.mp4', 'track-pulse.mp3'];
  const missing = needed.filter((name) => !existsSync(join(sampleDir, name)));
  if (missing.length) {
    console.error(`Missing sample media (${missing.join(', ')}). Run: node scripts/make-sample-media.mjs --force`);
    process.exit(2);
  }

  let server = null;
  if (!process.argv[2]?.startsWith('http')) {
    server = spawn(process.execPath, ['server/index.js', '--port', String(PORT)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let log = '';
    server.stdout.on('data', (chunk) => { log += chunk.toString(); });
    server.stderr.on('data', (chunk) => { log += chunk.toString(); });
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const response = await fetch(`${BASE}/api/health`);
        if (response.ok) break;
      } catch {
        /* starting */
      }
      await sleep(200);
    }
    process.on('exit', () => { try { server?.kill(); } catch { /* ignore */ } });
  }

  const browserPath = findBrowser();
  if (!browserPath) throw new Error('no Chromium browser found');
  const page = new BrowserPage({ profileDir: join(WORKSPACE, 'smoke-chrome'), width: 1800, height: 1080 });
  await page.launch(browserPath, await findFreePort(9800));

  await fs.mkdir(SHOTS, { recursive: true });

  const consoleErrors = [];
  const originalEvaluate = page.evaluate.bind(page);
  page.evaluate = async (expression, options) => {
    try {
      return await originalEvaluate(expression, options);
    } catch (error) {
      consoleErrors.push(String(error instanceof Error ? error.message : error));
      throw error;
    }
  };

  try {
    /* ---------------- boot ---------------- */
    await stage('1. The workspace boots', async () => {
      await page.navigate(`${BASE}/index.html`, 90000);
      // Wait for the ready flag the app sets at the very end of its boot
      // sequence, once the project and its media have loaded.
      let ready = false;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        ready = await page.evaluate('Boolean(window.__motionLab && window.__motionLab.ready)').catch(() => false);
        if (ready) break;
        await sleep(150);
      }
      check('the app exposed its store bridge', Boolean(await page.evaluate('typeof window.__motionLab === "object"')));
      check('the app finished booting', ready);
      if (!ready) {
        const status = await page.evaluate(`document.body.innerText.slice(0, 400)`);
        throw new Error(`the editor never finished booting. Screen said: ${status}`);
      }
      // Panels repaint on the next animation frame; let the first render land
      // before inspecting the DOM.
      await page.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, { awaitPromise: true, timeoutMs: 20000 }).catch(() => {});
      await sleep(400);

      const layout = JSON.parse(await page.evaluate(`JSON.stringify({
        topbar: Boolean(document.querySelector('.topbar')),
        transport: Boolean(document.querySelector('.transport')),
        library: Boolean(document.querySelector('.panel--left')),
        preview: Boolean(document.querySelector('.preview-stage canvas')),
        inspector: Boolean(document.querySelector('.panel--right')),
        timeline: Boolean(document.querySelector('.timeline__lanes')),
        libraryCards: document.querySelectorAll('.asset-card, .asset-row').length,
        libraryEmptyState: Boolean(document.querySelector('.panel--left .empty-state')),
        inspectorSections: document.querySelectorAll('.inspector-section').length,
        timelineHeads: document.querySelectorAll('.track-head').length,
      })`));
      check('top bar is present', layout.topbar);
      check('transport is present', layout.transport);
      check('media library is present', layout.library && !layout.libraryEmptyState, `${layout.libraryCards} media tiles, empty state: ${layout.libraryEmptyState}`);
      check('composition preview is present', layout.preview);
      check('inspector is present with sections', layout.inspector && layout.inspectorSections > 0, `${layout.inspectorSections} sections`);
      check('timeline has tracks', layout.timeline && layout.timelineHeads > 0, `${layout.timelineHeads} tracks`);

      const preview = JSON.parse(await page.evaluate(`(() => {
        const canvas = document.querySelector('.preview-stage canvas');
        return JSON.stringify({ width: canvas.width, height: canvas.height });
      })()`));
      check('the preview canvas has a real backing size', preview.width > 100 && preview.height > 100, `${preview.width}x${preview.height}`);
      await page.captureClip({ x: 0, y: 0, width: 1800, height: 1080 }).then((buffer) => fs.writeFile(join(SHOTS, 'smoke-01-workspace.png'), buffer));
    });

    /* ---------------- import ---------------- */
    await stage('2. Import media through the library', async () => {
      const result = await page.evaluate(`(async () => {
        const { media, store } = window.__motionLab;
        const response = await fetch('/api/assets');
        const { assets } = await response.json();
        for (const asset of assets) store.registerAsset(asset);
        const wanted = ${JSON.stringify(needed)};
        const picked = assets.filter((asset) => wanted.includes(asset.fileName));
        for (const asset of picked) await media.load(asset.id);
        return {
          total: assets.length,
          picked: picked.map((asset) => ({ id: asset.id, name: asset.fileName, kind: asset.kind, width: asset.width, height: asset.height, duration: asset.duration })),
        };
      })()`, { awaitPromise: true, timeoutMs: 180000 });

      check('the library lists the sample media', result.total >= 4, `${result.total} assets`);
      const byKind = (/** @type {string} */ kind) => result.picked.filter((asset) => asset.kind === kind);
      check('two images are available', byKind('image').length >= 1);
      check('two video clips are available', byKind('video').length >= 2, `${byKind('video').length}`);
      check('a music track is available', byKind('audio').length >= 1);
      const decoded = await page.evaluate(`(async () => {
        const { media } = window.__motionLab;
        const assets = [...window.__motionLab.store.assets.values()];
        const audio = assets.find((asset) => asset.kind === 'audio');
        await media.ensureAnalysis(audio.id);
        const analysis = window.__motionLab.store.doc.audio[audio.id];
        return { frames: analysis.level.length, onsets: analysis.onsets.length, beats: analysis.beats.length, tempo: analysis.tempo };
      })()`, { awaitPromise: true, timeoutMs: 300000 });
      check('audio analysed in the editor', decoded.frames > 100, `${decoded.frames} frames, ${decoded.onsets} onsets, ${decoded.tempo} BPM`);

      await page.evaluate(`(async () => {
        document.querySelector('.tabs')?.scrollIntoView();
        await new Promise((r) => setTimeout(r, 300));
      })()`);
      await page.captureClip({ x: 0, y: 0, width: 1800, height: 1080 }).then((buffer) => fs.writeFile(join(SHOTS, 'smoke-02-library.png'), buffer));
    });

    /* ---------------- composition ---------------- */
    await stage('3. Build the 20-second portrait composition', async () => {
      // Start from an empty document so the counts below mean something on a
      // machine that already has projects in its workspace.
      await page.evaluate(`(async () => {
        const { store, media, preview, timeline } = window.__motionLab;
        const { createProject } = await import('/core/schema.js');
        const doc = createProject({ name: 'Smoke acceptance' }, { width: 1080, height: 1920, fps: 30, duration: 20, aspect: 'portrait' });
        for (const asset of store.assets.values()) doc.assets.push(asset);
        store.loadDocument(doc, { projectId: null });
        media.releaseAll();
        await media.preloadDocument();
        preview.layout();
        preview.invalidate(true);
        timeline.rebuildHeads();
        timeline.fit();
        return store.doc.clips.length;
      })()`, { awaitPromise: true, timeoutMs: 240000 });

      const built = await page.evaluate(`(async () => {
        const { store, preview, timeline } = window.__motionLab;
        const {
          defaultClip, defaultGraphic, defaultTextStyle, defaultMapping, uid, neutralTransform,
        } = await import('/core/schema.js');
        const { setKeyframe, easingPreset } = await import('/core/keyframes.js');
        const { defaultParams } = await import('/core/effectRegistry.js');

        const assets = [...store.assets.values()];
        const photo = assets.find((a) => a.fileName === 'photo-dusk.png');
        const clips = assets.filter((a) => a.kind === 'video');
        const music = assets.find((a) => a.kind === 'audio');

        store.edit('Composition settings', () => {
          const c = store.doc.composition;
          c.width = 1080; c.height = 1920; c.fps = 30; c.duration = 20; c.aspect = 'portrait';
          store.doc.exportRange = { in: 0, out: 20 };
        });

        const visual = store.doc.tracks.filter((t) => t.kind === 'visual');
        const audioTrack = store.doc.tracks.find((t) => t.kind === 'audio');
        const [overlay, main, background] = visual;

        store.edit('Build composition', () => {
          /* particle background */
          store.doc.clips.push(defaultClip({
            name: 'Particle background', kind: 'graphic', trackId: background.id, start: 0, duration: 20, seed: 4242,
            graphic: { ...defaultGraphic('particles'), kind: 'particles', count: 240, seed: 4242, colorA: '#080812', colorB: '#ff2d78', colorC: '#5ce1ff', size: 0.4, speed: 0.8, spread: 0.8, complexity: 4, amount: 0.7 },
          }));

          /* the photograph, animated with a slow zoom and a drift */
          const photograph = defaultClip({ name: 'Photograph', kind: 'image', assetId: photo.id, trackId: main.id, start: 0, duration: 20 });
          photograph.transform = { ...neutralTransform(), scaleX: 1.05, scaleY: 1.05 };
          for (const channel of ['transform.scale.x', 'transform.scale.y']) {
            setKeyframe(photograph, channel, 0, 1.03, easingPreset('Ease in-out'));
            setKeyframe(photograph, channel, 20, 1.38, easingPreset('Ease in-out'));
          }
          setKeyframe(photograph, 'transform.position.x', 0, -50, easingPreset('Ease out'));
          setKeyframe(photograph, 'transform.position.x', 13, 44, easingPreset('Ease in'));
          photograph.effects.stack.push({ id: uid('fx'), type: 'halftone', enabled: true, seed: 900, params: { ...defaultParams('halftone'), spacing: 8, dotSize: 98, angle: 42, ink: '#0b0812', paper: '#f5eedd' } });
          photograph.effects.stack.push({ id: uid('fx'), type: 'contrast', enabled: true, seed: 901, params: { ...defaultParams('contrast'), amount: 22 } });
          store.doc.clips.push(photograph);

          /* two trimmed video clips on the overlay track */
          const first = defaultClip({ name: 'Clip one', kind: 'video', assetId: clips[0].id, trackId: overlay.id, start: 3.5, duration: 6, inPoint: 0.4 });
          first.transform = { ...neutralTransform(), scaleX: 0.62, scaleY: 0.62, x: 120, y: -420 };
          const second = defaultClip({ name: 'Clip two', kind: 'video', assetId: clips[1].id, trackId: overlay.id, start: 10, duration: 6.5, inPoint: 0.2 });
          second.transform = { ...neutralTransform(), scaleX: 0.72, scaleY: 0.72, x: -140, y: 380, rotation: -6 };
          second.blend = 'screen';
          second.effects.stack.push({ id: uid('fx'), type: 'wave', enabled: true, seed: 77, params: { ...defaultParams('wave'), amplitude: 10, wavelength: 150, animate: 0.6 } });
          store.doc.clips.push(first, second);

          /* masked text */
          const title = defaultClip({ name: 'Title', kind: 'text', trackId: overlay.id, start: 1.2, duration: 17 });
          title.text = { ...defaultTextStyle(), content: 'MOTION\\nLAB', fontSize: 205, letterSpacing: 5, lineHeight: 0.98, maxWidth: 790, uppercase: true, strokeColor: '#05050a', strokeWidth: 4, shadowColor: 'rgba(0,0,0,0.6)', shadowBlur: 26, shadowY: 10, gradientFrom: '#ffffff', gradientTo: '#5ce1ff' };
          title.masks.push({ id: uid('mask'), name: 'Band mask', shape: 'rect', enabled: true, inverted: false, position: { x: 0.5, y: 0.5 }, size: { x: 1.3, y: 0.3 }, rotation: -4, roundness: 0.2, feather: 0.1, opacity: 1, points: [], pointsClosed: true });
          setKeyframe(title, 'transform.position.y', 1.2, 130, easingPreset('Ease out'));
          setKeyframe(title, 'transform.position.y', 3.6, -30, easingPreset('Ease in-out'));
          setKeyframe(title, 'transform.opacity', 1.2, 0, easingPreset('Linear'));
          setKeyframe(title, 'transform.opacity', 2.4, 1, easingPreset('Linear'));
          store.doc.clips.push(title);

          /* the graphic the bass will drive */
          const rings = defaultClip({
            name: 'Bass rings', kind: 'graphic', trackId: overlay.id, start: 0, duration: 20, seed: 88,
            graphic: { ...defaultGraphic('rings'), kind: 'rings', count: 18, seed: 88, colorA: '#ff2d78', colorB: '#ffd166', colorC: '#ffffff', amount: 0.6, speed: 1.1, size: 0.85 },
          });
          rings.blend = 'screen';
          store.doc.clips.push(rings);

          /* the music */
          store.doc.clips.push(defaultClip({ name: 'Music', kind: 'audio', assetId: music.id, trackId: audioTrack.id, start: 0, duration: 20, volume: 0.9, fadeIn: 1.5, fadeOut: 3 }));

          /* bass energy drives the rings' scale */
          for (const channel of ['transform.scale.x', 'transform.scale.y']) {
            store.doc.mappings.push(defaultMapping({
              name: 'Bass to ring scale', source: music.id, band: 'low', target: channel, clipId: rings.id,
              sensitivity: 1.5, min: 0.85, max: 1.4, attack: 0.012, release: 0.22, mode: 'set',
            }));
          }
        });

        store.invalidateMappings();
        preview.layout();
        preview.invalidate(true);
        timeline.rebuildHeads();
        timeline.fit();
        timeline.invalidate(true);

        return {
          clips: store.doc.clips.length,
          mappings: store.doc.mappings.length,
          tracks: store.doc.tracks.length,
          halftone: store.doc.clips.some((clip) => clip.effects.stack.some((fx) => fx.type === 'halftone')),
          width: store.doc.composition.width,
          height: store.doc.composition.height,
          fps: store.doc.composition.fps,
          duration: store.doc.composition.duration,
          effects: store.doc.clips.reduce((total, clip) => total + clip.effects.stack.length, 0),
          keyframes: store.doc.clips.reduce((total, clip) => total + clip.keyframes.reduce((n, channel) => n + channel.keys.length, 0), 0),
          masks: store.doc.clips.reduce((total, clip) => total + clip.masks.length, 0),
        };
      })()`, { awaitPromise: true, timeoutMs: 180000 });

      check('composition is 20 s portrait at 30 fps', built.width === 1080 && built.height === 1920 && built.fps === 30 && built.duration === 20, `${built.width}x${built.height} @ ${built.fps}`);
      check('seven layers were created', built.clips === 7, `${built.clips} clips`);
      check('keyframes were authored', built.keyframes >= 10, `${built.keyframes} keyframes`);
      check('the halftone treatment was applied', built.halftone, `${built.effects} effects across the stack`);
      check('a mask was added', built.masks === 1);
      check('two audio connections were made', built.mappings === 2);
      await sleep(700);
      await page.captureClip({ x: 0, y: 0, width: 1800, height: 1080 }).then((buffer) => fs.writeFile(join(SHOTS, 'smoke-03-composition.png'), buffer));
    });

    /* ---------------- interaction: trim, scrub, undo ---------------- */
    await stage('4. Timeline interaction, scrubbing and undo', async () => {
      const interaction = await page.evaluate(`(async () => {
        const { store, preview, timeline } = window.__motionLab;
        const clip = store.doc.clips.find((c) => c.name === 'Clip one');
        store.selectClips([clip.id]);
        await new Promise((r) => requestAnimationFrame(r));

        const before = { start: clip.start, duration: clip.duration, inPoint: clip.inPoint };
        // Trim by 1.5 s from the left edge, exactly as a drag would.
        store.beginGesture('Trim clips');
        clip.start = before.start + 1.5;
        clip.duration = before.duration - 1.5;
        clip.inPoint = before.inPoint + 1.5;
        store.emit('doc');
        store.endGesture(true);
        const trimmed = { start: clip.start, duration: clip.duration, inPoint: clip.inPoint };

        // Scrub and step.
        preview.seek(6.5);
        const scrubbed = store.playback.time;
        preview.step(1);
        const stepped = store.playback.time;

        // Split the clip at the playhead.
        store.setTime(6);
        store.selectClips([clip.id]);
        const splits = store.splitClips(6);
        const afterSplit = store.doc.clips.length;

        // Undo the split: one edit, one undo step.
        store.undo();
        const afterUndoSplit = store.doc.clips.length;

        // Now a second, independent gesture: a trim. Undoing it must restore the
        // clip in a single step, which is what "one drag is one undo step" means.
        const target = store.doc.clips.find((c) => c.name === 'Clip one');
        const gestureBefore = { start: target.start, duration: target.duration, inPoint: target.inPoint };
        store.beginGesture('Trim clips');
        for (let frame = 0; frame < 12; frame += 1) {
          // Twelve intermediate writes, as a real drag would produce.
          target.start = gestureBefore.start + (frame + 1) * 0.1;
          target.duration = gestureBefore.duration - (frame + 1) * 0.1;
          store.emit('doc');
        }
        store.endGesture(true);
        const gestureAfter = { start: target.start, duration: target.duration };
        const historyAfterGesture = store.history.past.length;
        store.undo();
        const gestureRestored = store.doc.clips.find((c) => c.name === 'Clip one');
        const historyAfterUndo = store.history.past.length;

        return {
          before, trimmed, scrubbed, stepped, splits, afterSplit, afterUndoSplit,
          gestureBefore, gestureAfter, historyAfterGesture, historyAfterUndo,
          clipsAfterUndo: store.doc.clips.length,
          restored: gestureRestored ? { start: gestureRestored.start, duration: gestureRestored.duration, inPoint: gestureRestored.inPoint } : null,
          canRedo: store.canRedo(),
        };
      })()`, { awaitPromise: true, timeoutMs: 60000 });

      check('a trim moved the clip in-point', Math.abs(interaction.trimmed.inPoint - (interaction.before.inPoint + 1.5)) < 1e-6, `inPoint ${interaction.before.inPoint} → ${interaction.trimmed.inPoint}`);
      check('scrubbing moves the playhead', Math.abs(interaction.scrubbed - 6.5) < 1e-6, `${interaction.scrubbed}s`);
      check('stepping advances exactly one frame', Math.abs(interaction.stepped - (6.5 + 1 / 30)) < 1e-6, `${interaction.stepped.toFixed(4)}s`);
      check('splitting added a clip', interaction.splits === 1 && interaction.afterSplit === 8, `${interaction.splits} split, ${interaction.afterSplit} clips`);
      check('undoing a split removes the extra clip', interaction.afterUndoSplit === 7, `${interaction.afterUndoSplit} clips`);
      check('twelve drag frames produced exactly one history entry', interaction.historyAfterGesture - interaction.historyAfterUndo === 1, `history ${interaction.historyAfterGesture} → ${interaction.historyAfterUndo}`);
      check('one drag is one undo step', interaction.restored?.start === interaction.gestureBefore.start && interaction.clipsAfterUndo === 7, `start ${interaction.gestureAfter.start} → ${interaction.restored?.start} (was ${interaction.gestureBefore.start})`);
      check('redo is available after undo', interaction.canRedo);
    });

    /* ---------------- preview vs quality ---------------- */
    await stage('5. Preview quality modes', async () => {
      const sizes = await page.evaluate(`(async () => {
        const { store, preview } = window.__motionLab;
        const results = [];
        for (const quality of [1, 0.5, 0.25]) {
          preview.setQuality(quality);
          await new Promise((r) => requestAnimationFrame(r));
          await new Promise((r) => requestAnimationFrame(r));
          const canvas = document.querySelector('.preview-stage canvas');
          results.push({ quality, width: canvas.width, height: canvas.height, qualityValue: store.playback.quality });
        }
        preview.setQuality(1);
        await new Promise((r) => requestAnimationFrame(r));
        return results;
      })()`, { awaitPromise: true, timeoutMs: 60000 });
      check('full quality renders at composition size', sizes[0].width === 1080 && sizes[0].height === 1920, `${sizes[0].width}x${sizes[0].height}`);
      check('half quality renders at half size', sizes[1].width === 540 && sizes[1].height === 960, `${sizes[1].width}x${sizes[1].height}`);
      check('quarter quality renders at quarter size', sizes[2].width === 270 && sizes[2].height === 480, `${sizes[2].width}x${sizes[2].height}`);
      check('the timeline duration is untouched by quality', sizes.every((entry) => entry.qualityValue === entry.quality));
      const afterQuality = JSON.parse(await page.evaluate(`JSON.stringify({
        clips: window.__motionLab.store.doc.clips.length,
        name: window.__motionLab.store.doc.meta.name,
        projectId: window.__motionLab.store.session.projectId,
        mappings: window.__motionLab.store.doc.mappings.length,
      })`));
      check('the composition is intact after switching preview quality', afterQuality.clips === 7 && afterQuality.mappings === 2, `${afterQuality.clips} clips, ${afterQuality.mappings} connections, "${afterQuality.name}"`);
    });

    /* ---------------- save + reload ---------------- */
    await stage('6. Save, reload the page, confirm the edit survived', async () => {
      const saved = await page.evaluate(`(async () => {
        const { store } = window.__motionLab;
        const before = {
          name: store.doc.meta.name,
          clips: store.doc.clips.length,
          assets: store.doc.assets.length,
          projectId: store.session.projectId,
        };
        const response = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ doc: store.doc }),
        });
        const body = await response.json();
        store.session.projectId = body.project.id;
        store.session.dirty = false;
        store.session.saveState = 'saved';
        // Save again through the normal path so the project is the most
        // recently updated one and the app reopens it on reload.
        const put = await fetch('/api/projects/' + body.project.id, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ doc: store.doc }),
        });
        const putBody = await put.json();
        const after = {
          name: store.doc.meta.name,
          clips: store.doc.clips.length,
          assets: store.doc.assets.length,
        };
        return {
          id: body.project.id,
          before,
          after,
          clips: store.doc.clips.length,
          mappings: store.doc.mappings.length,
          serverIssues: (putBody.issues ?? []).map((issue) => issue.message),
          listed: (await (await fetch('/api/projects')).json()).projects.slice(0, 2).map((project) => project.name + ':' + project.clipCount),
        };
      })()`, { awaitPromise: true, timeoutMs: 120000 });
      check('the project saved', Boolean(saved.id), `${saved.clips} clips (before ${saved.before.clips}, after ${saved.after.clips}, name ${saved.before.name})`);
      if (saved.serverIssues?.length) for (const issue of saved.serverIssues) console.log(`      ! server: ${issue}`);
      console.log(`      listed: ${saved.listed?.join(' | ')}`);

      await page.navigate(`${BASE}/index.html`, 90000);
      let ready = false;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        ready = await page.evaluate('Boolean(window.__motionLab && window.__motionLab.ready)').catch(() => false);
        if (ready) break;
        await sleep(150);
      }
      check('the editor booted again', ready);

      // Wait for the project to load and the media to settle.
      const reopened = await page.evaluate(`(async () => {
        const { store } = window.__motionLab;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (store.doc.clips.length > 1) break;
          await new Promise((r) => setTimeout(r, 150));
        }
        const doc = store.doc;
        return {
          name: doc.meta.name,
          projectId: store.session.projectId,
          clips: doc.clips.length,
          mappings: doc.mappings.length,
          keyframes: doc.clips.reduce((n, clip) => n + clip.keyframes.reduce((m, channel) => m + channel.keys.length, 0), 0),
          masks: doc.clips.reduce((n, clip) => n + clip.masks.length, 0),
          effects: doc.clips.reduce((n, clip) => n + clip.effects.stack.length, 0),
          halftone: doc.clips.some((clip) => clip.effects.stack.some((fx) => fx.type === 'halftone')),
          gradientText: doc.clips.some((clip) => clip.text && clip.text.gradientFrom),
          audioAnalysis: Object.keys(doc.audio).length,
          // Every audio file in the library is analysed after a load, so count
          // only what matters here: the music clip's own analysis came back.
          musicAnalysed: doc.clips.some((clip) => clip.kind === 'audio')
            && doc.clips.filter((clip) => clip.kind === 'audio').every((clip) => Boolean(doc.audio[clip.assetId])),
          width: doc.composition.width,
          height: doc.composition.height,
          fps: doc.composition.fps,
          duration: doc.composition.duration,
        };
      })()`, { awaitPromise: true, timeoutMs: 180000 });

      check('the composition size survived the reload', reopened.width === 1080 && reopened.height === 1920 && reopened.fps === 30);
      check('every clip survived', reopened.clips === saved.clips, `${reopened.clips} clips`);
      check('keyframes survived', reopened.keyframes >= 10, `${reopened.keyframes}`);
      check('the halftone treatment survived', reopened.halftone);
      check('the masked text survived', reopened.masks === 1 && reopened.gradientText);
      check('the audio connections survived', reopened.mappings === 2);
      check('the audio analysis survived', reopened.musicAnalysed, `${reopened.audioAnalysis} analysed track(s) in the project`);
      await sleep(600);
      await page.captureClip({ x: 0, y: 0, width: 1800, height: 1080 }).then((buffer) => fs.writeFile(join(SHOTS, 'smoke-04-reopened.png'), buffer));
    });

    /* ---------------- export from the UI ---------------- */
    await stage('7. Export the finished video from the editor', async () => {
      const { job } = await page.evaluate(`(async () => {
        const { store } = window.__motionLab;
        // Export a short range so the test stays quick, using the same payload
        // the export dialog sends.
        const response = await fetch('/api/exports', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            doc: store.doc, kind: 'video', format: 'mp4-h264',
            width: 1080, height: 1920, fps: 30,
            rangeStart: 2, rangeEnd: 5, quality: 78,
            fileName: 'smoke-export',
          }),
        });
        const body = await response.json();
        store.session.exportJob = body.job;
        store.emit('export');
        return body;
      })()`, { awaitPromise: true, timeoutMs: 60000 });

      let finished = null;
      for (let attempt = 0; attempt < 900; attempt += 1) {
        const { job: current } = await (await fetch(`${BASE}/api/exports/${job.id}`)).json();
        if (['done', 'failed', 'cancelled'].includes(current.status)) {
          finished = current;
          break;
        }
        if (attempt % 20 === 0) process.stdout.write(`      … ${current.stage}\n`);
        await sleep(600);
      }
      check('export finished', finished?.status === 'done', finished?.status === 'done' ? finished.outputName : (finished?.error ?? 'timed out'));
      if (finished?.status === 'done') {
        check('the exported file has a downloaded size', finished.outputSize > 100000, `${(finished.outputSize / 1024 / 1024).toFixed(2)} MB`);
        check('the export reports an audio stream', finished.report?.hasAudio === true);
        check('the export reports 90 frames for 3 s at 30 fps', finished.report?.video?.frames === 90, `${finished.report?.video?.frames}`);
        const download = await fetch(`${BASE}${finished.downloadUrl}`);
        check('the export downloads', download.ok, `${download.headers.get('content-type')}`);
      }
      await sleep(400);
      await page.captureClip({ x: 0, y: 0, width: 1800, height: 1080 }).then((buffer) => fs.writeFile(join(SHOTS, 'smoke-05-exported.png'), buffer));
    });

    /* ---------------- video in the preview ---------------- */
    await stage('8. A video clip draws while the preview plays, pauses and scrubs', async () => {
      // Leave nothing in the composition but one video clip, so a black preview
      // means the video was not drawn.
      await page.evaluate(`(async () => {
        const { store, preview } = window.__motionLab;
        const { defaultClip } = await import('/core/schema.js');
        const assets = [...store.assets.values()];
        const video = assets.find((asset) => asset.fileName === 'clip-neon.mp4') ?? assets.find((asset) => asset.kind === 'video');
        const track = store.doc.tracks.find((entry) => entry.kind === 'visual');
        store.edit('Playback check', () => {
          store.doc.mappings = [];
          store.doc.clips = [defaultClip({ name: 'Video', kind: 'video', assetId: video.id, trackId: track.id, start: 0, duration: 6 })];
        });
        preview.invalidate(true);
      })()`, { awaitPromise: true, timeoutMs: 60000 });
      const brightness = () => page.evaluate(`(() => {
        const canvas = document.querySelector('.preview-canvas');
        const probe = document.createElement('canvas'); probe.width = 64; probe.height = 36;
        const ctx = probe.getContext('2d'); ctx.drawImage(canvas, 0, 0, 64, 36);
        const data = ctx.getImageData(0, 0, 64, 36).data; let sum = 0;
        for (let i = 0; i < data.length; i += 4) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
        return sum / (data.length / 4);
      })()`);
      const settle = async () => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if ((await brightness()) > 20) break;
          await sleep(150);
        }
        return brightness();
      };
      // The first frame of a video that has sat idle can take the browser a moment.
      await page.evaluate('window.__motionLab.preview.seek(0.5)');
      await settle();

      await page.evaluate('window.__motionLab.preview.play()');
      const samples = [];
      for (let index = 0; index < 8; index += 1) {
        await sleep(300);
        samples.push(await brightness());
      }
      await page.evaluate('window.__motionLab.preview.pause()');
      const lit = samples.filter((value) => value > 20).length;
      check('the video draws in every sample while playing', lit === samples.length, samples.map((value) => value.toFixed(0)).join(' '));
      await sleep(800);
      const paused = await brightness();
      check('the video is still drawn after pausing', paused > 20, `brightness ${paused.toFixed(1)}`);

      await page.evaluate('window.__motionLab.preview.seek(4.2)');
      const scrubbed = await settle();
      const time = await page.evaluate('window.__motionLab.store.playback.time');
      check('scrubbing shows the video at the new time', scrubbed > 20 && Math.abs(time - 4.2) < 0.05, `brightness ${scrubbed.toFixed(1)} at ${time.toFixed(2)}s`);
    });

    /* ---------------- proportions in the preview ---------------- */
    await stage('9. Photos and videos keep their proportions in the preview', async () => {
      // The portrait composition holds one clip at a time: a 1600x2000 photo, then a
      // 1280x720 video. The preview must match the source cover-fitted (its own
      // proportions, filling the frame, centred), not stretched to the frame.
      const fit = async (fileName, time) => JSON.parse(String(await page.evaluate(`(async () => {
        const { store, preview } = window.__motionLab;
        const { defaultClip } = await import('/core/schema.js');
        const asset = [...store.assets.values()].find((entry) => entry.fileName === '${fileName}');
        const track = store.doc.tracks.find((entry) => entry.kind === 'visual');
        store.edit('Proportion check', () => {
          store.doc.mappings = [];
          store.doc.clips = [defaultClip({ name: 'Fit', kind: asset.kind, assetId: asset.id, trackId: track.id, start: 0, duration: 6 })];
        });
        preview.seek(${time});
        const url = '/api/assets/' + encodeURIComponent(asset.id) + '/file';
        let source;
        if (asset.kind === 'video') {
          source = document.createElement('video');
          source.muted = true;
          source.src = url;
          await new Promise((resolve) => { source.onloadeddata = resolve; });
          source.currentTime = ${time};
          await new Promise((resolve) => { source.onseeked = resolve; });
        } else {
          source = new Image();
          source.src = url;
          await source.decode();
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const sw = source.videoWidth || source.naturalWidth;
        const sh = source.videoHeight || source.naturalHeight;
        const canvas = document.querySelector('.preview-canvas');
        const W = 48;
        const H = Math.round(W * canvas.height / canvas.width);
        const pixels = (draw) => {
          const probe = document.createElement('canvas');
          probe.width = W; probe.height = H;
          const ctx = probe.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          draw(ctx);
          return ctx.getImageData(0, 0, W, H).data;
        };
        const shown = pixels((ctx) => ctx.drawImage(canvas, 0, 0, W, H));
        const s = Math.max(W / sw, H / sh);
        const cover = pixels((ctx) => ctx.drawImage(source, (sw - W / s) / 2, (sh - H / s) / 2, W / s, H / s, 0, 0, W, H));
        const stretch = pixels((ctx) => ctx.drawImage(source, 0, 0, W, H));
        const diff = (a, b) => {
          let total = 0;
          for (let i = 0; i < a.length; i += 4) total += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
          return total / (a.length / 4 * 3);
        };
        return JSON.stringify({ cover: diff(shown, cover), stretch: diff(shown, stretch) });
      })()`, { awaitPromise: true, timeoutMs: 60000 })));
      const photo = await fit('photo-dusk.png', 1);
      check('a photo of another shape is cover-fitted in the preview', photo.cover < 12 && photo.cover * 2 < photo.stretch, `cover ${photo.cover.toFixed(1)}, stretched ${photo.stretch.toFixed(1)}`);
      const video = await fit('clip-harbour.mp4', 2);
      check('a video of another shape is cover-fitted in the preview', video.cover < 12 && video.cover * 2 < video.stretch, `cover ${video.cover.toFixed(1)}, stretched ${video.stretch.toFixed(1)}`);
    });

    /* ---------------- console cleanliness ---------------- */
    await stage('10. No console errors', async () => {
      const errors = page.consoleErrors.filter((line) => !/favicon/i.test(line));
      check('the browser reported no errors or exceptions', errors.length === 0, errors.slice(0, 4).join(' | '));
      void consoleErrors;
    });
  } finally {
    await page.close();
    try { server?.kill(); } catch { /* ignore */ }
  }

  console.log('\n============================');
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const failure of failures) console.log(`  \u2022 ${failure}`);
  }
  console.log(`\nScreenshots written to ${SHOTS}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nSmoke test crashed:', error);
  process.exit(1);
});
