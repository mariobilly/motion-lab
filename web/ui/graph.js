/**
 * The two curve editors.
 *
 * `openGraphEditor` is the channel graph: time along x, value along y, one
 * draggable square per keyframe, Bézier handles for the selected key when its
 * easing is a custom curve, and the playhead marked with the value the renderer
 * is using right now. The curve it draws comes from `sampleChannel()`, the very
 * function the rest of the app evaluates animation with, so the graph cannot
 * disagree with the preview.
 *
 * `openCurveEditor` is the effect curve (RGB / R / G / B): a 0..1 square with
 * monotone cubic interpolation re-implemented below, matching
 * `core/effects.js`'s `curveTable` line for line, so the spline you drag is the
 * spline that renders.
 *
 * Both editors follow the same rule for undo: a whole drag is *one* step. Keys
 * are mutated live (so the canvas tracks the pointer) and the final write goes
 * through `store.edit` between `beginGesture` and `endGesture`.
 */

import { button, drag, el, fitCanvas, formatValue, select, textField, toggle } from './dom.js';
import { EFFECT_REGISTRY } from '/core/effectRegistry.js';
import { clipChannelSpecs } from '/core/channels.js';
import {
  EASING_PRESETS,
  channelRange,
  easeInOutEasing,
  easingPreset,
  evaluateChannel,
  findChannel,
  holdEasing,
  linearEasing,
  normalizeEasing,
  removeKeyframe,
  sampleChannel,
  setKeyframe,
  sortKeys,
} from '/core/keyframes.js';
import { formatTimecode } from '/core/schema.js';
import { clamp, clamp01, lerp } from '/core/math.js';

/* ------------------------------------------------------------------ *
 * Graph editor constants
 * ------------------------------------------------------------------ */

const DEFAULT_PLOT_HEIGHT = 230;
/** Below this the graph stops being usable, so the panel grows instead. */
const MIN_PLOT_HEIGHT = 120;
/** Fallback toolbar height, used before the DOM can be measured. */
const TOOLBAR_ALLOWANCE = 62;
const GRAPH_PAD = Object.freeze({ left: 50, right: 14, top: 14, bottom: 20 });
const KEY_SIZE = 8;
const KEY_HIT = 10;
const HANDLE_RADIUS = 4;
const HANDLE_HIT = 10;
const CURVE_SAMPLES = 400;

const COLOR = Object.freeze({
  background: '#08080c',
  grid: '#1c1c28',
  gridStrong: '#2a2a3a',
  label: '#5d6076',
  curve: '#5ce1ff',
  hold: '#ffc857',
  key: '#ff3d8b',
  selected: '#ffffff',
  playhead: '#ff3d8b',
  clipBand: 'rgba(92, 225, 255, 0.06)',
});

const MONO = '10px ui-monospace, "Cascadia Mono", Consolas, monospace';
const UI = '11px "Segoe UI", system-ui, sans-serif';

/* ------------------------------------------------------------------ *
 * Graph editor
 * ------------------------------------------------------------------ */

/**
 * Open the animation graph editor for one channel of one clip.
 *
 * The editor is appended to `container`; call the returned `destroy()` to
 * remove it, drop its store subscriptions, detach its pointer and keyboard
 * listeners and cancel its animation frame.
 *
 * Interactions: click a key to select it, drag it to change time and value
 * (horizontally and vertically, clamped to the composition and to the channel's
 * own range); drag empty space to scrub the playhead; double-click empty space
 * to add a keyframe there; `Delete` removes the selected key; with a `bezier`
 * key selected, the two control dots are draggable.
 *
 * @param {object} options
 * @param {any} options.store The editor store (undo, subscriptions, document).
 * @param {any} options.clip The clip that owns the channel.
 * @param {string} options.channel Channel id, e.g. `transform.position.x`.
 * @param {HTMLElement} options.container Where to mount the editor.
 * @returns {{destroy:()=>void, redraw:()=>void}}
 */
export function openGraphEditor({ store, clip, channel, container }) {
  const clipId = clip?.id ?? null;

  /** @type {string|null} */
  let selectedKeyId = null;
  let frameSnap = true;
  /** @type {null|'key'|'handle1'|'handle2'|'none'|'scrub'} */
  let mode = null;
  /** @type {any} */
  let grab = null;
  let rafId = 0;
  let destroyed = false;
  let controlsSignature = '';

  /* ----------------------------------------------------------- elements */

  const canvas = /** @type {HTMLCanvasElement} */ (el('canvas', { tabindex: '0' }));
  const legend = el('div', { class: 'graph-editor__legend' });
  // The legend sits inside the stage, so it lands on the plot no matter which
  // element ends up providing the panel chrome.
  const stage = el('div', {
    style: { height: `${DEFAULT_PLOT_HEIGHT}px`, position: 'relative' },
  }, [canvas, legend]);
  // A caller may hand us a container that is *already* the `.graph-editor`
  // (the inspector docks one at a fixed height), in which case the plot has to
  // fit inside it instead of nesting a second panel inside the first.
  const plotIsContainer = Boolean(container.classList?.contains('graph-editor'));
  const plot = plotIsContainer
    ? stage
    : el('div', { class: 'graph-editor', style: { height: `${DEFAULT_PLOT_HEIGHT + 2}px` } }, [stage]);

  /**
   * The toolbar block's real height, measured once it is in the document.
   * @returns {number}
   */
  function toolbarHeight() {
    const measured = root.offsetHeight;
    return Number.isFinite(measured) && measured > 0 ? measured : TOOLBAR_ALLOWANCE;
  }

  /**
   * Height available for the plot.
   *
   * The graph has a comfortable default, but when the caller's container *is*
   * the panel it gets to set the height -- so the plot fills whatever is left
   * after the toolbar, and the panel is grown instead of clipping the canvas
   * when that would leave too little to work with.
   * @returns {number}
   */
  function plotHeight() {
    if (!plotIsContainer) return DEFAULT_PLOT_HEIGHT;
    const toolbar = toolbarHeight();
    const rect = container.getBoundingClientRect();
    const available = rect.height > 90 ? Math.floor(rect.height - toolbar - 12) : 0;
    if (available >= MIN_PLOT_HEIGHT) return Math.min(available, 420);
    container.style.height = `${toolbar + DEFAULT_PLOT_HEIGHT + 12}px`;
    return DEFAULT_PLOT_HEIGHT;
  }

  const presetSelect = /** @type {HTMLSelectElement} */ (select({
    inline: true,
    options: EASING_PRESETS.map((preset) => ({ value: preset.name, label: preset.name })),
    value: 'Linear',
    title: 'Curve of the segment that starts at the selected keyframe',
    onChange: (/** @type {string} */ name) => applyPreset(easingPreset(String(name))),
  }));

  const timeField = /** @type {HTMLInputElement} */ (textField({
    inline: true,
    value: '0',
    placeholder: 'seconds',
    onChange: (/** @type {string} */ value) => applyTimeField(value),
  }));
  timeField.title = 'Time of the selected keyframe, in seconds';

  const valueField = /** @type {HTMLInputElement} */ (textField({
    inline: true,
    value: '0',
    placeholder: 'value',
    onChange: (/** @type {string} */ value) => applyValueField(value),
  }));
  valueField.title = 'Value of the selected keyframe';

  const readout = el('span', { class: 'stat-chip', title: 'Value of this channel at the playhead' });

  const snapToggle = toggle({
    label: 'Frame snap',
    checked: frameSnap,
    title: 'Snap dragged keyframes to the composition frame grid',
    onChange: (/** @type {boolean} */ checked) => {
      frameSnap = Boolean(checked);
      requestDraw();
    },
  });

  const linearButton = button('Linear', 'btn btn--tiny', {
    title: 'Straight segment out of the selected keyframe',
    onclick: () => applyPreset(linearEasing()),
  });
  const easeButton = button('Ease in-out', 'btn btn--tiny', {
    title: 'Smooth ease in and out of the selected keyframe',
    onclick: () => applyPreset(easeInOutEasing()),
  });
  const holdButton = button('Hold', 'btn btn--tiny', {
    title: 'Keep the value until the next keyframe (a step)',
    onclick: () => applyPreset(holdEasing()),
  });
  const removeButton = button('Delete key', 'btn btn--tiny', {
    title: 'Remove the selected keyframe (Delete)',
    onclick: () => deleteSelectedKey(),
  });

  const root = el('div', {}, [
    el('div', { class: 'row row--wrap', style: { marginBottom: '6px' } }, [
      el('span', { class: 'muted', text: 'Easing' }),
      el('div', { style: { width: '112px' } }, [presetSelect]),
      linearButton,
      easeButton,
      holdButton,
      el('div', { class: 'grow' }),
      snapToggle,
    ]),
    el('div', { class: 'row row--wrap', style: { marginBottom: '6px' } }, [
      el('span', { class: 'muted', text: 'Key' }),
      el('span', { class: 'mono muted', text: 't' }),
      el('div', { style: { width: '82px' } }, [timeField]),
      el('span', { class: 'mono muted', text: 'v' }),
      el('div', { style: { width: '82px' } }, [valueField]),
      removeButton,
      el('div', { class: 'grow' }),
      readout,
    ]),
    // When the caller's container *is* the graph panel, only the plot goes in.
    plotIsContainer ? null : plot,
  ].filter(Boolean));

  /* ------------------------------------------------------------ document */

  function currentClip() {
    return clipId ? store.getClip(clipId) ?? null : null;
  }

  function currentEntry() {
    const clipNow = currentClip();
    return clipNow ? findChannel(clipNow, channel) ?? null : null;
  }

  function selectedKey() {
    const entry = currentEntry();
    if (!entry || !selectedKeyId) return null;
    return entry.keys.find((key) => key.id === selectedKeyId) ?? null;
  }

  function channelSpec() {
    const clipNow = currentClip();
    if (!clipNow) return null;
    return clipChannelSpecs(clipNow, store.doc.composition, EFFECT_REGISTRY).find((spec) => spec.id === channel) ?? null;
  }

  function baseValue() {
    return channelSpec()?.base ?? 0;
  }

  function decimals() {
    return channelSpec()?.decimals ?? 3;
  }

  function unit() {
    return channelSpec()?.unit ?? '';
  }

  /**
   * @param {number} value
   * @returns {number}
   */
  function clampValue(value) {
    const spec = channelSpec();
    if (!spec) return Number.isFinite(value) ? value : 0;
    return clamp(value, spec.min ?? -Infinity, spec.max ?? Infinity);
  }

  /**
   * @param {number} time
   * @returns {number}
   */
  function snapTime(time) {
    const fps = store.doc.composition.fps;
    return frameSnap ? Math.round(time * fps) / fps : Math.round(time * 1000) / 1000;
  }

  /**
   * A frozen snapshot of the plot mapping. Captured when a drag starts so the
   * axes cannot shift while the pointer is down (the value range follows the
   * keys, so a live mapping would fight the drag).
   * @param {number} height
   * @returns {any}
   */
  function geometry(height) {
    const width = Math.max(140, stage.getBoundingClientRect().width);
    const plotWidth = Math.max(20, width - GRAPH_PAD.left - GRAPH_PAD.right);
    const plotHeight = Math.max(20, height - GRAPH_PAD.top - GRAPH_PAD.bottom);
    const duration = Math.max(1e-3, store.doc.composition.duration);
    const clipNow = currentClip();
    const range = channelRange(clipNow, channel, baseValue());
    const span = Math.max(1e-9, range.max - range.min);
    return {
      width,
      height,
      duration,
      plotWidth,
      plotHeight,
      range,
      span,
      xOf: (/** @type {number} */ time) => GRAPH_PAD.left + (time / duration) * plotWidth,
      timeOf: (/** @type {number} */ x) => ((x - GRAPH_PAD.left) / plotWidth) * duration,
      yOf: (/** @type {number} */ value) => GRAPH_PAD.top + (1 - (value - range.min) / span) * plotHeight,
      valueOf: (/** @type {number} */ y) => range.min + (1 - (y - GRAPH_PAD.top) / plotHeight) * span,
    };
  }

  /* --------------------------------------------------------------- drawing */

  function requestDraw() {
    if (destroyed || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (!destroyed) draw();
    });
  }

  function draw() {
    const height = plotHeight();
    if (stage.style.height !== `${height}px`) stage.style.height = `${height}px`;
    const ctx = fitCanvas(canvas, stage, height);
    const geo = geometry(height);
    ctx.clearRect(0, 0, geo.width, height);
    ctx.fillStyle = COLOR.background;
    ctx.fillRect(0, 0, geo.width, height);

    const clipNow = currentClip();
    if (!clipNow) {
      ctx.fillStyle = COLOR.label;
      ctx.font = UI;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('This clip is no longer in the composition.', GRAPH_PAD.left, height / 2);
      legend.replaceChildren(el('span', { text: channel }), el('span', { text: 'clip missing' }));
      syncControls();
      return;
    }

    drawGrid(ctx, geo, clipNow);
    drawCurve(ctx, geo, clipNow);
    drawHandles(ctx, geo);
    drawKeys(ctx, geo, clipNow);
    drawPlayhead(ctx, geo, clipNow);
    syncControls();
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {any} geo
   * @param {any} clipNow
   */
  function drawGrid(ctx, geo, clipNow) {
    ctx.font = MONO;
    ctx.lineWidth = 1;

    // The span the clip actually plays over.
    ctx.fillStyle = COLOR.clipBand;
    const clipSpan = Math.max(1, geo.xOf(clipNow.duration));
    ctx.fillRect(geo.xOf(clipNow.start), GRAPH_PAD.top, clipSpan, geo.plotHeight);

    const divisions = 4;
    for (let index = 0; index <= divisions; index += 1) {
      const ratio = index / divisions;
      const y = Math.round(GRAPH_PAD.top + ratio * geo.plotHeight) + 0.5;
      ctx.strokeStyle = index === 0 || index === divisions ? COLOR.gridStrong : COLOR.grid;
      ctx.beginPath();
      ctx.moveTo(GRAPH_PAD.left, y);
      ctx.lineTo(GRAPH_PAD.left + geo.plotWidth, y);
      ctx.stroke();
      ctx.fillStyle = COLOR.label;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        formatValue(geo.range.max - ratio * (geo.range.max - geo.range.min), decimals()),
        GRAPH_PAD.left - 6,
        y,
      );
    }

    const steps = 6;
    for (let index = 0; index <= steps; index += 1) {
      const time = (geo.duration * index) / steps;
      const x = Math.round(geo.xOf(time)) + 0.5;
      ctx.strokeStyle = COLOR.grid;
      ctx.beginPath();
      ctx.moveTo(x, GRAPH_PAD.top);
      ctx.lineTo(x, GRAPH_PAD.top + geo.plotHeight);
      ctx.stroke();
      ctx.fillStyle = COLOR.label;
      ctx.textAlign = index === 0 ? 'left' : index === steps ? 'right' : 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(formatTimecode(time, store.doc.composition.fps), x, GRAPH_PAD.top + geo.plotHeight + 5);
    }
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {any} geo
   * @param {any} clipNow
   */
  function drawCurve(ctx, geo, clipNow) {
    const samples = sampleChannel(clipNow, channel, 0, geo.duration, CURVE_SAMPLES);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (samples.length < 2) {
      // No keyframes yet: show the static value the renderer falls back to.
      const y = Math.round(geo.yOf(baseValue())) + 0.5;
      ctx.strokeStyle = COLOR.curve;
      ctx.globalAlpha = 0.45;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(GRAPH_PAD.left, y);
      ctx.lineTo(GRAPH_PAD.left + geo.plotWidth, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = COLOR.label;
      ctx.font = UI;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('No keyframes — double-click in the graph to add one.', GRAPH_PAD.left + geo.plotWidth / 2, y - 6);
      return;
    }

    ctx.strokeStyle = COLOR.curve;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let index = 0; index < samples.length; index += 1) {
      const x = geo.xOf(samples[index].time);
      const y = geo.yOf(samples[index].value);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Hold keys are steps: draw the flat run and the jump so the shape is
    // unmistakable at any zoom.
    const entry = findChannel(clipNow, channel);
    if (!entry) return;
    ctx.lineWidth = 1.4;
    for (let index = 0; index < entry.keys.length - 1; index += 1) {
      const key = entry.keys[index];
      const next = entry.keys[index + 1];
      if (normalizeEasing(key.ease).kind !== 'hold') continue;
      const y = geo.yOf(key.value);
      ctx.strokeStyle = COLOR.hold;
      ctx.beginPath();
      ctx.moveTo(geo.xOf(key.time), y);
      ctx.lineTo(geo.xOf(next.time), y);
      ctx.stroke();
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(geo.xOf(next.time), y);
      ctx.lineTo(geo.xOf(next.time), geo.yOf(next.value));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {any} geo
   * @param {any} clipNow
   */
  function drawKeys(ctx, geo, clipNow) {
    const entry = findChannel(clipNow, channel);
    if (!entry) return;
    const half = KEY_SIZE / 2;
    for (const key of entry.keys) {
      const x = geo.xOf(key.time);
      const y = geo.yOf(key.value);
      if (x < 0 || x > geo.width) continue;
      const selected = key.id === selectedKeyId;
      ctx.beginPath();
      ctx.rect(x - half, y - half, KEY_SIZE, KEY_SIZE);
      ctx.fillStyle = selected ? COLOR.selected : COLOR.key;
      ctx.fill();
      ctx.strokeStyle = selected ? COLOR.key : 'rgba(0, 0, 0, 0.6)';
      ctx.lineWidth = selected ? 2 : 1;
      ctx.stroke();
    }
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {any} geo
   */
  function drawHandles(ctx, geo) {
    const handles = handleGeometry(geo);
    if (!handles) return;
    ctx.strokeStyle = COLOR.hold;
    ctx.fillStyle = COLOR.hold;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    for (const [anchor, control] of [[handles.p0, handles.c1], [handles.p1, handles.c2]]) {
      ctx.beginPath();
      ctx.moveTo(anchor.x, anchor.y);
      ctx.lineTo(control.x, control.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const control of [handles.c1, handles.c2]) {
      ctx.beginPath();
      ctx.arc(control.x, control.y, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {any} geo
   * @param {any} clipNow
   */
  function drawPlayhead(ctx, geo, clipNow) {
    const time = store.playback.time;
    const x = Math.round(geo.xOf(time)) + 0.5;
    ctx.strokeStyle = COLOR.playhead;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(x, GRAPH_PAD.top);
    ctx.lineTo(x, GRAPH_PAD.top + geo.plotHeight);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const evaluated = evaluateChannel(clipNow, channel, time);
    const value = evaluated === null ? baseValue() : evaluated;
    const y = geo.yOf(value);
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = COLOR.playhead;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /* -------------------------------------------------- selection + handles */

  /**
   * @param {any} geo
   * @returns {any}
   */
  function handleGeometry(geo) {
    const entry = currentEntry();
    const key = selectedKey();
    if (!entry || !key) return null;
    const easing = normalizeEasing(key.ease);
    if (easing.kind !== 'bezier') return null;
    const index = entry.keys.findIndex((candidate) => candidate.id === key.id);
    const next = entry.keys[index + 1];
    if (!next) return null;
    const p0 = { x: geo.xOf(key.time), y: geo.yOf(key.value) };
    const p1 = { x: geo.xOf(next.time), y: geo.yOf(next.value) };
    return {
      key,
      next,
      easing,
      p0,
      p1,
      c1: { x: lerp(p0.x, p1.x, easing.bezier.x1), y: lerp(p0.y, p1.y, easing.bezier.y1) },
      c2: { x: lerp(p0.x, p1.x, easing.bezier.x2), y: lerp(p0.y, p1.y, easing.bezier.y2) },
    };
  }

  /**
   * @param {MouseEvent|PointerEvent} event
   * @returns {{x:number, y:number}}
   */
  function localPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /**
   * @param {any} geo
   * @param {{x:number,y:number}} point
   * @returns {any}
   */
  function hitKey(geo, point) {
    const entry = currentEntry();
    if (!entry) return null;
    let best = null;
    let bestDistance = KEY_HIT;
    for (const key of entry.keys) {
      const distance = Math.hypot(geo.xOf(key.time) - point.x, geo.yOf(key.value) - point.y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = key;
      }
    }
    return best;
  }

  /* ---------------------------------------------------------- interactions */

  const detachDrag = drag({
    target: canvas,
    onStart: (event) => {
      if (event.button !== 0) return;
      if (destroyed) return;
      const clipNow = currentClip();
      if (!clipNow) return;
      canvas.focus();
      const geo = geometry(plotHeight());
      const point = localPoint(event);
      const handle = handleGeometry(geo);

      if (handle && Math.hypot(handle.c1.x - point.x, handle.c1.y - point.y) <= HANDLE_HIT) {
        mode = 'handle1';
        grab = {
          geo,
          key: handle.key,
          p0: handle.p0,
          p1: handle.p1,
          origin: JSON.parse(JSON.stringify(handle.easing)),
          final: JSON.parse(JSON.stringify(handle.easing)),
        };
        store.beginGesture('Shape easing curve');
        return;
      }
      if (handle && Math.hypot(handle.c2.x - point.x, handle.c2.y - point.y) <= HANDLE_HIT) {
        mode = 'handle2';
        grab = {
          geo,
          key: handle.key,
          p0: handle.p0,
          p1: handle.p1,
          origin: JSON.parse(JSON.stringify(handle.easing)),
          final: JSON.parse(JSON.stringify(handle.easing)),
        };
        store.beginGesture('Shape easing curve');
        return;
      }

      const key = hitKey(geo, point);
      if (key) {
        selectedKeyId = key.id;
        mode = 'key';
        grab = { geo, key, time: key.time, value: key.value, originTime: key.time, originValue: key.value };
        store.beginGesture('Move keyframe');
        requestDraw();
        return;
      }

      mode = 'none';
      grab = { geo, point };
      if (selectedKeyId) {
        selectedKeyId = null;
        requestDraw();
      }
    },

    onMove: (dx, dy) => {
      if (destroyed || !mode || !grab) return;
      const geo = grab.geo;

      if (mode === 'none') {
        if (Math.hypot(dx, dy) < 3) return;
        mode = 'scrub';
      }

      if (mode === 'scrub') {
        const time = clamp(geo.timeOf(grab.point.x + dx), 0, geo.duration);
        store.setTime(snapTime(time));
        return;
      }

      if (mode === 'key') {
        const key = grab.key;
        const time = clamp(grab.time + (dx * geo.duration) / geo.plotWidth, 0, geo.duration);
        const value = clampValue(grab.value - (dy * geo.span) / geo.plotHeight);
        key.time = snapTime(time);
        key.value = value;
        const entry = currentEntry();
        if (entry) sortKeys(entry.keys);
        requestDraw();
        return;
      }

      // Bézier handles: x is clamped to 0..1 (it is a progress fraction),
      // y is free so anticipation and overshoot can be authored.
      const spanX = grab.p1.x - grab.p0.x;
      const spanY = grab.p1.y - grab.p0.y;
      if (Math.abs(spanX) < 1e-6) return;
      const source = grab.origin.bezier;
      const baseX = mode === 'handle1' ? source.x1 : source.x2;
      const baseY = mode === 'handle1' ? source.y1 : source.y2;
      const x = clamp01(baseX + dx / spanX);
      const y = Math.abs(spanY) < 1e-6 ? baseY : baseY + dy / spanY;
      if (mode === 'handle1') {
        grab.final.bezier.x1 = x;
        grab.final.bezier.y1 = y;
      } else {
        grab.final.bezier.x2 = x;
        grab.final.bezier.y2 = y;
      }
      grab.final.kind = 'bezier';
      grab.final.name = 'Custom';
      grab.key.ease = JSON.parse(JSON.stringify(grab.final));
      requestDraw();
    },

    onEnd: () => {
      if (destroyed) return;
      const finished = mode;
      const state = grab;
      mode = null;
      grab = null;
      if (!finished || finished === 'none' || finished === 'scrub' || !state) {
        requestDraw();
        return;
      }

      const key = state.key;
      if (finished === 'key') {
        // Roll back to the pre-drag value, then let `store.edit` make the real
        // change: that is what marks the open gesture dirty, so the whole drag
        // folds into a single undo entry.
        const finalTime = key.time;
        const finalValue = key.value;
        key.time = state.originTime;
        key.value = state.originValue;
        store.edit('Move keyframe', () => {
          const entry = currentEntry();
          key.time = clamp(finalTime, 0, store.doc.composition.duration);
          key.value = clampValue(finalValue);
          if (entry) sortKeys(entry.keys);
        });
      } else {
        const original = state.origin;
        const final = state.final;
        key.ease = original;
        store.edit('Shape easing curve', () => {
          key.ease = final;
        });
      }
      store.endGesture(true);
      requestDraw();
    },
  });

  /**
   * Dismiss the drag and the gesture it opened, restoring the document.
   */
  function abortDrag() {
    if (!mode || !grab) return;
    const state = grab;
    if (mode === 'key' && state.key) {
      state.key.time = state.originTime;
      state.key.value = state.originValue;
      const entry = currentEntry();
      if (entry) sortKeys(entry.keys);
    } else if (state.key && state.origin) {
      state.key.ease = state.origin;
    }
    mode = null;
    grab = null;
    store.endGesture(false);
  }

  /* ------------------------------------------------------------- commands */

  /**
   * @param {any} easing
   */
  function applyPreset(easing) {
    const key = selectedKey();
    if (!key) {
      store.notify('warn', 'Select a keyframe first — easing applies to the segment that starts at it.', { title: 'Graph editor' });
      return;
    }
    store.edit('Set easing', () => {
      key.ease = easing;
    });
    requestDraw();
  }

  /**
   * @param {string} raw
   */
  function applyTimeField(raw) {
    const key = selectedKey();
    if (!key) return;
    const parsed = Number(String(raw).replace(/[^0-9.eE+-]/g, ''));
    if (!Number.isFinite(parsed)) {
      syncControls();
      return;
    }
    const time = snapTime(clamp(parsed, 0, store.doc.composition.duration));
    store.edit('Move keyframe', () => {
      key.time = time;
      const entry = currentEntry();
      if (entry) sortKeys(entry.keys);
    });
    requestDraw();
  }

  /**
   * @param {string} raw
   */
  function applyValueField(raw) {
    const key = selectedKey();
    if (!key) return;
    const parsed = Number(String(raw).replace(/[^0-9.eE+-]/g, ''));
    if (!Number.isFinite(parsed)) {
      syncControls();
      return;
    }
    const value = clampValue(parsed);
    store.edit('Set keyframe value', () => {
      key.value = value;
    });
    requestDraw();
  }

  function deleteSelectedKey() {
    const clipNow = currentClip();
    const key = selectedKey();
    if (!clipNow || !key) {
      store.notify('warn', 'Select a keyframe first.', { title: 'Graph editor' });
      return;
    }
    store.edit('Delete keyframe', () => {
      removeKeyframe(clipNow, channel, key.id);
    });
    selectedKeyId = null;
    requestDraw();
  }

  /**
   * @param {KeyboardEvent} event
   */
  function onKeyDown(event) {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    if (!selectedKey()) return;
    // Handled here: stop the app-wide Delete shortcut from also deleting clips.
    event.preventDefault();
    event.stopPropagation();
    deleteSelectedKey();
  }

  /**
   * @param {MouseEvent} event
   */
  function onDoubleClick(event) {
    const clipNow = currentClip();
    if (!clipNow) return;
    const geo = geometry(plotHeight());
    const point = localPoint(event);
    if (hitKey(geo, point)) return;
    const time = snapTime(clamp(geo.timeOf(point.x), 0, geo.duration));
    const value = clampValue(geo.valueOf(point.y));
    /** @type {any} */
    let created = null;
    store.edit('Add keyframe', () => {
      created = setKeyframe(clipNow, channel, time, value, keyEasingForNewKey(time));
    });
    selectedKeyId = created?.id ?? null;
    requestDraw();
  }

  /**
   * A new key inherits the easing of the key it follows, so adding a key in the
   * middle of an eased run does not silently change the shape.
   * @param {number} time
   * @returns {any}
   */
  function keyEasingForNewKey(time) {
    const entry = currentEntry();
    if (!entry) return linearEasing();
    let easing = linearEasing();
    for (const key of entry.keys) {
      if (key.time <= time) easing = normalizeEasing(key.ease);
    }
    return easing;
  }

  /**
   * Keep the toolbar, the legend and the readout in step with the document.
   * The legend and the fields are only rebuilt when their content actually
   * changed; the readout follows the playhead every frame.
   */
  function syncControls() {
    const key = selectedKey();
    const spec = channelSpec();
    const clipNow = currentClip();
    const range = channelRange(clipNow, channel, baseValue());
    const atPlayhead = clipNow ? evaluateChannel(clipNow, channel, store.playback.time) : null;
    const value = atPlayhead === null ? baseValue() : atPlayhead;
    const fps = store.doc.composition.fps;

    const signature = [
      spec?.label ?? channel,
      range.min,
      range.max,
      decimals(),
      unit(),
      key?.id ?? '',
      key?.time ?? '',
      key?.value ?? '',
      key?.ease?.name ?? '',
      Boolean(clipNow),
    ].join('|');

    if (signature !== controlsSignature) {
      controlsSignature = signature;
      legend.replaceChildren(
        el('span', { text: spec?.label ?? channel }),
        el('span', { text: `${formatValue(range.min, decimals())} … ${formatValue(range.max, decimals())}${unit()}` }),
        el('span', { text: key ? `key @ ${formatTimecode(key.time, fps)}` : 'no key selected' }),
      );
      presetSelect.value = key ? presetNameFor(key.ease) : 'Linear';
      presetSelect.disabled = !key;
      if (document.activeElement !== timeField) timeField.value = key ? formatValue(key.time, 3) : '';
      if (document.activeElement !== valueField) valueField.value = key ? formatValue(key.value, decimals()) : '';
      timeField.disabled = !key;
      valueField.disabled = !key;
      linearButton.disabled = !key;
      easeButton.disabled = !key;
      holdButton.disabled = !key;
      removeButton.disabled = !key;
    }

    readout.textContent = `${formatValue(value, decimals())}${unit()} at playhead`;
    readout.title = `${spec?.label ?? channel} at ${formatTimecode(store.playback.time, fps)}`;
  }

  /**
   * @param {any} easing
   * @returns {string}
   */
  function presetNameFor(easing) {
    const normalized = normalizeEasing(easing);
    if (normalized.name) {
      const byName = EASING_PRESETS.find((preset) => preset.name === normalized.name);
      if (byName) return byName.name;
    }
    const byKind = EASING_PRESETS.find((preset) => preset.kind === normalized.kind && normalized.kind !== 'bezier');
    if (byKind) return byKind.name;
    const byHandles = EASING_PRESETS.find((preset) => (
      Math.abs(preset.bezier.x1 - normalized.bezier.x1) < 1e-3
      && Math.abs(preset.bezier.y1 - normalized.bezier.y1) < 1e-3
      && Math.abs(preset.bezier.x2 - normalized.bezier.x2) < 1e-3
      && Math.abs(preset.bezier.y2 - normalized.bezier.y2) < 1e-3
    ));
    return byHandles ? byHandles.name : 'Linear';
  }

  /* ------------------------------------------------------------- lifecycle */

  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('keydown', onKeyDown);
  const offPlayhead = store.on('playhead', requestDraw);
  const offDoc = store.on('doc', requestDraw);
  container.append(root);
  // The caller's container is the panel, so the plot goes in beside the toolbar.
  if (plotIsContainer) container.append(stage);
  requestDraw();

  return {
    /** Force a repaint (used after the caller changes the document itself). */
    redraw: requestDraw,
    /** Remove the editor and everything it registered. */
    destroy() {
      if (destroyed) return;
      abortDrag();
      destroyed = true;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      offPlayhead();
      offDoc();
      detachDrag();
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.removeEventListener('keydown', onKeyDown);
      // The toolbar block is always ours; the plot belongs to the caller when
      // the caller handed us the panel itself.
      root.remove();
      if (plotIsContainer) stage.remove();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Curve editor
 * ------------------------------------------------------------------ */

const CURVE_HEIGHT = 168;
const CURVE_PAD = 14;
const POINT_RADIUS = 5;
const POINT_HIT = 11;
const MAX_POINTS = 8;
const CURVE_COLOR = '#5ce1ff';

/**
 * Fritsch–Carlson monotone cubic interpolation, re-implemented here so the
 * editor draws exactly the curve `core/effects.js` samples into its lookup
 * table. Returns an evaluator for `x` in 0..1.
 *
 * @param {number[][]} points
 * @returns {(x:number)=>number}
 */
export function monotoneEvaluator(points) {
  const sorted = (Array.isArray(points) ? points : [])
    .filter((point) => Array.isArray(point) && point.length >= 2)
    .map((point) => [Number(point[0]) || 0, Number(point[1]) || 0])
    .sort((a, b) => a[0] - b[0]);
  const pts = sorted.length >= 2 ? sorted : [[0, 0], [1, 1]];
  const n = pts.length;
  const xs = pts.map((point) => point[0]);
  const ys = pts.map((point) => point[1]);
  const slopes = new Array(n).fill(0);
  const deltas = new Array(n - 1).fill(0);
  for (let i = 0; i < n - 1; i += 1) {
    const dx = Math.max(1e-6, xs[i + 1] - xs[i]);
    deltas[i] = (ys[i + 1] - ys[i]) / dx;
  }
  slopes[0] = deltas[0];
  slopes[n - 1] = deltas[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    slopes[i] = deltas[i - 1] * deltas[i] <= 0 ? 0 : (deltas[i - 1] + deltas[i]) / 2;
  }
  for (let i = 0; i < n - 1; i += 1) {
    if (deltas[i] === 0) {
      slopes[i] = 0;
      slopes[i + 1] = 0;
    } else {
      const a = slopes[i] / deltas[i];
      const b = slopes[i + 1] / deltas[i];
      const magnitude = a * a + b * b;
      if (magnitude > 9) {
        const scale = 3 / Math.sqrt(magnitude);
        slopes[i] = scale * a * deltas[i];
        slopes[i + 1] = scale * b * deltas[i];
      }
    }
  }
  return (x) => {
    const clamped = clamp01(x);
    let segment = 0;
    while (segment < n - 2 && clamped > xs[segment + 1]) segment += 1;
    const h = Math.max(1e-6, xs[segment + 1] - xs[segment]);
    const t = clamp01((clamped - xs[segment]) / h);
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * ys[segment] + h10 * h * slopes[segment] + h01 * ys[segment + 1] + h11 * h * slopes[segment + 1];
  };
}

/**
 * Open the effect curve editor over a list of `[x, y]` control points.
 *
 * The array is mutated in place and handed back through `onChange` on every
 * drag frame, so a caller that holds the effect parameter (or that opened a
 * `store.beginGesture` around the edit) sees the change immediately. Endpoints
 * are locked to x = 0 and x = 1; clicking inside the square adds an interpolated
 * point while there is room (8 maximum) and double-clicking an interior point
 * removes it.
 *
 * @param {object} options
 * @param {number[][]} options.points Control points, each `[x, y]` in 0..1.
 * @param {(points:number[][])=>void} options.onChange Called on every change.
 * @param {HTMLElement} options.container Where to mount the editor.
 * @returns {{destroy:()=>void, redraw:()=>void}}
 */
export function openCurveEditor({ points, onChange, container }) {
  const state = { points: Array.isArray(points) ? points : [[0, 0], [1, 1]] };

  // Keep the same guarantees `core/effectRegistry.js`'s `coerceParam` applies to
  // a `points` parameter: pairs of 0..1 numbers, sorted by x, ends pinned.
  for (let index = state.points.length - 1; index >= 0; index -= 1) {
    const entry = state.points[index];
    if (!Array.isArray(entry) || entry.length < 2 || !Number.isFinite(Number(entry[0])) || !Number.isFinite(Number(entry[1]))) {
      state.points.splice(index, 1);
    } else {
      entry[0] = clamp01(Number(entry[0]));
      entry[1] = clamp01(Number(entry[1]));
    }
  }
  if (state.points.length < 2) {
    state.points.length = 0;
    state.points.push([0, 0], [1, 1]);
  }
  state.points.sort((a, b) => a[0] - b[0]);
  state.points[0][0] = 0;
  state.points[state.points.length - 1][0] = 1;

  let rafId = 0;
  let destroyed = false;
  /** @type {number} */ let dragIndex = -1;
  /** @type {any} */ let grab = null;
  let moved = false;

  const canvas = /** @type {HTMLCanvasElement} */ (el('canvas', { tabindex: '0' }));
  // The inspector hands us a container that is already a `.curve-editor`; own it
  // rather than nesting a second one inside it.
  const ownsWrapper = !container.classList?.contains('curve-editor');
  const root = ownsWrapper ? el('div', { class: 'curve-editor' }) : container;
  const hint = el('div', {
    class: 'hint',
    text: `Drag a point to shape the curve. Click the square to add a point (up to ${MAX_POINTS}), double-click an interior point to remove it. The ends stay pinned to 0 and 1.`,
  });
  root.append(canvas, hint);

  /* ------------------------------------------------------------ geometry */

  function geometry() {
    const width = Math.max(80, root.getBoundingClientRect().width);
    const plotWidth = Math.max(20, width - CURVE_PAD * 2);
    const plotHeight = Math.max(20, CURVE_HEIGHT - CURVE_PAD * 2);
    return {
      width,
      plotWidth,
      plotHeight,
      xOf: (/** @type {number} */ x) => CURVE_PAD + clamp01(x) * plotWidth,
      yOf: (/** @type {number} */ y) => CURVE_PAD + (1 - clamp01(y)) * plotHeight,
      xAt: (/** @type {number} */ px) => clamp01((px - CURVE_PAD) / plotWidth),
      yAt: (/** @type {number} */ py) => clamp01(1 - (py - CURVE_PAD) / plotHeight),
    };
  }

  /**
   * @param {number} x
   * @returns {number}
   */
  function curveAt(x) {
    return clamp01(monotoneEvaluator(state.points)(x));
  }

  /* -------------------------------------------------------------- drawing */

  function requestDraw() {
    if (destroyed || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (!destroyed) draw();
    });
  }

  function draw() {
    const ctx = fitCanvas(canvas, root, CURVE_HEIGHT);
    const geo = geometry();
    const dpr = canvas.width / Math.max(1, geo.width);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, geo.width, CURVE_HEIGHT);
    ctx.fillStyle = '#08080c';
    ctx.fillRect(0, 0, geo.width, CURVE_HEIGHT);

    // Grid + the 0..1 square.
    ctx.strokeStyle = '#1c1c28';
    ctx.lineWidth = 1;
    for (let step = 1; step < 4; step += 1) {
      const ratio = step / 4;
      const x = Math.round(CURVE_PAD + ratio * geo.plotWidth) + 0.5;
      const y = Math.round(CURVE_PAD + ratio * geo.plotHeight) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, CURVE_PAD);
      ctx.lineTo(x, CURVE_PAD + geo.plotHeight);
      ctx.moveTo(CURVE_PAD, y);
      ctx.lineTo(CURVE_PAD + geo.plotWidth, y);
      ctx.stroke();
    }
    ctx.strokeStyle = '#2a2a3a';
    ctx.strokeRect(CURVE_PAD + 0.5, CURVE_PAD + 0.5, geo.plotWidth - 1, geo.plotHeight - 1);

    // The identity diagonal: what "no change" looks like.
    ctx.strokeStyle = '#3a3a4e';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(geo.xOf(0), geo.yOf(0));
    ctx.lineTo(geo.xOf(1), geo.yOf(1));
    ctx.stroke();
    ctx.setLineDash([]);

    // The spline, sampled densely enough to show the real shape.
    const evaluate = monotoneEvaluator(state.points);
    ctx.strokeStyle = CURVE_COLOR;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    const steps = Math.max(32, Math.round(geo.plotWidth));
    for (let index = 0; index <= steps; index += 1) {
      const x = index / steps;
      const y = clamp01(evaluate(x));
      const px = geo.xOf(x);
      const py = geo.yOf(y);
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Control points. The two ends are drawn as squares: they are pinned.
    state.points.forEach((point, index) => {
      const x = geo.xOf(point[0]);
      const y = geo.yOf(point[1]);
      const pinned = index === 0 || index === state.points.length - 1;
      const active = index === dragIndex;
      ctx.fillStyle = active ? '#ffffff' : pinned ? '#ffc857' : '#ff3d8b';
      ctx.strokeStyle = active ? '#ff3d8b' : 'rgba(0, 0, 0, 0.6)';
      ctx.lineWidth = active ? 2 : 1;
      ctx.beginPath();
      if (pinned) ctx.rect(x - POINT_RADIUS, y - POINT_RADIUS, POINT_RADIUS * 2, POINT_RADIUS * 2);
      else ctx.arc(x, y, POINT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  }

  /* --------------------------------------------------------- interaction */

  /**
   * @param {MouseEvent|PointerEvent} event
   * @returns {{x:number, y:number}}
   */
  function localPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /**
   * @param {{x:number, y:number}} point
   * @returns {number}
   */
  function hitPoint(point) {
    const geo = geometry();
    let best = -1;
    let bestDistance = POINT_HIT;
    state.points.forEach((entry, index) => {
      const distance = Math.hypot(geo.xOf(entry[0]) - point.x, geo.yOf(entry[1]) - point.y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }

  const detachDrag = drag({
    target: canvas,
    onStart: (event) => {
      if (event.button !== 0 || destroyed) return;
      canvas.focus();
      const index = hitPoint(localPoint(event));
      dragIndex = index;
      moved = false;
      grab = index >= 0 ? { x: state.points[index][0], y: state.points[index][1] } : null;
      requestDraw();
    },
    onMove: (dx, dy) => {
      if (dragIndex < 0 || !grab || destroyed) return;
      const geo = geometry();
      moved = moved || Math.hypot(dx, dy) > 1.5;
      const point = state.points[dragIndex];
      if (!point) return;
      const last = state.points.length - 1;
      const y = clamp01(grab.y - dy / geo.plotHeight);
      if (dragIndex === 0) {
        // The endpoints are pinned to the edges of the square.
        point[1] = y;
      } else if (dragIndex === last) {
        point[1] = y;
      } else {
        const minX = (state.points[dragIndex - 1]?.[0] ?? 0) + 0.002;
        const maxX = (state.points[dragIndex + 1]?.[0] ?? 1) - 0.002;
        point[0] = clamp(grab.x + dx / geo.plotWidth, Math.min(minX, maxX), Math.max(minX, maxX));
        point[1] = y;
      }
      onChange(state.points);
      requestDraw();
    },
    onEnd: () => {
      if (dragIndex >= 0 && moved) onChange(state.points);
      dragIndex = -1;
      grab = null;
      // `moved` is deliberately left alone: the click event that follows a drag
      // must not be mistaken for "click empty space to add a point".
      requestDraw();
    },
  });

  /**
   * @param {MouseEvent} event
   */
  function onClick(event) {
    if (destroyed || moved) return;
    const point = localPoint(event);
    const geo = geometry();
    if (hitPoint(point) >= 0) return;
    if (point.x < CURVE_PAD || point.x > CURVE_PAD + geo.plotWidth) return;
    if (point.y < CURVE_PAD || point.y > CURVE_PAD + geo.plotHeight) return;
    if (state.points.length >= MAX_POINTS) {
      storeNoticeHint(`This curve already has ${MAX_POINTS} points — the renderer reads at most that many. Remove one first.`);
      return;
    }
    const x = clamp01(geo.xAt(point.x));
    const y = curveAt(x);
    const index = state.points.findIndex((entry) => entry[0] > x);
    state.points.splice(index < 0 ? state.points.length - 1 : index, 0, [x, y]);
    onChange(state.points);
    requestDraw();
  }

  /**
   * @param {MouseEvent} event
   */
  function onDoubleClick(event) {
    if (destroyed) return;
    const index = hitPoint(localPoint(event));
    if (index <= 0 || index >= state.points.length - 1) return;
    state.points.splice(index, 1);
    onChange(state.points);
    requestDraw();
  }

  /**
   * The curve editor has no store of its own, so a refused edit is reported
   * through the caller-owned hint line instead of the toast stack.
   * @param {string} message
   */
  function storeNoticeHint(message) {
    hint.textContent = message;
    hint.classList.add('hint--warn');
  }

  canvas.addEventListener('click', onClick);
  canvas.addEventListener('dblclick', onDoubleClick);
  if (ownsWrapper) container.append(root);
  requestDraw();

  return {
    /** Force a repaint (used after the caller replaces the points array). */
    redraw: requestDraw,
    /** Remove the editor and everything it registered. */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      detachDrag();
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.remove();
      hint.remove();
      // A container we did not create belongs to the caller: leave it in place.
      if (ownsWrapper) root.remove();
    },
  };
}
