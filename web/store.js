/**
 * The editor store.
 *
 * Holds the project document, the selection, the playback position and the
 * transient UI state, and is the only place a document mutation is allowed to
 * happen. Two things make the rest of the app manageable:
 *
 *  - **`store.edit()`** wraps a mutation in an undo step. Continuous gestures
 *    (dragging a clip, sweeping a slider) call `beginGesture()` /
 *    `endGesture()` so the whole drag folds into one history entry, which is
 *    what the brief asks for and what users actually expect.
 *  - **Subscriptions are scoped**: `store.on('selection', fn)` fires only when
 *    the selection changes, so dragging a clip does not re-render the media
 *    library.
 */

import { clamp, clamp01 } from '/core/math.js';
import { PROJECT_VERSION, clampRanges, createProject, defaultClip, defaultMapping, defaultTrack, uid } from '/core/schema.js';
import { normalizeProject } from '/core/document.js';
import { pruneOrphanChannels, sortKeys } from '/core/keyframes.js';
import { defaultParams, effectDefinition } from '/core/effectRegistry.js';

/** @typedef {import('/core/schema.js').ProjectDoc} ProjectDoc */
/** @typedef {import('/core/schema.js').Clip} Clip */
/** @typedef {import('/core/schema.js').Track} Track */

/** Topics a view can subscribe to. */
export const TOPICS = /** @type {const} */ ([
  'doc',        // the project document changed (edit, load, undo)
  'selection',  // selected clip / track / asset / effect changed
  'playhead',   // time or playback state changed
  'timeline',   // zoom / scroll / snap changed
  'library',    // assets, folders or asset status changed
  'analysis',   // audio analysis or mapping curves changed
  'export',     // export jobs or format support changed
  'transport',  // loop / range / preview quality changed
  'ui',         // panels, dialogs, notices
]);

const HISTORY_LIMIT = 120;

export class Store {
  constructor() {
    /** @type {ProjectDoc} */
    this.doc = createProject();
    /** @type {any} */
    this.ui = {
      selectedClipIds: [],
      selectedTrackId: null,
      selectedAssetIds: [],
      selectedEffectId: null,
      selectedMaskId: null,
      selectedKeyChannels: [],
      libraryTab: 'all',
      libraryFolderId: null,
      libraryQuery: '',
      libraryView: 'grid',
      inspectorSection: 'transform',
      graphChannel: 'transform.position.x',
      graphOpen: false,
      leftOpen: true,
      rightOpen: true,
      zoomToFit: true,
      showSafeGuides: false,
      showOverlay: true,
      statusMessage: '',
    };
    /** @type {any} */
    this.playback = {
      time: 0,
      playing: false,
      rate: 1,
      loop: false,
      quality: 1,
      droppedFrames: 0,
      renderedFrames: 0,
      lastFrameMs: 0,
      audioReady: false,
    };
    /** @type {any} */
    this.session = {
      projectId: null,
      dirty: false,
      saveState: 'saved',
      lastSavedAt: null,
      recoveredDraft: null,
      notices: [],
      tools: null,
      formats: [],
      health: null,
      exportJob: null,
      analyses: {},
      decodeProgress: {},
    };
    this.history = { past: [], future: [], gesture: null, gestures: [] };
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
    /** @type {Set<string>} */
    this.pending = new Set();
    this.batching = false;
    this.assets = new Map();
    this.assetUrls = new Map();
    /** @type {Map<string, import('/core/audio.js').MappingCurve[]>} */
    this.mappingCache = new Map();
    this.clipboard = { clips: null, keyframes: null, effects: null, mappings: null };
  }

  /* ------------------------------------------------------------ events */

  /**
   * @param {string} topic
   * @param {Function} handler
   * @returns {() => void} unsubscribe
   */
  on(topic, handler) {
    if (!this.listeners.has(topic)) this.listeners.set(topic, new Set());
    this.listeners.get(topic).add(handler);
    return () => this.listeners.get(topic)?.delete(handler);
  }

  /**
   * @param {string} topic
   */
  emit(topic) {
    if (this.batching) {
      this.pending.add(topic);
      return;
    }
    const handlers = this.listeners.get(topic);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(this);
      } catch (error) {
        console.error(`[motion-lab] listener for "${topic}" failed`, error);
      }
    }
  }

  /**
   * Coalesce a burst of emissions into one per topic.
   * @param {() => void} fn
   */
  batch(fn) {
    const wasBatching = this.batching;
    this.batching = true;
    try {
      fn();
    } finally {
      this.batching = wasBatching;
      if (!this.batching) {
        const topics = [...this.pending];
        this.pending.clear();
        for (const topic of topics) this.emit(topic);
      }
    }
  }

  /* ------------------------------------------------------------ history */

  /**
   * Snapshot the document for undo. Uses structuredClone when available and
   * falls back to JSON round-tripping, which is correct here because the
   * document is plain JSON by contract.
   * @returns {string}
   */
  snapshot() {
    return JSON.stringify(this.doc);
  }

  /**
   * @param {string} label
   * @param {() => void} mutation
   * @param {{topics?:string[], coalesceKey?:string}} [options]
   */
  edit(label, mutation, options = {}) {
    const before = this.snapshot();
    mutation();
    const after = this.snapshot();
    if (before === after) return;

    const gesture = this.history.gesture;
    if (gesture) {
      gesture.label = gesture.label ?? label;
      gesture.dirty = true;
    } else {
      const key = options.coalesceKey;
      const top = this.history.past[this.history.past.length - 1];
      if (key && top && top.coalesceKey === key && Date.now() - top.at < 900) {
        top.after = after;
        top.at = Date.now();
      } else {
        this.history.past.push({ label, before, after, at: Date.now(), coalesceKey: key });
        if (this.history.past.length > HISTORY_LIMIT) this.history.past.shift();
      }
      this.history.future.length = 0;
    }
    this.markDirty();
    this.emit('doc');
    for (const topic of options.topics ?? []) this.emit(topic);
  }

  /**
   * Open a continuous gesture. Everything edited until `endGesture` becomes one
   * undo entry, no matter how many intermediate frames the pointer produced.
   *
   * A gesture is recorded whenever the document actually differs at the end,
   * whether the caller mutated it through `edit()` or wrote to it directly. The
   * timeline's drag handlers mutate clips in place for speed and only emit
   * `doc`, so relying on `edit()` alone would silently drop every drag from the
   * history -- which is exactly the kind of bug that makes undo feel broken.
   *
   * @param {string} label
   */
  beginGesture(label) {
    if (this.history.gesture) return;
    this.history.gesture = { label, before: this.snapshot(), after: null, dirty: false, at: Date.now() };
  }

  /**
   * @param {boolean} [commit]
   * @returns {boolean} whether a history entry was recorded
   */
  endGesture(commit = true) {
    const gesture = this.history.gesture;
    this.history.gesture = null;
    if (!gesture) return false;
    const after = this.snapshot();
    if (!commit || gesture.before === after) return false;
    this.history.past.push({ label: gesture.label, before: gesture.before, after, at: Date.now() });
    if (this.history.past.length > HISTORY_LIMIT) this.history.past.shift();
    this.history.future.length = 0;
    this.markDirty();
    this.emit('doc');
    return true;
  }

  canUndo() { return this.history.past.length > 0; }
  canRedo() { return this.history.future.length > 0; }

  undo() {
    const entry = this.history.past.pop();
    if (!entry) return false;
    this.history.future.push(entry);
    this.doc = JSON.parse(entry.before);
    this.afterHistoryChange(`Undo ${entry.label}`);
    return true;
  }

  redo() {
    const entry = this.history.future.pop();
    if (!entry) return false;
    this.history.past.push(entry);
    this.doc = JSON.parse(entry.after);
    this.afterHistoryChange(`Redo ${entry.label}`);
    return true;
  }

  /**
   * @param {string} label
   */
  afterHistoryChange(label) {
    this.pruneSelection();
    this.invalidateMappings();
    this.markDirty();
    this.ui.statusMessage = label;
    this.emit('doc');
    this.emit('selection');
    this.emit('analysis');
    this.emit('library');
  }

  markDirty() {
    this.session.dirty = true;
    this.session.saveState = 'dirty';
    this.emit('ui');
  }

  /* ------------------------------------------------------------ selection */

  /**
   * @param {string[]} clipIds
   */
  selectClips(clipIds) {
    this.ui.selectedClipIds = clipIds.filter(Boolean);
    if (this.ui.selectedClipIds.length === 1) {
      const clip = this.getClip(this.ui.selectedClipIds[0]);
      if (clip) {
        this.ui.selectedTrackId = clip.trackId;
        this.ui.selectedEffectId = null;
      }
    }
    this.emit('selection');
  }

  /**
   * @param {string} clipId
   * @param {boolean} [additive]
   */
  toggleClipSelection(clipId, additive = true) {
    const current = new Set(this.ui.selectedClipIds);
    if (current.has(clipId)) current.delete(clipId);
    else current.add(clipId);
    this.ui.selectedClipIds = additive ? [...current] : [clipId];
    this.emit('selection');
  }

  clearSelection() {
    this.ui.selectedClipIds = [];
    this.ui.selectedEffectId = null;
    this.ui.selectedMaskId = null;
    this.emit('selection');
  }

  /**
   * @param {string} id
   * @returns {Clip|undefined}
   */
  getClip(id) {
    return this.doc.clips.find((clip) => clip.id === id);
  }

  /**
   * @returns {Clip|undefined}
   */
  get primaryClip() {
    return this.getClip(this.ui.selectedClipIds[0]);
  }

  pruneSelection() {
    const clipIds = new Set(this.doc.clips.map((clip) => clip.id));
    this.ui.selectedClipIds = this.ui.selectedClipIds.filter((id) => clipIds.has(id));
    if (this.ui.selectedTrackId && !this.doc.tracks.some((track) => track.id === this.ui.selectedTrackId)) {
      this.ui.selectedTrackId = this.doc.tracks[0]?.id ?? null;
    }
    const clip = this.primaryClip;
    if (clip) {
      const effectIds = new Set(clip.effects.stack.map((effect) => effect.id));
      if (this.ui.selectedEffectId && !effectIds.has(this.ui.selectedEffectId)) this.ui.selectedEffectId = null;
      const maskIds = new Set(clip.masks.map((mask) => mask.id));
      if (this.ui.selectedMaskId && !maskIds.has(this.ui.selectedMaskId)) this.ui.selectedMaskId = null;
    }
  }

  /* ------------------------------------------------------------ document */

  /**
   * Replace the whole document, as when opening a project, starting a new one or
   * applying a template.
   *
   * The undo history is cleared deliberately: nothing recorded before this point
   * belongs to the document now on screen, and leaving it in place would let a
   * stray Ctrl+Z swap the user's project out from under them.
   *
   * @param {ProjectDoc} doc
   * @param {{projectId?:string|null}} [meta]
   */
  loadDocument(doc, meta = {}) {
    this.doc = doc;
    this.session.projectId = meta.projectId ?? doc.meta.id ?? null;
    this.session.dirty = false;
    this.session.saveState = 'saved';
    this.history.past.length = 0;
    this.history.future.length = 0;
    this.history.gesture = null;
    this.ui.selectedClipIds = [];
    this.ui.selectedTrackId = doc.tracks[0]?.id ?? null;
    this.playback.time = clamp(0, 0, doc.composition.duration);
    this.invalidateMappings();
    this.emit('doc');
    this.emit('selection');
    this.emit('library');
    this.emit('analysis');
    this.emit('timeline');
    this.emit('playhead');
  }

  /**
   * Replace the document wholesale (project settings, import, template).
   * @param {unknown} input
   * @param {string} label
   */
  replaceDocument(input, label) {
    const { doc, issues } = normalizeProject(input);
    this.edit(label, () => {
      this.doc = doc;
    });
    for (const issue of issues) if (issue.level !== 'info') this.notify(issue.level, issue.message);
    this.ui.selectedClipIds = [];
    this.invalidateMappings();
    this.emit('selection');
    this.emit('library');
  }

  /* ------------------------------------------------------------ time */

  /**
   * @param {number} time
   * @param {{silent?:boolean}} [options]
   */
  setTime(time, options = {}) {
    const duration = this.doc.composition.duration;
    const clamped = clamp(Number.isFinite(time) ? time : 0, 0, duration);
    if (Math.abs(clamped - this.playback.time) < 1e-6 && !options.silent) return;
    this.playback.time = clamped;
    this.emit('playhead');
  }

  /**
   * @param {number} frames
   */
  stepFrames(frames) {
    const fps = this.doc.composition.fps;
    const frame = Math.round(this.playback.time * fps) + frames;
    this.setTime(frame / fps);
  }

  /**
   * @param {boolean} playing
   */
  setPlaying(playing) {
    if (this.playback.playing === playing) return;
    this.playback.playing = playing;
    if (!playing) {
      this.playback.droppedFrames = 0;
      this.playback.renderedFrames = 0;
    }
    this.emit('playhead');
    this.emit('transport');
  }

  /* ------------------------------------------------------------ clips */

  /**
   * @param {Partial<Clip>} patch
   * @returns {Clip}
   */
  addClip(patch) {
    const clip = defaultClip(patch);
    if (!clip.trackId) clip.trackId = this.defaultTrackFor(clip.kind)?.id ?? '';
    this.edit(`Add ${clip.kind} clip`, () => {
      this.doc.clips.push(clip);
    }, { topics: ['selection'] });
    this.selectClips([clip.id]);
    return clip;
  }

  /**
   * Put a photo or video into an empty media slot (a starter project's "drop media
   * here" clip). The clip keeps its timing, effects, masks and keyframes.
   * @param {string} clipId
   * @param {import('/core/schema.js').AssetMeta} asset
   * @returns {boolean} false when the clip is not an empty visual slot or the file is not a picture
   */
  fillMediaSlot(clipId, asset) {
    const clip = this.doc.clips.find((entry) => entry.id === clipId);
    const visual = (/** @type {string} */ kind) => kind === 'image' || kind === 'video';
    if (!clip || clip.assetId || !visual(clip.kind) || !asset || !visual(asset.kind)) return false;
    if (!this.doc.assets.some((entry) => entry.id === asset.id)) this.registerAsset(asset);
    this.edit('Fill media slot', () => {
      clip.kind = asset.kind;
      clip.assetId = asset.id;
      if (/\(drop media here\)$/.test(clip.name)) clip.name = asset.name;
    });
    this.selectClips([clip.id]);
    return true;
  }

  /**
   * @param {string} kind
   * @returns {Track|undefined}
   */
  defaultTrackFor(kind) {
    if (kind === 'audio') return this.doc.tracks.find((track) => track.kind === 'audio');
    return this.doc.tracks.find((track) => track.kind === 'visual');
  }

  /**
   * @param {string[]} clipIds
   * @param {(clip:Clip)=>void} mutation
   * @param {string} label
   */
  updateClips(clipIds, mutation, label) {
    const ids = new Set(clipIds);
    this.edit(label, () => {
      for (const clip of this.doc.clips) if (ids.has(clip.id)) mutation(clip);
    });
  }

  /**
   * @param {string[]} clipIds
   */
  deleteClips(clipIds) {
    const ids = new Set(clipIds);
    if (ids.size === 0) return;
    this.edit('Delete clips', () => {
      this.doc.clips = this.doc.clips.filter((clip) => !ids.has(clip.id));
    });
    this.pruneSelection();
    this.emit('selection');
  }

  /**
   * @param {string[]} clipIds
   */
  duplicateClips(clipIds) {
    const ids = new Set(clipIds);
    const copies = [];
    this.edit('Duplicate clips', () => {
      for (const clip of this.doc.clips.filter((entry) => ids.has(entry.id))) {
        const copy = JSON.parse(JSON.stringify(clip));
        copy.id = uid('clip');
        copy.start = clip.start + clip.duration;
        copy.name = `${clip.name} copy`;
        copy.keyframes = copy.keyframes.map((channel) => ({
          ...channel,
          id: uid('chan'),
          keys: channel.keys.map((key) => ({ ...key, id: uid('key') })),
        }));
        copy.effects.stack = copy.effects.stack.map((effect) => ({
          ...effect,
          id: uid('fx'),
          params: { ...effect.params },
          seed: (effect.seed ?? 1) + 17,
        }));
        copy.masks = copy.masks.map((mask) => ({ ...mask, id: uid('mask') }));
        this.doc.clips.push(copy);
        copies.push(copy);
      }
    });
    if (copies.length) this.selectClips(copies.map((clip) => clip.id));
  }

  /**
   * Split every selected clip at the playhead (or the supplied time).
   * @param {number} [time]
   * @returns {number} number of splits performed
   */
  splitClips(time = this.playback.time) {
    const fps = this.doc.composition.fps;
    const at = Math.round(time * fps) / fps;
    const targets = this.doc.clips.filter((clip) => {
      if (!this.ui.selectedClipIds.includes(clip.id)) return false;
      return at > clip.start + 1e-6 && at < clip.start + clip.duration - 1e-6;
    });
    if (targets.length === 0) return 0;
    /** @type {string[]} */
    const newIds = [];
    this.edit('Split clips', () => {
      for (const clip of targets) {
        const offset = at - clip.start;
        const tail = JSON.parse(JSON.stringify(clip));
        tail.id = uid('clip');
        tail.start = at;
        tail.duration = clip.duration - offset;
        tail.inPoint = clip.inPoint + offset;
        tail.fadeIn = Math.min(clip.fadeIn, tail.duration);
        tail.fadeOut = Math.min(clip.fadeOut, tail.duration);
        // Keyframes after the cut belong to the tail; keep both sides coherent.
        for (const channel of tail.keyframes) {
          channel.id = uid('chan');
          channel.keys = channel.keys
            .filter((key) => key.time >= at - 1e-9)
            .map((key) => ({ ...key, id: uid('key') }));
        }
        tail.keyframes = tail.keyframes.filter((channel) => channel.keys.length > 0);
        for (const channel of clip.keyframes) {
          channel.keys = channel.keys.filter((key) => key.time <= at + 1e-9);
        }
        clip.keyframes = clip.keyframes.filter((channel) => channel.keys.length > 0);
        clip.duration = offset;
        this.doc.clips.push(tail);
        newIds.push(tail.id);
      }
    });
    this.selectClips(newIds);
    return targets.length;
  }

  /**
   * @param {string[]} clipIds
   * @param {boolean} hidden
   */
  setClipsHidden(clipIds, hidden) {
    this.updateClips(clipIds, (clip) => { clip.hidden = hidden; }, hidden ? 'Hide clips' : 'Show clips');
  }

  /* ------------------------------------------------------------ tracks */

  /**
   * @param {Partial<Track>} patch
   */
  addTrack(patch = {}) {
    const track = defaultTrack(patch);
    this.edit('Add track', () => {
      this.doc.tracks.push(track);
    });
    this.ui.selectedTrackId = track.id;
    this.emit('selection');
    return track;
  }

  /**
   * @param {string} trackId
   */
  removeTrack(trackId) {
    if (this.doc.tracks.length <= 1) {
      this.notify('warn', 'A composition needs at least one track.');
      return;
    }
    this.edit('Delete track', () => {
      this.doc.tracks = this.doc.tracks.filter((track) => track.id !== trackId);
      this.doc.clips = this.doc.clips.filter((clip) => clip.trackId !== trackId);
    });
    this.pruneSelection();
    this.emit('selection');
  }

  /**
   * Reorder by moving a track to a new index.
   * @param {string} trackId
   * @param {number} targetIndex
   */
  moveTrack(trackId, targetIndex) {
    const from = this.doc.tracks.findIndex((track) => track.id === trackId);
    if (from < 0) return;
    const to = clamp(targetIndex, 0, this.doc.tracks.length - 1);
    if (from === to) return;
    this.edit('Reorder tracks', () => {
      const [track] = this.doc.tracks.splice(from, 1);
      this.doc.tracks.splice(to, 0, track);
    });
  }

  /* ------------------------------------------------------------ effects */

  /**
   * @param {string} clipId
   * @param {string} type
   * @returns {string|null} new effect id
   */
  addEffect(clipId, type) {
    const clip = this.getClip(clipId);
    if (!clip) return null;
    const definition = effectDefinition(type);
    const instance = {
      id: uid('fx'),
      type,
      enabled: true,
      seed: 1000 + Math.floor(Math.random() * 9000),
      params: defaultParams(type),
    };
    this.edit(`Add ${definition.label}`, () => {
      clip.effects.stack.push(instance);
      clip.effects.enabled = true;
    });
    this.ui.selectedEffectId = instance.id;
    this.emit('selection');
    return instance.id;
  }

  /**
   * @param {string} clipId
   * @param {string} effectId
   */
  removeEffect(clipId, effectId) {
    const clip = this.getClip(clipId);
    if (!clip) return;
    this.edit('Remove effect', () => {
      clip.effects.stack = clip.effects.stack.filter((effect) => effect.id !== effectId);
      pruneOrphanChannels(clip);
    });
    this.emit('selection');
  }

  /**
   * @param {string} clipId
   * @param {string} effectId
   */
  duplicateEffect(clipId, effectId) {
    const clip = this.getClip(clipId);
    const source = clip?.effects.stack.find((effect) => effect.id === effectId);
    if (!clip || !source) return;
    const copy = JSON.parse(JSON.stringify(source));
    copy.id = uid('fx');
    copy.seed = (copy.seed ?? 1) + 37;
    this.edit('Duplicate effect', () => {
      const index = clip.effects.stack.findIndex((effect) => effect.id === effectId);
      clip.effects.stack.splice(index + 1, 0, copy);
    });
    this.ui.selectedEffectId = copy.id;
    this.emit('selection');
  }

  /**
   * @param {string} clipId
   * @param {string} effectId
   * @param {number} delta -1 up, +1 down
   */
  moveEffect(clipId, effectId, delta) {
    const clip = this.getClip(clipId);
    if (!clip) return;
    const index = clip.effects.stack.findIndex((effect) => effect.id === effectId);
    if (index < 0) return;
    const target = clamp(index + delta, 0, clip.effects.stack.length - 1);
    if (target === index) return;
    this.edit('Reorder effects', () => {
      const [instance] = clip.effects.stack.splice(index, 1);
      clip.effects.stack.splice(target, 0, instance);
    });
  }

  /**
   * @param {string} clipId
   * @param {number} fromIndex
   * @param {number} toIndex
   */
  reorderEffect(clipId, fromIndex, toIndex) {
    const clip = this.getClip(clipId);
    if (!clip) return;
    const target = clamp(toIndex, 0, clip.effects.stack.length - 1);
    if (fromIndex === target) return;
    this.edit('Reorder effects', () => {
      const [instance] = clip.effects.stack.splice(fromIndex, 1);
      clip.effects.stack.splice(target, 0, instance);
    });
  }

  /* ------------------------------------------------------------ masks */

  /**
   * @param {string} clipId
   * @param {import('/core/schema.js').MaskShape} shape
   */
  addMask(clipId, shape) {
    const clip = this.getClip(clipId);
    if (!clip) return null;
    const mask = {
      id: uid('mask'),
      name: shape === 'ellipse' ? 'Ellipse mask' : shape === 'polygon' ? 'Polygon mask' : 'Rectangle mask',
      shape,
      enabled: true,
      inverted: false,
      position: { x: 0.5, y: 0.5 },
      size: { x: 0.72, y: 0.72 },
      rotation: 0,
      roundness: 0,
      feather: 0.12,
      opacity: 1,
      points: shape === 'polygon'
        ? [
            { x: 0.5, y: 0.12 },
            { x: 0.88, y: 0.38 },
            { x: 0.74, y: 0.86 },
            { x: 0.26, y: 0.86 },
            { x: 0.12, y: 0.38 },
          ]
        : [],
      pointsClosed: true,
    };
    this.edit(`Add ${mask.name}`, () => {
      clip.masks.push(mask);
    });
    this.ui.selectedMaskId = mask.id;
    this.emit('selection');
    return mask;
  }

  /**
   * @param {string} clipId
   * @param {string} maskId
   */
  removeMask(clipId, maskId) {
    const clip = this.getClip(clipId);
    if (!clip) return;
    this.edit('Remove mask', () => {
      clip.masks = clip.masks.filter((mask) => mask.id !== maskId);
      pruneOrphanChannels(clip);
    });
    this.emit('selection');
  }

  /* ------------------------------------------------------------ mappings */

  /**
   * @param {Partial<import('/core/schema.js').AudioMapping>} patch
   */
  addMapping(patch = {}) {
    const mapping = defaultMapping(patch);
    this.edit('Add audio connection', () => {
      this.doc.mappings.push(mapping);
    }, { topics: ['analysis', 'selection'] });
    this.invalidateMappings();
    this.emit('analysis');
    return mapping;
  }

  /**
   * @param {string} mappingId
   * @param {Partial<import('/core/schema.js').AudioMapping>} patch
   * @param {{coalesce?:boolean}} [options]
   */
  updateMapping(mappingId, patch, options = {}) {
    this.edit('Update audio connection', () => {
      const mapping = this.doc.mappings.find((entry) => entry.id === mappingId);
      if (mapping) Object.assign(mapping, patch);
    }, { coalesceKey: options.coalesce ? `mapping:${mappingId}:${Object.keys(patch).join(',')}` : undefined });
    this.invalidateMappings();
    this.emit('analysis');
  }

  /**
   * @param {string} mappingId
   */
  removeMapping(mappingId) {
    this.edit('Remove audio connection', () => {
      this.doc.mappings = this.doc.mappings.filter((mapping) => mapping.id !== mappingId);
    });
    this.invalidateMappings();
    this.emit('analysis');
    this.emit('selection');
  }

  /* ------------------------------------------------------------ audio markers */

  /**
   * @param {number} time
   */
  addMarker(time) {
    const rounded = Math.round(time * 1000) / 1000;
    this.edit('Add marker', () => {
      const settings = this.doc.audioSettings;
      if (!settings.manualMarkers.some((value) => Math.abs(value - rounded) < 1e-3)) {
        settings.manualMarkers.push(rounded);
        settings.manualMarkers.sort((a, b) => a - b);
      }
    });
    this.emit('analysis');
  }

  /**
   * @param {number} time
   */
  removeMarker(time) {
    const rounded = Math.round(time * 1000) / 1000;
    this.edit('Remove marker', () => {
      const settings = this.doc.audioSettings;
      settings.manualMarkers = settings.manualMarkers.filter((value) => Math.abs(value - rounded) > 1e-3);
      if (!settings.removedMarkers.some((value) => Math.abs(value - rounded) < 1e-3)) {
        settings.removedMarkers.push(rounded);
      }
    });
    this.emit('analysis');
  }

  /* ------------------------------------------------------------ presets */

  /**
   * @param {import('/core/schema.js').Preset} preset
   */
  addPreset(preset) {
    this.edit('Save preset', () => {
      this.doc.presets.push(preset);
    });
    this.emit('library');
  }

  /**
   * @param {string} presetId
   */
  removePreset(presetId) {
    this.edit('Delete preset', () => {
      this.doc.presets = this.doc.presets.filter((preset) => preset.id !== presetId);
    });
    this.emit('library');
  }

  /* ------------------------------------------------------------ ranges */

  /**
   * @param {'exportRange'|'loopRange'} key
   * @param {{in?:number,out?:number}} patch
   * @param {boolean} [commit]
   */
  setRange(key, patch, commit = false) {
    const apply = () => {
      const range = this.doc[key];
      if (patch.in !== undefined) range.in = clamp(patch.in, 0, this.doc.composition.duration);
      if (patch.out !== undefined) range.out = clamp(patch.out, 0, this.doc.composition.duration);
      if (range.out < range.in) {
        if (patch.in !== undefined) range.out = range.in;
        else range.in = range.out;
      }
      clampRanges(this.doc);
    };
    if (commit) this.edit(`Set ${key === 'loopRange' ? 'loop' : 'export'} range`, apply);
    else apply();
    this.emit('transport');
  }

  /**
   * @param {string} preset
   */
  setExportRangePreset(preset) {
    const duration = this.doc.composition.duration;
    if (preset === 'all') this.setRange('exportRange', { in: 0, out: duration }, true);
    else if (preset === 'selection') {
      const clips = this.doc.clips.filter((clip) => this.ui.selectedClipIds.includes(clip.id));
      if (clips.length === 0) {
        this.notify('warn', 'Select a clip first — the export range follows the selection.');
        return;
      }
      const from = Math.min(...clips.map((clip) => clip.start));
      const to = Math.max(...clips.map((clip) => clip.start + clip.duration));
      this.setRange('exportRange', { in: from, out: to }, true);
    } else if (preset === 'loop') {
      this.setRange('exportRange', { in: this.doc.loopRange.in, out: this.doc.loopRange.out }, true);
    }
  }

  /* ------------------------------------------------------------ quality */

  /**
   * @param {number} quality 1, 0.5 or 0.25
   */
  setPreviewQuality(quality) {
    this.playback.quality = quality;
    this.emit('transport');
  }

  /* ------------------------------------------------------------ notices */

  /**
   * @param {'info'|'warn'|'error'|'ok'} level
   * @param {string} message
   * @param {{title?:string, timeout?:number}} [options]
   */
  notify(level, message, options = {}) {
    const notice = {
      id: uid('note'),
      level,
      message,
      title: options.title,
      at: Date.now(),
      timeout: options.timeout ?? (level === 'error' ? 12000 : 6000),
    };
    this.session.notices.push(notice);
    if (this.session.notices.length > 40) this.session.notices.shift();
    this.emit('ui');
    return notice;
  }

  /**
   * @param {string} id
   */
  dismissNotice(id) {
    this.session.notices = this.session.notices.filter((notice) => notice.id !== id);
    this.emit('ui');
  }

  /* ------------------------------------------------------------ mappings cache */

  invalidateMappings() {
    this.mappingCache.clear();
    this.emit('analysis');
  }

  /**
   * Precomputed per-frame audio modulation shared by preview and export.
   * @returns {import('/core/audio.js').MappingCurve[]}
   */
  modulationCurves() {
    const key = JSON.stringify([
      this.doc.mappings,
      Object.keys(this.doc.audio),
      this.doc.audioSettings,
      this.doc.composition.fps,
    ]);
    const cached = this.mappingCache.get(key);
    if (cached) return cached;
    // Imported lazily to keep the store free of engine imports at module scope.
    const built = buildCurves(this.doc);
    this.mappingCache.clear();
    this.mappingCache.set(key, built);
    return built;
  }

  /* ------------------------------------------------------------ assets */

  /**
   * @param {import('/core/schema.js').AssetMeta} asset
   */
  registerAsset(asset) {
    this.assets.set(asset.id, asset);
    const existing = this.doc.assets.findIndex((entry) => entry.id === asset.id);
    if (existing >= 0) this.doc.assets[existing] = asset;
    else this.doc.assets.push(asset);
    this.emit('library');
  }

  /**
   * @param {string} assetId
   */
  removeAsset(assetId) {
    this.edit('Remove media', () => {
      this.doc.assets = this.doc.assets.filter((asset) => asset.id !== assetId);
    });
    this.assets.delete(assetId);
    const url = this.assetUrls.get(assetId);
    if (url) {
      URL.revokeObjectURL(url);
      this.assetUrls.delete(assetId);
    }
    this.emit('library');
  }

  /**
   * @param {string} name
   */
  addFolder(name) {
    const folder = { id: uid('folder'), name };
    this.edit('Add folder', () => {
      this.doc.folders.push(folder);
    }, { topics: ['library'] });
    this.emit('library');
    return folder;
  }

  /**
   * @param {string} assetId
   * @param {string|null} folderId
   */
  moveAssetToFolder(assetId, folderId) {
    this.edit('Move media', () => {
      const asset = this.doc.assets.find((entry) => entry.id === assetId);
      if (!asset) return;
      if (folderId) asset.folderId = folderId;
      else delete asset.folderId;
    }, { topics: ['library'] });
    this.emit('library');
  }
}

/** Lazily bound to avoid a circular import at module load. */
/** @type {(doc:ProjectDoc)=>import('/core/audio.js').MappingCurve[]} */
let buildCurves = () => [];
export function bindCurveBuilder(fn) {
  buildCurves = fn;
}

/** The single store instance the app uses. */
export const store = new Store();

/** Re-exported so views can implement "fit" without importing the schema. */
export function compositionAspect(/** @type {ProjectDoc} */ doc) {
  return doc.composition.width / doc.composition.height;
}

export { clamp, clamp01, sortKeys, PROJECT_VERSION };
