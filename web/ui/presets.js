/**
 * Presets: saving, listing, previewing and applying reusable pieces of a project.
 *
 * A preset is a plain record on the document (`doc.presets`) with a `kind` that
 * decides what its `data` holds:
 *
 *   effect-stack   a clip's whole effect stack
 *   animation      a clip's keyframes, normalised to start at 0, plus its base transform
 *   audio-mapping  the document's audio connections
 *   template       a whole project document
 *   graphic        one procedural graphic spec
 *
 * Two properties matter and are deliberately enforced here:
 *
 *  - **Fresh ids on apply.** A saved stack or connection is a *recipe*. Applying
 *    it mints new effect/mapping ids, so two clips can carry the same look
 *    without sharing an id -- which would otherwise make keyframe channels,
 *    selection and undo ambiguous.
 *  - **Animation is anchored to the clip, not the timeline.** Keyframes are
 *    stored as offsets from the first key and applied relative to the target
 *    clip's `start`, so an animation preset lands where the clip actually is.
 */

import { BAND_CHOICES } from '/core/audio.js';
import { setTransformBase, transformBase } from '/core/channels.js';
import { effectDefinition } from '/core/effectRegistry.js';
import { drawGraphicThumbnail } from '/core/graphics.js';
import { easingPreset, evaluateKeys, pruneOrphanChannels, setKeyframe } from '/core/keyframes.js';
import { renderFrameToCanvas } from '/core/render.js';
import { defaultGraphic, uid } from '/core/schema.js';
import {
  button, confirmDialog, el, emptyState, hint, iconButton, ICONS, promptDialog,
} from './dom.js';

/** @typedef {import('/core/schema.js').Preset} Preset */
/** @typedef {import('/core/schema.js').Clip} Clip */
/** @typedef {import('/core/schema.js').ProjectDoc} ProjectDoc */
/** @typedef {import('../store.js').Store} Store */

/** The order preset groups are shown in, with their headings. */
const PRESET_GROUPS = Object.freeze([
  { kind: 'effect-stack', label: 'Effect stacks' },
  { kind: 'animation', label: 'Animations' },
  { kind: 'audio-mapping', label: 'Audio connections' },
  { kind: 'graphic', label: 'Graphics' },
  { kind: 'template', label: 'Templates' },
]);

/** Kinds that can only be applied to a clip. */
const CLIP_SCOPED = Object.freeze(['effect-stack', 'animation', 'graphic']);

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepCopy(value) {
  return /** @type {T} */ (JSON.parse(JSON.stringify(value)));
}

/**
 * Human label for a keyframe channel id.
 * @param {string} channel
 * @returns {string}
 */
function channelLabel(channel) {
  const transformLabels = {
    'transform.position.x': 'position X',
    'transform.position.y': 'position Y',
    'transform.scale.x': 'scale X',
    'transform.scale.y': 'scale Y',
    'transform.rotation': 'rotation',
    'transform.opacity': 'opacity',
    'transform.anchor.x': 'anchor X',
    'transform.anchor.y': 'anchor Y',
    'transform.crop.top': 'crop top',
    'transform.crop.right': 'crop right',
    'transform.crop.bottom': 'crop bottom',
    'transform.crop.left': 'crop left',
  };
  if (transformLabels[channel]) return transformLabels[channel];
  const effectMatch = /^effects\.([^.]+)\.(.+)$/.exec(channel);
  if (effectMatch) return `effect ${effectMatch[2]}`;
  const maskMatch = /^masks\.([^.]+)\.(.+)$/.exec(channel);
  if (maskMatch) return `mask ${maskMatch[2]}`;
  return channel;
}

/**
 * @param {string} band
 * @returns {string}
 */
function bandLabel(band) {
  return BAND_CHOICES.find((entry) => entry.value === band)?.label ?? band;
}

/**
 * @param {number} timestamp
 * @returns {string}
 */
function formatWhen(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'unknown date';
  return new Date(timestamp).toLocaleString();
}

/**
 * The clip a preset action should target: the timeline selection when the caller
 * supplied one, otherwise the store's own selection.
 *
 * @param {Store} store
 * @param {any} [timelineSelection]  Array of clip ids, or an object with `clipIds` / `selectedClipIds` / `clips`.
 * @returns {Clip|undefined}
 */
function selectedClip(store, timelineSelection) {
  const fromTimeline = Array.isArray(timelineSelection)
    ? timelineSelection
    : timelineSelection?.clips?.length
      ? timelineSelection.clips
      : timelineSelection?.clipIds ?? timelineSelection?.selectedClipIds ?? timelineSelection?.ids ?? null;
  if (Array.isArray(fromTimeline) && fromTimeline.length) {
    const first = fromTimeline[0];
    const clip = typeof first === 'string' ? store.getClip(first) : first;
    if (clip) return /** @type {Clip} */ (clip);
  }
  return store.primaryClip;
}

/**
 * A small modal that asks which of two things to do. Used when applying an
 * effect stack, where "replace" and "add to the end" are both reasonable.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.message
 * @param {Array<{label:string, value:string, primary?:boolean, title?:string}>} options.choices
 * @returns {Promise<string|null>} the chosen value, or null when cancelled
 */
function choiceDialog({ title, message, choices }) {
  return new Promise((resolvePromise) => {
    const root = document.getElementById('modal-root');
    if (!root) {
      resolvePromise(choices[0]?.value ?? null);
      return;
    }
    let settled = false;
    const close = (/** @type {string|null} */ value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolvePromise(value);
    };
    function onKey(/** @type {KeyboardEvent} */ event) {
      if (event.key === 'Escape') close(null);
    }
    const backdrop = el('div', { class: 'modal-backdrop' }, [
      el('div', { class: 'modal modal--sm' }, [
        el('div', { class: 'modal__head' }, [
          el('div', { class: 'modal__title', text: title }),
          iconButton(ICONS.close, 'Cancel', () => close(null)),
        ]),
        el('div', { class: 'modal__body' }, [hint('info', message)]),
        el('div', { class: 'modal__foot' }, [
          el('div', { class: 'spacer' }),
          button('Cancel', 'btn', { onclick: () => close(null) }),
          ...choices.map((choice) => button(choice.label, choice.primary ? 'btn btn--primary' : 'btn', {
            title: choice.title ?? choice.label,
            onclick: () => close(choice.value),
          })),
        ]),
      ]),
    ]);
    backdrop.addEventListener('pointerdown', (event) => {
      if (event.target === backdrop) close(null);
    });
    root.append(backdrop);
    document.addEventListener('keydown', onKey);
  });
}

/* ------------------------------------------------------------------ *
 * Saving
 * ------------------------------------------------------------------ */

/**
 * Save a clip's effect stack as an `effect-stack` preset. The stack is stored as
 * a deep copy; applying it later mints fresh effect ids.
 *
 * @param {object} options
 * @param {Store} options.store
 * @param {Clip} options.clip
 * @param {string} [options.name]
 * @returns {Preset|null} the stored preset, or null when there was nothing to save
 */
export function saveEffectStackPreset({ store, clip, name }) {
  if (!clip) {
    store.notify('warn', 'Select a clip first — an effect stack preset is built from a clip.');
    return null;
  }
  if (!clip.effects.stack.length) {
    store.notify('warn', `“${clip.name}” has no effects yet. Add one in the inspector, then save the stack.`, { title: 'Presets' });
    return null;
  }
  const stack = deepCopy(clip.effects.stack);
  const labels = stack.map((instance) => effectDefinition(instance.type).label);
  const preset = /** @type {Preset} */ ({
    id: uid('preset'),
    name: name?.trim() || `${clip.name} look`,
    kind: 'effect-stack',
    category: clip.kind,
    description: `${labels.length} effect${labels.length === 1 ? '' : 's'}: ${labels.join(' → ')}`,
    createdAt: Date.now(),
    data: { enabled: clip.effects.enabled, stack },
  });
  store.addPreset(preset);
  store.notify('ok', `Saved “${preset.name}” — apply it to any clip from Presets.`, { title: 'Presets' });
  return preset;
}

/**
 * Save a clip's animation as an `animation` preset. Key times are normalised to
 * start at 0 (the earliest key becomes 0) so the preset can be applied anywhere;
 * the clip's base transform is stored alongside so applying it reproduces the
 * preset's framing as well as its movement.
 *
 * @param {object} options
 * @param {Store} options.store
 * @param {Clip} options.clip
 * @param {string} [options.name]
 * @returns {Preset|null}
 */
export function saveAnimationPreset({ store, clip, name }) {
  if (!clip) {
    store.notify('warn', 'Select a clip first — an animation preset is built from a clip’s keyframes.');
    return null;
  }
  const keyed = clip.keyframes.filter((channel) => channel.keys.length > 0);
  if (keyed.length === 0) {
    store.notify('warn', `“${clip.name}” has no keyframes yet. Key a property at the playhead, then save the animation.`, { title: 'Presets' });
    return null;
  }
  let earliest = Infinity;
  let latest = 0;
  for (const channel of keyed) {
    for (const key of channel.keys) earliest = Math.min(earliest, key.time);
  }
  const channels = keyed.map((channel) => ({
    channel: channel.channel,
    keys: channel.keys.map((key) => {
      const offset = Math.max(0, key.time - earliest);
      latest = Math.max(latest, offset);
      return { offset, value: key.value, ease: deepCopy(key.ease) };
    }),
  }));
  const keyCount = channels.reduce((total, group) => total + group.keys.length, 0);
  const names = channels.map((group) => channelLabel(group.channel));
  const preset = /** @type {Preset} */ ({
    id: uid('preset'),
    name: name?.trim() || `${clip.name} animation`,
    kind: 'animation',
    category: clip.kind,
    description: `${keyCount} keyframe${keyCount === 1 ? '' : 's'} on ${names.join(', ')} over ${latest.toFixed(2)}s, starting at the clip’s own start`,
    createdAt: Date.now(),
    data: {
      channels,
      duration: latest,
      base: deepCopy(clip.transform),
      clipKind: clip.kind,
    },
  });
  store.addPreset(preset);
  store.notify('ok', `Saved “${preset.name}” — it starts at whichever clip you apply it to.`, { title: 'Presets' });
  return preset;
}

/**
 * Save the document's audio connections as an `audio-mapping` preset. Applying it
 * replaces the connections wholesale, which is what "recall this setup" means
 * for modulation.
 *
 * @param {object} options
 * @param {Store} options.store
 * @param {string} [options.name]
 * @returns {Preset|null}
 */
export function saveAudioMappingPreset({ store, name }) {
  const mappings = store.doc.mappings;
  if (!mappings.length) {
    store.notify('warn', 'There are no audio connections to save yet. Create one in the Audio panel first.', { title: 'Presets' });
    return null;
  }
  const summary = mappings
    .slice(0, 4)
    .map((mapping) => `${bandLabel(mapping.band)} → ${channelLabel(mapping.target)}`)
    .join(', ');
  const preset = /** @type {Preset} */ ({
    id: uid('preset'),
    name: name?.trim() || 'Audio connections',
    kind: 'audio-mapping',
    category: 'Audio',
    description: `${mappings.length} connection${mappings.length === 1 ? '' : 's'}: ${summary}${mappings.length > 4 ? ', …' : ''}`,
    createdAt: Date.now(),
    data: { mappings: deepCopy(mappings) },
  });
  store.addPreset(preset);
  store.notify('ok', `Saved “${preset.name}” with ${mappings.length} connection${mappings.length === 1 ? '' : 's'}.`, { title: 'Presets' });
  return preset;
}

/* ------------------------------------------------------------------ *
 * Listing
 * ------------------------------------------------------------------ */

/**
 * Presets on the document, optionally filtered by kind.
 *
 * @param {Store} store
 * @param {string} [kind]  One of effect-stack | animation | audio-mapping | template | graphic.
 * @returns {Preset[]}
 */
export function listPresets(store, kind) {
  const presets = store.doc.presets ?? [];
  return kind ? presets.filter((preset) => preset.kind === kind) : [...presets];
}

/* ------------------------------------------------------------------ *
 * Applying
 * ------------------------------------------------------------------ */

/**
 * Apply a preset.
 *
 *  - `effect-stack`  asks whether to replace or extend the clip's stack, then
 *                    writes fresh effect ids.
 *  - `animation`     writes the keys offset to the clip's `start` and applies the
 *                    stored base transform, so the framing matches even if the
 *                    keys are later removed.
 *  - `audio-mapping` replaces `doc.mappings` with fresh mapping ids.
 *  - `template`      replaces the whole document.
 *  - `graphic`       writes the graphic spec onto a graphic clip.
 *
 * @param {object} options
 * @param {Store} options.store
 * @param {import('../preview.js').Preview} [options.preview]
 * @param {import('../timeline.js').Timeline} [options.timeline]
 * @param {Preset} options.preset
 * @param {Clip} [options.clip]  Required for the clip-scoped kinds.
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function applyPreset({ store, preview, timeline, preset, clip }) {
  const refresh = () => {
    preview?.layout?.();
    preview?.invalidate?.(true);
    timeline?.rebuildHeads?.();
    timeline?.invalidate?.(true);
  };

  /**
   * @param {string} message
   * @returns {{ok:boolean, message:string}}
   */
  const fail = (message) => {
    store.notify('warn', message, { title: 'Presets' });
    return { ok: false, message };
  };

  if (!preset) return fail('There is no preset to apply.');
  const data = /** @type {any} */ (preset.data ?? {});

  switch (preset.kind) {
    case 'effect-stack': {
      if (!clip) return fail(`“${preset.name}” needs a selected clip: select one, then apply it.`);
      const incoming = Array.isArray(data.stack) ? data.stack : [];
      if (incoming.length === 0) return fail(`“${preset.name}” holds no effects.`);
      const mode = await choiceDialog({
        title: `Apply “${preset.name}”`,
        message: `${incoming.length} effect${incoming.length === 1 ? '' : 's'} will be copied onto “${clip.name}”. Replace what is there, or add them to the end of the stack?`,
        choices: [
          { label: 'Add to the end', value: 'append', title: 'Keep the existing effects and append the preset after them', primary: true },
          { label: 'Replace the stack', value: 'replace', title: 'Remove the clip’s current effects and use the preset instead' },
        ],
      });
      if (!mode) return { ok: false, message: 'Cancelled.' };
      const copies = incoming.map((instance) => ({
        ...deepCopy(instance),
        id: uid('fx'),
        seed: (Number(instance.seed) || 1) + 7,
      }));
      store.edit(`Apply ${preset.name}`, () => {
        if (mode === 'replace') clip.effects.stack = copies;
        else clip.effects.stack.push(...copies);
        clip.effects.enabled = data.enabled ?? true;
        pruneOrphanChannels(clip);
      });
      refresh();
      const message = `${mode === 'replace' ? 'Replaced' : 'Added'} ${copies.length} effect${copies.length === 1 ? '' : 's'} on “${clip.name}”.`;
      store.notify('ok', message, { title: 'Presets' });
      return { ok: true, message };
    }

    case 'animation': {
      if (!clip) return fail(`“${preset.name}” needs a selected clip: select one, then apply it.`);
      const channels = Array.isArray(data.channels) ? data.channels : [];
      if (channels.length === 0) return fail(`“${preset.name}” holds no keyframes.`);
      let written = 0;
      store.edit(`Apply ${preset.name}`, () => {
        for (const group of channels) {
          for (const key of group.keys ?? []) {
            setKeyframe(
              clip,
              group.channel,
              clip.start + (Number(key.offset) || 0),
              Number(key.value) || 0,
              key.ease ?? easingPreset('Ease in-out'),
            );
            written += 1;
          }
          // The stored base transform keeps the preset's framing even if the
          // keys are later deleted, so restore it for the animated channels.
          if (data.base && String(group.channel).startsWith('transform.')) {
            setTransformBase(clip.transform, group.channel, transformBase(data.base, group.channel));
          }
        }
      });
      refresh();
      const message = `${written} keyframe${written === 1 ? '' : 's'} applied to “${clip.name}”, starting at ${clip.start.toFixed(2)}s.`;
      store.notify('ok', message, { title: 'Presets' });
      return { ok: true, message };
    }

    case 'audio-mapping': {
      const mappings = Array.isArray(data.mappings) ? data.mappings : [];
      if (mappings.length === 0) return fail(`“${preset.name}” holds no connections.`);
      let replaced = 0;
      store.edit(`Apply ${preset.name}`, () => {
        store.doc.mappings = mappings.map((mapping) => ({ ...deepCopy(mapping), id: uid('map') }));
        replaced = store.doc.mappings.length;
      });
      store.invalidateMappings();
      store.emit('analysis');
      refresh();
      const message = `Replaced the audio connections with ${replaced} from “${preset.name}”. Choose their sources in the Audio panel if the assets differ.`;
      store.notify('ok', message, { title: 'Presets' });
      return { ok: true, message };
    }

    case 'template': {
      if (!data || typeof data !== 'object' || !data.composition) return fail(`“${preset.name}” does not contain a project document.`);
      store.replaceDocument(data, `Apply template ${preset.name}`);
      // A template is a different composition, so the timeline gets a full refit
      // rather than the light refresh the clip-scoped kinds need.
      store.session.projectId = null;
      preview?.layout?.();
      preview?.invalidate?.(true);
      timeline?.rebuildHeads?.();
      timeline?.fit?.();
      timeline?.invalidate?.(true);
      const message = `Opened “${preset.name}” as an unsaved project. Save it when you are happy with it.`;
      store.notify('ok', message, { title: 'Presets' });
      return { ok: true, message };
    }

    case 'graphic': {
      if (!clip) return fail(`“${preset.name}” needs a graphic clip: select one, then apply it.`);
      if (clip.kind !== 'graphic') return fail(`“${preset.name}” is a graphic preset, and “${clip.name}” is a ${clip.kind} clip. Select a graphic layer instead.`);
      if (!data || typeof data.kind !== 'string') return fail(`“${preset.name}” does not contain a graphic.`);
      store.edit(`Apply ${preset.name}`, () => {
        clip.graphic = { ...deepCopy(data), seed: Number(data.seed) || clip.graphic?.seed || 1 };
      });
      refresh();
      const message = `Applied the ${data.kind} graphic to “${clip.name}”.`;
      store.notify('ok', message, { title: 'Presets' });
      return { ok: true, message };
    }

    default:
      return fail(`“${preset.name}” has an unknown kind (“${preset.kind}”), so it cannot be applied.`);
  }
}

/* ------------------------------------------------------------------ *
 * Preset previews
 * ------------------------------------------------------------------ */

const CURVE_COLORS = ['#5ce1ff', '#ff3d8b', '#ffd166', '#4ad991', '#b48cff', '#ff8a3d'];

/**
 * Paint a summary of a preset into a canvas. Every kind gets a drawing that says
 * something true about the preset rather than a generic icon:
 * templates render a real frame, graphics draw the real source, animations plot
 * the real curves, audio connections draw the real output ranges, and effect
 * stacks list the real chain in order.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Preset} preset
 * @param {any} [frameSource]
 */
function drawPresetPreview(canvas, preset, frameSource) {
  const width = canvas.width;
  const height = canvas.height;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#08080c';
  ctx.fillRect(0, 0, width, height);
  const data = /** @type {any} */ (preset.data ?? {});

  if (preset.kind === 'template' && data.composition) {
    const renderHeight = height;
    const renderWidth = Math.max(16, Math.round(renderHeight * (data.composition.width / data.composition.height)));
    const time = Math.min((data.composition.duration ?? 4) * 0.35, 4);
    const { canvas: frame } = renderFrameToCanvas(data, time, { width: renderWidth, height: renderHeight, frameSource });
    const scale = Math.min(width / renderWidth, height / renderHeight);
    ctx.drawImage(/** @type {any} */ (frame), (width - renderWidth * scale) / 2, (height - renderHeight * scale) / 2, renderWidth * scale, renderHeight * scale);
    return;
  }

  if (preset.kind === 'graphic') {
    const spec = { ...defaultGraphic(data.kind ?? 'gradient'), ...data };
    const size = Math.min(width, height);
    ctx.save();
    ctx.translate((width - size) / 2, (height - size) / 2);
    drawGraphicThumbnail(ctx, spec.kind, size, spec, 1.4);
    ctx.restore();
    return;
  }

  if (preset.kind === 'animation') {
    const groups = Array.isArray(data.channels) ? data.channels : [];
    const duration = Math.max(0.1, Number(data.duration) || 1);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i += 1) {
      const y = 8 + ((height - 16) * i) / 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    groups.forEach((group, index) => {
      const keys = (group.keys ?? []).map((key) => ({ id: key.channel ?? 'k', time: key.offset, value: key.value, ease: key.ease }));
      if (keys.length === 0) return;
      const values = keys.map((key) => key.value);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const span = Math.abs(max - min) < 1e-6 ? 1 : max - min;
      ctx.strokeStyle = CURVE_COLORS[index % CURVE_COLORS.length];
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      const steps = Math.max(2, Math.round(width / 2));
      for (let step = 0; step <= steps; step += 1) {
        const time = (duration * step) / steps;
        const value = evaluateKeys(keys, time);
        const x = (width * step) / steps;
        const y = height - 10 - ((value - min) / span) * (height - 20);
        if (step === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = CURVE_COLORS[index % CURVE_COLORS.length];
      for (const key of keys) {
        const x = (width * Math.min(1, key.time / duration));
        const y = height - 10 - ((key.value - min) / span) * (height - 20);
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText(channelLabel(group.channel), 4, 11 + index * 11);
    });
    if (groups.length === 0) drawCentredText(ctx, 'No keyframes', width, height);
    return;
  }

  if (preset.kind === 'audio-mapping') {
    const mappings = Array.isArray(data.mappings) ? data.mappings : [];
    if (mappings.length === 0) {
      drawCentredText(ctx, 'No connections', width, height);
      return;
    }
    const min = Math.min(...mappings.map((mapping) => Number(mapping.min) || 0));
    const max = Math.max(...mappings.map((mapping) => Number(mapping.max) || 1));
    const span = Math.abs(max - min) < 1e-6 ? 1 : max - min;
    const rowHeight = Math.max(9, Math.min(20, (height - 10) / mappings.length));
    mappings.forEach((mapping, index) => {
      const y = 8 + index * rowHeight;
      const from = ((Number(mapping.min) || 0) - min) / span;
      const to = ((Number(mapping.max) || 0) - min) / span;
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(4, y, width - 8, Math.max(4, rowHeight - 4));
      ctx.fillStyle = CURVE_COLORS[index % CURVE_COLORS.length];
      ctx.fillRect(4 + from * (width - 8), y, Math.max(2, (to - from) * (width - 8)), Math.max(4, rowHeight - 4));
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = '9px ui-monospace, monospace';
      const label = `${bandLabel(mapping.band)} → ${channelLabel(mapping.target)}`;
      ctx.fillText(label, 8, y + Math.max(9, rowHeight - 6));
    });
    return;
  }

  // effect-stack (and anything unexpected): list the real chain in order.
  const stack = Array.isArray(data.stack) ? data.stack : [];
  if (stack.length === 0) {
    drawCentredText(ctx, 'Empty stack', width, height);
    return;
  }
  const rowHeight = Math.min(22, (height - 12) / stack.length);
  stack.slice(0, 8).forEach((instance, index) => {
    const y = 8 + index * rowHeight;
    const definition = effectDefinition(instance.type);
    ctx.fillStyle = CURVE_COLORS[index % CURVE_COLORS.length];
    ctx.fillRect(6, y, 3, Math.max(5, rowHeight - 5));
    ctx.fillStyle = instance.enabled === false ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.85)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(`${index + 1}. ${definition.label}`, 14, y + Math.max(8, rowHeight - 7));
  });
  if (stack.length > 8) {
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillText(`+${stack.length - 8} more`, 14, height - 4);
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} width
 * @param {number} height
 */
function drawCentredText(ctx, text, width, height) {
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '11px ui-monospace, monospace';
  const metrics = ctx.measureText(text);
  ctx.fillText(text, (width - metrics.width) / 2, height / 2 + 4);
}

/* ------------------------------------------------------------------ *
 * Dialog
 * ------------------------------------------------------------------ */

/**
 * The preset browser: every saved preset grouped by kind, each with a live
 * preview and Apply / Rename / Delete / Export buttons, plus the save and import
 * actions that create presets in the first place.
 *
 * @param {object} options
 * @param {Store} options.store
 * @param {import('../api.js').api} [options.api]
 * @param {import('../media.js').MediaEngine} [options.media]
 * @param {import('../preview.js').Preview} [options.preview]
 * @param {import('../timeline.js').Timeline} [options.timeline]
 * @param {any} [options.timelineSelection]  Used to find the clip a preset applies to.
 * @returns {{close:()=>void, render:()=>void}}
 */
export function openPresetsDialog({ store, api, media, preview, timeline, timelineSelection }) {
  const modalRoot = document.getElementById('modal-root');
  const backdrop = el('div', { class: 'modal-backdrop' });
  const body = el('div', { class: 'modal__body' });
  const foot = el('div', { class: 'modal__foot' });
  let open = true;
  /** @type {(() => void)|null} */
  let unsubscribe = null;

  const close = () => {
    if (!open) return;
    open = false;
    unsubscribe?.();
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  };
  const isTopmost = () => {
    const all = modalRoot ? [...modalRoot.querySelectorAll('.modal-backdrop')] : [];
    return all[all.length - 1] === backdrop;
  };
  function onKey(/** @type {KeyboardEvent} */ event) {
    if (event.key === 'Escape' && isTopmost()) close();
  }

  const listHost = el('div', {});
  const targetHint = el('div', {});
  const fileInput = el('input', { type: 'file', accept: '.json,application/json', class: 'hidden' });

  /** @returns {Clip|undefined} */
  const targetClip = () => selectedClip(store, timelineSelection);

  /**
   * Save one clip's effect stack, animation or graphic.
   * @param {'effect-stack'|'animation'|'graphic'} kind
   */
  async function saveFromSelection(kind) {
    const clip = targetClip();
    if (!clip) {
      store.notify('warn', 'Select a clip first — presets are saved from the selected clip.', { title: 'Presets' });
      return;
    }
    const defaults = {
      'effect-stack': `${clip.name} look`,
      animation: `${clip.name} animation`,
      graphic: `${(clip.graphic?.kind ?? 'graphic')} graphic`,
    };
    const name = await promptDialog({
      title: 'Save preset',
      message: `Name for this ${kind === 'effect-stack' ? 'effect stack' : kind}`,
      value: defaults[kind],
    });
    if (!name) return;
    if (kind === 'effect-stack') saveEffectStackPreset({ store, clip, name });
    else if (kind === 'animation') saveAnimationPreset({ store, clip, name });
    else {
      if (clip.kind !== 'graphic' || !clip.graphic) {
        store.notify('warn', `“${clip.name}” is not a graphic layer, so it has no graphic to save.`, { title: 'Presets' });
        return;
      }
      store.addPreset({
        id: uid('preset'),
        name,
        kind: 'graphic',
        category: clip.graphic.kind,
        description: `${clip.graphic.kind} graphic, seed ${clip.graphic.seed}`,
        createdAt: Date.now(),
        data: deepCopy(clip.graphic),
      });
      store.notify('ok', `Saved the “${name}” graphic.`, { title: 'Presets' });
    }
    render();
  }

  /** @param {'audio-mapping'|'template'} kind */
  async function saveDocumentPreset(kind) {
    if (kind === 'audio-mapping') {
      const name = await promptDialog({ title: 'Save preset', message: 'Name for this set of audio connections', value: 'Audio connections' });
      if (!name) return;
      saveAudioMappingPreset({ store, name });
    } else {
      const name = await promptDialog({ title: 'Save template', message: 'Name for this template', value: store.doc.meta.name });
      if (!name) return;
      const payload = deepCopy({ ...store.doc, presets: [] });
      store.addPreset({
        id: uid('preset'),
        name,
        kind: 'template',
        category: 'Project',
        description: `${payload.clips.length} clips · ${payload.tracks.length} tracks · ${payload.composition.width}×${payload.composition.height} @ ${payload.composition.fps} fps`,
        createdAt: Date.now(),
        data: payload,
      });
      store.notify('ok', `Saved “${name}” as a template. It is stored inside this project.`, { title: 'Presets' });
    }
    render();
  }

  /**
   * @param {Preset} preset
   * @returns {HTMLElement}
   */
  function buildCard(preset) {
    const canvas = /** @type {HTMLCanvasElement} */ (el('canvas', { class: 'mapping-canvas', width: '320', height: '180' }));
    const needsClip = CLIP_SCOPED.includes(preset.kind);
    const clip = targetClip();
    const applyButton = button('Apply', 'btn btn--tiny btn--primary', {
      title: needsClip && !clip
        ? 'Select a clip first: this preset is applied to a clip'
        : `Apply “${preset.name}”`,
      disabled: needsClip && !clip,
      onclick: async () => {
        await applyPreset({ store, preview, timeline, preset, clip: targetClip() });
        render();
      },
    });
    const card = el('div', { class: 'picker-tile' }, [
      canvas,
      el('div', { class: 'picker-tile__label', text: preset.name }),
      el('div', { class: 'picker-tile__sub', text: `${preset.category ?? preset.kind} · ${preset.description ?? 'No description'}` }),
      el('div', { class: 'picker-tile__sub muted', text: `Saved ${formatWhen(preset.createdAt)}` }),
      el('div', { class: 'row row--wrap' }, [
        applyButton,
        button('Rename', 'btn btn--tiny', {
          onclick: async () => {
            const name = await promptDialog({ title: 'Rename preset', message: 'Preset name', value: preset.name });
            if (!name) return;
            store.edit('Rename preset', () => {
              preset.name = name;
            });
            render();
          },
        }),
        button('Delete', 'btn btn--tiny btn--danger', {
          onclick: async () => {
            const confirmed = await confirmDialog({
              title: 'Delete preset',
              message: `Delete “${preset.name}” from this project?`,
              confirmLabel: 'Delete',
              danger: true,
            });
            if (!confirmed) return;
            store.removePreset(preset.id);
            render();
          },
        }),
        button('Export', 'btn btn--tiny', {
          title: 'Export this preset as a JSON file',
          onclick: () => exportPreset(preset),
        }),
      ]),
    ]);
    try {
      drawPresetPreview(canvas, preset, media?.frameSource);
    } catch (error) {
      const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
      ctx.fillStyle = '#08080c';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawCentredText(ctx, 'Preview unavailable', canvas.width, canvas.height);
      console.warn('[motion-lab] preset preview failed', error);
    }
    return card;
  }

  function render() {
    const presets = listPresets(store);
    const clip = targetClip();
    targetHint.replaceChildren(
      clip
        ? hint('info', `Clip-scoped presets (effect stacks, animations and graphics) apply to “${clip.name}”.`)
        : hint('warn', 'No clip is selected: effect-stack, animation and graphic presets need one. Select a clip on the timeline, or in the inspector, and they become available.'),
    );

    if (presets.length === 0) {
      listHost.replaceChildren(emptyState('No presets yet. Save the selected clip’s effect stack or animation above, save the audio connections, or import a preset JSON file.'));
      return;
    }

    listHost.replaceChildren(...PRESET_GROUPS.map((group) => {
      const entries = presets.filter((preset) => preset.kind === group.kind);
      if (entries.length === 0) return null;
      return el('div', { class: 'form-group' }, [
        el('div', { class: 'form-group__label', text: `${group.label} (${entries.length})` }),
        el('div', { class: 'grid-3' }, entries.map(buildCard)),
      ]);
    }).filter(Boolean));
  }

  /**
   * Write one preset to a JSON file the user can keep or share.
   * @param {Preset} preset
   */
  function exportPreset(preset) {
    try {
      const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = el('a', {
        href: url,
        download: `${preset.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'preset'}.json`,
      });
      anchor.style.display = 'none';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      store.notify('ok', `Exported “${preset.name}”.`, { title: 'Presets' });
    } catch (error) {
      store.notify('error', `Could not export the preset: ${error instanceof Error ? error.message : error}`, { title: 'Presets' });
    }
  }

  /** @param {File} file */
  async function importPreset(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const record = Array.isArray(parsed) ? parsed[0] : parsed;
      const kinds = PRESET_GROUPS.map((group) => group.kind);
      if (!record || typeof record !== 'object' || !kinds.includes(record.kind)) {
        throw new Error(`the file is not a Motion Lab preset (expected a "kind" of ${kinds.join(', ')})`);
      }
      const preset = /** @type {Preset} */ ({
        id: uid('preset'),
        name: String(record.name ?? file.name.replace(/\.json$/i, '')),
        kind: record.kind,
        category: record.category ? String(record.category) : undefined,
        description: record.description ? String(record.description) : `Imported from ${file.name}`,
        createdAt: Date.now(),
        data: deepCopy(record.data ?? {}),
      });
      store.addPreset(preset);
      store.notify('ok', `Imported “${preset.name}” as an ${preset.kind} preset.`, { title: 'Presets' });
      render();
    } catch (error) {
      store.notify('error', `That preset could not be imported: ${error instanceof Error ? error.message : error}`, { title: 'Presets' });
    }
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) await importPreset(file);
  });

  const head = el('div', { class: 'modal__head' }, [
    el('div', { class: 'modal__title', text: 'Presets' }),
    el('div', { class: 'modal__sub', text: 'Reusable looks, animations, connections and templates' }),
    iconButton(ICONS.close, 'Close', () => close()),
  ]);

  body.append(
    el('div', { class: 'form-group' }, [
      el('div', { class: 'form-group__label', text: 'Save the current state' }),
      el('div', { class: 'row row--wrap' }, [
        button('Save effect stack', 'btn btn--tiny', { onclick: () => saveFromSelection('effect-stack') }),
        button('Save animation', 'btn btn--tiny', { onclick: () => saveFromSelection('animation') }),
        button('Save graphic', 'btn btn--tiny', { onclick: () => saveFromSelection('graphic') }),
        button('Save audio connections', 'btn btn--tiny', { onclick: () => saveDocumentPreset('audio-mapping') }),
        button('Save project as template', 'btn btn--tiny', { onclick: () => saveDocumentPreset('template') }),
        button('Import from JSON…', 'btn btn--tiny', { onclick: () => fileInput.click() }),
        fileInput,
      ]),
      targetHint,
    ]),
    listHost,
  );
  foot.append(
    el('div', { class: 'spacer' }),
    button('Close', 'btn', { onclick: () => close() }),
  );

  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  backdrop.append(el('div', { class: 'modal modal--lg' }, [head, body, foot]));
  modalRoot?.append(backdrop);

  // Presets live on the document and on external edits (undo, imports), so keep
  // the list in step with the store rather than trusting a snapshot.
  unsubscribe = store.on('library', () => {
    if (open) render();
  });

  render();
  return { close, render };
}