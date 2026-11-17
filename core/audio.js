/**
 * The audio-reactive model.
 *
 * Everything that connects sound to pixels lives here:
 *
 *  - `sampleAnalysis()` reads an analysed signal at any time, interpolating the
 *    stored envelope so a 30 fps composition can read a 43 Hz analysis.
 *  - `buildMappingCurves()` turns the project's mapping list into a
 *    *deterministic lookup table*, one value per composition frame per mapping.
 *
 * Why a table instead of a live filter? Attack/release smoothing is a recursive
 * filter, so its output depends on how it was stepped. Walking the table
 * forward from frame 0 makes the value at frame 812 a pure function of the
 * project and the audio -- a playback that starts mid-timeline, a scrub and an
 * export all produce the same number. It also makes the mapping panel's live
 * meter honest: the meter shows exactly what the renderer is using.
 *
 * Offline audio *mixing* (for export) lives in `mixAudio()` at the bottom.
 */

import { clamp, clamp01, mod } from './math.js';
import { defaultMapping, uid } from './schema.js';

/** @typedef {import('./schema.js').ProjectDoc} ProjectDoc */
/** @typedef {import('./schema.js').AudioMapping} AudioMapping */
/** @typedef {import('./schema.js').AudioAnalysis} AudioAnalysis */
/** @typedef {import('./schema.js').Clip} Clip */

/** Signals a mapping can read. */
export const BAND_CHOICES = Object.freeze([
  { value: 'level', label: 'Overall volume' },
  { value: 'low', label: 'Low / bass' },
  { value: 'mid', label: 'Mid' },
  { value: 'high', label: 'High' },
  { value: 'onset', label: 'Onset trigger' },
  { value: 'beat', label: 'Beat marker' },
]);

/**
 * @param {ProjectDoc} doc
 * @param {string} assetId
 * @returns {AudioAnalysis|undefined}
 */
export function analysisFor(doc, assetId) {
  return doc.audio[assetId];
}

/**
 * Effective marker list for an asset: suggested beats (or onsets) minus the
 * ones the user rejected, plus the ones they added by hand.
 * @param {ProjectDoc} doc
 * @param {string} assetId
 * @returns {number[]}
 */
export function markerTimes(doc, assetId) {
  const analysis = doc.audio[assetId];
  const removed = new Set(doc.audioSettings.removedMarkers.map((value) => Math.round(value * 1000)));
  const base = analysis ? (analysis.beats.length ? analysis.beats : analysis.onsets) : [];
  const merged = new Set(
    base
      .map((time) => Math.round((time + doc.audioSettings.offset) * 1000) / 1000)
      .filter((time) => time >= 0 && !removed.has(Math.round(time * 1000))),
  );
  for (const manual of doc.audioSettings.manualMarkers) {
    merged.add(Math.round((manual + doc.audioSettings.offset) * 1000) / 1000);
  }
  return [...merged].sort((a, b) => a - b);
}

/**
 * Linear sample of an analysis envelope at `time`, with the audio's user offset
 * applied. Values are clamped to 0..1.
 *
 * @param {AudioAnalysis} analysis
 * @param {'level'|'low'|'mid'|'high'} band
 * @param {number} time
 * @param {number} offset
 * @returns {number}
 */
export function sampleEnvelope(analysis, band, time, offset = 0) {
  const data = /** @type {any} */ (analysis)[band];
  if (!data || data.length === 0) return 0;
  const hopSeconds = Number(analysis.hopSeconds) > 0
    ? Number(analysis.hopSeconds)
    : analysis.duration / Math.max(1, data.length);
  const position = (time - offset) / hopSeconds;
  if (position <= 0) return clamp01(data[0]);
  if (position >= data.length - 1) return clamp01(data[data.length - 1]);
  const index = Math.floor(position);
  const fraction = position - index;
  return clamp01(data[index] + (data[index + 1] - data[index]) * fraction);
}

/**
 * Impulse response for onset/beat signals: an exponential decay starting at the
 * most recent event. Reads as a punchy trigger rather than a level.
 *
 * @param {number[]} times
 * @param {number} time
 * @param {number} decay seconds to fall to ~37%
 * @returns {number} 0..1
 */
export function impulseAt(times, time, decay = 0.16) {
  if (times.length === 0) return 0;
  let low = 0;
  let high = times.length - 1;
  if (time < times[0]) return 0;
  if (time >= times[high]) return Math.exp(-(time - times[high]) / decay);
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (times[mid] <= time) low = mid;
    else high = mid;
  }
  return Math.exp(-(time - times[low]) / decay);
}

/**
 * Raw (unmapped) value of a signal at a time.
 * @param {ProjectDoc} doc
 * @param {AudioMapping} mapping
 * @param {number} time Composition time in seconds.
 * @returns {number} 0..1
 */
export function rawSignal(doc, mapping, time) {
  const analysis = doc.audio[mapping.source];
  if (!analysis) return 0;
  const offset = doc.audioSettings.offset ?? 0;
  switch (mapping.band) {
    case 'onset':
      return impulseAt(analysis.onsets ?? [], time - offset, 0.14);
    case 'beat':
      return impulseAt(markerTimes(doc, mapping.source), time, 0.18);
    case 'low':
    case 'mid':
    case 'high':
    case 'level':
    default:
      return sampleEnvelope(analysis, /** @type {any} */ (mapping.band === 'level' ? 'level' : mapping.band), time, offset);
  }
}

/** @typedef {{value:number, raw:number}} CurveSample */

/**
 * @typedef {object} MappingCurve
 * @property {string} id
 * @property {string} target
 * @property {string} [clipId]
 * @property {string} mode
 * @property {Float32Array} values   One entry per composition frame.
 * @property {Float32Array} raws     Raw signal per frame (for the meter).
 * @property {number} frames
 */

/**
 * Precompute every mapping into a per-frame table.
 *
 * @param {ProjectDoc} doc
 * @param {{rangeStart?:number, rangeEnd?:number}} [options]
 * @returns {Map<string, MappingCurve>}
 */
export function buildMappingCurves(doc, options = {}) {
  /** @type {Map<string, MappingCurve>} */
  const curves = new Map();
  const fps = doc.composition.fps;
  const start = options.rangeStart ?? 0;
  const end = options.rangeEnd ?? doc.composition.duration;
  const frames = Math.max(1, Math.round((end - start) * fps) + 1);
  const dt = 1 / fps;

  for (const mapping of doc.mappings) {
    if (!mapping.enabled || !mapping.source) continue;
    const analysis = doc.audio[mapping.source];
    const values = new Float32Array(frames);
    const raws = new Float32Array(frames);
    let envelope = 0;

    for (let frame = 0; frame < frames; frame += 1) {
      const time = start + frame * dt;
      const raw = clamp01(rawSignal(doc, mapping, time));
      raws[frame] = raw;
      const sensitivity = Number.isFinite(mapping.sensitivity) ? mapping.sensitivity : 1;
      let driven = clamp01(raw * sensitivity);
      if (mapping.invert) driven = 1 - driven;

      // Asymmetric smoothing: attack when the signal rises, release when it
      // falls. Expressed in seconds so it is frame-rate independent.
      const tau = driven > envelope ? Math.max(1e-4, mapping.attack) : Math.max(1e-4, mapping.release);
      envelope = driven + (envelope - driven) * Math.exp(-dt / tau);
      if (!Number.isFinite(envelope)) envelope = driven;

      const min = Number.isFinite(mapping.min) ? mapping.min : 0;
      const max = Number.isFinite(mapping.max) ? mapping.max : 1;
      values[frame] = min + (max - min) * clamp01(envelope);
    }

    curves.set(mapping.id, {
      id: mapping.id,
      target: mapping.target,
      clipId: mapping.clipId,
      mode: mapping.mode ?? 'set',
      values,
      raws,
      frames,
    });
  }
  return curves;
}

/**
 * Look a curve up at a composition time, falling back to the nearest frame.
 * @param {MappingCurve} curve
 * @param {number} time
 * @param {number} fps
 * @param {number} [start]
 * @returns {number}
 */
export function curveValueAt(curve, time, fps, start = 0) {
  const index = Math.round((time - start) * fps);
  if (index <= 0) return curve.values[0] ?? 0;
  if (index >= curve.frames) return curve.values[curve.frames - 1] ?? 0;
  return curve.values[index];
}

/**
 * @param {MappingCurve} curve
 * @param {number} time
 * @param {number} fps
 * @param {number} [start]
 * @returns {number} the raw, unsmoothed signal -- what meters display
 */
export function curveRawAt(curve, time, fps, start = 0) {
  const index = Math.round((time - start) * fps);
  if (index <= 0) return curve.raws[0] ?? 0;
  if (index >= curve.frames) return curve.raws[curve.frames - 1] ?? 0;
  return curve.raws[index];
}

/**
 * Apply modulation to a channel's base value.
 *
 * `set` replaces (the common case: bass drives scale), `add` offsets (nudge a
 * position), `multiply` scales (gain-style control). The order between
 * mappings is the document order, so results are reproducible.
 *
 * @param {number} base
 * @param {string} channel
 * @param {MappingCurve[]} curves
 * @param {string} clipId
 * @param {number} time
 * @param {number} fps
 * @param {number} [rangeStart]
 * @param {number} [min]
 * @param {number} [max]
 * @returns {number}
 */
export function applyModulation(base, channel, curves, clipId, time, fps, rangeStart = 0, min = -Infinity, max = Infinity) {
  let value = base;
  for (const curve of curves) {
    if (curve.target !== channel) continue;
    if (curve.clipId && curve.clipId !== clipId) continue;
    const driven = curveValueAt(curve, time, fps, rangeStart);
    switch (curve.mode) {
      case 'add': value += driven; break;
      case 'multiply': value *= driven; break;
      case 'set':
      default: value = driven; break;
    }
  }
  return clamp(value, min, max);
}

/* ------------------------------------------------------------------ *
 * Analysis bookkeeping
 * ------------------------------------------------------------------ */

/**
 * Store an analysis result in the project, converting typed arrays to plain
 * arrays so the document stays JSON-serialisable.
 * @param {ProjectDoc} doc
 * @param {string} assetId
 * @param {ReturnType<import('./audioAnalysis.js').analyzeAudio>} result
 * @returns {AudioAnalysis}
 */
export function storeAnalysis(doc, assetId, result) {
  const analysis = {
    assetId,
    sampleRate: result.sampleRate,
    hop: result.hop,
    hopSeconds: result.hopSeconds,
    frames: result.frames,
    duration: result.duration,
    level: Array.from(result.level),
    low: Array.from(result.low),
    mid: Array.from(result.mid),
    high: Array.from(result.high),
    waveform: result.waveform,
    onsets: result.onsets,
    beats: result.beats,
    tempo: result.tempo,
    tempoConfidence: result.tempoConfidence,
    analysedAt: Date.now(),
  };
  doc.audio[assetId] = /** @type {any} */ (analysis);
  return /** @type {any} */ (analysis);
}

/**
 * Peak level of an analysis across all bands -- used by the library to show an
 * "analysed" state without decoding anything.
 * @param {AudioAnalysis|undefined} analysis
 * @returns {{rms:number, peak:number}}
 */
export function analysisSummary(analysis) {
  if (!analysis || !analysis.level || analysis.level.length === 0) return { rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  for (const value of analysis.level) {
    sum += value * value;
    if (value > peak) peak = value;
  }
  return { rms: Math.sqrt(sum / analysis.level.length), peak };
}

/* ------------------------------------------------------------------ *
 * Offline mixing (export)
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} MixClip
 * @property {number} start
 * @property {number} duration
 * @property {number} inPoint
 * @property {number} volume
 * @property {number} pan
 * @property {number} fadeIn
 * @property {number} fadeOut
 * @property {boolean} muted
 * @property {string} [assetId]
 * @property {string} [bufferKey]
 */

/**
 * Mix all audio clips into an interleaved stereo buffer.
 *
 * Runs on the server during export (samples are supplied by the caller) and in
 * the browser for the "render audio only" verification. Clips are summed with
 * their gain, pan and fades, then a gentle soft-clip limiter keeps the result
 * inside [-1, 1] without hard distortion.
 *
 * @param {object} options
 * @param {MixClip[]} options.clips
 * @param {Record<string, {left:Float32Array, right:Float32Array, sampleRate:number}>} options.sources
 * @param {number} options.sampleRate
 * @param {number} options.start    Range start in seconds.
 * @param {number} options.duration Range duration in seconds.
 * @param {number} [options.masterGain]
 * @returns {{left:Float32Array, right:Float32Array, sampleRate:number}}
 */
export function mixAudio({ clips, sources, sampleRate, start, duration, masterGain = 1 }) {
  const frames = Math.max(1, Math.round(duration * sampleRate));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);

  for (const clip of clips) {
    if (clip.muted || !clip.assetId) continue;
    const source = sources[clip.assetId];
    if (!source) continue;
    const clipEnd = clip.start + clip.duration;
    const from = Math.max(clip.start, start);
    const to = Math.min(clipEnd, start + duration);
    if (to <= from) continue;

    const clipPan = clamp(clip.pan ?? 0, -1, 1);
    // Equal-power pan: centre -3 dB, hard pan puts everything on one side.
    const angle = ((clipPan + 1) * Math.PI) / 4;
    const leftGain = Math.cos(angle) * (clip.volume ?? 1);
    const rightGain = Math.sin(angle) * (clip.volume ?? 1);

    const firstFrame = Math.round((from - start) * sampleRate);
    const lastFrame = Math.min(frames, Math.round((to - start) * sampleRate));

    for (let frame = firstFrame; frame < lastFrame; frame += 1) {
      const time = start + frame / sampleRate;
      const local = time - clip.start;
      const sourceTime = clip.inPoint + local;
      const sourceIndex = Math.round(sourceTime * source.sampleRate);
      if (sourceIndex < 0) continue;

      let gain = 1;
      if (clip.fadeIn > 0) gain = Math.min(gain, clamp01(local / clip.fadeIn));
      if (clip.fadeOut > 0) gain = Math.min(gain, clamp01((clip.duration - local) / clip.fadeOut));
      if (gain <= 0) continue;

      const sampleLeft = sourceIndex < source.left.length ? source.left[sourceIndex] : 0;
      const sampleRight = sourceIndex < source.right.length ? source.right[sourceIndex] : sampleLeft;
      left[frame] += sampleLeft * leftGain * gain;
      right[frame] += sampleRight * rightGain * gain;
    }
  }

  const gain = Number.isFinite(masterGain) ? masterGain : 1;
  for (let frame = 0; frame < frames; frame += 1) {
    left[frame] = softClip(left[frame] * gain);
    right[frame] = softClip(right[frame] * gain);
  }
  return { left, right, sampleRate };
}

/**
 * @param {number} value
 * @returns {number}
 */
function softClip(value) {
  if (value > 1) return 1 - Math.exp(-(value - 1) * 0.5) * 0.2;
  if (value < -1) return -1 + Math.exp(-(-value - 1) * 0.5) * 0.2;
  return value;
}

/* ------------------------------------------------------------------ *
 * Small helpers used by the UI
 * ------------------------------------------------------------------ */

/**
 * Create a mapping with sensible defaults for a target channel spec.
 * @param {string} assetId
 * @param {string} target
 * @param {Partial<AudioMapping>} [patch]
 * @returns {AudioMapping}
 */
export function createMapping(assetId, target, patch = {}) {
  const mapping = defaultMapping({ source: assetId, target, ...patch });
  mapping.id = uid('map');
  return mapping;
}

/**
 * Suggested default output range for a channel, so a new connection does
 * something visible instead of nothing.
 * @param {{base:number, min:number, max:number}} spec
 * @param {string} band
 * @returns {{min:number, max:number}}
 */
export function suggestRange(spec, band) {
  const base = spec.base;
  const span = Math.max(1e-3, spec.max - spec.min);
  if (band === 'onset' || band === 'beat') {
    return { min: base, max: base + span * 0.08 };
  }
  if (Math.abs(base) > 1e-6 && base * 1.6 <= spec.max && base * 0.4 >= spec.min) {
    return { min: base * 0.9, max: base * 1.35 };
  }
  return { min: base, max: base + span * 0.25 };
}

/**
 * Where in the timeline a marker falls, snapped to the composition grid.
 * @param {number} time
 * @param {number} fps
 * @returns {number}
 */
export function snapMarker(time, fps) {
  return Math.round(time * fps) / fps;
}

/**
 * Wrap a time into the loop range.
 * @param {number} time
 * @param {{in:number,out:number}} range
 * @returns {number}
 */
export function wrapTime(time, range) {
  const span = range.out - range.in;
  if (span <= 0) return range.in;
  return range.in + mod(time - range.in, span);
}
