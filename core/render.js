/**
 * The frame renderer.
 *
 * One function -- `renderFrame` -- draws a composition at a given time into a
 * given canvas context. The interactive preview, the headless export harness
 * and the automated tests all call it with the same plan, which is why an
 * exported frame matches the preview of the same timestamp.
 *
 * Resolution independence
 * -----------------------
 * `RenderContext.deviceScale` is composition pixels per device pixel: 1 for a
 * full-resolution render, 0.25 for a quarter-resolution preview. Every length
 * that describes *artwork* (grain size, halftone spacing, stroke widths, mask
 * feather) is divided by that scale, so it covers the same fraction of the
 * picture at any preview quality. Composition timing never depends on it.
 *
 * Draw order within a clip
 * ------------------------
 *   source raster -> crop -> output effects (trails, frame stepping)
 *   -> geometry -> masks -> effects stack -> blend onto the parent
 *
 * Adjustment layers sit in the same track stack as everything else: they take
 * the accumulated artwork underneath, run their stack over it and write it
 * back, so they affect "all visual layers beneath them" exactly as advertised.
 */

import { clipActiveAt, clipSourceTime, emptyEffects } from './schema.js';
import { effectDefinition, isEffectNeutral } from './effectRegistry.js';
import { runEffectPass, HISTORY_EFFECTS } from './effects.js';
import { channelValue, normalizeEasing, evaluateKeys, findChannel } from './keyframes.js';
import { transformChannelSpecs, maskChannelSpecs } from './channels.js';
import { applyModulation, markerTimes } from './audio.js';
import { clamp, clamp01, lerp, toRadians, withAlpha } from './math.js';
import { drawGraphic, graphicSize } from './graphics.js';

/** @typedef {import('./schema.js').ProjectDoc} ProjectDoc */
/** @typedef {import('./schema.js').Clip} Clip */
/** @typedef {import('./schema.js').Composition} Composition */
/** @typedef {import('./schema.js').Transform} Transform */
/** @typedef {import('./schema.js').Mask} Mask */
/** @typedef {import('./schema.js').EffectInstance} EffectInstance */

/* ------------------------------------------------------------------ *
 * Runtime interfaces supplied by the host (browser or harness)
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} FrameSource
 * @property {(assetId: string) => {width:number, height:number}|null} size
 * @property {(assetId: string, sourceTime: number) => CanvasImageSource|null} frame
 *   Returns something drawable for the asset at `sourceTime` seconds. The
 *   browser implementation seeks a <video>; the export harness looks the frame
 *   up in a pre-extracted index. Either way the *renderer* does not care.
 */

/**
 * @typedef {object} AssetResolver
 * @property {(assetId: string) => {width:number, height:number, duration:number, kind:string}|null} meta
 */

/* ------------------------------------------------------------------ *
 * Effect parameters
 * ------------------------------------------------------------------ */

/**
 * Resolve an effect instance's parameters for a frame: registry defaults, then
 * the stored values, then keyframes or audio modulation on top.
 *
 * @param {EffectInstance} instance
 * @param {Clip} clip
 * @param {number} time
 * @param {PlanContext} plan
 * @returns {Record<string, any>}
 */
export function resolveEffectParams(instance, clip, time, plan) {
  const definition = effectDefinition(instance.type);
  /** @type {Record<string, any>} */
  const params = {};
  const mods = plan.modulation;

  for (const spec of definition.params) {
    let value = instance.params[spec.key] !== undefined ? instance.params[spec.key] : spec.default;
    if (spec.kind === 'number') {
      const base = typeof value === 'number' ? value : Number(spec.default);
      const channel = `effects.${instance.id}.${spec.key}`;
      const keyed = channelValue(clip, channel, time, base);
      const modulated = mods.length
        ? applyModulation(keyed, channel, mods, clip.id, time, plan.fps, plan.rangeStart, spec.min ?? -Infinity, spec.max ?? Infinity)
        : keyed;
      value = modulated;
    }
    params[spec.key] = value;
  }
  return params;
}

/* ------------------------------------------------------------------ *
 * Plan
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} PlanContext
 * @property {number} fps
 * @property {number} rangeStart
 * @property {import('./audio.js').MappingCurve[]} modulation
 * @property {EffectInstance[]} adjustmentStack  Reference stack used for caching decisions.
 */

/**
 * Build the small context every channel lookup needs.
 * @param {ProjectDoc} doc
 * @param {{rangeStart?:number, modulation?:import('./audio.js').MappingCurve[]}} [options]
 * @returns {PlanContext}
 */
export function createPlanContext(doc, options = {}) {
  return {
    fps: doc.composition.fps,
    rangeStart: options.rangeStart ?? 0,
    modulation: options.modulation ?? [],
    adjustmentStack: [],
  };
}

/**
 * Fully resolved transform for a clip at a time, including keyframes and audio.
 * @param {Clip} clip
 * @param {number} time
 * @param {import('./schema.js').Composition} composition
 * @param {PlanContext} plan
 * @returns {Transform}
 */
export function resolveTransform(clip, time, composition, plan) {
  const base = clip.transform;
  const specs = transformChannelSpecs(composition);
  const mods = plan.modulation;

  /**
   * @param {string} channel
   * @param {number} fallback
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  const read = (channel, fallback, min, max) => {
    let value = channelValue(clip, channel, time, fallback);
    if (mods.length) value = applyModulation(value, channel, mods, clip.id, time, plan.fps, plan.rangeStart, min, max);
    return value;
  };

  /** @param {string} id */
  const specOf = (id) => specs.find((entry) => entry.id === id) ?? { min: -Infinity, max: Infinity, base: 0 };

  const s = {
    'transform.position.x': specOf('transform.position.x'),
    'transform.position.y': specOf('transform.position.y'),
    'transform.scale.x': specOf('transform.scale.x'),
    'transform.scale.y': specOf('transform.scale.y'),
    'transform.rotation': specOf('transform.rotation'),
    'transform.opacity': specOf('transform.opacity'),
    'transform.anchor.x': specOf('transform.anchor.x'),
    'transform.anchor.y': specOf('transform.anchor.y'),
    'transform.crop.top': specOf('transform.crop.top'),
    'transform.crop.right': specOf('transform.crop.right'),
    'transform.crop.bottom': specOf('transform.crop.bottom'),
    'transform.crop.left': specOf('transform.crop.left'),
  };

  return {
    x: read('transform.position.x', base.x, s['transform.position.x'].min, s['transform.position.x'].max),
    y: read('transform.position.y', base.y, s['transform.position.y'].min, s['transform.position.y'].max),
    scaleX: read('transform.scale.x', base.scaleX, 0, 12),
    scaleY: read('transform.scale.y', base.scaleY, 0, 12),
    rotation: read('transform.rotation', base.rotation, -100000, 100000),
    opacity: clamp01(read('transform.opacity', base.opacity, 0, 1)),
    anchorX: read('transform.anchor.x', base.anchorX, -4, 5),
    anchorY: read('transform.anchor.y', base.anchorY, -4, 5),
    cropTop: clamp(read('transform.crop.top', base.cropTop, 0, 0.98), 0, 0.98),
    cropRight: clamp(read('transform.crop.right', base.cropRight, 0, 0.98), 0, 0.98),
    cropBottom: clamp(read('transform.crop.bottom', base.cropBottom, 0, 0.98), 0, 0.98),
    cropLeft: clamp(read('transform.crop.left', base.cropLeft, 0, 0.98), 0, 0.98),
  };
}

/**
 * Resolved mask geometry at a time.
 * @param {Mask} mask
 * @param {Clip} clip
 * @param {number} time
 * @param {PlanContext} plan
 * @returns {{x:number,y:number,width:number,height:number,rotation:number,feather:number,opacity:number}}
 */
export function resolveMask(mask, clip, time, plan) {
  const specs = maskChannelSpecs(mask);
  const mods = plan.modulation;
  /**
   * @param {string} channel
   * @param {number} fallback
   * @returns {number}
   */
  const read = (channel, fallback) => {
    let value = channelValue(clip, channel, time, fallback);
    if (mods.length) {
      const spec = specs.find((entry) => entry.id === channel);
      value = applyModulation(value, channel, mods, clip.id, time, plan.fps, plan.rangeStart, spec?.min ?? -Infinity, spec?.max ?? Infinity);
    }
    return value;
  };
  return {
    x: read(`masks.${mask.id}.position.x`, mask.position.x),
    y: read(`masks.${mask.id}.position.y`, mask.position.y),
    width: Math.max(0, read(`masks.${mask.id}.size.x`, mask.size.x)),
    height: Math.max(0, read(`masks.${mask.id}.size.y`, mask.size.y)),
    rotation: read(`masks.${mask.id}.rotation`, mask.rotation),
    feather: clamp01(read(`masks.${mask.id}.feather`, mask.feather)),
    opacity: clamp01(read(`masks.${mask.id}.opacity`, mask.opacity)),
  };
}

/* ------------------------------------------------------------------ *
 * Canvas helpers
 * ------------------------------------------------------------------ */

/**
 * A growable pool of scratch canvases. Reusing them keeps a long export from
 * thrashing the garbage collector.
 */
export class ScratchPool {
  constructor() {
    /** @type {HTMLCanvasElement[]} */
    this.canvases = [];
    /** @type {number[]} */
    this.inUse = [];
    /** @type {boolean[]} */
    this.available = [];
  }

  /**
   * @param {number} index
   * @param {number} width
   * @param {number} height
   * @returns {{canvas:HTMLCanvasElement, ctx:CanvasRenderingContext2D}}
   */
  acquire(index, width, height) {
    const w = Math.max(1, Math.ceil(width));
    const h = Math.max(1, Math.ceil(height));
    let canvas = this.canvases[index];
    if (!canvas) {
      canvas = typeof OffscreenCanvas !== 'undefined'
        ? /** @type {any} */ (new OffscreenCanvas(w, h))
        : /** @type {any} */ (document.createElement('canvas'));
      this.canvases[index] = canvas;
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.clearRect(0, 0, w, h);
    return { canvas, ctx };
  }

  release() {
    // Nothing to do: every acquire resets the canvas it hands out.
  }
}

/**
 * Everything a frame render needs beyond the document itself.
 */
export class RenderContext {
  /**
   * @param {object} options
   * @param {ProjectDoc} options.doc
   * @param {number} options.width   Device pixels.
   * @param {number} options.height  Device pixels.
   * @param {import('./audio.js').MappingCurve[]} [options.modulation]
   * @param {FrameSource} [options.frameSource]
   * @param {number} [options.rangeStart]
   */
  constructor({ doc, width, height, modulation = [], frameSource, rangeStart = 0 }) {
    this.doc = doc;
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.composition = doc.composition;
    this.deviceScale = this.width / this.composition.width;
    /** @type {FrameSource|null} */
    this.frameSource = frameSource ?? null;
    this.rangeStart = rangeStart;
    this.cache = new Map();
    this.scratch = new ScratchPool();
    this.plan = createPlanContext(doc, { rangeStart, modulation });
    /** @type {string[]} */
    this.trackStack = [];
    /** @type {Uint8ClampedArray|null} */
    this.byteBuffer = null;
    /** @type {Map<number, Float32Array>} */
    this.floatBuffers = new Map();
    this.debug = { clipsDrawn: 0, effectPasses: 0, cacheHits: 0, cacheMisses: 0 };
  }

  /**
   * Composition pixels for `devicePixels` device pixels.
   * @param {number} devicePixels
   * @returns {number}
   */
  units(devicePixels) {
    return devicePixels / this.deviceScale;
  }

  /**
   * Device pixels for `units` composition pixels.
   * @param {number} units
   * @returns {number}
   */
  pixels(units) {
    return units * this.deviceScale;
  }

  /**
   * A flat RGBA copy of a raster at the current preview scale. Effects operate
   * on the preview raster by design: a quarter-resolution preview must be a
   * quarter-resolution version of the exported frame, not a different picture.
   * @param {CanvasRenderingContext2D} ctx
   * @returns {Uint8ClampedArray}
   */
  readRaster(ctx) {
    return ctx.getImageData(0, 0, this.width, this.height).data;
  }

  /**
   * Effect context for a clip's stack.
   * @param {EffectInstance} instance
   * @param {number} time
   * @param {Uint8ClampedArray} [below]
   * @returns {import('./effects.js').EffectContext}
   */
  effectContext(instance, time, below) {
    if (!this.byteBuffer || this.byteBuffer.length !== this.width * this.height * 4) {
      this.byteBuffer = new Uint8ClampedArray(this.width * this.height * 4);
    }
    const byteBuffer = this.byteBuffer;
    return {
      width: this.width,
      height: this.height,
      scale: this.deviceScale,
      widthUnits: this.composition.width,
      heightUnits: this.composition.height,
      seed: (instance.seed ?? 1) >>> 0,
      time,
      frame: Math.round(time * this.composition.fps),
      below,
      byteScratch: () => byteBuffer,
      scratch: (factor) => {
        // Pooled, and cleared each time it is handed out: multi-pass effects
        // such as bloom accumulate into this buffer.
        const cellWidth = Math.max(1, Math.floor(this.width / factor));
        const cellHeight = Math.max(1, Math.floor(this.height / factor));
        const length = cellWidth * cellHeight * 4;
        let buffer = this.floatBuffers.get(length);
        if (!buffer) {
          buffer = new Float32Array(length);
          this.floatBuffers.set(length, buffer);
        } else {
          buffer.fill(0);
        }
        return { data: buffer, width: cellWidth, height: cellHeight };
      },
    };
  }
}

/* ------------------------------------------------------------------ *
 * Mask drawing
 * ------------------------------------------------------------------ */

/**
 * Trace a mask path in the clip's local space.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Mask} mask
 * @param {{x:number,y:number,width:number,height:number,rotation:number}} geometry
 */
function traceMaskPath(ctx, mask, geometry) {
  const cx = geometry.x;
  const cy = geometry.y;
  const halfWidth = Math.max(0.0001, geometry.width / 2);
  const halfHeight = Math.max(0.0001, geometry.height / 2);
  ctx.beginPath();
  ctx.translate(cx, cy);
  ctx.rotate(toRadians(geometry.rotation));
  if (mask.shape === 'ellipse') {
    ctx.ellipse(0, 0, halfWidth, halfHeight, 0, 0, Math.PI * 2);
    return;
  }
  if (mask.shape === 'polygon' && mask.points.length >= 3) {
    const count = mask.points.length;
    for (let i = 0; i < count; i += 1) {
      const point = mask.points[i];
      const x = (point.x - 0.5) * geometry.width;
      const y = (point.y - 0.5) * geometry.height;
      if (i === 0) ctx.moveTo(x, y);
      else {
        // Catmull-Rom style smoothing keeps freehand polygons organic while
        // staying a pure function of the stored points.
        const previous = mask.points[(i - 1 + count) % count];
        const next = mask.points[(i + 1) % count];
        const after = mask.points[(i + 2) % count];
        const c1x = x + (((next.x - previous.x) * geometry.width) / 6);
        const c1y = y + (((next.y - previous.y) * geometry.height) / 6);
        const c2x = (next.x - 0.5) * geometry.width - (((after.x - point.x) * geometry.width) / 6);
        const c2y = (next.y - 0.5) * geometry.height - (((after.y - point.y) * geometry.height) / 6);
        ctx.bezierCurveTo(c1x, c1y, c2x, c2y, (next.x - 0.5) * geometry.width, (next.y - 0.5) * geometry.height);
      }
    }
    if (mask.pointsClosed !== false) ctx.closePath();
    return;
  }
  // Rounded rectangle.
  const radius = clamp(mask.roundness ?? 0, 0, 1) * Math.min(halfWidth, halfHeight);
  ctx.moveTo(-halfWidth + radius, -halfHeight);
  ctx.lineTo(halfWidth - radius, -halfHeight);
  if (radius > 0) ctx.quadraticCurveTo(halfWidth, -halfHeight, halfWidth, -halfHeight + radius);
  ctx.lineTo(halfWidth, halfHeight - radius);
  if (radius > 0) ctx.quadraticCurveTo(halfWidth, halfHeight, halfWidth - radius, halfHeight);
  ctx.lineTo(-halfWidth + radius, halfHeight);
  if (radius > 0) ctx.quadraticCurveTo(-halfWidth, halfHeight, -halfWidth, halfHeight - radius);
  ctx.lineTo(-halfWidth, -halfHeight + radius);
  if (radius > 0) ctx.quadraticCurveTo(-halfWidth, -halfHeight, -halfWidth + radius, -halfHeight);
  ctx.closePath();
}

/**
 * Apply every enabled mask of a clip to the current canvas contents.
 *
 * Uses `source-in` so a single mask can both reveal the layer *and* clip away
 * everything outside it in one compositing step; an inverted mask is drawn with
 * the opposite fill so it subtracts instead.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Clip} clip
 * @param {RenderContext} render
 * @param {number} time
 * @param {number} scale
 * @param {number} originX
 * @param {number} originY
 */
function applyMasks(ctx, clip, render, time, scale, originX, originY) {
  const active = clip.masks.filter((mask) => mask.enabled);
  if (active.length === 0) return;

  for (const mask of active) {
    const geometry = resolveMask(mask, clip, time, render.plan);
    const featherUnits = geometry.feather * Math.min(geometry.width, geometry.height) * 0.5;
    const featherPixels = render.pixels(featherUnits);
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;

    const maskIndex = 20 + (clip.masks.indexOf(mask) % 8);
    const { ctx: maskCtx } = render.scratch.acquire(maskIndex, width, height);
    maskCtx.setTransform(1, 0, 0, 1, 0, 0);
    maskCtx.clearRect(0, 0, width, height);
    maskCtx.save();
    maskCtx.translate(originX, originY);
    maskCtx.scale(scale, scale);
    traceMaskPath(maskCtx, mask, geometry);
    maskCtx.fillStyle = '#000';
    maskCtx.fill();
    maskCtx.restore();

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (featherPixels > 0.4) ctx.filter = `blur(${featherPixels.toFixed(2)}px)`;
    ctx.globalAlpha = geometry.opacity;
    ctx.globalCompositeOperation = mask.inverted ? 'destination-out' : 'source-in';
    ctx.drawImage(/** @type {any} */ (maskCtx.canvas), 0, 0);
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ *
 * Source raster
 * ------------------------------------------------------------------ */

/**
 * A source raster plus the authored size it represents.
 * @typedef {object} SourceRaster
 * @property {any} canvas
 * @property {CanvasRenderingContext2D} ctx
 * @property {number} width        Authored width in composition pixels.
 * @property {number} height       Authored height in composition pixels.
 * @property {number} nativeWidth  The source's own pixel width, when it has one.
 * @property {number} nativeHeight
 */

/**
 * Draw a clip's *source* (before geometry, masks and the effect stack) into a
 * local scratch canvas and return it with its authored size.
 *
 * @param {Clip} clip
 * @param {RenderContext} render
 * @param {number} time
 * @returns {SourceRaster|null}
 */
function drawSource(clip, render, time) {
  const composition = render.composition;
  const deviceWidth = render.width;
  const deviceHeight = render.height;
  const scale = render.deviceScale;

  if (clip.kind === 'graphic' && clip.graphic) {
    const authored = graphicSize(clip.graphic, composition.width, composition.height);
    const { ctx } = render.scratch.acquire(1, deviceWidth, deviceHeight);
    drawGraphic(ctx, clip.graphic, {
      width: deviceWidth,
      height: deviceHeight,
      unit: scale,
      time,
      seed: clip.seed ?? 1,
      motion: 0,
    });
    return { canvas: ctx.canvas, ctx, width: authored.width, height: authored.height, nativeWidth: authored.width, nativeHeight: authored.height };
  }

  if (clip.kind === 'text') {
    const { ctx } = render.scratch.acquire(2, deviceWidth, deviceHeight);
    const style = clip.text ?? null;
    if (style) drawText(ctx, style, deviceWidth, deviceHeight, scale, time);
    const authored = { width: composition.width, height: composition.height };
    return { canvas: ctx.canvas, ctx, width: authored.width, height: authored.height, nativeWidth: authored.width, nativeHeight: authored.height };
  }

  if (!clip.assetId || !render.frameSource) return null;
  const meta = render.frameSource.size(clip.assetId);
  if (!meta) return null;
  const sourceTime = clipSourceTime(clip, time);
  if (sourceTime === null) return null;
  const image = render.frameSource.frame(clip.assetId, sourceTime);
  if (!image) return null;
  const { ctx } = render.scratch.acquire(3, deviceWidth, deviceHeight);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, meta.width, meta.height, 0, 0, deviceWidth, deviceHeight);
  return {
    canvas: ctx.canvas,
    ctx,
    width: composition.width,
    height: composition.height,
    nativeWidth: meta.width,
    nativeHeight: meta.height,
  };
}

/**
 * Lay out text inside the composition, honouring wrapping, spacing, stroke and
 * gradient fill. All measurements are in authored composition pixels so text
 * occupies the same fraction of the frame at any preview resolution.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('./schema.js').TextStyle} style
 * @param {number} deviceWidth
 * @param {number} deviceHeight
 * @param {number} scale
 * @param {number} time
 */
export function drawText(ctx, style, deviceWidth, deviceHeight, scale, time) {
  const fontSize = Math.max(1, style.fontSize);
  const weight = style.fontWeight ?? 700;
  const family = style.fontFamily || 'Georgia, serif';
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.font = `${style.italic ? 'italic ' : ''}${weight} ${fontSize}px ${family}`;
  ctx.textAlign = /** @type {CanvasTextAlign} */ (style.align ?? 'center');
  ctx.textBaseline = 'middle';

  const raw = style.uppercase ? String(style.content ?? '').toUpperCase() : String(style.content ?? '');
  const maxWidth = style.maxWidth && style.maxWidth > 0 ? style.maxWidth : 0;
  const lines = wrapText(ctx, raw, maxWidth, style.letterSpacing ?? 0);
  const lineHeight = fontSize * (style.lineHeight ?? 1.1);
  const totalHeight = lineHeight * lines.length;
  const anchorX = style.align === 'left' ? 0 : style.align === 'right' ? deviceWidth / scale : deviceWidth / scale / 2;
  const anchorY = style.baseline === 'top' ? 0 : style.baseline === 'bottom' ? deviceHeight / scale : deviceHeight / scale / 2;
  const startY = anchorY - totalHeight / 2 + lineHeight / 2;

  if (style.shadowColor) {
    ctx.shadowColor = style.shadowColor;
    ctx.shadowBlur = style.shadowBlur ?? 0;
    ctx.shadowOffsetX = style.shadowX ?? 0;
    ctx.shadowOffsetY = style.shadowY ?? 0;
  }

  lines.forEach((line, index) => {
    const y = startY + index * lineHeight;
    const metrics = ctx.measureText(line);
    const width = metrics.width + Math.max(0, line.length - 1) * (style.letterSpacing ?? 0);
    const x = style.align === 'left' ? anchorX : style.align === 'right' ? anchorX - width : anchorX - width / 2;
    const drawLine = (/** @type {number} */ offsetX) => {
      if (style.letterSpacing) {
        let cursor = offsetX;
        for (const character of line) {
          ctx.fillText(character, cursor, y);
          cursor += ctx.measureText(character).width + style.letterSpacing;
        }
      } else {
        ctx.fillText(line, offsetX, y);
      }
    };
    if (style.gradientFrom && style.gradientTo) {
      const gradient = ctx.createLinearGradient(0, y - lineHeight / 2, 0, y + lineHeight / 2);
      gradient.addColorStop(0, style.gradientFrom);
      gradient.addColorStop(1, style.gradientTo);
      ctx.fillStyle = gradient;
    } else {
      ctx.fillStyle = style.color ?? '#ffffff';
    }
    if (style.strokeColor && style.strokeWidth > 0) {
      ctx.lineWidth = style.strokeWidth;
      ctx.strokeStyle = style.strokeColor;
      ctx.lineJoin = 'round';
      if (style.letterSpacing) {
        let cursor = x;
        for (const character of line) {
          ctx.strokeText(character, cursor, y);
          cursor += ctx.measureText(character).width + style.letterSpacing;
        }
      } else {
        ctx.strokeText(line, x, y);
      }
    }
    ctx.shadowColor = 'transparent';
    drawLine(x);
    if (style.shadowColor) {
      ctx.shadowColor = style.shadowColor;
      ctx.shadowBlur = style.shadowBlur ?? 0;
      ctx.shadowOffsetX = style.shadowX ?? 0;
      ctx.shadowOffsetY = style.shadowY ?? 0;
    }
  });
  ctx.restore();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth
 * @param {number} letterSpacing
 * @returns {string[]}
 */
function wrapText(ctx, text, maxWidth, letterSpacing) {
  const paragraphs = text.split('\n');
  if (!maxWidth || maxWidth <= 0) return paragraphs;
  /** @type {string[]} */
  const lines = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = words[0];
    for (let i = 1; i < words.length; i += 1) {
      const candidate = `${current} ${words[i]}`;
      const width = ctx.measureText(candidate).width + candidate.length * letterSpacing;
      if (width <= maxWidth) current = candidate;
      else {
        lines.push(current);
        current = words[i];
      }
    }
    lines.push(current);
  }
  return lines;
}

/* ------------------------------------------------------------------ *
 * Clip rendering
 * ------------------------------------------------------------------ */

/**
 * Resolve the geometry of a clip's content rectangle inside the composition.
 *
 * @param {Clip} clip
 * @param {Transform} transform
 * @param {{width:number,height:number,nativeWidth:number,nativeHeight:number}} source
 * @param {RenderContext} render
 * @returns {{x:number,y:number,width:number,height:number,unit:number,anchorX:number,anchorY:number,
 *   sourceWidth:number,sourceHeight:number,insetLeft:number,insetTop:number,
 *   visibleWidth:number,visibleHeight:number,cropLeft:number,cropRight:number,cropTop:number,cropBottom:number}}
 *   Composition-space rectangle and the device pixels per source pixel.
 */
export function layoutClip(clip, transform, source, render) {
  const composition = render.composition;
  const cropLeft = transform.cropLeft;
  const cropRight = transform.cropRight;
  const cropTop = transform.cropTop;
  const cropBottom = transform.cropBottom;

  const sourceWidth = Math.max(1, source.width);
  const sourceHeight = Math.max(1, source.height);

  const insetLeft = sourceWidth * cropLeft;
  const insetRight = sourceWidth * cropRight;
  const insetTop = sourceHeight * cropTop;
  const insetBottom = sourceHeight * cropBottom;
  const visibleWidth = Math.max(1, sourceWidth - insetLeft - insetRight);
  const visibleHeight = Math.max(1, sourceHeight - insetTop - insetBottom);

  const fit = Math.max(composition.width / visibleWidth, composition.height / visibleHeight);
  const width = visibleWidth * fit;
  const height = visibleHeight * fit;
  const anchorX = composition.width * transform.anchorX;
  const anchorY = composition.height * transform.anchorY;
  const x = composition.width / 2 + transform.x - anchorX;
  const y = composition.height / 2 + transform.y - anchorY;

  return { x, y, width, height, unit: fit, anchorX, anchorY, sourceWidth, sourceHeight, insetLeft, insetTop, visibleWidth, visibleHeight, cropLeft, cropRight, cropTop, cropBottom };
}

/**
 * Render a nested composition clip by recursing into it.
 * @param {Clip} clip
 * @param {RenderContext} render
 * @param {number} time
 * @returns {SourceRaster|null}
 */
function renderNestedSource(clip, render, time) {
  const nested = render.doc.compositions.find((entry) => entry.id === clip.compositionId);
  if (!nested) return null;
  const local = clipActiveAt(clip, time) ? (time - clip.start) * (clip.playbackRate || 1) + clip.inPoint : 0;
  const { ctx } = render.scratch.acquire(4, render.width, render.height);
  // A nested composition renders its own tracks into this raster using the
  // same composition pixel space as its parent.
  const nestedDoc = {
    ...render.doc,
    composition: { ...nested.composition, width: render.composition.width, height: render.composition.height },
    tracks: nested.tracks,
    clips: nested.clips,
  };
  const nestedRender = new RenderContext({
    doc: /** @type {any} */ (nestedDoc),
    width: render.width,
    height: render.height,
    modulation: render.plan.modulation,
    frameSource: render.frameSource ?? undefined,
    rangeStart: render.rangeStart,
  });
  nestedRender.scratch = render.scratch;
  renderClipsInto(ctx, nestedRender, local, { nested: true });
  return {
    canvas: ctx.canvas,
    ctx,
    width: render.composition.width,
    height: render.composition.height,
    nativeWidth: render.composition.width,
    nativeHeight: render.composition.height,
  };
}

/**
 * Draw one visual clip into `ctx`, which is already the parent raster.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Clip} clip
 * @param {RenderContext} render
 * @param {number} time
 * @param {{below?:Uint8ClampedArray}} [options]
 * @returns {boolean} whether anything was drawn
 */
export function drawClip(ctx, clip, render, time, options = {}) {
  if (clip.kind === 'audio') return false;
  const onScreen = clipActiveAt(clip, time);
  const needsHistoryCheck = clip.effects.stack.some((instance) => instance.enabled && HISTORY_EFFECTS.includes(instance.type));
  if (!onScreen && !needsHistoryCheck) return false;

  const definition = clip.kind === 'adjustment' ? null : clipSourcePath(clip, render, time);
  if (clip.kind !== 'adjustment' && !definition) return false;

  const transform = resolveTransform(clip, time, render.composition, render.plan);
  if (transform.opacity <= 0.0005) return false;

  const composition = render.composition;

  /* ---- adjustment layer: filter what is already underneath ---- */
  if (clip.kind === 'adjustment' && onScreen) {
    const below = options.below;
    if (below) return applyAdjustmentLayer(ctx, clip, render, time, below, transform);
    return false;
  }

  /* ---- source ---- */
  let source = definition;
  if (clip.kind === 'nested') source = renderNestedSource(clip, render, time);
  if (!source) return false;

  const layout = layoutClip(clip, transform, source, render);

  /* ---- output effects (trails, frame stepping) act on the source raster ---- */
  const outputStack = clip.effects.stack.filter((instance) => instance.enabled && HISTORY_EFFECTS.includes(instance.type));
  let sourceCanvas = source.canvas;
  let sourceWidth = source.width;
  let sourceHeight = source.height;
  if (outputStack.length > 0) {
    const prepared = renderHistoryEffects(clip, render, time, outputStack, /** @type {any} */ (source));
    if (prepared) {
      sourceCanvas = prepared.canvas;
      sourceWidth = prepared.width;
      sourceHeight = prepared.height;
    }
  }

  /* ---- local raster so masks and the effect stack stay inside the clip ---- */
  const localIndex = sourceCanvas === source.canvas ? 5 : 6;
  const { ctx: localCtx } = render.scratch.acquire(localIndex, render.width, render.height);
  localCtx.setTransform(1, 0, 0, 1, 0, 0);
  localCtx.globalAlpha = 1;
  localCtx.globalCompositeOperation = 'source-over';
  localCtx.clearRect(0, 0, render.width, render.height);

  const scale = render.deviceScale;
  const originX = layout.x * scale;
  const originY = layout.y * scale;
  localCtx.save();
  localCtx.translate(originX, originY);
  localCtx.scale(scale, scale);
  localCtx.translate(layout.width * transform.anchorX, layout.height * transform.anchorY);
  localCtx.rotate(toRadians(transform.rotation));
  localCtx.translate(-layout.width * transform.anchorX, -layout.height * transform.anchorY);
  localCtx.scale(transform.scaleX, transform.scaleY);
  const sourceRect = {
    x: (sourceCanvas.width / Math.max(1, sourceWidth)) * layout.insetLeft,
    y: (sourceCanvas.height / Math.max(1, sourceHeight)) * layout.insetTop,
    w: (sourceCanvas.width / Math.max(1, sourceWidth)) * layout.visibleWidth,
    h: (sourceCanvas.height / Math.max(1, sourceHeight)) * layout.visibleHeight,
  };
  localCtx.drawImage(
    sourceCanvas,
    sourceRect.x, sourceRect.y, Math.max(1, sourceRect.w), Math.max(1, sourceRect.h),
    0, 0, layout.width, layout.height,
  );
  localCtx.restore();

  /* ---- masks ---- */
  applyMasks(localCtx, clip, render, time, scale, originX, originY);

  /* ---- effect stack ---- */
  applyEffectStack(localCtx, clip, render, time, undefined);

  /* ---- composite onto the parent ---- */
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = transform.opacity;
  ctx.globalCompositeOperation = normalizeBlend(clip.blend);
  ctx.drawImage(localCtx.canvas, 0, 0);
  ctx.restore();

  render.debug.clipsDrawn += 1;
  return true;
}

/**
 * Canvas accepts CSS blend-mode names directly; `add` is the one that needs
 * translating to the canvas-specific value.
 * @param {string} blend
 * @returns {GlobalCompositeOperation}
 */
export function normalizeBlend(blend) {
  if (blend === 'add') return 'lighter';
  return /** @type {GlobalCompositeOperation} */ (blend || 'source-over');
}

/**
 * Build the clip's source raster for image/video/graphic/text/nested clips.
 * @param {Clip} clip
 * @param {RenderContext} render
 * @param {number} time
 */
function clipSourcePath(clip, render, time) {
  const source = drawSource(clip, render, time);
  if (!source) return null;
  return source;
}

/**
 * Runs the effects stack of a clip over its local raster.
 * @param {CanvasRenderingContext2D} localCtx
 * @param {Clip} clip
 * @param {RenderContext} render
 * @param {number} time
 * @param {Uint8ClampedArray} [below]
 * @returns {number} number of passes executed
 */
export function applyEffectStack(localCtx, clip, render, time, below) {
  const stack = clip.effects.enabled ? clip.effects.stack : [];
  if (stack.length === 0) return 0;
  let data = null;
  let passes = 0;

  for (const instance of stack) {
    if (!instance.enabled) continue;
    if (HISTORY_EFFECTS.includes(instance.type)) continue; // handled at output stage
    const params = resolveEffectParams(instance, clip, time, render.plan);
    if (isEffectNeutral(instance.type, params)) continue;
    if (!data) data = render.readRaster(localCtx);
    const context = render.effectContext(instance, time, below);
    if (runEffectPass(data, context, instance.type, params)) {
      passes += 1;
      render.debug.effectPasses += 1;
    }
  }

  if (data && passes > 0) {
    localCtx.save();
    localCtx.setTransform(1, 0, 0, 1, 0, 0);
    localCtx.globalCompositeOperation = 'copy';
    localCtx.putImageData(toImageData(data, render.width, render.height), 0, 0);
    localCtx.restore();
  }
  return passes;
}

/**
 * `new ImageData(...)` wants a plain ArrayBuffer-backed view; the pooled buffer
 * is shared, so copy into a fresh ImageData rather than handing out a reference.
 * @param {Uint8ClampedArray} data
 * @param {number} width
 * @param {number} height
 * @returns {ImageData}
 */
function toImageData(data, width, height) {
  const image = new ImageData(width, height);
  image.data.set(data.subarray(0, image.data.length));
  return image;
}

/**
 * Adjustment layer: run the layer's stack over everything drawn beneath it and
 * write the result back.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Clip} clip
 * @param {RenderContext} render
 * @param {number} time
 * @param {Uint8ClampedArray} below
 * @param {Transform} transform
 * @returns {boolean}
 */
function applyAdjustmentLayer(ctx, clip, render, time, below, transform) {
  const stack = clip.effects.enabled ? clip.effects.stack : [];
  const active = stack.filter((instance) => instance.enabled && !HISTORY_EFFECTS.includes(instance.type));
  if (active.length === 0) return false;

  const composed = new Uint8ClampedArray(below.length);
  composed.set(below);
  let passes = 0;
  for (const instance of active) {
    const params = resolveEffectParams(instance, clip, time, render.plan);
    if (isEffectNeutral(instance.type, params)) continue;
    const context = render.effectContext(instance, time, below);
    if (runEffectPass(composed, context, instance.type, params)) passes += 1;
  }
  if (passes === 0) return false;

  // Feather the layer's own masks into the adjustment strength so a masked
  // adjustment layer behaves like a masked effect, not a hard cut.
  const images = toImageData(composed, render.width, render.height);
  const { ctx: adjustCtx } = render.scratch.acquire(7, render.width, render.height);
  adjustCtx.setTransform(1, 0, 0, 1, 0, 0);
  adjustCtx.globalCompositeOperation = 'source-over';
  adjustCtx.globalAlpha = 1;
  adjustCtx.putImageData(images, 0, 0);
  applyMasks(adjustCtx, clip, render, time, render.deviceScale, 0, 0);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = transform.opacity;
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(adjustCtx.canvas, 0, 0);
  ctx.restore();
  render.debug.effectPasses += passes;
  return true;
}

/* ------------------------------------------------------------------ *
 * History effects (trails, frame stepping)
 * ------------------------------------------------------------------ */

/**
 * Render the clip at a *previous* time, reusing the source-drawing path but not
 * the current canvas, so the parent frame is untouched. This is what makes
 * trails and frame-stepping reproducible on a seek: they are a function of the
 * timeline, not of how many frames have been played.
 *
 * @param {Clip} clip
 * @param {RenderContext} render
 * @param {number} time
 * @returns {{canvas:any,width:number,height:number}|null}
 */
function renderClipAtTime(clip, render, time) {
  const { ctx } = render.scratch.acquire(8, render.width, render.height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, render.width, render.height);

  const source = clip.kind === 'nested' ? renderNestedSource(clip, render, time) : clipSourcePath(clip, render, time);
  if (!source) return null;

  const transform = resolveTransform(clip, time, render.composition, render.plan);
  const layout = layoutClip(clip, transform, source, render);
  const scale = render.deviceScale;
  ctx.save();
  ctx.translate(layout.x * scale, layout.y * scale);
  ctx.scale(scale, scale);
  ctx.translate(layout.width * transform.anchorX, layout.height * transform.anchorY);
  ctx.rotate(toRadians(transform.rotation));
  ctx.translate(-layout.width * transform.anchorX, -layout.height * transform.anchorY);
  ctx.scale(transform.scaleX, transform.scaleY);
  const sourceRect = {
    x: (source.canvas.width / Math.max(1, source.width)) * layout.insetLeft,
    y: (source.canvas.height / Math.max(1, source.height)) * layout.insetTop,
    w: (source.canvas.width / Math.max(1, source.width)) * layout.visibleWidth,
    h: (source.canvas.height / Math.max(1, source.height)) * layout.visibleHeight,
  };
  ctx.globalAlpha = transform.opacity;
  ctx.drawImage(
    source.canvas,
    sourceRect.x, sourceRect.y, Math.max(1, sourceRect.w), Math.max(1, sourceRect.h),
    0, 0, layout.width, layout.height,
  );
  ctx.restore();
  return { canvas: ctx.canvas, width: render.width, height: render.height };
}

/**
 * Compose trails / frame stepping into a new source raster.
 * @param {Clip} clip
 * @param {RenderContext} render
 * @param {number} time
 * @param {EffectInstance[]} stack
 * @param {{canvas:any,width:number,height:number}} source
 * @returns {{canvas:any,width:number,height:number}|null}
 */
function renderHistoryEffects(clip, render, time, stack, source) {
  const { ctx } = render.scratch.acquire(9, render.width, render.height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, render.width, render.height);

  let handled = false;

  for (const instance of stack) {
    const params = resolveEffectParams(instance, clip, time, render.plan);
    if (instance.type === 'frameStep') {
      const hold = Math.max(1, Math.round(params.hold ?? 1));
      if (hold <= 1 || !params.mix) continue;
      const holdSeconds = hold / render.composition.fps;
      const snapped = Math.floor(time / holdSeconds) * holdSeconds;
      const stepped = Math.abs(snapped - time) < 1e-6 ? source : renderClipAtTime(clip, render, snapped);
      if (!stepped) continue;
      ctx.globalAlpha = 1;
      ctx.drawImage(stepped.canvas, 0, 0);
      if (params.mix < 1) {
        ctx.globalAlpha = 1 - params.mix;
        ctx.drawImage(source.canvas, 0, 0);
        ctx.globalAlpha = 1;
      }
      handled = true;
      continue;
    }

    if (instance.type === 'strobe') {
      // A gate, not a pixel change: the layer cycles on and off in sync with the
      // timeline. Using the absolute frame index (rather than counting renders)
      // means a seek to the middle of a strobe reproduces that frame exactly.
      const rate = Math.max(0.0625, params.rate ?? 8);
      const phase = ((params.phase ?? 0) / 360) % 1;
      const cycle = (time * rate + phase) % 1;
      const on = cycle < (params.duty ?? 50) / 100;
      const depth = clamp01(params.depth ?? 1);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      if (on) {
        if (depth >= 0.999) ctx.drawImage(source.canvas, 0, 0);
        else {
          // A partial gate mixes the layer with nothing, so "depth" reads as a
          // dimming of the off phase rather than an on/off switch.
          ctx.globalAlpha = 1 - depth;
          ctx.drawImage(source.canvas, 0, 0);
          ctx.globalAlpha = 1;
        }
      } else {
        ctx.globalAlpha = 1 - depth;
        ctx.drawImage(source.canvas, 0, 0);
        ctx.globalAlpha = 1;
      }
      handled = true;
      continue;
    }

    if (instance.type === 'trails') {
      const count = Math.max(1, Math.min(24, Math.round(params.count ?? 6)));
      const spacing = Math.max(0.02, params.spacing ?? 0.12);
      const falloff = clamp(params.falloff ?? 0.68, 0.05, 1);
      const blend = clamp01(params.blend ?? 0.6);
      if (blend <= 0) continue;
      // Oldest first so the newest trail sits on top.
      for (let step = count; step >= 1; step -= 1) {
        const pastTime = time - step * spacing;
        if (pastTime < clip.start - 1e-9) continue;
        const past = renderClipAtTime(clip, render, pastTime);
        if (!past) continue;
        ctx.globalAlpha = blend * Math.pow(falloff, step);
        ctx.globalCompositeOperation = params.additive ? 'lighter' : 'source-over';
        ctx.drawImage(past.canvas, 0, 0);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(source.canvas, 0, 0);
      handled = true;
    }
  }

  if (!handled) return null;
  return { canvas: ctx.canvas, width: render.width, height: render.height };
}

/* ------------------------------------------------------------------ *
 * Composition rendering
 * ------------------------------------------------------------------ */

/**
 * Render the active tracks of a composition into `ctx`.
 *
 * `visual` tracks draw bottom-up; `audio` tracks contribute nothing visually
 * but still occupy their slot so the timeline and the render agree.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {RenderContext} render
 * @param {number} time
 * @param {{nested?:boolean}} [options]
 * @returns {void}
 */
export function renderClipsInto(ctx, render, time, options = {}) {
  const doc = render.doc;
  const tracks = doc.tracks;
  const soloed = tracks.some((track) => track.solo);
  const stack = render.trackStack.slice();

  for (let index = tracks.length - 1; index >= 0; index -= 1) {
    const track = tracks[index];
    if (track.kind === 'audio') continue;
    if (track.hidden) continue;
    if (soloed && !track.solo) continue;

    const clips = doc.clips
      .filter((clip) => clip.trackId === track.id)
      .sort((a, b) => a.start - b.start);
    if (clips.length === 0) continue;

    stack.push(track.id);
    for (const clip of clips) {
      if (clip.hidden) continue;
      let below;
      const hasAdjustment = clip.kind === 'adjustment' && clipActiveAt(clip, time);
      const hasMasks = clip.masks.some((mask) => mask.enabled);
      if (hasAdjustment || hasMasks) {
        // Only pay for a raster read-back when a feature needs the pixels
        // beneath: adjustment layers and masked non-normal blends.
        below = render.readRaster(ctx);
      }
      drawClip(ctx, clip, render, time, { below });
    }
  }
  render.trackStack = stack;
}

/**
 * Render one frame of the root composition.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {RenderContext} render
 * @param {number} time
 * @returns {void}
 */
export function renderFrame(ctx, render, time) {
  render.debug.clipsDrawn = 0;
  render.debug.effectPasses = 0;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.fillStyle = render.composition.background || '#000000';
  ctx.fillRect(0, 0, render.width, render.height);
  renderClipsInto(ctx, render, time, {});
}

/**
 * Convenience wrapper used by tests and thumbnails: create a canvas of the
 * requested size and render a frame into it.
 *
 * @param {ProjectDoc} doc
 * @param {number} time
 * @param {object} [options]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {FrameSource} [options.frameSource]
 * @param {import('./audio.js').MappingCurve[]} [options.modulation]
 * @param {number} [options.rangeStart]
 * @returns {{canvas:HTMLCanvasElement, render:RenderContext}}
 */
export function renderFrameToCanvas(doc, time, options = {}) {
  const width = options.width ?? doc.composition.width;
  const height = options.height ?? doc.composition.height;
  const canvas = /** @type {HTMLCanvasElement} */ (typeof OffscreenCanvas !== 'undefined'
    ? /** @type {any} */ (new OffscreenCanvas(width, height))
    : document.createElement('canvas'));
  canvas.width = width;
  canvas.height = height;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
  const render = new RenderContext({
    doc,
    width,
    height,
    modulation: options.modulation ?? [],
    frameSource: options.frameSource,
    rangeStart: options.rangeStart ?? 0,
  });
  renderFrame(ctx, render, time);
  return { canvas, render };
}

/**
 * Diagnostics for the UI: which clips are active at a time.
 * @param {ProjectDoc} doc
 * @param {number} time
 * @returns {Clip[]}
 */
export function activeClips(doc, time) {
  return doc.clips.filter((clip) => clipActiveAt(clip, time) && clip.kind !== 'audio');
}

export { evaluateKeys, findChannel, normalizeEasing, markerTimes, lerp };
