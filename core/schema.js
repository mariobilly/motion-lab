/**
 * Motion Lab project format -- version 4.
 *
 * This module is the single source of truth for the shape of a project. It is
 * plain ES module JavaScript so the exact same file loads in the browser (over
 * HTTP, as a native module), in the headless-Chrome render harness and in Node
 * (for export, media probing and tests). Types are supplied as JSDoc typedefs
 * so `npm run check` still verifies every field.
 *
 * Design rules that the rest of the engine depends on:
 *  - Everything is JSON-serialisable. No class instances, no functions.
 *  - Every random-looking value is derived from an explicit `seed`, never from
 *    Math.random(), so a frame renders identically in preview and export.
 *  - Nothing is stored in composition pixels unless it is a pixel value. All
 *    geometry is *normalised* to the composition's coordinate space via
 *    `norm()`/`denorm()` helpers below, which is what lets preview quality
 *    change without changing timing or exported appearance.
 */

export const PROJECT_FORMAT = 'motion-lab';
export const PROJECT_VERSION = 4;

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} Vec2
 * @property {number} x
 * @property {number} y
 */

/**
 * @typedef {object} Rect
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 */

/* ------------------------------------------------------------------ *
 * Composition
 * ------------------------------------------------------------------ */

/** @typedef {'landscape'|'portrait'|'square'|'custom'} AspectId */

/**
 * @typedef {object} Composition
 * @property {number} width  Composition pixels (the export raster width).
 * @property {number} height Composition pixels (the export raster height).
 * @property {number} fps    One of 24, 25, 30, 60.
 * @property {number} duration  Seconds.
 * @property {string} background  CSS colour painted under every layer.
 * @property {AspectId} aspect   Bookkeeping only; width/height are authoritative.
 */

/* ------------------------------------------------------------------ *
 * Assets
 * ------------------------------------------------------------------ */

/**
 * @typedef {'image'|'video'|'audio'} AssetKind
 * @typedef {'ok'|'missing'|'unsupported'|'analyzing'|'error'} AssetStatus
 */

/**
 * @typedef {object} AssetMeta
 * @property {string} id
 * @property {AssetKind} kind
 * @property {string} name        Display name (editable).
 * @property {string} fileName    Original file name as imported.
 * @property {number} size        Bytes.
 * @property {string} mime
 * @property {number} width       Pixels (image/video), 0 for audio.
 * @property {number} height      Pixels (image/video), 0 for audio.
 * @property {number} duration    Seconds (video/audio); 0 for stills.
 * @property {number} [fps]       Detected video frame rate when known.
 * @property {'server'|'library'|'procedural'} origin
 * @property {AssetStatus} status
 * @property {string} [statusDetail]  Human-readable explanation when not `ok`.
 * @property {string} [folderId]      Media library folder.
 * @property {string} addedAt         ISO timestamp.
 * @property {number} [seed]          For procedural assets.
 * @property {string} [previewUrl]    Optional override for the thumbnail source.
 */

/* ------------------------------------------------------------------ *
 * Effects
 * ------------------------------------------------------------------ */

/**
 * A single effect instance in a stack. `params` only carries values the user
 * has touched -- unspecified parameters fall back to the registry default, so
 * adding a parameter in a later version cannot corrupt a saved project.
 *
 * @typedef {object} EffectInstance
 * @property {string} id
 * @property {string} type   Key into the effect registry.
 * @property {boolean} enabled
 * @property {number} seed   Per-instance randomness (grain, glitch, particles).
 * @property {Record<string, number|string|number[]|boolean>} params
 */

/**
 * @typedef {object} LayerEffects
 * @property {boolean} enabled
 * @property {EffectInstance[]} stack
 */

/* ------------------------------------------------------------------ *
 * Masks
 * ------------------------------------------------------------------ */

/** @typedef {'rect'|'ellipse'|'polygon'} MaskShape */

/**
 * Masks live in *normalised layer space*: (0,0) is the top-left of the layer's
 * own rectangle and (1,1) the bottom-right, so a mask keeps its relationship to
 * the layer no matter the source resolution.
 *
 * @typedef {object} Mask
 * @property {string} id
 * @property {string} name
 * @property {MaskShape} shape
 * @property {boolean} enabled
 * @property {boolean} inverted
 * @property {Vec2} position  Centre, normalised layer space.
 * @property {Vec2} size      Full width/height, normalised layer space.
 * @property {number} rotation  Degrees.
 * @property {number} roundness  0..1, rect corners only.
 * @property {number} feather    Fraction of the mask's shorter side.
 * @property {number} opacity    0..1
 * @property {Vec2[]} points     Polygon points, normalised layer space.
 * @property {boolean} pointsClosed
 */

/* ------------------------------------------------------------------ *
 * Animation
 * ------------------------------------------------------------------ */

/**
 * @typedef {'linear'|'hold'|'ease'|'bezier'} EasingKind
 */

/**
 * Cubic Bezier control handles, P1 and P2 of a CSS-style timing function.
 * @typedef {object} BezierHandles
 * @property {number} x1
 * @property {number} y1
 * @property {number} x2
 * @property {number} y2
 */

/**
 * @typedef {object} Easing
 * @property {EasingKind} kind
 * @property {BezierHandles} bezier  Used when kind is `bezier`; `ease` maps to a named curve.
 * @property {string} [name]         Human label kept for the UI ('Ease in', ...).
 */

/**
 * A keyframe on a numeric channel. `ease` describes the segment that *starts*
 * at this keyframe, so a hold keyframe stops the animation until the next one.
 *
 * @typedef {object} Keyframe
 * @property {string} id
 * @property {number} time    Seconds, absolute within the owning composition.
 * @property {number} value
 * @property {Easing} ease
 */

/**
 * @typedef {object} KeyChannel
 * @property {string} id
 * @property {string} channel  e.g. `transform.position.x`, `effects.<id>.amount`
 * @property {Keyframe[]} keys Sorted by time.
 */

/**
 * @typedef {object} Transform
 * @property {number} x            Composition pixels from centre.
 * @property {number} y
 * @property {number} scaleX       Multiplier, 1 = asset's natural cover fit.
 * @property {number} scaleY
 * @property {number} rotation     Degrees, clockwise.
 * @property {number} opacity      0..1
 * @property {number} anchorX      Normalised within the layer rect (0.5 = centre).
 * @property {number} anchorY
 * @property {number} cropTop      Normalised 0..0.95 insets.
 * @property {number} cropRight
 * @property {number} cropBottom
 * @property {number} cropLeft
 */

/**
 * @typedef {object} SoundKeys
 * @property {number} level         0..1 output
 * @property {number} low
 * @property {number} mid
 * @property {number} high
 * @property {number} onset         0..1 decaying impulse
 * @property {number} beat          0..1 decaying impulse from beat markers
 */

/* ------------------------------------------------------------------ *
 * Text & procedural sources
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} TextStyle
 * @property {string} content
 * @property {string} fontFamily
 * @property {number} fontSize      Composition pixels.
 * @property {number} fontWeight    100..900
 * @property {boolean} italic
 * @property {number} letterSpacing  Composition pixels.
 * @property {number} lineHeight    Multiplier.
 * @property {string} color
 * @property {string} align         'left'|'center'|'right'
 * @property {string} baseline      'top'|'middle'|'bottom'
 * @property {number} maxWidth      Wrap width in composition pixels.
 * @property {boolean} uppercase
 * @property {string} [strokeColor]
 * @property {number} strokeWidth
 * @property {string} [shadowColor]
 * @property {number} shadowBlur
 * @property {number} shadowX
 * @property {number} shadowY
 * @property {string} [gradientFrom]  When set, text fills with a vertical gradient.
 * @property {string} [gradientTo]
 */

/**
 * @typedef {'gradient'|'shape'|'particles'|'waveform'|'bars'|'rings'|'noise'|'grid'|'text'} SourceType
 */

/**
 * One procedural layer's parameters. `kind` values map to `core/graphics.js`.
 * Every `*Seed` field feeds the deterministic hashes so a project replays
 * exactly; nothing here consults Math.random().
 *
 * @typedef {object} GraphicSpec
 * @property {SourceType} kind
 * @property {number} seed
 * @property {string} colorA
 * @property {string} colorB
 * @property {string} [colorC]
 * @property {number} amount        Generic 0..1 driver (ramps, coverage, ...).
 * @property {number} count         Particle/shape/ring count.
 * @property {number} speed
 * @property {number} size
 * @property {number} spread
 * @property {number} complexity    Octaves / detail.
 * @property {number} rotation
 * @property {number} width
 * @property {number} height
 * @property {string} [shapeKind]   'circle'|'rect'|'triangle'|'star'|'ring'|'line'
 * @property {string} [gradientKind] 'linear'|'radial'|'conic'|'mesh'|'aurora'
 * @property {number} [bandCount]   Frequency bars.
 * @property {number} [smoothing]
 * @property {boolean} [mirror]
 * @property {string} [text]        Waveform label.
 */

/* ------------------------------------------------------------------ *
 * Layers, clips, tracks
 * ------------------------------------------------------------------ */

/** @typedef {'visual'|'audio'|'adjustment'} LayerKind */
/** @typedef {'image'|'video'|'text'|'graphic'|'audio'|'adjustment'|'nested'} ClipKind */
/** @typedef {'normal'|'multiply'|'screen'|'overlay'|'darken'|'lighten'|'color-dodge'|'color-burn'|'hard-light'|'soft-light'|'difference'|'exclusion'|'hue'|'saturation'|'color'|'luminosity'|'add'} BlendMode */

/**
 * @typedef {object} Clip
 * @property {string} id
 * @property {string} name
 * @property {ClipKind} kind
 * @property {string} trackId       Which track the clip lives on.
 * @property {boolean} [hidden]     Per-clip visibility (independent of the track).
 * @property {string} [assetId]     image/video/audio clips.
 * @property {string} [compositionId] nested clips.
 * @property {number} start          Seconds on the parent timeline.
 * @property {number} duration       Seconds.
 * @property {number} inPoint        Seconds into the source (trim in).
 * @property {Transform} transform
 * @property {BlendMode} blend
 * @property {number} volume         0..2 (audio clips)
 * @property {number} pan            -1..1 (audio clips)
 * @property {number} fadeIn         Seconds (audio clips)
 * @property {number} fadeOut        Seconds
 * @property {LayerEffects} effects
 * @property {Mask[]} masks
 * @property {KeyChannel[]} keyframes
 * @property {GraphicSpec} [graphic]
 * @property {TextStyle} [text]
 * @property {number} [seed]         Per-clip randomness for motion effects.
 * @property {boolean} [reverse]     Play the source backwards.
 * @property {number} [playbackRate] 1 = normal.
 * @property {number} [speedRamp]    Reserved: 0 = constant rate.
 */

/**
 * @typedef {object} Track
 * @property {string} id
 * @property {string} name
 * @property {LayerKind} kind
 * @property {boolean} muted
 * @property {boolean} solo
 * @property {boolean} locked
 * @property {boolean} hidden
 * @property {number} height
 * @property {number} volume     Track gain for audio tracks.
 * @property {boolean} collapsed
 */

/* ------------------------------------------------------------------ *
 * Audio
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} AudioAnalysis
 * @property {string} assetId
 * @property {number} sampleRate
 * @property {number} hop         Samples between analysis frames.
 * @property {number} hopSeconds  Seconds between analysis frames.
 * @property {number} frames      Number of analysis frames stored.
 * @property {number} duration
 * @property {number[]} level     Per-frame RMS, 0..1 (normalised).
 * @property {number[]} low
 * @property {number[]} mid
 * @property {number[]} high
 * @property {number[]} onsets    Seconds of detected onsets.
 * @property {number[]} beats     Seconds of suggested beat markers.
 * @property {number} tempo       BPM estimate, 0 when not confident.
 * @property {number} tempoConfidence 0..1
 * @property {number[]} waveform  Min/max pairs for drawing, ~1000 buckets.
 * @property {number} analysedAt
 */

/**
 * @typedef {object} AudioMapping
 * @property {string} id
 * @property {boolean} enabled
 * @property {string} name
 * @property {string} source   Asset id of the analysed audio.
 * @property {'level'|'low'|'mid'|'high'|'onset'|'beat'} band
 * @property {string} target   Channel id, e.g. `transform.scale.x`.
 * @property {string} [clipId]  Empty/undefined = any clip whose channel matches.
 * @property {number} sensitivity  Multiplier before the range mapping.
 * @property {number} min
 * @property {number} max
 * @property {number} smoothing    0..0.98 moving-average on the control signal.
 * @property {number} attack       Seconds to rise.
 * @property {number} release      Seconds to fall.
 * @property {'set'|'add'|'multiply'} mode
 * @property {boolean} [invert]
 */

/**
 * @typedef {object} AudioSettings
 * @property {number} masterGain
 * @property {number} tempo
 * @property {number} offset     Seconds: shifts markers/onsets relative to the timeline.
 * @property {boolean} loopMarkers
 * @property {number[]} manualMarkers  User-added marker times.
 * @property {number[]} removedMarkers Detected markers the user rejected.
 */

/* ------------------------------------------------------------------ *
 * Presets
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} Preset
 * @property {string} id
 * @property {string} name
 * @property {'effect-stack'|'animation'|'audio-mapping'|'template'|'graphic'} kind
 * @property {string} [category]
 * @property {string} [description]
 * @property {number} createdAt
 * @property {*} data  Shape depends on `kind`.
 */

/**
 * @typedef {object} Folder
 * @property {string} id
 * @property {string} name
 * @property {string} [parentId]
 */

/* ------------------------------------------------------------------ *
 * Project
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} ProjectMeta
 * @property {string} id
 * @property {string} name
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} [lastOpenedAt]
 * @property {string} [thumbnail]  Data URL of the poster frame.
 */

/**
 * @typedef {object} ProjectDoc
 * @property {string} format
 * @property {number} version
 * @property {ProjectMeta} meta
 * @property {Composition} composition
 * @property {AssetMeta[]} assets
 * @property {Folder[]} folders
 * @property {Track[]} tracks
 * @property {Clip[]} clips
 * @property {Array<{id:string,name:string,composition:Composition,tracks:Track[],clips:Clip[]}>} compositions  Nested compositions.
 * @property {Record<string, AudioAnalysis>} audio
 * @property {AudioMapping[]} mappings
 * @property {AudioSettings} audioSettings
 * @property {Preset[]} presets
 * @property {{in:number,out:number}} exportRange
 * @property {{in:number,out:number}} loopRange
 * @property {{snap:boolean,snapToMarkers:boolean,zoom:number,scroll:number}} timeline
 * @property {string[]} notes
 */

/* ------------------------------------------------------------------ *
 * Construction helpers
 * ------------------------------------------------------------------ */

let idCounter = 0;

/**
 * Short, collision-resistant id. Deterministic within a session; ids are stored
 * in the document so they only need to be unique, not reproducible.
 * @param {string} [prefix]
 * @returns {string}
 */
export function uid(prefix = 'id') {
  idCounter += 1;
  const rand = Math.floor(Math.random() * 0x1000000).toString(36);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

/** @returns {number} */
export function now() {
  return Date.now();
}

/** @returns {Transform} */
export function neutralTransform() {
  return {
    x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1,
    anchorX: 0.5, anchorY: 0.5,
    cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0,
  };
}

/** @returns {LayerEffects} */
export function emptyEffects() {
  return { enabled: true, stack: [] };
}

/** @returns {TextStyle} */
export function defaultTextStyle() {
  return {
    content: 'MOTION LAB',
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: 120,
    fontWeight: 700,
    italic: false,
    letterSpacing: 0,
    lineHeight: 1.1,
    color: '#ffffff',
    align: 'center',
    baseline: 'middle',
    maxWidth: 0,
    uppercase: false,
    strokeWidth: 0,
    shadowBlur: 0,
    shadowX: 0,
    shadowY: 0,
  };
}

/** @returns {GraphicSpec} */
export function defaultGraphic(kind = 'gradient') {
  return {
    kind: /** @type {SourceType} */ (kind),
    seed: 1337,
    colorA: '#ff2e88',
    colorB: '#12d6ff',
    colorC: '#ffd166',
    amount: 0.5,
    count: 120,
    speed: 1,
    size: 0.5,
    spread: 0.5,
    complexity: 3,
    rotation: 0,
    width: 1,
    height: 1,
    shapeKind: 'circle',
    gradientKind: 'aurora',
    bandCount: 48,
    smoothing: 0.6,
    mirror: true,
    text: '',
  };
}

/**
 * @param {Partial<Composition>} [patch]
 * @returns {Composition}
 */
export function defaultComposition(patch = {}) {
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 20,
    background: '#0a0a0f',
    aspect: 'landscape',
    ...patch,
  };
}

/**
 * @param {Partial<Track>} [patch]
 * @returns {Track}
 */
export function defaultTrack(patch = {}) {
  return {
    id: uid('trk'),
    name: 'Track',
    kind: 'visual',
    muted: false,
    solo: false,
    locked: false,
    hidden: false,
    height: 74,
    volume: 1,
    collapsed: false,
    ...patch,
  };
}

/**
 * @param {Partial<Clip>} [patch]
 * @returns {Clip}
 */
export function defaultClip(patch = {}) {
  return {
    id: uid('clip'),
    name: 'Clip',
    kind: 'image',
    trackId: '',
    hidden: false,
    start: 0,
    duration: 5,
    inPoint: 0,
    transform: neutralTransform(),
    blend: 'normal',
    volume: 1,
    pan: 0,
    fadeIn: 0,
    fadeOut: 0,
    effects: emptyEffects(),
    masks: [],
    keyframes: [],
    seed: 1,
    ...patch,
  };
}

/**
 * @param {Partial<AudioMapping>} [patch]
 * @returns {AudioMapping}
 */
export function defaultMapping(patch = {}) {
  return {
    id: uid('map'),
    enabled: true,
    name: 'New connection',
    source: '',
    band: 'low',
    target: 'transform.scale.x',
    sensitivity: 1,
    min: 0.8,
    max: 1.2,
    smoothing: 0.55,
    attack: 0.01,
    release: 0.18,
    mode: 'set',
    invert: false,
    ...patch,
  };
}

/** @returns {AudioSettings} */
export function defaultAudioSettings() {
  return { masterGain: 1, tempo: 0, offset: 0, loopMarkers: false, manualMarkers: [], removedMarkers: [] };
}

/**
 * A brand new, empty project.
 * @param {Partial<ProjectMeta>} [meta]
 * @param {Partial<Composition>} [composition]
 * @returns {ProjectDoc}
 */
export function createProject(meta = {}, composition = {}) {
  const timestamp = now();
  const comp = defaultComposition(composition);
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    meta: {
      id: uid('proj'),
      name: 'Untitled composition',
      createdAt: timestamp,
      updatedAt: timestamp,
      ...meta,
    },
    composition: comp,
    assets: [],
    folders: [
      { id: 'folder_footage', name: 'Footage' },
      { id: 'folder_audio', name: 'Audio' },
      { id: 'folder_graphics', name: 'Graphics' },
    ],
    tracks: [
      // Heights are chosen so a default four-track composition fits the default
      // timeline height without scrolling: the most common case should never
      // need a scrollbar to see its own timeline.
      defaultTrack({ name: 'Overlay', kind: 'visual', height: 64 }),
      defaultTrack({ name: 'Main', kind: 'visual', height: 70 }),
      defaultTrack({ name: 'Background', kind: 'visual', height: 64 }),
      defaultTrack({ name: 'Music', kind: 'audio', height: 74 }),
    ],
    clips: [],
    compositions: [],
    audio: {},
    mappings: [],
    audioSettings: defaultAudioSettings(),
    presets: [],
    exportRange: { in: 0, out: comp.duration },
    loopRange: { in: 0, out: comp.duration },
    timeline: { snap: true, snapToMarkers: true, zoom: 42, scroll: 0 },
    notes: [],
  };
}

/* ------------------------------------------------------------------ *
 * Coordinate helpers
 * ------------------------------------------------------------------ */

/**
 * Normalised coordinates: x in [0,1] across the composition's *width*,
 * y in [0,1] across its *height*. Distances along x are therefore scaled by
 * `width` when drawn. Keeping authored geometry normalised is what makes
 * preview resolution independent of output resolution.
 *
 * @param {number} value
 * @param {number} extent
 * @returns {number}
 */
export function denorm(value, extent) {
  return value * extent;
}

/**
 * @param {number} value
 * @param {number} extent
 * @returns {number}
 */
export function norm(value, extent) {
  return extent === 0 ? 0 : value / extent;
}

/* ------------------------------------------------------------------ *
 * Time helpers
 * ------------------------------------------------------------------ */

export const FPS_CHOICES = /** @type {const} */ ([24, 25, 30, 60]);

/**
 * @param {number} fps
 * @returns {number}
 */
export function frameDuration(fps) {
  return 1 / Math.max(1, fps);
}

/**
 * Snap seconds to the nearest whole frame boundary of `fps`.
 * @param {number} time
 * @param {number} fps
 * @returns {number}
 */
export function snapToFrame(time, fps) {
  return Math.round(time * fps) / fps;
}

/**
 * @param {number} time
 * @param {number} fps
 * @returns {number}
 */
export function timeToFrame(time, fps) {
  return Math.round(time * fps);
}

/**
 * @param {number} frame
 * @param {number} fps
 * @returns {number}
 */
export function frameToTime(frame, fps) {
  return frame / fps;
}

/**
 * Format seconds as `mm:ss:ff` (with frames) or `mm:ss.mmm`.
 * @param {number} time
 * @param {number} fps
 * @returns {string}
 */
export function formatTimecode(time, fps) {
  const safe = Math.max(0, time);
  const totalFrames = Math.round(safe * fps);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);
  const pad = (/** @type {number} */ n, /** @type {number} */ width = 2) => String(n).padStart(width, '0');
  return `${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}

/**
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.round(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Clip helpers
 * ------------------------------------------------------------------ */

/**
 * @param {Clip} clip
 * @returns {number}
 */
export function clipEnd(clip) {
  return clip.start + clip.duration;
}

/**
 * @param {Clip} clip
 * @param {number} time
 * @returns {boolean}
 */
export function clipActiveAt(clip, time) {
  return time >= clip.start - 1e-9 && time < clipEnd(clip) - 1e-9;
}

/**
 * Source time for a clip at a given timeline time, honouring trim, reverse and
 * playback rate. Returns null when the clip is not active.
 * @param {Clip} clip
 * @param {number} time
 * @returns {number|null}
 */
export function clipSourceTime(clip, time) {
  if (!clipActiveAt(clip, time)) return null;
  const local = time - clip.start;
  const rate = clip.playbackRate && clip.playbackRate > 0 ? clip.playbackRate : 1;
  const offset = clip.reverse ? clip.duration - local : local;
  return clip.inPoint + offset * rate;
}

/**
 * @param {Clip} clip
 * @param {number} time
 * @returns {number} 0..1 audio fade envelope
 */
export function clipFadeGain(clip, time) {
  const local = time - clip.start;
  let gain = 1;
  if (clip.fadeIn > 0) gain = Math.min(gain, Math.max(0, local / clip.fadeIn));
  if (clip.fadeOut > 0) gain = Math.min(gain, Math.max(0, (clip.duration - local) / clip.fadeOut));
  return Math.min(1, Math.max(0, gain));
}

/**
 * @param {Keyframe[]} keys
 * @returns {boolean}
 */
export function keysSorted(keys) {
  for (let i = 1; i < keys.length; i += 1) if (keys[i].time < keys[i - 1].time) return false;
  return true;
}

/**
 * Unique asset ids referenced anywhere in the document (including nested
 * compositions and audio analyses) -- used by the library's "in use" badges and
 * by the export packager.
 * @param {ProjectDoc} doc
 * @returns {Set<string>}
 */
export function usedAssetIds(doc) {
  const used = new Set();
  const walk = (/** @type {Clip[]} */ clips) => {
    for (const clip of clips) {
      if (clip.assetId) used.add(clip.assetId);
      if (clip.kind === 'nested' && clip.compositionId) {
        const nested = doc.compositions.find((c) => c.id === clip.compositionId);
        if (nested) walk(nested.clips);
      }
    }
  };
  walk(doc.clips);
  for (const mapping of doc.mappings) if (mapping.source) used.add(mapping.source);
  return used;
}

/**
 * Renumber `in`/`out` keys after a composition resize so the project stays
 * coherent.
 * @param {ProjectDoc} doc
 * @returns {void}
 */
export function clampRanges(doc) {
  const duration = doc.composition.duration;
  const fix = (/** @type {{in:number,out:number}} */ range) => {
    range.in = Math.min(Math.max(0, range.in), duration);
    range.out = Math.min(Math.max(range.in + frameDuration(doc.composition.fps), range.out), duration);
    return range;
  };
  fix(doc.exportRange);
  fix(doc.loopRange);
}
