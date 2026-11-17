/**
 * The composition preview.
 *
 * Owns the visible canvas, the render loop and the playback clock.
 *
 * How preview quality stays honest
 * --------------------------------
 * The canvas is sized `composition * quality` (1, 1/2 or 1/4). Everything the
 * renderer draws is expressed relative to the composition, and every pixel-sized
 * effect divides by `deviceScale` (composition pixels per device pixel), so a
 * quarter-resolution preview is a quarter-resolution *version of the same
 * picture* -- not a differently-styled one. Nothing about timing, keyframes,
 * audio or the export range is touched by this setting, which is why changing it
 * cannot change the export.
 *
 * How playback stays in sync
 * --------------------------
 * The audio clock is the master. Each animation frame asks the audio engine (or
 * the wall clock when there is no audio) for the current time, snaps it to the
 * composition grid, and renders the newest frame it can. If rendering falls
 * behind, frames are *skipped* rather than queued, the time stays correct, and
 * the drop is counted and reported.
 */

import { RenderContext, renderFrame } from '/core/render.js';
import { clamp } from '/core/math.js';
import { frameToTime, snapToFrame, timeToFrame } from '/core/schema.js';
import { buildMappingCurves } from '/core/audio.js';
import { el, fitCanvas } from './ui/dom.js';

/** @typedef {import('./store.js').Store} Store */

export const PREVIEW_QUALITIES = Object.freeze([
  { value: 1, label: 'Full', hint: 'Composition resolution — exactly what an export renders' },
  { value: 0.5, label: 'Half', hint: 'Half resolution — faster, identical timing and framing' },
  { value: 0.25, label: 'Quarter', hint: 'Quarter resolution — fastest, identical timing and framing' },
]);

export class Preview {
  /**
   * @param {object} options
   * @param {Store} options.store
   * @param {import('./media.js').MediaEngine} options.media
   * @param {import('./playback.js').AudioEngine} options.audio
   */
  constructor({ store, media, audio }) {
    this.store = store;
    this.media = media;
    this.audio = audio;

    this.canvas = /** @type {HTMLCanvasElement} */ (el('canvas', { class: 'preview-canvas' }));
    this.stage = el('div', { class: 'preview-stage' }, [this.canvas]);
    this.overlayCanvas = /** @type {HTMLCanvasElement} */ (el('canvas', { class: 'preview-overlay-canvas' }));
    this.guides = el('div', { class: 'safe-guides hidden' });
    this.overlay = el('div', { class: 'preview-overlay preview-overlay--interactive' }, [this.guides, this.overlayCanvas]);
    this.badges = el('div', { class: 'preview-badge' });
    this.footer = el('div', { class: 'preview-footer' });
    this.busy = el('div', { class: 'busy-overlay hidden' });
    this.root = el('div', { class: 'preview-wrap' }, [this.stage, this.overlay, this.badges, this.footer, this.busy]);

    /** @type {RenderContext|null} */
    this.render = null;
    /** @type {CanvasRenderingContext2D|null} */
    this.ctx = null;
    /** @type {CanvasRenderingContext2D|null} */
    this.overlayCtx = null;

    this.running = false;
    this.lastFrameAt = 0;
    this.lastRenderCost = 0;
    /** @type {number|null} */
    this.rafId = null;
    /** @type {Array<{at:number, cost:number}>} */
    this.frameTimes = [];
    this.needsRender = true;
    this.needsOverlay = true;
    this.overlayHandler = null;
    this.quality = 1;

    /* interaction state */
    this.pointerMode = null;
    this.stage.addEventListener('pointerdown', (event) => this.onStagePointerDown(event));
    window.addEventListener('pointermove', (event) => this.onPointerMove(event));
    window.addEventListener('pointerup', (event) => this.onPointerUp(event));
    window.addEventListener('resize', () => {
      this.layout();
      this.invalidate();
    });
    this.overlayCanvas.addEventListener('dblclick', () => this.fitToView());
  }

  /* ------------------------------------------------------------ lifecycle */

  mount() {
    this.store.on('doc', () => this.invalidate(true));
    this.store.on('playhead', () => {
      this.invalidate();
      this.syncAudioPlan();
    });
    this.store.on('transport', () => {
      this.invalidate(true);
      this.syncAudioPlan();
    });
    this.store.on('selection', () => this.invalidateOverlay());
    this.store.on('analysis', () => this.invalidate(true));
    this.store.on('library', () => this.invalidate(true));
    this.media.requestRender = () => this.invalidate();
    this.layout();
    this.start();
  }

  /* ------------------------------------------------------------ layout */

  get composition() {
    return this.store.doc.composition;
  }

  /**
   * Recompute the canvas backing size and its on-screen size.
   */
  layout() {
    const composition = this.composition;
    const quality = this.store.playback.quality;
    const width = Math.max(16, Math.round(composition.width * quality));
    const height = Math.max(16, Math.round(composition.height * quality));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.render = null;
    }
    if (this.overlayCanvas.width !== width || this.overlayCanvas.height !== height) {
      this.overlayCanvas.width = width;
      this.overlayCanvas.height = height;
      this.overlayCtx = null;
    }

    // Fit inside the available space, never upscaling past 1:1 device pixels.
    const rect = this.root.getBoundingClientRect();
    const available = { width: Math.max(80, rect.width - 36), height: Math.max(80, rect.height - 36) };
    const aspect = composition.width / composition.height;
    let displayWidth = Math.min(available.width, available.height * aspect);
    let displayHeight = displayWidth / aspect;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const maxWidth = (composition.width * dpr) / 1;
    if (displayWidth > maxWidth) {
      displayWidth = maxWidth;
      displayHeight = displayWidth / aspect;
    }
    this.stage.style.width = `${Math.round(displayWidth)}px`;
    this.stage.style.height = `${Math.round(displayHeight)}px`;
    this.displaySize = { width: displayWidth, height: displayHeight };
  }

  /**
   * Zoom is expressed by scaling the stage inside the wrapper; a "fit" resets it.
   */
  fitToView() {
    this.layout();
    this.invalidate(true);
  }

  nearestQualityLabel() {
    const entry = PREVIEW_QUALITIES.find((quality) => quality.value === this.store.playback.quality);
    return entry ? entry.label : `${Math.round(this.store.playback.quality * 100)}%`;
  }

  /* ------------------------------------------------------------ render */

  /**
   * @param {boolean} [rebuild]
   */
  invalidate(rebuild = false) {
    this.needsRender = true;
    if (rebuild) this.render = null;
  }

  invalidateOverlay() {
    this.needsOverlay = true;
  }

  ensureRenderContext() {
    const composition = this.composition;
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (
      !this.render
      || this.render.width !== width
      || this.render.height !== height
      || this.render.doc !== this.store.doc
    ) {
      this.ctx = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d', { willReadFrequently: true }));
      const curves = safeCurves(this.store);
      this.render = new RenderContext({
        doc: this.store.doc,
        width,
        height,
        modulation: curves,
        frameSource: this.media.frameSource,
        rangeStart: this.store.doc.exportRange.in,
      });
    }
    if (!this.overlayCtx) {
      this.overlayCtx = /** @type {CanvasRenderingContext2D} */ (this.overlayCanvas.getContext('2d'));
    }
    return this.render;
  }

  /**
   * Render one frame at `time`.
   * @param {number} time
   * @param {{force?:boolean}} [options]
   * @returns {boolean} whether a frame was drawn
   */
  renderAt(time, options = {}) {
    const render = this.ensureRenderContext();
    const ctx = /** @type {CanvasRenderingContext2D} */ (this.ctx);
    const started = performance.now();
    try {
      renderFrame(ctx, render, time);
    } catch (error) {
      this.store.notify('error', `The preview could not draw this frame: ${error instanceof Error ? error.message : error}`, { title: 'Render error' });
      return false;
    }
    this.lastRenderCost = performance.now() - started;
    this.lastRenderedTime = time;
    return true;
  }

  /* ------------------------------------------------------------ overlay */

  /**
   * @param {(ctx:CanvasRenderingContext2D, scale:number)=>void} handler
   */
  setOverlayHandler(handler) {
    this.overlayHandler = handler;
    this.invalidateOverlay();
  }

  drawOverlay() {
    if (!this.overlayCtx) return;
    const ctx = this.overlayCtx;
    const scale = this.overlayCanvas.width / this.composition.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    if (!this.store.ui.showOverlay) return;
    ctx.save();
    ctx.scale(scale, scale);
    ctx.lineWidth = 1.5 / scale;
    this.overlayHandler?.(ctx, scale);
    ctx.restore();
  }

  /* ------------------------------------------------------------ loop */

  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(tick);
      this.update();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  update() {
    const store = this.store;
    const composition = this.composition;

    if (store.playback.playing) {
      this.advance();
    }

    if (this.needsRender) {
      const time = this.currentRenderTime();
      this.pendingSeeksBeforeRender = this.media.pendingSeeks.size;
      if (this.pendingSeeksBeforeRender > 0 && store.playback.playing) {
        // Waiting on a video seek: keep the clock running, draw next tick.
        this.media.settleSeeks().then(() => this.invalidate());
        return;
      }
      this.renderAt(time);
      this.needsRender = false;
      if (store.playback.playing) {
        this.frameTimes.push({ at: performance.now(), cost: this.lastRenderCost });
        if (this.frameTimes.length > 30) this.frameTimes.shift();
      }
    }

    if (this.needsOverlay) {
      this.drawOverlay();
      this.needsOverlay = false;
    }

    this.updateFooter();
  }

  /**
   * The exact frame boundary the preview should draw for the current playhead.
   * @returns {number}
   */
  currentRenderTime() {
    const fps = this.composition.fps;
    const raw = this.store.playback.time;
    if (this.store.playback.playing) return snapToFrame(raw, fps);
    return clamp(raw, 0, this.composition.duration);
  }

  /**
   * Advance the playhead from the master clock and update the drop statistics.
   */
  advance() {
    const store = this.store;
    const composition = this.composition;
    const fps = composition.fps;
    const range = store.playback.loop ? store.doc.loopRange : null;
    const audioTime = this.audio.playing || store.playback.audioReady ? this.audio.currentTime() : Number.NaN;
    const wall = performance.now() / 1000;
    if (!Number.isFinite(this.wallAnchor)) {
      this.wallAnchor = wall;
      this.wallAnchorTime = store.playback.time;
    }
    let time = Number.isFinite(audioTime) && this.audio.playing
      ? audioTime
      : this.wallAnchorTime + (wall - this.wallAnchor) * store.playback.rate;

    if (range) {
      const span = range.out - range.in;
      if (span > 1e-4 && time >= range.out) {
        time = range.in + ((time - range.in) % span);
        this.resyncAudio(time);
      }
    } else if (time >= composition.duration) {
      time = composition.duration;
      store.setPlaying(false);
      store.setTime(composition.duration);
      this.resyncAudio(time);
      return;
    }

    const frame = timeToFrame(time, fps);
    const previousFrame = timeToFrame(store.playback.time, fps);
    store.playback.rate = store.playback.rate || 1;

    if (frame !== previousFrame) {
      const advanced = frame - previousFrame;
      if (advanced > 1) {
        const skipped = Math.max(0, advanced - 1);
        if (skipped > 0) {
          // Only count a skip as a drop when the renderer is actually behind,
          // not when the clock simply jumped by more than one frame at a rate
          // change or a loop wrap.
          const expected = 1000 / fps;
          if (this.lastRenderCost > expected * 0.9) {
            store.playback.droppedFrames += skipped;
            store.playback.lastDropAt = performance.now();
          }
        }
      }
      store.playback.renderedFrames += 1;
    }

    const snapped = frameToTime(frame, fps);
    store.playback.time = snapped;
    this.needsRender = true;
  }

  /**
   * Re-anchor the wall clock and restart the schedule (loop wrap, seek, rate).
   * @param {number} time
   */
  resyncAudio(time) {
    this.wallAnchor = performance.now() / 1000;
    this.wallAnchorTime = time;
    if (this.store.playback.playing) {
      this.audio.play(time);
      this.wallAnchor = performance.now() / 1000;
      this.wallAnchorTime = time;
    }
  }

  /* ------------------------------------------------------------ controls */

  play() {
    const store = this.store;
    if (store.playback.playing) return;
    const range = store.playback.loop ? store.doc.loopRange : { in: 0, out: this.composition.duration };
    let from = store.playback.time;
    if (from >= range.out - 1e-3) from = range.in;
    store.playback.droppedFrames = 0;
    store.playback.renderedFrames = 0;
    this.frameTimes = [];
    store.setTime(from);
    this.wallAnchor = performance.now() / 1000;
    this.wallAnchorTime = from;
    store.setPlaying(true);
    this.audio.play(from);
    this.invalidate();
  }

  pause() {
    const time = this.store.playback.time;
    this.store.setPlaying(false);
    this.audio.stop();
    this.wallAnchor = Number.NaN;
    this.store.setTime(time);
    this.invalidate();
  }

  togglePlay() {
    if (this.store.playback.playing) this.pause();
    else this.play();
  }

  /**
   * Seek to an absolute time and keep the audio in step.
   * @param {number} time
   * @param {{silent?:boolean}} [options]
   */
  seek(time) {
    const clamped = clamp(time, 0, this.composition.duration);
    this.store.playback.time = clamped;
    this.wallAnchor = performance.now() / 1000;
    this.wallAnchorTime = clamped;
    if (this.store.playback.playing) this.audio.play(clamped);
    this.needsRender = true;
    this.needsOverlay = true;
    this.store.emit('playhead');
  }

  /**
   * @param {number} frames
   */
  step(frames) {
    const fps = this.composition.fps;
    const frame = timeToFrame(this.store.playback.time, fps) + frames;
    this.seek(frameToTime(frame, fps));
  }

  goToStart() {
    this.seek(this.store.playback.loop ? this.store.doc.loopRange.in : 0);
  }

  goToEnd() {
    this.seek(this.store.playback.loop ? this.store.doc.loopRange.out : this.composition.duration);
  }

  /**
   * @param {number} quality
   */
  setQuality(quality) {
    if (this.store.playback.quality === quality) return;
    this.store.playback.quality = quality;
    this.layout();
    this.render = null;
    this.invalidate(true);
    this.store.emit('transport');
    const entry = PREVIEW_QUALITIES.find((candidate) => candidate.value === quality);
    this.store.notify('info', `Preview quality: ${entry?.label ?? quality}. Timing and the exported result are unchanged — only the preview raster is.`, { title: 'Preview', timeout: 4000 });
  }

  /**
   * Rebuild the live audio schedule from the document.
   */
  syncAudioPlan() {
    const doc = this.store.doc;
    const soloed = doc.tracks.some((track) => track.kind === 'audio' && track.solo);
    const plan = doc.clips
      .filter((clip) => clip.kind === 'audio' && clip.assetId)
      .map((clip) => {
        const track = doc.tracks.find((entry) => entry.id === clip.trackId);
        const muted = Boolean(track?.muted) || (soloed && !track?.solo);
        return {
          id: clip.id,
          assetId: /** @type {string} */ (clip.assetId),
          start: clip.start,
          duration: clip.duration,
          inPoint: clip.inPoint,
          volume: muted ? 0 : (clip.volume ?? 1) * (track?.volume ?? 1),
          pan: clip.pan ?? 0,
          fadeIn: clip.fadeIn ?? 0,
          fadeOut: clip.fadeOut ?? 0,
        };
      });
    const signature = JSON.stringify(plan);
    if (signature === this.audioPlanSignature) return;
    this.audioPlanSignature = signature;
    this.audio.setPlan(plan);
  }

  /* ------------------------------------------------------------ stage interaction */

  /**
   * Convert a pointer position on the stage into composition coordinates.
   * @param {PointerEvent|MouseEvent} event
   * @returns {{x:number, y:number}}
   */
  toComposition(event) {
    const rect = this.overlayCanvas.getBoundingClientRect();
    const composition = this.composition;
    return {
      x: ((event.clientX - rect.left) / rect.width) * composition.width,
      y: ((event.clientY - rect.top) / rect.height) * composition.height,
    };
  }

  /**
   * @param {PointerEvent} event
   */
  onStagePointerDown(event) {
    if (event.button !== 0) return;
    const point = this.toComposition(event);
    this.pointerMode = this.hitTest(point) ? 'transform' : null;
    this.pointerStart = point;
    if (this.pointerMode) {
      this.store.beginGesture('Drag layer');
      event.preventDefault();
    }
  }

  /**
   * @param {PointerEvent} event
   */
  onPointerMove(event) {
    if (!this.pointerMode) return;
    const point = this.toComposition(event);
    const dx = point.x - this.pointerStart.x;
    const dy = point.y - this.pointerStart.y;
    const clip = this.store.primaryClip;
    if (!clip) return;
    clip.transform.x = Math.round(clip.transform.x + dx);
    clip.transform.y = Math.round(clip.transform.y + dy);
    this.pointerStart = point;
    this.store.emit('doc');
    this.invalidate();
    this.invalidateOverlay();
  }

  onPointerUp() {
    if (!this.pointerMode) return;
    this.pointerMode = null;
    this.store.endGesture(true);
  }

  /**
   * Is a composition-space point inside the selected clip's rectangle?
   * @param {{x:number,y:number}} point
   * @returns {boolean}
   */
  hitTest(point) {
    return this.selectedClipRect() !== null && pointInRect(point, /** @type {any} */ (this.selectedClipRect()));
  }

  /**
   * The selected clip's on-screen rectangle, in composition coordinates.
   * @returns {{x:number,y:number,width:number,height:number,rotation:number}|null}
   */
  selectedClipRect() {
    const clip = this.store.primaryClip;
    if (!clip || clip.kind === 'audio' || clip.kind === 'adjustment') return null;
    const composition = this.composition;
    const transform = clip.transform;
    const meta = clip.assetId ? this.store.doc.assets.find((asset) => asset.id === clip.assetId) : null;
    const sourceWidth = clip.kind === 'graphic' ? composition.width * (clip.graphic?.width ?? 1)
      : clip.kind === 'text' ? composition.width
      : meta?.width ?? composition.width;
    const sourceHeight = clip.kind === 'graphic' ? composition.height * (clip.graphic?.height ?? 1)
      : clip.kind === 'text' ? composition.height
      : meta?.height ?? composition.height;
    const visibleWidth = Math.max(1, sourceWidth * (1 - transform.cropLeft - transform.cropRight));
    const visibleHeight = Math.max(1, sourceHeight * (1 - transform.cropTop - transform.cropBottom));
    const fit = Math.max(composition.width / visibleWidth, composition.height / visibleHeight);
    const width = visibleWidth * fit * transform.scaleX;
    const height = visibleHeight * fit * transform.scaleY;
    const anchorX = composition.width * transform.anchorX;
    const anchorY = composition.height * transform.anchorY;
    const centerX = composition.width / 2 + transform.x - anchorX + (width / transform.scaleX) * transform.anchorX;
    const centerY = composition.height / 2 + transform.y - anchorY + (height / transform.scaleY) * transform.anchorY;
    return { x: centerX - width / 2, y: centerY - height / 2, width, height, rotation: transform.rotation };
  }

  /* ------------------------------------------------------------ footer */

  updateFooter() {
    const store = this.store;
    const playback = store.playback;
    const stats = [];
    stats.push(`${this.canvas.width}\u00d7${this.canvas.height}`);
    stats.push(`${this.nearestQualityLabel()} preview`);
    stats.push(`${Math.round(this.lastRenderCost * 10) / 10} ms/frame`);
    if (playback.playing && playback.droppedFrames > 0) {
      const total = playback.droppedFrames + playback.renderedFrames;
      stats.push(`${playback.droppedFrames} dropped (${Math.round((playback.droppedFrames / Math.max(1, total)) * 100)}%)`);
    }
    const signature = `${stats.join('|')}|${store.ui.showSafeGuides}`;
    if (signature === this.footerSignature) return;
    this.footerSignature = signature;

    const children = stats.map((text, index) => el('span', {
      class: `stat-chip${index === 3 ? ' stat-chip--warn' : ''}`,
      text,
    }));
    const dropHint = playback.droppedFrames > 0 && playback.playing
      ? el('span', { class: 'stat-chip stat-chip--warn', title: 'Playback is behind the target frame rate. Lower the preview quality to keep up; the export is unaffected.', text: 'below target fps' })
      : null;
    this.footer.replaceChildren(...children, ...(dropHint ? [dropHint] : []));
  }

  /**
   * Show or hide the modal busy overlay with a message and optional progress.
   * @param {string|null} message
   * @param {number} [progress] 0..1, negative for indeterminate
   */
  setBusy(message, progress = -1) {
    if (!message) {
      this.busy.classList.add('hidden');
      this.busy.replaceChildren();
      return;
    }
    this.busy.classList.remove('hidden');
    const bar = el('div', { class: 'progress' }, [
      el('div', {
        class: `progress__fill${progress < 0 ? ' progress__fill--indeterminate' : ''}`,
        style: progress >= 0 ? { width: `${Math.round(progress * 100)}%` } : {},
      }),
    ]);
    this.busy.replaceChildren(el('div', { class: 'spinner' }), el('div', { text: message }), bar);
  }

  /**
   * Update the badge row above the preview.
   * @param {HTMLElement[]} children
   */
  setBadges(children) {
    this.badges.replaceChildren(...children);
  }
}

/**
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {{x:number,y:number}} point
 * @returns {boolean}
 */
function pointInRect(rect, point) {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

/**
 * Build audio modulation curves without letting a bad mapping break the preview.
 * @param {Store} store
 */
function safeCurves(store) {
  try {
    return buildMappingCurves(store.doc, {
      rangeStart: store.doc.exportRange.in,
      rangeEnd: store.doc.exportRange.out,
    }).values().toArray();
  } catch (error) {
    console.warn('[motion-lab] audio mapping failed; continuing without modulation', error);
    return [];
  }
}

/**
 * Export a canvas as a Blob without blocking the UI.
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Blob|null>}
 */
export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolvePromise) => canvas.toBlob((blob) => resolvePromise(blob), type, quality));
}

export { fitCanvas, frameToTime, timeToFrame };
