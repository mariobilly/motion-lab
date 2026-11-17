/**
 * Pixel effect passes.
 *
 * Every pass is a pure function of (source raster, parameters, context). No
 * pass reads or writes anything outside its arguments, and no pass consults
 * Math.random() or the wall clock -- randomness comes from
 * `hash(composition coordinate, instance seed)` and any time dependence comes
 * from `ctx.time`, the frame's exact timeline position. That is the whole
 * reason an exported frame is identical to the preview of that frame.
 *
 * Passes receive:
 *   src, dst  RGBA Uint8ClampedArray, `dst` may alias `src`
 *   ctx.width/height  raster size in *composition* pixels at this frame's scale
 *   ctx.scale  composition pixels per raster pixel (preview < 1, export = 1)
 *   ctx.seed   the effect instance's seed
 *   ctx.time   frame time in seconds
 *   ctx.widthUnits / heightUnits  raster size in authored composition pixels
 *
 * Because `ctx.widthUnits` is the *authored* size and never the preview size,
 * "40px grain" means the same thing in a quarter-resolution preview and in a
 * 4K export.
 */

import {
  fbm2d, hash2d, hexToRgb, lerp, mixHex, rgbToHex, sampleBilinear,
  smoothstep, valueNoise2d, withAlpha,
} from './math.js';

/**
 * @param {number} value
 * @returns {number} clamped to the 0..255 byte range
 */
function clamp255(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/* ------------------------------------------------------------------ *
 * sRGB transfer helpers (duplicated locally so effect passes have no
 * dependency on UI modules)
 * ------------------------------------------------------------------ */

const SRGB_TO_LINEAR_TABLE = (() => {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i += 1) {
    const c = i / 255;
    table[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return table;
})();

/**
 * @param {number} linear
 * @returns {number}
 */
function linearToSrgb255(linear) {
  const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(Math.max(0, linear), 1 / 2.4) - 0.055;
  return c * 255;
}

/**
 * Additive-ish soft add so bright areas roll off instead of clipping hard.
 * @param {number} channel
 * @param {number} delta
 * @returns {number}
 */
function softAdd(channel, delta) {
  return delta >= 0 ? channel + (255 - channel) * (delta / 255) : channel + channel * (delta / 255);
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {number}
 */
function lumaOf(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/* ------------------------------------------------------------------ *
 * Pass context
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} EffectContext
 * @property {number} width        Raster width in pixels.
 * @property {number} height       Raster height in pixels.
 * @property {number} scale        Composition pixels per raster pixel.
 * @property {number} widthUnits   Composition width in authored units.
 * @property {number} heightUnits  Composition height in authored units.
 * @property {number} seed
 * @property {number} time         Frame time in seconds.
 * @property {number} [frame]      Frame index at the composition's frame rate.
 * @property {Uint8ClampedArray} [below]  Flattened artwork underneath, for clips inside an adjustment layer's scope.
 * @property {Uint8ClampedArray} [history] Optional pre-composited history frame (oldest first).
 * @property {number} [historyCount]
 * @property {(factor:number) => {data:Float32Array,width:number,height:number}} scratch
 *   A pooled float raster at 1/`factor` of the frame size, for multi-pass effects.
 * @property {() => Uint8ClampedArray} [byteScratch]
 *   A pooled byte raster the same size as the frame, so the effect stack can run
 *   without allocating a new buffer per pass.
 */

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

/**
 * Build a 256-entry tone table for exposure + contrast.
 * @param {number} exposure -100..100
 * @param {number} contrast -100..100
 * @param {number} pivot 0..100
 * @returns {Uint8ClampedArray}
 */
function toneTable(exposure, contrast, pivot) {
  const stops = (exposure / 100) * 2;
  const gain = exposure === 0 ? 1 : Math.pow(2, stops);
  const c = contrast / 100;
  const factor = c >= 0 ? 1 + c * 0.95 : 1 + c * 0.72;
  const pivotValue = (pivot / 100) * 255;
  const table = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    if (exposure !== 0) value = linearToSrgb255(SRGB_TO_LINEAR_TABLE[i] * gain);
    if (contrast !== 0) value = pivotValue + (value - pivotValue) * factor;
    table[i] = clamp255(value);
  }
  return table;
}

/**
 * Exposure.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passExposure(src, dst, ctx, params) {
  const table = toneTable(params.amount, 0, 50);
  for (let i = 0; i < src.length; i += 4) {
    dst[i] = table[src[i]];
    dst[i + 1] = table[src[i + 1]];
    dst[i + 2] = table[src[i + 2]];
    dst[i + 3] = src[i + 3];
  }
}

/**
 * Contrast.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passContrast(src, dst, ctx, params) {
  const table = toneTable(0, params.amount, params.pivot ?? 50);
  for (let i = 0; i < src.length; i += 4) {
    dst[i] = table[src[i]];
    dst[i + 1] = table[src[i + 1]];
    dst[i + 2] = table[src[i + 2]];
    dst[i + 3] = src[i + 3];
  }
}

/**
 * Temperature: blue/yellow axis.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passTemperature(src, dst, ctx, params) {
  const warm = (params.amount / 100) * 46;
  for (let i = 0; i < src.length; i += 4) {
    dst[i] = clamp255(softAdd(src[i], warm));
    dst[i + 1] = src[i + 1];
    dst[i + 2] = clamp255(softAdd(src[i + 2], -warm));
    dst[i + 3] = src[i + 3];
  }
}

/**
 * Tint: green/magenta axis.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passTint(src, dst, ctx, params) {
  const green = (params.amount / 100) * 32;
  const magenta = -(params.amount / 100) * 16;
  for (let i = 0; i < src.length; i += 4) {
    dst[i] = clamp255(softAdd(src[i], magenta));
    dst[i + 1] = clamp255(softAdd(src[i + 1], green));
    dst[i + 2] = clamp255(softAdd(src[i + 2], magenta));
    dst[i + 3] = src[i + 3];
  }
}

/**
 * Saturation: chroma scale around luma.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passSaturation(src, dst, ctx, params) {
  const factor = 1 + params.amount / 100;
  for (let i = 0; i < src.length; i += 4) {
    const grey = lumaOf(src[i], src[i + 1], src[i + 2]);
    dst[i] = clamp255(grey + (src[i] - grey) * factor);
    dst[i + 1] = clamp255(grey + (src[i + 1] - grey) * factor);
    dst[i + 2] = clamp255(grey + (src[i + 2] - grey) * factor);
    dst[i + 3] = src[i + 3];
  }
}

/**
 * Vibrance: saturation weighted towards muted pixels.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passVibrance(src, dst, ctx, params) {
  const amount = (params.amount / 100) * 1.6;
  for (let i = 0; i < src.length; i += 4) {
    const r = src[i];
    const g = src[i + 1];
    const b = src[i + 2];
    const grey = lumaOf(r, g, b);
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    const chroma = (max - min) / 255;
    const factor = 1 + amount * (1 - chroma);
    dst[i] = clamp255(grey + (r - grey) * factor);
    dst[i + 1] = clamp255(grey + (g - grey) * factor);
    dst[i + 2] = clamp255(grey + (b - grey) * factor);
    dst[i + 3] = src[i + 3];
  }
}

/**
 * Fade: lifted blacks, compressed highlights.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passFade(src, dst, ctx, params) {
  const lift = (params.amount / 100) * 0.34;
  const gain = 1 - lift;
  const black = lift * 255;
  for (let i = 0; i < src.length; i += 4) {
    dst[i] = clamp255(black + src[i] * gain);
    dst[i + 1] = clamp255(black + src[i + 1] * gain);
    dst[i + 2] = clamp255(black + src[i + 2] * gain);
    dst[i + 3] = src[i + 3];
  }
}

/**
 * Levels: black/white point, gamma and output range.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passLevels(src, dst, ctx, params) {
  const inBlack = (params.black / 100) * 255;
  const inWhite = Math.max(inBlack + 1, (params.white / 100) * 255);
  const outBlack = (params.outBlack / 100) * 255;
  const outWhite = (params.outWhite / 100) * 255;
  const inverseGamma = 1 / Math.max(0.05, params.gamma);
  const table = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i += 1) {
    let value = (i - inBlack) / (inWhite - inBlack);
    value = value < 0 ? 0 : value > 1 ? 1 : value;
    value = Math.pow(value, inverseGamma);
    table[i] = clamp255(outBlack + value * (outWhite - outBlack));
  }
  for (let i = 0; i < src.length; i += 4) {
    dst[i] = table[src[i]];
    dst[i + 1] = table[src[i + 1]];
    dst[i + 2] = table[src[i + 2]];
    dst[i + 3] = src[i + 3];
  }
}

/**
 * Monotone cubic (Fritsch-Carlson) interpolation through curve control points,
 * sampled into a 256-entry lookup table.
 * @param {number[][]} points
 * @returns {Uint8ClampedArray}
 */
function curveTable(points) {
  const pts = points.length >= 2 ? points : [[0, 0], [1, 1]];
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

  const table = new Uint8ClampedArray(256);
  let segment = 0;
  for (let i = 0; i < 256; i += 1) {
    const x = i / 255;
    while (segment < n - 2 && x > xs[segment + 1]) segment += 1;
    const x0 = xs[segment];
    const x1 = xs[segment + 1];
    const h = Math.max(1e-6, x1 - x0);
    const t = Math.min(1, Math.max(0, (x - x0) / h));
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const value = h00 * ys[segment] + h10 * h * slopes[segment] + h01 * ys[segment + 1] + h11 * h * slopes[segment + 1];
    table[i] = clamp255(value * 255);
  }
  return table;
}

/**
 * Curves: RGB plus per-channel curves.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passCurves(src, dst, ctx, params) {
  const rgbTable = curveTable(params.rgb);
  const redTable = curveTable(params.red);
  const greenTable = curveTable(params.green);
  const blueTable = curveTable(params.blue);
  const mix = params.mix / 100;
  for (let i = 0; i < src.length; i += 4) {
    const baseR = rgbTable[src[i]];
    const baseG = rgbTable[src[i + 1]];
    const baseB = rgbTable[src[i + 2]];
    const targetR = redTable[baseR];
    const targetG = greenTable[baseG];
    const targetB = blueTable[baseB];
    dst[i] = src[i] + (targetR - src[i]) * mix;
    dst[i + 1] = src[i + 1] + (targetG - src[i + 1]) * mix;
    dst[i + 2] = src[i + 2] + (targetB - src[i + 2]) * mix;
    dst[i + 3] = src[i + 3];
  }
}

/**
 * Duotone.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passDuotone(src, dst, ctx, params) {
  const shadow = hexToRgb(params.shadowColor);
  const highlight = hexToRgb(params.highlightColor);
  const mix = params.strength / 100;
  const mid = Math.min(0.95, Math.max(0.05, params.midpoint / 100));
  for (let i = 0; i < src.length; i += 4) {
    const l = lumaOf(src[i], src[i + 1], src[i + 2]) / 255;
    const t = l < mid ? 0.5 * (l / mid) : 0.5 + 0.5 * ((l - mid) / (1 - mid));
    const dr = shadow[0] + (highlight[0] - shadow[0]) * t;
    const dg = shadow[1] + (highlight[1] - shadow[1]) * t;
    const db = shadow[2] + (highlight[2] - shadow[2]) * t;
    dst[i] = src[i] + (dr - src[i]) * mix;
    dst[i + 1] = src[i + 1] + (dg - src[i + 1]) * mix;
    dst[i + 2] = src[i + 2] + (db - src[i + 2]) * mix;
    dst[i + 3] = src[i + 3];
  }
}

/** 8x8 Bayer matrix, normalised to (0,1). */
const BAYER_8 = (() => {
  const base = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
  ];
  const flat = new Float32Array(64);
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) flat[y * 8 + x] = base[y][x] / 64 - 0.5;
  return flat;
})();

/**
 * Palette map: snap each pixel to the nearest palette colour, with optional
 * ordered dithering.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passPaletteMap(src, dst, ctx, params) {
  const palette = /** @type {string[]} */ (params.palette).map(hexToRgb);
  if (palette.length === 0) {
    dst.set(src);
    return;
  }
  const strength = params.strength / 100;
  const spread = params.dither ? (params.ditherAmount ?? 0.5) * 46 : 0;
  const { width } = ctx;

  for (let y = 0; y < ctx.height; y += 1) {
    const bayerRow = (y & 7) * 8;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const offset = spread ? BAYER_8[bayerRow + (x & 7)] * spread : 0;
      const r = src[i] + offset;
      const g = src[i + 1] + offset;
      const b = src[i + 2] + offset;
      let best = 0;
      let bestDistance = Infinity;
      for (let p = 0; p < palette.length; p += 1) {
        const dr = r - palette[p][0];
        const dg = g - palette[p][1];
        const db = b - palette[p][2];
        // Weighted to approximate perceptual distance.
        const distance = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = p;
        }
      }
      dst[i] = src[i] + (palette[best][0] - src[i]) * strength;
      dst[i + 1] = src[i + 1] + (palette[best][1] - src[i + 1]) * strength;
      dst[i + 2] = src[i + 2] + (palette[best][2] - src[i + 2]) * strength;
      dst[i + 3] = src[i + 3];
    }
  }
}

/**
 * Bloom: bright-pass, blur, screen back on.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passBloom(src, dst, ctx, params) {
  const { width, height, scale } = ctx;
  const radius = Math.max(1, Math.round(params.radius / Math.max(0.05, scale)));
  const factor = Math.max(1, Math.round(radius / 4));
  const small = ctx.scratch(factor);
  const sw = Math.max(1, Math.floor(width / factor));
  const sh = Math.max(1, Math.floor(height / factor));
  const threshold = (params.threshold / 100) * 255;
  const amount = params.amount;

  // Bright pass with a box downsample.
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = 0; sy < factor; sy += 1) {
        const py = Math.min(height - 1, y * factor + sy);
        for (let sx = 0; sx < factor; sx += 1) {
          const px = Math.min(width - 1, x * factor + sx);
          const i = (py * width + px) * 4;
          const l = lumaOf(src[i], src[i + 1], src[i + 2]);
          const weight = smoothstep(threshold, threshold + 70, l);
          r += src[i] * weight;
          g += src[i + 1] * weight;
          b += src[i + 2] * weight;
          n += 1;
        }
      }
      const o = (y * sw + x) * 4;
      small.data[o] = n ? r / n : 0;
      small.data[o + 1] = n ? g / n : 0;
      small.data[o + 2] = n ? b / n : 0;
      small.data[o + 3] = 255;
    }
  }

  // Two separable box blurs give a soft, cheap gaussian-ish falloff.
  boxBlur(small.data, sw, sh, Math.max(1, Math.round(radius / (2 * factor))));
  boxBlur(small.data, sw, sh, Math.max(1, Math.round(radius / (2 * factor))));

  // Upsample and add.
  const sample = new Float32Array(4);
  const blurTile = Float32Array.from(small.data.subarray(0, sw * sh * 4));
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(sh - 1, y / factor);
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(sw - 1, x / factor);
      sampleBilinear(blurTile, sw, sh, sx + 0.5, sy + 0.5, sample);
      const i = (y * width + x) * 4;
      dst[i] = clamp255(src[i] + sample[0] * amount);
      dst[i + 1] = clamp255(src[i + 1] + sample[1] * amount);
      dst[i + 2] = clamp255(src[i + 2] + sample[2] * amount);
      dst[i + 3] = src[i + 3];
    }
  }
}

/**
 * In-place separable box blur over an interleaved RGBA float raster.
 * @param {Float32Array} data
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 */
function boxBlur(data, width, height, radius) {
  if (radius < 1) return;
  const temp = new Float32Array(width * height * 3);
  const window = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    for (let c = 0; c < 3; c += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const x = Math.min(width - 1, Math.max(0, k));
        sum += data[(y * width + x) * 4 + c];
      }
      for (let x = 0; x < width; x += 1) {
        temp[(y * width + x) * 3 + c] = sum / window;
        const outIndex = Math.min(width - 1, Math.max(0, x - radius));
        const inIndex = Math.min(width - 1, Math.max(0, x + radius + 1));
        sum += data[(y * width + inIndex) * 4 + c] - data[(y * width + outIndex) * 4 + c];
      }
    }
  }
  for (let x = 0; x < width; x += 1) {
    for (let c = 0; c < 3; c += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const y = Math.min(height - 1, Math.max(0, k));
        sum += temp[(y * width + x) * 3 + c];
      }
      for (let y = 0; y < height; y += 1) {
        data[(y * width + x) * 4 + c] = sum / window;
        const outIndex = Math.min(height - 1, Math.max(0, y - radius));
        const inIndex = Math.min(height - 1, Math.max(0, y + radius + 1));
        sum += temp[(inIndex * width + x) * 3 + c] - temp[(outIndex * width + x) * 3 + c];
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Texture
 * ------------------------------------------------------------------ */

/**
 * Film grain.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passGrain(src, dst, ctx, params) {
  const { width, height, scale, seed } = ctx;
  const sizeUnits = Math.max(0.35, params.size);
  const cell = Math.max(0.5, sizeUnits / Math.max(0.05, scale));
  const amount = (params.amount / 100) * 46;
  const animate = params.animate ?? 0;
  // A frame-varying seed offset keeps the grain field stable while unrelated
  // parameters move, but lets the user ask for animated grain explicitly.
  const timeSeed = animate > 0 ? Math.floor(ctx.time * animate) * 7919 : 0;

  for (let y = 0; y < height; y += 1) {
    const cy = Math.floor((y + 0.5) / cell);
    for (let x = 0; x < width; x += 1) {
      const cx = Math.floor((x + 0.5) / cell);
      const i = (y * width + x) * 4;
      if (params.colored) {
        const nr = (hash2d(cx, cy, seed + timeSeed) - 0.5) * 2;
        const ng = (hash2d(cx, cy, seed + timeSeed + 7919) - 0.5) * 2;
        const nb = (hash2d(cx, cy, seed + timeSeed + 104729) - 0.5) * 2;
        dst[i] = clamp255(src[i] + nr * amount);
        dst[i + 1] = clamp255(src[i + 1] + ng * amount);
        dst[i + 2] = clamp255(src[i + 2] + nb * amount);
      } else {
        const n = (hash2d(cx, cy, seed + timeSeed) - 0.5) * 2;
        const delta = n * amount;
        dst[i] = clamp255(src[i] + delta);
        dst[i + 1] = clamp255(src[i + 1] + delta);
        dst[i + 2] = clamp255(src[i + 2] + delta);
      }
      dst[i + 3] = src[i + 3];
    }
  }
}

/**
 * Paper texture.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passPaper(src, dst, ctx, params) {
  const { width, height, scale, seed } = ctx;
  const cell = Math.max(0.8, params.scale / Math.max(0.05, scale));
  const amount = (params.intensity / 100) * 40;
  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / cell;
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / cell;
      const coarse = fbm2d(u, v, seed + 91, 3);
      const fibre = valueNoise2d(u * 5.5, v * 5.5, seed + 313);
      const n = coarse * 0.75 + fibre * 0.25;
      const delta = (n - 0.5) * 2 * amount;
      const i = (y * width + x) * 4;
      dst[i] = clamp255(src[i] + delta);
      dst[i + 1] = clamp255(src[i + 1] + delta);
      dst[i + 2] = clamp255(src[i + 2] + delta);
      dst[i + 3] = src[i + 3];
    }
  }
}

/**
 * Vertical film scratches.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passScratches(src, dst, ctx, params) {
  dst.set(src);
  const { width, height, scale, seed } = ctx;
  const count = Math.round(params.count);
  if (count <= 0 || params.opacity <= 0) return;
  const lengthFraction = params.length / 100;
  const lineWidth = Math.max(1, Math.round((params.width * scale) / Math.max(0.05, scale)));
  const baseAlpha = params.opacity / 100;
  const brightness = params.bright ? 235 : 12;

  for (let s = 0; s < count; s += 1) {
    const xBase = hash2d(s, 11, seed) * width;
    const jitter = (hash2d(s, 29, seed) - 0.5) * params.jitter * width * 0.08;
    const y0 = hash2d(s, 47, seed) * height * (1 - lengthFraction);
    const span = Math.max(6, height * lengthFraction * (0.4 + hash2d(s, 71, seed) * 0.6));
    const alpha = baseAlpha * (0.35 + hash2d(s, 97, seed) * 0.65);
    for (let y = Math.floor(y0); y < Math.min(height, y0 + span); y += 1) {
      const wobble = Math.sin((y / height) * 6.28 * (1 + hash2d(s, 131, seed) * 2)) * jitter;
      const cx = Math.round(xBase + wobble);
      for (let w = 0; w < lineWidth; w += 1) {
        const x = cx + w;
        if (x < 0 || x >= width) continue;
        const i = (y * width + x) * 4;
        dst[i] = clamp255(src[i] + (brightness - src[i]) * alpha);
        dst[i + 1] = clamp255(src[i + 1] + (brightness - src[i + 1]) * alpha);
        dst[i + 2] = clamp255(src[i + 2] + (brightness - src[i + 2]) * alpha);
      }
    }
  }
}

/**
 * Vignette.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passVignette(src, dst, ctx, params) {
  const strength = (params.amount / 100) * 0.95;
  const inner = 0.85 - (params.softness / 100) * 0.7;
  const { width, height } = ctx;
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const invMax = 1 / Math.SQRT2;
  for (let y = 0; y < height; y += 1) {
    const ny = (y - cy) / (height / 2);
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const nx = (x - cx) / (width / 2);
      const r = Math.sqrt(nx * nx + ny * ny) * invMax;
      const t = Math.min(1, Math.max(0, (r - inner) / (1 - inner)));
      const falloff = t * t * (3 - 2 * t);
      const f = 1 - strength * falloff;
      dst[i] = src[i] * f;
      dst[i + 1] = src[i + 1] * f;
      dst[i + 2] = src[i + 2] * f;
      dst[i + 3] = src[i + 3];
    }
  }
}

/* ------------------------------------------------------------------ *
 * Graphic
 * ------------------------------------------------------------------ */

/**
 * Halftone screen.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passHalftone(src, dst, ctx, params) {
  const { width, height, scale } = ctx;
  const ink = hexToRgb(params.ink);
  const paper = hexToRgb(params.paper);
  const spacing = Math.max(1.2, params.spacing / Math.max(0.05, scale));
  const maxRadius = spacing * 0.5 * (params.dotSize / 100) * Math.SQRT2;
  const rad = (params.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const aa = 0.75;
  const sample = new Float32Array(4);

  for (let y = 0; y < height; y += 1) {
    const py = y + 0.5;
    for (let x = 0; x < width; x += 1) {
      const px = x + 0.5;
      const u = (px * cos + py * sin) / spacing;
      const v = (-px * sin + py * cos) / spacing;
      const uc = (Math.floor(u) + 0.5) * spacing;
      const vc = (Math.floor(v) + 0.5) * spacing;
      const cxp = uc * cos - vc * sin;
      const cyp = uc * sin + vc * cos;
      const ddx = px - cxp;
      const ddy = py - cyp;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy);

      sampleBilinear(src, width, height, cxp, cyp, sample);
      const l = lumaOf(sample[0], sample[1], sample[2]) / 255;
      const radius = maxRadius * Math.sqrt(Math.max(0, 1 - l));
      const coverage = 1 - smoothstep(radius - aa, radius + aa, dist);

      const i = (y * width + x) * 4;
      dst[i] = paper[0] + (ink[0] - paper[0]) * coverage;
      dst[i + 1] = paper[1] + (ink[1] - paper[1]) * coverage;
      dst[i + 2] = paper[2] + (ink[2] - paper[2]) * coverage;
      dst[i + 3] = src[i + 3];
    }
  }
}

/**
 * Posterize.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passPosterize(src, dst, ctx, params) {
  const levels = Math.max(2, Math.min(64, Math.round(params.levels)));
  const step = (levels - 1) / 255;
  const blend = params.blend / 100;
  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const v = src[i + c];
      const q = (Math.round(v * step) / (levels - 1)) * 255;
      dst[i + c] = v + (q - v) * blend;
    }
    dst[i + 3] = src[i + 3];
  }
}

/**
 * Sobel edge outlines.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passEdges(src, dst, ctx, params) {
  const { width, height } = ctx;
  const ink = hexToRgb(params.ink);
  const threshold = params.threshold;
  const fade = params.baseFade / 100;
  const thickness = Math.max(1, Math.round(params.thickness));
  const lumaBuffer = new Float32Array(width * height);
  for (let p = 0; p < width * height; p += 1) {
    const i = p * 4;
    lumaBuffer[p] = lumaOf(src[i], src[i + 1], src[i + 2]) / 255;
  }

  /** @param {number} x @param {number} y */
  const at = (x, y) => lumaBuffer[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      let maxMagnitude = 0;
      for (let k = 0; k < thickness; k += 1) {
        const ox = x + k;
        const gx = -at(ox - 1, y - 1) - 2 * at(ox - 1, y) - at(ox - 1, y + 1) + at(ox + 1, y - 1) + 2 * at(ox + 1, y) + at(ox + 1, y + 1);
        const gy = -at(ox - 1, y - 1) - 2 * at(ox, y - 1) - at(ox + 1, y - 1) + at(ox - 1, y + 1) + 2 * at(ox, y + 1) + at(ox + 1, y + 1);
        maxMagnitude = Math.max(maxMagnitude, Math.sqrt(gx * gx + gy * gy));
      }
      const edge = smoothstep(threshold, threshold + 0.35, maxMagnitude);
      if (params.colorEdges && edge > 0.01) {
        dst[i] = src[i] * (1 - fade) + src[i] * edge;
        dst[i + 1] = src[i + 1] * (1 - fade) + src[i + 1] * edge;
        dst[i + 2] = src[i + 2] * (1 - fade) + src[i + 2] * edge;
        dst[i + 3] = src[i + 3];
      } else {
        const baseR = src[i] * (1 - fade) + 255 * fade;
        const baseG = src[i + 1] * (1 - fade) + 255 * fade;
        const baseB = src[i + 2] * (1 - fade) + 255 * fade;
        dst[i] = baseR + (ink[0] - baseR) * edge;
        dst[i + 1] = baseG + (ink[1] - baseG) * edge;
        dst[i + 2] = baseB + (ink[2] - baseB) * edge;
        dst[i + 3] = src[i + 3];
      }
    }
  }
}

/**
 * Pixelate.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passPixelate(src, dst, ctx, params) {
  const { width, height, scale } = ctx;
  const block = Math.max(1, params.blockSize / Math.max(0.05, scale));
  if (block <= 1.0001) {
    dst.set(src);
    return;
  }
  const blocksX = Math.ceil(width / block);
  const blocksY = Math.ceil(height / block);
  for (let by = 0; by < blocksY; by += 1) {
    const y0 = Math.floor(by * block);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((by + 1) * block)));
    for (let bx = 0; bx < blocksX; bx += 1) {
      const x0 = Math.floor(bx * block);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((bx + 1) * block)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        let i = (y * width + x0) * 4;
        for (let x = x0; x < x1; x += 1) {
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          a += src[i + 3];
          n += 1;
          i += 4;
        }
      }
      const inv = n === 0 ? 0 : 1 / n;
      r *= inv; g *= inv; b *= inv; a *= inv;
      for (let y = y0; y < y1; y += 1) {
        let i = (y * width + x0) * 4;
        for (let x = x0; x < x1; x += 1) {
          dst[i] = r;
          dst[i + 1] = g;
          dst[i + 2] = b;
          dst[i + 3] = a;
          i += 4;
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Distortion
 * ------------------------------------------------------------------ */

/**
 * Horizontal wave displacement.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passWave(src, dst, ctx, params) {
  const { width, height, scale } = ctx;
  const amplitude = params.amplitude / Math.max(0.05, scale);
  if (!amplitude) {
    dst.set(src);
    return;
  }
  const wavelength = Math.max(2, params.wavelength / Math.max(0.05, scale));
  const phase = (params.phase * Math.PI) / 180 + ctx.time * (params.animate ?? 0) * Math.PI;
  const sample = new Float32Array(4);
  const kind = params.waveKind ?? 'sine';

  /** @param {number} u */
  const wave = (u) => {
    const x = u / wavelength + phase;
    switch (kind) {
      case 'triangle': return 2 * Math.abs(2 * (x - Math.floor(x + 0.5))) - 1;
      case 'square': return Math.sin(x * Math.PI * 2) >= 0 ? 1 : -1;
      case 'noise': return valueNoise2d(u / wavelength, ctx.time * 2, ctx.seed) * 2 - 1;
      case 'sine':
      default: return Math.sin(x * Math.PI * 2);
    }
  };

  for (let y = 0; y < height; y += 1) {
    const offset = wave(y) * amplitude;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      sampleBilinear(src, width, height, x + 0.5 - offset, y + 0.5, sample);
      dst[i] = sample[0];
      dst[i + 1] = sample[1];
      dst[i + 2] = sample[2];
      dst[i + 3] = sample[3];
    }
  }
}

/**
 * RGB channel offset.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passRgbOffset(src, dst, ctx, params) {
  const { width, height, scale } = ctx;
  const distance = params.distance / Math.max(0.05, scale);
  const angle = ((params.angle + (params.animate ?? 0) * ctx.time * 60) * Math.PI) / 180;
  const dx = Math.cos(angle) * distance;
  const dy = Math.sin(angle) * distance;
  const sample = new Float32Array(4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      sampleBilinear(src, width, height, x + 0.5 - dx, y + 0.5 + dy, sample);
      dst[i] = sample[0];
      sampleBilinear(src, width, height, x + 0.5, y + 0.5, sample);
      dst[i + 1] = sample[1];
      sampleBilinear(src, width, height, x + 0.5 + dx, y + 0.5 - dy, sample);
      dst[i + 2] = sample[2];
      dst[i + 3] = src[i + 3];
    }
  }
}

/**
 * Kaleidoscope.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passKaleidoscope(src, dst, ctx, params) {
  const { width, height } = ctx;
  const segments = Math.max(2, Math.round(params.segments));
  const slice = (Math.PI * 2) / segments;
  const rotation = ((params.rotation + (params.spin ?? 0) * ctx.time) * Math.PI) / 180;
  const zoom = Math.max(0.05, params.zoom);
  const cx = width / 2;
  const cy = height / 2;
  const sample = new Float32Array(4);
  const radius = Math.min(cx, cy);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const distance = Math.sqrt(dx * dx + dy * dy);
      let angle = Math.atan2(dy, dx) + rotation;
      angle = ((angle % slice) + slice) % slice;
      angle = Math.abs(angle - slice / 2);
      const sourceRadius = Math.min(radius, distance / zoom);
      const sx = cx + Math.cos(angle) * sourceRadius;
      const sy = cy + Math.sin(angle) * sourceRadius;
      sampleBilinear(src, width, height, sx, sy, sample);
      dst[i] = sample[0];
      dst[i + 1] = sample[1];
      dst[i + 2] = sample[2];
      dst[i + 3] = sample[3];
    }
  }
}

/**
 * Glitch: slice displacement, block corruption and channel tears.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passGlitch(src, dst, ctx, params) {
  const { width, height, scale, seed } = ctx;
  const amount = params.amount / 100;
  if (amount <= 0) {
    dst.set(src);
    return;
  }
  dst.set(src);
  const slices = Math.max(1, Math.round(params.slices));
  // Quantising time to the glitch rate makes the glitch a step function of the
  // timeline: seeking to a frame reproduces that frame's glitch exactly.
  const tick = Math.floor(ctx.time * Math.max(0.5, params.rate));
  const maxShift = amount * width * 0.22;
  const block = Math.max(2, params.blockSize / Math.max(0.05, scale));
  const sample = new Float32Array(4);

  for (let s = 0; s < slices; s += 1) {
    const roll = hash2d(s, tick, seed);
    if (roll > 0.34 + amount * 0.6) continue;
    const y0 = Math.floor(hash2d(s, tick + 3, seed + 17) * height);
    const sliceHeight = Math.max(1, Math.round(height / slices * (0.25 + hash2d(s, tick + 7, seed + 31) * 0.85)));
    const shift = (hash2d(s, tick + 11, seed + 53) - 0.5) * 2 * maxShift;
    const tear = params.colorTear ? (hash2d(s, tick + 13, seed + 71) - 0.5) * 2 * amount * 18 : 0;
    for (let y = y0; y < Math.min(height, y0 + sliceHeight); y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        sampleBilinear(src, width, height, x + 0.5 - shift, y + 0.5, sample);
        dst[i] = clamp255(sample[0] + tear);
        dst[i + 1] = sample[1];
        dst[i + 2] = clamp255(sample[2] - tear);
        dst[i + 3] = sample[3];
      }
    }
  }

  // Block corruption: a few rectangles get a hard colour displacement.
  const blocks = Math.round(amount * 14);
  for (let b = 0; b < blocks; b += 1) {
    const bx = Math.floor(hash2d(b, tick + 101, seed + 5) * width);
    const by = Math.floor(hash2d(b, tick + 103, seed + 9) * height);
    const bw = Math.round(block * (0.5 + hash2d(b, tick + 107, seed + 13)));
    const bh = Math.round(block * (0.3 + hash2d(b, tick + 109, seed + 19)));
    const shift = Math.round((hash2d(b, tick + 113, seed + 23) - 0.5) * 2 * maxShift);
    for (let y = by; y < Math.min(height, by + bh); y += 1) {
      for (let x = bx; x < Math.min(width, bx + bw); x += 1) {
        const i = (y * width + x) * 4;
        sampleBilinear(src, width, height, x + 0.5 - shift, y + 0.5, sample);
        dst[i] = sample[0];
        dst[i + 1] = sample[1];
        dst[i + 2] = sample[2];
        dst[i + 3] = sample[3];
      }
    }
  }
}

/**
 * Animated noise: film, static, fog and dust.
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {EffectContext} ctx
 * @param {Record<string, any>} params
 */
export function passAnimatedNoise(src, dst, ctx, params) {
  const { width, height, scale, seed } = ctx;
  const cell = Math.max(0.5, params.scale / Math.max(0.05, scale));
  const amount = (params.amount / 100) * 255;
  const t = ctx.time * (params.speed ?? 1);
  const kind = params.noiseKind ?? 'film';

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      let n;
      if (kind === 'film') {
        n = hash2d(Math.floor(x / cell), Math.floor(y / cell), seed + Math.floor(t * 24) * 131);
      } else if (kind === 'static') {
        n = hash2d(x, y, seed + Math.floor(t * 30) * 977);
      } else if (kind === 'fog') {
        n = fbm2d((x / cell) * 0.12, (y / cell) * 0.12 + t * 0.35, seed, 4);
      } else {
        // Dust: sparse bright specks that drift downward.
        const cells = hash2d(Math.floor(x / (cell * 4)), Math.floor((y + t * 30) / (cell * 4)), seed);
        n = cells > 0.985 ? 1 : 0;
      }
      const delta = (n - (kind === 'dust' ? 0 : 0.5)) * amount;
      if (params.mono) {
        dst[i] = clamp255(src[i] + delta);
        dst[i + 1] = clamp255(src[i + 1] + delta);
        dst[i + 2] = clamp255(src[i + 2] + delta);
      } else {
        dst[i] = clamp255(src[i] + delta * 1.1);
        dst[i + 1] = clamp255(src[i + 1] + delta);
        dst[i + 2] = clamp255(src[i + 2] + delta * 0.85);
      }
      dst[i + 3] = src[i + 3];
    }
  }
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

/**
 * @typedef {(src: Uint8ClampedArray, dst: Uint8ClampedArray, ctx: EffectContext, params: Record<string, any>) => void} EffectPass
 */

/** @type {Record<string, EffectPass>} */
export const EFFECT_PASSES = {
  exposure: passExposure,
  contrast: passContrast,
  temperature: passTemperature,
  tint: passTint,
  saturation: passSaturation,
  vibrance: passVibrance,
  fade: passFade,
  levels: passLevels,
  curves: passCurves,
  duotone: passDuotone,
  paletteMap: passPaletteMap,
  bloom: passBloom,
  grain: passGrain,
  paper: passPaper,
  scratches: passScratches,
  vignette: passVignette,
  halftone: passHalftone,
  posterize: passPosterize,
  edges: passEdges,
  pixelate: passPixelate,
  wave: passWave,
  rgbOffset: passRgbOffset,
  kaleidoscope: passKaleidoscope,
  glitch: passGlitch,
  animatedNoise: passAnimatedNoise,
};

/**
 * Effects that need to look at the frames underneath them, plus the ones whose
 * result is a *gate* on the whole layer rather than a per-pixel change. These
 * are handled by the renderer instead of this dispatch table because they need
 * information a pixel pass cannot see: the frame's own time and, for trails and
 * frame stepping, the clip re-rendered at other timestamps.
 *
 * @type {readonly string[]}
 */
export const HISTORY_EFFECTS = Object.freeze(['trails', 'frameStep', 'strobe']);

/**
 * Run one effect instance over a raster in place.
 * @param {Uint8ClampedArray} data
 * @param {EffectContext} ctx
 * @param {string} type
 * @param {Record<string, any>} params
 * @returns {boolean} whether the raster was modified
 */
export function runEffectPass(data, ctx, type, params) {
  const pass = EFFECT_PASSES[type];
  if (!pass) return false;
  // Passes read `src` and write `dst`, so they need a real second buffer.
  // The host supplies one from its pool and reuses it across the whole stack.
  const scratch = ctx.byteScratch ? ctx.byteScratch() : new Uint8ClampedArray(data.length);
  pass(data, scratch, ctx, params);
  data.set(scratch.subarray(0, data.length));
  return true;
}

/**
 * Debug helper: human-readable average colour of a raster.
 * @param {Uint8ClampedArray} data
 * @returns {string}
 */
export function averageColor(data) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n += 1;
  }
  if (!n) return '#000000';
  return rgbToHex(r / n, g / n, b / n);
}

export { lerp, mixHex, withAlpha };
