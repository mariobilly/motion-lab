/**
 * Keyframe channels: evaluation, editing helpers and interpolation.
 *
 * Interpolation contract
 * ----------------------
 * A keyframe's `ease` describes the segment that *starts* at that keyframe:
 *
 *   linear  straight line to the next key
 *   hold    value stays put until the next key (step)
 *   ease    cubic ease-in-out
 *   bezier  user-editable cubic-bezier(x1,y1,x2,y2) timing function
 *
 * Segment curves are therefore authored on the *outgoing* side of a key, which
 * is what the graph editor draws handles for, and it removes any ambiguity
 * about which of two adjacent keys owns a segment.
 *
 * Evaluation only reads the document -- it never writes -- so preview and
 * export always agree.
 */

import { cubicBezier, clamp01 } from './math.js';
import { uid } from './schema.js';

/** @typedef {import('./schema.js').KeyChannel} KeyChannel */
/** @typedef {import('./schema.js').Keyframe} Keyframe */
/** @typedef {import('./schema.js').Easing} Easing */
/** @typedef {import('./schema.js').BezierHandles} BezierHandles */

/** Named curves offered in the easing menu. */
export const EASING_PRESETS = Object.freeze([
  { name: 'Linear', kind: 'linear', bezier: { x1: 0, y1: 0, x2: 1, y2: 1 } },
  { name: 'Ease in', kind: 'bezier', bezier: { x1: 0.42, y1: 0, x2: 1, y2: 1 } },
  { name: 'Ease out', kind: 'bezier', bezier: { x1: 0, y1: 0, x2: 0.58, y2: 1 } },
  { name: 'Ease in-out', kind: 'ease', bezier: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 } },
  { name: 'Expo out', kind: 'bezier', bezier: { x1: 0.16, y1: 1, x2: 0.3, y2: 1 } },
  { name: 'Expo in', kind: 'bezier', bezier: { x1: 0.7, y1: 0, x2: 0.84, y2: 0 } },
  { name: 'Back out', kind: 'bezier', bezier: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 } },
  { name: 'Anticipate', kind: 'bezier', bezier: { x1: 0.36, y1: -0.4, x2: 0.66, y2: 1 } },
  { name: 'Hold', kind: 'hold', bezier: { x1: 0, y1: 0, x2: 1, y2: 1 } },
]);

/**
 * @param {string} name
 * @returns {Easing}
 */
export function easingPreset(name) {
  const preset = EASING_PRESETS.find((entry) => entry.name === name) ?? EASING_PRESETS[0];
  return { kind: /** @type {any} */ (preset.kind), bezier: { ...preset.bezier }, name: preset.name };
}

/** @returns {Easing} */
export function linearEasing() {
  return { kind: 'linear', bezier: { x1: 0, y1: 0, x2: 1, y2: 1 }, name: 'Linear' };
}

/** @returns {Easing} */
export function holdEasing() {
  return { kind: 'hold', bezier: { x1: 0, y1: 0, x2: 1, y2: 1 }, name: 'Hold' };
}

/** @returns {Easing} */
export function easeInOutEasing() {
  return { kind: 'ease', bezier: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 }, name: 'Ease in-out' };
}

/**
 * Normalise an easing record that came from storage or the UI.
 * @param {unknown} input
 * @returns {Easing}
 */
export function normalizeEasing(input) {
  const source = /** @type {Partial<Easing>} */ (input ?? {});
  const bezier = /** @type {Partial<BezierHandles>} */ (source.bezier ?? {});
  const kind = source.kind === 'hold' || source.kind === 'ease' || source.kind === 'bezier' || source.kind === 'linear'
    ? source.kind
    : 'linear';
  return {
    kind,
    bezier: {
      x1: Number.isFinite(bezier.x1) ? /** @type {number} */ (bezier.x1) : 0,
      y1: Number.isFinite(bezier.y1) ? /** @type {number} */ (bezier.y1) : 0,
      x2: Number.isFinite(bezier.x2) ? /** @type {number} */ (bezier.x2) : 1,
      y2: Number.isFinite(bezier.y2) ? /** @type {number} */ (bezier.y2) : 1,
    },
    name: typeof source.name === 'string' ? source.name : 'Linear',
  };
}

/**
 * Apply an easing curve to a normalised 0..1 progress value.
 * @param {Easing} easing
 * @param {number} t
 * @returns {number}
 */
export function applyEasing(easing, t) {
  const progress = clamp01(t);
  switch (easing.kind) {
    case 'hold':
      return 0;
    case 'ease':
      return progress < 0.5
        ? 4 * progress * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;
    case 'bezier':
      return cubicBezier(easing.bezier.x1, easing.bezier.y1, easing.bezier.x2, easing.bezier.y2, progress);
    case 'linear':
    default:
      return progress;
  }
}

/**
 * Find the channel for `channel` inside a clip, if present.
 * @param {import('./schema.js').Clip} clip
 * @param {string} channel
 * @returns {KeyChannel|undefined}
 */
export function findChannel(clip, channel) {
  return clip.keyframes.find((entry) => entry.channel === channel);
}

/**
 * Get or create a channel. Mutates the clip -- callers that need undo
 * granularity should go through the store's command layer.
 * @param {import('./schema.js').Clip} clip
 * @param {string} channel
 * @returns {KeyChannel}
 */
export function ensureChannel(clip, channel) {
  let found = findChannel(clip, channel);
  if (!found) {
    found = { id: uid('chan'), channel, keys: [] };
    clip.keyframes.push(found);
  }
  return found;
}

/**
 * @param {Keyframe[]} keys
 * @returns {Keyframe[]} the same array, sorted in place by time then id
 */
export function sortKeys(keys) {
  keys.sort((a, b) => (a.time - b.time) || a.id.localeCompare(b.id));
  return keys;
}

/**
 * Evaluate a channel at an absolute composition time.
 * Returns `null` when the channel has no keys at all so callers can fall back
 * to the clip's static base value.
 *
 * @param {import('./schema.js').Clip} clip
 * @param {string} channel
 * @param {number} time
 * @returns {number|null}
 */
export function evaluateChannel(clip, channel, time) {
  const entry = findChannel(clip, channel);
  if (!entry || entry.keys.length === 0) return null;
  return evaluateKeys(entry.keys, time);
}

/**
 * Evaluate a sorted key list at `time`.
 * @param {Keyframe[]} keys
 * @param {number} time
 * @returns {number}
 */
export function evaluateKeys(keys, time) {
  const count = keys.length;
  if (count === 0) return 0;
  if (count === 1) return keys[0].value;
  if (time <= keys[0].time) return keys[0].value;
  if (time >= keys[count - 1].time) return keys[count - 1].value;

  // Binary search for the segment containing `time`.
  let low = 0;
  let high = count - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (keys[mid].time <= time) low = mid;
    else high = mid;
  }
  const a = keys[low];
  const b = keys[low + 1];
  const span = b.time - a.time;
  if (span <= 1e-9) return b.value;
  const raw = (time - a.time) / span;
  const eased = applyEasing(normalizeEasing(a.ease), raw);
  return a.value + (b.value - a.value) * eased;
}

/**
 * Value of a channel at `time`, falling back to a static base.
 * @param {import('./schema.js').Clip} clip
 * @param {string} channel
 * @param {number} time
 * @param {number} base
 * @returns {number}
 */
export function channelValue(clip, channel, time, base) {
  const value = evaluateChannel(clip, channel, time);
  return value === null ? base : value;
}

/**
 * Insert or replace a keyframe at `time` and return it.
 * @param {import('./schema.js').Clip} clip
 * @param {string} channel
 * @param {number} time
 * @param {number} value
 * @param {Easing} [easing]
 * @returns {Keyframe}
 */
export function setKeyframe(clip, channel, time, value, easing) {
  const entry = ensureChannel(clip, channel);
  const rounded = Math.round(time * 1e6) / 1e6;
  const existing = entry.keys.find((key) => Math.abs(key.time - rounded) < 1e-4);
  if (existing) {
    existing.value = value;
    if (easing) existing.ease = normalizeEasing(easing);
    return existing;
  }
  const key = {
    id: uid('key'),
    time: rounded,
    value,
    ease: normalizeEasing(easing ?? linearEasing()),
  };
  entry.keys.push(key);
  sortKeys(entry.keys);
  return key;
}

/**
 * @param {import('./schema.js').Clip} clip
 * @param {string} channel
 * @param {string} keyId
 * @returns {boolean}
 */
export function removeKeyframe(clip, channel, keyId) {
  const entry = findChannel(clip, channel);
  if (!entry) return false;
  const index = entry.keys.findIndex((key) => key.id === keyId);
  if (index < 0) return false;
  entry.keys.splice(index, 1);
  if (entry.keys.length === 0) removeChannel(clip, channel);
  return true;
}

/**
 * @param {import('./schema.js').Clip} clip
 * @param {string} channel
 * @returns {void}
 */
export function removeChannel(clip, channel) {
  const index = clip.keyframes.findIndex((entry) => entry.channel === channel);
  if (index >= 0) clip.keyframes.splice(index, 1);
}

/**
 * Drop every keyframe belonging to an effect instance or mask that no longer
 * exists, so deleting a layer feature cannot leave orphan animation behind.
 * @param {import('./schema.js').Clip} clip
 * @returns {number} number of channels removed
 */
export function pruneOrphanChannels(clip) {
  const effectIds = new Set(clip.effects.stack.map((effect) => effect.id));
  const maskIds = new Set(clip.masks.map((mask) => mask.id));
  const before = clip.keyframes.length;
  clip.keyframes = clip.keyframes.filter((entry) => {
    const effectMatch = /^effects\.([^.]+)\./.exec(entry.channel);
    if (effectMatch) return effectIds.has(effectMatch[1]);
    const maskMatch = /^masks\.([^.]+)\./.exec(entry.channel);
    if (maskMatch) return maskIds.has(maskMatch[1]);
    return true;
  });
  return before - clip.keyframes.length;
}

/**
 * @param {import('./schema.js').Clip} clip
 * @param {number} time
 * @param {number} tolerance
 * @returns {Keyframe[]} every key in the clip within `tolerance` of `time`
 */
export function keysAtTime(clip, time, tolerance = 1e-3) {
  /** @type {Keyframe[]} */
  const found = [];
  for (const entry of clip.keyframes) {
    for (const key of entry.keys) if (Math.abs(key.time - time) <= tolerance) found.push(key);
  }
  return found;
}

/**
 * @param {import('./schema.js').Clip} clip
 * @param {string} channel
 * @param {number} time
 * @param {number} deltaSeconds
 * @returns {boolean} whether anything moved
 */
export function moveKeyframe(clip, channel, time, deltaSeconds) {
  const entry = findChannel(clip, channel);
  if (!entry) return false;
  const key = entry.keys.find((candidate) => Math.abs(candidate.time - time) < 1e-3);
  if (!key) return false;
  key.time = Math.max(0, key.time + deltaSeconds);
  sortKeys(entry.keys);
  return true;
}

/**
 * Copy a set of keys (by channel + time) into a portable clipboard payload.
 * Times are stored *relative to the earliest copied key* so the payload can be
 * pasted at an arbitrary playhead position.
 *
 * @param {import('./schema.js').Clip} clip
 * @param {Array<{channel:string, time:number}>} selection
 * @returns {{channels: Array<{channel:string, keys: Array<{offset:number, value:number, ease:Easing}>}>, duration:number}}
 */
export function copyKeyframes(clip, selection) {
  /** @type {Map<string, Array<{time:number, value:number, ease:Easing}>>} */
  const byChannel = new Map();
  let earliest = Infinity;
  for (const item of selection) {
    const entry = findChannel(clip, item.channel);
    if (!entry) continue;
    const key = entry.keys.find((candidate) => Math.abs(candidate.time - item.time) < 1e-3);
    if (!key) continue;
    earliest = Math.min(earliest, key.time);
    if (!byChannel.has(item.channel)) byChannel.set(item.channel, []);
    /** @type {Array<{time:number, value:number, ease:Easing}>} */ (byChannel.get(item.channel)).push({
      time: key.time,
      value: key.value,
      ease: normalizeEasing(key.ease),
    });
  }
  if (!Number.isFinite(earliest)) return { channels: [], duration: 0 };
  let latest = earliest;
  const channels = [...byChannel.entries()].map(([channel, keys]) => {
    const mapped = keys
      .map((key) => {
        latest = Math.max(latest, key.time);
        return { offset: key.time - earliest, value: key.value, ease: key.ease };
      })
      .sort((a, b) => a.offset - b.offset);
    return { channel, keys: mapped };
  });
  return { channels, duration: latest - earliest };
}

/**
 * Paste a clipboard payload so its first key lands on `atTime`.
 * @param {import('./schema.js').Clip} clip
 * @param {{channels: Array<{channel:string, keys: Array<{offset:number, value:number, ease:Easing}>}>}} payload
 * @param {number} atTime
 * @returns {number} number of keyframes written
 */
export function pasteKeyframes(clip, payload, atTime) {
  let written = 0;
  for (const group of payload.channels ?? []) {
    for (const key of group.keys) {
      setKeyframe(clip, group.channel, atTime + key.offset, key.value, key.ease);
      written += 1;
    }
  }
  return written;
}

/**
 * Summary used by the timeline to draw a keyframe density strip.
 * @param {import('./schema.js').Clip} clip
 * @returns {number[]} sorted unique key times
 */
export function allKeyTimes(clip) {
  const times = new Set();
  for (const entry of clip.keyframes) for (const key of entry.keys) times.add(Math.round(key.time * 1000) / 1000);
  return [...times].sort((a, b) => a - b);
}

/**
 * Sample a channel into `count` evenly spaced samples -- used by the graph
 * editor and by the mini curve previews in the inspector.
 * @param {import('./schema.js').Clip} clip
 * @param {string} channel
 * @param {number} start
 * @param {number} end
 * @param {number} count
 * @returns {Array<{time:number, value:number}>}
 */
export function sampleChannel(clip, channel, start, end, count) {
  /** @type {Array<{time:number, value:number}>} */
  const samples = [];
  const entry = findChannel(clip, channel);
  if (!entry || entry.keys.length === 0) return samples;
  const steps = Math.max(2, count);
  for (let i = 0; i < steps; i += 1) {
    const t = start + ((end - start) * i) / (steps - 1);
    samples.push({ time: t, value: evaluateKeys(entry.keys, t) });
  }
  return samples;
}

/**
 * Value range covered by a channel's keys (plus the base value), padded a
 * little so a flat line is still visible in the graph editor.
 * @param {import('./schema.js').Clip} clip
 * @param {string} channel
 * @param {number} base
 * @returns {{min:number, max:number}}
 */
export function channelRange(clip, channel, base) {
  const entry = findChannel(clip, channel);
  let min = base;
  let max = base;
  if (entry) {
    for (const key of entry.keys) {
      min = Math.min(min, key.value);
      max = Math.max(max, key.value);
    }
  }
  if (Math.abs(max - min) < 1e-6) {
    const pad = Math.max(0.5, Math.abs(max) * 0.2);
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.15;
  return { min: min - pad, max: max + pad };
}
