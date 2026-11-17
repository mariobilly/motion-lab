/**
 * Small numeric toolbox shared by the engine, the UI and the server.
 * No DOM, no Node APIs -- this file runs identically in all three.
 */

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/**
 * @param {number} value
 * @returns {number} clamped to 0..1
 */
export function clamp01(value) {
  return clamp(value, 0, 1);
}

/**
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * @param {number} a
 * @param {number} b
 * @param {number} value
 * @returns {number} 0..1
 */
export function inverseLerp(a, b, value) {
  if (a === b) return 0;
  return clamp01((value - a) / (b - a));
}

/**
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} value
 * @returns {number}
 */
export function smoothstep(edge0, edge1, value) {
  const t = inverseLerp(edge0, edge1, value);
  return t * t * (3 - 2 * t);
}

/**
 * Map a value from one range into another, clamped at both ends.
 * @param {number} value
 * @param {number} inMin
 * @param {number} inMax
 * @param {number} outMin
 * @param {number} outMax
 * @returns {number}
 */
export function remap(value, inMin, inMax, outMin, outMax) {
  return lerp(outMin, outMax, inverseLerp(inMin, inMax, value));
}

/**
 * Exponential smoothing that is frame-rate independent: `tau` is the time in
 * seconds to close ~63% of the gap.
 * @param {number} current
 * @param {number} target
 * @param {number} tau
 * @param {number} dt
 * @returns {number}
 */
export function approach(current, target, tau, dt) {
  if (tau <= 1e-6) return target;
  return target + (current - target) * Math.exp(-dt / tau);
}

/**
 * Euclidean modulo (always positive for positive modulus).
 * @param {number} a
 * @param {number} n
 * @returns {number}
 */
export function mod(a, n) {
  return ((a % n) + n) % n;
}

/**
 * @param {number} degrees
 * @returns {number}
 */
export function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/**
 * Cubic ease-in-out, the classic `ease` curve.
 * @param {number} t
 * @returns {number}
 */
export function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * @param {number} t
 * @returns {number}
 */
export function easeIn(t) {
  return t * t * t;
}

/**
 * @param {number} t
 * @returns {number}
 */
export function easeOut(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Solve a CSS-style cubic-bezier timing function. `x1,y1,x2,y2` are the two
 * control handles; the curve always starts at (0,0) and ends at (1,1).
 *
 * Newton-Raphson with a bisection fallback -- fast enough to run per property
 * per frame and accurate to ~1e-6, so preview and export agree exactly.
 *
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @param {number} x  Input progress 0..1
 * @returns {number} Eased progress 0..1
 */
export function cubicBezier(x1, y1, x2, y2, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  /** @param {number} t */
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  /** @param {number} t */
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  /** @param {number} t */
  const sampleDX = (t) => (3 * ax * t + 2 * bx) * t + cx;

  let t = x;
  for (let i = 0; i < 8; i += 1) {
    const error = sampleX(t) - x;
    if (Math.abs(error) < 1e-7) return sampleY(t);
    const slope = sampleDX(t);
    if (Math.abs(slope) < 1e-7) break;
    t -= error / slope;
  }

  let low = 0;
  let high = 1;
  t = x;
  for (let i = 0; i < 30; i += 1) {
    const current = sampleX(t);
    if (Math.abs(current - x) < 1e-7) break;
    if (current < x) low = t;
    else high = t;
    t = (low + high) / 2;
  }
  return sampleY(t);
}

/* ------------------------------------------------------------------ *
 * Deterministic noise
 *
 * Every stochastic effect in Motion Lab is a pure hash of (coordinate, seed),
 * never Math.random(). That is what makes an exported frame byte-identical to
 * the preview of the same frame.
 * ------------------------------------------------------------------ */

/**
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @returns {number} 0..1
 */
export function hash2d(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * @param {number} n
 * @param {number} seed
 * @returns {number} 0..1
 */
export function hash1d(n, seed) {
  return hash2d(n, 0x9e37, seed);
}

/**
 * Deterministic pseudo-random sequence -- a tiny xorshift PRNG derived from a
 * seed. Used for particle fields, so the same seed always produces the same
 * field while the UI stays free to re-render as often as it likes.
 * @param {number} seed
 * @returns {() => number} generator returning 0..1
 */
export function seededRandom(seed) {
  let state = (seed | 0) || 0x2f6e2b1;
  return function next() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1000000) / 1000000;
  };
}

/**
 * Smoothstep-interpolated value noise in 1D.
 * @param {number} x
 * @param {number} seed
 * @returns {number} 0..1
 */
export function valueNoise1d(x, seed) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash1d(i, seed), hash1d(i + 1, seed), u);
}

/**
 * Smoothstep-interpolated value noise in 2D.
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @returns {number} 0..1
 */
export function valueNoise2d(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const n00 = hash2d(ix, iy, seed);
  const n10 = hash2d(ix + 1, iy, seed);
  const n01 = hash2d(ix, iy + 1, seed);
  const n11 = hash2d(ix + 1, iy + 1, seed);
  return lerp(lerp(n00, n10, ux), lerp(n01, n11, ux), uy);
}

/**
 * Fractal Brownian motion over `valueNoise2d`.
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @param {number} octaves
 * @param {number} [gain]
 * @param {number} [lacunarity]
 * @returns {number} ~0..1
 */
export function fbm2d(x, y, seed, octaves, gain = 0.5, lacunarity = 2) {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let total = 0;
  const octaveCount = Math.max(1, Math.min(8, Math.round(octaves)));
  for (let i = 0; i < octaveCount; i += 1) {
    sum += amplitude * valueNoise2d(x * frequency, y * frequency, seed + i * 7919);
    total += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return total > 0 ? sum / total : 0;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @param {number} octaves
 * @returns {number} ~-1..1
 */
export function fbm2dSigned(x, y, seed, octaves) {
  return fbm2d(x, y, seed, octaves) * 2 - 1;
}

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

/**
 * @param {string} hex
 * @returns {[number, number, number]} 0..255
 */
export function hexToRgb(hex) {
  let value = String(hex || '').trim().replace('#', '');
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  if (value.length === 8) value = value.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return [255, 255, 255];
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string}
 */
export function rgbToHex(r, g, b) {
  const to = (/** @type {number} */ v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/**
 * `#rrggbb` + alpha -> `rgba(...)` string usable by canvas.
 * @param {string} hex
 * @param {number} alpha
 * @returns {string}
 */
export function withAlpha(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha)})`;
}

/**
 * @param {[number, number, number]} rgb
 * @returns {number} Rec.709 luma, 0..255
 */
export function luma(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/**
 * Mix two hex colours in sRGB space.
 * @param {string} a
 * @param {string} b
 * @param {number} t
 * @returns {string}
 */
export function mixHex(a, b, t) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex(lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t));
}

/**
 * Perceptual-ish luminance of a hex colour, 0..1.
 * @param {string} hex
 * @returns {number}
 */
export function hexLuma(hex) {
  return luma(hexToRgb(hex)) / 255;
}

/**
 * Bilinear sample from an interleaved RGBA raster with edge clamping. Shared by
 * every geometric effect pass. Works on byte rasters and on float scratch
 * rasters (bloom's bright-pass buffers).
 *
 * @param {Uint8ClampedArray|Float32Array} src
 * @param {number} width
 * @param {number} height
 * @param {number} x
 * @param {number} y
 * @param {Uint8ClampedArray|Float32Array} out  Receives 4 values.
 * @returns {void}
 */
export function sampleBilinear(src, width, height, x, y, out) {
  const cx = clamp(x, 0, width - 1);
  const cy = clamp(y, 0, height - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;
  for (let c = 0; c < 4; c += 1) {
    const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
    const bottom = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
    out[c] = top + (bottom - top) * fy;
  }
}

/**
 * Format a number for display: fixed decimals, but no trailing zero noise.
 * @param {number} value
 * @param {number} [decimals]
 * @returns {string}
 */
export function formatNumber(value, decimals = 2) {
  if (!Number.isFinite(value)) return '0';
  const fixed = value.toFixed(decimals);
  return fixed.replace(/\.?0+$/, '') || '0';
}

/**
 * Human byte size.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, index);
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}
