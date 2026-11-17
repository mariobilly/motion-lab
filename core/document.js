/**
 * Document normalisation, migration and validation.
 *
 * `normalizeProject` is the only entry point anyone should use to turn
 * untrusted JSON into a project document: it is applied to files loaded from
 * disk, backups restored from a package, and drafts recovered after a crash.
 * It never throws on bad input -- it repairs what it can, drops what it cannot
 * and reports every change it made, so the UI can tell the user exactly what
 * happened to their project.
 */

import {
  PROJECT_FORMAT, PROJECT_VERSION, clampRanges, createProject, defaultAudioSettings, defaultClip,
  defaultComposition, defaultGraphic, defaultTextStyle, defaultTrack, defaultMapping, emptyEffects,
  neutralTransform, uid,
} from './schema.js';
import { coerceParam, defaultParams, effectDefinition } from './effectRegistry.js';
import { normalizeEasing } from './keyframes.js';
import { clamp, clamp01 } from './math.js';

/**
 * @typedef {{level:'info'|'warn'|'error', message:string}} NormalizeIssue
 */

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function num(value, fallback) {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function str(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * @template T
 * @param {unknown} value
 * @param {T} fallback
 * @returns {T}
 */
function clone(value, fallback) {
  if (value === undefined || value === null) return JSON.parse(JSON.stringify(fallback));
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return JSON.parse(JSON.stringify(fallback));
  }
}

/**
 * Normalise an effect instance, dropping anything unusable and filling in
 * parameters that a newer version of the registry introduced.
 * @param {any} input
 * @param {NormalizeIssue[]} issues
 * @returns {import('./schema.js').EffectInstance|null}
 */
function normalizeEffect(input, issues) {
  if (!input || typeof input !== 'object') return null;
  const type = str(input.type, '');
  if (!type) return null;
  const definition = effectDefinition(type);
  if (definition.category === 'Unknown') {
    issues.push({ level: 'warn', message: `Unknown effect "${type}" was removed.` });
    return null;
  }
  const defaults = defaultParams(type);
  /** @type {Record<string, any>} */
  const params = {};
  for (const spec of definition.params) {
    const provided = input.params && typeof input.params === 'object' ? input.params[spec.key] : undefined;
    params[spec.key] = provided === undefined ? defaults[spec.key] : coerceParam(spec, provided);
  }
  return {
    id: str(input.id, uid('fx')),
    type,
    enabled: bool(input.enabled, true),
    seed: Math.max(1, Math.round(num(input.seed, 1 + Math.floor(Math.random() * 9999)))),
    params,
  };
}

/**
 * @param {any} input
 * @returns {import('./schema.js').Transform}
 */
function normalizeTransform(input) {
  const base = neutralTransform();
  if (!input || typeof input !== 'object') return base;
  return {
    x: num(input.x, base.x),
    y: num(input.y, base.y),
    scaleX: clamp(num(input.scaleX, base.scaleX), -20, 20),
    scaleY: clamp(num(input.scaleY, base.scaleY), -20, 20),
    rotation: num(input.rotation, base.rotation),
    opacity: clamp01(num(input.opacity, base.opacity)),
    anchorX: clamp(num(input.anchorX, base.anchorX), -5, 6),
    anchorY: clamp(num(input.anchorY, base.anchorY), -5, 6),
    cropTop: clamp(num(input.cropTop, 0), 0, 0.98),
    cropRight: clamp(num(input.cropRight, 0), 0, 0.98),
    cropBottom: clamp(num(input.cropBottom, 0), 0, 0.98),
    cropLeft: clamp(num(input.cropLeft, 0), 0, 0.98),
  };
}

/**
 * @param {any} input
 * @returns {import('./schema.js').Mask}
 */
function normalizeMask(input) {
  const shape = input?.shape === 'ellipse' || input?.shape === 'polygon' ? input.shape : 'rect';
  const points = Array.isArray(input?.points)
    ? /** @type {any[]} */ (input.points)
        .filter((point) => point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)))
        .map((point) => ({ x: clamp01(Number(point.x)), y: clamp01(Number(point.y)) }))
    : [];
  return {
    id: str(input?.id, uid('mask')),
    name: str(input?.name, shape === 'ellipse' ? 'Ellipse mask' : shape === 'polygon' ? 'Polygon mask' : 'Rectangle mask'),
    shape,
    enabled: bool(input?.enabled, true),
    inverted: bool(input?.inverted, false),
    position: {
      x: num(input?.position?.x, 0.5),
      y: num(input?.position?.y, 0.5),
    },
    size: {
      x: clamp(num(input?.size?.x, 0.7), 0, 4),
      y: clamp(num(input?.size?.y, 0.7), 0, 4),
    },
    rotation: num(input?.rotation, 0),
    roundness: clamp01(num(input?.roundness, 0)),
    feather: clamp01(num(input?.feather, 0)),
    opacity: clamp01(num(input?.opacity, 1)),
    points: points.length >= 3 ? points : [],
    pointsClosed: bool(input?.pointsClosed, true),
  };
}

/**
 * @param {any} input
 * @returns {import('./schema.js').KeyChannel[]}
 */
function normalizeKeyframes(input) {
  if (!Array.isArray(input)) return [];
  /** @type {import('./schema.js').KeyChannel[]} */
  const channels = [];
  for (const entry of /** @type {any[]} */ (input)) {
    if (!entry || typeof entry.channel !== 'string') continue;
    const keys = Array.isArray(entry.keys)
      ? /** @type {any[]} */ (entry.keys)
          .filter((key) => key && Number.isFinite(Number(key.time)) && Number.isFinite(Number(key.value)))
          .map((key) => ({
            id: str(key.id, uid('key')),
            time: Math.max(0, num(key.time, 0)),
            value: num(key.value, 0),
            ease: normalizeEasing(key.ease),
          }))
          .sort((a, b) => a.time - b.time)
      : [];
    if (keys.length === 0) continue;
    channels.push({ id: str(entry.id, uid('chan')), channel: entry.channel, keys });
  }
  return channels;
}

/**
 * @param {any} input
 * @param {string[]} trackIds
 * @param {NormalizeIssue[]} issues
 * @returns {import('./schema.js').Clip}
 */
function normalizeClip(input, trackIds, issues) {
  const clip = defaultClip();
  const kind = ['image', 'video', 'text', 'graphic', 'audio', 'adjustment', 'nested'].includes(input?.kind)
    ? input.kind
    : 'image';
  clip.id = str(input?.id, clip.id);
  clip.name = str(input?.name, 'Clip');
  clip.kind = kind;
  clip.trackId = trackIds.includes(input?.trackId) ? input.trackId : trackIds[0] ?? '';
  if (!trackIds.includes(input?.trackId)) {
    issues.push({ level: 'warn', message: `Clip "${clip.name}" had no valid track and was moved to the first track.` });
  }
  clip.hidden = bool(input?.hidden, false);
  clip.start = Math.max(0, num(input?.start, 0));
  clip.duration = Math.max(1 / 240, num(input?.duration, 5));
  clip.inPoint = Math.max(0, num(input?.inPoint, 0));
  clip.transform = normalizeTransform(input?.transform);
  clip.blend = /** @type {import('./schema.js').BlendMode} */ (str(input?.blend, 'normal'));
  clip.volume = clamp(num(input?.volume, 1), 0, 4);
  clip.pan = clamp(num(input?.pan, 0), -1, 1);
  clip.fadeIn = Math.max(0, num(input?.fadeIn, 0));
  clip.fadeOut = Math.max(0, num(input?.fadeOut, 0));
  /** @type {import('./schema.js').EffectInstance[]} */
  const stack = [];
  if (Array.isArray(input?.effects?.stack)) {
    for (const entry of /** @type {any[]} */ (input.effects.stack)) {
      const normalized = normalizeEffect(entry, issues);
      if (normalized) stack.push(normalized);
    }
  }
  clip.effects = {
    enabled: bool(input?.effects?.enabled, true),
    stack,
  };
  clip.masks = Array.isArray(input?.masks) ? /** @type {any[]} */ (input.masks).map(normalizeMask) : [];
  clip.keyframes = normalizeKeyframes(input?.keyframes);
  clip.seed = Math.max(1, Math.round(num(input?.seed, 1)));
  clip.reverse = bool(input?.reverse, false);
  clip.playbackRate = clamp(num(input?.playbackRate, 1), 0.05, 20);
  if (input?.assetId) clip.assetId = String(input.assetId);
  if (input?.compositionId) clip.compositionId = String(input.compositionId);
  if (kind === 'graphic') {
    clip.graphic = /** @type {import('./schema.js').GraphicSpec} */ ({
      ...defaultGraphic(),
      ...clone(input?.graphic, {}),
      kind: /** @type {import('./schema.js').SourceType} */ (str(input?.graphic?.kind, 'gradient')),
    });
  }
  if (kind === 'text') clip.text = /** @type {import('./schema.js').TextStyle} */ ({ ...defaultTextStyle(), ...clone(input?.text, {}) });
  return clip;
}

/**
 * Normalise a whole project document.
 *
 * @param {unknown} input
 * @param {{source?:string}} [options]
 * @returns {{doc:import('./schema.js').ProjectDoc, issues:NormalizeIssue[], migratedFrom:number|null}}
 */
export function normalizeProject(input, options = {}) {
  /** @type {NormalizeIssue[]} */
  const issues = [];
  const source = input && typeof input === 'object' ? /** @type {any} */ (input) : null;

  if (!source) {
    issues.push({ level: 'error', message: 'The project file was empty or not valid JSON; a new project was created instead.' });
    return { doc: createProject(), issues, migratedFrom: null };
  }

  const incomingVersion = Math.round(num(source.version, 0));
  const migratedFrom = incomingVersion < PROJECT_VERSION && incomingVersion > 0 ? incomingVersion : null;
  if (migratedFrom) {
    issues.push({ level: 'info', message: `Project upgraded from format version ${migratedFrom} to ${PROJECT_VERSION}.` });
  }
  if (source.format && source.format !== PROJECT_FORMAT) {
    issues.push({ level: 'warn', message: `This file was saved as "${source.format}", not "${PROJECT_FORMAT}". Loading it anyway.` });
  }

  const composition = defaultComposition({
    width: Math.max(16, Math.min(8192, Math.round(num(source.composition?.width, 1920)))),
    height: Math.max(16, Math.min(8192, Math.round(num(source.composition?.height, 1080)))),
    fps: [24, 25, 30, 60].includes(Math.round(num(source.composition?.fps, 30))) ? Math.round(num(source.composition?.fps, 30)) : 30,
    duration: clamp(num(source.composition?.duration, 20), 0.1, 3600),
    background: str(source.composition?.background, '#0a0a0f'),
    aspect: /** @type {import('./schema.js').AspectId} */ (str(source.composition?.aspect, 'landscape')),
  });

  const doc = createProject(
    {
      id: str(source.meta?.id, uid('proj')),
      name: str(source.meta?.name, 'Untitled composition'),
      createdAt: Math.round(num(source.meta?.createdAt, Date.now())),
      updatedAt: Math.round(num(source.meta?.updatedAt, Date.now())),
      ...(source.meta?.thumbnail ? { thumbnail: String(source.meta.thumbnail) } : {}),
    },
    composition,
  );

  /* ---- assets ---- */
  const assets = /** @type {any[]} */ (Array.isArray(source.assets) ? source.assets : []);
  const seenAssetIds = new Set();
  /** @type {import('./schema.js').AssetMeta[]} */
  const normalizedAssets = [];
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object') continue;
    const id = str(asset.id, uid('asset'));
    if (seenAssetIds.has(id)) continue;
    seenAssetIds.add(id);
    normalizedAssets.push(/** @type {any} */ ({
      id,
      kind: ['image', 'video', 'audio'].includes(asset.kind) ? asset.kind : 'image',
      name: str(asset.name, 'Asset'),
      fileName: str(asset.fileName, 'asset'),
      size: Math.max(0, Math.round(num(asset.size, 0))),
      mime: str(asset.mime, 'application/octet-stream'),
      width: Math.max(0, Math.round(num(asset.width, 0))),
      height: Math.max(0, Math.round(num(asset.height, 0))),
      duration: Math.max(0, num(asset.duration, 0)),
      ...(Number.isFinite(asset.fps) ? { fps: num(asset.fps, 0) } : {}),
      origin: ['server', 'library', 'procedural'].includes(asset.origin) ? asset.origin : 'library',
      status: ['ok', 'missing', 'unsupported', 'analyzing', 'error'].includes(asset.status) ? asset.status : 'ok',
      ...(asset.statusDetail ? { statusDetail: String(asset.statusDetail) } : {}),
      ...(asset.folderId ? { folderId: String(asset.folderId) } : {}),
      addedAt: str(asset.addedAt, new Date().toISOString()),
      ...(Number.isFinite(asset.seed) ? { seed: num(asset.seed, 1) } : {}),
      ...(asset.previewUrl ? { previewUrl: String(asset.previewUrl) } : {}),
    }));
  }
  doc.assets = normalizedAssets;

  const assetIds = new Set(doc.assets.map((asset) => asset.id));

  /* ---- folders ---- */
  const folderInput = /** @type {any[]} */ (Array.isArray(source.folders) ? source.folders : []);
  doc.folders = folderInput.length
    ? folderInput
        .filter((folder) => folder && typeof folder === 'object')
        .map((folder) => ({
          id: str(folder.id, uid('folder')),
          name: str(folder.name, 'Folder'),
          ...(folder.parentId ? { parentId: String(folder.parentId) } : {}),
        }))
    : doc.folders;

  /* ---- nested compositions ---- */
  const compositionInput = /** @type {any[]} */ (Array.isArray(source.compositions) ? source.compositions : []);
  doc.compositions = compositionInput
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const nestedComposition = defaultComposition({
        width: Math.max(16, Math.round(num(entry.composition?.width, composition.width))),
        height: Math.max(16, Math.round(num(entry.composition?.height, composition.height))),
        fps: composition.fps,
        duration: clamp(num(entry.composition?.duration, 5), 0.1, 3600),
        background: str(entry.composition?.background, 'transparent'),
      });
      const trackInput = /** @type {any[]} */ (Array.isArray(entry.tracks) ? entry.tracks : []);
      const nestedTracks = trackInput.length
        ? trackInput.map((track) => normalizeTrack(track))
        : [defaultTrack({ name: 'Layer 1' })];
      const nestedTrackIds = nestedTracks.map((track) => track.id);
      const nestedClipInput = /** @type {any[]} */ (Array.isArray(entry.clips) ? entry.clips : []);
      return {
        id: str(entry.id, uid('comp')),
        name: str(entry.name, 'Nested composition'),
        composition: nestedComposition,
        tracks: nestedTracks,
        clips: nestedClipInput.map((clip) => normalizeClip(clip, nestedTrackIds, issues)),
      };
    });

  /* ---- tracks & clips ---- */
  const trackInput = /** @type {any[]} */ (Array.isArray(source.tracks) ? source.tracks : []);
  doc.tracks = trackInput.length ? trackInput.map((track) => normalizeTrack(track)) : doc.tracks;
  const trackIds = doc.tracks.map((track) => track.id);
  const clipInput = /** @type {any[]} */ (Array.isArray(source.clips) ? source.clips : []);
  doc.clips = clipInput.map((clip) => normalizeClip(clip, trackIds, issues));

  /* ---- dangling references ---- */
  const nestedIds = new Set(doc.compositions.map((entry) => entry.id));
  const isAvailable = (/** @type {string} */ id) => assetIds.has(id) || id.startsWith('builtin:');
  let missingAssets = 0;
  let missingNested = 0;
  for (const clip of doc.clips) {
    if (clip.assetId && !isAvailable(clip.assetId)) {
      missingAssets += 1;
      clip.hidden = clip.hidden || false;
    }
    if (clip.kind === 'nested' && clip.compositionId && !nestedIds.has(clip.compositionId)) {
      missingNested += 1;
      issues.push({ level: 'warn', message: `Nested clip "${clip.name}" pointed at a composition that no longer exists.` });
      clip.kind = 'adjustment';
      delete clip.compositionId;
      clip.effects = clip.effects ?? emptyEffects();
    }
  }
  for (const clip of doc.clips) if (clip.assetId && !assetIds.has(clip.assetId) && !clip.assetId.startsWith('builtin:')) clip.assetId = clip.assetId;
  for (const nested of doc.compositions) {
    for (const clip of nested.clips) {
      if (clip.kind === 'nested' && clip.compositionId === nested.id) {
        issues.push({ level: 'warn', message: `Nested composition "${nested.name}" referenced itself; the reference was removed.` });
        clip.kind = 'adjustment';
        delete clip.compositionId;
      }
    }
  }
  if (missingAssets > 0) {
    issues.push({
      level: 'warn',
      message: `${missingAssets} clip${missingAssets === 1 ? '' : 's'} referenced media that is not in this project yet. Use Relink in the media library to choose the file.`,
    });
  }

  /* ---- audio ---- */
  doc.audio = {};
  if (source.audio && typeof source.audio === 'object') {
    for (const [assetId, analysis] of Object.entries(source.audio)) {
      if (!analysis || typeof analysis !== 'object') continue;
      const record = /** @type {any} */ (analysis);
      if (!Array.isArray(record.level)) continue;
      const level = /** @type {any[]} */ (record.level);
      /** @param {any} value */
      const unit = (value) => clamp01(num(value, 0));
      /** @param {any} value */
      const seconds = (value) => Math.max(0, num(value, 0));
      /** @param {any} a @param {any} b */
      const ascending = (a, b) => a - b;
      doc.audio[assetId] = {
        assetId,
        sampleRate: num(record.sampleRate, 22050),
        hop: num(record.hop, 256),
        hopSeconds: num(record.hopSeconds, 0.0116),
        frames: Math.round(num(record.frames, level.length)),
        duration: num(record.duration, 0),
        level: level.map(unit),
        low: Array.isArray(record.low) ? /** @type {any[]} */ (record.low).map(unit) : level.map(() => 0),
        mid: Array.isArray(record.mid) ? /** @type {any[]} */ (record.mid).map(unit) : level.map(() => 0),
        high: Array.isArray(record.high) ? /** @type {any[]} */ (record.high).map(unit) : level.map(() => 0),
        waveform: Array.isArray(record.waveform) ? /** @type {any[]} */ (record.waveform).map((value) => num(value, 0)) : [],
        onsets: Array.isArray(record.onsets) ? /** @type {any[]} */ (record.onsets).map(seconds).sort(ascending) : [],
        beats: Array.isArray(record.beats) ? /** @type {any[]} */ (record.beats).map(seconds).sort(ascending) : [],
        tempo: Math.max(0, Math.round(num(record.tempo, 0))),
        tempoConfidence: clamp01(num(record.tempoConfidence, 0)),
        analysedAt: Math.round(num(record.analysedAt, Date.now())),
      };
    }
  }

  /* ---- mappings ---- */
  const mappingInput = /** @type {any[]} */ (Array.isArray(source.mappings) ? source.mappings : []);
  doc.mappings = mappingInput
    .filter((mapping) => mapping && typeof mapping === 'object')
    .map((mapping) => {
      const base = defaultMapping();
      return {
        ...base,
        id: str(mapping.id, base.id),
        enabled: bool(mapping.enabled, true),
        name: str(mapping.name, 'Connection'),
        source: str(mapping.source, ''),
        band: ['level', 'low', 'mid', 'high', 'onset', 'beat'].includes(mapping.band) ? mapping.band : 'level',
        target: str(mapping.target, base.target),
        ...(mapping.clipId ? { clipId: String(mapping.clipId) } : {}),
        sensitivity: clamp(num(mapping.sensitivity, 1), 0, 20),
        min: num(mapping.min, 0),
        max: num(mapping.max, 1),
        smoothing: clamp01(num(mapping.smoothing, 0.5)),
        attack: clamp(num(mapping.attack, 0.01), 0.0005, 5),
        release: clamp(num(mapping.release, 0.18), 0.0005, 8),
        mode: ['set', 'add', 'multiply'].includes(mapping.mode) ? mapping.mode : 'set',
        invert: bool(mapping.invert, false),
      };
    });

  /* ---- audio settings, ranges, timeline ---- */
  const manualMarkers = /** @type {any[]} */ (Array.isArray(source.audioSettings?.manualMarkers) ? source.audioSettings.manualMarkers : []);
  const removedMarkers = /** @type {any[]} */ (Array.isArray(source.audioSettings?.removedMarkers) ? source.audioSettings.removedMarkers : []);
  doc.audioSettings = {
    masterGain: clamp(num(source.audioSettings?.masterGain, 1), 0, 4),
    tempo: Math.max(0, Math.round(num(source.audioSettings?.tempo, 0))),
    offset: num(source.audioSettings?.offset, 0),
    loopMarkers: bool(source.audioSettings?.loopMarkers, false),
    manualMarkers: manualMarkers.map((value) => Math.max(0, num(value, 0))),
    removedMarkers: removedMarkers.map((value) => Math.max(0, num(value, 0))),
  };
  doc.exportRange = {
    in: Math.max(0, num(source.exportRange?.in, 0)),
    out: Math.max(0, num(source.exportRange?.out, composition.duration)),
  };
  doc.loopRange = {
    in: Math.max(0, num(source.loopRange?.in, 0)),
    out: Math.max(0, num(source.loopRange?.out, composition.duration)),
  };
  doc.timeline = {
    snap: bool(source.timeline?.snap, true),
    snapToMarkers: bool(source.timeline?.snapToMarkers, true),
    zoom: clamp(num(source.timeline?.zoom, 42), 4, 400),
    scroll: Math.max(0, num(source.timeline?.scroll, 0)),
  };
  const presetInput = /** @type {any[]} */ (Array.isArray(source.presets) ? source.presets : []);
  doc.presets = presetInput
    .filter((preset) => preset && typeof preset === 'object')
    .map((preset) => ({
      id: str(preset.id, uid('preset')),
      name: str(preset.name, 'Preset'),
      kind: ['effect-stack', 'animation', 'audio-mapping', 'template', 'graphic'].includes(preset.kind) ? preset.kind : 'effect-stack',
      ...(preset.category ? { category: String(preset.category) } : {}),
      ...(preset.description ? { description: String(preset.description) } : {}),
      createdAt: Math.round(num(preset.createdAt, Date.now())),
      data: clone(preset.data, {}),
    }));
  const noteInput = /** @type {any[]} */ (Array.isArray(source.notes) ? source.notes : []);
  doc.notes = noteInput.map((note) => String(note));
  clampRanges(doc);

  if (missingNested > 0) {
    issues.push({ level: 'warn', message: `${missingNested} nested composition reference${missingNested === 1 ? '' : 's'} could not be resolved.` });
  }

  return { doc, issues, migratedFrom };
}

/**
 * @param {any} input
 * @returns {import('./schema.js').Track}
 */
function normalizeTrack(input) {
  const base = defaultTrack();
  return {
    id: str(input?.id, base.id),
    name: str(input?.name, 'Track'),
    kind: ['visual', 'audio', 'adjustment'].includes(input?.kind) ? input.kind : 'visual',
    muted: bool(input?.muted, false),
    solo: bool(input?.solo, false),
    locked: bool(input?.locked, false),
    hidden: bool(input?.hidden, false),
    height: clamp(Math.round(num(input?.height, 74)), 42, 240),
    volume: clamp(num(input?.volume, 1), 0, 4),
    collapsed: bool(input?.collapsed, false),
  };
}

/**
 * Validate a document and return human-readable problems, without changing it.
 * Used before an export so the user hears about issues first.
 * @param {import('./schema.js').ProjectDoc} doc
 * @returns {Array<{level:'info'|'warn'|'error', message:string}>}
 */
export function validateProject(doc) {
  /** @type {Array<{level:'info'|'warn'|'error', message:string}>} */
  const issues = [];
  if (doc.clips.length === 0) issues.push({ level: 'warn', message: 'The composition has no clips yet.' });
  const missing = doc.assets.filter((asset) => asset.status === 'missing' || asset.status === 'unsupported');
  if (missing.length) {
    issues.push({ level: 'warn', message: `${missing.length} media file${missing.length === 1 ? '' : 's'} need attention: ${missing.map((asset) => asset.name).join(', ')}.` });
  }
  const range = doc.exportRange;
  if (range.out - range.in < 1 / doc.composition.fps) {
    issues.push({ level: 'error', message: 'The export range is shorter than a single frame.' });
  }
  const usedAssetIds = new Set(doc.clips.map((clip) => clip.assetId).filter(Boolean));
  for (const assetId of usedAssetIds) {
    const asset = doc.assets.find((entry) => entry.id === assetId);
    if (asset && asset.kind === 'audio' && !doc.audio[asset.id]) {
      issues.push({ level: 'info', message: `"${asset.name}" has not been analysed yet, so audio connections cannot use it.` });
    }
  }
  return issues;
}

/**
 * A trimmed copy of the document suitable for embedding in a shareable preset.
 * @param {import('./schema.js').ProjectDoc} doc
 * @returns {import('./schema.js').ProjectDoc}
 */
export function slimCopy(doc) {
  const copy = clone(doc, doc);
  copy.meta.thumbnail = undefined;
  return copy;
}
