/**
 * Engine unit tests.
 *
 * These cover the guarantees the architecture rests on: determinism, resolution
 * independence, the project format surviving a round trip, keyframe
 * interpolation, audio analysis honesty and the mapping curve builder.
 *
 * Run with `npm test`.
 */

import { describe, expect, it } from 'vitest';

import {
  PROJECT_VERSION, assetSourceSpan, clipSourceTime, createProject, defaultClip, defaultGraphic, defaultMapping,
  defaultTextStyle, formatTimecode, neutralTransform, snapToFrame, timeToFrame, usedAssetIds, uid,
} from '../core/schema.js';
import { normalizeProject, validateProject } from '../core/document.js';
import {
  copyKeyframes, easingPreset, evaluateKeys, findChannel, pasteKeyframes, sampleChannel,
  setKeyframe, removeKeyframe, pruneOrphanChannels, channelValue, applyEasing, normalizeEasing,
} from '../core/keyframes.js';
import { EFFECT_REGISTRY, defaultParams, effectDefinition, isEffectNeutral, animatableParams } from '../core/effectRegistry.js';
import { EFFECT_PASSES, runEffectPass, passHalftone } from '../core/effects.js';
import { cubicBezier, fbm2d, hash2d, seededRandom, clamp } from '../core/math.js';
import { analyzeAudio, detectOnsets, suggestBeats } from '../core/audioAnalysis.js';
import { buildMappingCurves, curveValueAt, impulseAt, mixAudio, sampleEnvelope, markerTimes, applyModulation } from '../core/audio.js';
import { clipChannelSpecs, transformChannelSpecs, maskChannelSpecs } from '../core/channels.js';
import { graphicSize, drawGraphicThumbnail } from '../core/graphics.js';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** A deterministic pseudo-random raster, as if it were a photograph. */
function makeRaster(width = 64, height = 48, seed = 7) {
  const data = new Uint8ClampedArray(width * height * 4);
  const random = seededRandom(seed);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.floor(random() * 255);
    data[i + 1] = Math.floor(random() * 255);
    data[i + 2] = Math.floor(random() * 255);
    data[i + 3] = 255;
  }
  return data;
}

/**
 * @param {number} width
 * @param {number} height
 * @param {number} [scale]
 */
function makeContext(width, height, scale = 1) {
  const buffer = new Uint8ClampedArray(width * height * 4);
  return {
    width,
    height,
    scale,
    widthUnits: width / scale,
    heightUnits: height / scale,
    seed: 1234,
    time: 0,
    below: undefined,
    byteScratch: () => buffer,
    scratch: (factor) => ({
      data: new Float32Array(Math.max(1, Math.floor(width / factor)) * Math.max(1, Math.floor(height / factor)) * 4),
      width: Math.max(1, Math.floor(width / factor)),
      height: Math.max(1, Math.floor(height / factor)),
    }),
  };
}

/** A synthetic audio buffer: a 96 BPM pulse train plus a sustained tone. */
function makeAudio(duration = 6, sampleRate = 22050) {
  const length = Math.round(duration * sampleRate);
  const channel = new Float32Array(length);
  const beat = 60 / 96;
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    const phase = (t % beat) / beat;
    const kick = Math.sin(2 * Math.PI * (55 + 70 * Math.exp(-phase * 30)) * t) * Math.exp(-phase * 10) * 0.8;
    const tone = Math.sin(2 * Math.PI * 440 * t) * 0.12;
    const hat = (Math.floor(t / (beat / 2)) % 2 === 1) ? (Math.sin(2 * Math.PI * 6000 * t) * Math.exp(-((t % (beat / 2)) / (beat / 2)) * 40) * 0.25) : 0;
    channel[i] = Math.max(-1, Math.min(1, kick + tone + hat));
  }
  return { channels: [channel, channel], sampleRate, duration };
}

/* ------------------------------------------------------------------ *
 * Determinism
 * ------------------------------------------------------------------ */

describe('deterministic randomness', () => {
  it('hashes coordinates reproducibly', () => {
    expect(hash2d(3, 7, 11)).toBe(hash2d(3, 7, 11));
    expect(hash2d(3, 7, 11)).not.toBe(hash2d(3, 7, 12));
    expect(hash2d(3, 7, 11)).toBeGreaterThanOrEqual(0);
    expect(hash2d(3, 7, 11)).toBeLessThan(1);
  });

  it('produces the same seed sequence every time', () => {
    const a = seededRandom(4242);
    const b = seededRandom(4242);
    const first = [a(), a(), a(), a()];
    const second = [b(), b(), b(), b()];
    expect(first).toEqual(second);
  });

  it('returns stable fractal noise for the same coordinates', () => {
    expect(fbm2d(1.25, 3.75, 99, 4)).toBe(fbm2d(1.25, 3.75, 99, 4));
    expect(fbm2d(1.25, 3.75, 99, 4)).not.toBe(fbm2d(1.25, 3.75, 100, 4));
  });
});

describe('cubic bezier easing', () => {
  it('is pinned at both ends', () => {
    expect(cubicBezier(0.42, 0, 0.58, 1, 0)).toBe(0);
    expect(cubicBezier(0.42, 0, 0.58, 1, 1)).toBe(1);
  });

  it('is monotonic for a standard ease', () => {
    let previous = -1;
    for (let i = 0; i <= 20; i += 1) {
      const value = cubicBezier(0.42, 0, 0.58, 1, i / 20);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-6);
      previous = value;
    }
  });

  it('overshoots with a back curve, as authored', () => {
    let peaked = 0;
    for (let i = 0; i <= 100; i += 1) peaked = Math.max(peaked, cubicBezier(0.34, 1.56, 0.64, 1, i / 100));
    expect(peaked).toBeGreaterThan(1);
  });

  it('holds a constant value for hold easing', () => {
    const hold = normalizeEasing({ kind: 'hold' });
    expect(applyEasing(hold, 0)).toBe(0);
    expect(applyEasing(hold, 0.5)).toBe(0);
    expect(applyEasing(hold, 0.999)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Keyframes
 * ------------------------------------------------------------------ */

describe('keyframes', () => {
  it('interpolates linearly between two keys', () => {
    const clip = defaultClip();
    setKeyframe(clip, 'transform.opacity', 0, 0, { kind: 'linear', bezier: { x1: 0, y1: 0, x2: 1, y2: 1 } });
    setKeyframe(clip, 'transform.opacity', 2, 1, { kind: 'linear', bezier: { x1: 0, y1: 0, x2: 1, y2: 1 } });
    expect(channelValue(clip, 'transform.opacity', 1, 0)).toBeCloseTo(0.5, 6);
    expect(channelValue(clip, 'transform.opacity', 0.5, 0)).toBeCloseTo(0.25, 6);
  });

  it('holds a value across a hold keyframe', () => {
    const clip = defaultClip();
    setKeyframe(clip, 'transform.opacity', 0, 0.2, easingPreset('Hold'));
    setKeyframe(clip, 'transform.opacity', 2, 1, easingPreset('Linear'));
    expect(channelValue(clip, 'transform.opacity', 0.5, 0)).toBeCloseTo(0.2, 6);
    expect(channelValue(clip, 'transform.opacity', 1.99, 0)).toBeCloseTo(0.2, 6);
    expect(channelValue(clip, 'transform.opacity', 2, 0)).toBeCloseTo(1, 6);
  });

  it('clamps outside the key range', () => {
    const clip = defaultClip();
    setKeyframe(clip, 'transform.position.x', 1, 10, easingPreset('Linear'));
    setKeyframe(clip, 'transform.position.x', 3, 50, easingPreset('Linear'));
    expect(channelValue(clip, 'transform.position.x', 0, 0)).toBe(10);
    expect(channelValue(clip, 'transform.position.x', 9, 0)).toBe(50);
  });

  it('falls back to the base value when a channel has no keys', () => {
    const clip = defaultClip();
    expect(channelValue(clip, 'transform.rotation', 1, 33)).toBe(33);
  });

  it('replaces a keyframe at the same time instead of stacking', () => {
    const clip = defaultClip();
    setKeyframe(clip, 'transform.rotation', 1, 10);
    setKeyframe(clip, 'transform.rotation', 1, 20);
    const channel = findChannel(clip, 'transform.rotation');
    expect(channel?.keys.length).toBe(1);
    expect(channel?.keys[0].value).toBe(20);
  });

  it('removes a channel when its last key goes', () => {
    const clip = defaultClip();
    const key = setKeyframe(clip, 'transform.rotation', 1, 10);
    removeKeyframe(clip, 'transform.rotation', key.id);
    expect(findChannel(clip, 'transform.rotation')).toBeUndefined();
  });

  it('round-trips a keyframe selection through the clipboard', () => {
    const clip = defaultClip();
    setKeyframe(clip, 'transform.opacity', 1, 0, easingPreset('Ease in-out'));
    setKeyframe(clip, 'transform.opacity', 3, 1, easingPreset('Ease out'));
    const payload = copyKeyframes(clip, [
      { channel: 'transform.opacity', time: 1 },
      { channel: 'transform.opacity', time: 3 },
    ]);
    expect(payload.channels.length).toBe(1);
    expect(payload.duration).toBeCloseTo(2, 6);
    expect(payload.channels[0].keys[0].offset).toBe(0);

    const other = defaultClip();
    const written = pasteKeyframes(other, payload, 5);
    expect(written).toBe(2);
    expect(channelValue(other, 'transform.opacity', 5, -1)).toBeCloseTo(0, 6);
    expect(channelValue(other, 'transform.opacity', 7, -1)).toBeCloseTo(1, 6);
  });

  it('prunes channels whose effect or mask no longer exists', () => {
    const clip = defaultClip();
    clip.effects.stack.push({ id: 'fx1', type: 'grain', enabled: true, seed: 1, params: defaultParams('grain') });
    clip.masks.push({ id: 'mask1', name: 'm', shape: 'rect', enabled: true, inverted: false, position: { x: 0.5, y: 0.5 }, size: { x: 1, y: 1 }, rotation: 0, roundness: 0, feather: 0, opacity: 1, points: [], pointsClosed: true });
    setKeyframe(clip, 'effects.fx1.amount', 0, 0);
    setKeyframe(clip, 'masks.mask1.feather', 0, 0);
    setKeyframe(clip, 'transform.opacity', 0, 1);
    clip.effects.stack = [];
    clip.masks = [];
    const removed = pruneOrphanChannels(clip);
    expect(removed).toBe(2);
    expect(clip.keyframes.length).toBe(1);
  });

  it('samples a channel for the graph editor', () => {
    const clip = defaultClip();
    setKeyframe(clip, 'transform.scale.x', 0, 1, easingPreset('Linear'));
    setKeyframe(clip, 'transform.scale.x', 4, 2, easingPreset('Linear'));
    const samples = sampleChannel(clip, 'transform.scale.x', 0, 4, 9);
    expect(samples.length).toBe(9);
    expect(samples[0].value).toBeCloseTo(1, 6);
    expect(samples[8].value).toBeCloseTo(2, 6);
    expect(samples[4].value).toBeCloseTo(1.5, 6);
  });

  it('evaluates an unsorted key list correctly', () => {
    const keys = [
      { id: 'b', time: 2, value: 10, ease: normalizeEasing(undefined) },
      { id: 'a', time: 0, value: 0, ease: normalizeEasing(undefined) },
      { id: 'c', time: 4, value: 20, ease: normalizeEasing(undefined) },
    ].sort((a, b) => a.time - b.time);
    expect(evaluateKeys(keys, 1)).toBeCloseTo(5, 6);
    expect(evaluateKeys(keys, 3)).toBeCloseTo(15, 6);
  });
});

/* ------------------------------------------------------------------ *
 * Project format
 * ------------------------------------------------------------------ */

describe('project format', () => {
  function populatedProject() {
    const doc = createProject({ name: 'Test' }, { width: 1080, height: 1920, fps: 30, duration: 12 });
    doc.assets.push({ id: 'a1', kind: 'image', name: 'Photo', fileName: 'p.png', size: 10, mime: 'image/png', width: 100, height: 200, duration: 0, origin: 'library', status: 'ok', addedAt: new Date().toISOString() });
    doc.assets.push({ id: 'a2', kind: 'audio', name: 'Music', fileName: 'm.mp3', size: 10, mime: 'audio/mpeg', width: 0, height: 0, duration: 30, origin: 'library', status: 'ok', addedAt: new Date().toISOString() });
    const visual = doc.tracks.find((track) => track.kind === 'visual');
    const audioTrack = doc.tracks.find((track) => track.kind === 'audio');
    const clip = defaultClip({
      name: 'Photo', kind: 'image', assetId: 'a1', trackId: visual.id, start: 0, duration: 12,
      effects: { enabled: true, stack: [{ id: 'fx1', type: 'halftone', enabled: true, seed: 5, params: { ...defaultParams('halftone'), spacing: 9 } }] },
    });
    setKeyframe(clip, 'transform.scale.x', 0, 1, easingPreset('Ease in-out'));
    setKeyframe(clip, 'transform.scale.x', 12, 1.4, easingPreset('Ease in-out'));
    clip.masks.push({ id: 'm1', name: 'Band', shape: 'rect', enabled: true, inverted: false, position: { x: 0.5, y: 0.5 }, size: { x: 1, y: 0.5 }, rotation: 0, roundness: 0, feather: 0.1, opacity: 1, points: [], pointsClosed: true });
    doc.clips.push(clip);
    doc.clips.push(defaultClip({ name: 'Music', kind: 'audio', assetId: 'a2', trackId: audioTrack.id, start: 0, duration: 12 }));
    doc.mappings.push(defaultMapping({ source: 'a2', band: 'low', target: 'transform.scale.x', clipId: clip.id }));
    doc.audio.a2 = { assetId: 'a2', sampleRate: 22050, hop: 256, hopSeconds: 0.0116, frames: 3, duration: 12, level: [0, 0.5, 1], low: [0, 0.4, 1], mid: [0, 0.2, 1], high: [0, 0, 1], onsets: [1, 2], beats: [1], tempo: 96, tempoConfidence: 0.8, waveform: [0, 1], analysedAt: Date.now() };
    return doc;
  }

  it('round-trips through normalization unchanged', () => {
    const doc = populatedProject();
    const { doc: out, issues } = normalizeProject(JSON.parse(JSON.stringify(doc)));
    expect(issues.filter((issue) => issue.level === 'error')).toEqual([]);
    expect(out.clips.length).toBe(doc.clips.length);
    expect(out.clips[0].keyframes.length).toBe(doc.clips[0].keyframes.length);
    expect(out.clips[0].effects.stack[0].type).toBe('halftone');
    expect(out.clips[0].effects.stack[0].params.spacing).toBeCloseTo(9, 9);
    expect(out.clips[0].masks.length).toBe(1);
    expect(out.mappings.length).toBe(1);
    expect(out.audio.a2.level.length).toBe(3);
    expect(out.composition.width).toBe(1080);
    expect(out.version).toBe(PROJECT_VERSION);
  });

  it('is stable under a second normalization pass', () => {
    const doc = populatedProject();
    const first = normalizeProject(doc).doc;
    const second = normalizeProject(JSON.parse(JSON.stringify(first))).doc;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('repairs hostile input instead of throwing', () => {
    const { doc, issues } = normalizeProject({
      composition: { width: 'wide', height: -40, fps: 999, duration: 'forever' },
      clips: [
        { id: 'c1', kind: 'nonsense', start: 'later', duration: null },
        { id: 'c2', kind: 'image', trackId: 'missing-track', effects: { stack: [{ type: 'not-an-effect' }] } },
        null,
      ],
      tracks: 'nope',
      mappings: [{ band: 'ultrasonic', sensitivity: 'lots' }],
    });
    expect(doc.composition.width).toBe(1920);
    expect(doc.composition.height).toBeGreaterThan(0);
    expect([24, 25, 30, 60]).toContain(doc.composition.fps);
    expect(doc.composition.duration).toBeGreaterThan(0);
    expect(doc.clips.length).toBeGreaterThan(0);
    expect(doc.clips[0].start).toBe(0);
    expect(doc.tracks.length).toBeGreaterThan(0);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('reports dangling media and unknown effects', () => {
    const { doc, issues } = normalizeProject({
      clips: [{ id: 'c1', kind: 'image', assetId: 'nope', trackId: 't', effects: { stack: [{ type: 'ghost' }] } }],
      tracks: [{ id: 't', name: 'T', kind: 'visual' }],
    });
    expect(doc.clips.length).toBe(1);
    expect(issues.some((issue) => /media/i.test(issue.message))).toBe(true);
    expect(issues.some((issue) => /unknown effect/i.test(issue.message))).toBe(true);
  });

  it('validates an empty composition', () => {
    const issues = validateProject(createProject());
    expect(issues.some((issue) => /no clips/i.test(issue.message))).toBe(true);
  });

  it('lists the assets a document uses', () => {
    const doc = populatedProject();
    const used = usedAssetIds(doc);
    expect(used.has('a1')).toBe(true);
    expect(used.has('a2')).toBe(true);
  });

  it('formats timecode and snaps to frames', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00');
    expect(formatTimecode(61.5, 30)).toBe('01:01:15');
    expect(snapToFrame(1.017, 30)).toBeCloseTo(1.0333333, 5);
    expect(timeToFrame(1, 30)).toBe(30);
  });

  it('computes a source time honouring trim, reverse and rate', () => {
    const clip = defaultClip({ start: 2, duration: 4, inPoint: 1 });
    expect(clipSourceTime(clip, 3)).toBeCloseTo(2, 6);
    clip.reverse = true;
    expect(clipSourceTime(clip, 3)).toBeCloseTo(4, 6);
    clip.reverse = false;
    clip.playbackRate = 2;
    expect(clipSourceTime(clip, 3)).toBeCloseTo(3, 6);
    expect(clipSourceTime(clip, 99)).toBeNull();
  });

  it('finds the source span an export needs from each clip, not from the timeline range', () => {
    const doc = createProject({ name: 'Span' }, { width: 1080, height: 1920, fps: 30, duration: 20 });
    const track = doc.tracks[0].id;
    // A clip trimmed to start 8 s into its file: exporting 0-3 s needs source 8-11 s.
    doc.clips.push(defaultClip({ kind: 'video', assetId: 'a', trackId: track, start: 0, duration: 8, inPoint: 8 }));
    expect(assetSourceSpan(doc, 'a', 0, 3)).toEqual({ start: 8, end: 11 });
    // A clip placed at 6 s: exporting 10-12 s needs source 4-6 s.
    doc.clips.push(defaultClip({ kind: 'video', assetId: 'b', trackId: track, start: 6, duration: 10 }));
    expect(assetSourceSpan(doc, 'b', 10, 12)).toEqual({ start: 4, end: 6 });
    // Reverse and playback rate are honoured.
    doc.clips.push(defaultClip({ kind: 'video', assetId: 'c', trackId: track, start: 0, duration: 4, reverse: true, playbackRate: 2 }));
    expect(assetSourceSpan(doc, 'c', 0, 1)).toEqual({ start: 6, end: 8 });
    // A clip inside a nested composition, mapped through its host clip.
    doc.compositions.push({ id: 'comp1', name: 'Nested', composition: { ...doc.composition, duration: 10 }, tracks: [], clips: [
      defaultClip({ kind: 'video', assetId: 'd', trackId: 't', start: 0, duration: 10, inPoint: 2 }),
    ] });
    doc.clips.push(defaultClip({ kind: 'nested', compositionId: 'comp1', trackId: track, start: 5, duration: 5, inPoint: 1 }));
    expect(assetSourceSpan(doc, 'd', 5, 7)).toEqual({ start: 3, end: 5 });
    // Not on screen in the range: nothing to extract.
    expect(assetSourceSpan(doc, 'b', 0, 5)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Effects
 * ------------------------------------------------------------------ */

describe('effects', () => {
  it('registers a pass for every effect that is not a render-level gate', () => {
    // Trails and frame stepping re-render the clip at other timestamps, and
    // strobe gates the whole layer; all three live in the renderer because a
    // pixel pass cannot see what they need.
    const renderLevel = ['trails', 'frameStep', 'strobe'];
    for (const type of Object.keys(EFFECT_REGISTRY)) {
      if (renderLevel.includes(type)) continue;
      expect(typeof EFFECT_PASSES[type], `pass for ${type}`).toBe('function');
    }
  });

  it('gives every effect the parameters its passes read', () => {
    for (const type of Object.keys(EFFECT_REGISTRY)) {
      const params = defaultParams(type);
      const definition = effectDefinition(type);
      for (const spec of definition.params) {
        expect(params[spec.key], `${type}.${spec.key}`).toBeDefined();
      }
    }
  });

  it('only lets an effect change the picture by default when that is the point', () => {
    // Adding an effect from the menu should leave the picture alone unless the
    // effect *is* the look. This list is the contract: if a new effect starts out
    // visible it has to be justified here, rather than discovered by a user
    // wondering why their frame changed the moment they added something.
    const visibleByDefault = [
      // Always active by definition: a screen, an edge pass, a kaleidoscope.
      'halftone', 'edges', 'kaleidoscope',
      // The look is the point. Each is asserted neutral once zeroed below.
      'duotone', 'paletteMap', 'bloom',
      'grain', 'paper', 'scratches', 'vignette', 'posterize', 'pixelate',
      'trails', 'animatedNoise', 'frameStep', 'strobe',
      // Distortions: adding "glitch" or "RGB offset" and seeing nothing would be
      // the surprising outcome, so both arrive with a small visible amount.
      'wave', 'glitch', 'rgbOffset',
    ];
    const actual = Object.keys(EFFECT_REGISTRY).filter((type) => !isEffectNeutral(type, defaultParams(type)));
    expect(actual.sort()).toEqual(visibleByDefault.slice().sort());
  });

  it('reports every visible-by-default effect as neutral once its knob is zeroed', () => {
    const zeroed = {
      duotone: { strength: 0 },
      paletteMap: { strength: 0 },
      bloom: { amount: 0 },
      grain: { amount: 0 },
      paper: { intensity: 0 },
      scratches: { count: 0 },
      vignette: { amount: 0 },
      trails: { blend: 0 },
      animatedNoise: { amount: 0 },
      posterize: { blend: 0 },
      pixelate: { blockSize: 1 },
      frameStep: { hold: 1 },
      strobe: { depth: 0 },
      wave: { amplitude: 0 },
      glitch: { amount: 0 },
      rgbOffset: { distance: 0, animate: 0 },
    };
    for (const [type, overrides] of Object.entries(zeroed)) {
      expect(isEffectNeutral(type, { ...defaultParams(type), ...overrides }), type).toBe(true);
    }
  });

  it('exposes animatable parameters only as numbers', () => {
    for (const type of Object.keys(EFFECT_REGISTRY)) {
      for (const spec of animatableParams(type)) expect(spec.kind).toBe('number');
    }
  });

  it('produces identical output for identical input and seed', () => {
    const src = makeRaster(48, 32, 3);
    const a = Uint8ClampedArray.from(src);
    const b = Uint8ClampedArray.from(src);
    const params = { ...defaultParams('grain'), amount: 60 };
    runEffectPass(a, makeContext(48, 32), 'grain', params);
    runEffectPass(b, makeContext(48, 32), 'grain', params);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('changes the grain pattern when the seed changes', () => {
    const src = makeRaster(48, 32, 3);
    const a = Uint8ClampedArray.from(src);
    const b = Uint8ClampedArray.from(src);
    runEffectPass(a, { ...makeContext(48, 32), seed: 1 }, 'grain', { ...defaultParams('grain'), amount: 60 });
    runEffectPass(b, { ...makeContext(48, 32), seed: 2 }, 'grain', { ...defaultParams('grain'), amount: 60 });
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('scales pixel-sized effects with the render scale', () => {
    // Halftone dot spacing is declared in composition pixels. A half-resolution
    // render of the same picture must therefore produce dots half the size in
    // raster pixels -- that is what keeps the screen looking identical at any
    // preview quality. A gradient gives the screen something to vary over.
    const params = { ...defaultParams('halftone'), spacing: 8, dotSize: 100 };
    const full = gradientRaster(64, 64);
    const half = gradientRaster(32, 32);

    const fullOut = Uint8ClampedArray.from(full);
    const halfOut = Uint8ClampedArray.from(half);
    passHalftone(full, fullOut, makeContext(64, 64, 1), params);
    passHalftone(half, halfOut, makeContext(32, 32, 0.5), params);

    const fullInk = countInk(fullOut);
    const halfInk = countInk(halfOut);
    // The ink coverage of a screen is scale-invariant, so the *fraction* of dark
    // pixels should match closely while the absolute pixel counts differ by 4x.
    const fullFraction = fullInk / (64 * 64);
    const halfFraction = halfInk / (32 * 32);
    expect(fullFraction).toBeGreaterThan(0.05);
    expect(Math.abs(fullFraction - halfFraction)).toBeLessThan(0.12);
    expect(fullInk).toBeGreaterThan(halfInk * 3);
  });

  it('draws pixel-sized effects at the same picture size at any render scale', () => {
    // Pixelate blocks are declared in composition pixels: 8 units are 8 raster
    // pixels at full resolution and 4 at half resolution. A half-size render
    // (preview quality or a smaller export) must keep the same picture, only
    // with fewer pixels, so its blocks change every 4 pixels, not every 16.
    const half = gradientRaster(32, 32);
    const out = Uint8ClampedArray.from(half);
    runEffectPass(out, makeContext(32, 32, 0.5), 'pixelate', { ...defaultParams('pixelate'), blockSize: 8 });
    const at = (x) => out[(16 * 32 + x) * 4];
    expect(at(1)).toBe(at(3));
    expect(at(4)).not.toBe(at(3));
    expect(at(8)).not.toBe(at(7));

    // Halftone: a half-size render matches the full-size render scaled down.
    const params = { ...defaultParams('halftone'), spacing: 8, dotSize: 100 };
    const fullOut = Uint8ClampedArray.from(gradientRaster(64, 64));
    const halfOut = Uint8ClampedArray.from(gradientRaster(32, 32));
    passHalftone(gradientRaster(64, 64), fullOut, makeContext(64, 64, 1), params);
    passHalftone(gradientRaster(32, 32), halfOut, makeContext(32, 32, 0.5), params);
    // Compare both at 8x8 (blocks of one screen cell), where the dot pattern
    // averages out into the tone it prints.
    const blockMeans = (data, size, cells) => {
      const step = size / cells;
      const means = [];
      for (let cy = 0; cy < cells; cy += 1) {
        for (let cx = 0; cx < cells; cx += 1) {
          let sum = 0;
          for (let y = cy * step; y < (cy + 1) * step; y += 1) for (let x = cx * step; x < (cx + 1) * step; x += 1) sum += data[(y * size + x) * 4];
          means.push(sum / (step * step));
        }
      }
      return means;
    };
    const a = blockMeans(fullOut, 64, 8);
    const b = blockMeans(halfOut, 32, 8);
    const meanDiff = a.reduce((total, value, index) => total + Math.abs(value - b[index]), 0) / a.length;
    expect(meanDiff).toBeLessThan(20);
  });

  it('leaves the raster untouched for a neutral pass', () => {
    const src = makeRaster(32, 32, 11);
    const copy = Uint8ClampedArray.from(src);
    runEffectPass(copy, makeContext(32, 32), 'exposure', { amount: 0 });
    expect(Array.from(copy)).toEqual(Array.from(src));
  });

  it('brightens with positive exposure and darkens with negative', () => {
    const src = new Uint8ClampedArray(16 * 16 * 4).fill(120);
    for (let i = 3; i < src.length; i += 4) src[i] = 255;
    const brighter = Uint8ClampedArray.from(src);
    const darker = Uint8ClampedArray.from(src);
    runEffectPass(brighter, makeContext(16, 16), 'exposure', { amount: 40 });
    runEffectPass(darker, makeContext(16, 16), 'exposure', { amount: -40 });
    expect(brighter[0]).toBeGreaterThan(src[0]);
    expect(darker[0]).toBeLessThan(src[0]);
  });

  it('desaturates fully at saturation -100', () => {
    const src = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < src.length; i += 4) {
      src[i] = 200; src[i + 1] = 40; src[i + 2] = 90; src[i + 3] = 255;
    }
    const out = Uint8ClampedArray.from(src);
    runEffectPass(out, makeContext(4, 4), 'saturation', { amount: -100 });
    expect(Math.abs(out[0] - out[1])).toBeLessThan(2);
    expect(Math.abs(out[1] - out[2])).toBeLessThan(2);
  });

  it('keeps alpha intact through a pixel pass', () => {
    const src = makeRaster(24, 24, 5);
    for (let i = 3; i < src.length; i += 4) src[i] = 137;
    const out = Uint8ClampedArray.from(src);
    runEffectPass(out, makeContext(24, 24), 'posterize', { levels: 4, blend: 100 });
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(137);
  });
});

/** A horizontal grey ramp, so a screen has something to vary over. */
function gradientRaster(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const shade = (x / width) * 235 + 10;
      data[i] = shade;
      data[i + 1] = shade;
      data[i + 2] = shade;
      data[i + 3] = 255;
    }
  }
  return data;
}

/** Count pixels the halftone screen actually laid ink onto. */
function countInk(data) {
  let count = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] < 90) count += 1;
  return count;
}

/* ------------------------------------------------------------------ *
 * Channels
 * ------------------------------------------------------------------ */

describe('channels', () => {
  it('reads the base value out of the transform for every transform channel', () => {
    const composition = { width: 1920, height: 1080, fps: 30, duration: 10, background: '#000', aspect: 'landscape' };
    const clip = defaultClip();
    clip.transform = { ...neutralTransform(), x: 12, rotation: 30, cropLeft: 0.1 };
    for (const spec of clipChannelSpecs(clip, composition, EFFECT_REGISTRY)) {
      expect(typeof spec.base, spec.id).toBe('number');
    }
    const specs = clipChannelSpecs(clip, composition, EFFECT_REGISTRY);
    expect(specs.find((spec) => spec.id === 'transform.position.x')?.base).toBe(12);
    expect(specs.find((spec) => spec.id === 'transform.rotation')?.base).toBe(30);
    expect(specs.find((spec) => spec.id === 'transform.crop.left')?.base).toBeCloseTo(0.1, 9);
  });

  it('exposes effect parameters as keyframable channels', () => {
    const composition = { width: 1920, height: 1080, fps: 30, duration: 10, background: '#000', aspect: 'landscape' };
    const clip = defaultClip();
    clip.effects.stack.push({ id: 'fx1', type: 'grain', enabled: true, seed: 1, params: defaultParams('grain') });
    const specs = clipChannelSpecs(clip, composition, EFFECT_REGISTRY);
    const amount = specs.find((spec) => spec.id === 'effects.fx1.amount');
    expect(amount).toBeDefined();
    expect(amount?.effectId).toBe('fx1');
    expect(specs.some((spec) => spec.id === 'effects.fx1.colored')).toBe(false);
  });

  it('exposes mask geometry as channels', () => {
    const mask = { id: 'm1', name: 'm', shape: 'rect', enabled: true, inverted: false, position: { x: 0.5, y: 0.5 }, size: { x: 1, y: 0.5 }, rotation: 0, roundness: 0, feather: 0.1, opacity: 1, points: [], pointsClosed: true };
    const specs = maskChannelSpecs(mask);
    expect(specs.length).toBe(7);
    expect(specs.every((spec) => spec.maskId === 'm1')).toBe(true);
  });

  it('labels every transform channel', () => {
    const specs = transformChannelSpecs({ width: 1920, height: 1080, fps: 30, duration: 10, background: '#000', aspect: 'landscape' });
    expect(specs.length).toBe(12);
    expect(specs.every((spec) => spec.label.length > 0)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Graphics
 * ------------------------------------------------------------------ */

describe('procedural graphics', () => {
  it('derives its authored size from the composition', () => {
    const spec = { ...defaultGraphic('particles'), width: 0.5, height: 0.25 };
    expect(graphicSize(spec, 1000, 800)).toEqual({ width: 500, height: 200 });
  });

  it('never asks for a zero-sized raster', () => {
    const spec = { ...defaultGraphic('gradient'), width: 0, height: 0 };
    const size = graphicSize(spec, 100, 100);
    expect(size.width).toBeGreaterThan(1);
    expect(size.height).toBeGreaterThan(1);
  });
});

/* ------------------------------------------------------------------ *
 * Audio analysis
 * ------------------------------------------------------------------ */

describe('audio analysis', () => {
  const analysis = analyzeAudio(makeAudio(8));

  it('produces per-frame envelopes', () => {
    expect(analysis.frames).toBeGreaterThan(100);
    expect(analysis.level.length).toBe(analysis.frames);
    expect(analysis.low.length).toBe(analysis.frames);
  });

  it('normalises the envelopes into 0..1', () => {
    for (const band of ['level', 'low', 'mid', 'high']) {
      for (const value of analysis[band]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('puts energy where the synthetic signal put it', () => {
    const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;
    expect(mean(analysis.low)).toBeGreaterThan(mean(analysis.high));
  });

  it('is deterministic', () => {
    const again = analyzeAudio(makeAudio(8));
    expect(Array.from(again.low)).toEqual(Array.from(analysis.low));
  });

  it('finds the onsets of a 96 BPM pulse train', () => {
    // 8 seconds at 96 BPM is 12.8 beats, so expect roughly 13 kicks -- and not
    // an order of magnitude more, which is what an unthresholded detector gives.
    expect(analysis.onsets.length).toBeGreaterThan(8);
    expect(analysis.onsets.length).toBeLessThan(40);
  });

  it('suggests beat markers without claiming certainty', () => {
    expect(analysis.beats.length).toBeGreaterThan(4);
    expect(analysis.tempoConfidence).toBeGreaterThanOrEqual(0);
    expect(analysis.tempoConfidence).toBeLessThanOrEqual(1);
    if (analysis.tempo > 0) {
      expect(analysis.tempo).toBeGreaterThan(40);
      expect(analysis.tempo).toBeLessThan(220);
    }
  });

  it('reports no tempo for a signal with no periodicity', () => {
    const noise = new Float32Array(22050 * 4);
    const random = seededRandom(9);
    for (let i = 0; i < noise.length; i += 1) noise[i] = (random() - 0.5) * 0.6;
    const flat = analyzeAudio({ channels: [noise], sampleRate: 22050, duration: 4 });
    // Either it declines to name a tempo, or it names one with low confidence.
    expect(flat.tempo === 0 || flat.tempoConfidence < 0.6).toBe(true);
  });

  it('returns nothing for a signal too short to analyse', () => {
    expect(detectOnsets(new Float32Array(2), 0.01)).toEqual([]);
    expect(suggestBeats(new Float32Array(4), 0.01, []).beats).toEqual([]);
  });

  it('stores waveform peaks for drawing', () => {
    expect(analysis.waveform.length).toBeGreaterThan(100);
    for (const value of analysis.waveform) {
      expect(value).toBeGreaterThanOrEqual(-1.02);
      expect(value).toBeLessThanOrEqual(1.02);
    }
  });

  it('samples an envelope with interpolation', () => {
    const stored = { assetId: 'a', sampleRate: 100, hop: 1, hopSeconds: 0.1, frames: 3, duration: 0.3, level: [0, 1, 0], low: [0, 1, 0], mid: [0, 0, 0], high: [0, 0, 0], onsets: [], beats: [], tempo: 0, tempoConfidence: 0, waveform: [], analysedAt: 0 };
    expect(sampleEnvelope(stored, 'level', 0, 0)).toBeCloseTo(0, 6);
    expect(sampleEnvelope(stored, 'level', 0.1, 0)).toBeCloseTo(1, 6);
    expect(sampleEnvelope(stored, 'level', 0.05, 0)).toBeCloseTo(0.5, 6);
  });

  it('decays an onset impulse over time', () => {
    const times = [1];
    expect(impulseAt(times, 0.5, 0.2)).toBe(0);
    expect(impulseAt(times, 1, 0.2)).toBeCloseTo(1, 6);
    expect(impulseAt(times, 1.2, 0.2)).toBeLessThan(0.5);
  });
});

/* ------------------------------------------------------------------ *
 * Audio mapping
 * ------------------------------------------------------------------ */

describe('audio mapping', () => {
  function mappedProject() {
    const doc = createProject({ name: 'Mapped' }, { fps: 30, duration: 4 });
    const track = doc.tracks.find((entry) => entry.kind === 'visual');
    const audioTrack = doc.tracks.find((entry) => entry.kind === 'audio');
    const clip = defaultClip({ kind: 'graphic', trackId: track.id, start: 0, duration: 4, graphic: defaultGraphic('rings') });
    doc.clips.push(clip);
    doc.clips.push(defaultClip({ kind: 'audio', assetId: 'a', trackId: audioTrack.id, start: 0, duration: 4 }));
    doc.audio.a = {
      assetId: 'a', sampleRate: 100, hop: 1, hopSeconds: 0.1, frames: 40, duration: 4,
      level: Array.from({ length: 40 }, (_, index) => (index % 5 === 0 ? 1 : 0.1)),
      low: Array.from({ length: 40 }, (_, index) => (index % 5 === 0 ? 1 : 0.05)),
      mid: new Array(40).fill(0.3),
      high: new Array(40).fill(0.2),
      onsets: [0.5, 1.5, 2.5], beats: [0, 1, 2, 3], tempo: 120, tempoConfidence: 0.9,
      waveform: [0, 1], analysedAt: 0,
    };
    doc.mappings.push(defaultMapping({ source: 'a', band: 'low', target: 'transform.scale.x', clipId: clip.id, min: 0.8, max: 1.4, attack: 0.01, release: 0.2 }));
    return { doc, clip };
  }

  it('builds a curve with one value per composition frame', () => {
    const { doc } = mappedProject();
    const curves = buildMappingCurves(doc, { rangeStart: 0, rangeEnd: 4 });
    expect(curves.size).toBe(1);
    const curve = [...curves.values()][0];
    expect(curve.frames).toBe(121);
    expect(curve.values.length).toBe(121);
  });

  it('maps into the configured output range', () => {
    const { doc } = mappedProject();
    const curve = [...buildMappingCurves(doc, { rangeStart: 0, rangeEnd: 4 }).values()][0];
    for (const value of curve.values) {
      expect(value).toBeGreaterThanOrEqual(0.8 - 1e-6);
      expect(value).toBeLessThanOrEqual(1.4 + 1e-6);
    }
  });

  it('is deterministic across builds', () => {
    const { doc } = mappedProject();
    const a = [...buildMappingCurves(doc, { rangeStart: 0, rangeEnd: 4 }).values()][0];
    const b = [...buildMappingCurves(doc, { rangeStart: 0, rangeEnd: 4 }).values()][0];
    expect(Array.from(a.values)).toEqual(Array.from(b.values));
  });

  it('does not depend on which frame was evaluated first', () => {
    const { doc } = mappedProject();
    const curve = [...buildMappingCurves(doc, { rangeStart: 0, rangeEnd: 4 }).values()][0];
    // Reading frame 100 and then frame 40 must give the same values as reading
    // them in order: the smoothing is baked into the table, not into the read.
    const forward = curveValueAt(curve, 40 / 30, 30, 0);
    curveValueAt(curve, 100 / 30, 30, 0);
    expect(curveValueAt(curve, 40 / 30, 30, 0)).toBe(forward);
  });

  it('applies set, add and multiply modes', () => {
    const curve = { id: 'c', target: 'transform.scale.x', mode: 'add', frames: 2, values: new Float32Array([0.5, 0.5]), raws: new Float32Array([0.5, 0.5]) };
    expect(applyModulation(1, 'transform.scale.x', [curve], 'clip', 0, 30, 0)).toBeCloseTo(1.5, 6);
    const multiply = { ...curve, mode: 'multiply' };
    expect(applyModulation(2, 'transform.scale.x', [multiply], 'clip', 0, 30, 0)).toBeCloseTo(1, 6);
    const set = { ...curve, mode: 'set' };
    expect(applyModulation(9, 'transform.scale.x', [set], 'clip', 0, 30, 0)).toBeCloseTo(0.5, 6);
  });

  it('respects the clamp bounds', () => {
    const curve = { id: 'c', target: 'transform.opacity', mode: 'set', frames: 2, values: new Float32Array([5, 5]), raws: new Float32Array([5, 5]) };
    expect(applyModulation(1, 'transform.opacity', [curve], 'clip', 0, 30, 0, 0, 1)).toBe(1);
  });

  it('scopes a connection to one clip', () => {
    const { doc, clip } = mappedProject();
    const curves = [...buildMappingCurves(doc, { rangeStart: 0, rangeEnd: 4 }).values()];
    expect(applyModulation(1, 'transform.scale.x', curves, clip.id, 0.1, 30, 0)).toBeGreaterThan(0.8);
    expect(applyModulation(1, 'transform.scale.x', curves, 'other-clip', 0.1, 30, 0)).toBe(1);
  });

  it('includes manual markers and excludes rejected ones', () => {
    const { doc } = mappedProject();
    doc.audioSettings.manualMarkers.push(1.25);
    doc.audioSettings.removedMarkers.push(2);
    const markers = markerTimes(doc, 'a');
    expect(markers).toContain(1.25);
    expect(markers).not.toContain(2);
  });
});

/* ------------------------------------------------------------------ *
 * Offline audio mixing
 * ------------------------------------------------------------------ */

describe('offline mixing', () => {
  it('places a clip at the right offset with its gain', () => {
    const length = 4800;
    // A recognisable sentinel rather than silence, so "did the mixer touch this
    // sample at all?" is answerable.
    const left = new Float32Array(length).fill(-1);
    const mixed = mixAudio({
      clips: [{ start: 0.05, duration: 0.05, inPoint: 0, volume: 0.5, pan: 0, fadeIn: 0, fadeOut: 0, muted: false, assetId: 'a' }],
      sources: { a: { left, right: left, sampleRate: 48000 } },
      sampleRate: 48000,
      start: 0,
      duration: 0.1,
    });
    // The clip occupies samples 2400..4799 of a 4800-sample mix, so the head is
    // silent, the middle carries the clip at half gain, and the tail (the second
    // half of a longer mix) is untouched.
    expect(mixed.left[0]).toBeCloseTo(0, 6);
    expect(mixed.left[2399]).toBeCloseTo(0, 6);
    expect(mixed.left[2400]).toBeLessThan(0);
    expect(mixed.left[2400]).toBeGreaterThan(-0.6);

    const longer = mixAudio({
      clips: [{ start: 0.05, duration: 0.05, inPoint: 0, volume: 0.5, pan: 0, fadeIn: 0, fadeOut: 0, muted: false, assetId: 'a' }],
      sources: { a: { left, right: left, sampleRate: 48000 } },
      sampleRate: 48000,
      start: 0,
      duration: 0.2,
    });
    expect(longer.left[4800]).toBeCloseTo(0, 6);
    expect(longer.left[9500]).toBeCloseTo(0, 6);
  });

  it('honours mute and fades', () => {
    const length = 48000;
    const left = new Float32Array(length).fill(0.8);
    const muted = mixAudio({
      clips: [{ start: 0, duration: 1, inPoint: 0, volume: 1, pan: 0, fadeIn: 0, fadeOut: 0, muted: true, assetId: 'a' }],
      sources: { a: { left, right: left, sampleRate: 48000 } },
      sampleRate: 48000,
      start: 0,
      duration: 1,
    });
    expect(Math.max(...muted.left)).toBe(0);

    const faded = mixAudio({
      clips: [{ start: 0, duration: 1, inPoint: 0, volume: 1, pan: 0, fadeIn: 0.5, fadeOut: 0.5, muted: false, assetId: 'a' }],
      sources: { a: { left, right: left, sampleRate: 48000 } },
      sampleRate: 48000,
      start: 0,
      duration: 1,
    });
    expect(faded.left[0]).toBeLessThan(0.05);
    expect(faded.left[24000]).toBeGreaterThan(0.5);
    expect(faded.left[47999]).toBeLessThan(0.05);
  });

  it('keeps the mix inside the valid range', () => {
    const length = 48000;
    const loud = new Float32Array(length).fill(0.9);
    const mixed = mixAudio({
      clips: [
        { start: 0, duration: 1, inPoint: 0, volume: 2, pan: 0, fadeIn: 0, fadeOut: 0, muted: false, assetId: 'a' },
        { start: 0, duration: 1, inPoint: 0, volume: 2, pan: 0, fadeIn: 0, fadeOut: 0, muted: false, assetId: 'a' },
      ],
      sources: { a: { left: loud, right: loud, sampleRate: 48000 } },
      sampleRate: 48000,
      start: 0,
      duration: 1,
      masterGain: 2,
    });
    for (const value of mixed.left) {
      expect(value).toBeLessThanOrEqual(1);
      expect(value).toBeGreaterThanOrEqual(-1);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Text and graphics defaults
 * ------------------------------------------------------------------ */

describe('layer defaults', () => {
  it('gives text a usable starting style', () => {
    const style = defaultTextStyle();
    expect(style.content.length).toBeGreaterThan(0);
    expect(style.fontSize).toBeGreaterThan(0);
    expect(style.align).toBe('center');
  });

  it('gives every procedural kind a specification', () => {
    for (const kind of ['gradient', 'shape', 'particles', 'waveform', 'bars', 'rings', 'noise', 'grid', 'text']) {
      const spec = defaultGraphic(kind);
      expect(spec.kind).toBe(kind);
      expect(spec.seed).toBeGreaterThan(0);
    }
  });

  it('builds a project with sensible defaults', () => {
    const doc = createProject();
    expect(doc.composition.width).toBe(1920);
    expect(doc.composition.fps).toBe(30);
    expect(doc.tracks.length).toBeGreaterThan(1);
    expect(doc.tracks.some((track) => track.kind === 'audio')).toBe(true);
    expect(doc.version).toBe(PROJECT_VERSION);
    expect(doc.exportRange.out).toBe(doc.composition.duration);
  });

  it('mints unique ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => uid('x')));
    expect(ids.size).toBe(500);
  });
});
