/**
 * The properties / effects inspector.
 *
 * One panel, one clip at a time: the primary selection's transform, blend mode,
 * effect stack, masks and source parameters, plus the keyframe/graph tools and
 * the two composition-wide panels (audio connections, audio analysis) that make
 * sense with nothing selected at all.
 *
 * House rules:
 *  - Every document change goes through `store.edit(...)`, so undo/redo works.
 *  - A continuous drag opens a gesture on its first input and closes it on
 *    commit, folding one sweep of a slider into one history entry.
 *  - Rebuilds wait while a gesture is in flight: replacing the element under the
 *    pointer would end the drag, so the pending rebuild lands on commit instead.
 *  - The graph editor and the `curves` editors live in a dock that a rebuild
 *    never detaches, so dragging inside them survives the document event that
 *    their own edits emit.
 *
 * Nothing runs at import time except loading the engine modules, and nothing
 * outside `root` is touched.
 */
import {
  ICONS, button, colorField, confirmDialog, drag, el, emptyState, fitCanvas, formatValue,
  hint, iconButton, menu, promptDialog, section, select, slider, textField, toggle,
} from './dom.js';

/**
 * The engine ships as root-absolute ESM (`/core/...`) because that is how the
 * server mounts it. Node cannot resolve a root-absolute specifier (it means
 * `C:\core\...` on Windows), so every module is imported by URL first and by the
 * equivalent relative path second -- the same URL when the app is served, and
 * the real file on disk when Node imports this module.
 * @param {string} absolute @param {string} relative @returns {Promise<any|null>}
 */
async function loadEngine(absolute, relative) {
  try {
    return await import(/* @vite-ignore */ absolute);
  } catch {
    try {
      return await import(/* @vite-ignore */ relative);
    } catch (error) {
      console.warn(`[motion-lab] could not load ${absolute}`, error);
      return null;
    }
  }
}

const [schemaModule, channelsModule, keyframesModule, audioModule, effectsModule, mathModule] = await Promise.all([
  loadEngine('/core/schema.js', '../../core/schema.js'),
  loadEngine('/core/channels.js', '../../core/channels.js'),
  loadEngine('/core/keyframes.js', '../../core/keyframes.js'),
  loadEngine('/core/audio.js', '../../core/audio.js'),
  loadEngine('/core/effectRegistry.js', '../../core/effectRegistry.js'),
  loadEngine('/core/math.js', '../../core/math.js'),
]);
const { uid, defaultClip, defaultTrack, defaultGraphic, defaultTextStyle, neutralTransform } = schemaModule ?? {};
const { clipChannelSpecs, transformChannelSpecs, maskChannelSpecs, groupLabel, audioTargetableChannels, setTransformBase } = channelsModule ?? {};
const { channelValue, findChannel, setKeyframe, removeKeyframe, evaluateChannel, easingPreset, EASING_PRESETS, applyEasing, copyKeyframes, pasteKeyframes, keysAtTime, allKeyTimes, channelRange } = keyframesModule ?? {};
const { BAND_CHOICES, createMapping, suggestRange, rawSignal, markerTimes, curveValueAt, curveRawAt } = audioModule ?? {};
const { EFFECT_REGISTRY, EFFECT_CATEGORIES, effectDefinition, defaultParams, animatableParams, describeEffect } = effectsModule ?? {};
const { clamp, clamp01, formatNumber } = mathModule ?? {};
const ENGINE_READY = Boolean(schemaModule && channelsModule && keyframesModule && audioModule && effectsModule && mathModule);
/** @typedef {import('/core/schema.js').Clip} Clip */
/** @typedef {import('/core/schema.js').Mask} Mask */
/** @typedef {import('/core/schema.js').AudioMapping} AudioMapping */

/* Tables: everything the panel offers that is not a store method. */
const BLEND_MODES = Object.freeze([
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'add',
]);
const TEXT_FONTS = Object.freeze([
  'Georgia, "Times New Roman", serif', '"Segoe UI", system-ui, sans-serif',
  'Impact, "Arial Black", sans-serif', '"Courier New", monospace', 'Verdana, sans-serif',
]);
const TEXT_WEIGHTS = Object.freeze([300, 400, 600, 700, 900]);
const TEXT_ALIGNS = Object.freeze(['left', 'center', 'right']);
const TEXT_BASELINES = Object.freeze(['top', 'middle', 'bottom']);
/** key, label, min, max, step, unit, decimals */
const TEXT_NUMBERS = Object.freeze([
  ['fontSize', 'Size', 8, 400, 1, 'px', 0],
  ['letterSpacing', 'Letter spacing', -20, 80, 0.5, 'px', 1],
  ['lineHeight', 'Line height', 0.6, 3, 0.01, '×', 2],
  ['maxWidth', 'Max width', 0, 4000, 4, 'px', 0],
  ['strokeWidth', 'Stroke width', 0, 40, 0.5, 'px', 1],
  ['shadowBlur', 'Shadow blur', 0, 120, 1, 'px', 0],
  ['shadowX', 'Shadow X', -200, 200, 1, 'px', 0],
  ['shadowY', 'Shadow Y', -200, 200, 1, 'px', 0],
]);
const AUDIO_NUMBERS = Object.freeze([
  ['volume', 'Volume', 0, 2, 0.01, '×', 2],
  ['pan', 'Pan', -1, 1, 0.01, '', 2],
  ['fadeIn', 'Fade in', 0, 30, 0.01, 's', 2],
  ['fadeOut', 'Fade out', 0, 30, 0.01, 's', 2],
]);
const TRANSFORM_GROUPS = Object.freeze([
  ['Position', ['transform.position.x', 'transform.position.y']],
  ['Scale', ['transform.scale.x', 'transform.scale.y']],
  ['Rotation & opacity', ['transform.rotation', 'transform.opacity']],
  ['Anchor', ['transform.anchor.x', 'transform.anchor.y']],
  ['Crop', ['transform.crop.top', 'transform.crop.right', 'transform.crop.bottom', 'transform.crop.left']],
]);
const TRANSFORM_TARGETS = Object.freeze(['transform.position.x', 'transform.position.y', 'transform.scale.x', 'transform.scale.y', 'transform.rotation', 'transform.opacity']);
const GRAPHIC_KINDS = Object.freeze(['gradient', 'shape', 'particles', 'waveform', 'bars', 'rings', 'noise', 'grid']);
const SHAPE_KINDS = Object.freeze(['circle', 'rect', 'triangle', 'star', 'ring', 'line']);
const GRADIENT_KINDS = Object.freeze(['linear', 'radial', 'conic', 'mesh', 'aurora']);
/** Graphic parameter sliders: label, min, max, step, unit, decimals. */
const GRAPHIC_PARAMS = Object.freeze({
  amount: ['Amount', 0, 1, 0.01, '', 3], count: ['Count', 1, 600, 1, '', 0], speed: ['Speed', -4, 4, 0.05, '×', 2],
  size: ['Size', 0, 2, 0.01, '', 3], spread: ['Spread', 0, 1, 0.01, '', 3], complexity: ['Complexity', 1, 8, 1, '', 0],
  rotation: ['Rotation', -360, 360, 1, '°', 1], width: ['Width', 0, 2, 0.01, '', 3], height: ['Height', 0, 2, 0.01, '', 3],
  bandCount: ['Bands', 4, 160, 1, '', 0], smoothing: ['Smoothing', 0, 0.98, 0.01, '', 2],
});
/** Which parameters each procedural kind reads; the rest is shared plumbing. */
const GRAPHIC_KIND_PARAMS = Object.freeze({
  gradient: ['gradientKind', 'amount', 'speed', 'width', 'height', 'rotation'],
  shape: ['shapeKind', 'count', 'size', 'spread', 'rotation', 'speed'],
  particles: ['count', 'size', 'spread', 'speed', 'complexity', 'rotation'],
  waveform: ['text', 'amount', 'smoothing', 'mirror', 'size', 'speed'],
  bars: ['bandCount', 'amount', 'smoothing', 'mirror', 'size'],
  rings: ['count', 'size', 'spread', 'complexity', 'rotation', 'speed'],
  noise: ['complexity', 'amount', 'speed', 'size', 'spread'],
  grid: ['width', 'height', 'count', 'amount', 'rotation'],
});
const GRAPHIC_KIND_NOTES = Object.freeze({
  gradient: 'A gradient reads its kind, amount, speed, rotation and size; colours A, B and C build the ramp.',
  shape: 'Shapes use shape kind, count, size, spread, rotation and speed.',
  particles: 'Particles are seeded: the same seed always lays out the same field, in the preview and in the export.',
  waveform: 'The waveform source reads label, amount, smoothing, mirror, size and speed.',
  bars: 'Bars read band count, amount, smoothing, mirror and size.',
  rings: 'Rings read count, size, spread, complexity, rotation and speed.',
  noise: 'Noise reads complexity, amount, speed, size and spread.',
  grid: 'The grid reads width, height, count, amount and rotation.',
});
/** Band envelopes drawn behind the waveform, in z-order. */
const ANALYSIS_BANDS = Object.freeze([
  { key: 'level', label: 'Level', color: 'rgba(206, 214, 232, 0.85)' },
  { key: 'low', label: 'Low', color: 'rgba(255, 61, 139, 0.9)' },
  { key: 'mid', label: 'Mid', color: 'rgba(92, 225, 255, 0.9)' },
  { key: 'high', label: 'High', color: 'rgba(255, 209, 102, 0.9)' },
]);
const LOW_CONFIDENCE = 0.35;

/**
 * Build the inspector panel.
 *
 * The returned `root` is meant to be appended into `.panel--right`. `render()`
 * rebuilds the body from the store's current document and selection;
 * `scheduleRender()` coalesces any number of calls into one rebuild on the next
 * animation frame, preserves the panel's scroll position and defers itself
 * entirely while the user is mid-drag.
 *
 * @param {object} options
 * @param {import('../store.js').Store} options.store  Editor store: document, selection, playhead, edit/gesture API.
 * @param {import('../media.js').MediaEngine} options.media  Media engine, used to analyse audio on demand.
 * @param {import('../preview.js').Preview} options.preview  Preview, invalidated after every edit.
 * @param {import('../api.js').api} options.api  Server API, used to replace an asset's file.
 * @returns {{root: HTMLElement, render: () => void, scheduleRender: () => void}}
 */
export function buildInspector({ store, media, preview, api }) {
  const root = el('div', { class: 'panel__body' });
  const main = el('div', {});
  const dock = el('div', { class: 'inspector-section hidden', style: { position: 'sticky', top: '0', zIndex: '4', background: 'var(--bg-1)' } });
  // The dock sits first so a mounted editor stays pinned at the top of the
  // scrolled panel instead of trailing the last section.
  root.append(dock, main);
  if (!ENGINE_READY) {
    main.append(hint('error', 'The Motion Lab engine modules could not be loaded, so the inspector is unavailable. Reload the page; if it persists, check that /core is being served.'));
    return { root, render() {}, scheduleRender() {} };
  }
  /** Local (non-document) panel state; survives every rebuild. */
  const state = {
    open: { transform: true, blend: false, effects: true, masks: false, keyframes: false, source: false, audio: false, analysis: false },
    link: true,
    dragging: /** @type {string|null} */ (null),  // slider whose drag is in flight
    gestures: 0,                                  // open gestures; while > 0 rebuilds wait
    pendingRender: false,
    selectedKey: /** @type {{channel:string, time:number}|null} */ (null),
    graph: /** @type {{channel:string, clipId:string, entry:HTMLElement, handle:any}|null} */ (null),
    curves: /** @type {Map<string, {entry:HTMLElement, handle:any}>} */ (new Map()),
    meters: /** @type {Array<any>} */ ([]),
  };
  let frame = 0;

  function render() {
    const scrollTop = root.scrollTop;
    state.dragging = null;
    state.meters = [];
    const clip = store.primaryClip;
    pruneGrowth(clip);
    main.replaceChildren(...body(clip));
    root.scrollTop = scrollTop;
    updateMeters();
  }

  /** Rebuild at most once per animation frame; never during a drag. */
  function scheduleRender() {
    if (frame) return;
    if (state.gestures > 0) { state.pendingRender = true; return; }
    frame = requestAnimationFrame(() => { frame = 0; render(); });
  }
  function beginAdjust(/** @type {string} */ label) { state.gestures += 1; store.beginGesture(label); }
  /** Close the gesture, then flush at most one deferred rebuild. */
  function endAdjust() {
    if (state.gestures > 0) state.gestures -= 1;
    store.endGesture(true);
    if (state.gestures === 0 && state.pendingRender) { state.pendingRender = false; scheduleRender(); }
  }
  /**
   * The timeline lives on main.js's debug handle; the store's `doc` event also
   * invalidates it, so this is only the immediate path.
   * @param {boolean} structure
   */
  function invalidateTimeline(structure) { /** @type {any} */ (globalThis).__motionLab?.timeline?.invalidate?.(structure); }
  /** @param {boolean} [rebuild] */
  function invalidate(rebuild) { preview?.invalidate?.(Boolean(rebuild)); invalidateTimeline(true); }
  /** One mutation, one undo step, then the preview/timeline invalidations. */
  function write(/** @type {string} */ label, /** @type {() => void} */ mutate, /** @type {{rebuild?:boolean}} */ options = {}) {
    store.edit(label, mutate);
    invalidate(options.rebuild);
  }

  store.on('doc', scheduleRender);
  store.on('selection', scheduleRender);
  store.on('library', scheduleRender);
  store.on('analysis', () => { updateMeters(); scheduleRender(); });
  store.on('playhead', () => {
    updateMeters();
    // Follow the playhead while scrubbing, but never rebuild during playback:
    // the inspector is a property editor, not a monitor.
    if (!store.playback.playing) scheduleRender();
  });

  /* Channel layer: one flat namespace for transform, mask and effect values. */

  const clipNow = () => store.primaryClip;
  const specsFor = (/** @type {Clip} */ clip) => clipChannelSpecs(clip, store.doc.composition, EFFECT_REGISTRY);
  const specFor = (/** @type {Clip} */ clip, /** @type {string} */ channel) => specsFor(clip).find((spec) => spec.id === channel) ?? null;
  const labelFor = (/** @type {Clip} */ clip, /** @type {string} */ channel) => specFor(clip, channel)?.label ?? channel;
  const keyAt = (/** @type {Clip} */ clip, /** @type {string} */ channel, /** @type {number} */ time) => findChannel(clip, channel)?.keys.find((key) => Math.abs(key.time - time) < 1e-3) ?? null;

  /** @param {Clip} clip @param {string} channel */
  function nearestKeyTime(clip, channel) {
    const entry = findChannel(clip, channel);
    if (!entry || entry.keys.length === 0) return null;
    const now = store.playback.time;
    let best = entry.keys[0];
    for (const key of entry.keys) if (Math.abs(key.time - now) < Math.abs(best.time - now)) best = key;
    return best.time;
  }

  /** The key the easing controls act on: at the playhead, remembered, else nearest. */
  function selectedKeyOf(/** @type {Clip} */ clip, /** @type {string} */ channel) {
    const entry = findChannel(clip, channel);
    if (!entry || entry.keys.length === 0) return null;
    const remembered = state.selectedKey;
    if (remembered && remembered.channel === channel) {
      const found = entry.keys.find((key) => Math.abs(key.time - remembered.time) < 1e-3);
      if (found) return found;
    }
    const nearest = nearestKeyTime(clip, channel);
    const key = entry.keys.find((candidate) => Math.abs(candidate.time - store.playback.time) < 1e-3)
      ?? entry.keys.find((candidate) => Math.abs(candidate.time - nearest) < 1e-3) ?? entry.keys[0];
    state.selectedKey = { channel, time: key.time };
    return key;
  }

  /** @param {Clip} clip @param {string} channel */
  function channelBaseValue(clip, channel) {
    if (channel.startsWith('effects.')) {
      const [, id, key] = channel.split('.');
      const stored = clip.effects.stack.find((entry) => entry.id === id)?.params?.[key];
      if (typeof stored === 'number') return stored;
    }
    return specFor(clip, channel)?.base ?? 0;
  }

  /** @param {Mask} mask @param {string} channel @param {number} value */
  function setMaskBase(mask, channel, value) {
    const [group, axis] = channel.split('.').slice(2);
    if (group === 'rotation' || group === 'feather' || group === 'opacity') mask[group] = value;
    else if (mask[group] && axis) mask[group][axis] = value;
  }

  /** @param {Clip} clip @param {string} channel @param {number} value */
  function setChannelBase(clip, channel, value) {
    if (channel.startsWith('transform.')) { setTransformBase(clip.transform, channel, value); return; }
    if (channel.startsWith('masks.')) {
      const mask = clip.masks.find((entry) => entry.id === channel.split('.')[1]);
      if (mask) setMaskBase(mask, channel, value);
      return;
    }
    const match = /^effects\.([^.]+)\.(.+)$/.exec(channel);
    if (!match) return;
    const instance = clip.effects.stack.find((entry) => entry.id === match[1]);
    if (instance) instance.params[match[2]] = value;
  }

  /** Animated channels are keyed at the playhead; everything else writes its base. */
  function applyChannelValue(/** @type {Clip} */ clip, /** @type {string} */ channel, /** @type {number} */ value) {
    const entry = findChannel(clip, channel);
    if (entry && entry.keys.length > 0) setKeyframe(clip, channel, store.playback.time, value);
    else setChannelBase(clip, channel, value);
  }

  /** Add the keyframe at the playhead, or remove the one already there. */
  function toggleKey(/** @type {Clip} */ clip, /** @type {string} */ channel, /** @type {number} */ value, /** @type {string} */ label) {
    const existing = keyAt(clip, channel, store.playback.time);
    store.edit(existing ? `Remove ${label} key` : `Add ${label} key`, () => {
      if (existing) removeKeyframe(clip, channel, existing.id);
      else setKeyframe(clip, channel, store.playback.time, value);
    });
    invalidate(false);
    scheduleRender();
  }

  /* Controls. `channelSlider` and `valueSlider` own the gesture bookkeeping, so
     one sweep of a slider is one undo entry and never rebuilds mid-drag. */

  /**
   * @param {Clip} clip @param {string} channel
   * @param {{label?:string, min?:number, max?:number, step?:number, unit?:string, decimals?:number, title?:string, mirror?:(value:number)=>void, resetValue?:number}} [extra]
   * @returns {HTMLElement}
   */
  function channelSlider(clip, channel, extra = {}) {
    const spec = specFor(clip, channel);
    const now = store.playback.time;
    const entry = findChannel(clip, channel);
    const label = extra.label ?? spec?.label ?? channel;
    const current = () => channelValue(clip, channel, now, channelBaseValue(clip, channel));
    return slider({
      label,
      value: current(),
      min: extra.min ?? spec?.min ?? 0,
      max: extra.max ?? spec?.max ?? 1,
      step: extra.step ?? spec?.step ?? 0.01,
      unit: extra.unit ?? spec?.unit ?? '',
      decimals: extra.decimals ?? spec?.decimals ?? 2,
      animated: Boolean(entry && entry.keys.length > 0),
      keyed: Boolean(entry && entry.keys.some((key) => Math.abs(key.time - now) < 1e-3)),
      title: extra.title ?? `${label} — ${channel}`,
      onInput: (value) => {
        if (state.dragging !== channel) { state.dragging = channel; beginAdjust(`Adjust ${label}`); }
        store.edit(`Adjust ${label}`, () => { applyChannelValue(clip, channel, value); extra.mirror?.(value); });
        preview?.invalidate?.();
        invalidateTimeline(true);
      },
      onCommit: () => {
        if (state.dragging !== channel) return;
        state.dragging = null;
        endAdjust();
        scheduleRender();
      },
      onToggleKey: () => toggleKey(clip, channel, current(), label),
      onReset: extra.resetValue === undefined ? undefined : () => write(`Reset ${label}`, () => setChannelBase(clip, channel, /** @type {number} */ (extra.resetValue))),
    });
  }

  /** A slider for a value that is not a keyframable channel. @param {any} options */
  function valueSlider(options) {
    const key = `value:${options.label}`;
    return slider({
      ...options,
      onInput: (value) => {
        if (state.dragging !== key) { state.dragging = key; beginAdjust(`Change ${options.label}`); }
        options.onInput(value);
        preview?.invalidate?.(Boolean(options.rebuild));
      },
      onCommit: () => { state.dragging = null; endAdjust(); scheduleRender(); },
    });
  }

  /** Shorthand: `num(label, value, min, max, apply, { step, unit, decimals, title })`. */
  const num = (/** @type {string} */ label, /** @type {number} */ value, /** @type {number} */ min, /** @type {number} */ max, /** @type {(value:number)=>void} */ apply, /** @type {any} */ extra = {}) =>
    valueSlider({ ...extra, label, value, min, max, onInput: apply });

  /** Gesture-aware colour field. @param {any} options label, value, apply */
  function colorControl(options) {
    const key = `colour:${options.label}`;
    return colorField({
      label: options.label,
      value: options.value,
      onChange: (value, committing) => {
        if (state.dragging !== key) { state.dragging = key; beginAdjust(`Change ${options.label}`); }
        options.apply(value);
        preview?.invalidate?.();
        if (committing) { state.dragging = null; endAdjust(); scheduleRender(); }
      },
    });
  }

  /** Labelled dropdown from strings or `{value,label}` pairs. */
  const pickRow = (/** @type {string} */ label, /** @type {Array<any>} */ options, /** @type {string} */ value, /** @type {(value:string)=>void} */ apply) =>
    select({ label, options: options.map((entry) => (typeof entry === 'string' ? { value: entry, label: entry } : entry)), value, onChange: apply });
  const flagRow = (/** @type {string} */ label, /** @type {boolean} */ checked, /** @type {(value:boolean)=>void} */ apply, /** @type {string} */ title) => toggle({ label, checked, onChange: apply, title: title ?? label });
  const smallButton = (/** @type {string} */ label, /** @type {string} */ title, /** @type {() => void} */ onclick) => button(label, 'btn btn--tiny', { title, onclick });
  const diceButton = (/** @type {string} */ title, /** @type {() => void} */ onRoll) => iconButton('\u2684', title, onRoll, 'icon-btn');
  const kv = (/** @type {string} */ key, /** @type {string} */ value) => el('div', { class: 'kv' }, [el('span', { class: 'kv__k', text: key }), el('span', { class: 'kv__v', text: value })]);
  const groupHeading = (/** @type {string} */ text) => el('div', { class: 'field__label', text, style: { marginTop: '8px', color: 'var(--text-3)' } });

  /** Build a `.menu__panel` body from entry descriptors. */
  function menuPanel(/** @type {() => void} */ close, /** @type {Array<any>} */ entries) {
    const panel = el('div', {});
    for (const entry of entries) {
      if (entry.group) { panel.append(el('div', { class: 'menu__label', text: entry.group })); continue; }
      if (entry.note) { panel.append(el('div', { class: 'menu__note', text: entry.note })); continue; }
      panel.append(el('button', {
        class: `menu__item${entry.danger ? ' menu__item--danger' : ''}`,
        text: entry.label ?? '', title: entry.hint ?? '',
        ...(entry.disabled ? { disabled: true } : {}),
        onclick: () => { close(); entry.onSelect?.(); },
      }));
    }
    return panel;
  }
  // Left-aligned: the buttons sit near the inspector's left edge, so a right-aligned menu would open outside the
  // panel, where it is clipped and the preview takes the clicks.
  const menuButton = (/** @type {string} */ label, /** @type {string} */ title, /** @type {(close:()=>void)=>HTMLElement} */ build) =>
    menu({ trigger: button(label, 'btn btn--tiny', { title }), build }).root;
  /** @param {Clip} clip */
  const maskMenu = (clip) => menuButton('+ Mask', 'Add a mask to this clip', (close) => menuPanel(close, [
    { group: 'Add mask' },
    { label: 'Rectangle', hint: 'A rectangular mask with rounded corners', onSelect: () => store.addMask(clip.id, 'rect') },
    { label: 'Ellipse', hint: 'A soft elliptical mask', onSelect: () => store.addMask(clip.id, 'ellipse') },
    { label: 'Polygon', hint: 'A closed freehand polygon — thin it later with Simplify', onSelect: () => store.addMask(clip.id, 'polygon') },
    { note: 'Masks live in normalised layer space, so they follow the layer at any output size.' },
  ]));
  const assetFor = (/** @type {Clip} */ clip) => (clip.assetId ? store.doc.assets.find((asset) => asset.id === clip.assetId) ?? null : null);

  /* A. Header: identity and the clip-wide actions. */

  /** @param {Clip|null} clip */
  function header(clip) {
    if (!clip) {
      return el('div', { class: 'inspector-section' }, [
        el('div', { class: 'inspector-section__head' }, [el('span', { class: 'inspector-section__title', text: 'Inspector' })]),
        el('div', { class: 'inspector-section__body' }, [
          emptyState('No clip selected. Click a clip in the Timeline, or drag media in from the Media panel. Audio connections and the analysis panel below work without a selection.'),
        ]),
      ]);
    }
    const count = store.ui.selectedClipIds.length;
    const nameField = textField({
      inline: true, value: clip.name, placeholder: 'Clip name',
      onChange: (value) => {
        const next = String(value).trim();
        if (!next || next === clip.name) return;
        write('Rename clip', () => { clip.name = next; });
        scheduleRender();
      },
    });
    return el('div', { class: 'inspector-section' }, [
      el('div', { class: 'inspector-section__head' }, [
        el('span', { class: 'inspector-section__title', text: 'Selected clip' }),
        el('span', { class: 'chip', text: `${ICONS[clip.kind] ?? ICONS.info} ${clip.kind}` }),
      ]),
      el('div', { class: 'inspector-section__body' }, [
        el('div', { class: 'field' }, [el('div', { class: 'field__label', text: 'Name' }), el('div', { class: 'field__control' }, [nameField])]),
        ...(count > 1 ? [hint('info', `${count} clips are selected; the inspector edits "${clip.name}", the primary selection.`)] : []),
        el('div', { class: 'chip-row' }, [
          smallButton(clip.effects.enabled ? 'Bypass effects' : 'Enable effects', 'Bypass or re-enable the whole effect stack',
            () => write(clip.effects.enabled ? 'Bypass effects' : 'Enable effects', () => { clip.effects.enabled = !clip.effects.enabled; })),
          maskMenu(clip),
          smallButton('Save preset', 'Save this clip\'s transform, effects and masks as a reusable preset', () => savePreset(clip)),
          button('Delete', 'btn btn--tiny btn--danger', { title: 'Delete the selected clip (undoable)', onclick: () => deleteSelected(clip) }),
        ]),
        kv('Track', store.doc.tracks.find((track) => track.id === clip.trackId)?.name ?? '—'),
        kv('Timing', `${formatNumber(clip.start, 2)}s → ${formatNumber(clip.start + clip.duration, 2)}s`),
        kv('Key channels', `${clip.keyframes.length} (${allKeyTimes(clip).length} moments)`),
      ]),
    ]);
  }

  /** @param {Clip} clip */
  async function savePreset(clip) {
    const presetName = await promptDialog({ title: 'Save as preset', message: 'Transform, effects and masks are stored together.', value: `${clip.name} look` });
    if (!presetName || !presetName.trim()) return;
    store.addPreset({
      id: uid('preset'), name: presetName.trim(), kind: 'effect-stack', category: 'Inspector',
      description: `${clip.effects.stack.length} effect(s) from "${clip.name}"`, createdAt: Date.now(),
      data: {
        transform: JSON.parse(JSON.stringify(clip.transform)),
        effects: JSON.parse(JSON.stringify(clip.effects.stack)),
        masks: JSON.parse(JSON.stringify(clip.masks)),
      },
    });
    store.notify('ok', `Saved "${presetName.trim()}" to the preset library.`, { title: 'Preset' });
  }

  /** @param {Clip} clip */
  async function deleteSelected(clip) {
    const count = store.ui.selectedClipIds.length;
    const ok = await confirmDialog({
      title: 'Delete clip?', confirmLabel: 'Delete', danger: true,
      message: count > 1 ? `Delete ${count} selected clips? Undo keeps them recoverable.` : `Delete "${clip.name}"? Undo keeps it recoverable.`,
    });
    if (ok) store.deleteClips([...store.ui.selectedClipIds]);
  }

  /* B. Transform: every property is a keyframable channel. */

  /** @param {Clip} clip */
  function transformSection(clip) {
    const mirror = (/** @type {string} */ id) => (state.link
      ? (value) => applyChannelValue(clip, id === 'transform.scale.x' ? 'transform.scale.y' : 'transform.scale.x', value)
      : undefined);
    const rows = [el('div', { class: 'chip-row' }, [
      smallButton('Fit to frame', 'Sets the base transform: crop 0, scale 1, centred anchor, position 0. Existing keyframes still win.',
        () => write('Fit to frame', () => { Object.assign(clip.transform, { cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5, x: 0, y: 0 }); })),
      smallButton('Reset transform', 'Back to the neutral transform: opacity 1, no crop, no rotation',
        () => write('Reset transform', () => { Object.assign(clip.transform, neutralTransform()); })),
      flagRow('Link scale', state.link, (value) => { state.link = value; }, 'Mirror one scale axis onto the other while editing'),
    ])];
    for (const [title, channels] of TRANSFORM_GROUPS) {
      rows.push(groupHeading(title));
      for (const channel of channels) {
        const reset = channel.includes('anchor') ? 0.5 : channel.includes('scale') || channel === 'transform.opacity' ? 1 : 0;
        rows.push(channelSlider(clip, channel, { resetValue: reset, mirror: channel.startsWith('transform.scale.') ? mirror(channel) : undefined }));
      }
    }
    rows.push(hint('info', `${transformChannelSpecs(store.doc.composition).length} transform channels are keyframable here. The diamond adds a keyframe at the playhead and removes the one already there; an animated property draws as a coloured slider.`));
    return rows;
  }

  /* C. Blend & compositing. */

  /** @param {Clip} clip */
  function blendSection(clip) {
    return [
      pickRow('Blend mode', BLEND_MODES, BLEND_MODES.includes(clip.blend) ? clip.blend : 'normal', (value) => write('Change blend mode', () => { clip.blend = value; }, { rebuild: true })),
      flagRow('Visible in the composition', !clip.hidden, (value) => write(value ? 'Show clip' : 'Hide clip', () => { clip.hidden = !value; }), 'Per-clip visibility, independent of the track'),
      el('div', { class: 'chip-row' }, [smallButton('Nested composition', 'Group the selected clips into one reusable nested composition', () => nestSelectedClips())]),
      hint('info', 'Nesting keeps the selected clips, their animation and their effects together in a single layer. A nested timeline is edited in the Timeline panel after selecting the nested clip.'),
    ];
  }

  /** Group the selected clips into a nested composition, replaced by one clip. */
  function nestSelectedClips() {
    const ids = [...store.ui.selectedClipIds];
    const selected = store.doc.clips.filter((clip) => ids.includes(clip.id));
    if (selected.length === 0) { store.notify('warn', 'Select at least one clip before nesting.'); return; }
    const from = Math.min(...selected.map((clip) => clip.start));
    const to = Math.max(...selected.map((clip) => clip.start + clip.duration));
    const compositionId = uid('comp');
    const name = selected.length === 1 ? `${selected[0].name} (nested)` : `Nested composition ${store.doc.compositions.length + 1}`;
    const duration = Math.max(1 / store.doc.composition.fps, to - from);
    /** @type {Map<string, any>} */ const trackMap = new Map();
    /** @type {any[]} */ const tracks = [];
    /** @type {any[]} */ const clips = [];
    for (const clip of selected) {
      let track = trackMap.get(clip.trackId);
      if (!track) {
        const source = store.doc.tracks.find((entry) => entry.id === clip.trackId);
        track = defaultTrack({ name: source?.name ?? 'Nested track', kind: source?.kind ?? 'visual', height: 74 });
        trackMap.set(clip.trackId, track);
        tracks.push(track);
      }
      const copy = JSON.parse(JSON.stringify(clip));
      copy.trackId = track.id;
      copy.start = clip.start - from;
      clips.push(copy);
    }
    const host = defaultClip({ name, kind: 'nested', compositionId, start: from, duration, trackId: store.primaryClip?.trackId ?? store.doc.tracks[0]?.id ?? '' });
    store.edit('Nest clips', () => {
      store.doc.compositions.push({ id: compositionId, name, composition: { ...store.doc.composition, duration }, tracks, clips });
      store.doc.clips = store.doc.clips.filter((clip) => !ids.includes(clip.id));
      store.doc.clips.push(host);
    });
    store.selectClips([host.id]);
    store.notify('ok', `Created the nested composition "${name}". Nested timelines are edited in the Timeline panel: select the nested clip there to work inside it.`, { title: 'Nested' });
  }

  /* D. Effects: the stack, one card per instance. */

  /** @param {Clip} clip */
  function effectsSection(clip) {
    const stack = clip.effects.stack;
    const rows = [el('div', { class: 'chip-row' }, [
      menuButton('+ Add effect', 'Add an effect to this clip', (close) => menuPanel(close, effectMenuEntries(clip))),
      flagRow('Stack enabled', clip.effects.enabled, (value) => write(value ? 'Enable effects' : 'Bypass effects', () => { clip.effects.enabled = !value; }), 'Bypass or enable every effect on this clip at once'),
      ...(stack.length > 0 ? [button('Remove all', 'btn btn--tiny btn--danger', {
        title: 'Remove every effect from this clip',
        onclick: async () => {
          const ok = await confirmDialog({ title: 'Remove all effects?', message: `Remove ${stack.length} effect(s) from "${clip.name}"?`, confirmLabel: 'Remove', danger: true });
          if (!ok) return;
          store.edit('Remove all effects', () => {
            clip.effects.stack = [];
            clip.keyframes = clip.keyframes.filter((entry) => !entry.channel.startsWith('effects.'));
          });
        },
      })] : []),
    ])];
    if (stack.length === 0) {
      rows.push(emptyState('No effects yet. "+ Add effect" opens the registry, grouped by category. Effects render bottom to top: the list order is the pipeline order.'));
      return rows;
    }
    if (!clip.effects.enabled) rows.push(hint('warn', 'The stack is bypassed, so none of these effects is rendering right now.'));
    stack.forEach((instance, index) => rows.push(effectCard(clip, instance, index)));
    rows.push(hint('info', 'Drag a card by its grip to reorder the pipeline, or use the arrows for a single step.'));
    return rows;
  }

  /** The add-effect menu, grouped by `EFFECT_CATEGORIES`. @param {Clip} clip */
  function effectMenuEntries(clip) {
    /** @type {Array<any>} */ const entries = [];
    const all = Object.values(EFFECT_REGISTRY);
    const add = (/** @type {any} */ definition) => entries.push({ label: definition.label, hint: definition.description, onSelect: () => store.addEffect(clip.id, definition.type) });
    for (const category of EFFECT_CATEGORIES) {
      entries.push({ group: category });
      all.filter((definition) => definition.category === category).forEach(add);
    }
    const others = all.filter((definition) => !EFFECT_CATEGORIES.includes(definition.category));
    if (others.length > 0) { entries.push({ group: 'Other' }); others.forEach(add); }
    return entries;
  }

  /** One effect card: a head with the drag grip and actions, a body of controls. */
  function effectCard(/** @type {Clip} */ clip, /** @type {any} */ instance, /** @type {number} */ index) {
    const definition = effectDefinition(instance.type);
    const card = el('div', { class: `effect-card${instance.enabled ? '' : ' effect-card--disabled'}` });
    const category = el('span', { class: 'effect-card__cat', text: definition.category });
    const head = el('div', { class: 'effect-card__head' }, [
      el('span', { class: 'effect-card__grip', text: ICONS.grip, title: 'Drag to reorder this effect in the pipeline' }),
      flagRow('', instance.enabled, (value) => write(value ? `Enable ${definition.label}` : `Bypass ${definition.label}`, () => { instance.enabled = value; }), instance.enabled ? 'Bypass this effect' : 'Enable this effect'),
      el('span', { class: 'effect-card__name', text: definition.label, title: definition.description }),
      category,
      iconButton(ICONS.key, 'Key every numeric parameter at the playhead', () => keyEffectParams(clip, instance), 'icon-btn'),
      iconButton(ICONS.undo, 'Reset every parameter to its registry default', () => write(`Reset ${definition.label}`, () => { instance.params = defaultParams(instance.type); }), 'icon-btn'),
      iconButton('\u2191', 'Move up one step', () => store.moveEffect(clip.id, instance.id, -1), 'icon-btn'),
      iconButton('\u2193', 'Move down one step', () => store.moveEffect(clip.id, instance.id, 1), 'icon-btn'),
      iconButton(ICONS.copy, 'Duplicate this effect', () => store.duplicateEffect(clip.id, instance.id), 'icon-btn'),
      iconButton(ICONS.trash, 'Remove this effect', () => store.removeEffect(clip.id, instance.id), 'icon-btn icon-btn--danger'),
    ]);
    card.append(head, el('div', { class: 'effect-card__body' }, effectBody(clip, instance, definition)));
    attachEffectDrag(card, head, clip, index, category);
    return card;
  }

  /**
   * Reorder by pointer: the drop index is the number of sibling midlines above
   * the pointer, corrected for the dragged card's own slot.
   */
  function attachEffectDrag(/** @type {HTMLElement} */ card, /** @type {HTMLElement} */ head, /** @type {Clip} */ clip, /** @type {number} */ index, /** @type {HTMLElement} */ category) {
    let armed = false;
    let dropIndex = index;
    /** @type {HTMLElement[]} */ let cards = [];
    const original = category.textContent ?? '';
    drag({
      target: head,
      onStart: (event) => {
        armed = !(/** @type {HTMLElement} */ (event.target).closest('button, input, label, .checkbox'));
        dropIndex = index;
        if (!armed) return;
        cards = [...(card.parentElement?.querySelectorAll('.effect-card') ?? [])];
        card.classList.add('effect-card--dragging');
      },
      onMove: (dx, dy, event) => {
        if (!armed) return;
        let drop = 0;
        for (const rect of cards.map((entry) => entry.getBoundingClientRect())) if (event.clientY > rect.top + rect.height / 2) drop += 1;
        if (drop > index) drop -= 1;
        dropIndex = clamp(drop, 0, Math.max(0, cards.length - 1));
        category.textContent = `→ ${dropIndex + 1}`;
      },
      onEnd: () => {
        card.classList.remove('effect-card--dragging');
        category.textContent = original;
        if (!armed) return;
        armed = false;
        if (dropIndex !== index) store.reorderEffect(clip.id, index, dropIndex);
      },
    });
  }

  /** One control per registry parameter, plus the seed for stochastic families. */
  function effectBody(/** @type {Clip} */ clip, /** @type {any} */ instance, /** @type {any} */ definition) {
    const rows = [el('div', { class: 'effect-card__desc', text: definition.description })];
    const summary = describeEffect(instance.type, instance.params);
    if (summary) rows.push(kv('Currently', summary));
    if (definition.perFrame) rows.push(hint('info', 'This effect is time dependent, so its seed is what keeps the preview and the export identical.'));
    for (const spec of definition.params) {
      const channel = `effects.${instance.id}.${spec.key}`;
      const apply = (/** @type {any} */ value) => write(`Change ${spec.label}`, () => { instance.params[spec.key] = value; });
      if (spec.kind === 'number') {
        rows.push(channelSlider(clip, channel, {
          label: spec.label, min: spec.min ?? 0, max: spec.max ?? 1, step: spec.step ?? 0.01,
          unit: spec.unit ?? '', decimals: spec.decimals ?? 3, resetValue: /** @type {number} */ (spec.default),
        }));
      } else if (spec.kind === 'toggle') rows.push(flagRow(spec.label, Boolean(instance.params[spec.key] ?? spec.default), apply, spec.hint ?? `${definition.label} · ${spec.label}`));
      else if (spec.kind === 'select') rows.push(pickRow(spec.label, spec.options ?? [], String(instance.params[spec.key] ?? spec.default), apply));
      else if (spec.kind === 'color') rows.push(colorControl({ label: spec.label, value: String(instance.params[spec.key] ?? spec.default), apply }));
      else if (spec.kind === 'text') rows.push(textField({ label: spec.label, value: String(instance.params[spec.key] ?? spec.default ?? ''), onChange: apply }));
      else if (spec.kind === 'palette') rows.push(paletteControl(instance, spec, definition));
      else if (spec.kind === 'points') rows.push(curveControl(instance, spec, definition));
    }
    if (needsSeed(definition)) rows.push(seedControl(instance, definition, 'effect'));
    return rows;
  }

  /** Seeds drive determinism, so every stochastic family gets one. */
  function needsSeed(/** @type {any} */ definition) {
    return definition.perFrame === true
      || ['Texture', 'Motion', 'Distortion'].includes(definition.category)
      || /seed|noise|grain|particle|random/i.test(`${definition.label} ${definition.description}`);
  }

  /** @param {any} instance @param {any} definition @param {string} scope */
  function seedControl(instance, definition, scope) {
    return el('div', { class: 'field' }, [
      el('div', {
        class: 'field__label', text: 'Seed',
        title: 'Seeds drive determinism: the same seed always produces the same grain, particles and noise, so the preview and the export match frame for frame. Roll a new seed to reshuffle the pattern.',
      }),
      el('div', { class: 'field__control' }, [
        num('Seed', Number(instance.seed ?? 1), 1, 9999, (value) => write(`Change ${definition.label} seed`, () => { instance.seed = Math.round(value); }), {
          step: 1, decimals: 0, title: 'Seeds drive determinism: the same seed always renders the same pattern, in the preview and in the export.',
        }),
        diceButton('Roll a new seed', () => {
          store.edit(`Roll ${scope} seed`, () => { instance.seed = 1000 + Math.floor(Math.random() * 9000); });
          scheduleRender();
        }),
      ]),
    ]);
  }

  /** A `palette` parameter: colour inputs with add and remove. */
  function paletteControl(/** @type {any} */ instance, /** @type {any} */ spec, /** @type {any} */ definition) {
    const read = () => (Array.isArray(instance.params[spec.key]) ? instance.params[spec.key] : spec.default);
    const edit = (/** @type {(list:string[])=>void} */ mutate, /** @type {string} */ label) => write(label, () => {
      if (!Array.isArray(instance.params[spec.key])) instance.params[spec.key] = JSON.parse(JSON.stringify(spec.default));
      mutate(/** @type {string[]} */ (instance.params[spec.key]));
    });
    const row = el('div', { class: 'chip-row' }, read().map((colour, position) => el('span', { class: 'chip' }, [
      colorField({
        inline: true, value: colour,
        onChange: (value, committing) => {
          const key = `palette:${instance.id}:${position}`;
          if (state.dragging !== key) { state.dragging = key; beginAdjust(`Change ${spec.label}`); }
          edit((list) => { list[position] = value; }, `Change ${spec.label}`);
          if (committing) { state.dragging = null; endAdjust(); scheduleRender(); }
        },
      }),
      iconButton(ICONS.close, 'Remove this colour', () => {
        if (read().length <= 2) { store.notify('warn', 'A palette needs at least two colours.'); return; }
        edit((list) => { list.splice(position, 1); }, `Remove ${spec.label} colour`);
      }),
    ])));
    return el('div', { class: 'field field--stack' }, [
      el('div', { class: 'field__label', text: spec.label, title: `${definition.label} · ${spec.label}` }),
      row,
      smallButton('+ Colour', 'Append a colour to this palette', () => edit((list) => { list.push('#ffffff'); }, `Add ${spec.label} colour`)),
    ]);
  }

  /** A `points` parameter opens in the dock, which no rebuild detaches. */
  function curveControl(/** @type {any} */ instance, /** @type {any} */ spec, /** @type {any} */ definition) {
    const channel = `effects.${instance.id}.${spec.key}`;
    const open = state.curves.has(channel);
    return el('div', { class: 'field field--stack' }, [
      el('div', { class: 'field__label', text: spec.label, title: `${definition.label} · ${spec.label}` }),
      smallButton(open ? `Close ${spec.label} curve` : `Edit ${spec.label} curve`, 'A 5-point spline editor for this tone curve',
        () => (open ? closeCurveEditor(channel) : openCurveEditor(channel, instance, spec, definition))),
    ]);
  }

  /** @param {string} channel @param {any} instance @param {any} spec @param {any} definition */
  async function openCurveEditor(channel, instance, spec, definition) {
    const graph = await loadGraph();
    if (!graph?.openCurveEditor) {
      store.notify('warn', 'The curve editor is unavailable: web/ui/graph.js could not be loaded. Every other control on this effect still works.');
      return;
    }
    const entry = dockEntry(`${definition.label} · ${spec.label}`, () => closeCurveEditor(channel));
    const mount = el('div', { class: 'curve-editor' });
    entry.body.append(mount);
    const points = JSON.parse(JSON.stringify(Array.isArray(instance.params[spec.key]) ? instance.params[spec.key] : spec.default));
    const handle = graph.openCurveEditor({
      points, container: mount,
      onChange: (next) => write(`Change ${spec.label} curve`, () => { instance.params[spec.key] = next; }),
    });
    state.curves.set(channel, { entry: entry.wrap, handle });
    scheduleRender();
  }

  /** @param {string} channel */
  function closeCurveEditor(channel) {
    const open = state.curves.get(channel);
    if (!open) return;
    try { open.handle?.destroy?.(); } catch (error) { console.warn('[motion-lab] the curve editor failed to close cleanly', error); }
    open.entry.remove();
    state.curves.delete(channel);
    syncDock();
    scheduleRender();
  }

  /** Lazily imported, so a missing `graph.js` cannot break the panel. */
  let graphModule = /** @type {Promise<any>|null} */ (null);
  async function loadGraph() {
    if (!graphModule) graphModule = import('./graph.js').catch(() => null);
    const loaded = await graphModule;
    if (!loaded) graphModule = null; // allow a retry: the module may appear later
    return loaded;
  }

  /** Header + body wrapper for a docked editor. @param {string} title @param {() => void} onClose */
  function dockEntry(title, onClose) {
    const body = el('div', {});
    const wrap = el('div', { class: 'inspector-section' }, [
      el('div', { class: 'inspector-section__head' }, [
        el('span', { class: 'inspector-section__title', text: title }),
        iconButton(ICONS.close, 'Close this editor', onClose),
      ]),
      el('div', { class: 'inspector-section__body' }, [body]),
    ]);
    dock.append(wrap);
    syncDock();
    return { wrap, body };
  }
  function syncDock() { dock.classList.toggle('hidden', dock.childElementCount === 0); }

  /** Drop docked editors whose effect disappeared. @param {Clip|null} clip */
  function pruneGrowth(clip) {
    const live = new Set();
    if (clip) for (const instance of clip.effects.stack) {
      for (const spec of effectDefinition(instance.type).params) if (spec.kind === 'points') live.add(`effects.${instance.id}.${spec.key}`);
    }
    for (const channel of [...state.curves.keys()]) if (!live.has(channel)) closeCurveEditor(channel);
    if (state.graph && (!clip || clip.id !== state.graph.clipId)) closeGraphEditor();
    syncDock();
  }

  /** Key every animatable parameter of one effect, in a single undo step. */
  function keyEffectParams(/** @type {Clip} */ clip, /** @type {any} */ instance) {
    const label = effectDefinition(instance.type).label;
    const params = animatableParams(instance.type);
    if (params.length === 0) { store.notify('warn', `${label} has no numeric parameters to key.`); return; }
    store.edit(`Key ${label}`, () => {
      for (const spec of params) {
        const channel = `effects.${instance.id}.${spec.key}`;
        setKeyframe(clip, channel, store.playback.time, channelValue(clip, channel, store.playback.time, channelBaseValue(clip, channel)));
      }
    });
    invalidate(false);
    scheduleRender();
  }

  /* E. Masks: a list, plus the selected mask's keyframable geometry. */

  /** @param {Clip} clip */
  function masksSection(clip) {
    const rows = [el('div', { class: 'chip-row' }, [maskMenu(clip)])];
    const current = clip.masks.find((mask) => mask.id === store.ui.selectedMaskId) ?? clip.masks[0] ?? null;
    if (current && current.id !== store.ui.selectedMaskId) store.ui.selectedMaskId = current.id;
    if (clip.masks.length === 0) {
      rows.push(emptyState('No masks on this clip. A mask limits the layer to the shape you draw; feather softens its edge, and every mask property stays keyframable.'));
      return rows;
    }
    rows.push(el('div', { class: 'mask-list' }, clip.masks.map((mask) => el('div', {
      class: `mask-row${current && mask.id === current.id ? ' mask-row--selected' : ''}`,
      onclick: (event) => {
        if (/** @type {HTMLElement} */ (event.target).closest('button, input, label, .checkbox')) return;
        store.ui.selectedMaskId = mask.id;
        store.emit('selection');
      },
    }, [
      flagRow('', mask.enabled, (value) => write(value ? 'Enable mask' : 'Bypass mask', () => { mask.enabled = value; }), mask.enabled ? 'Bypass this mask' : 'Enable this mask'),
      el('span', { class: 'grow', text: mask.name, title: `${mask.name} — ${mask.shape}` }),
      el('span', { class: 'chip', text: mask.shape }),
      iconButton(ICONS.eye, mask.inverted ? 'Inverted: click to un-invert' : 'Invert this mask', () => write('Invert mask', () => { mask.inverted = !mask.inverted; }), `icon-btn${mask.inverted ? ' icon-btn--on' : ''}`),
      iconButton(ICONS.text, 'Rename this mask', async () => {
        const name = await promptDialog({ title: 'Rename mask', value: mask.name });
        if (name && name.trim()) write('Rename mask', () => { mask.name = name.trim(); });
      }),
      iconButton(ICONS.trash, 'Delete this mask', () => store.removeMask(clip.id, mask.id), 'icon-btn icon-btn--danger'),
    ]))));
    rows.push(el('div', { class: 'chip-row' }, [
      flagRow('Invert', current.inverted, (value) => write('Invert mask', () => { current.inverted = value; }), 'Keep what the mask covers instead of what it excludes'),
      flagRow('Enabled', current.enabled, (value) => write(value ? 'Enable mask' : 'Bypass mask', () => { current.enabled = value; })),
      button('Delete mask', 'btn btn--tiny btn--danger', { onclick: () => store.removeMask(clip.id, current.id) }),
    ]));
    for (const spec of maskChannelSpecs(current)) rows.push(channelSlider(clip, spec.id, { label: spec.label }));
    if (current.shape === 'rect') {
      rows.push(num('Roundness', current.roundness, 0, 1, (value) => write('Change mask roundness', () => { current.roundness = value; }), {
        decimals: 3, title: 'Corner rounding, as a fraction of the shorter side',
      }));
    }
    if (current.shape === 'polygon') {
      rows.push(kv('Polygon points', String(current.points.length)));
      rows.push(el('div', { class: 'chip-row' }, [
        smallButton('Simplify', 'Keep every other point (never below three)', () => simplifyPolygon(current)),
        smallButton('Add point', 'Insert a point at the middle of the longest edge', () => addPolygonPoint(current)),
      ]));
      rows.push(hint('info', 'Polygon points are stored in normalised layer space, 0..1 across the layer, so the outline keeps its shape at any output size.'));
    }
    return rows;
  }

  /** Keep every other point, never below three. @param {Mask} mask */
  function simplifyPolygon(mask) {
    if (mask.points.length <= 3) { store.notify('warn', 'This polygon already has the minimum of three points.'); return; }
    const thinned = mask.points.filter((_, index) => index % 2 === 0);
    if (thinned.length < 3) { store.notify('warn', 'Thinning this outline would leave fewer than three points, so it was left alone.'); return; }
    write('Simplify mask', () => { mask.points = thinned; });
  }

  /** Insert a point at the middle of the polygon's longest edge. @param {Mask} mask */
  function addPolygonPoint(mask) {
    if (mask.points.length < 2) { store.notify('warn', 'This polygon needs at least two points before another one can be inserted.'); return; }
    let longest = 0;
    let best = 0;
    for (let index = 0; index < mask.points.length; index += 1) {
      const a = mask.points[index];
      const b = mask.points[(index + 1) % mask.points.length];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length > longest) { longest = length; best = index; }
    }
    const a = mask.points[best];
    const b = mask.points[(best + 1) % mask.points.length];
    write('Add mask point', () => { mask.points.splice(best + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }); });
  }

  /* F. Keyframes, the channel sparklines, and the graph/easing tools. */

  /** @param {Clip} clip */
  function keyframesSection(clip) {
    const rows = [];
    const channels = clip.keyframes.filter((entry) => entry.keys.length > 0);
    rows.push(el('div', { class: 'chip-row' }, [
      smallButton('Key all transform properties', 'Position, scale, rotation and opacity at the playhead, in one undo step', () => {
        store.edit('Key transform properties', () => {
          for (const channel of TRANSFORM_TARGETS) setKeyframe(clip, channel, store.playback.time, channelValue(clip, channel, store.playback.time, channelBaseValue(clip, channel)));
        });
        invalidate(false);
        scheduleRender();
      }),
      smallButton('Copy keyframes', 'Copy every key at the playhead, or the whole graph channel when the playhead is empty', () => copyKeys(clip)),
      button('Paste keyframes', 'btn btn--tiny', {
        title: 'Paste the copied keys so the first one lands on the playhead',
        disabled: !store.clipboard.keyframes,
        onclick: () => pasteKeys(clip),
      }),
      ...(channels.length > 0 ? [button('Clear all', 'btn btn--tiny btn--danger', {
        title: 'Remove every keyframe on this clip',
        onclick: async () => {
          const ok = await confirmDialog({ title: 'Clear every keyframe?', message: `Remove all ${allKeyTimes(clip).length} keyframe moments from "${clip.name}"?`, confirmLabel: 'Clear', danger: true });
          if (!ok) return;
          store.edit('Clear keyframes', () => { clip.keyframes = []; });
        },
      })] : []),
    ]));
    rows.push(kv('Keys at playhead', String(keysAtTime(clip, store.playback.time).length)));
    rows.push(kv('Clipboard', store.clipboard.keyframes ? `${store.clipboard.keyframes.channels.length} channel(s)` : 'empty'));
    if (channels.length === 0) {
      rows.push(emptyState('Nothing is animated yet. Use the diamond next to any slider, or "Key all transform properties" to start.'));
      return rows;
    }
    for (const entry of channels) {
      rows.push(el('div', {
        class: 'field', title: entry.channel,
        onclick: (event) => {
          if (/** @type {HTMLElement} */ (event.target).closest('button')) return;
          store.ui.graphChannel = entry.channel;
          state.selectedKey = { channel: entry.channel, time: nearestKeyTime(clip, entry.channel) ?? 0 };
          scheduleRender();
        },
      }, [
        el('div', { class: 'field__label', text: labelFor(clip, entry.channel), title: entry.channel }),
        el('div', { class: 'field__control' }, [
          el('span', { class: 'chip', text: groupLabel(specFor(clip, entry.channel)?.group ?? 'effect') }),
          el('span', { class: 'chip', text: `${entry.keys.length}` }),
          sparkline(clip, entry.channel),
          iconButton(ICONS.trash, 'Remove this channel and its keys', () => write('Remove channel', () => {
            clip.keyframes = clip.keyframes.filter((candidate) => candidate.channel !== entry.channel);
          }), 'icon-btn icon-btn--danger'),
        ]),
      ]));
    }
    const options = specsFor(clip).map((spec) => ({ value: spec.id, label: `${groupLabel(spec.group)} · ${spec.label}` }));
    if (!specsFor(clip).some((spec) => spec.id === store.ui.graphChannel)) options.unshift({ value: store.ui.graphChannel, label: store.ui.graphChannel });
    rows.push(pickRow('Graph channel', options, store.ui.graphChannel, (value) => {
      store.ui.graphChannel = value;
      const nearest = nearestKeyTime(clip, value);
      state.selectedKey = nearest === null ? null : { channel: value, time: nearest };
      if (state.graph) { closeGraphEditor(); openGraphEditor(clip, value); }
      scheduleRender();
    }));
    rows.push(el('div', { class: 'chip-row' }, [
      smallButton(state.graph ? 'Close graph editor' : 'Open graph editor', 'Edit the selected channel as a curve with draggable keys',
        () => (state.graph ? closeGraphEditor() : openGraphEditor(clip, store.ui.graphChannel))),
    ]));
    rows.push(hint('info', 'The graph editor opens in the dock at the top of this panel, so it stays put while you keep editing.'));
    rows.push(...easingRows(clip, store.ui.graphChannel));
    return rows;
  }

  /** Copy the keys at the playhead, or the whole graph channel. @param {Clip} clip */
  function copyKeys(clip) {
    let selection = keysAtTime(clip, store.playback.time).map((key) => {
      const channel = clip.keyframes.find((entry) => entry.keys.includes(key))?.channel;
      return channel ? { channel, time: key.time } : null;
    }).filter(Boolean);
    if (selection.length === 0) selection = (findChannel(clip, store.ui.graphChannel)?.keys ?? []).map((key) => ({ channel: store.ui.graphChannel, time: key.time }));
    if (selection.length === 0) { store.notify('warn', 'There is nothing to copy: put the playhead on a keyframe, or animate the graph channel first.'); return; }
    store.clipboard.keyframes = copyKeyframes(clip, /** @type {any} */ (selection));
    store.notify('ok', `Copied ${selection.length} keyframe(s); pasting lands them on the playhead.`, { title: 'Keyframes' });
    scheduleRender();
  }

  /** @param {Clip} clip */
  function pasteKeys(clip) {
    const payload = store.clipboard.keyframes;
    if (!payload) { store.notify('warn', 'Copy some keyframes first.'); return; }
    let written = 0;
    store.edit('Paste keyframes', () => { written = pasteKeyframes(clip, payload, store.playback.time); });
    invalidate(false);
    scheduleRender();
    store.notify('ok', `Pasted ${written} keyframe(s) at ${formatNumber(store.playback.time, 2)}s.`, { title: 'Keyframes' });
  }

  /** Mini curve preview drawn from `evaluateChannel` samples of one channel. */
  function sparkline(/** @type {Clip} */ clip, /** @type {string} */ channel) {
    const canvas = el('canvas');
    const wrap = el('div', { class: 'graph-editor', style: { height: '26px', width: '100%', minWidth: '60px' } }, [canvas]);
    const base = channelBaseValue(clip, channel);
    const range = channelRange(clip, channel, base);
    const from = clip.start;
    const to = clip.start + clip.duration;
    requestAnimationFrame(() => {
      if (!canvas.isConnected) return;
      const height = 26;
      const ctx = fitCanvas(canvas, wrap, height);
      const width = canvas.clientWidth || 120;
      if (width < 4) return;
      const span = Math.max(1e-6, range.max - range.min);
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = 'rgba(92, 225, 255, 0.9)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let index = 0; index < 48; index += 1) {
        const time = from + ((to - from) * index) / 47;
        const value = evaluateChannel(clip, channel, time);
        const x = (index / 47) * width;
        const y = height - 2 - clamp01(((value === null ? base : value) - range.min) / span) * (height - 4);
        if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 61, 139, 0.95)';
      for (const key of findChannel(clip, channel)?.keys ?? []) ctx.fillRect(clamp01((key.time - from) / Math.max(1e-6, to - from)) * width - 0.75, 1, 1.5, height - 2);
    });
    return wrap;
  }

  /** Easing for the selected key: preset, four Bezier handles, live preview. */
  function easingRows(/** @type {Clip} */ clip, /** @type {string} */ channel) {
    const entry = findChannel(clip, channel);
    const key = selectedKeyOf(clip, channel);
    if (!entry || !key) return [hint('info', `${labelFor(clip, channel)} has no keys yet, so there is no segment to shape.`)];
    const rows = [
      pickRow('Selected key', entry.keys.map((candidate) => ({ value: String(candidate.time), label: `${formatNumber(candidate.time, 2)}s` })), String(key.time), (value) => {
        state.selectedKey = { channel, time: Number(value) };
        scheduleRender();
      }),
      pickRow('Easing', EASING_PRESETS.map((preset) => preset.name), key.ease?.name ?? 'Linear', (value) => write(`Change ${labelFor(clip, channel)} easing`, () => { key.ease = easingPreset(value); })),
    ];
    const bezier = key.ease?.bezier ?? { x1: 0, y1: 0, x2: 1, y2: 1 };
    const handle = (/** @type {string} */ label, /** @type {any} */ property, /** @type {number} */ min, /** @type {number} */ max) => num(
      label, Number(bezier[property] ?? 0), min, max,
      (value) => store.edit('Change Bezier handles', () => {
        key.ease = { kind: 'bezier', bezier: { x1: 0, y1: 0, x2: 1, y2: 1, ...(key.ease?.bezier ?? {}), [property]: value }, name: 'Custom' };
      }),
      { title: `${label} — easing describes the segment that starts at this key` },
    );
    rows.push(handle('Handle 1 X', 'x1', 0, 1), handle('Handle 1 Y', 'y1', -2, 2), handle('Handle 2 X', 'x2', 0, 1), handle('Handle 2 Y', 'y2', -2, 2));
    rows.push(el('div', { class: 'field' }, [el('div', { class: 'field__label', text: 'Segment curve' }), el('div', { class: 'field__control' }, [easingPreview(key)])]));
    rows.push(hint('info', 'Easing belongs to the key it starts from, and it shapes the segment up to the next key.'));
    return rows;
  }

  /** Small live plot of the selected segment's curve. @param {any} key */
  function easingPreview(key) {
    const canvas = el('canvas');
    const wrap = el('div', { class: 'graph-editor', style: { height: '84px', width: '100%' } }, [canvas]);
    requestAnimationFrame(() => {
      if (!canvas.isConnected) return;
      const height = 84;
      const ctx = fitCanvas(canvas, wrap, height);
      const width = canvas.clientWidth || 120;
      if (width < 4) return;
      const easing = key.ease ?? { kind: 'linear', bezier: { x1: 0, y1: 0, x2: 1, y2: 1 } };
      const plotWidth = width - 12;
      const plotHeight = height - 12;
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
      ctx.lineWidth = 1;
      ctx.strokeRect(6, 6, plotWidth, plotHeight);
      ctx.strokeStyle = 'rgba(92, 225, 255, 0.95)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let index = 0; index <= 40; index += 1) {
        const x = 6 + (index / 40) * plotWidth;
        const y = 6 + (1 - clamp01(applyEasing(easing, index / 40))) * plotHeight;
        if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 61, 139, 0.9)';
      ctx.fillRect(4, height - 8, 4, 4);
      ctx.fillRect(width - 8, 4, 4, 4);
    });
    return wrap;
  }

  /** `openGraphEditor({store, clip, channel, container})`, mounted in the dock. */
  async function openGraphEditor(/** @type {Clip} */ clip, /** @type {string} */ channel) {
    const graph = await loadGraph();
    if (!graph?.openGraphEditor) {
      store.notify('warn', 'The graph editor is unavailable: web/ui/graph.js could not be loaded. Keyframes can still be edited from the sliders and the easing controls.');
      return;
    }
    const entry = dockEntry(`Graph · ${labelFor(clip, channel)}`, () => closeGraphEditor());
    const mount = el('div', { class: 'graph-editor', style: { height: '190px' } });
    entry.body.append(mount);
    state.graph = { channel, clipId: clip.id, entry: entry.wrap, handle: graph.openGraphEditor({ store, clip, channel, container: mount }) };
    store.ui.graphOpen = true;
    scheduleRender();
  }

  function closeGraphEditor() {
    if (!state.graph) return;
    try { state.graph.handle?.destroy?.(); } catch (error) { console.warn('[motion-lab] the graph editor failed to close cleanly', error); }
    state.graph.entry.remove();
    state.graph = null;
    store.ui.graphOpen = false;
    syncDock();
    scheduleRender();
  }

  /* G. Source, by clip kind. */

  /** @param {Clip} clip */
  function sourceSection(clip) {
    switch (clip.kind) {
      case 'text': return textSource(clip);
      case 'graphic': return graphicSource(clip);
      case 'image':
      case 'video': return mediaSource(clip);
      case 'audio': return audioSource(clip);
      case 'adjustment': return adjustmentSource(clip);
      case 'nested': return nestedSource(clip);
      default: return [hint('warn', `No source controls for a "${clip.kind}" clip.`)];
    }
  }

  /** @param {Clip} clip */
  function textSource(clip) {
    const style = clip.text ?? defaultTextStyle();
    const set = (/** @type {string} */ key, /** @type {any} */ value) => write('Change text', () => {
      if (!clip.text) clip.text = defaultTextStyle();
      clip.text[key] = value;
    });
    const area = el('textarea', {
      class: 'text-input', rows: '3', value: style.content, placeholder: 'Type the text',
      style: { width: '100%', height: 'auto', resize: 'vertical', lineHeight: '1.4' },
    });
    area.addEventListener('change', () => set('content', area.value));
    const rows = [el('div', { class: 'field field--stack' }, [el('div', { class: 'field__label', text: 'Content' }), area])];
    rows.push(pickRow('Font', TEXT_FONTS.map((font) => ({ value: font, label: font.split(',')[0].replace(/"/g, '') })), TEXT_FONTS.includes(style.fontFamily) ? style.fontFamily : TEXT_FONTS[0], (value) => set('fontFamily', value)));
    for (const [key, label, min, max, step, unit, decimals] of TEXT_NUMBERS) {
      rows.push(num(label, Number(style[key] ?? 0), min, key === 'maxWidth' ? store.doc.composition.width : max, (value) => set(key, value), {
        step, unit, decimals, title: key === 'maxWidth' ? 'Wrap width in composition pixels — 0 means no wrapping' : label,
      }));
    }
    rows.push(pickRow('Weight', TEXT_WEIGHTS.map(String), String(TEXT_WEIGHTS.includes(style.fontWeight) ? style.fontWeight : 400), (value) => set('fontWeight', Number(value))));
    rows.push(flagRow('Italic', Boolean(style.italic), (value) => set('italic', value)));
    rows.push(pickRow('Align', TEXT_ALIGNS, TEXT_ALIGNS.includes(style.align) ? style.align : 'center', (value) => set('align', value)));
    rows.push(pickRow('Baseline', TEXT_BASELINES, TEXT_BASELINES.includes(style.baseline) ? style.baseline : 'middle', (value) => set('baseline', value)));
    rows.push(hint('info', 'Max width 0 turns wrapping off entirely; any other value wraps at that width in composition pixels.'));
    rows.push(flagRow('Uppercase', Boolean(style.uppercase), (value) => set('uppercase', value)));
    rows.push(colorControl({ label: 'Colour', value: style.color, apply: (value) => set('color', value) }));
    rows.push(flagRow('Gradient fill', Boolean(style.gradientFrom), (value) => write(value ? 'Enable text gradient' : 'Disable text gradient', () => {
      if (!clip.text) clip.text = defaultTextStyle();
      if (value) {
        clip.text.gradientFrom = clip.text.gradientFrom ?? clip.text.color;
        clip.text.gradientTo = clip.text.gradientTo ?? '#5ce1ff';
      } else {
        delete clip.text.gradientFrom;
        delete clip.text.gradientTo;
      }
    }), 'Fill the glyphs with a vertical gradient instead of a flat colour'));
    if (style.gradientFrom) {
      rows.push(colorControl({ label: 'Gradient from', value: style.gradientFrom, apply: (value) => set('gradientFrom', value) }));
      rows.push(colorControl({ label: 'Gradient to', value: style.gradientTo ?? '#5ce1ff', apply: (value) => set('gradientTo', value) }));
    }
    rows.push(colorControl({ label: 'Stroke colour', value: style.strokeColor ?? '#000000', apply: (value) => set('strokeColor', value) }));
    rows.push(colorControl({ label: 'Shadow colour', value: style.shadowColor ?? '#000000', apply: (value) => set('shadowColor', value) }));
    rows.push(el('div', { class: 'chip-row' }, [
      smallButton('Reset style', 'Back to the default text style, keeping the words', () => write('Reset text style', () => {
        const content = clip.text?.content ?? defaultTextStyle().content;
        const align = clip.text?.align;
        clip.text = defaultTextStyle();
        clip.text.content = content;
        if (align) clip.text.align = align;
      })),
    ]));
    return rows;
  }

  /** @param {Clip} clip */
  function graphicSource(clip) {
    const graphic = clip.graphic ?? defaultGraphic();
    const kind = GRAPHIC_KINDS.includes(graphic.kind) ? graphic.kind : GRAPHIC_KINDS[0];
    const set = (/** @type {string} */ key, /** @type {any} */ value) => write('Change graphic', () => {
      if (!clip.graphic) clip.graphic = defaultGraphic();
      clip.graphic[key] = value;
    }, { rebuild: true });
    const rows = [
      pickRow('Source', [...GRAPHIC_KINDS, ...(GRAPHIC_KINDS.includes(graphic.kind) ? [] : [graphic.kind])], kind, (value) => set('kind', value)),
      el('div', { class: 'field' }, [
        el('div', { class: 'field__label', text: 'Seed', title: 'Seeds drive determinism: procedural sources hash the seed rather than calling Math.random(), so the preview and the export are identical.' }),
        el('div', { class: 'field__control' }, [
          num('Seed', Number(graphic.seed ?? 1), 1, 9999, (value) => set('seed', Math.round(value)), { step: 1, decimals: 0, title: 'The same seed always lays out the same field; roll a new one to reshuffle it.' }),
          diceButton('Roll a new seed', () => set('seed', 1000 + Math.floor(Math.random() * 9000))),
        ]),
      ]),
      colorControl({ label: 'Colour A', value: graphic.colorA, apply: (value) => set('colorA', value) }),
      colorControl({ label: 'Colour B', value: graphic.colorB, apply: (value) => set('colorB', value) }),
      colorControl({ label: 'Colour C', value: graphic.colorC ?? '#ffd166', apply: (value) => set('colorC', value) }),
    ];
    for (const key of GRAPHIC_KIND_PARAMS[kind] ?? []) {
      const spec = GRAPHIC_PARAMS[key];
      if (key === 'shapeKind') rows.push(pickRow('Shape', SHAPE_KINDS, SHAPE_KINDS.includes(graphic.shapeKind) ? graphic.shapeKind : 'circle', (value) => set('shapeKind', value)));
      else if (key === 'gradientKind') rows.push(pickRow('Gradient type', GRADIENT_KINDS, GRADIENT_KINDS.includes(graphic.gradientKind) ? graphic.gradientKind : 'linear', (value) => set('gradientKind', value)));
      else if (key === 'mirror') rows.push(flagRow('Mirror', graphic.mirror !== false, (value) => set('mirror', value)));
      else if (key === 'text') rows.push(textField({ label: 'Label', value: graphic.text ?? '', placeholder: 'Optional caption', onChange: (value) => set('text', value) }));
      else if (spec) rows.push(num(spec[0], Number(graphic[key] ?? 0), spec[1], spec[2], (value) => set(key, value), { step: spec[3], unit: spec[4], decimals: spec[5] }));
    }
    rows.push(hint('info', GRAPHIC_KIND_NOTES[kind] ?? 'Only the parameters this source reads are shown.'));
    rows.push(el('div', { class: 'chip-row' }, [
      smallButton('Reset source', 'Back to the registry defaults for this kind', () => write('Reset graphic', () => { clip.graphic = defaultGraphic(clip.graphic?.kind ?? 'gradient'); }, { rebuild: true })),
    ]));
    return rows;
  }

  /** @param {Clip} clip */
  function mediaSource(clip) {
    const asset = assetFor(clip);
    const rows = [
      kv('Asset', asset?.name ?? '— no media linked —'),
      kv('Dimensions', asset && asset.width ? `${asset.width} × ${asset.height}` : '—'),
      kv('Duration', asset && asset.duration ? `${formatNumber(asset.duration, 2)}s` : clip.kind === 'image' ? 'still image' : '—'),
      kv('File', asset?.fileName ?? '—'),
    ];
    if (asset?.status && asset.status !== 'ok') rows.push(hint('warn', `This asset reports "${asset.status}"${asset.statusDetail ? `: ${asset.statusDetail}` : '.'}`));
    if (!clip.assetId) rows.push(hint('warn', 'This media slot is empty. Choose a photo or video, or drop one on the clip in the timeline: the clip keeps its timing, effects and keyframes.'));
    const fileInput = el('input', { type: 'file', class: 'hidden', accept: clip.assetId ? 'image/*,video/*,audio/*' : 'image/*,video/*' });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      if (!clip.assetId) {
        // An empty slot: import the file and put it in the slot.
        try {
          const [asset] = await media.importFiles([file]);
          if (!asset || !store.fillMediaSlot(clip.id, asset)) store.notify('warn', 'Only a photo or a video can go in this slot.');
        } finally {
          fileInput.value = '';
        }
        return;
      }
      try {
        await api.replaceAssetFile(clip.assetId, file);
        store.notify('ok', `Replaced the file behind "${asset?.name ?? clip.assetId}". Every clip using it now points at the new media.`, { title: 'Media' });
        store.emit('library');
        preview?.invalidate?.(true);
      } catch (error) {
        store.notify('error', `The file could not be replaced: ${error instanceof Error ? error.message : error}`, { title: 'Media' });
      } finally {
        fileInput.value = '';
      }
    });
    rows.push(el('div', { class: 'chip-row' }, [
      button(clip.assetId ? 'Replace file' : 'Choose file...', 'btn btn--tiny', {
        title: clip.assetId ? 'Swap the media behind this clip without touching the timeline' : 'Put a photo or video in this empty slot',
        disabled: clip.assetId ? typeof api?.replaceAssetFile !== 'function' : typeof media?.importFiles !== 'function',
        onclick: () => fileInput.click(),
      }),
      fileInput,
    ]));
    rows.push(flagRow('Reverse', Boolean(clip.reverse), (value) => write(value ? 'Reverse clip' : 'Play clip forwards', () => { clip.reverse = value; }), 'Play the source backwards inside the clip'));
    rows.push(num('Playback rate', Number(clip.playbackRate ?? 1), 0.25, 4, (value) => write('Change playback rate', () => { clip.playbackRate = value; }), { unit: '×', title: 'Source speed inside the clip; the clip keeps its timeline length' }));
    rows.push(hint('info', 'Reverse and playback rate change how the source is sampled; they never change the clip\'s place on the timeline.'));
    return rows;
  }

  /** @param {Clip} clip */
  function audioSource(clip) {
    const asset = assetFor(clip);
    const rows = [
      kv('Asset', asset?.name ?? '— no audio linked —'),
      kv('Duration', asset?.duration ? `${formatNumber(asset.duration, 2)}s` : '—'),
      kv('Analysed', store.doc.audio[clip.assetId ?? ''] ? 'yes' : 'not yet'),
    ];
    for (const [key, label, min, max, step, unit, decimals] of AUDIO_NUMBERS) {
      rows.push(num(label, Number(clip[key] ?? 0), min, key.startsWith('fade') ? Math.max(0.1, clip.duration) : max, (value) => write(`Change ${label.toLowerCase()}`, () => { clip[key] = value; }), {
        step, unit, decimals, title: key === 'pan' ? '−1 hard left, 0 centre, +1 hard right' : label,
      }));
    }
    if (asset && !store.doc.audio[asset.id]) rows.push(hint('info', 'Analyse this audio in the Audio analysis panel below to unlock onsets, beats and audio connections.'));
    return rows;
  }

  /** @param {Clip} clip */
  function adjustmentSource(clip) {
    const rows = [hint('info', 'An adjustment layer has no media of its own: it filters every visual layer beneath it in the composition, in track order.'), kv('Effects in stack', String(clip.effects.stack.length))];
    if (clip.effects.stack.length === 0) {
      rows.push(emptyState('This adjustment layer is empty. Add an effect from the Effects section to make it do something.'));
      return rows;
    }
    for (const instance of clip.effects.stack) rows.push(kv(effectDefinition(instance.type).label, instance.enabled ? 'active' : 'bypassed'));
    return rows;
  }

  /** @param {Clip} clip */
  function nestedSource(clip) {
    const nested = store.doc.compositions.find((entry) => entry.id === clip.compositionId) ?? null;
    const rows = [
      kv('Composition', nested?.name ?? '— missing —'),
      kv('Internal duration', nested ? `${formatNumber(nested.composition.duration, 2)}s` : '—'),
      kv('Clips inside', nested ? String(nested.clips.length) : '—'),
      kv('Tracks inside', nested ? String(nested.tracks.length) : '—'),
    ];
    if (!nested) {
      rows.push(hint('warn', 'The nested composition this clip references is missing, so the clip renders nothing. Delete the clip, or nest the clips again.'));
      return rows;
    }
    rows.push(el('div', { class: 'chip-row' }, [
      smallButton('Edit contents', 'Nested timelines live in the Timeline panel', () =>
        store.notify('info', `A nested timeline is edited in the Timeline panel: select "${clip.name}" there and work inside its contents.`, { title: 'Nested composition' })),
    ]));
    rows.push(hint('info', 'Everything inside a nested composition renders first; then this clip\'s own transform, masks and effects apply to the result.'));
    return rows;
  }

  /* H. Audio connections: the whole composition's mapping list. */

  function connectionsSection() {
    const rows = [];
    const audioAssets = store.doc.assets.filter((asset) => asset.kind === 'audio' && store.doc.audio[asset.id]);
    const targets = targetChannels();
    rows.push(el('div', { class: 'chip-row' }, [
      button('+ Add connection', 'btn btn--tiny', {
        title: 'Drive a channel from an analysed audio signal',
        disabled: audioAssets.length === 0,
        onclick: () => addConnection(audioAssets, targets),
      }),
      button('Suggest from onsets', 'btn btn--tiny', {
        title: 'One onset trigger on opacity and one beat trigger on scale',
        disabled: audioAssets.length === 0,
        onclick: () => suggestConnections(audioAssets, targets),
      }),
    ]));
    if (audioAssets.length === 0) rows.push(hint('warn', 'No analysed audio yet. Select an audio asset and analyse it in the panel below — a connection needs an analysis to read.'));
    rows.push(hint('info', 'Detected onsets are suggestions, not necessarily musical beats: an onset is any sharp energy jump, including a lyric or a door slam. Trust your ears over the markers.'));
    if (store.doc.mappings.length === 0) {
      rows.push(emptyState('No audio connections. A connection reads one band of one analysed track and drives any numeric channel of any clip.'));
      return rows;
    }
    for (const mapping of store.doc.mappings) rows.push(mappingCard(mapping, audioAssets, targets));
    return rows;
  }

  /** Every channel an audio connection may drive, across every clip. */
  function targetChannels() {
    const list = [];
    for (const clip of store.doc.clips) {
      for (const spec of audioTargetableChannels(specsFor(clip))) list.push({ id: spec.id, label: `${clip.name} · ${spec.label}`, clipId: clip.id, spec });
    }
    return list;
  }

  /** @param {any[]} audioAssets @param {Array<any>} targets */
  function addConnection(audioAssets, targets) {
    const source = audioAssets[0];
    if (!source) { store.notify('warn', 'Analyse an audio file first — a connection needs a signal to read.'); return; }
    const target = targets[0] ?? { id: 'transform.scale.x', label: 'Scale X', clipId: null, spec: { base: 1, min: 0, max: 6 } };
    store.addMapping(createMapping(source.id, target.id, {
      name: `${source.name} → ${target.label}`, band: 'low', clipId: target.clipId ?? undefined, ...suggestRange(target.spec, 'low'),
    }));
    store.notify('ok', `Connected "${source.name}" (low band) to ${target.label}. Tune the range below to taste.`, { title: 'Audio connection' });
  }

  /** @param {any[]} audioAssets @param {Array<any>} targets */
  function suggestConnections(audioAssets, targets) {
    const source = audioAssets[0];
    if (!source) { store.notify('warn', 'Analyse an audio file first — a suggestion needs a signal to read.'); return; }
    const opacity = targets.find((entry) => entry.id === 'transform.opacity') ?? { id: 'transform.opacity', label: 'Opacity', clipId: null, spec: { base: 1, min: 0, max: 1 } };
    const scale = targets.find((entry) => entry.id === 'transform.scale.x') ?? { id: 'transform.scale.x', label: 'Scale X', clipId: null, spec: { base: 1, min: 0, max: 6 } };
    store.addMapping(createMapping(source.id, opacity.id, {
      name: `Onsets → ${opacity.label}`, band: 'onset', clipId: opacity.clipId ?? undefined,
      ...suggestRange({ base: 1, min: 0, max: 1 }, 'onset'), attack: 0.005, release: 0.22,
    }));
    store.addMapping(createMapping(source.id, scale.id, {
      name: `Beats → ${scale.label}`, band: 'beat', clipId: scale.clipId ?? undefined,
      ...suggestRange(scale.spec, 'beat'), attack: 0.01, release: 0.3,
    }));
    store.notify('ok', 'Added an onset → opacity and a beat → scale connection. Detected onsets are suggestions: they mark energy jumps, which are not always musical beats.', { title: 'Suggested connections' });
  }

  /** @param {AudioMapping} mapping @param {any[]} audioAssets @param {Array<any>} targets */
  function mappingCard(mapping, audioAssets, targets) {
    const card = el('div', { class: `mapping-card${mapping.enabled ? '' : ' mapping-card--disabled'}` });
    card.append(el('div', { class: 'mapping-card__head' }, [
      flagRow('', mapping.enabled, (value) => store.updateMapping(mapping.id, { enabled: value }), mapping.enabled ? 'Disable this connection' : 'Enable this connection'),
      textField({ inline: true, value: mapping.name, onChange: (value) => store.updateMapping(mapping.id, { name: String(value).trim() || 'Connection' }) }),
      iconButton(ICONS.trash, 'Remove this connection', () => store.removeMapping(mapping.id), 'icon-btn icon-btn--danger'),
    ]));
    card.append(pickRow('Source', [{ value: '', label: 'No audio' }, ...audioAssets.map((asset) => ({ value: asset.id, label: asset.name }))], audioAssets.some((asset) => asset.id === mapping.source) ? mapping.source : '', (value) => store.updateMapping(mapping.id, { source: value })));
    card.append(pickRow('Band', BAND_CHOICES.map((choice) => ({ value: choice.value, label: choice.label })), mapping.band, (value) => store.updateMapping(mapping.id, { band: value })));
    const targetOptions = targets.map((entry) => ({ value: entry.id, label: entry.label }));
    if (!targetOptions.some((entry) => entry.value === mapping.target)) targetOptions.unshift({ value: mapping.target, label: `${mapping.target} (no matching clip)` });
    card.append(pickRow('Target', targetOptions, mapping.target, (value) => store.updateMapping(mapping.id, { target: value })));
    card.append(pickRow('Applies to', [{ value: '', label: 'All clips' }, ...store.doc.clips.map((clip) => ({ value: clip.id, label: clip.name }))], mapping.clipId ?? '', (value) => store.updateMapping(mapping.id, { clipId: value || undefined })));
    card.append(mappingSlider(mapping, 'sensitivity', 'Sensitivity', 0, 4, 0.01, 2));
    card.append(mappingSlider(mapping, 'min', 'Output min', -2, 4, 0.01, 3));
    card.append(mappingSlider(mapping, 'max', 'Output max', -2, 8, 0.01, 3));
    card.append(mappingSlider(mapping, 'smoothing', 'Smoothing', 0, 0.98, 0.01, 2));
    card.append(mappingSlider(mapping, 'attack', 'Attack', 0.001, 1, 0.001, 3));
    card.append(mappingSlider(mapping, 'release', 'Release', 0.001, 3, 0.001, 3));
    card.append(pickRow('Mode', [
      { value: 'set', label: 'set — replace the value' },
      { value: 'add', label: 'add — offset the value' },
      { value: 'multiply', label: 'multiply — scale the value' },
    ], mapping.mode ?? 'set', (value) => store.updateMapping(mapping.id, { mode: value })));
    card.append(flagRow('Invert', Boolean(mapping.invert), (value) => store.updateMapping(mapping.id, { invert: value }), 'Flip the control signal before it is mapped'));
    const rawFill = el('div', { class: 'progress__fill', style: { background: 'var(--accent-4)' } });
    const outFill = el('div', { class: 'progress__fill' });
    const readout = el('span', { class: 'kv__v', text: '0 → 0' });
    card.append(el('div', { class: 'field' }, [
      el('div', { class: 'field__label', text: 'Raw signal' }),
      el('div', { class: 'field__control' }, [el('div', { class: 'progress', style: { width: '100%' } }, [rawFill])]),
    ]));
    card.append(el('div', { class: 'field' }, [
      el('div', { class: 'field__label', text: 'Output' }),
      el('div', { class: 'field__control' }, [el('div', { class: 'progress', style: { width: '100%' } }, [outFill]), readout]),
    ]));
    card.append(hint('info', 'The meter reads the same per-frame lookup table the renderer uses, so it shows exactly what the frame at the playhead is driven with.'));
    state.meters.push({ id: mapping.id, rawFill, outFill, readout, min: Number(mapping.min ?? 0), max: Number(mapping.max ?? 1) });
    return card;
  }

  /** @param {AudioMapping} mapping @param {string} key @param {string} label */
  function mappingSlider(mapping, key, label, min, max, step, decimals) {
    const dragKey = `mapping:${mapping.id}:${key}`;
    return slider({
      label, min, max, step, decimals,
      value: Number(/** @type {any} */ (mapping)[key] ?? 0),
      onInput: (value) => {
        if (state.dragging !== dragKey) { state.dragging = dragKey; beginAdjust(`Change ${label}`); }
        store.updateMapping(mapping.id, { [key]: value }, { coalesce: true });
      },
      onCommit: () => {
        if (state.dragging !== dragKey) return;
        state.dragging = null;
        endAdjust();
        scheduleRender();
      },
    });
  }

  /** Repaint every live mapping meter at the playhead. */
  function updateMeters() {
    if (state.meters.length === 0) return;
    const fps = store.doc.composition.fps;
    const start = store.doc.exportRange.in;
    const time = store.playback.time;
    const curves = store.modulationCurves();
    for (const meter of state.meters) {
      const mapping = store.doc.mappings.find((entry) => entry.id === meter.id);
      const curve = curves.find((entry) => entry.id === meter.id);
      const raw = curve ? clamp01(curveRawAt(curve, time, fps, start)) : mapping ? clamp01(rawSignal(store.doc, mapping, time)) : 0;
      meter.rawFill.style.width = `${Math.round(raw * 100)}%`;
      if (!curve) {
        meter.outFill.style.width = '0%';
        meter.readout.textContent = `${formatValue(raw, 2)} → —`;
        continue;
      }
      const value = curveValueAt(curve, time, fps, start);
      const span = meter.max - meter.min;
      meter.outFill.style.width = `${Math.round((Math.abs(span) > 1e-6 ? clamp01((value - meter.min) / span) : clamp01(value)) * 100)}%`;
      meter.readout.textContent = `${formatValue(raw, 2)} → ${formatValue(value, 2)}`;
    }
  }

  /* I. Audio analysis: waveform, bands, onsets, beats, tempo. */

  /** The audio asset to describe: the selected audio clip's, else the selected asset's. */
  function analysisTarget() {
    const clip = clipNow();
    if (clip?.kind === 'audio' && clip.assetId) return { assetId: clip.assetId, asset: assetFor(clip) };
    for (const id of store.ui.selectedAssetIds ?? []) {
      const asset = store.doc.assets.find((entry) => entry.id === id);
      if (asset?.kind === 'audio') return { assetId: id, asset };
    }
    return null;
  }

  function analysisSection() {
    const target = analysisTarget();
    if (!target) return [emptyState('Select an audio clip, or an audio asset in the Media panel, to see its waveform, bands, onsets and tempo here.')];
    const analysis = store.doc.audio[target.assetId];
    if (!analysis) {
      const progressFill = el('div', { class: 'progress__fill' });
      const progressLabel = el('div', { class: 'hint', text: 'Not analysed yet.' });
      return [
        kv('Asset', target.asset?.name ?? target.assetId),
        kv('Analysis', 'not run'),
        button('Analyse audio', 'btn btn--primary', {
          title: 'Decode and analyse this file in the browser',
          onclick: async () => {
            if (typeof media?.ensureAnalysis !== 'function') { progressLabel.textContent = 'The media engine is unavailable, so this file cannot be analysed.'; return; }
            try {
              await media.ensureAnalysis(target.assetId, (stage, progress) => {
                progressFill.style.width = `${Math.round(clamp01(progress) * 100)}%`;
                progressLabel.textContent = `${stage}…`;
              });
              store.notify('ok', `Analysed "${target.asset?.name ?? target.assetId}".`, { title: 'Analysis' });
            } catch (error) {
              progressLabel.textContent = `Analysis failed: ${error instanceof Error ? error.message : error}`;
            }
            scheduleRender();
          },
        }),
        el('div', { class: 'progress', style: { width: '100%' } }, [progressFill]),
        progressLabel,
      ];
    }
    const canvas = el('canvas', { class: 'analysis-canvas' });
    const wrap = el('div', {}, [canvas]);
    requestAnimationFrame(() => drawAnalysis(canvas, analysis));
    const weak = Number(analysis.tempoConfidence) < LOW_CONFIDENCE;
    return [
      wrap,
      el('div', { class: 'chip-row' }, ANALYSIS_BANDS.map((band) => el('span', { class: 'chip', text: band.label }))),
      kv('Frames', String(analysis.frames)),
      kv('Hop', `${formatNumber(analysis.hopSeconds * 1000, 1)} ms`),
      kv('Tempo', analysis.tempo ? `${formatNumber(analysis.tempo, 1)} BPM` : 'no confident estimate'),
      kv('Tempo confidence', `${formatValue(clamp01(analysis.tempoConfidence), 2)} / 1`),
      kv('Onsets', String(analysis.onsets.length)),
      kv('Beat markers', String(markerTimes(store.doc, target.assetId).length)),
      kv('Manual markers', String(store.doc.audioSettings.manualMarkers.length)),
      hint(weak ? 'warn' : 'info', weak
        ? 'The tempo estimate is weak — treat the suggested markers as a starting point, not as the track\'s real beat.'
        : 'Markers are suggestions from onset energy; a tempo is only reported when the autocorrelation peak is clear.'),
      el('div', { class: 'chip-row' }, [
        smallButton('Add marker at playhead', 'Place a marker yourself, at the playhead', () => {
          store.addMarker(store.playback.time);
          store.notify('ok', `Marker added at ${formatNumber(store.playback.time, 2)}s.`, { title: 'Markers' });
        }),
        button('Clear manual markers', 'btn btn--tiny btn--danger', {
          title: 'Remove only the markers you added by hand',
          disabled: store.doc.audioSettings.manualMarkers.length === 0,
          onclick: () => {
            const count = store.doc.audioSettings.manualMarkers.length;
            store.edit('Clear manual markers', () => { store.doc.audioSettings.manualMarkers = []; });
            store.emit('analysis');
            store.notify('ok', `Removed ${count} manual marker(s); detected markers are untouched.`, { title: 'Markers' });
          },
        }),
        smallButton('Re-analyse', 'Drop the stored analysis and analyse the file again', async () => {
          try {
            store.edit('Clear audio analysis', () => { delete store.doc.audio[target.assetId]; });
            store.invalidateMappings();
            await media.ensureAnalysis(target.assetId);
            store.notify('ok', 'Analysis refreshed.', { title: 'Analysis' });
          } catch (error) {
            store.notify('error', `Analysis failed: ${error instanceof Error ? error.message : error}`, { title: 'Analysis' });
          }
          scheduleRender();
        }),
      ]),
    ];
  }

  /** Waveform, band envelopes, onsets and beat markers on one canvas. */
  function drawAnalysis(/** @type {HTMLCanvasElement} */ canvas, /** @type {any} */ analysis) {
    const wrap = /** @type {HTMLElement} */ (canvas.parentElement);
    if (!wrap || !canvas.isConnected) return;
    const height = 132;
    const ctx = fitCanvas(canvas, wrap, height);
    const width = canvas.clientWidth || 240;
    if (width < 8) return;
    const duration = Math.max(1e-3, analysis.duration);
    const x = (/** @type {number} */ time) => clamp01(time / duration) * width;
    ctx.clearRect(0, 0, width, height);

    // Waveform: interleaved min/max pairs, -1..1.
    const waveform = analysis.waveform ?? [];
    const buckets = Math.floor(waveform.length / 2);
    if (buckets > 0) {
      ctx.strokeStyle = 'rgba(190, 200, 220, 0.32)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let bucket = 0; bucket < buckets; bucket += 1) {
        const px = (bucket / Math.max(1, buckets - 1)) * width;
        ctx.moveTo(px, height / 2 - waveform[bucket * 2 + 1] * (height / 2) * 0.92);
        ctx.lineTo(px, height / 2 - waveform[bucket * 2] * (height / 2) * 0.92);
      }
      ctx.stroke();
    }
    // Band envelopes.
    const hop = Number(analysis.hopSeconds) > 0 ? Number(analysis.hopSeconds) : duration / Math.max(1, analysis.frames);
    for (const band of ANALYSIS_BANDS) {
      const data = /** @type {any} */ (analysis)[band.key];
      if (!Array.isArray(data) || data.length < 2) continue;
      ctx.strokeStyle = band.color;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      for (let index = 0; index < data.length; index += 1) {
        const px = ((index * hop) / duration) * width;
        if (px > width) break;
        const py = height - clamp01(data[index]) * (height - 6) - 3;
        if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    // Onsets along the bottom, beat markers along the top.
    ctx.strokeStyle = 'rgba(92, 225, 255, 0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const onset of analysis.onsets ?? []) {
      ctx.moveTo(x(onset), height - 9);
      ctx.lineTo(x(onset), height);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 61, 139, 0.9)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (const mark of markerTimes(store.doc, analysis.assetId)) {
      if (mark < 0 || mark > duration) continue;
      ctx.moveTo(x(mark), 0);
      ctx.lineTo(x(mark), 7);
    }
    ctx.stroke();
    // Manual markers in amber, never to be confused with suggestions.
    ctx.strokeStyle = 'rgba(255, 209, 102, 0.95)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (const manual of store.doc.audioSettings.manualMarkers) {
      if (manual < 0 || manual > duration) continue;
      ctx.moveTo(x(manual), 0);
      ctx.lineTo(x(manual), height);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // Playhead.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(store.playback.time), 0);
    ctx.lineTo(x(store.playback.time), height);
    ctx.stroke();
  }

  /* Assembly: collapsible sections over a persistent dock. */

  /** @param {Clip|null} clip */
  function body(clip) {
    const nodes = [header(clip)];
    const addSection = (/** @type {string} */ key, /** @type {string} */ title, /** @type {() => HTMLElement[]} */ build) => {
      nodes.push(section({
        title,
        open: state.open[key],
        onToggle: () => { state.open[key] = !state.open[key]; render(); },
        children: state.open[key] ? build() : [],
      }));
    };
    if (clip) {
      addSection('transform', 'Transform', () => transformSection(clip));
      addSection('blend', 'Blend & compositing', () => blendSection(clip));
      addSection('effects', `Effects${clip.effects.stack.length ? ` (${clip.effects.stack.length})` : ''}`, () => effectsSection(clip));
      addSection('masks', `Masks${clip.masks.length ? ` (${clip.masks.length})` : ''}`, () => masksSection(clip));
      addSection('keyframes', `Keyframes & graph (${clip.keyframes.length})`, () => keyframesSection(clip));
      addSection('source', `Source · ${clip.kind}`, () => sourceSection(clip));
    }
    addSection('audio', `Audio connections (${store.doc.mappings.length})`, () => connectionsSection());
    addSection('analysis', 'Audio analysis', () => analysisSection());
    return nodes;
  }

  return { root, render, scheduleRender };
}
