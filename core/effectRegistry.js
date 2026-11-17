/**
 * The effect registry: metadata for every creative effect Motion Lab offers.
 *
 * This file is deliberately free of pixel code so the UI (which builds sliders
 * from specs), the schema normaliser and the export planner can all import it
 * without pulling in the raster passes.
 *
 * Parameter kinds
 *   number   slider with min/max/step
 *   toggle   checkbox
 *   select   dropdown
 *   color    colour swatch
 *   text     free text
 *   points   curve editor (see `curve` effect)
 *   palette  list of colours
 *   range    reserved
 *
 * Anything with `animatable: false` is excluded from keyframe/audio targeting.
 */

/** @typedef {'number'|'toggle'|'select'|'color'|'text'|'points'|'palette'} ParamKind */

/**
 * @typedef {object} ParamSpec
 * @property {string} key
 * @property {string} label
 * @property {ParamKind} kind
 * @property {any} default
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {string} [unit]
 * @property {number} [decimals]
 * @property {string[]} [options]
 * @property {boolean} [animatable]
 * @property {string} [hint]
 */

/**
 * @typedef {object} EffectDefinition
 * @property {string} type
 * @property {string} label
 * @property {string} category
 * @property {string} description
 * @property {ParamSpec[]} params
 * @property {boolean} [perFrame]  Result depends on the frame's absolute time.
 * @property {boolean} [needsHistory] Reads previously rendered frames.
 */

/** @typedef {Record<string, EffectDefinition>} EffectRegistry */

/**
 * Numeric parameter spec.
 * @param {string} key
 * @param {string} label
 * @param {number} def
 * @param {number} min
 * @param {number} max
 * @param {string} [unit]
 * @param {number} [step]
 * @param {number} [decimals]
 * @returns {ParamSpec}
 */
const num = (key, label, def, min, max, unit = '', step = 0.01, decimals = 3) =>
  ({ key, label, kind: /** @type {ParamKind} */ ('number'), default: def, min, max, unit, step, decimals });

/**
 * Percentage parameter spec.
 * @param {string} key
 * @param {string} label
 * @param {number} def
 * @returns {ParamSpec}
 */
const pct = (key, label, def) => num(key, label, def, 0, 100, '%', 0.5, 1);

/**
 * @param {string} key
 * @param {string} label
 * @param {boolean} def
 * @returns {ParamSpec}
 */
const toggle = (key, label, def) => ({ key, label, kind: /** @type {ParamKind} */ ('toggle'), default: def, animatable: false });

/**
 * @param {string} key
 * @param {string} label
 * @param {string} def
 * @param {string[]} options
 * @returns {ParamSpec}
 */
const select = (key, label, def, options) => ({
  key, label, kind: /** @type {ParamKind} */ ('select'), default: def, options, animatable: false,
});

/**
 * @param {string} key
 * @param {string} label
 * @param {string} def
 * @returns {ParamSpec}
 */
const color = (key, label, def) => ({ key, label, kind: /** @type {ParamKind} */ ('color'), default: def, animatable: false });

/** @type {EffectRegistry} */
export const EFFECT_REGISTRY = {
  /* ────────────────────────────── Colour ────────────────────────────── */
  exposure: {
    type: 'exposure', label: 'Exposure', category: 'Color',
    description: 'Light-linear exposure in stops, from -2 to +2.',
    params: [num('amount', 'Exposure', 0, -100, 100, 'stops', 0.5, 1)],
  },
  contrast: {
    type: 'contrast', label: 'Contrast', category: 'Color',
    description: 'Pivots the tonal range around mid grey.',
    params: [pct('amount', 'Contrast', 0), pct('pivot', 'Pivot', 50)],
  },
  temperature: {
    type: 'temperature', label: 'Temperature', category: 'Color',
    description: 'Warm/cool shift, blue-yellow axis.',
    params: [num('amount', 'Temperature', 0, -100, 100, '', 0.5, 1)],
  },
  tint: {
    type: 'tint', label: 'Tint', category: 'Color',
    description: 'Green/magenta shift, perpendicular to temperature.',
    params: [num('amount', 'Tint', 0, -100, 100, '', 0.5, 1)],
  },
  saturation: {
    type: 'saturation', label: 'Saturation', category: 'Color',
    description: 'Uniform chroma scaling around luma.',
    params: [num('amount', 'Saturation', 0, -100, 200, '', 0.5, 1)],
  },
  vibrance: {
    type: 'vibrance', label: 'Vibrance', category: 'Color',
    description: 'Boosts muted colours more than already-saturated ones.',
    params: [num('amount', 'Vibrance', 0, -100, 100, '', 0.5, 1)],
  },
  fade: {
    type: 'fade', label: 'Fade', category: 'Color',
    description: 'Lifts blacks and compresses highlights, like aged film.',
    params: [pct('amount', 'Fade', 0)],
  },
  levels: {
    type: 'levels', label: 'Levels', category: 'Color',
    description: 'Black point, white point, gamma and output range.',
    params: [
      pct('black', 'Black point', 0),
      pct('white', 'White point', 100),
      num('gamma', 'Gamma', 1, 0.1, 4, '', 0.01, 2),
      pct('outBlack', 'Output black', 0),
      pct('outWhite', 'Output white', 100),
    ],
  },
  curves: {
    type: 'curves', label: 'Curves', category: 'Color',
    description: 'Per-channel tone curves on a shared 5-point spline.',
    params: [
      { key: 'rgb', label: 'RGB', kind: /** @type {ParamKind} */ ('points'), default: [[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]], animatable: false },
      { key: 'red', label: 'Red', kind: /** @type {ParamKind} */ ('points'), default: [[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]], animatable: false },
      { key: 'green', label: 'Green', kind: /** @type {ParamKind} */ ('points'), default: [[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]], animatable: false },
      { key: 'blue', label: 'Blue', kind: /** @type {ParamKind} */ ('points'), default: [[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]], animatable: false },
      pct('mix', 'Mix', 100),
    ],
  },
  duotone: {
    type: 'duotone', label: 'Duotone', category: 'Color',
    description: 'Maps luminance onto a two-colour ramp.',
    params: [
      color('shadowColor', 'Shadow', '#12123a'),
      color('highlightColor', 'Highlight', '#ffb46b'),
      pct('strength', 'Strength', 100),
      pct('midpoint', 'Midpoint', 50),
    ],
  },
  paletteMap: {
    type: 'paletteMap', label: 'Palette map', category: 'Color',
    description: 'Quantises to a hand-picked palette, optionally dithered.',
    params: [
      {
        key: 'palette', label: 'Palette', kind: /** @type {ParamKind} */ ('palette'),
        default: ['#0b1020', '#2b3a67', '#f2a65a', '#f7f3e8'], animatable: false,
      },
      pct('strength', 'Strength', 100),
      toggle('dither', 'Ordered dither', true),
      num('ditherAmount', 'Dither amount', 0.5, 0, 1, '', 0.01, 3),
    ],
  },
  bloom: {
    type: 'bloom', label: 'Bloom', category: 'Color',
    description: 'Soft glow bleeding out of the brightest areas.',
    params: [
      pct('threshold', 'Threshold', 68),
      num('radius', 'Radius', 12, 0, 80, 'px', 0.5, 1),
      num('amount', 'Amount', 0.55, 0, 2, '', 0.01, 3),
    ],
  },

  /* ────────────────────────────── Texture ───────────────────────────── */
  grain: {
    type: 'grain', label: 'Film grain', category: 'Texture',
    description: 'Deterministic grain, anchored to composition coordinates.',
    params: [
      num('size', 'Grain size', 1.4, 0.35, 12, 'px', 0.05, 2),
      pct('amount', 'Amount', 22),
      toggle('colored', 'Coloured', false),
      num('animate', 'Animate', 0, 0, 30, 'fps', 0.5, 1),
    ],
  },
  paper: {
    type: 'paper', label: 'Paper texture', category: 'Texture',
    description: 'Fibrous paper relief from fractal noise.',
    params: [
      num('scale', 'Fibre size', 2.4, 0.6, 20, 'px', 0.1, 2),
      pct('intensity', 'Intensity', 34),
    ],
  },
  scratches: {
    type: 'scratches', label: 'Scratches', category: 'Texture',
    description: 'Vertical film scratches with a wobble and occasional bright line.',
    params: [
      num('count', 'Count', 8, 0, 60, '', 1, 0),
      num('length', 'Length', 100, 5, 100, '%', 1, 0),
      num('width', 'Width', 1.2, 0.4, 6, 'px', 0.1, 2),
      pct('opacity', 'Opacity', 30),
      toggle('bright', 'Bright lines', false),
      num('jitter', 'Jitter', 0.3, 0, 1, '', 0.01, 3),
    ],
  },
  vignette: {
    type: 'vignette', label: 'Vignette', category: 'Texture',
    description: 'Soft elliptical darkening anchored to the frame.',
    params: [pct('amount', 'Amount', 40), pct('softness', 'Softness', 50)],
  },

  /* ────────────────────────────── Graphic ───────────────────────────── */
  halftone: {
    type: 'halftone', label: 'Halftone', category: 'Graphic',
    description: 'Rotated dot screen in ink and paper colours.',
    params: [
      num('spacing', 'Dot spacing', 7, 1.5, 60, 'px', 0.1, 2),
      num('dotSize', 'Dot size', 100, 10, 160, '%', 1, 1),
      num('angle', 'Screen angle', 45, -90, 90, '°', 1, 1),
      color('ink', 'Ink', '#101018'),
      color('paper', 'Paper', '#f4f1e8'),
    ],
  },
  posterize: {
    type: 'posterize', label: 'Posterize', category: 'Graphic',
    description: 'Reduces each channel to a small number of levels.',
    params: [num('levels', 'Levels', 6, 2, 32, '', 1, 0), pct('blend', 'Blend', 100)],
  },
  edges: {
    type: 'edges', label: 'Edge outlines', category: 'Graphic',
    description: 'Sobel edge detection drawn in ink over a flattened base.',
    params: [
      num('threshold', 'Threshold', 0.18, 0, 1, '', 0.01, 3),
      num('thickness', 'Thickness', 1, 1, 4, 'px', 1, 0),
      color('ink', 'Ink', '#0d0d12'),
      pct('baseFade', 'Base fade', 88),
      toggle('colorEdges', 'Colourise edges', false),
    ],
  },
  pixelate: {
    type: 'pixelate', label: 'Pixelate', category: 'Graphic',
    description: 'Averages the raster into square blocks.',
    params: [num('blockSize', 'Block size', 10, 1, 160, 'px', 1, 0)],
  },

  /* ────────────────────────────── Motion ────────────────────────────── */
  trails: {
    type: 'trails', label: 'Trails', category: 'Motion',
    description: 'Ghosts of previous frames, sampled at a fixed interval so a seek reproduces them exactly.',
    perFrame: true, needsHistory: true,
    params: [
      num('count', 'Trail count', 6, 1, 24, '', 1, 0),
      // Seconds, not frames: a trail's spacing has to mean the same thing at 24
      // and 60 fps, and it has to survive a frame-rate change on the project.
      num('spacing', 'Spacing', 0.08, 0.02, 0.6, 's', 0.01, 3),
      num('falloff', 'Falloff', 0.68, 0.05, 1, '', 0.01, 3),
      pct('blend', 'Trail opacity', 60),
      toggle('additive', 'Additive', true),
    ],
  },
  frameStep: {
    type: 'frameStep', label: 'Frame stepping', category: 'Motion',
    description: 'Holds the composition on one frame for several, for stop-motion and stutter.',
    perFrame: true, needsHistory: true,
    params: [
      num('hold', 'Hold frames', 3, 1, 30, 'frames', 1, 0),
      pct('mix', 'Mix', 100),
    ],
  },
  strobe: {
    type: 'strobe', label: 'Strobe', category: 'Motion',
    description: 'Cycles the layer on and off in sync with the timeline.',
    perFrame: true,
    params: [
      num('rate', 'Rate', 8, 0.5, 60, 'Hz', 0.5, 2),
      num('duty', 'Duty', 50, 1, 99, '%', 1, 1),
      pct('depth', 'Depth', 100),
      num('phase', 'Phase', 0, 0, 360, '°', 1, 0),
    ],
  },
  animatedNoise: {
    type: 'animatedNoise', label: 'Animated noise', category: 'Motion',
    description: 'Time-varying film noise, television static, fog and dust.',
    perFrame: true,
    params: [
      select('noiseKind', 'Noise type', 'film', ['film', 'static', 'fog', 'dust']),
      pct('amount', 'Amount', 30),
      num('scale', 'Scale', 1.6, 0.2, 20, 'px', 0.1, 2),
      num('speed', 'Speed', 1, -8, 8, '×', 0.05, 2),
      toggle('mono', 'Monochrome', true),
    ],
  },

  /* ───────────────────────────── Distortion ─────────────────────────── */
  wave: {
    type: 'wave', label: 'Wave displacement', category: 'Distortion',
    description: 'Horizontal sine displacement with a controllable wavelength.',
    params: [
      num('amplitude', 'Amplitude', 14, 0, 200, 'px', 1, 1),
      num('wavelength', 'Wavelength', 90, 4, 800, 'px', 1, 1),
      num('phase', 'Phase', 0, -360, 360, '°', 1, 1),
      num('animate', 'Animate', 0, -4, 4, '×', 0.05, 2),
      select('waveKind', 'Waveform', 'sine', ['sine', 'triangle', 'square', 'noise']),
    ],
  },
  rgbOffset: {
    type: 'rgbOffset', label: 'RGB offset', category: 'Distortion',
    description: 'Separates the colour channels along an angle.',
    params: [
      num('distance', 'Distance', 4, 0, 80, 'px', 0.5, 1),
      num('angle', 'Angle', 0, -180, 180, '°', 1, 1),
      num('animate', 'Animate', 0, -20, 20, '°/frame', 0.1, 2),
    ],
  },
  kaleidoscope: {
    type: 'kaleidoscope', label: 'Kaleidoscope', category: 'Distortion',
    description: 'Mirrors the frame into wedges around its centre.',
    params: [
      num('segments', 'Segments', 8, 2, 48, '', 1, 0),
      num('rotation', 'Rotation', 0, -360, 360, '°', 1, 1),
      num('zoom', 'Zoom', 1, 0.2, 4, '×', 0.01, 3),
      num('spin', 'Spin', 0, -180, 180, '°/s', 1, 1),
    ],
  },
  glitch: {
    type: 'glitch', label: 'Glitch', category: 'Distortion',
    description: 'Slice displacement with block corruption and channel tears.',
    perFrame: true,
    params: [
      pct('amount', 'Amount', 35),
      num('slices', 'Slices', 14, 1, 80, '', 1, 0),
      num('blockSize', 'Block size', 28, 4, 200, 'px', 1, 0),
      num('rate', 'Rate', 6, 0.5, 60, 'Hz', 0.5, 2),
      toggle('colorTear', 'Colour tear', true),
    ],
  },
};

/**
 * Order the effect picker lists them in.
 * @type {readonly string[]}
 */
export const EFFECT_CATEGORIES = Object.freeze(['Color', 'Texture', 'Graphic', 'Motion', 'Distortion']);

/**
 * @param {string} type
 * @returns {EffectDefinition}
 */
export function effectDefinition(type) {
  const definition = EFFECT_REGISTRY[type];
  if (definition) return definition;
  return {
    type,
    label: type,
    category: 'Unknown',
    description: `Unknown effect "${type}" -- it is preserved but does nothing.`,
    params: [],
  };
}

/**
 * Parameter specs excluding non-animatable kinds.
 * @param {string} type
 * @returns {ParamSpec[]}
 */
export function animatableParams(type) {
  return effectDefinition(type).params.filter((param) => param.animatable !== false && param.kind === 'number');
}

/**
 * @param {string} type
 * @param {string} key
 * @returns {ParamSpec|undefined}
 */
export function paramSpec(type, key) {
  return effectDefinition(type).params.find((param) => param.key === key);
}

/**
 * Fresh parameter set for a newly added effect.
 * @param {string} type
 * @returns {Record<string, any>}
 */
export function defaultParams(type) {
  /** @type {Record<string, any>} */
  const params = {};
  for (const param of effectDefinition(type).params) {
    params[param.key] = Array.isArray(param.default) ? JSON.parse(JSON.stringify(param.default)) : param.default;
  }
  return params;
}

/**
 * Coerce a stored value into the shape its spec expects.
 * @param {ParamSpec} spec
 * @param {unknown} value
 * @returns {any}
 */
export function coerceParam(spec, value) {
  switch (spec.kind) {
    case 'number': {
      const numeric = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(numeric)) return /** @type {number} */ (spec.default);
      const min = spec.min ?? -Infinity;
      const max = spec.max ?? Infinity;
      return Math.min(Math.max(numeric, min), max);
    }
    case 'toggle':
      return Boolean(value);
    case 'select': {
      const options = spec.options ?? [];
      return options.includes(String(value)) ? String(value) : /** @type {string} */ (spec.default);
    }
    case 'color':
      return typeof value === 'string' && /^#?[0-9a-fA-F]{3,8}$/.test(value) ? String(value) : spec.default;
    case 'text':
      return String(value ?? spec.default);
    case 'points': {
      const points = Array.isArray(value) ? value : spec.default;
      const cleaned = /** @type {any[]} */ (points)
        .filter((pair) => Array.isArray(pair) && pair.length >= 2)
        .map((pair) => [Math.min(1, Math.max(0, Number(pair[0]) || 0)), Math.min(1, Math.max(0, Number(pair[1]) || 0))]);
      cleaned.sort((a, b) => a[0] - b[0]);
      if (cleaned.length < 2) return JSON.parse(JSON.stringify(spec.default));
      cleaned[0][0] = 0;
      cleaned[cleaned.length - 1][0] = 1;
      return cleaned;
    }
    case 'palette': {
      const list = Array.isArray(value) ? value : spec.default;
      const cleaned = /** @type {any[]} */ (list)
        .filter((entry) => typeof entry === 'string' && /^#?[0-9a-fA-F]{3,8}$/.test(entry))
        .map((entry) => (entry.startsWith('#') ? entry : `#${entry}`));
      return cleaned.length ? cleaned : JSON.parse(JSON.stringify(spec.default));
    }
    default:
      return /** @type {number} */ (spec.default);
  }
}

/**
 * A short human summary of an effect instance for timeline tooltips and lists.
 * @param {string} type
 * @param {Record<string, any>} params
 * @returns {string}
 */
export function describeEffect(type, params) {
  const definition = effectDefinition(type);
  const parts = [];
  for (const spec of definition.params) {
    const value = params[spec.key] ?? spec.default;
    if (spec.kind === 'number') {
      parts.push(`${spec.label} ${typeof value === 'number' ? value.toFixed(spec.decimals ?? 2) : value}${spec.unit ?? ''}`);
    } else if (spec.kind === 'toggle' && value) {
      parts.push(spec.label);
    } else if (spec.kind === 'select') {
      parts.push(String(value));
    } else if (spec.kind === 'color') {
      parts.push(String(value));
    }
  }
  return parts.slice(0, 4).join(' · ');
}

/**
 * Does this stack contain any effect that needs the frame history?
 * @param {{stack: Array<{type:string, enabled:boolean}>}} effects
 * @returns {boolean}
 */
export function stackNeedsHistory(effects) {
  return effects.stack.some((entry) => entry.enabled && effectDefinition(entry.type).needsHistory);
}

/**
 * Neutral parameter test used by the renderer to skip passes entirely.
 * @param {string} type
 * @param {Record<string, any>} params
 * @returns {boolean}
 */
export function isEffectNeutral(type, params) {
  switch (type) {
    case 'exposure': return !params.amount;
    case 'contrast': return !params.amount;
    case 'temperature': return !params.amount;
    case 'tint': return !params.amount;
    case 'saturation': return !params.amount;
    case 'vibrance': return !params.amount;
    case 'fade': return !params.amount;
    case 'levels':
      return params.black === 0 && params.white === 100 && params.gamma === 1 && params.outBlack === 0 && params.outWhite === 100;
    case 'curves': {
      const identity = (/** @type {number[][]} */ points) =>
        Array.isArray(points) && points.length === 5 && points.every((point, index) => Math.abs(point[0] - index / 4) < 1e-6 && Math.abs(point[1] - index / 4) < 1e-6);
      return !params.mix || (identity(params.rgb) && identity(params.red) && identity(params.green) && identity(params.blue));
    }
    case 'duotone': return !params.strength;
    case 'paletteMap': return !params.strength;
    case 'bloom': return !params.amount || !params.radius;
    case 'grain': return !params.amount;
    case 'paper': return !params.intensity;
    case 'scratches': return !params.count || !params.opacity;
    case 'vignette': return !params.amount;
    case 'halftone': return false; // spacing/dot sizing always produces a screen
    case 'posterize': return !params.blend;
    case 'edges': return false;
    case 'pixelate': return (params.blockSize ?? 1) <= 1.0001;
    case 'trails': return !params.count || !params.blend;
    case 'frameStep': return (params.hold ?? 1) <= 1 || !params.mix;
    case 'strobe': return !params.depth;
    case 'animatedNoise': return !params.amount;
    case 'wave': return !params.amplitude;
    case 'rgbOffset': return !params.distance && !params.animate;
    case 'kaleidoscope': return false;
    case 'glitch': return !params.amount;
    default: return false;
  }
}
