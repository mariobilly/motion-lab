/**
 * The multitrack timeline.
 *
 * Rendering strategy: the ruler, the lane background, every clip body and the
 * playhead are painted into two canvases (a static one and an interactive
 * overlay), while clip interaction is delegated from a single transparent layer
 * on top. That keeps a 200-clip timeline at 60 fps without creating DOM nodes
 * per frame of audio waveform.
 *
 * Every interaction is a gesture: `beginGesture` on pointer-down, live mutation
 * during the drag, `endGesture` on release -- so one drag is exactly one undo
 * step, which is what the brief requires.
 */

import { clamp, formatBytes } from '/core/math.js';
import { formatDuration, formatTimecode, frameToTime, snapToFrame, timeToFrame } from '/core/schema.js';
import { activeClips } from '/core/render.js';
import { markerTimes } from '/core/audio.js';
import { allKeyTimes } from '/core/keyframes.js';
import { button, clear, drag, el, iconButton, ICONS, select } from './ui/dom.js';

/** Track lane colours by clip kind. */
const CLIP_COLORS = {
  image: { from: '#2f3f76', to: '#1d2748' },
  video: { from: '#1f4f6b', to: '#14313f' },
  text: { from: '#5a2f6f', to: '#331a3e' },
  graphic: { from: '#6b4520', to: '#3d2611' },
  audio: { from: '#1f5a4a', to: '#123029' },
  adjustment: { from: '#5c5c22', to: '#33330f' },
  nested: { from: '#1f5a6b', to: '#0f2f38' },
};

const MIN_CLIP_PIXELS = 4;

export class Timeline {
  /**
   * @param {object} options
   * @param {import('./store.js').Store} options.store
   * @param {import('./media.js').MediaEngine} options.media
   * @param {import('./preview.js').Preview} options.preview
   */
  constructor({ store, media, preview }) {
    this.store = store;
    this.media = media;
    this.preview = preview;

    this.rulerCanvas = /** @type {HTMLCanvasElement} */ (el('canvas'));
    this.contentCanvas = /** @type {HTMLCanvasElement} */ (el('canvas'));
    this.overlayCanvas = /** @type {HTMLCanvasElement} */ (el('canvas'));
    this.clickLayer = el('div', { class: 'timeline__click-layer' });
    this.content = el('div', { class: 'timeline__content' }, [this.contentCanvas, this.overlayCanvas, this.clickLayer]);
    this.lanes = el('div', { class: 'timeline__lanes' }, [
      el('div', { class: 'timeline__ruler' }, [this.rulerCanvas]),
      this.content,
    ]);
    this.heads = el('div', { class: 'timeline__heads' }, [
      el('div', { class: 'timeline__head-spacer' }),
      el('div', { class: 'timeline__heads-scroll' }),
    ]);
    this.body = el('div', { class: 'timeline__body' }, [this.heads, this.lanes]);
    this.toolbar = el('div', { class: 'timeline__toolbar' });
    this.root = el('div', { class: 'timeline' }, [this.toolbar, this.body]);

    /** pixels per second */
    this.zoom = store.doc.timeline.zoom;
    this.scrollX = store.doc.timeline.scroll;
    this.laneOffsets = new Map();
    this.totalHeight = 0;

    this.dragState = null;
    this.marquee = null;
    this.hoverClipId = null;
    /** @type {Map<string, HTMLCanvasElement>} */
    this.thumbCache = new Map();
    /** @type {Map<string, {peaks:number[], min:number, max:number}>} */
    this.waveCache = new Map();

    this.buildToolbar();
    this.attach();
    this.rebuildHeads();
    this.invalidate(true);
  }

  mount() {
    this.store.on('doc', () => {
      this.rebuildHeads();
      this.invalidate(true);
    });
    this.store.on('selection', () => this.invalidate(true));
    this.store.on('playhead', () => this.drawOverlay());
    this.store.on('timeline', () => {
      this.zoom = this.store.doc.timeline.zoom;
      this.scrollX = this.store.doc.timeline.scroll;
      this.invalidate(true);
    });
    this.store.on('library', () => {
      this.waveCache.clear();
      this.thumbCache.clear();
      this.invalidate(true);
    });
    this.store.on('transport', () => this.invalidate(true));
    this.store.on('analysis', () => {
      this.waveCache.clear();
      this.invalidate(true);
    });
    this.lanes.addEventListener('scroll', () => {
      this.scrollX = this.lanes.scrollLeft;
      this.store.doc.timeline.scroll = this.scrollX;
      this.heads.querySelector('.timeline__heads-scroll').scrollTop = this.lanes.scrollTop;
      this.draw();
    });
  }

  /* ------------------------------------------------------------ toolbar */

  buildToolbar() {
    const store = this.store;
    const doc = store.doc;

    const zoomOut = iconButton(ICONS.minus, 'Zoom out (Ctrl+scroll)', () => this.setZoom(this.zoom / 1.25));
    const zoomIn = iconButton(ICONS.plus, 'Zoom in (Ctrl+scroll)', () => this.setZoom(this.zoom * 1.25));
    const zoomFit = button('Fit', 'btn btn--tiny', { title: 'Fit the whole composition', onclick: () => this.fit() });

    const snapToggle = button(`${ICONS.grip} Snap`, 'btn btn--tiny', {
      title: 'Snap to clip edges, markers and the playhead',
      onclick: () => {
        store.doc.timeline.snap = !store.doc.timeline.snap;
        store.markDirty();
        this.refreshToolbar();
      },
    });
    const markerToggle = button(`${ICONS.key} Markers`, 'btn btn--tiny', {
      title: 'Also snap to audio markers',
      onclick: () => {
        store.doc.timeline.snapToMarkers = !store.doc.timeline.snapToMarkers;
        store.markDirty();
        this.refreshToolbar();
      },
    });

    const rangeLabel = el('span', { class: 'stat-chip', text: '' });
    this.rangeLabel = rangeLabel;

    this.toolbar.replaceChildren(
      el('span', { class: 'panel__title', text: 'Timeline' }),
      zoomOut,
      zoomIn,
      zoomFit,
      el('span', { class: 'panel__spacer' }),
      snapToggle,
      markerToggle,
      button('Split', 'btn btn--tiny', { title: 'Split selected clips at the playhead (S)', onclick: () => this.store.splitClips() }),
      button('Loop range', 'btn btn--tiny', { title: 'Set the loop to the selected clips', onclick: () => this.setLoopFromSelection() }),
      button('Export range', 'btn btn--tiny', { title: 'Set the export range to the selected clips', onclick: () => this.setExportFromSelection() }),
      rangeLabel,
    );
    this.snapToggle = snapToggle;
    this.markerToggle = markerToggle;
    this.refreshToolbar();
  }

  refreshToolbar() {
    const doc = this.store.doc;
    this.snapToggle.classList.toggle('btn--active', doc.timeline.snap);
    this.markerToggle.classList.toggle('btn--active', doc.timeline.snapToMarkers);
    const span = doc.exportRange.out - doc.exportRange.in;
    this.rangeLabel.textContent = `export ${formatTimecode(doc.exportRange.in, doc.composition.fps)} → ${formatTimecode(doc.exportRange.out, doc.composition.fps)} (${span.toFixed(2)}s)`;
  }

  /* ------------------------------------------------------------ geometry */

  /** @returns {number} pixels per second */
  get pixelsPerSecond() {
    return this.zoom;
  }

  /**
   * @param {number} time
   * @returns {number}
   */
  timeToX(time) {
    return time * this.zoom;
  }

  /**
   * @param {number} x
   * @returns {number}
   */
  xToTime(x) {
    return x / this.zoom;
  }

  /**
   * @param {string} trackId
   * @returns {{top:number, height:number}}
   */
  laneOf(trackId) {
    return this.laneOffsets.get(trackId) ?? { top: 0, height: 70 };
  }

  setZoom(zoom) {
    const clamped = clamp(zoom, 3, 600);
    if (Math.abs(clamped - this.zoom) < 1e-6) return;
    const focus = this.lanes.scrollLeft + this.lanes.clientWidth / 2;
    const focusTime = this.xToTime(focus);
    this.zoom = clamped;
    this.store.doc.timeline.zoom = clamped;
    this.store.markDirty();
    this.invalidate(true);
    requestAnimationFrame(() => {
      this.lanes.scrollLeft = Math.max(0, this.timeToX(focusTime) - this.lanes.clientWidth / 2);
      this.draw();
    });
  }

  fit() {
    const duration = this.store.doc.composition.duration;
    const width = this.lanes.clientWidth - 24;
    this.setZoom(Math.max(3, width / Math.max(1, duration)));
    this.lanes.scrollLeft = 0;
    this.draw();
  }

  /* ------------------------------------------------------------ layout */

  rebuildHeads() {
    const doc = this.store.doc;
    const container = /** @type {HTMLElement} */ (this.heads.querySelector('.timeline__heads-scroll'));
    clear(container);
    this.laneOffsets.clear();
    let top = 0;
    const soloed = doc.tracks.some((track) => track.solo);

    for (const track of doc.tracks) {
      const height = track.collapsed ? 26 : track.height;
      this.laneOffsets.set(track.id, { top, height });
      const clipCount = doc.clips.filter((clip) => clip.trackId === track.id).length;
      const head = el('div', {
        class: `track-head${track.kind === 'audio' ? ' track-head--audio' : ''}${this.store.ui.selectedTrackId === track.id ? ' track-head--selected' : ''}`,
        style: { height: `${height}px` },
        dataset: { trackId: track.id },
        onclick: () => {
          this.store.ui.selectedTrackId = track.id;
          this.store.emit('selection');
        },
      }, [
        track.collapsed
          ? iconButton(ICONS.chevronRight, 'Expand track', () => this.toggleTrack(track.id, 'collapsed'))
          : iconButton(ICONS.chevron, 'Collapse track', () => this.toggleTrack(track.id, 'collapsed')),
        el('input', {
          class: 'track-head__name',
          value: track.name,
          title: 'Rename track',
          onchange: (/** @type {Event} */ event) => {
            const value = /** @type {HTMLInputElement} */ (event.target).value.trim() || 'Track';
            this.store.edit('Rename track', () => { track.name = value; });
          },
        }),
        el('button', {
          class: `track-head__toggle track-head__toggle--lock${track.locked ? ' track-head__toggle--on' : ''}`,
          title: track.locked ? 'Unlock track' : 'Lock track (clips cannot be moved)',
          text: track.locked ? '\u25a0' : '\u25a1',
          onclick: (/** @type {Event} */ event) => {
            event.stopPropagation();
            this.toggleTrack(track.id, 'locked');
          },
        }),
        el('button', {
          class: `track-head__toggle${track.hidden ? ' track-head__toggle--on' : ''}`,
          title: track.hidden ? 'Show track' : 'Hide track',
          text: track.hidden ? '\u25cb' : '\u25c9',
          onclick: (/** @type {Event} */ event) => {
            event.stopPropagation();
            this.toggleTrack(track.id, 'hidden');
          },
        }),
        track.kind === 'visual'
          ? el('button', {
              class: `track-head__toggle track-head__toggle--solo${track.solo ? ' track-head__toggle--on' : ''}`,
              title: 'Solo this track',
              text: 'S',
              onclick: (/** @type {Event} */ event) => {
                event.stopPropagation();
                this.toggleTrack(track.id, 'solo');
              },
            })
          : null,
        el('button', {
          class: `track-head__toggle track-head__toggle--mute${track.muted ? ' track-head__toggle--on' : ''}`,
          title: track.muted ? 'Unmute' : 'Mute',
          text: 'M',
          onclick: (/** @type {Event} */ event) => {
            event.stopPropagation();
            this.toggleTrack(track.id, 'muted');
          },
        }),
        el('span', { class: 'track-head__meta', text: String(clipCount) }),
        el('div', { class: 'track-head__meta', style: { marginLeft: '2px' }, text: soloed && !track.solo ? '·' : '' }),
      ]);
      container.append(head);
      top += height;
    }
    this.totalHeight = Math.max(top, 80);
  }

  /**
   * @param {string} trackId
   * @param {'muted'|'solo'|'locked'|'hidden'|'collapsed'} key
   */
  toggleTrack(trackId, key) {
    this.store.edit(`${key === 'collapsed' ? 'Collapse' : 'Toggle'} track ${key}`, () => {
      const track = this.store.doc.tracks.find((entry) => entry.id === trackId);
      if (!track) return;
      /** @type {any} */ (track)[key] = !/** @type {any} */ (track)[key];
      if (key === 'solo' && track.solo) track.muted = false;
    });
    this.rebuildHeads();
    this.rebuildAudioPlan();
    this.invalidate(true);
  }

  rebuildAudioPlan() {
    this.preview.syncAudioPlan();
  }

  /* ------------------------------------------------------------ canvas sizes */

  invalidate(structure = false) {
    if (structure) this.structureDirty = true;
    this.dirty = true;
    requestAnimationFrame(() => this.draw());
  }

  resizeCanvases() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const duration = this.store.doc.composition.duration;
    const width = Math.max(this.lanes.clientWidth, this.timeToX(duration) + 240);
    const height = Math.max(this.totalHeight, this.lanes.clientHeight);
    for (const canvas of [this.contentCanvas, this.overlayCanvas]) {
      const targetWidth = Math.floor(width * dpr);
      const targetHeight = Math.floor(height * dpr);
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const rulerWidth = Math.max(this.lanes.clientWidth, width);
    const rulerHeight = 26;
    if (this.rulerCanvas.width !== Math.floor(rulerWidth * dpr)) {
      this.rulerCanvas.width = Math.floor(rulerWidth * dpr);
      this.rulerCanvas.height = Math.floor(rulerHeight * dpr);
      this.rulerCanvas.style.width = `${rulerWidth}px`;
      this.rulerCanvas.style.height = `${rulerHeight}px`;
    }
    this.dpr = dpr;
    this.canvasSize = { width, height, rulerWidth, rulerHeight };
  }

  /* ------------------------------------------------------------ drawing */

  draw() {
    if (!this.store) return;
    this.resizeCanvases();
    this.drawRuler();
    if (this.dirty || this.structureDirty) {
      this.drawContent();
      this.dirty = false;
      this.structureDirty = false;
    }
    this.drawOverlay();
    this.refreshToolbar();
  }

  drawRuler() {
    const ctx = /** @type {CanvasRenderingContext2D} */ (this.rulerCanvas.getContext('2d'));
    const dpr = this.dpr ?? 1;
    const { rulerWidth, rulerHeight } = this.canvasSize ?? { rulerWidth: 400, rulerHeight: 26 };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rulerWidth, rulerHeight);
    ctx.fillStyle = '#12121a';
    ctx.fillRect(0, 0, rulerWidth, rulerHeight);

    const fps = this.store.doc.composition.fps;
    const step = niceStep(this.zoom);
    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (let time = 0; time <= this.store.doc.composition.duration + step; time += step) {
      const x = Math.round(this.timeToX(time)) + 0.5;
      if (x > rulerWidth + 40) break;
      ctx.strokeStyle = '#33334a';
      ctx.beginPath();
      ctx.moveTo(x, rulerHeight - 8);
      ctx.lineTo(x, rulerHeight);
      ctx.stroke();
      ctx.fillStyle = '#8b8fa6';
      ctx.fillText(formatTimecode(time, fps), x + 4, 9);
    }
    // Minor ticks each second when there is room.
    if (this.zoom > 26) {
      ctx.strokeStyle = '#23233a';
      for (let second = 0; second <= this.store.doc.composition.duration; second += 1) {
        const x = Math.round(this.timeToX(second)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, rulerHeight - 4);
        ctx.lineTo(x, rulerHeight);
        ctx.stroke();
      }
    }

    // Range bands.
    const drawBand = (/** @type {{in:number,out:number}} */ range, /** @type {string} */ color) => {
      const x0 = this.timeToX(range.in);
      const x1 = this.timeToX(range.out);
      ctx.fillStyle = color;
      ctx.fillRect(x0, 0, Math.max(2, x1 - x0), rulerHeight);
    };
    if (this.store.playback.loop) drawBand(this.store.doc.loopRange, 'rgba(255,200,87,0.22)');
    drawBand(this.store.doc.exportRange, 'rgba(92,225,255,0.16)');

    // Audio markers.
    for (const assetId of Object.keys(this.store.doc.audio)) {
      const times = markerTimes(this.store.doc, assetId);
      const manual = new Set(this.store.doc.audioSettings.manualMarkers.map((value) => Math.round(value * 1000)));
      for (const time of times) {
        const x = Math.round(this.timeToX(time)) + 0.5;
        if (x < -10 || x > rulerWidth + 10) continue;
        const isManual = manual.has(Math.round(time * 1000));
        ctx.fillStyle = isManual ? 'rgba(255,200,87,0.95)' : 'rgba(124,245,154,0.8)';
        ctx.beginPath();
        ctx.moveTo(x - 3.5, 1);
        ctx.lineTo(x + 3.5, 1);
        ctx.lineTo(x, 8);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  drawContent() {
    const ctx = /** @type {CanvasRenderingContext2D} */ (this.contentCanvas.getContext('2d'));
    const dpr = this.dpr ?? 1;
    const { width, height } = this.canvasSize ?? { width: 400, height: 200 };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, width, height);

    const doc = this.store.doc;
    const duration = doc.composition.duration;

    // Lanes.
    for (const track of doc.tracks) {
      const lane = this.laneOf(track.id);
      ctx.fillStyle = track.kind === 'audio' ? '#0e0e16' : (doc.tracks.indexOf(track) % 2 === 0 ? '#0b0b11' : '#0d0d14');
      ctx.fillRect(0, lane.top, width, lane.height);
      ctx.strokeStyle = '#16161f';
      ctx.beginPath();
      ctx.moveTo(0, lane.top + lane.height + 0.5);
      ctx.lineTo(width, lane.top + lane.height + 0.5);
      ctx.stroke();

      // Clips.
      const clips = doc.clips.filter((clip) => clip.trackId === track.id);
      for (const clip of clips) this.drawClip(ctx, clip, lane, track.locked);
    }

    // Beyond the composition duration.
    const endX = this.timeToX(duration);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(endX, 0, Math.max(0, width - endX), height);
    ctx.strokeStyle = 'rgba(92,225,255,0.35)';
    ctx.beginPath();
    ctx.moveTo(Math.round(endX) + 0.5, 0);
    ctx.lineTo(Math.round(endX) + 0.5, height);
    ctx.stroke();
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {import('/core/schema.js').Clip} clip
   * @param {{top:number,height:number}} lane
   * @param {boolean} trackLocked
   */
  drawClip(ctx, clip, lane, trackLocked) {
    const x = this.timeToX(clip.start);
    const width = Math.max(MIN_CLIP_PIXELS, this.timeToX(clip.duration));
    const top = lane.top + 3;
    const height = lane.height - 7;
    const selected = this.store.ui.selectedClipIds.includes(clip.id);
    const colors = CLIP_COLORS[clip.kind] ?? CLIP_COLORS.image;
    const radius = 4;

    ctx.save();
    roundedRect(ctx, x, top, width, height, radius);
    ctx.clip();

    const gradient = ctx.createLinearGradient(0, top, 0, top + height);
    gradient.addColorStop(0, colors.from);
    gradient.addColorStop(1, colors.to);
    ctx.fillStyle = gradient;
    ctx.fillRect(x, top, width, height);
    if (clip.hidden) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(x, top, width, height);
    }

    // Media thumbnails / waveform inside the clip.
    if (clip.kind === 'audio') {
      this.drawWaveform(ctx, clip, x, top, width, height);
    } else if ((clip.kind === 'video' || clip.kind === 'image') && width > 34) {
      this.drawThumbnails(ctx, clip, x, top, width, height);
    } else if (clip.kind === 'graphic' && width > 24) {
      this.drawGraphicSample(ctx, clip, x, top, width, height);
    }

    // Blend/treatment badges.
    if (clip.effects.stack.length > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(x, top, Math.min(width, 3 + clip.effects.stack.length * 3), 3);
    }

    // Label.
    if (width > 30) {
      ctx.font = '600 10px "Segoe UI", system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(255,255,255,0.96)';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 3;
      const badges = [];
      if (clip.masks.length) badges.push(`◧${clip.masks.length}`);
      if (clip.blend !== 'normal') badges.push(clip.blend.slice(0, 3));
      const label = `${clip.name}${badges.length ? ` ${badges.join(' ')}` : ''}`;
      ctx.fillText(label, x + 6, top + 4, Math.max(10, width - 12));
      ctx.shadowBlur = 0;
    }

    // Keyframe strip along the bottom edge.
    const keyTimes = allKeyTimes(clip);
    if (keyTimes.length && height > 24) {
      const stripTop = top + height - 7;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(x, stripTop, width, 7);
      for (const time of keyTimes) {
        const keyX = this.timeToX(time);
        if (keyX < x - 4 || keyX > x + width + 4) continue;
        ctx.beginPath();
        ctx.moveTo(keyX, stripTop + 1);
        ctx.lineTo(keyX + 3, stripTop + 3.5);
        ctx.lineTo(keyX, stripTop + 6);
        ctx.lineTo(keyX - 3, stripTop + 3.5);
        ctx.closePath();
        ctx.fillStyle = '#ff3d8b';
        ctx.fill();
      }
    }

    // Fade ramps.
    if (clip.kind === 'audio' && (clip.fadeIn > 0 || clip.fadeOut > 0)) {
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (clip.fadeIn > 0) {
        ctx.moveTo(x, top + height);
        ctx.lineTo(x + this.timeToX(clip.fadeIn), top);
      }
      if (clip.fadeOut > 0) {
        ctx.moveTo(x + width - this.timeToX(clip.fadeOut), top);
        ctx.lineTo(x + width, top + height);
      }
      ctx.stroke();
    }

    ctx.restore();

    // Border.
    roundedRect(ctx, x + 0.5, top + 0.5, width - 1, height - 1, radius);
    ctx.strokeStyle = selected ? '#5ce1ff' : 'rgba(255,255,255,0.16)';
    ctx.lineWidth = selected ? 2 : 1;
    if (trackLocked) ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (selected) {
      ctx.strokeStyle = 'rgba(92,225,255,0.35)';
      ctx.lineWidth = 5;
      ctx.stroke();
    }
  }

  /**
   * Waveform peaks: computed from the stored analysis, so drawing never decodes
   * audio again.
   * @param {CanvasRenderingContext2D} ctx
   * @param {import('/core/schema.js').Clip} clip
   */
  drawWaveform(ctx, clip, x, top, width, height) {
    if (!clip.assetId) return;
    const analysis = this.store.doc.audio[clip.assetId];
    const middle = top + height / 2;
    ctx.fillStyle = 'rgba(124,245,154,0.55)';
    if (!analysis || !analysis.waveform?.length) {
      ctx.fillStyle = 'rgba(124,245,154,0.22)';
      ctx.fillRect(x, middle - 1, width, 2);
      return;
    }
    const peaks = analysis.waveform;
    const buckets = peaks.length / 2;
    const total = Math.max(0.001, analysis.duration || clip.duration);
    const step = Math.max(1, Math.floor(width / 2));
    const gain = Math.min(1.6, 1.2);
    const columns = Math.max(1, Math.floor(width / step));
    for (let column = 0; column < columns; column += 1) {
      const time = clip.inPoint + (column / columns) * clip.duration;
      const bucket = Math.floor((time / total) * buckets);
      if (bucket < 0 || bucket >= buckets) continue;
      const min = peaks[bucket * 2] ?? 0;
      const max = peaks[bucket * 2 + 1] ?? 0;
      const y0 = middle - max * gain * (height / 2 - 2);
      const y1 = middle - min * gain * (height / 2 - 2);
      ctx.fillRect(x + column * (width / columns), Math.min(y0, y1), Math.max(1, width / columns - 1), Math.max(1.5, Math.abs(y1 - y0)));
    }
  }

  /**
   * Video/image thumbnails: one small tile per "page", generated lazily and
   * cached per (asset, page index).
   */
  drawThumbnails(ctx, clip, x, top, width, height) {
    if (!clip.assetId) return;
    const tileWidth = Math.max(28, height * 1.6);
    const count = Math.max(1, Math.min(60, Math.floor(width / tileWidth)));
    const meta = this.store.doc.assets.find((asset) => asset.id === clip.assetId);
    if (!meta) return;
    for (let index = 0; index < count; index += 1) {
      const tileX = x + index * tileWidth;
      const tileKey = `${clip.assetId}:${index}:${Math.round(tileWidth)}`;
      const cached = this.thumbCache.get(tileKey);
      if (cached) {
        ctx.drawImage(cached, tileX, top, tileWidth, height);
        continue;
      }
      if (!this.thumbPending?.has(tileKey)) {
        this.requestThumbnail(clip, meta, index, tileWidth, height, tileKey);
      }
    }
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(x, top, width, height);
  }

  requestThumbnail(clip, meta, index, tileWidth, height, tileKey) {
    if (!this.thumbPending) this.thumbPending = new Set();
    if (this.thumbPending.size > 24) return;
    this.thumbPending.add(tileKey);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(tileWidth));
    canvas.height = Math.max(2, Math.round(height));
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    const run = async () => {
      try {
        const source = clip.kind === 'video'
          ? await this.videoThumbSource(clip, index, tileWidth)
          : await this.media.load(/** @type {string} */ (clip.assetId));
        const element = source instanceof HTMLVideoElement || source instanceof HTMLImageElement
          ? source
          : source?.element;
        if (element) {
          drawCover(ctx, element, canvas.width, canvas.height);
          this.thumbCache.set(tileKey, canvas);
          if (this.thumbCache.size > 240) this.thumbCache.delete(this.thumbCache.keys().next().value);
          this.dirty = true;
        }
      } catch {
        /* a missing thumbnail is cosmetic */
      } finally {
        this.thumbPending?.delete(tileKey);
      }
    };
    run();
  }

  /**
   * Video thumbnails ask the server for a still, which is cheap and cached.
   */
  async videoThumbSource(clip, index, tileWidth) {
    if (!clip.assetId) return null;
    const perTile = clip.duration / Math.max(1, Math.floor(this.timeToX(clip.duration) / tileWidth));
    const time = clip.inPoint + index * perTile + perTile / 2;
    const url = `/api/assets/${encodeURIComponent(clip.assetId)}/frames?at=${time.toFixed(3)}`;
    const key = `frame:${url}`;
    const cached = this.thumbCache.get(key);
    if (cached) return cached;
    const image = new Image();
    await new Promise((resolvePromise, reject) => {
      image.onload = () => resolvePromise(undefined);
      image.onerror = () => reject(new Error('no frame'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d')).drawImage(image, 0, 0);
    this.thumbCache.set(key, canvas);
    return canvas;
  }

  /**
   * A procedurally drawn sample for graphic clips (no media required).
   */
  drawGraphicSample(ctx, clip, x, top, width, height) {
    if (!clip.graphic) return;
    const spec = clip.graphic;
    const accent = spec.colorA ?? '#ff2e88';
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, top, width, height);
    ctx.clip();
    const gradient = ctx.createLinearGradient(x, top, x + width, top + height);
    gradient.addColorStop(0, accent);
    gradient.addColorStop(1, spec.colorB ?? '#12d6ff');
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = gradient;
    ctx.fillRect(x, top, width, height);
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    const step = Math.max(6, height / 3);
    for (let offset = -height; offset < width; offset += step) {
      ctx.beginPath();
      ctx.moveTo(x + offset, top + height);
      ctx.lineTo(x + offset + height, top);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawOverlay() {
    const ctx = /** @type {CanvasRenderingContext2D} */ (this.overlayCanvas.getContext('2d'));
    const dpr = this.dpr ?? 1;
    const { width, height } = this.canvasSize ?? { width: 400, height: 200 };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Export / loop bands.
    const drawBand = (/** @type {{in:number,out:number}} */ range, /** @type {string} */ fill, /** @type {string} */ stroke) => {
      const x0 = this.timeToX(range.in);
      const x1 = this.timeToX(range.out);
      ctx.fillStyle = fill;
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), height);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0 + 1, 0);
      ctx.lineTo(x0 + 1, height);
      ctx.moveTo(x1 - 1, 0);
      ctx.lineTo(x1 - 1, height);
      ctx.stroke();
    };
    if (this.store.playback.loop) drawBand(this.store.doc.loopRange, 'rgba(255,200,87,0.06)', 'rgba(255,200,87,0.7)');
    drawBand(this.store.doc.exportRange, 'rgba(92,225,255,0.05)', 'rgba(92,225,255,0.55)');

    // Marker lines.
    for (const assetId of Object.keys(this.store.doc.audio)) {
      for (const time of markerTimes(this.store.doc, assetId)) {
        const x = Math.round(this.timeToX(time)) + 0.5;
        ctx.strokeStyle = 'rgba(124,245,154,0.16)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
    }

    // Playhead.
    const playheadX = Math.round(this.timeToX(this.store.playback.time)) + 0.5;
    ctx.strokeStyle = '#ff3d8b';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = 'rgba(255,61,139,0.8)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Loop / export range handles (drag targets live in the click layer).
    ctx.fillStyle = '#5ce1ff';
    ctx.fillRect(this.timeToX(this.store.doc.exportRange.in) - 1, 0, 3, 12);
    ctx.fillRect(this.timeToX(this.store.doc.exportRange.out) - 2, 0, 3, 12);

    // Snap guide.
    if (this.snapGuide !== null && this.snapGuide !== undefined) {
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(this.timeToX(this.snapGuide)) + 0.5, 0);
      ctx.lineTo(Math.round(this.timeToX(this.snapGuide)) + 0.5, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Drop preview while media is dragged in from the library.
    if (this.dropPreview) {
      const lane = this.dropPreview.kind === 'empty'
        ? this.laneOf(this.dropPreview.trackId)
        : this.laneOf(this.dropPreview.clip.trackId);
      ctx.fillStyle = 'rgba(92,225,255,0.12)';
      ctx.fillRect(0, lane.top, width, lane.height);
      ctx.strokeStyle = 'rgba(92,225,255,0.8)';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, lane.top + 1, width - 2, lane.height - 2);
    }

    // Marquee.
    if (this.marquee) {
      ctx.fillStyle = 'rgba(92,225,255,0.14)';
      ctx.strokeStyle = 'rgba(92,225,255,0.7)';
      ctx.fillRect(this.marquee.x, this.marquee.y, this.marquee.width, this.marquee.height);
      ctx.strokeRect(this.marquee.x, this.marquee.y, this.marquee.width, this.marquee.height);
    }
  }

  /* ------------------------------------------------------------ interaction */

  attach() {
    const lanes = this.lanes;

    // Scrub on the ruler.
    drag({
      target: /** @type {HTMLElement} */ (lanes.querySelector('.timeline__ruler')),
      onStart: (event) => {
        this.store.beginGesture('Scrub');
        this.scrubFromEvent(event);
      },
      onMove: (event) => this.scrubFromEvent(event),
      onEnd: () => this.store.endGesture(true),
    });

    // Right-click marker management on the ruler.
    /** @type {HTMLElement} */ (lanes.querySelector('.timeline__ruler')).addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const time = snapToFrame(this.xToTime(this.eventX(event)), this.store.doc.composition.fps);
      const existing = this.nearestMarker(time);
      if (existing !== null && Math.abs(existing - time) < 8 / this.zoom) this.store.removeMarker(existing);
      else this.store.addMarker(time);
    });

    // Clip interactions via delegation.
    drag({
      target: this.clickLayer,
      onStart: (event) => this.onLanePointerDown(event),
      onMove: (dx, dy, event) => this.onLanePointerMove(dx, dy, event),
      onEnd: () => this.onLanePointerUp(),
    });

    this.clickLayer.addEventListener('dblclick', (event) => {
      const hit = this.hitTest(this.eventX(event), this.eventY(event));
      if (hit?.kind === 'clip' && hit.clip.kind === 'text') {
        this.store.ui.inspectorSection = 'text';
        this.store.emit('selection');
      }
    });

    this.clickLayer.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const hit = this.hitTest(this.eventX(event), this.eventY(event));
      if (hit?.kind === 'clip') this.showClipMenu(hit.clip, event.clientX, event.clientY);
    });

    this.clickLayer.addEventListener('wheel', (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      this.setZoom(this.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
    }, { passive: false });

    // The track heads share the lanes' vertical scroll so a tall stack of
    // tracks keeps its names beside the clips.
    this.lanes.addEventListener('scroll', () => {
      this.scrollX = this.lanes.scrollLeft;
      this.store.doc.timeline.scroll = this.scrollX;
      const heads = /** @type {HTMLElement} */ (this.heads.querySelector('.timeline__heads-scroll'));
      if (heads.scrollTop !== this.lanes.scrollTop) heads.scrollTop = this.lanes.scrollTop;
      this.draw();
    });

    this.attachDropTarget();
  }

  /**
   * Accept media dragged out of the library.
   *
   * The library publishes two payload shapes: an existing asset id, and a
   * description of a built-in layer (graphic kind, text, adjustment). Dropping
   * either onto a specific track places the new clip on *that* track at the drop
   * position, which is what a user dragging onto a lane expects.
   */
  attachDropTarget() {
    const layer = this.clickLayer;
    let dragDepth = 0;

    const onDragOver = (event) => {
      const data = event.dataTransfer;
      if (!data) return;
      const types = Array.from(data.types ?? []);
      const acceptable = types.includes('application/x-motion-lab-asset')
        || types.includes('application/x-motion-lab-builtin')
        || types.includes('Files');
      if (!acceptable) return;
      event.preventDefault();
      data.dropEffect = 'copy';
      this.dropPreview = this.hitTest(this.eventX(event), this.eventY(event));
      this.drawOverlay();
    };
    const onDragEnter = (event) => {
      dragDepth += 1;
      onDragOver(event);
    };
    const onDragLeave = () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        this.dropPreview = null;
        this.drawOverlay();
      }
    };
    const onDrop = async (event) => {
      dragDepth = 0;
      this.dropPreview = null;
      this.drawOverlay();
      const data = event.dataTransfer;
      if (!data) return;
      const hit = this.hitTest(this.eventX(event), this.eventY(event));

      // Files dropped straight from the desktop land in the library first, then
      // are placed on the track under the pointer.
      if (data.files && data.files.length > 0 && !data.types.includes('application/x-motion-lab-asset')) {
        event.preventDefault();
        const assets = await this.media.importFiles([...data.files]);
        if (assets.length > 0 && hit?.kind === 'clip' && this.store.fillMediaSlot(hit.clip.id, assets[0])) return;
        if (assets.length > 0 && hit?.kind === 'empty') this.placeAsset(assets[0], hit.trackId, hit.time);
        return;
      }

      const assetId = data.getData('application/x-motion-lab-asset');
      const builtin = data.getData('application/x-motion-lab-builtin');
      if (!assetId && !builtin) return;
      event.preventDefault();
      const trackId = hit?.kind === 'empty' ? hit.trackId : hit?.kind === 'clip' ? hit.clip.trackId : null;
      const time = hit?.kind === 'empty' ? hit.time : this.xToTime(this.eventX(event));

      if (assetId) {
        const asset = this.store.doc.assets.find((entry) => entry.id === assetId) ?? this.store.assets.get(assetId);
        if (!asset) return;
        // Dropped on an empty media slot (a starter's "drop media here" clip): fill it.
        if (hit?.kind === 'clip' && this.store.fillMediaSlot(hit.clip.id, asset)) return;
        this.placeAsset(asset, trackId, time);
        return;
      }
      try {
        const spec = JSON.parse(builtin);
        this.placeBuiltin(spec, trackId, time);
      } catch {
        /* an unrecognised payload is simply ignored */
      }
    };

    layer.addEventListener('dragover', onDragOver);
    layer.addEventListener('dragenter', onDragEnter);
    layer.addEventListener('dragleave', onDragLeave);
    layer.addEventListener('drop', onDrop);
  }

  /**
   * Add an imported asset to the timeline.
   * @param {import('/core/schema.js').AssetMeta} asset
   * @param {string|null} trackId
   * @param {number} time
   */
  placeAsset(asset, trackId, time) {
    const fps = this.store.doc.composition.fps;
    const duration = asset.kind === 'image'
      ? 5
      : Math.max(1 / fps, Math.min(asset.duration || 5, this.store.doc.composition.duration));
    const kind = asset.kind === 'audio' ? 'audio' : asset.kind === 'video' ? 'video' : 'image';
    const targetTrack = trackId && this.trackAccepts(trackId, kind)
      ? trackId
      : this.store.defaultTrackFor(kind)?.id;
    if (!targetTrack) {
      this.store.notify('warn', `There is no track that can hold ${kind} clips. Add one from the timeline toolbar.`);
      return;
    }
    const start = clamp(snapToFrame(time, fps), 0, Math.max(0, this.store.doc.composition.duration - 1 / fps));
    this.store.addClip({
      name: asset.name,
      kind,
      assetId: asset.id,
      trackId: targetTrack,
      start,
      duration: Math.min(duration, Math.max(1 / fps, this.store.doc.composition.duration - start)),
    });
  }

  /**
   * Add one of the built-in procedural layers from the library's Graphics tab.
   * @param {{kind:string, graphicKind?:string}} spec
   * @param {string|null} trackId
   * @param {number} time
   */
  placeBuiltin(spec, trackId, time) {
    const fps = this.store.doc.composition.fps;
    const duration = this.store.doc.composition.duration;
    const start = clamp(snapToFrame(time, fps), 0, Math.max(0, duration - 1 / fps));
    const kind = spec.kind === 'text' ? 'text' : spec.kind === 'adjustment' ? 'adjustment' : 'graphic';
    const targetTrack = trackId && this.trackAccepts(trackId, kind)
      ? trackId
      : (kind === 'adjustment'
        ? (this.store.doc.tracks.find((track) => track.kind === 'visual')?.id ?? null)
        : this.store.defaultTrackFor(kind)?.id);
    if (!targetTrack) return;
    void import('/core/schema.js').then(({ defaultGraphic, defaultTextStyle }) => {
      this.store.addClip({
        name: kind === 'text' ? 'Text' : kind === 'adjustment' ? 'Adjustment layer' : `${spec.graphicKind ?? 'Graphic'} layer`,
        kind,
        trackId: targetTrack,
        start,
        duration: Math.max(1 / fps, duration - start),
        seed: 1000 + Math.floor(Math.random() * 9000),
        ...(kind === 'graphic' ? { graphic: { ...defaultGraphic(spec.graphicKind ?? 'gradient'), kind: spec.graphicKind ?? 'gradient', seed: 1000 + Math.floor(Math.random() * 9000) } } : {}),
        ...(kind === 'text' ? { text: defaultTextStyle() } : {}),
      });
    });
  }

  /**
   * @param {string} trackId
   * @param {string} kind
   * @returns {boolean}
   */
  trackAccepts(trackId, kind) {
    const track = this.store.doc.tracks.find((entry) => entry.id === trackId);
    if (!track || track.locked) return false;
    const wantsAudio = kind === 'audio';
    return (track.kind === 'audio') === wantsAudio;
  }

  /**
   * @param {Event} event
   * @returns {number}
   */
  eventX(event) {
    const rect = this.clickLayer.getBoundingClientRect();
    return /** @type {MouseEvent} */ (event).clientX - rect.left;
  }

  /**
   * @param {Event} event
   * @returns {number}
   */
  eventY(event) {
    const rect = this.clickLayer.getBoundingClientRect();
    return /** @type {MouseEvent} */ (event).clientY - rect.top;
  }

  /**
   * @param {PointerEvent} event
   */
  scrubFromEvent(event) {
    const time = clamp(this.xToTime(this.eventX(event)), 0, this.store.doc.composition.duration);
    this.preview.seek(snapToFrame(time, this.store.doc.composition.fps));
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {{kind:'clip', clip:import('/core/schema.js').Clip, zone:'body'|'left'|'right'|'fadeIn'|'fadeOut'}|{kind:'empty', trackId:string, time:number}|null}
   */
  hitTest(x, y) {
    const doc = this.store.doc;
    for (const track of doc.tracks) {
      const lane = this.laneOf(track.id);
      if (y < lane.top || y > lane.top + lane.height) continue;
      // Topmost (last-drawn) clip wins.
      const clips = doc.clips.filter((clip) => clip.trackId === track.id);
      for (let index = clips.length - 1; index >= 0; index -= 1) {
        const clip = clips[index];
        const startX = this.timeToX(clip.start);
        const endX = startX + Math.max(MIN_CLIP_PIXELS, this.timeToX(clip.duration));
        if (x < startX - 3 || x > endX + 3) continue;
        const handle = 7;
        /** @type {'body'|'left'|'right'|'fadeIn'|'fadeOut'} */
        let zone = 'body';
        if (x <= startX + handle) zone = 'left';
        else if (x >= endX - handle) zone = 'right';
        if (clip.kind === 'audio') {
          const fadeInX = startX + this.timeToX(clip.fadeIn);
          const fadeOutX = endX - this.timeToX(clip.fadeOut);
          if (clip.fadeIn > 0.02 && Math.abs(x - fadeInX) < 6) zone = 'fadeIn';
          else if (clip.fadeOut > 0.02 && Math.abs(x - fadeOutX) < 6) zone = 'fadeOut';
        }
        return { kind: 'clip', clip, zone };
      }
      return { kind: 'empty', trackId: track.id, time: this.xToTime(x) };
    }
    return null;
  }

  /**
   * @param {PointerEvent} event
   */
  onLanePointerDown(event) {
    const x = this.eventX(event);
    const y = this.eventY(event);
    const hit = this.hitTest(x, y);
    this.snapGuide = null;

    if (!hit) {
      this.store.clearSelection();
      return;
    }

    if (hit.kind === 'clip') {
      const track = this.store.doc.tracks.find((entry) => entry.id === hit.clip.trackId);
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      if (!this.store.ui.selectedClipIds.includes(hit.clip.id)) {
        this.store.toggleClipSelection(hit.clip.id, additive);
      } else if (additive) {
        this.store.toggleClipSelection(hit.clip.id, true);
      }
      if (track?.locked) {
        this.store.notify('warn', `Track "${track.name}" is locked. Unlock it to move clips.`);
        return;
      }
      const startTime = this.xToTime(x);
      this.dragState = {
        kind: 'clip',
        zone: hit.zone,
        startX: x,
        startY: y,
        startTime,
        clips: this.store.doc.clips
          .filter((clip) => this.store.ui.selectedClipIds.includes(clip.id))
          .map((clip) => ({
            id: clip.id,
            start: clip.start,
            duration: clip.duration,
            inPoint: clip.inPoint,
            fadeIn: clip.fadeIn,
            fadeOut: clip.fadeOut,
            trackId: clip.trackId,
          })),
      };
      this.store.beginGesture(hit.zone === 'body' ? 'Move clips' : 'Trim clips');
      return;
    }

    // Empty lane: start a marquee and move the playhead.
    this.marquee = { x, y, width: 0, height: 0 };
    this.marqueeStart = { x, y };
    this.store.ui.selectedTrackId = hit.trackId;
    this.preview.seek(snapToFrame(hit.time, this.store.doc.composition.fps));
    this.store.clearSelection();
    this.store.emit('selection');
  }

  /**
   * @param {number} dx
   * @param {number} dy
   * @param {PointerEvent} event
   */
  onLanePointerMove(dx, dy, event) {
    if (this.marquee && this.marqueeStart) {
      const x = this.eventX(event);
      const y = this.eventY(event);
      this.marquee = {
        x: Math.min(this.marqueeStart.x, x),
        y: Math.min(this.marqueeStart.y, y),
        width: Math.abs(x - this.marqueeStart.x),
        height: Math.abs(y - this.marqueeStart.y),
      };
      const ids = this.store.doc.clips.filter((clip) => {
        const lane = this.laneOf(clip.trackId);
        const clipX = this.timeToX(clip.start);
        const clipRight = clipX + Math.max(MIN_CLIP_PIXELS, this.timeToX(clip.duration));
        const overlapsX = clipRight >= this.marquee.x && clipX <= this.marquee.x + this.marquee.width;
        const overlapsY = lane.top + lane.height >= this.marquee.y && lane.top <= this.marquee.y + this.marquee.height;
        return overlapsX && overlapsY;
      }).map((clip) => clip.id);
      this.store.ui.selectedClipIds = ids;
      this.store.emit('selection');
      this.drawOverlay();
      return;
    }

    const state = this.dragState;
    if (!state) return;

    const fps = this.store.doc.composition.fps;
    const deltaTime = this.xToTime(dx);
    const snap = this.store.doc.timeline.snap;

    if (state.kind === 'clip' && state.zone === 'body') {
      // Vertical: move between tracks.
      const laneDelta = this.trackIndexDelta(state.startY, this.eventY(event));
      for (const entry of state.clips) {
        const clip = this.store.doc.clips.find((candidate) => candidate.id === entry.id);
        if (!clip) continue;
        let start = Math.max(0, entry.start + deltaTime);
        if (snap) {
          const snapped = this.snapTime(start, clip.id, 'start');
          if (snapped !== null) start = snapped;
        }
        clip.start = Math.round(start * fps * 1000) / (fps * 1000);
        if (laneDelta !== 0) {
          const tracks = this.store.doc.tracks;
          const from = tracks.findIndex((track) => track.id === entry.trackId);
          if (from >= 0) {
            const target = clamp(from + laneDelta, 0, tracks.length - 1);
            const targetTrack = tracks[target];
            const clipIsAudio = clip.kind === 'audio';
            if ((targetTrack.kind === 'audio') === clipIsAudio) clip.trackId = targetTrack.id;
          }
        }
      }
      this.dirty = true;
      this.store.emit('doc');
      this.draw();
      return;
    }

    if (state.kind === 'clip' && (state.zone === 'left' || state.zone === 'right')) {
      for (const entry of state.clips) {
        const clip = this.store.doc.clips.find((candidate) => candidate.id === entry.id);
        if (!clip) continue;
        if (state.zone === 'left') {
          let newStart = entry.start + deltaTime;
          newStart = clamp(newStart, 0, entry.start + entry.duration - 1 / fps);
          if (snap) {
            const snapped = this.snapTime(newStart, clip.id, 'start');
            if (snapped !== null) newStart = snapped;
          }
          const delta = newStart - entry.start;
          clip.start = newStart;
          clip.duration = Math.max(1 / fps, entry.duration - delta);
          clip.inPoint = Math.max(0, entry.inPoint + delta);
        } else {
          let newEnd = entry.start + entry.duration + deltaTime;
          newEnd = Math.max(entry.start + 1 / fps, Math.min(this.store.doc.composition.duration + 30, newEnd));
          if (snap) {
            const snapped = this.snapTime(newEnd, clip.id, 'end');
            if (snapped !== null) newEnd = snapped;
          }
          clip.duration = Math.max(1 / fps, newEnd - entry.start);
        }
      }
      this.dirty = true;
      this.store.emit('doc');
      this.draw();
      return;
    }

    if (state.kind === 'clip' && (state.zone === 'fadeIn' || state.zone === 'fadeOut')) {
      for (const entry of state.clips) {
        const clip = this.store.doc.clips.find((candidate) => candidate.id === entry.id);
        if (!clip) continue;
        if (state.zone === 'fadeIn') {
          clip.fadeIn = clamp(entry.fadeIn + deltaTime, 0, clip.duration);
        } else {
          clip.fadeOut = clamp(entry.fadeOut - deltaTime, 0, clip.duration);
        }
      }
      this.dirty = true;
      this.store.emit('doc');
      this.draw();
    }
  }

  /**
   * @param {number} y0
   * @param {number} y1
   * @returns {number}
   */
  trackIndexDelta(y0, y1) {
    const tracks = this.store.doc.tracks;
    const indexAt = (/** @type {number} */ y) => {
      for (let index = 0; index < tracks.length; index += 1) {
        const lane = this.laneOf(tracks[index].id);
        if (y >= lane.top && y <= lane.top + lane.height) return index;
      }
      return -1;
    };
    const a = indexAt(y0);
    const b = indexAt(y1);
    if (a < 0 || b < 0) return 0;
    return b - a;
  }

  onLanePointerUp() {
    if (this.marquee) {
      this.marquee = null;
      this.marqueeStart = null;
      this.drawOverlay();
      return;
    }
    if (this.dragState) {
      this.dragState = null;
      this.store.endGesture(true);
      this.snapGuide = null;
      this.dirty = true;
      this.rebuildAudioPlan();
      this.draw();
    }
  }

  /**
   * Candidate snap targets: clip edges on every track, markers, the playhead and
   * whole seconds.
   * @returns {number[]}
   */
  snapTargets() {
    const doc = this.store.doc;
    /** @type {number[]} */
    const targets = [0, doc.composition.duration, this.store.playback.time];
    for (const clip of doc.clips) {
      targets.push(clip.start, clip.start + clip.duration);
    }
    if (doc.timeline.snapToMarkers) {
      for (const assetId of Object.keys(doc.audio)) targets.push(...markerTimes(doc, assetId));
      for (const time of doc.exportRange ? [doc.exportRange.in, doc.exportRange.out, doc.loopRange.in, doc.loopRange.out] : []) targets.push(time);
    }
    return targets;
  }

  /**
   * @param {number} time
   * @param {string} clipId
   * @param {'start'|'end'} edge
   * @returns {number|null}
   */
  snapTime(time, clipId, edge) {
    const threshold = 8 / this.zoom;
    let best = null;
    let bestDistance = threshold;
    for (const target of this.snapTargets()) {
      const distance = Math.abs(target - time);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = target;
      }
    }
    if (best === null) {
      this.snapGuide = null;
      return null;
    }
    this.snapGuide = best;
    return best;
  }

  /**
   * @param {number} time
   * @returns {number|null}
   */
  nearestMarker(time) {
    let best = null;
    let bestDistance = 0.25;
    for (const assetId of Object.keys(this.store.doc.audio)) {
      for (const marker of markerTimes(this.store.doc, assetId)) {
        const distance = Math.abs(marker - time);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = marker;
        }
      }
    }
    return best;
  }

  setLoopFromSelection() {
    const clips = this.store.doc.clips.filter((clip) => this.store.ui.selectedClipIds.includes(clip.id));
    if (!clips.length) {
      this.store.notify('warn', 'Select one or more clips first, then set the loop range.');
      return;
    }
    const from = Math.min(...clips.map((clip) => clip.start));
    const to = Math.max(...clips.map((clip) => clip.start + clip.duration));
    this.store.setRange('loopRange', { in: from, out: to }, true);
    this.store.playback.loop = true;
    this.store.emit('transport');
    this.invalidate(true);
  }

  setExportFromSelection() {
    const clips = this.store.doc.clips.filter((clip) => this.store.ui.selectedClipIds.includes(clip.id));
    if (!clips.length) {
      this.store.notify('warn', 'Select one or more clips first, then set the export range.');
      return;
    }
    const from = Math.min(...clips.map((clip) => clip.start));
    const to = Math.max(...clips.map((clip) => clip.start + clip.duration));
    this.store.setRange('exportRange', { in: from, out: to }, true);
    this.invalidate(true);
  }

  /**
   * @param {import('/core/schema.js').Clip} clip
   * @param {number} clientX
   * @param {number} clientY
   */
  showClipMenu(clip, clientX, clientY) {
    const existing = document.querySelector('.timeline-context');
    existing?.remove();
    const panel = el('div', { class: 'menu__panel timeline-context', style: { position: 'fixed', left: `${clientX}px`, top: `${clientY}px`, zIndex: '400' } }, [
      el('div', { class: 'menu__label', text: clip.name }),
      item('Split at playhead', () => this.store.splitClips()),
      item('Duplicate', () => this.store.duplicateClips([clip.id])),
      item(clip.hidden ? 'Show clip' : 'Hide clip', () => this.store.setClipsHidden([clip.id], !clip.hidden)),
      item('Set export range to clip', () => this.store.setRange('exportRange', { in: clip.start, out: clip.start + clip.duration }, true)),
      item('Set loop to clip', () => {
        this.store.setRange('loopRange', { in: clip.start, out: clip.start + clip.duration }, true);
        this.store.playback.loop = true;
        this.store.emit('transport');
      }),
      el('div', { class: 'menu__sep' }),
      item('Add keyframe on this clip', () => {
        this.store.notify('info', 'Choose a property in the inspector and click its diamond to key it at the playhead.', { title: 'Keyframes' });
      }),
      item('Delete', () => this.store.deleteClips([clip.id]), true),
    ]);
    document.body.append(panel);
    const close = (event) => {
      if (panel.contains(/** @type {Node} */ (event.target))) return;
      panel.remove();
      document.removeEventListener('pointerdown', close, true);
    };
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0);

    /**
     * @param {string} text
     * @param {() => void} action
     * @param {boolean} [danger]
     */
    function item(text, action, danger = false) {
      return el('button', {
        class: `menu__item${danger ? ' menu__item--danger' : ''}`,
        text,
        onclick: () => {
          panel.remove();
          action();
          this.dirty = true;
          this.draw();
        },
      });
    }
  }

  /**
   * Scroll so the playhead is visible.
   */
  followPlayhead() {
    const x = this.timeToX(this.store.playback.time);
    const view = this.lanes;
    if (x < view.scrollLeft + 40) view.scrollLeft = Math.max(0, x - 80);
    else if (x > view.scrollLeft + view.clientWidth - 60) view.scrollLeft = x - view.clientWidth + 120;
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 */
function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {CanvasImageSource} image
 * @param {number} width
 * @param {number} height
 */
function drawCover(ctx, image, width, height) {
  const source = /** @type {any} */ (image);
  const sourceWidth = source.videoWidth ?? source.naturalWidth ?? source.width ?? 1;
  const sourceHeight = source.videoHeight ?? source.naturalHeight ?? source.height ?? 1;
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

/**
 * A ruler step that stays readable at any zoom.
 * @param {number} zoom pixels per second
 * @returns {number} seconds
 */
function niceStep(zoom) {
  const candidates = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const minimum = 70 / zoom;
  for (const candidate of candidates) if (candidate >= minimum) return candidate;
  return 600;
}

export { formatDuration };
