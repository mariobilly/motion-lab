/**
 * The render harness.
 *
 * This page is what the exporter drives. It loads the *same* engine modules the
 * editor uses, at the export resolution, and renders one frame per request
 * through the DevTools protocol. There is no second renderer to drift out of
 * sync: an exported frame is the preview frame.
 *
 * The harness is also usable by hand (`/harness.html`) for eyeballing an export
 * session, and by the automated verification script.
 */

import { normalizeProject } from '/core/document.js';
import { RenderContext, renderFrame } from '/core/render.js';
import { buildMappingCurves } from '/core/audio.js';

/** @type {any} */
let state = null;

const status = document.getElementById('status');
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('stage'));

/**
 * @param {string} message
 */
function setStatus(message) {
  if (status) status.textContent = message;
}

/**
 * Load an export session: either straight from a POSTed payload (tests) or from
 * the session file the server wrote for this job id.
 *
 * @param {string|object} source Job id, or a session object directly.
 * @returns {Promise<{ok:boolean, error?:string, warnings?:string[]}>}
 */
async function load(source) {
  /** @type {any} */
  let session;
  if (typeof source === 'string') {
    const response = await fetch(`/api/exports/${source}/scratch/session.json`);
    if (!response.ok) {
      return { ok: false, error: `The render session file could not be read (HTTP ${response.status}).` };
    }
    session = await response.json();
  } else {
    session = source;
  }

  const warnings = [];
  const { doc, issues } = normalizeProject(session.doc);
  for (const issue of issues) if (issue.level !== 'info') warnings.push(issue.message);

  const options = session.options ?? {};
  const width = Math.max(16, Math.round(options.width ?? doc.composition.width));
  const height = Math.max(16, Math.round(options.height ?? doc.composition.height));

  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
  const assets = options.assets ?? {};

  const modulation = (options.modulation ?? []).map((curve) => ({
    id: curve.id,
    target: curve.target,
    clipId: curve.clipId,
    mode: curve.mode,
    frames: curve.frames,
    values: Float32Array.from(curve.values ?? []),
    raws: Float32Array.from(curve.values ?? []),
  }));

  // The asset server hands back a compact description of each prepared file:
  // images and video frame sequences become ImageBitmaps, decoded once, and
  // keyed by the *frame index the composition asks for*.
  /** @type {Map<string, any>} */
  const assetCache = new Map();
  /** @type {Map<string, HTMLImageElement|ImageBitmap>} */
  const frameCache = new Map();

  /**
   * @param {string} url
   * @returns {Promise<HTMLImageElement|ImageBitmap>}
   */
  async function fetchImage(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load ${url} (HTTP ${response.status})`);
    const blob = await response.blob();
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(blob);
      } catch {
        /* fall through to <img> decoding */
      }
    }
    const element = new Image();
    const url2 = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      element.onload = () => resolve(undefined);
      element.onerror = () => reject(new Error(`Could not decode ${url}`));
      element.src = url2;
    });
    URL.revokeObjectURL(url2);
    return element;
  }

  for (const [assetId, entry] of Object.entries(assets)) {
    assetCache.set(assetId, entry);
    if (entry.kind === 'image') {
      try {
        frameCache.set(assetId, await fetchImage(entry.url));
      } catch (error) {
        warnings.push(`"${assetId}" could not be loaded: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  const frameSource = {
    /**
     * @param {string} assetId
     */
    size(assetId) {
      const entry = assetCache.get(assetId);
      if (!entry) return null;
      if (entry.kind === 'image') {
        const image = /** @type {any} */ (frameCache.get(assetId));
        if (!image) return null;
        return { width: image.width ?? entry.width ?? 1, height: image.height ?? entry.height ?? 1 };
      }
      return { width: entry.width ?? 1, height: entry.height ?? 1 };
    },

    /**
     * @param {string} assetId
     * @param {number} sourceTime
     */
    frame(assetId, sourceTime) {
      const entry = assetCache.get(assetId);
      if (!entry) return null;
      if (entry.kind === 'image') return /** @type {any} */ (frameCache.get(assetId)) ?? null;
      if (entry.kind === 'video-sequence') {
        const startTime = entry.startTime ?? 0;
        const fps = entry.fps ?? doc.composition.fps;
        const index = Math.max(1, Math.round((sourceTime - startTime) * fps) + 1);
        const url = entry.url.replace('%06d', String(index).padStart(6, '0'));
        const cached = frameCache.get(url);
        if (cached) return cached;
        // A missing frame is requested synchronously by the renderer, so the
        // harness preloads the whole range before the first frame is drawn.
        return null;
      }
      return null;
    },
  };

  /* Preload video frame ranges: the renderer samples synchronously, so every
     frame it could ask for has to be resident before rendering starts. */
  let preloaded = 0;
  let totalToPreload = 0;
  for (const entry of assetCache.values()) if (entry.kind === 'video-sequence') totalToPreload += entry.frameCount;
  if (totalToPreload > 0) setStatus(`Loading ${totalToPreload} video frames…`);

  for (const [assetId, entry] of assetCache.entries()) {
    if (entry.kind !== 'video-sequence') continue;
    const batchSize = 8;
    for (let start = 1; start <= entry.frameCount; start += batchSize) {
      const batch = [];
      for (let index = start; index < Math.min(entry.frameCount + 1, start + batchSize); index += 1) {
        const url = entry.url.replace('%06d', String(index).padStart(6, '0'));
        batch.push(fetchImage(url).then((image) => {
          frameCache.set(url, image);
          preloaded += 1;
          if (preloaded % 12 === 0) setStatus(`Loading video frames… ${preloaded}/${totalToPreload}`);
        }).catch(() => {
          preloaded += 1;
        }));
      }
      await Promise.all(batch);
    }
  }

  const render = new RenderContext({
    doc,
    width,
    height,
    modulation,
    frameSource,
    rangeStart: options.rangeStart ?? 0,
  });

  state = {
    doc,
    render,
    ctx,
    width,
    height,
    options,
    warnings,
    lastTime: null,
  };

  // Warm up: resolving fonts and gradients once avoids a first-frame surprise.
  renderFrame(ctx, render, options.rangeStart ?? 0);
  setStatus('Ready');
  return { ok: true, warnings };
}

/**
 * Render the frame at `time`. `index` is accepted so the exporter can report
 * progress without recomputing it; the renderer itself is time-based, which is
 * what keeps timing independent of how fast frames are produced.
 *
 * @param {number} index
 * @param {number} time
 * @returns {{ok:boolean, time:number, frame:number}}
 */
function seek(index, time) {
  if (!state) throw new Error('The harness has not loaded a session yet.');
  const t = Number.isFinite(time) ? time : index / state.doc.composition.fps;
  renderFrame(state.ctx, state.render, t);
  state.lastTime = t;
  return { ok: true, time: t, frame: index };
}

/**
 * Where the canvas sits on the page, so the exporter can clip precisely.
 * @returns {{x:number, y:number, width:number, height:number, deviceScaleFactor:number}}
 */
function clipRect() {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.round(rect.left * 1000) / 1000,
    y: Math.round(rect.top * 1000) / 1000,
    width: canvas.width,
    height: canvas.height,
    deviceScaleFactor: window.devicePixelRatio || 1,
  };
}

/**
 * Render a single frame and return it as a PNG data URL. Used by tests and by
 * the editor's "verify frame" check, which compares a preview pixel-for-pixel
 * against an export-rendered frame at the same timestamp.
 *
 * @param {number} time
 * @returns {string}
 */
function frameDataUrl(time) {
  if (!state) throw new Error('The harness has not loaded a session yet.');
  renderFrame(state.ctx, state.render, time);
  return canvas.toDataURL('image/png');
}

/**
 * Diagnostics the verification script asserts on.
 * @returns {any}
 */
function info() {
  if (!state) return { loaded: false };
  return {
    loaded: true,
    width: state.width,
    height: state.height,
    fps: state.doc.composition.fps,
    duration: state.doc.composition.duration,
    clips: state.doc.clips.length,
    tracks: state.doc.tracks.length,
    mappings: state.render.plan.modulation.length,
    assets: [...state.render.frameSource ? [] : []],
    warnings: state.warnings,
    debug: state.render.debug,
    lastTime: state.lastTime,
  };
}

window.MotionLabHarness = {
  load,
  seek,
  clipRect,
  frameDataUrl,
  info,
  get state() {
    return state;
  },
};

window.addEventListener('error', (event) => {
  setStatus(`Error: ${event.message}`);
});

setStatus('Waiting for an export session…');

// Auto-load when opened with ?job=<id> so a human can watch a render.
const params = new URLSearchParams(location.search);
const jobId = params.get('job');
if (jobId) {
  load(jobId).catch((error) => setStatus(`Failed: ${error.message}`));
}
