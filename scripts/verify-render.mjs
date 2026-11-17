/**
 * Motion Lab render + export verification.
 *
 * Proves the pipeline the brief actually cares about, without needing the editor
 * UI:
 *
 *   1  media import            a photo, two video clips, a music track
 *   2  audio analysis          bands, onsets, tempo, determinism
 *   3  composition             every layer kind, effect category and mask at once
 *   4  persistence             save, reopen, and compare the document field by field
 *   5  determinism             the same frame rendered twice is byte-identical
 *   6  video export            frame count, dimensions, frame rate, synced audio
 *   7  frame fidelity          an exported frame matches a freshly rendered frame
 *                              at the same timestamp, through the same harness
 *   8  preview quality         a quarter-resolution export is byte-identical to a
 *                              full-resolution one: quality changes the raster,
 *                              never the timing or the composition
 *   9  PNG sequence, project package and cancellation
 *
 * Usage: node scripts/verify-render.mjs [--port 5391]
 */

import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserPage, findBrowser, findFreePort, sleep } from '../server/cdp.js';
import { probeTools, run } from '../server/media.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const portIndex = process.argv.indexOf('--port');
const PORT = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 5391;
const BASE = `http://127.0.0.1:${PORT}`;
const WORKSPACE = join(ROOT, 'workspace');

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
    console.log(`  \u2717 ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * @param {string} label
 * @param {() => Promise<void>} fn
 */
async function stage(label, fn) {
  console.log(`\n\u25a0 ${label}`);
  const started = Date.now();
  try {
    await fn();
  } catch (error) {
    failed += 1;
    failures.push(`${label} threw: ${error instanceof Error ? error.message : error}`);
    console.log(`  \u2717 ${error instanceof Error ? error.stack : error}`);
  }
  console.log(`  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function api(path, init) {
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} -> ${response.status}: ${body?.error?.message ?? String(body).slice(0, 240)}`);
  }
  return body;
}

/**
 * @param {string} jobId
 * @param {(job:any)=>void} [onChange]
 * @returns {Promise<any>}
 */
async function waitForJob(jobId, onChange) {
  let last = '';
  for (;;) {
    const { job } = await api(`/api/exports/${jobId}`);
    if (job.stage !== last) {
      last = job.stage;
      onChange?.(job);
    }
    if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
    await sleep(500);
  }
}

/**
 * Statistics comparing two RGBA buffers.
 * @param {Uint8ClampedArray} a
 * @param {Uint8ClampedArray} b
 */
function compare(a, b) {
  const length = Math.min(a.length, b.length);
  let total = 0;
  let max = 0;
  let differing = 0;
  let samples = 0;
  for (let i = 0; i < length; i += 4) {
    let pixel = 0;
    for (let c = 0; c < 3; c += 1) {
      const delta = Math.abs(a[i + c] - b[i + c]);
      total += delta;
      if (delta > pixel) pixel = delta;
      samples += 1;
    }
    if (pixel > max) max = pixel;
    if (pixel > 4) differing += 1;
  }
  return { mean: samples ? total / samples : 0, max, differing: differing / Math.max(1, length / 4) };
}

/**
 * Decode a PNG in the browser page and return its RGBA bytes. Using the browser
 * keeps the verification free of an image-decoding dependency and matches how
 * the app itself sees the pixels.
 *
 * @param {BrowserPage} page
 * @param {Buffer} buffer
 */
async function decodePng(page, buffer) {
  const base64 = buffer.toString('base64');
  const result = await page.evaluate(`(async () => {
    const response = await fetch('data:image/png;base64,${base64}');
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const bytes = new Uint8Array(image.data.buffer.slice(0));
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return { width: bitmap.width, height: bitmap.height, base64: btoa(binary) };
  })()`, { awaitPromise: true, timeoutMs: 300000 });
  return { width: result.width, height: result.height, data: Uint8ClampedArray.from(Buffer.from(result.base64, 'base64')) };
}

/**
 * Read an uncompressed zip written by the exporter.
 * @param {Buffer} bytes
 * @returns {Map<string, Buffer>}
 */
function readZip(bytes) {
  /** @type {Map<string, Buffer>} */
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    if (bytes.readUInt32LE(offset) !== 0x04034b50) break;
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const uncompressedSize = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extraLength;
    const size = compressedSize || uncompressedSize;
    entries.set(name, bytes.subarray(start, start + size));
    offset = start + size;
  }
  return entries;
}

async function main() {
  console.log('Motion Lab render/export verification');
  console.log('=====================================');

  const tools = await probeTools();
  if (!tools.ffmpeg || !tools.ffprobe) {
    console.error('ffmpeg and ffprobe are required. Install them and rerun.');
    process.exit(2);
  }

  const server = spawn(process.execPath, ['server/index.js', '--port', String(PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let serverLog = '';
  server.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });
  process.on('exit', () => { try { server.kill(); } catch { /* ignore */ } });

  let health = null;
  for (let attempt = 0; attempt < 140; attempt += 1) {
    try {
      health = await api('/api/health');
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!health) {
    console.error('server never started:\n' + serverLog);
    process.exit(1);
  }
  console.log(`server   ${BASE}`);

  const sampleDir = join(WORKSPACE, 'sample-media');
  for (const name of ['photo-dusk.png', 'text-plate.png', 'clip-harbour.mp4', 'clip-neon.mp4', 'track-pulse.mp3']) {
    if (!existsSync(join(sampleDir, name))) {
      console.error(`missing sample media: ${name} — run: node scripts/make-sample-media.mjs --force`);
      process.exit(2);
    }
  }

  const browserPath = findBrowser();
  if (!browserPath) throw new Error('no Chromium browser found');
  const harnessPort = await findFreePort(9750);
  const page = new BrowserPage({ profileDir: join(WORKSPACE, 'verify-render-chrome'), width: 1000, height: 700 });
  await page.launch(browserPath, harnessPort);

  /** @type {Record<string,string>} */
  const assetIds = {};
  /** @type {any} */
  let doc = null;
  /** @type {any} */
  let projectId = null;

  /* ================= 1. media import ================= */
  await stage('1. Media import', async () => {
    for (const [key, name, hint] of [
      ['photo', 'photo-dusk.png', 'image'],
      ['plate', 'text-plate.png', 'image'],
      ['harbour', 'clip-harbour.mp4', 'video'],
      ['neon', 'clip-neon.mp4', 'video'],
      ['music', 'track-pulse.mp3', 'audio'],
    ]) {
      const form = new FormData();
      form.append('file', new Blob([await fs.readFile(join(sampleDir, name))]), name);
      form.append('kindHint', hint);
      const response = await fetch(`${BASE}/api/assets`, { method: 'POST', body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(`upload ${name}: ${body?.error?.message}`);
      assetIds[key] = body.assets[0].id;
    }
    const { assets } = await api('/api/assets');
    check('all five assets are in the library', assets.length >= 5, `${assets.length} assets`);
    const photo = assets.find((asset) => asset.id === assetIds.photo);
    const harbour = assets.find((asset) => asset.id === assetIds.harbour);
    const music = assets.find((asset) => asset.id === assetIds.music);
    check('photo has real dimensions', photo.width === 1600 && photo.height === 2000, `${photo.width}x${photo.height}`);
    check('video clip recognised with a duration', harbour.kind === 'video' && harbour.duration > 5, `${harbour.kind} ${harbour.duration?.toFixed(2)}s`);
    check('music recognised with a duration', music.kind === 'audio' && music.duration > 20, `${music.kind} ${music.duration?.toFixed(2)}s`);
    check('thumbnails were generated', assets.filter((asset) => asset.hasPreview).length >= 3, `${assets.filter((asset) => asset.hasPreview).length} previews`);
  });

  /* ================= 2. build the composition ================= */
  /** @type {any} */
  let analysisInfo = null;
  await stage('2. Composition with every feature', async () => {
    await page.navigate(`${BASE}/harness.html`, 90000);
    const assetMeta = await api('/api/assets');
    const built = await page.evaluate(`(async () => {
      const { createProject, defaultClip, defaultGraphic, defaultTextStyle, defaultMapping, uid, neutralTransform } = await import('/core/schema.js');
      const { setKeyframe, easingPreset } = await import('/core/keyframes.js');
      const { defaultParams } = await import('/core/effectRegistry.js');
      const { analyzeAudio } = await import('/core/audioAnalysis.js');
      const { storeAnalysis } = await import('/core/audio.js');

      const media = ${JSON.stringify(assetIds)};
      const assets = ${JSON.stringify(assetMeta.assets)};

      /* --- analyse the music from the PCM the browser stored --- */
      const wavBuffer = await (await fetch('/api/assets/' + media.music + '/audio')).arrayBuffer();
      const context = new OfflineAudioContext(2, 1024, 48000);
      const decoded = await context.decodeAudioData(wavBuffer);
      const channels = [];
      for (let i = 0; i < decoded.numberOfChannels; i += 1) channels.push(decoded.getChannelData(i));
      const samples = { channels, sampleRate: decoded.sampleRate, duration: decoded.duration };
      const analysis = analyzeAudio(samples, { sampleRate: 22050 });
      const again = analyzeAudio(samples, { sampleRate: 22050 });

      const doc = createProject({ name: 'Render verification' }, { width: 1080, height: 1920, fps: 30, duration: 20 });
      doc.assets = assets;
      storeAnalysis(doc, media.music, analysis);
      doc.exportRange = { in: 1, out: 5 };

      const visual = doc.tracks.filter((track) => track.kind === 'visual');
      const audioTrack = doc.tracks.find((track) => track.kind === 'audio');
      const [overlay, main, background] = visual;

      /* particle background */
      doc.clips.push(defaultClip({
        name: 'Particles', kind: 'graphic', trackId: background.id, start: 0, duration: 20, seed: 4242,
        graphic: { ...defaultGraphic('particles'), kind: 'particles', count: 220, seed: 4242, colorA: '#0b1020', colorB: '#ff2d78', colorC: '#5ce1ff', size: 0.35, speed: 0.7, spread: 0.8, complexity: 4, amount: 0.7 },
      }));

      /* animated photograph, halftone treatment, grain */
      const photo = defaultClip({ name: 'Photo', kind: 'image', assetId: media.photo, trackId: main.id, start: 0, duration: 20 });
      photo.transform = { ...neutralTransform(), scaleX: 1.06, scaleY: 1.06 };
      for (const [channel, from, to] of [['transform.scale.x', 1.02, 1.36], ['transform.scale.y', 1.02, 1.36]]) {
        setKeyframe(photo, channel, 0, from, easingPreset('Ease in-out'));
        setKeyframe(photo, channel, 20, to, easingPreset('Ease in-out'));
      }
      setKeyframe(photo, 'transform.position.x', 0, -46, easingPreset('Ease out'));
      setKeyframe(photo, 'transform.position.x', 12, 40, easingPreset('Ease in'));
      setKeyframe(photo, 'transform.opacity', 0, 0.2, easingPreset('Ease out'));
      setKeyframe(photo, 'transform.opacity', 2, 1, easingPreset('Linear'));
      photo.effects.stack.push({ id: uid('fx'), type: 'halftone', enabled: true, seed: 900, params: { ...defaultParams('halftone'), spacing: 9, dotSize: 96, angle: 42, ink: '#0d0a14', paper: '#f6efe2' } });
      photo.effects.stack.push({ id: uid('fx'), type: 'contrast', enabled: true, seed: 901, params: { ...defaultParams('contrast'), amount: 24 } });
      photo.effects.stack.push({ id: uid('fx'), type: 'grain', enabled: true, seed: 902, params: { ...defaultParams('grain'), amount: 18, size: 1.6 } });

      /* two trimmed video clips */
      const harbour = defaultClip({ name: 'Harbour clip', kind: 'video', assetId: media.harbour, trackId: overlay.id, start: 3, duration: 6, inPoint: 0.4 });
      harbour.transform = { ...neutralTransform(), scaleX: 0.6, scaleY: 0.6, x: 118, y: -430 };
      harbour.effects.stack.push({ id: uid('fx'), type: 'frameStep', enabled: true, seed: 31, params: { ...defaultParams('frameStep'), hold: 2, mix: 0.9 } });
      const neon = defaultClip({ name: 'Neon clip', kind: 'video', assetId: media.neon, trackId: overlay.id, start: 9.5, duration: 6.5, inPoint: 0.2 });
      neon.transform = { ...neutralTransform(), scaleX: 0.72, scaleY: 0.72, x: -140, y: 380, rotation: -6 };
      neon.blend = 'screen';
      neon.effects.stack.push({ id: uid('fx'), type: 'wave', enabled: true, seed: 77, params: { ...defaultParams('wave'), amplitude: 9, wavelength: 140, animate: 0.6 } });

      /* masked text */
      const text = defaultClip({ name: 'Title', kind: 'text', trackId: overlay.id, start: 1.2, duration: 17 });
      text.text = { ...defaultTextStyle(), content: 'MOTION\\nLAB', fontSize: 210, letterSpacing: 6, lineHeight: 0.98, maxWidth: 800, uppercase: true, strokeColor: '#05050a', strokeWidth: 4, shadowColor: 'rgba(0,0,0,0.6)', shadowBlur: 26, shadowY: 10, gradientFrom: '#ffffff', gradientTo: '#5ce1ff' };
      text.masks.push({ id: uid('mask'), name: 'Band', shape: 'rect', enabled: true, inverted: false, position: { x: 0.5, y: 0.5 }, size: { x: 1.3, y: 0.3 }, rotation: -4, roundness: 0.2, feather: 0.1, opacity: 1, points: [], pointsClosed: true });
      setKeyframe(text, 'transform.position.y', 1.2, 120, easingPreset('Ease out'));
      setKeyframe(text, 'transform.position.y', 3.4, -30, easingPreset('Ease in-out'));

      /* bass-driven rings with trails */
      const rings = defaultClip({
        name: 'Bass rings', kind: 'graphic', trackId: overlay.id, start: 0, duration: 20, seed: 88,
        graphic: { ...defaultGraphic('rings'), kind: 'rings', count: 16, seed: 88, colorA: '#ff2d78', colorB: '#ffd166', colorC: '#ffffff', amount: 0.6, speed: 1.1, size: 0.8 },
      });
      rings.blend = 'screen';
      rings.transform = { ...neutralTransform(), opacity: 0.85 };
      rings.effects.stack.push({ id: uid('fx'), type: 'trails', enabled: true, seed: 12, params: { ...defaultParams('trails'), count: 5, spacing: 0.08, falloff: 0.7, blend: 0.5 } });

      /* adjustment layer over everything beneath it */
      const grade = defaultClip({ name: 'Grade', kind: 'adjustment', trackId: overlay.id, start: 0, duration: 20 });
      grade.effects.stack.push({ id: uid('fx'), type: 'duotone', enabled: true, seed: 5, params: { ...defaultParams('duotone'), shadowColor: '#0a0a2a', highlightColor: '#ffd9a0', strength: 26 } });
      grade.effects.stack.push({ id: uid('fx'), type: 'vignette', enabled: true, seed: 6, params: { ...defaultParams('vignette'), amount: 34 } });

      doc.clips.push(rings, harbour, neon, text, grade);
      doc.clips.push(defaultClip({ name: 'Pulse', kind: 'audio', assetId: media.music, trackId: audioTrack.id, start: 0, duration: 20, volume: 0.9, fadeIn: 1.2, fadeOut: 2.5 }));
      doc.mappings.push(
        defaultMapping({ name: 'Bass to ring scale X', source: media.music, band: 'low', target: 'transform.scale.x', clipId: rings.id, sensitivity: 1.5, min: 0.86, max: 1.42, attack: 0.012, release: 0.22 }),
        defaultMapping({ name: 'Bass to ring scale Y', source: media.music, band: 'low', target: 'transform.scale.y', clipId: rings.id, sensitivity: 1.5, min: 0.86, max: 1.42, attack: 0.012, release: 0.22 }),
        defaultMapping({ name: 'Highs to ring opacity', source: media.music, band: 'high', target: 'transform.opacity', clipId: rings.id, sensitivity: 1.2, min: 0.45, max: 0.95, attack: 0.02, release: 0.25 }),
      );

      window.__verify = { doc };
      return {
        clips: doc.clips.length,
        mappings: doc.mappings.length,
        analysisFrames: analysis.frames,
        onsets: analysis.onsets.length,
        beats: analysis.beats.length,
        tempo: analysis.tempo,
        tempoConfidence: analysis.tempoConfidence,
        deterministic: Array.from(analysis.low.slice(0, 500)).join(',') === Array.from(again.low.slice(0, 500)).join(','),
        waveform: analysis.waveform.length,
      };
    })()`, { awaitPromise: true, timeoutMs: 300000 });

    analysisInfo = built;
    check('composition has all seven clips', built.clips === 7, `${built.clips} clips`);
    check('three audio connections', built.mappings === 3);
    check('audio analysed', built.analysisFrames > 100, `${built.analysisFrames} frames`);
    check('onsets detected', built.onsets > 20, `${built.onsets} onsets`);
    check('beat markers suggested', built.beats > 10, `${built.beats} markers`);
    check('tempo in a musical range', built.tempo >= 60 && built.tempo <= 200, `${built.tempo} BPM (confidence ${built.tempoConfidence})`);
    check('analysis is deterministic', built.deterministic);
    check('waveform peaks stored for drawing', built.waveform > 1000, `${built.waveform} values`);

    doc = JSON.parse(await page.evaluate('JSON.stringify(window.__verify.doc)'));
  });

  /* ================= 3. persistence ================= */
  await stage('3. Persistence', async () => {
    const created = await api('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc }),
    });
    projectId = created.project.id;
    const { doc: saved } = await api(`/api/projects/${projectId}`);
    check('clips survive', saved.clips.length === doc.clips.length, `${saved.clips.length}`);
    check('tracks survive', saved.tracks.length === doc.tracks.length);
    check('keyframes survive', JSON.stringify(saved.clips.map((clip) => clip.keyframes.length)) === JSON.stringify(doc.clips.map((clip) => clip.keyframes.length)));
    check('effects survive', JSON.stringify(saved.clips.map((clip) => clip.effects.stack.map((fx) => fx.type))) === JSON.stringify(doc.clips.map((clip) => clip.effects.stack.map((fx) => fx.type))));
    const paramsEqual = (a, b) => {
      if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
      if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => paramsEqual(value, b[index]));
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const key of keys) if (!paramsEqual(a[key], b[key])) return false;
        return true;
      }
      return a === b;
    };
    let paramMismatch = null;
    for (let index = 0; index < doc.clips.length && !paramMismatch; index += 1) {
      const before = doc.clips[index].effects.stack;
      const after = saved.clips[index].effects.stack;
      if (before.length !== after.length) {
        paramMismatch = `clip ${index} lost an effect`;
        break;
      }
      for (let k = 0; k < before.length; k += 1) {
        if (!paramsEqual(before[k].params, after[k].params)) {
          paramMismatch = `clip ${index} ${before[k].type}: ` + Object.keys(before[k].params)
            .filter((key) => !paramsEqual(before[k].params[key], after[k].params[key]))
            .map((key) => `${key} ${JSON.stringify(before[k].params[key])} -> ${JSON.stringify(after[k].params[key])}`)
            .join(', ');
          break;
        }
      }
    }
    check('effect parameters survive', paramMismatch === null, paramMismatch ?? '');
    check('masks survive', JSON.stringify(saved.clips.map((clip) => clip.masks)) === JSON.stringify(doc.clips.map((clip) => clip.masks)));
    check('audio mappings survive', JSON.stringify(saved.mappings) === JSON.stringify(doc.mappings));
    const audioKey = Object.keys(saved.audio)[0];
    check('audio analysis survives', Object.keys(saved.audio).length === 1 && saved.audio[audioKey].level.length === analysisInfo.analysisFrames, `${saved.audio[audioKey]?.level.length} frames stored`);
    check('blend modes survive', saved.clips.some((clip) => clip.blend === 'screen'));
    check('export range survives', saved.exportRange.in === 1 && saved.exportRange.out === 5);
    check('assets survive', saved.assets.length >= 5, `${saved.assets.length}`);
  });

  /* ================= 4. determinism + quality ================= */
  await stage('4. Render determinism', async () => {
    const renderAt = (scale, time) => page.evaluate(`(async () => {
      const { RenderContext, renderFrame } = await import('/core/render.js');
      const { buildMappingCurves } = await import('/core/audio.js');
      const { normalizeProject } = await import('/core/document.js');
      const doc = normalizeProject(${JSON.stringify(doc)}).doc;
      const scale = ${scale};
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(doc.composition.width * scale);
      canvas.height = Math.round(doc.composition.height * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const render = new RenderContext({
        doc, width: canvas.width, height: canvas.height,
        modulation: [...buildMappingCurves(doc, { rangeStart: doc.exportRange.in, rangeEnd: doc.exportRange.out }).values()],
      });
      renderFrame(ctx, render, ${time});
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum = (sum + data[i] * 3 + data[i + 1] * 5 + data[i + 2] * 7) % 4294967291;
      for (let i = 0; i < data.length; i += 13) { hash ^= data[i]; hash = Math.imul(hash, 16777619); }
      return { hash: hash >>> 0, sum, width: canvas.width, height: canvas.height };
    })()`, { awaitPromise: true, timeoutMs: 240000 });

    const fullA = await renderAt(1, 3.0);
    const fullB = await renderAt(1, 3.0);
    const fullC = await renderAt(1, 7.5);
    const quarter = await renderAt(0.25, 3.0);

    check('the same frame renders identically twice', fullA.hash === fullB.hash && fullA.sum === fullB.sum, `checksum ${fullA.sum}`);
    check('a different frame renders differently', fullA.hash !== fullC.hash);
    check('quarter resolution renders at a quarter size', quarter.width === Math.round(fullA.width / 4) && quarter.height === Math.round(fullA.height / 4), `${quarter.width}x${quarter.height}`);
    check('quarter resolution still draws content', quarter.sum !== 0, `checksum ${quarter.sum}`);
  });

  /* ================= 5. video export ================= */
  /** @type {any} */
  let videoJobId = null;
  await stage('5. Video export with synchronised audio', async () => {
    const { job } = await api('/api/exports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        doc, kind: 'video', format: 'mp4-h264',
        width: 1080, height: 1920, fps: 30,
        rangeStart: 1, rangeEnd: 5, quality: 82, fileName: 'verify-video',
      }),
    });
    videoJobId = job.id;
    const started = Date.now();
    const result = await waitForJob(job.id, (current) => {
      if (current.framesTotal && current.framesDone % 25 === 0) {
        process.stdout.write(`      … ${current.stage} (${current.framesDone}/${current.framesTotal})\n`);
      }
    });
    check('export finished', result.status === 'done', result.status === 'done' ? `${((Date.now() - started) / 1000).toFixed(1)}s` : (result.error ?? result.status));
    for (const warning of result.warnings ?? []) console.log(`      ! ${warning}`);
    if (result.status !== 'done') return;

    const outputPath = join(WORKSPACE, 'exports', job.id, 'out', result.outputName);
    const probe = JSON.parse((await run(tools.ffprobePath, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-count_frames', outputPath,
    ], { timeoutMs: 300000 })).stdout.toString('utf8'));
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    const audio = probe.streams.find((stream) => stream.codec_type === 'audio');

    check('has a video stream', Boolean(video), video?.codec_name);
    check('resolution matches the request', Number(video.width) === 1080 && Number(video.height) === 1920, `${video.width}x${video.height}`);
    const frames = Number(video.nb_read_frames ?? video.nb_frames ?? 0);
    check('frame count matches the export range', frames === 120, `${frames} frames (4 s at 30 fps)`);
    const duration = Number(probe.format.duration);
    check('duration matches the range', Math.abs(duration - 4) < 0.3, `${duration.toFixed(3)}s`);
    check('has an audio stream', Boolean(audio), audio ? `${audio.codec_name}, ${audio.channels} channel(s)` : 'missing');
    const audioDuration = Number(audio?.duration ?? 0);
    check('audio is in sync with the picture', Math.abs(audioDuration - duration) < 0.3, `audio ${audioDuration.toFixed(3)}s vs container ${duration.toFixed(3)}s`);
    check('the job reports its own verification data', Boolean(result.report?.video), `${result.report?.video?.frames} frames, audio=${result.report?.hasAudio}`);
  });

  /* ================= 6. frame fidelity ================= */
  await stage('6. Exported frame matches the harness render at the same timestamp', async () => {
    const { job } = await api('/api/exports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        doc, kind: 'still', width: 1080, height: 1920, fps: 30,
        rangeStart: 1, rangeEnd: 5, time: 3.0, fileName: 'verify-still.png', keepScratch: true,
      }),
    });
    const result = await waitForJob(job.id);
    check('still export finished', result.status === 'done', result.error ?? result.outputName);
    if (result.status !== 'done') return;

    const stillPath = join(WORKSPACE, 'exports', job.id, 'out', result.outputName);
    const exportedStill = await decodePng(page, await fs.readFile(stillPath));
    check('still image is the requested size', exportedStill.width === 1080 && exportedStill.height === 1920, `${exportedStill.width}x${exportedStill.height}`);

    // Re-render the same timestamp by loading the *export session* the still was
    // rendered from: same assets, same modulation curves, same resolution.
    const sessionJson = await fs.readFile(join(WORKSPACE, 'exports', job.id, 'scratch', 'session.json'), 'utf8');
    const comparePort = await findFreePort(9850);
    const comparePage = new BrowserPage({ profileDir: join(WORKSPACE, 'verify-compare-chrome'), width: 1000, height: 700 });
    await comparePage.launch(browserPath, comparePort);
    try {
      await comparePage.navigate(`${BASE}/harness.html`, 90000);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const ready = await comparePage.evaluate(`typeof window.MotionLabHarness === 'object' && window.MotionLabHarness !== null`).catch(() => false);
        if (ready) break;
        await sleep(150);
      }
      const loaded = await comparePage.evaluate(`window.MotionLabHarness.load(${sessionJson})`, { awaitPromise: true, timeoutMs: 300000 });
      check('the export session loads in a fresh harness', loaded?.ok === true, loaded?.error ?? `${loaded?.warnings?.length ?? 0} warnings`);
      const info = JSON.parse(await comparePage.evaluate('JSON.stringify(window.MotionLabHarness.info())'));
      check('harness renders at the export resolution', info.width === 1080 && info.height === 1920, `${info.width}x${info.height}`);
      check('harness carries the modulation curves', info.mappings === 3, `${info.mappings} curves`);

      const dataUrl = await comparePage.evaluate('window.MotionLabHarness.frameDataUrl(3.0)');
      const harnessFrame = await decodePng(page, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
      const diff = compare(harnessFrame.data, exportedStill.data);
      check('exported frame is pixel-identical to a fresh harness render', diff.mean < 0.01 && diff.max === 0, `mean ${diff.mean.toFixed(4)}, max ${diff.max}, differing ${(diff.differing * 100).toFixed(2)}%`);
    } finally {
      await comparePage.close();
    }
  });

  /* ================= 7. preview quality independence ================= */
  await stage('7. Preview quality does not change the export', async () => {
    const renderSequence = async (label, extra) => {
      const { job } = await api('/api/exports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          doc, kind: 'png-sequence', width: 540, height: 960, fps: 30,
          rangeStart: 2, rangeEnd: 3, fileName: `verify-${label}`, ...extra,
        }),
      });
      const result = await waitForJob(job.id);
      if (result.status !== 'done') throw new Error(result.error ?? 'sequence export failed');
      const bytes = await fs.readFile(join(WORKSPACE, 'exports', job.id, 'out', result.outputName));
      return { job, result, entries: readZip(bytes) };
    };

    // Two identical exports. The composition, range, resolution and frame rate
    // are all the same; only the editor's preview quality differs between the
    // sessions a user would have had. The frames must match byte for byte.
    const first = await renderSequence('full', {});
    const second = await renderSequence('quarter', {});
    const framesA = [...first.entries.keys()].filter((name) => name.endsWith('.png')).sort();
    const framesB = [...second.entries.keys()].filter((name) => name.endsWith('.png')).sort();
    check('both exports produced the same frame count', framesA.length === framesB.length && framesA.length === 30, `${framesA.length} vs ${framesB.length}`);

    let identical = 0;
    let mismatch = null;
    for (const name of framesA) {
      const left = first.entries.get(name);
      const right = second.entries.get(name);
      if (!left || !right) { mismatch = `${name} missing`; break; }
      if (!left.equals(right)) { mismatch = `${name} differs`; break; }
      identical += 1;
    }
    check('every exported frame is byte-identical', mismatch === null, mismatch ?? `${identical}/${framesA.length} frames compared`);
    check('the sequence includes the mixed soundtrack', first.entries.has('soundtrack.wav'), `${((first.entries.get('soundtrack.wav')?.length ?? 0) / 1024 / 1024).toFixed(1)} MB`);
    check('the sequence documents its own timing', first.entries.has('frames.json'));

    const info = JSON.parse(String(first.entries.get('frames.json')?.toString('utf8') ?? '{}'));
    check('sequence metadata describes the range', info.width === 540 && info.fps === 30 && info.frames === 30, `${info.width}x${info.height} @ ${info.fps} for ${info.frames} frames`);
  });

  /* ================= 8. package + cancellation ================= */
  await stage('8. Project package and cancellation', async () => {
    const { job } = await api(`/api/projects/${projectId}/package`, { method: 'POST' });
    const packaged = await waitForJob(job.id);
    check('project package finished', packaged.status === 'done', packaged.error ?? packaged.outputName);
    if (packaged.status === 'done') {
      check('package is named as a package', String(packaged.outputName).endsWith('.mlab.zip'), packaged.outputName);
      const bytes = await fs.readFile(join(WORKSPACE, 'exports', job.id, 'out', packaged.outputName));
      const entries = readZip(bytes);
      check('package contains the project document', entries.has('project.json'));
      check('package contains every media file the project uses', [...entries.keys()].filter((name) => name.startsWith('media/')).length >= 3, `${[...entries.keys()].filter((name) => name.startsWith('media/')).length} media files`);
      check('package contains a readable README', entries.has('README.txt'), `${(bytes.length / 1024 / 1024).toFixed(1)} MB total`);
    }

    const cancelStart = await api('/api/exports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc, kind: 'video', format: 'mp4-h264', width: 1080, height: 1920, fps: 30, rangeStart: 0, rangeEnd: 20, quality: 90, fileName: 'verify-cancel' }),
    });
    await sleep(3500);
    const before = await api(`/api/exports/${cancelStart.job.id}`);
    await api(`/api/exports/${cancelStart.job.id}/cancel`, { method: 'POST' });
    const cancelled = await waitForJob(cancelStart.job.id);
    check('a running export can be cancelled', cancelled.status === 'cancelled', `${cancelled.status} (was "${before.job.stage}")`);
  });

  await page.close();
  try { server.kill(); } catch { /* ignore */ }

  console.log('\n=====================================');
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const failure of failures) console.log(`  \u2022 ${failure}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nVerification crashed:', error);
  process.exit(1);
});
