/**
 * Procedural graphics.
 *
 * Everything here draws into a caller-supplied 2D context using only
 * composition-space coordinates scaled by `unit` (composition pixels per
 * authored pixel). Every random-looking value comes from `spec.seed` through
 * the shared hash functions, so the same seed always draws the same field --
 * in the preview, in the headless export and after a project reload.
 *
 * Each generator also reports the *authored* size it wants to be drawn at, so
 * the layer transform has a stable reference rectangle regardless of preview
 * resolution.
 */

import { clamp01, fbm2d, hash2d, hexToRgb, lerp, mixHex, seededRandom, valueNoise2d, withAlpha } from './math.js';

/** @typedef {import('./schema.js').GraphicSpec} GraphicSpec */

/**
 * @typedef {object} GraphicContext
 * @property {number} width   Target canvas width in device pixels.
 * @property {number} height  Target canvas height in device pixels.
 * @property {number} unit    Device pixels per authored pixel.
 * @property {number} time    Composition time in seconds.
 * @property {number} seed    Layer/clip seed, mixed into the spec seed.
 * @property {number} motion  Signed 0..1 motion cue (used by audio-reactive presets).
 */

/**
 * The authored size a graphic wants: a fraction of the composition, in
 * composition pixels. Kept independent of the render scale on purpose.
 * @param {GraphicSpec} spec
 * @param {number} compositionWidth
 * @param {number} compositionHeight
 * @returns {{width:number, height:number}}
 */
export function graphicSize(spec, compositionWidth, compositionHeight) {
  const widthFraction = clamp01(spec.width ?? 1);
  const heightFraction = clamp01(spec.height ?? 1);
  return {
    width: Math.max(2, Math.round(compositionWidth * widthFraction)),
    height: Math.max(2, Math.round(compositionHeight * heightFraction)),
  };
}

/**
 * Draw a procedural graphic. Returns the authored size it was authored for.
 * @param {CanvasRenderingContext2D} ctx
 * @param {GraphicSpec} spec
 * @param {GraphicContext} context
 * @returns {{width:number, height:number}}
 */
export function drawGraphic(ctx, spec, context) {
  const kind = spec.kind ?? 'gradient';
  ctx.save();
  ctx.clearRect(0, 0, context.width, context.height);
  switch (kind) {
    case 'shape': drawShape(ctx, spec, context); break;
    case 'particles': drawParticles(ctx, spec, context); break;
    case 'waveform': drawWaveform(ctx, spec, context); break;
    case 'bars': drawBars(ctx, spec, context); break;
    case 'rings': drawRings(ctx, spec, context); break;
    case 'noise': drawNoise(ctx, spec, context); break;
    case 'grid': drawGrid(ctx, spec, context); break;
    case 'text': drawProceduralText(ctx, spec, context); break;
    case 'gradient':
    default: drawGradient(ctx, spec, context); break;
  }
  ctx.restore();
  return { width: context.width / context.unit, height: context.height / context.unit };
}

/* ------------------------------------------------------------------ *
 * Gradient
 * ------------------------------------------------------------------ */

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {GraphicSpec} spec
 * @param {GraphicContext} context
 */
function drawGradient(ctx, spec, context) {
  const { width, height, time, unit } = context;
  const variant = spec.gradientKind ?? 'aurora';
  const speed = spec.speed ?? 1;
  const t = time * speed;

  if (variant === 'linear') {
    const angle = ((spec.rotation ?? 0) * Math.PI) / 180;
    const dx = Math.cos(angle) * width * 0.5;
    const dy = Math.sin(angle) * height * 0.5;
    const gradient = ctx.createLinearGradient(width / 2 - dx, height / 2 - dy, width / 2 + dx, height / 2 + dy);
    gradient.addColorStop(0, spec.colorA);
    gradient.addColorStop(0.5, spec.colorC || mixHex(spec.colorA, spec.colorB, 0.5));
    gradient.addColorStop(1, spec.colorB);
    const shift = (t * 0.1) % 1;
    ctx.save();
    ctx.translate(-shift * width, 0);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width * 2, height);
    ctx.restore();
    return;
  }

  if (variant === 'radial') {
    const pulse = 1 + Math.sin(t * Math.PI * 2 * 0.25) * 0.12 * (spec.amount ?? 0.5);
    const cx = width * (0.5 + Math.sin(t * 0.21) * 0.08);
    const cy = height * (0.5 + Math.cos(t * 0.17) * 0.08);
    const radius = Math.max(1, Math.max(width, height) * 0.72 * pulse);
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, spec.colorA);
    gradient.addColorStop(0.55, spec.colorC || mixHex(spec.colorA, spec.colorB, 0.5));
    gradient.addColorStop(1, spec.colorB);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    return;
  }

  if (variant === 'conic') {
    const rotation = ((spec.rotation ?? 0) + t * 24) * (Math.PI / 180);
    const steps = 96;
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.hypot(width, height);
    for (let i = 0; i < steps; i += 1) {
      const from = rotation + (i / steps) * Math.PI * 2;
      const to = rotation + ((i + 1.02) / steps) * Math.PI * 2;
      const mix = i / steps;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, from, to);
      ctx.closePath();
      ctx.fillStyle = mixHex(spec.colorA, spec.colorB, (mix + t * 0.08) % 1);
      ctx.fill();
    }
    return;
  }

  if (variant === 'mesh') {
    ctx.fillStyle = spec.colorA;
    ctx.fillRect(0, 0, width, height);
    const blobs = Math.max(2, Math.round((spec.count ?? 6) / 12));
    for (let i = 0; i < blobs; i += 1) {
      const seed = (spec.seed ?? 1) + i * 977;
      const phase = hash2d(i, 3, spec.seed ?? 1) * Math.PI * 2;
      const cx = width * (0.5 + Math.sin(t * 0.22 + phase) * 0.32);
      const cy = height * (0.5 + Math.cos(t * 0.18 + phase * 1.3) * 0.32);
      const radius = Math.max(width, height) * (0.25 + hash2d(i, 7, seed) * 0.3);
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      const colour = i % 2 === 0 ? spec.colorB : (spec.colorC || mixHex(spec.colorA, spec.colorB, 0.5));
      gradient.addColorStop(0, withAlpha(colour, 0.85));
      gradient.addColorStop(1, withAlpha(colour, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }
    return;
  }

  // aurora (default): layered ribbons drifting across the frame
  ctx.fillStyle = spec.colorA;
  ctx.fillRect(0, 0, width, height);
  const bands = 5;
  for (let band = 0; band < bands; band += 1) {
    const phase = (band / bands) * Math.PI * 2 + t * (0.12 + band * 0.03);
    const colour = mixHex(band % 2 === 0 ? spec.colorA : spec.colorB, spec.colorC || spec.colorB, (band / bands) * 0.7);
    ctx.beginPath();
    const steps = 64;
    ctx.moveTo(0, height);
    for (let i = 0; i <= steps; i += 1) {
      const x = (i / steps) * width;
      const u = i / steps;
      const wave = Math.sin(u * Math.PI * 2 * 1.4 + phase) * 0.5 + Math.sin(u * Math.PI * 2 * 0.7 - phase * 1.7) * 0.5;
      const noise = fbm2d(u * 3 + t * 0.3, band * 1.7 + t * 0.12, (spec.seed ?? 1) + band * 131, 3) - 0.5;
      const y = height * (0.32 + (band / bands) * 0.5) + wave * height * 0.11 * (spec.amount ?? 0.5) * 2 + noise * height * 0.1;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.globalAlpha = 0.5 + 0.28 * (band / bands);
    ctx.fillStyle = colour;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const glow = ctx.createRadialGradient(width * 0.5, height * 0.35, 0, width * 0.5, height * 0.35, Math.max(width, height) * 0.7);
  glow.addColorStop(0, withAlpha(spec.colorC || '#ffffff', 0.28 + 0.2 * (spec.amount ?? 0.5)));
  glow.addColorStop(1, withAlpha(spec.colorC || '#ffffff', 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  if (spec.complexity > 0.5) {
    // Fine grain over the gradient keeps flat areas from banding.
    const cells = 90;
    ctx.globalAlpha = 0.05;
    for (let i = 0; i < cells * 6; i += 1) {
      const x = hash2d(i, 1, spec.seed ?? 1) * width;
      const y = hash2d(i, 2, spec.seed ?? 1) * height;
      ctx.fillStyle = i % 2 ? '#ffffff' : '#000000';
      ctx.fillRect(x, y, 1.5 * unit, 1.5 * unit);
    }
    ctx.globalAlpha = 1;
  }
}

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {GraphicSpec} spec
 * @param {GraphicContext} context
 */
function drawShape(ctx, spec, context) {
  const { width, height, unit, time } = context;
  const count = Math.max(1, Math.round(spec.count ?? 6));
  const kind = spec.shapeKind ?? 'circle';
  const random = seededRandom((spec.seed ?? 1) * 2654435761);

  for (let i = 0; i < count; i += 1) {
    const phase = random() * Math.PI * 2;
    const baseX = random();
    const baseY = random();
    const sizeBase = lerp(0.35, 1, random()) * (spec.size ?? 0.5);
    const speed = spec.speed ?? 1;
    const drift = (spec.spread ?? 0.5) * 0.5;
    const cx = width * (baseX + Math.sin(time * speed * 0.35 + phase) * drift);
    const cy = height * (baseY + Math.cos(time * speed * 0.29 + phase * 1.4) * drift);
    const radius = Math.max(1, Math.min(width, height) * sizeBase * 0.5);
    const rotation = ((spec.rotation ?? 0) + time * speed * 12 + phase * 57) * (Math.PI / 180);
    const colour = mixHex(spec.colorA, i % 2 === 0 ? spec.colorB : (spec.colorC || spec.colorB), (i / Math.max(1, count)) * 0.8);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    ctx.fillStyle = withAlpha(colour, 0.55 + 0.4 * ((i % 3) / 2));
    ctx.strokeStyle = withAlpha(spec.colorB, 0.9);
    ctx.lineWidth = Math.max(1, 2 * unit);
    switch (kind) {
      case 'rect':
        ctx.fillRect(-radius, -radius * 0.7, radius * 2, radius * 1.4);
        ctx.strokeRect(-radius, -radius * 0.7, radius * 2, radius * 1.4);
        break;
      case 'triangle':
        ctx.beginPath();
        ctx.moveTo(0, -radius);
        ctx.lineTo(radius * 0.9, radius * 0.7);
        ctx.lineTo(-radius * 0.9, radius * 0.7);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        break;
      case 'star': {
        const points = 5;
        ctx.beginPath();
        for (let p = 0; p < points * 2; p += 1) {
          const r = p % 2 === 0 ? radius : radius * 0.44;
          const angle = (p / (points * 2)) * Math.PI * 2 - Math.PI / 2;
          const px = Math.cos(angle) * r;
          const py = Math.sin(angle) * r;
          if (p === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        break;
      }
      case 'ring':
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(1, radius * 0.18);
        ctx.strokeStyle = withAlpha(colour, 0.95);
        ctx.stroke();
        break;
      case 'line':
        ctx.beginPath();
        ctx.moveTo(-radius, 0);
        ctx.lineTo(radius, 0);
        ctx.lineWidth = Math.max(1, radius * (spec.size ?? 0.5) * 0.12);
        ctx.strokeStyle = withAlpha(colour, 0.95);
        ctx.stroke();
        break;
      case 'circle':
      default:
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        break;
    }
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ *
 * Particles
 * ------------------------------------------------------------------ */

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {GraphicSpec} spec
 * @param {GraphicContext} context
 */
function drawParticles(ctx, spec, context) {
  const { width, height, unit, time } = context;
  const count = Math.max(1, Math.round(spec.count ?? 120));
  const random = seededRandom(((spec.seed ?? 1) ^ 0x9e3779b9) >>> 0);
  const speed = spec.speed ?? 1;
  const sizeBase = (spec.size ?? 0.5) * Math.min(width, height) * 0.02;
  const spread = spec.spread ?? 0.5;
  const trail = spec.amount ?? 0.5;
  const turbulence = Math.max(0, (spec.complexity ?? 3) - 1) * 0.2;

  for (let i = 0; i < count; i += 1) {
    const seedX = random();
    const seedY = random();
    const phase = random() * Math.PI * 2;
    const radiusJitter = 0.5 + random();
    const depth = random();
    // Deterministic per-particle drift: functions of time, never of frame count.
    const wobbleX = Math.sin(time * speed * (0.2 + depth * 0.5) + phase) * spread * width * 0.28;
    const wobbleY = Math.cos(time * speed * (0.17 + depth * 0.43) + phase * 1.7) * spread * height * 0.28;
    const flow = turbulence
      ? (valueNoise2d(seedX * 4 + time * speed * 0.25, seedY * 4, spec.seed ?? 1) - 0.5) * width * turbulence
      : 0;
    const x = seedX * width + wobbleX + flow;
    const y = seedY * height + wobbleY;
    const radius = Math.max(0.5 * unit, sizeBase * radiusJitter * (0.4 + depth));
    const colour = mixHex(spec.colorA, depth > 0.6 ? (spec.colorC || spec.colorB) : spec.colorB, depth);
    const alpha = 0.25 + depth * 0.7;

    if (trail > 0.05) {
      const previousX = x - wobbleX * 0.12 * trail - flow * 0.1 * trail;
      const previousY = y - wobbleY * 0.12 * trail;
      ctx.beginPath();
      ctx.moveTo(previousX, previousY);
      ctx.lineTo(x, y);
      ctx.strokeStyle = withAlpha(colour, alpha * 0.5 * trail);
      ctx.lineWidth = radius * (0.5 + trail);
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(colour, alpha);
    ctx.fill();
  }

  if ((spec.complexity ?? 3) >= 4) {
    const glow = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.6);
    glow.addColorStop(0, withAlpha(spec.colorA, 0.22));
    glow.addColorStop(1, withAlpha(spec.colorA, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
  }
}

/* ------------------------------------------------------------------ *
 * Waveform & bars
 * ------------------------------------------------------------------ */

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {GraphicSpec} spec
 * @param {GraphicContext} context
 */
function drawWaveform(ctx, spec, context) {
  const { width, height, unit, time } = context;
  const lines = Math.max(1, Math.round((spec.count ?? 3)));
  const speed = spec.speed ?? 1;
  const amplitude = (spec.size ?? 0.5) * height * 0.4;
  const smoothing = clamp01(spec.smoothing ?? 0.6);
  const steps = Math.max(24, Math.round(width / (6 * unit)));

  for (let line = 0; line < lines; line += 1) {
    const phase = (line / lines) * Math.PI * 2 + time * speed * 0.6;
    const colour = mixHex(spec.colorA, spec.colorB, line / Math.max(1, lines - 1 || 1));
    ctx.beginPath();
    for (let i = 0; i <= steps; i += 1) {
      const u = i / steps;
      const x = u * width;
      const noise = fbm2d(u * 4 + time * speed * 0.4, line * 3.1 + time * speed * 0.2, (spec.seed ?? 1) + line * 71, 3) - 0.5;
      const wave = Math.sin(u * Math.PI * 2 * (1 + line) + phase) * 0.6 + Math.sin(u * Math.PI * 6.3 - phase * 1.6) * 0.4;
      const envelope = lerp(1, Math.sin(u * Math.PI), smoothing);
      const y = height / 2 + (wave * (1 - noise * 0.4) + noise * 2) * amplitude * envelope;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = withAlpha(colour, 0.85);
    ctx.lineWidth = Math.max(1, (2 + line) * unit);
    ctx.lineJoin = 'round';
    ctx.shadowColor = withAlpha(colour, 0.6);
    ctx.shadowBlur = 12 * unit;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {GraphicSpec} spec
 * @param {GraphicContext} context
 */
function drawBars(ctx, spec, context) {
  const { width, height, unit, time } = context;
  const count = Math.max(2, Math.round(spec.bandCount ?? 48));
  const gap = Math.max(1 * unit, width / count * 0.18);
  const barWidth = (width - gap * (count - 1)) / count;
  const speed = spec.speed ?? 1;
  const amount = spec.amount ?? 0.5;
  const mirrored = spec.mirror !== false;

  for (let i = 0; i < count; i += 1) {
    const u = i / (count - 1 || 1);
    // Deterministic pseudo-spectrum: fbm keeps neighbouring bands related so
    // the result reads as music rather than noise.
    const spectrum = fbm2d(u * 6 + time * speed * 0.7, time * speed * 0.35, (spec.seed ?? 1) + 13, 3);
    const tilt = 1 - Math.pow(u, 1.6) * 0.75;
    const value = clamp01(spectrum * tilt * (0.6 + amount * 0.9) + 0.06);
    const barHeight = Math.max(1 * unit, value * height * 0.92);
    const x = i * (barWidth + gap);
    const colour = mixHex(spec.colorA, spec.colorB, u);
    ctx.fillStyle = colour;
    if (mirrored) {
      ctx.fillRect(x, height / 2 - barHeight / 2, barWidth, barHeight);
    } else {
      ctx.fillRect(x, height - barHeight, barWidth, barHeight);
    }
    if (spec.complexity >= 4) {
      ctx.fillStyle = withAlpha(spec.colorC || '#ffffff', 0.5);
      const capHeight = Math.max(1 * unit, barHeight * 0.12);
      if (mirrored) ctx.fillRect(x, height / 2 - barHeight / 2, barWidth, capHeight);
      else ctx.fillRect(x, height - barHeight, barWidth, capHeight);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Rings / grid / noise
 * ------------------------------------------------------------------ */

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {GraphicSpec} spec
 * @param {GraphicContext} context
 */
function drawRings(ctx, spec, context) {
  const { width, height, unit, time } = context;
  const count = Math.max(1, Math.round(spec.count ?? 12));
  const cx = width / 2;
  const cy = height / 2;
  const maxRadius = Math.min(width, height) * 0.5;
  const speed = spec.speed ?? 1;
  const pulse = spec.amount ?? 0.5;

  for (let i = 0; i < count; i += 1) {
    const u = (i + 1) / count;
    const breath = 1 + Math.sin(time * speed * 0.8 - u * Math.PI * 2) * 0.12 * pulse * 2;
    const radius = maxRadius * u * breath;
    const colour = mixHex(spec.colorA, spec.colorB, u);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(0.5, radius), 0, Math.PI * 2);
    ctx.strokeStyle = withAlpha(colour, 0.28 + 0.6 * (1 - u));
    ctx.lineWidth = Math.max(0.75 * unit, (1 + (1 - u) * 4) * unit);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(cx, cy, maxRadius * 0.08 * (1 + pulse), 0, Math.PI * 2);
  ctx.fillStyle = withAlpha(spec.colorC || '#ffffff', 0.85);
  ctx.fill();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {GraphicSpec} spec
 * @param {GraphicContext} context
 */
function drawGrid(ctx, spec, context) {
  const { width, height, unit, time } = context;
  const columns = Math.max(2, Math.round(spec.count ?? 12));
  const cell = width / columns;
  const rows = Math.max(1, Math.round(height / cell));
  const speed = spec.speed ?? 1;
  const drift = ((time * speed * 0.15) % 1) * cell;
  const thickness = Math.max(0.5 * unit, (spec.size ?? 0.5) * 3 * unit);
  const amount = spec.amount ?? 0.5;

  ctx.save();
  ctx.translate(-drift, -drift);
  for (let column = -1; column <= columns + 1; column += 1) {
    const x = column * cell;
    const pulse = 0.35 + 0.65 * fbm2d(column * 0.7 + time * speed * 0.3, 0, (spec.seed ?? 1) + 5, 2);
    ctx.strokeStyle = withAlpha(spec.colorA, pulse * (0.4 + amount * 0.6));
    ctx.lineWidth = thickness;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height + cell);
    ctx.stroke();
  }
  for (let row = -1; row <= rows + 1; row += 1) {
    const y = row * cell;
    const pulse = 0.35 + 0.65 * fbm2d(0, row * 0.7 - time * speed * 0.24, (spec.seed ?? 1) + 9, 2);
    ctx.strokeStyle = withAlpha(spec.colorB, pulse * (0.4 + amount * 0.6));
    ctx.lineWidth = thickness;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width + cell, y);
    ctx.stroke();
  }
  ctx.restore();

  if (amount > 0.6) {
    const step = Math.max(2, Math.round(cell / 4));
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const n = hash2d(Math.floor(x / step), Math.floor(y / step), spec.seed ?? 1);
        if (n > 0.93) {
          ctx.fillStyle = withAlpha(spec.colorC || '#ffffff', (n - 0.93) * 8);
          ctx.fillRect(x, y, step * 0.5, step * 0.5);
        }
      }
    }
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {GraphicSpec} spec
 * @param {GraphicContext} context
 */
function drawNoise(ctx, spec, context) {
  const { width, height, unit, time, seed } = context;
  const cell = Math.max(1, (spec.size ?? 0.5) * 30 * unit);
  const speed = spec.speed ?? 1;
  const octaves = Math.max(1, Math.round(spec.complexity ?? 3));
  const colourA = hexToRgb(spec.colorA);
  const colourB = hexToRgb(spec.colorB);
  const amount = spec.amount ?? 0.5;

  const columns = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const n = fbm2d(column * 0.08 + time * speed * 0.12, row * 0.08, (spec.seed ?? 1) + seed, octaves);
      const shaped = clamp01((n - 0.5) * (1 + amount * 1.6) + 0.5);
      const r = lerp(colourA[0], colourB[0], shaped);
      const g = lerp(colourA[1], colourB[1], shaped);
      const b = lerp(colourA[2], colourB[2], shaped);
      ctx.fillStyle = `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
      ctx.fillRect(column * cell, row * cell, cell + 1, cell + 1);
    }
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {GraphicSpec} spec
 * @param {GraphicContext} context
 */
function drawProceduralText(ctx, spec, context) {
  const { width, height, unit, time } = context;
  const label = spec.text || 'MOTION LAB';
  const fontSize = Math.max(8 * unit, height * 0.24);
  ctx.font = `700 ${fontSize}px Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const gradient = ctx.createLinearGradient(0, height * 0.3, 0, height * 0.7);
  gradient.addColorStop(0, spec.colorA);
  gradient.addColorStop(1, spec.colorB);
  ctx.fillStyle = gradient;
  ctx.shadowColor = withAlpha(spec.colorA, 0.7);
  ctx.shadowBlur = 24 * unit * (0.4 + (spec.amount ?? 0.5));
  const wobble = Math.sin(time * (spec.speed ?? 1) * 1.2) * height * 0.01;
  ctx.fillText(label, width / 2, height / 2 + wobble);
  ctx.shadowBlur = 0;
}

/* ------------------------------------------------------------------ *
 * Thumbnails
 * ------------------------------------------------------------------ */

/**
 * Draw a small preview of a graphic into an existing context. Used by the
 * library tiles and the "add graphic" picker.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} kind
 * @param {number} size
 * @param {Partial<GraphicSpec>} [overrides]
 * @param {number} [time]
 */
export function drawGraphicThumbnail(ctx, kind, size, overrides = {}, time = 1.4) {
  const spec = /** @type {GraphicSpec} */ ({
    kind,
    seed: 20240,
    colorA: '#ff2e88',
    colorB: '#12d6ff',
    colorC: '#ffd166',
    amount: 0.6,
    count: kind === 'particles' ? 90 : kind === 'grid' ? 8 : 12,
    speed: 1,
    size: 0.55,
    spread: 0.5,
    complexity: 3,
    rotation: 0,
    width: 1,
    height: 1,
    shapeKind: 'circle',
    gradientKind: 'aurora',
    bandCount: 28,
    smoothing: 0.6,
    mirror: true,
    text: 'MOTION',
    ...overrides,
  });
  drawGraphic(ctx, spec, {
    width: size,
    height: size,
    unit: size / 200,
    time,
    seed: 20240,
    motion: 0,
  });
}
