/**
 * Media engine: asset loading, the preview `FrameSource`, audio decoding and
 * thumbnail generation.
 *
 * The renderer never touches the network or an `<video>` element directly -- it
 * asks this module for "the picture of asset X at time T". Keeping that behind
 * one interface is what lets the *same* renderer run against a live `<video>` in
 * the editor and against a pre-extracted frame index during export.
 *
 * Determinism notes:
 *  - A video seek is awaited before the frame is handed back, so a scrub and a
 *    playback pass draw the same picture for the same timestamp.
 *  - Decoded audio is written back to the server, so the mixdown used at export
 *    time is byte-identical to the samples the analysis was computed from.
 */

import { api, assetAudioUrl, assetFileUrl, assetFrameUrl, assetPreviewUrl } from './api.js';
import { analyzeAudio } from '/core/audioAnalysis.js';
import { storeAnalysis } from '/core/audio.js';

/** Seconds a playing video element may drift from the playhead before it is re-seeked. */
const PLAYBACK_DRIFT = 0.15;

/** The last frame each video element showed, kept while a seek is loading. @type {WeakMap<HTMLVideoElement, HTMLCanvasElement>} */
const lastFrames = new WeakMap();

/** @param {HTMLVideoElement} video */
function rememberFrame(video) {
  let canvas = lastFrames.get(video);
  if (!canvas) {
    canvas = document.createElement('canvas');
    lastFrames.set(video, canvas);
  }
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  canvas.getContext('2d')?.drawImage(video, 0, 0);
}

/** @typedef {import('/core/schema.js').AssetMeta} AssetMeta */

/**
 * @typedef {object} LoadedAsset
 * @property {AssetMeta} meta
 * @property {HTMLImageElement|HTMLVideoElement|null} element
 * @property {object} [objectUrls]
 */

export class MediaEngine {
  /**
   * @param {import('./store.js').Store} store
   */
  constructor(store) {
    this.store = store;
    /** @type {Map<string, LoadedAsset>} */
    this.loaded = new Map();
    /** @type {Map<string, Promise<LoadedAsset|null>>} */
    this.loading = new Map();
    /** @type {Map<string, {channels: Float32Array[], sampleRate: number, duration: number}>} */
    this.audioBuffers = new Map();
    /** @type {Map<string, Promise<any>>} */
    this.analyseJobs = new Map();
    /** @type {HTMLCanvasElement|null} */
    this.scratch = null;
    this.frameSource = this.createFrameSource();
    /** @type {((assetId:string, progress:number)=>void)|null} */
    this.onProgress = null;
  }

  /* ------------------------------------------------------------ library */

  /**
   * Load the library listing from the server and merge it into the document.
   * @returns {Promise<AssetMeta[]>}
   */
  async refreshLibrary() {
    const { assets } = await api.listAssets();
    const known = new Set(assets.map((asset) => asset.id));
    for (const asset of assets) this.store.registerAsset(asset);
    // Assets the server no longer has are marked missing rather than dropped, so
    // clips that reference them keep their edit and offer a relink.
    for (const asset of this.store.doc.assets) {
      if (!known.has(asset.id)) {
        asset.status = 'missing';
        asset.statusDetail = 'This file is no longer in the media folder. Relink it to restore the clips that use it.';
      }
    }
    return assets;
  }

  /**
   * Import files through the server, which probes them and stores a preview.
   * @param {File[]} files
   * @param {{folderId?:string}} [options]
   * @returns {Promise<AssetMeta[]>}
   */
  async importFiles(files, options = {}) {
    const imported = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      this.onProgress?.(file.name, index / files.length);
      try {
        const result = await api.uploadAssets([file], options.folderId ? { folderId: options.folderId } : {});
        for (const asset of result.assets ?? []) {
          this.store.registerAsset(asset);
          imported.push(asset);
        }
      } catch (error) {
        this.store.notify('error', `"${file.name}" could not be imported: ${error instanceof Error ? error.message : error}`, {
          title: 'Import failed',
        });
      }
    }
    this.onProgress?.('', 1);
    // Fill in anything the server could not determine and generate thumbnails.
    for (const asset of imported) await this.finaliseAsset(asset);
    if (imported.length) {
      this.store.edit(`Import ${imported.length} file${imported.length === 1 ? '' : 's'}`, () => {
        for (const asset of imported) {
          if (!this.store.doc.assets.some((entry) => entry.id === asset.id)) this.store.doc.assets.push(asset);
        }
      }, { topics: ['library'] });
    }
    return imported;
  }

  /**
   * Read dimensions/duration in the browser when the server could not, store a
   * thumbnail, and analyse audio.
   * @param {AssetMeta} asset
   */
  async finaliseAsset(asset) {
    try {
      if (asset.kind === 'image' || asset.kind === 'video') {
        const measured = await this.measure(asset);
        if (measured) {
          const needsUpdate = measured.width !== asset.width || measured.height !== asset.height
            || (measured.duration > 0 && Math.abs(measured.duration - asset.duration) > 0.05);
          if (needsUpdate) {
            asset.width = measured.width || asset.width;
            asset.height = measured.height || asset.height;
            if (measured.duration) asset.duration = measured.duration;
            await api.updateAsset(asset.id, { name: asset.name });
            this.store.probeCache = measured;
          }
        }
        if (!asset.status || asset.status !== 'ok') {
          asset.status = 'ok';
          delete asset.statusDetail;
        }
        await this.ensureThumbnail(asset);
      } else if (asset.kind === 'audio') {
        await this.ensureAnalysis(asset.id);
        asset.status = 'ok';
        delete asset.statusDetail;
      }
      this.store.registerAsset(asset);
    } catch (error) {
      asset.status = 'error';
      asset.statusDetail = error instanceof Error ? error.message : String(error);
      this.store.registerAsset(asset);
      this.store.notify('warn', `"${asset.name}" imported, but Motion Lab could not read it: ${asset.statusDetail}`);
    }
  }

  /**
   * @param {AssetMeta} asset
   * @returns {Promise<{width:number,height:number,duration:number}|null>}
   */
  async measure(asset) {
    const url = `${assetFileUrl(asset.id)}?t=${asset.addedAt ?? ''}`;
    if (asset.kind === 'image') {
      const image = new Image();
      await new Promise((resolvePromise, reject) => {
        image.onload = () => resolvePromise(undefined);
        image.onerror = () => reject(new Error('The browser could not decode this image. It may be corrupt or in a format this browser does not support.'));
        image.src = url;
      });
      return { width: image.naturalWidth, height: image.naturalHeight, duration: 0 };
    }
    if (asset.kind === 'video') {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.src = url;
      try {
        await new Promise((resolvePromise, reject) => {
          const timer = setTimeout(() => reject(new Error('Timed out reading the video metadata.')), 20000);
          video.onloadedmetadata = () => {
            clearTimeout(timer);
            resolvePromise(undefined);
          };
          video.onerror = () => {
            clearTimeout(timer);
            reject(new Error('The browser could not decode this video. Try converting it to MP4 (H.264) or WebM.'));
          };
        });
        return { width: video.videoWidth, height: video.videoHeight, duration: Number.isFinite(video.duration) ? video.duration : 0 };
      } finally {
        video.removeAttribute('src');
        video.load();
      }
    }
    return null;
  }

  /**
   * @param {AssetMeta} asset
   */
  async ensureThumbnail(asset) {
    if (asset.hasPreview) return;
    const element = await this.load(asset.id);
    if (!element?.element) return;
    const canvas = this.scratchCanvas(400, 400);
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 400, 400);
    const source = element.element;
    const sourceWidth = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
    const sourceHeight = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
    if (!sourceWidth || !sourceHeight) return;
    const scale = Math.min(400 / sourceWidth, 400 / sourceHeight);
    const width = sourceWidth * scale;
    const height = sourceHeight * scale;
    ctx.drawImage(source, (400 - width) / 2, (400 - height) / 2, width, height);
    const blob = await new Promise((resolvePromise) => canvas.toBlob((value) => resolvePromise(value), 'image/jpeg', 0.82));
    if (!blob) return;
    try {
      await api.uploadPreview(asset.id, blob, sourceWidth, sourceHeight);
      asset.hasPreview = true;
    } catch {
      /* thumbnails are a convenience */
    }
  }

  /* ------------------------------------------------------------ loading */

  /**
   * @param {string} assetId
   * @returns {Promise<LoadedAsset|null>}
   */
  async load(assetId) {
    const existing = this.loaded.get(assetId);
    if (existing) return existing;
    const pending = this.loading.get(assetId);
    if (pending) return pending;

    const job = (async () => {
      const meta = this.store.doc.assets.find((asset) => asset.id === assetId) ?? this.store.assets.get(assetId);
      if (!meta) return null;
      const url = `${assetFileUrl(assetId)}?v=${encodeURIComponent(meta.addedAt ?? '')}`;
      try {
        if (meta.kind === 'image') {
          const image = new Image();
          image.crossOrigin = 'anonymous';
          await new Promise((resolvePromise, reject) => {
            image.onload = () => resolvePromise(undefined);
            image.onerror = () => reject(new Error('decode failed'));
            image.src = url;
          });
          const loaded = { meta, element: image };
          this.loaded.set(assetId, loaded);
          return loaded;
        }
        if (meta.kind === 'video') {
          const video = document.createElement('video');
          video.preload = 'auto';
          video.muted = true;
          video.playsInline = true;
          video.crossOrigin = 'anonymous';
          video.src = url;
          await new Promise((resolvePromise, reject) => {
            const timer = setTimeout(() => reject(new Error('metadata timeout')), 25000);
            video.onloadeddata = () => {
              clearTimeout(timer);
              resolvePromise(undefined);
            };
            video.onerror = () => {
              clearTimeout(timer);
              reject(new Error('decode failed'));
            };
          });
          const loaded = { meta, element: video };
          this.loaded.set(assetId, loaded);
          return loaded;
        }
      } catch {
        meta.status = 'unsupported';
        meta.statusDetail = `This browser could not decode "${meta.fileName}". Re-encode it as ${meta.kind === 'video' ? 'MP4 (H.264) or WebM' : 'PNG or JPEG'} and use Replace file.`;
        this.store.registerAsset(meta);
        return null;
      }
      return null;
    })();

    this.loading.set(assetId, job);
    try {
      return await job;
    } finally {
      this.loading.delete(assetId);
    }
  }

  /**
   * Preload every asset the document references, reporting progress.
   * @param {(done:number, total:number, name:string)=>void} [onProgress]
   * @returns {Promise<void>}
   */
  async preloadDocument(onProgress) {
    const ids = new Set();
    for (const clip of this.store.doc.clips) if (clip.assetId) ids.add(clip.assetId);
    for (const asset of this.store.doc.assets) if (asset.kind === 'image' || asset.kind === 'video') ids.add(asset.id);
    const list = [...ids];
    let done = 0;
    for (const id of list) {
      const meta = this.store.doc.assets.find((asset) => asset.id === id);
      onProgress?.(done, list.length, meta?.name ?? id);
      await this.load(id);
      done += 1;
    }
    onProgress?.(list.length, list.length, '');
  }

  /* ------------------------------------------------------------ frame source */

  /**
   * The renderer's view of the media library.
   * @returns {import('/core/render.js').FrameSource}
   */
  createFrameSource() {
    const engine = this;
    return {
      /**
       * @param {string} assetId
       */
      size(assetId) {
        const meta = engine.store.doc.assets.find((asset) => asset.id === assetId);
        const loaded = engine.loaded.get(assetId);
        if (loaded?.element instanceof HTMLVideoElement) {
          return {
            width: loaded.element.videoWidth || meta?.width || 1,
            height: loaded.element.videoHeight || meta?.height || 1,
          };
        }
        if (loaded?.element instanceof HTMLImageElement) {
          return {
            width: loaded.element.naturalWidth || meta?.width || 1,
            height: loaded.element.naturalHeight || meta?.height || 1,
          };
        }
        if (meta?.width && meta?.height) return { width: meta.width, height: meta.height };
        return null;
      },

      /**
       * Returns the picture at `sourceTime`. While the preview plays, the video
       * element plays along and is only re-seeked when it drifts; when it is
       * paused or scrubbed, the exact frame is sought and drawn once the seek
       * lands. Until then the last decoded frame stays on screen, never nothing.
       * (Exports do not use this: they render pre-extracted frames.)
       * @param {string} assetId
       * @param {number} sourceTime
       */
      frame(assetId, sourceTime) {
        const loaded = engine.loaded.get(assetId);
        if (!loaded?.element) {
          // Kick off the load; the next render pass will have it.
          engine.load(assetId).then(() => engine.requestRender?.());
          return null;
        }
        if (loaded.element instanceof HTMLVideoElement) {
          const video = loaded.element;
          const target = Math.max(0, Math.min(Math.max(0, (video.duration || 0) - 1e-3), sourceTime));
          const playing = Boolean(engine.store.playback?.playing);
          if (playing) {
            const rate = engine.store.playback.rate || 1;
            if (video.playbackRate !== rate) video.playbackRate = rate;
            if (video.paused) video.play().catch(() => { /* drift seeks below still keep it moving */ });
          } else if (!video.paused) {
            video.pause();
          }
          if (Math.abs(video.currentTime - target) > (playing ? PLAYBACK_DRIFT : 1e-3)) {
            if (video.readyState >= 2 && !video.seeking && video.videoWidth > 0) rememberFrame(video);
            if (!playing) engine.pendingSeeks.set(assetId, target);
            try {
              video.currentTime = target;
            } catch {
              /* seeking before metadata is ready */
            }
            video.addEventListener('seeked', () => engine.requestRender?.(), { once: true });
            return lastFrames.get(video) ?? (video.readyState >= 2 ? video : null);
          }
          if (video.readyState < 2) return lastFrames.get(video) ?? null;
          return video;
        }
        return loaded.element;
      },
    };
  }

  /**
   * Wait for every queued video seek to complete. The preview loop calls this
   * before drawing so a frame never mixes stale and fresh video.
   * @returns {Promise<void>}
   */
  async settleSeeks() {
    const entries = [...this.pendingSeeks.entries()];
    if (entries.length === 0) return;
    this.pendingSeeks.clear();
    await Promise.all(entries.map(([assetId, time]) => new Promise((resolvePromise) => {
      const loaded = this.loaded.get(assetId);
      const video = loaded?.element;
      if (!(video instanceof HTMLVideoElement)) {
        resolvePromise(undefined);
        return;
      }
      const timer = setTimeout(() => {
        video.removeEventListener('seeked', onSeeked);
        resolvePromise(undefined);
      }, 2000);
      const onSeeked = () => {
        clearTimeout(timer);
        video.removeEventListener('seeked', onSeeked);
        resolvePromise(undefined);
      };
      video.addEventListener('seeked', onSeeked);
      if (Math.abs(video.currentTime - time) < 1e-3) {
        onSeeked();
      } else {
        try {
          video.currentTime = time;
        } catch {
          onSeeked();
        }
      }
    })));
  }

  /* ------------------------------------------------------------ audio */

  /**
   * Decode an audio asset, analyse it, and (once) upload the decoded samples so
   * the server-side mixdown uses exactly the samples the analysis saw.
   * @param {string} assetId
   * @param {(stage:string, progress:number)=>void} [onProgress]
   * @returns {Promise<any>}
   */
  async ensureAnalysis(assetId, onProgress) {
    if (this.store.doc.audio[assetId]) return this.store.doc.audio[assetId];
    const existing = this.analyseJobs.get(assetId);
    if (existing) return existing;

    const job = (async () => {
      try {
        onProgress?.('Downloading audio', 0.05);
        const response = await fetch(`${assetAudioUrl(assetId)}`);
        if (!response.ok) throw new Error('The server could not provide this audio file.');
        const arrayBuffer = await response.arrayBuffer();

        onProgress?.('Decoding', 0.2);
        const context = new (window.AudioContext || /** @type {any} */ (window).webkitAudioContext)();
        const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
        await context.close();

        onProgress?.('Analysing', 0.5);
        const channels = [];
        for (let index = 0; index < decoded.numberOfChannels; index += 1) channels.push(decoded.getChannelData(index));
        // Yield once so the progress paint lands before the (synchronous) analysis.
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
        const result = analyzeAudio(
          { channels, sampleRate: decoded.sampleRate, duration: decoded.duration },
          { sampleRate: 22050 },
        );

        onProgress?.('Storing', 0.85);
        const stored = storeAnalysis(this.store.doc, assetId, result);
        this.audioBuffers.set(assetId, { channels, sampleRate: decoded.sampleRate, duration: decoded.duration });

        // Hand the PCM to the server once, so export mixing matches the analysis.
        try {
          const wav = encodeWav(channels, decoded.sampleRate);
          await api.uploadSamples(assetId, wav);
        } catch {
          /* the server can still decode the original with ffmpeg */
        }

        const assetName = this.store.assets.get(assetId)?.name ?? this.store.doc.assets.find((asset) => asset.id === assetId)?.name ?? assetId;
        this.store.notify('ok', `"${assetName}" analysed: ${result.onsets.length} onsets, ${result.tempo || '—'} BPM${result.tempoConfidence < 0.35 ? ' (low confidence — treat the markers as suggestions)' : ''}`, { title: 'Audio ready' });
        this.store.invalidateMappings();
        this.store.markDirty();
        return stored;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.notify('error', `Audio analysis failed: ${message}`, { title: 'Analysis' });
        throw error;
      } finally {
        this.analyseJobs.delete(assetId);
      }
    })();

    this.analyseJobs.set(assetId, job);
    return job;
  }

  /**
   * @param {string} assetId
   * @returns {{channels:Float32Array[], sampleRate:number, duration:number}|undefined}
   */
  audioBuffer(assetId) {
    return this.audioBuffers.get(assetId);
  }

  /* ------------------------------------------------------------ helpers */

  /**
   * @param {number} width
   * @param {number} height
   * @returns {HTMLCanvasElement}
   */
  scratchCanvas(width, height) {
    if (!this.scratch) this.scratch = document.createElement('canvas');
    this.scratch.width = Math.max(1, Math.round(width));
    this.scratch.height = Math.max(1, Math.round(height));
    return this.scratch;
  }

  /**
   * A JPEG thumbnail of an asset for library tiles that the server could not
   * generate (procedural assets, unsupported containers).
   * @param {AssetMeta} asset
   * @param {number} size
   * @returns {Promise<string|null>}
   */
  async thumbnailDataUrl(asset, size = 200) {
    const loaded = await this.load(asset.id);
    if (!loaded?.element) return null;
    const canvas = this.scratchCanvas(size, size * 0.625);
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    ctx.fillStyle = '#08080c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const source = loaded.element;
    const sourceWidth = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
    const sourceHeight = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
    if (!sourceWidth || !sourceHeight) return null;
    const scale = Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight);
    const width = sourceWidth * scale;
    const height = sourceHeight * scale;
    ctx.drawImage(source, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    try {
      return canvas.toDataURL('image/jpeg', 0.8);
    } catch {
      return null;
    }
  }

  /**
   * Release every decoded element (used when switching projects).
   */
  releaseAll() {
    for (const loaded of this.loaded.values()) {
      if (loaded.element instanceof HTMLVideoElement) {
        loaded.element.pause();
        loaded.element.removeAttribute('src');
        loaded.element.load();
      }
    }
    this.loaded.clear();
    this.loading.clear();
    this.audioBuffers.clear();
    this.pendingSeeks.clear();
  }

  /** @type {Map<string, number>} */
  pendingSeeks = new Map();

  /** @type {(()=>void)|null} */
  requestRender = null;
}

/**
 * Encode planar float channels as a 16-bit PCM WAV.
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @returns {Blob}
 */
export function encodeWav(channels, sampleRate) {
  const frames = channels[0]?.length ?? 0;
  const channelCount = Math.min(2, channels.length);
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel][frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export { assetFrameUrl, assetPreviewUrl, assetFileUrl, assetAudioUrl };
