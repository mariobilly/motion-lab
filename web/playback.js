/**
 * Audio playback for the timeline.
 *
 * One `AudioBufferSourceNode` per audio clip, each scheduled against the
 * `AudioContext` clock with its own gain envelope (clip volume, fades, track
 * gain, mute/solo). The audio clock is the master during playback, so a heavy
 * frame can never push the sound out of sync -- the picture skips a frame
 * instead, which is what the dropped-frame counter reports.
 *
 * The soundtrack is mixed *here*, live, rather than pre-rendered, so moving a
 * clip is audible immediately without re-rendering anything.
 */

/**
 * @typedef {object} AudioClipPlan
 * @property {string} id
 * @property {string} assetId
 * @property {number} start
 * @property {number} duration
 * @property {number} inPoint
 * @property {number} volume
 * @property {number} pan
 * @property {number} fadeIn
 * @property {number} fadeOut
 */

export class AudioEngine {
  /**
   * @param {() => number} getMasterGain
   */
  constructor(getMasterGain) {
    this.getMasterGain = getMasterGain;
    /** @type {AudioContext|null} */
    this.context = null;
    /** @type {GainNode|null} */
    this.master = null;
    /** @type {AudioBufferSourceNode[]} */
    this.active = [];
    /** @type {Map<string, AudioBuffer>} */
    this.buffers = new Map();
    this.playing = false;
    this.startedAt = 0;
    this.startOffset = 0;
    this.muted = false;
    /** @type {AudioClipPlan[]} */
    this.plan = [];
    /** @type {Map<string, {left:Float32Array,right:Float32Array,sampleRate:number}>} */
    this.sources = new Map();
    /** @type {AnalyserNode|null} */
    this.analyser = null;
    /** @type {Uint8Array|null} */
    this.analyserData = null;
  }

  /**
   * Lazily create the context -- browsers require a gesture before audio starts,
   * and creating it early just logs a warning.
   * @returns {AudioContext}
   */
  ensureContext() {
    if (!this.context) {
      const Ctor = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
      this.context = new Ctor({ latencyHint: 'interactive' });
      this.master = this.context.createGain();
      this.master.gain.value = this.muted ? 0 : this.getMasterGain();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyserData = new Uint8Array(this.analyser.frequencyBinCount);
      this.master.connect(this.analyser);
      this.analyser.connect(this.context.destination);
    }
    return this.context;
  }

  /**
   * Register decoded audio for an asset.
   * @param {string} assetId
   * @param {{channels:Float32Array[], sampleRate:number, duration:number}} decoded
   */
  setSource(assetId, decoded) {
    this.sources.set(assetId, {
      left: decoded.channels[0] ?? new Float32Array(0),
      right: decoded.channels[1] ?? decoded.channels[0] ?? new Float32Array(0),
      sampleRate: decoded.sampleRate,
    });
  }

  /**
   * @param {string} assetId
   * @param {{channels:Float32Array[], sampleRate:number, duration:number}} decoded
   * @returns {AudioBuffer}
   */
  toAudioBuffer(assetId, decoded) {
    const cached = this.buffers.get(assetId);
    if (cached) return cached;
    const context = this.ensureContext();
    const frames = decoded.channels[0]?.length ?? 0;
    const buffer = context.createBuffer(Math.max(1, Math.min(2, decoded.channels.length)), Math.max(1, frames), decoded.sampleRate);
    for (let channel = 0; channel < Math.min(2, decoded.channels.length); channel += 1) {
      buffer.copyToChannel(decoded.channels[channel], channel);
    }
    this.buffers.set(assetId, buffer);
    return buffer;
  }

  /**
   * Replace the schedule. Called whenever the timeline changes.
   * @param {AudioClipPlan[]} plan
   */
  setPlan(plan) {
    this.plan = plan;
    if (this.playing) {
      // Re-schedule from the current position so an edit is heard immediately.
      const at = this.currentTime();
      this.stop();
      this.play(at);
    }
  }

  /**
   * @param {number} time
   */
  play(time) {
    const context = this.ensureContext();
    if (context.state === 'suspended') context.resume();
    this.stopNodes();
    this.playing = true;
    this.startedAt = context.currentTime;
    this.startOffset = time;
    const master = /** @type {GainNode} */ (this.master);
    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.setValueAtTime(this.muted ? 0 : this.getMasterGain(), context.currentTime);

    for (const clip of this.plan) {
      if (!clip.assetId) continue;
      const buffer = this.buffers.get(clip.assetId);
      if (!buffer) continue;
      const clipEnd = clip.start + clip.duration;
      if (clipEnd <= time) continue;

      const when = context.currentTime + Math.max(0, clip.start - time);
      const offset = clip.inPoint + Math.max(0, time - clip.start);
      const duration = Math.min(clip.duration - Math.max(0, time - clip.start), buffer.duration - offset);
      if (duration <= 0.001) continue;

      const source = context.createBufferSource();
      source.buffer = buffer;
      const gain = context.createGain();
      const panner = context.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, clip.pan ?? 0));
      source.connect(gain);
      gain.connect(panner);
      panner.connect(master);

      const volume = clip.volume ?? 1;
      // Volume envelope: clip gain, then fades relative to the clip's own start.
      const localStart = Math.max(0, time - clip.start);
      gain.gain.cancelScheduledValues(0);
      if (clip.fadeIn > 0 && localStart < clip.fadeIn) {
        const remaining = clip.fadeIn - localStart;
        gain.gain.setValueAtTime(volume * (localStart / clip.fadeIn), when);
        gain.gain.linearRampToValueAtTime(volume, when + remaining);
      } else {
        gain.gain.setValueAtTime(volume, when);
      }
      if (clip.fadeOut > 0) {
        const fadeStart = clip.start + clip.duration - clip.fadeOut;
        if (fadeStart > time) {
          gain.gain.setValueAtTime(volume, context.currentTime + (fadeStart - time));
          gain.gain.linearRampToValueAtTime(0, context.currentTime + (clipEnd - time));
        } else {
          const progress = (time - fadeStart) / clip.fadeOut;
          gain.gain.setValueAtTime(volume * Math.max(0, 1 - progress), when);
          gain.gain.linearRampToValueAtTime(0, context.currentTime + (clipEnd - time));
        }
      }

      try {
        source.start(when, Math.max(0, offset), Math.max(0.001, duration));
        this.active.push(source);
      } catch {
        /* a clip that cannot be scheduled is simply silent */
      }
    }
  }

  stop() {
    this.stopNodes();
    this.playing = false;
  }

  stopNodes() {
    for (const source of this.active) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.active = [];
  }

  /**
   * The timeline position implied by the audio clock -- authoritative during
   * playback.
   * @returns {number}
   */
  currentTime() {
    if (!this.context || !this.playing) return this.startOffset;
    return this.startOffset + (this.context.currentTime - this.startedAt);
  }

  /**
   * @param {boolean} muted
   */
  setMuted(muted) {
    this.muted = muted;
    if (this.master && this.context) {
      this.master.gain.cancelScheduledValues(this.context.currentTime);
      this.master.gain.setValueAtTime(muted ? 0 : this.getMasterGain(), this.context.currentTime);
    }
  }

  /**
   * @param {number} gain
   */
  setMasterGain(gain) {
    if (this.master && this.context && !this.muted) {
      this.master.gain.cancelScheduledValues(this.context.currentTime);
      this.master.gain.setTargetAtTime(gain, this.context.currentTime, 0.02);
    }
  }

  /**
   * Post-gain spectrum for the level meters.
   * @returns {{level:number, low:number, mid:number, high:number}}
   */
  spectrum() {
    if (!this.analyser || !this.analyserData) return { level: 0, low: 0, mid: 0, high: 0 };
    this.analyser.getByteFrequencyData(/** @type {any} */ (this.analyserData));
    const data = this.analyserData;
    const bins = data.length;
    let peak = 0;
    let low = 0;
    let mid = 0;
    let high = 0;
    const lowEnd = Math.floor(bins * 0.08);
    const midEnd = Math.floor(bins * 0.45);
    for (let index = 0; index < bins; index += 1) {
      const value = data[index] / 255;
      if (value > peak) peak = value;
      if (index < lowEnd) low += value;
      else if (index < midEnd) mid += value;
      else high += value;
    }
    return {
      level: peak,
      low: Math.min(1, low / Math.max(1, lowEnd)),
      mid: Math.min(1, mid / Math.max(1, midEnd - lowEnd)),
      high: Math.min(1, high / Math.max(1, bins - midEnd)),
    };
  }

  /**
   * Duck the soundtrack so a UI sound or the user's own reference can be heard.
   * @param {number} factor
   */
  duck(factor) {
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.getMasterGain() * factor, this.context.currentTime, 0.05);
    }
  }
}
