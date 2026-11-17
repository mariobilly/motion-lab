/**
 * The export engine.
 *
 * Rendering is split between two processes on purpose:
 *
 *   Node              owns jobs, scratch space, media preparation, audio mixing
 *                     and the ffmpeg encode.
 *   Headless Chrome   renders frames by running the *same* `renderFrame` code
 *                     the editor previews with, exposed through `harness.html`.
 *
 * Node drives the browser over CDP: it tells the page to seek, captures the
 * canvas rectangle as a PNG, and streams those frames into an ffmpeg encode.
 * Export therefore preserves timing exactly even when rendering is slower than
 * real time, and "exported frame == preview frame" is a property of the
 * architecture rather than something that has to be tested into existence.
 */

import { spawn } from 'node:child_process';
import { existsSync, promises as fsRaw } from 'node:fs';
import { join } from 'node:path';

/**
 * `fs` is intentionally untyped here: under `checkJs`, Node's
 * `fs.promises.writeFile` overloads reject `Buffer` because `Buffer` is backed
 * by `ArrayBufferLike` rather than `ArrayBuffer`. Adding `exists` (which Node's
 * promises API deliberately omits) keeps the call sites uniform.
 * @type {any}
 */
const fs = Object.assign(Object.create(null), fsRaw, {
  /** @param {string} path */
  exists(path) {
    return fsRaw.access(path).then(() => true, () => false);
  },
});

import { BrowserPage, findBrowser, findFreePort, sleep } from './cdp.js';
import {
  encodeVideo, exportFormats, extractVideoFrames, inspectExport, probeMedia, probeTools,
  readWav, run, writeWav, writeZip,
} from './media.js';
import { directorySize, readJson as readJsonFile, removeTree, safeStem } from './workspace.js';

/**
 * @typedef {import('./workspace.js').Workspace} Workspace
 * @typedef {import('../../motion-lab/core/schema.js').ProjectDoc} ProjectDoc
 */

/**
 * @typedef {object} ExportOptions
 * @property {string} kind          video | png-sequence | still | stills | package | preview
 * @property {string} [format]      Format id from `exportFormats()`.
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [fps]
 * @property {number} [rangeStart]
 * @property {number} [rangeEnd]
 * @property {number} [quality]     0..100
 * @property {number} [time]        For a single still.
 * @property {Array<{time:number, fileName?:string}>} [items]  For `stills`: one frame each, rendered from a single session.
 * @property {string} [fileName]
 * @property {number} [captureScale]
 * @property {boolean} [keepScratch]
 */

/**
 * @typedef {object} ExportJob
 * @property {string} id
 * @property {string} kind
 * @property {'queued'|'preparing'|'rendering'|'encoding'|'finishing'|'done'|'cancelled'|'failed'} status
 * @property {string} stage
 * @property {number} progress
 * @property {number} framesTotal
 * @property {number} framesDone
 * @property {number} startedAt
 * @property {number} [finishedAt]
 * @property {string} [outputPath]
 * @property {string} [outputName]
 * @property {string} [outputMime]
 * @property {number} [outputSize]
 * @property {string} [error]
 * @property {string[]} [warnings]
 * @property {any} [report]
 * @property {() => void} [cancel]
 */

/** @type {Map<string, ExportJob>} */
export const jobs = new Map();

const RENDER_HARNESS_PORT_OFFSET = 9500;

/**
 * @param {Workspace} workspace
 * @param {ProjectDoc} doc
 * @param {{kind?:string}} options
 * @returns {ExportJob}
 */
export function createJob(workspace, doc, options) {
  const id = `job_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  /** @type {ExportJob} */
  const job = {
    id,
    kind: options.kind ?? 'video',
    status: 'queued',
    stage: 'Waiting to start',
    progress: 0,
    framesTotal: 0,
    framesDone: 0,
    startedAt: Date.now(),
    warnings: [],
  };
  job.cancel = () => {
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return;
    job.status = 'cancelled';
    job.stage = 'Cancelled';
  };
  jobs.set(id, job);
  return job;
}

/**
 * Wait until the harness module has finished executing.
 *
 * `document.readyState === 'complete'` is not enough: a module script can still
 * be evaluating when the load event fires, and `window.MotionLabHarness` appears
 * only after its imports resolve. Polling for the object is the reliable signal.
 *
 * @param {BrowserPage} page
 * @param {number} [timeoutMs]
 */
async function waitForHarness(page, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await page.evaluate(
      `JSON.stringify({ ready: typeof window.MotionLabHarness === 'object' && window.MotionLabHarness !== null, status: document.getElementById('status') ? document.getElementById('status').textContent : '' })`,
    ).catch(() => null);
    if (state) {
      const parsed = JSON.parse(state);
      if (parsed.ready === true) return;
    }
    if (Date.now() > deadline) {
      const errors = page.consoleErrors.slice(-4).join(' | ');
      throw new Error(`The render harness did not start within ${timeoutMs} ms.${errors ? ` The page reported: ${errors}` : ''}`);
    }
    await sleep(120);
  }
}

/**
 * Reading the status through a function keeps TypeScript from narrowing the
 * job's mutable status to a single literal across a long async body.
 * @param {ExportJob} job
 * @returns {boolean}
 */
function isCancelled(job) {
  return job.status === 'cancelled';
}

/**
 * Run a full export. Resolves when the job reaches a terminal state; the job
 * object is the source of truth for progress (poll `GET /api/exports/<id>`).
 *
 * @param {object} context
 * @param {Workspace} context.workspace
 * @param {string} context.baseUrl       Where the app is served (for the harness page).
 * @param {ProjectDoc} context.doc
 * @param {ExportJob} context.job
 * @param {ExportOptions} context.options
 * @returns {Promise<ExportJob>}
 */
export async function runExport({ workspace, baseUrl, doc, job, options }) {
  const composition = doc.composition;
  const fps = options.fps ?? composition.fps;
  const width = Math.max(16, Math.round(options.width ?? composition.width));
  const height = Math.max(16, Math.round(options.height ?? composition.height));
  const rangeStart = Math.max(0, options.rangeStart ?? doc.exportRange.in);
  const rangeEnd = Math.min(composition.duration, options.rangeEnd ?? doc.exportRange.out);
  const frameCount = Math.max(1, Math.round((rangeEnd - rangeStart) * fps));
  const sessionDir = join(workspace.exports, job.id);
  const frameDir = join(sessionDir, 'frames');
  const assetDir = join(sessionDir, 'assets');
  const videoDir = join(sessionDir, 'video');
  const tools = await probeTools();

  job.framesTotal = frameCount;
  job.outputName = undefined;

  /** @type {BrowserPage|null} */
  let page = null;
  /** @type {string[]} */
  const warnings = job.warnings ?? [];

  try {
    if (isCancelled(job)) return job;
    job.status = 'preparing';
    job.stage = 'Preparing workspace';
    await fs.mkdir(frameDir, { recursive: true });
    await fs.mkdir(assetDir, { recursive: true });

    /* ---------------- asset preparation ---------------- */
    const assetMap = await prepareAssets({
      workspace, doc, assetDir, videoDir, fps, rangeStart, rangeEnd, job, warnings, tools,
    });

    /* ---------------- modulation curves + audio mix ---------------- */
    job.stage = 'Analysing audio connections';
    const { buildMappingCurves, mixAudio } = await import('../core/audio.js');
    const curves = [...buildMappingCurves(doc, { rangeStart, rangeEnd }).values()];
    const modulationPayload = curves.map((curve) => ({
      id: curve.id,
      target: curve.target,
      clipId: curve.clipId,
      mode: curve.mode,
      frames: curve.frames,
      values: Array.from(curve.values),
    }));

    let audioPath = null;
    const audioClips = doc.clips.filter((clip) => clip.kind === 'audio' && clip.assetId);
    if (audioClips.length > 0 && tools.ffmpeg) {
      job.stage = 'Mixing soundtrack';
      audioPath = await mixSoundtrack({
        workspace, doc, audioClips, assetDir, sessionDir, fps, rangeStart, rangeEnd, tools, warnings, mixAudio,
      });
    } else if (audioClips.length > 0) {
      warnings.push('This export has audio clips but ffmpeg is not available, so the video will have no sound. Install ffmpeg and re-export, or use the PNG sequence.');
    }
    if (isCancelled(job)) return job;

    /* ---------------- render ---------------- */
    // A still is a one-frame render, so it uses the same browser harness as a
    // video; only the frame loop differs. `png-sequence`, `video` and `still`
    // therefore all share one code path, which is why an exported still and an
    // exported video frame of the same timestamp cannot diverge.
    const needsFrames = options.kind === 'video' || options.kind === 'png-sequence' || options.kind === 'preview' || options.kind === 'still' || options.kind === 'stills';
    if (needsFrames) {
      job.status = 'rendering';
      job.stage = 'Launching the render browser';
      const browserPath = findBrowser();
      if (!browserPath) {
        throw new Error(
          'No Chrome or Edge installation was found, so frames cannot be rendered. Install Google Chrome (or set MOTION_LAB_BROWSER to a Chromium-based browser) and try again. Project-package exports work without it.',
        );
      }
      const port = await findFreePort(RENDER_HARNESS_PORT_OFFSET);
      page = new BrowserPage({ profileDir: join(sessionDir, 'chrome-profile') });
      await page.launch(browserPath, port);

      const sessionJson = JSON.stringify({
        projectId: doc.meta.id,
        doc,
        options: {
          width,
          height,
          fps,
          rangeStart,
          rangeEnd,
          frameCount,
          assets: assetMap,
          modulation: modulationPayload,
        },
      });
      // The session is also written to the scratch directory so the app's own
      // verification tools (and a curious user) can re-render the exact frames
      // the export produced by loading the same session into the harness.
      await fs.mkdir(join(sessionDir, 'scratch'), { recursive: true });
      await fs.writeFile(join(sessionDir, 'scratch', 'session.json'), sessionJson, 'utf8').catch(() => {});

      await page.navigate(`${baseUrl}/harness.html`, 90000);
      job.stage = 'Loading the composition';
      await waitForHarness(page);
      // The session travels as an object literal. (It used to be read back from
      // a file, which meant the harness had to fetch it; passing it directly
      // removes a round trip and a whole class of "file not found" failures.)
      const prepared = await page.evaluate(
        `window.MotionLabHarness.load(${sessionJson})`,
        { awaitPromise: true, timeoutMs: 240000 },
      );
      if (!prepared || prepared.ok !== true) {
        const detail = prepared?.error ?? 'The render harness could not load the project.';
        throw new Error(`${detail}${page.consoleErrors.length ? ` Browser said: ${page.consoleErrors.slice(-3).join(' | ')}` : ''}`);
      }
      if (prepared.warnings?.length) warnings.push(...prepared.warnings);

      const clip = await page.evaluate('JSON.stringify(window.MotionLabHarness.clipRect())');
      const rect = JSON.parse(clip);

      if (options.kind === 'still' || options.kind === 'stills') {
        // Stills are rendered from the already-loaded session, one seek each.
        // A batch (`stills`) exists because opening the browser and preparing
        // the media is the expensive part of an export: rendering fifty stills
        // from one session costs one launch instead of fifty.
        const outputDir = join(sessionDir, 'out');
        await fs.mkdir(outputDir, { recursive: true });
        const items = options.kind === 'stills' && Array.isArray(options.items) && options.items.length > 0
          ? options.items
          : [{ time: Math.max(0, Math.min(rangeEnd, options.time ?? rangeStart)), fileName: options.fileName ?? 'frame.png' }];

        /** @type {Array<{fileName:string, time:number, bytes:number}>} */
        const written = [];
        for (const [index, item] of items.entries()) {
          if (isCancelled(job)) return job;
          const time = Math.max(0, Math.min(doc.composition.duration, Number(item.time) || 0));
          job.stage = items.length > 1
            ? `Rendering still ${index + 1} of ${items.length}`
            : 'Rendering the still frame';
          job.framesTotal = items.length;
          job.framesDone = index;
          job.progress = index / items.length;
          await page.evaluate(
            `window.MotionLabHarness.seek(${Math.max(0, Math.round((time - rangeStart) * fps))}, ${JSON.stringify(time)})`,
            { timeoutMs: 60000 },
          );
          const png = await page.captureClip({
            x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: options.captureScale ?? 1,
          });
          const name = safeStem(String(item.fileName ?? `frame-${index + 1}`), `frame-${index + 1}`) + '.png';
          await fs.writeFile(join(outputDir, name), png);
          written.push({ fileName: name, time, bytes: png.length });
        }

        job.framesDone = items.length;
        // A single still is downloadable as a file; a batch stays a folder that
        // the caller reads from the export's `out` directory.
        job.outputPath = written.length === 1 ? join(outputDir, written[0].fileName) : outputDir;
        job.outputName = written.length === 1 ? written[0].fileName : `${written.length} PNG files`;
        job.outputMime = 'image/png';
        job.outputSize = written.reduce((total, entry) => total + entry.bytes, 0);
        job.report = { width, height, frames: written.length, stills: written, outputDir };
        job.status = 'done';
        job.finishedAt = Date.now();
        job.progress = 1;
        job.stage = 'Done';
        return job;
      }

      job.stage = 'Rendering frames';
      for (let index = 0; index < frameCount; index += 1) {
        if (isCancelled(job)) return job;
        const time = rangeStart + index / fps;
        await page.evaluate(`window.MotionLabHarness.seek(${index}, ${JSON.stringify(time)})`, { timeoutMs: 60000 });
        const png = await page.captureClip({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          scale: options.captureScale ?? 1,
        });
        const name = `f${String(index + 1).padStart(6, '0')}.png`;
        await fs.writeFile(join(frameDir, name), png);
        job.framesDone = index + 1;
        job.progress = (index + 1) / frameCount;
        if (index % 5 === 0 || index === frameCount - 1) {
          job.stage = `Rendering frame ${index + 1} of ${frameCount}`;
        }
      }

      if (page.consoleErrors.length) {
        const unique = [...new Set(page.consoleErrors)].slice(0, 5);
        warnings.push(`The render browser reported: ${unique.join(' | ')}`);
      }
    }

    if (job.kind === 'preview' || options.kind === 'preview') {
      job.status = 'done';
      job.finishedAt = Date.now();
      job.progress = 1;
      job.stage = 'Done';
      job.report = { frames: job.framesDone, sessionDir };
      return job;
    }

    if (isCancelled(job)) return job;

    /* ---------------- encode ---------------- */
    const outputDir = join(sessionDir, 'out');
    await fs.mkdir(outputDir, { recursive: true });

    if (options.kind === 'video') {
      const formats = exportFormats(tools);
      const format = formats.find((entry) => entry.id === options.format) ?? formats.find((entry) => entry.available && entry.id === 'mp4-h264');
      if (!format || !format.available) {
        const available = formats.filter((entry) => entry.available).map((entry) => entry.label);
        throw new Error(
          `The requested format (${options.format ?? 'mp4-h264'}) is not supported by the ffmpeg build on this machine. Available alternatives: ${available.join(', ') || 'PNG image sequence'}.`,
        );
      }
      job.status = 'encoding';
      job.stage = `Encoding ${format.label}`;
      const stem = safeStem(options.fileName ?? doc.meta.name, 'motion-lab-export');
      const target = join(outputDir, `${stem}.${format.extension}`);
      const result = await encodeVideo(tools, join(frameDir, 'f%06d.png'), target, {
        videoEncoder: format.video,
        audioEncoder: format.audio,
        fps,
        quality: options.quality ?? 85,
        ...(audioPath && format.audio !== 'none' ? { audioInput: audioPath } : {}),
      });
      if (!result.ok) throw new Error(result.error ?? 'The encoder failed.');

      const info = await inspectExport(tools, target);
      const size = (await fs.stat(target)).size;
      job.outputPath = target;
      job.outputName = `${stem}.${format.extension}`;
      job.outputMime = format.extension === 'webm' ? 'video/webm' : format.extension === 'mkv' ? 'video/x-matroska' : 'video/mp4';
      job.outputSize = size;
      job.report = {
        format: format.label,
        video: info?.video ?? null,
        audio: info?.audio ?? null,
        requestedFrames: frameCount,
        requestedDuration: frameCount / fps,
        hasAudio: Boolean(audioPath && format.audio !== 'none'),
      };
      if (info?.video && info.video.frames && Math.abs(info.video.frames - frameCount) > 1) {
        warnings.push(`The encoder wrote ${info.video.frames} frames where ${frameCount} were requested.`);
      }
      if (info?.video && (info.video.width !== width || info.video.height !== height)) {
        warnings.push(`The encoder produced ${info.video.width}×${info.video.height} instead of ${width}×${height}.`);
      }
      if (audioPath && info && !info.audio) {
        warnings.push('The soundtrack was mixed but the exported file has no audio stream.');
      }
      job.status = 'done';
      job.finishedAt = Date.now();
      job.progress = 1;
      job.stage = 'Done';
      return job;
    }

    if (options.kind === 'png-sequence') {
      job.status = 'encoding';
      job.stage = 'Packaging PNG sequence';
      const entries = [];
      const names = (await fs.readdir(frameDir)).filter((/** @type {string} */ name) => name.endsWith('.png')).sort();
      for (let index = 0; index < names.length; index += 1) {
        entries.push({ name: names[index], data: await fs.readFile(join(frameDir, names[index])) });
        job.progress = (index + 1) / Math.max(1, names.length);
      }
      if (audioPath) {
        // The soundtrack travels with the sequence so it can be re-muxed later.
        entries.push({ name: 'soundtrack.wav', data: await fs.readFile(audioPath) });
      }
      entries.push({
        name: 'frames.json',
        data: Buffer.from(JSON.stringify({
          project: doc.meta.name,
          width, height, fps,
          rangeStart, rangeEnd,
          frames: names.length,
          format: 'PNG sequence, one file per composition frame, 1-based index',
        }, null, 2), 'utf8'),
      });
      const stem = safeStem(options.fileName ?? doc.meta.name, 'motion-lab-frames');
      const target = join(outputDir, `${stem}-png-sequence.zip`);
      await writeZip(entries, target);
      job.outputPath = target;
      job.outputName = `${stem}-png-sequence.zip`;
      job.outputMime = 'application/zip';
      job.outputSize = (await fs.stat(target)).size;
      job.status = 'done';
      job.finishedAt = Date.now();
      job.progress = 1;
      job.stage = 'Done';
      job.report = { frames: names.length, hasAudio: Boolean(audioPath) };
      return job;
    }

    if (options.kind === 'package') {
      job.status = 'finishing';
      job.stage = 'Packaging project';
      await packageProject({ workspace, doc, sessionDir, outputDir, options, job });
      job.status = 'done';
      job.finishedAt = Date.now();
      job.progress = 1;
      job.stage = 'Done';
      return job;
    }

    throw new Error(`Unknown export kind "${options.kind}".`);
  } catch (error) {
    if (!isCancelled(job)) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.stage = 'Failed';
    }
    return job;
  } finally {
    if (!options.keepScratch) {
      // Keep the output directory, drop the render scratch.
      await removeTree(join(sessionDir, 'chrome-profile'));
      await removeTree(join(sessionDir, 'video'));
      if (job.status !== 'failed') await removeTree(frameDir);
    }
    if (page) await page.close();
  }
}

/* ------------------------------------------------------------------ *
 * Assets
 * ------------------------------------------------------------------ */

/**
 * @param {object} context
 * @param {Workspace} context.workspace
 * @param {ProjectDoc} context.doc
 * @param {string} context.assetDir
 * @param {string} context.videoDir
 * @param {number} context.fps
 * @param {number} context.rangeStart
 * @param {number} context.rangeEnd
 * @param {ExportJob} context.job
 * @param {string[]} context.warnings
 * @param {Awaited<ReturnType<typeof probeTools>>} context.tools
 * @returns {Promise<Record<string, any>>}
 */
async function prepareAssets({ workspace, doc, assetDir, videoDir, fps, rangeStart, rangeEnd, job, warnings, tools }) {
  /** @type {Record<string, any>} */
  const map = {};
  const used = new Set();
  for (const clip of doc.clips) if (clip.assetId) used.add(clip.assetId);
  for (const nested of doc.compositions) for (const clip of nested.clips) if (clip.assetId) used.add(clip.assetId);

  for (const assetId of used) {
    if (isCancelled(job)) return map;
    const asset = await resolveAsset(workspace, doc, assetId);
    if (!asset) {
      warnings.push(`A clip referenced media "${assetId}" that is not in the library; it will render as nothing.`);
      continue;
    }
    const mediaDir = join(workspace.media, asset.id);
    const original = await findOriginal(mediaDir, asset);
    if (!original) {
      warnings.push(`"${asset.name}" is missing from the media library, so its clips will render as nothing. Relink it to include it in exports.`);
      continue;
    }
    job.stage = `Preparing ${asset.name}`;
    job.progress = 0;

    if (asset.kind === 'video') {
      const target = join(videoDir, asset.id);
      const frames = Math.max(1, Math.ceil((rangeEnd - rangeStart) * fps) + 4);
      const probe = await probeMedia(tools, original);
      const result = await extractVideoFrames(tools, original, target, {
        startTime: rangeStart,
        duration: (rangeEnd - rangeStart) + 2,
        fps,
        width: probe.width || asset.width || 1920,
        height: probe.height || asset.height || 1080,
        onProgress: (fraction) => { job.progress = fraction * 0.5; },
      });
      if (!result.ok) {
        warnings.push(`Frames from "${asset.name}" could not be extracted (${result.error}). Clips using it will render black.`);
        continue;
      }
      map[asset.id] = {
        kind: 'video-sequence',
        url: `/api/exports/${job.id}/video/${asset.id}/f%06d.png`,
        startTime: rangeStart,
        fps,
        frameCount: result.frames,
        width: probe.width || asset.width || 1920,
        height: probe.height || asset.height || 1080,
        duration: probe.duration || asset.duration,
        frameOffset: Math.min(...Array.from({ length: frames }, (_, i) => i)) + 1,
      };
      continue;
    }

    if (asset.kind === 'image') {
      const target = join(assetDir, `${asset.id}${extOf(original)}`);
      await fs.copyFile(original, target);
      map[asset.id] = {
        kind: 'image',
        url: `/api/exports/${job.id}/assets/${asset.id}${extOf(original)}`,
        width: asset.width,
        height: asset.height,
      };
      continue;
    }

    if (asset.kind === 'audio') {
      const target = join(assetDir, `${asset.id}.wav`);
      if (!existsSync(target)) {
        const ok = await decodeAudioToWavCached(tools, original, target);
        if (!ok) warnings.push(`"${asset.name}" could not be decoded for the mixdown; its clips will be silent in the export.`);
      }
      map[asset.id] = {
        kind: 'audio',
        url: `/api/exports/${job.id}/assets/${asset.id}.wav`,
        duration: asset.duration,
      };
      continue;
    }
  }
  return map;
}

/**
 * Find an asset's metadata: from the project document first, then from the media
 * folder's own `meta.json`. The second source matters because a document can name
 * clips that reference library media it does not itself list (an imported preset,
 * a project opened before the library finished loading), and an export should
 * still render those rather than silently dropping them.
 *
 * @param {Workspace} workspace
 * @param {ProjectDoc} doc
 * @param {string} assetId
 * @returns {Promise<any|null>}
 */
async function resolveAsset(workspace, doc, assetId) {
  const fromDoc = doc.assets.find((entry) => entry.id === assetId);
  if (fromDoc) return fromDoc;
  const meta = await readJsonFile(join(workspace.media, assetId, 'meta.json'));
  return meta ?? null;
}

/**
 * @param {Awaited<ReturnType<typeof probeTools>>} tools
 * @param {string} source
 * @param {string} target
 * @returns {Promise<boolean>}
 */
async function decodeAudioToWavCached(tools, source, target) {
  const { decodeAudioToWav } = await import('./media.js');
  return decodeAudioToWav(tools, source, target, 48000);
}

/**
 * @param {string} mediaDir
 * @param {{fileName:string}} asset
 * @returns {Promise<string|null>}
 */
async function findOriginal(mediaDir, asset) {
  try {
    const entries = await fs.readdir(mediaDir);
    const match = entries.find((/** @type {string} */ name) => name.startsWith('original.'));
    if (match) return join(mediaDir, match);
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function extOf(filePath) {
  const match = /\.[A-Za-z0-9]+$/.exec(filePath);
  return match ? match[0] : '.bin';
}

/* ------------------------------------------------------------------ *
 * Soundtrack
 * ------------------------------------------------------------------ */

/**
 * Mix every audio clip on the timeline into a single WAV for the encoder.
 * @param {object} context
 * @param {Workspace} context.workspace
 * @param {ProjectDoc} context.doc
 * @param {any[]} context.audioClips
 * @param {string} context.assetDir
 * @param {string} context.sessionDir
 * @param {number} context.fps
 * @param {number} context.rangeStart
 * @param {number} context.rangeEnd
 * @param {any} context.tools
 * @param {string[]} context.warnings
 * @param {any} context.mixAudio
 * @returns {Promise<string|null>}
 */
async function mixSoundtrack({ workspace, doc, audioClips, assetDir, sessionDir, fps, rangeStart, rangeEnd, tools, warnings, mixAudio }) {
  /** @type {Record<string, {left:Float32Array, right:Float32Array, sampleRate:number}>} */
  const sources = {};
  for (const assetId of new Set(audioClips.map((clip) => clip.assetId))) {
    const wavPath = join(assetDir, `${assetId}.wav`);
    const decoded = (await fs.exists(wavPath)) ? await readWav(wavPath) : null;
    if (decoded) {
      sources[assetId] = decoded;
    } else {
      warnings.push(`Audio asset ${assetId} could not be decoded for the mixdown.`);
    }
  }
  if (Object.keys(sources).length === 0) return null;

  const sampleRate = 48000;
  const tracksById = new Map(doc.tracks.map((track) => [track.id, track]));
  const anySolo = doc.tracks.some((track) => track.kind === 'audio' && track.solo);
  const clips = audioClips
    .map((clip) => {
      const track = tracksById.get(clip.trackId);
      const trackVolume = track?.volume ?? 1;
      const muted = Boolean(track?.muted) || (anySolo && !track?.solo);
      return {
        start: clip.start,
        duration: clip.duration,
        inPoint: clip.inPoint,
        volume: (clip.volume ?? 1) * trackVolume,
        pan: clip.pan ?? 0,
        fadeIn: clip.fadeIn ?? 0,
        fadeOut: clip.fadeOut ?? 0,
        muted,
        assetId: clip.assetId,
      };
    });

  const mixed = mixAudio({
    clips,
    sources,
    sampleRate,
    start: rangeStart,
    duration: rangeEnd - rangeStart,
    masterGain: doc.audioSettings?.masterGain ?? 1,
  });

  const target = join(sessionDir, 'soundtrack.wav');
  await writeWav(target, mixed.left, mixed.right, sampleRate);
  return target;
}

/* ------------------------------------------------------------------ *
 * Project package
 * ------------------------------------------------------------------ */

/**
 * Build a portable `.mlab.zip`: the project document plus every media file it
 * needs, so a project can be moved to another machine and reopened.
 * @param {object} context
 * @param {Workspace} context.workspace
 * @param {ProjectDoc} context.doc
 * @param {string} context.sessionDir
 * @param {string} context.outputDir
 * @param {ExportOptions} context.options
 * @param {ExportJob} context.job
 */
async function packageProject({ workspace, doc, sessionDir, outputDir, options, job }) {
  /** @type {Array<{name:string, data:Buffer}>} */
  const entries = [];
  const document = JSON.parse(JSON.stringify(doc));
  document.meta.exportedAt = Date.now();
  entries.push({ name: 'project.json', data: Buffer.from(JSON.stringify(document, null, 2), 'utf8') });
  entries.push({
    name: 'README.txt',
    data: Buffer.from(
      [
        `Motion Lab project package`,
        `Project:   ${doc.meta.name}`,
        `Format:    ${doc.format} v${doc.version}`,
        `Composition: ${doc.composition.width}x${doc.composition.height} @ ${doc.composition.fps}fps, ${doc.composition.duration}s`,
        `Clips:     ${doc.clips.length} across ${doc.tracks.length} tracks`,
        '',
        'To reopen this project: launch Motion Lab, choose "Import package" in the',
        'Projects menu, and pick this zip. The media folder below is what the',
        'project document refers to by asset id.',
        '',
      ].join('\n'),
      'utf8',
    ),
  });

  /** @type {Set<string>} */
  const used = new Set();
  for (const clip of doc.clips) if (clip.assetId) used.add(clip.assetId);
  for (const nested of doc.compositions) for (const clip of nested.clips) if (clip.assetId) used.add(clip.assetId);

  let copied = 0;
  for (const assetId of used) {
    const asset = doc.assets.find((entry) => entry.id === assetId);
    if (!asset) continue;
    const mediaDir = join(workspace.media, asset.id);
    const original = await findOriginal(mediaDir, asset);
    if (!original) continue;
    const data = await fs.readFile(original);
    entries.push({ name: `media/${asset.id}/${asset.fileName}`, data });
    copied += 1;
    job.progress = copied / Math.max(1, used.size);
    job.stage = `Packaging ${asset.name}`;
  }

  const stem = safeStem(options.fileName ?? doc.meta.name, 'motion-lab-project');
  const target = join(outputDir, `${stem}.mlab.zip`);
  await writeZip(entries, target);
  job.outputPath = target;
  job.outputName = `${stem}.mlab.zip`;
  job.outputMime = 'application/zip';
  job.outputSize = (await fs.stat(target)).size;
  job.report = { assets: copied, entries: entries.length };
}

/* ------------------------------------------------------------------ *
 * Housekeeping
 * ------------------------------------------------------------------ */

/**
 * Remove export scratch space older than `maxAgeMs`.
 * @param {Workspace} workspace
 * @param {number} [maxAgeMs]
 */
export async function cleanExports(workspace, maxAgeMs = 1000 * 60 * 60 * 24 * 7) {
  try {
    const entries = await fs.readdir(workspace.exports, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(workspace.exports, entry.name);
      const stat = await fs.stat(full);
      if (now - stat.mtimeMs > maxAgeMs) await removeTree(full);
    }
  } catch {
    /* best effort */
  }
}

/**
 * How much scratch space exports are using.
 * @param {Workspace} workspace
 * @returns {Promise<number>}
 */
export function exportScratchSize(workspace) {
  return directorySize(workspace.exports);
}

export { probeTools, exportFormats, probeMedia, inspectExport, run, spawn, sleep };
