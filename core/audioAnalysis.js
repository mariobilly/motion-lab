/**
 * Audio analysis.
 *
 * Turns a decoded audio buffer into the signals the rest of the app consumes:
 * waveform peaks for drawing, an amplitude envelope, low/mid/high band energy,
 * spectral-flux onsets and *suggested* beat markers.
 *
 * Two properties matter more than sophistication here:
 *
 *  1. **Determinism.** Given the same samples this produces the same arrays, so
 *     a preview and an export driven by the same project react identically.
 *  2. **Honesty about beats.** Onset detection finds energy jumps, not musical
 *     beats. Tempo is only reported when the autocorrelation peak is clearly
 *     better than the alternatives, and every marker is presented as a
 *     *suggestion* the user can delete or add to.
 */

import { clamp01 } from './math.js';

/**
 * @typedef {object} AnalysisOptions
 * @property {number} [sampleRate]  Target analysis rate (samples are resampled).
 * @property {number} [fftSize]     Power of two, default 1024.
 * @property {number} [hop]         Hop in samples, default fftSize / 4.
 * @property {number} [waveformBuckets] Peaks stored for drawing.
 */

/**
 * Iterative in-place radix-2 FFT.
 * @param {Float32Array} real
 * @param {Float32Array} imag
 * @returns {void}
 */
function fft(real, imag) {
  const n = real.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i]; real[i] = real[j]; real[j] = tr;
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curReal = 1;
      let curImag = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const uReal = real[i + k];
        const uImag = imag[i + k];
        const vReal = real[i + k + len / 2] * curReal - imag[i + k + len / 2] * curImag;
        const vImag = real[i + k + len / 2] * curImag + imag[i + k + len / 2] * curReal;
        real[i + k] = uReal + vReal;
        imag[i + k] = uImag + vImag;
        real[i + k + len / 2] = uReal - vReal;
        imag[i + k + len / 2] = uImag - vImag;
        const nextReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = nextReal;
      }
    }
  }
}

/**
 * Average a multi-channel buffer into mono.
 * @param {Float32Array[]} channels
 * @param {number} length
 * @returns {Float32Array}
 */
export function toMono(channels, length) {
  const mono = new Float32Array(length);
  if (channels.length === 0) return mono;
  for (const channel of channels) {
    const count = Math.min(length, channel.length);
    for (let i = 0; i < count; i += 1) mono[i] += channel[i];
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < length; i += 1) mono[i] *= scale;
  return mono;
}

/**
 * Linear-interpolated resample of a mono buffer.
 * @param {Float32Array} mono
 * @param {number} sourceRate
 * @param {number} targetRate
 * @returns {Float32Array}
 */
export function resampleMono(mono, sourceRate, targetRate) {
  if (sourceRate === targetRate) return mono;
  const ratio = targetRate / sourceRate;
  const length = Math.max(1, Math.floor(mono.length * ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i / ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = mono[index] ?? 0;
    const b = mono[index + 1] ?? a;
    out[i] = a + (b - a) * fraction;
  }
  return out;
}

/**
 * Peak envelope for waveform drawing.
 * @param {Float32Array} mono
 * @param {number} buckets
 * @returns {number[]} interleaved min/max pairs, normalised to -1..1
 */
export function waveformPeaks(mono, buckets) {
  const count = Math.max(1, Math.floor(buckets));
  const peaks = new Array(count * 2);
  const per = mono.length / count;
  for (let b = 0; b < count; b += 1) {
    const start = Math.floor(b * per);
    const end = Math.min(mono.length, Math.max(start + 1, Math.floor((b + 1) * per)));
    let min = 0;
    let max = 0;
    for (let i = start; i < end; i += 1) {
      const value = mono[i];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    peaks[b * 2] = min;
    peaks[b * 2 + 1] = max;
  }
  return peaks;
}

/**
 * Normalise an array in place so its 98th percentile becomes 1.
 * @param {Float32Array} values
 * @returns {Float32Array}
 */
function normalizeEnvelope(values) {
  const sorted = Float32Array.from(values).sort();
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98));
  const peak = sorted[index] || 1;
  const scale = peak > 1e-6 ? 1 / peak : 0;
  for (let i = 0; i < values.length; i += 1) values[i] = clamp01(values[i] * scale);
  return values;
}

/**
 * Full analysis of a decoded audio buffer.
 *
 * @param {{channels: Float32Array[], sampleRate: number, duration: number}} buffer
 * @param {AnalysisOptions} [options]
 * @returns {{
 *   sampleRate: number, hop: number, duration: number,
 *   level: Float32Array, low: Float32Array, mid: Float32Array, high: Float32Array,
 *   onsets: number[], beats: number[], tempo: number, tempoConfidence: number,
 *   waveform: number[], frames: number, hopSeconds: number
 * }}
 */
export function analyzeAudio(buffer, options = {}) {
  const analysisRate = options.sampleRate ?? 22050;
  const fftSize = options.fftSize ?? 1024;
  const hop = options.hop ?? fftSize / 4;
  const waveformBuckets = options.waveformBuckets ?? 1600;

  const monoSource = toMono(buffer.channels, Math.max(1, Math.round(buffer.duration * buffer.sampleRate) || buffer.channels[0]?.length || 0));
  const mono = resampleMono(monoSource, buffer.sampleRate, analysisRate);
  const duration = mono.length / analysisRate;

  const waveform = waveformPeaks(mono, waveformBuckets);

  const frameCount = Math.max(1, Math.floor((mono.length - fftSize) / hop) + 1);
  const level = new Float32Array(frameCount);
  const low = new Float32Array(frameCount);
  const mid = new Float32Array(frameCount);
  const high = new Float32Array(frameCount);
  const flux = new Float32Array(frameCount);

  const window = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));

  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);
  const magnitude = new Float32Array(fftSize / 2);
  const previous = new Float32Array(fftSize / 2);

  // Band edges in Hz -> bin indices.
  const binOf = (/** @type {number} */ hz) => Math.max(1, Math.min(fftSize / 2 - 1, Math.round((hz / analysisRate) * fftSize)));
  const lowRange = [binOf(20), binOf(200)];
  const midRange = [binOf(200), binOf(2000)];
  const highRange = [binOf(2000), binOf(8000)];

  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * hop;
    let rms = 0;
    for (let i = 0; i < fftSize; i += 1) {
      const sample = mono[offset + i] ?? 0;
      rms += sample * sample;
      real[i] = sample * window[i];
      imag[i] = 0;
    }
    level[frame] = Math.sqrt(rms / fftSize);

    fft(real, imag);

    let lowSum = 0;
    let midSum = 0;
    let highSum = 0;
    let fluxSum = 0;
    for (let bin = 1; bin < fftSize / 2; bin += 1) {
      const magnitudeValue = Math.sqrt(real[bin] * real[bin] + imag[bin] * imag[bin]) / (fftSize / 2);
      magnitude[bin] = magnitudeValue;
      const difference = magnitudeValue - previous[bin];
      if (difference > 0) fluxSum += difference;
      if (bin >= lowRange[0] && bin < lowRange[1]) lowSum += magnitudeValue * magnitudeValue;
      else if (bin >= midRange[0] && bin < midRange[1]) midSum += magnitudeValue * magnitudeValue;
      else if (bin >= highRange[0] && bin < highRange[1]) highSum += magnitudeValue * magnitudeValue;
    }
    const binCount = fftSize / 2;
    low[frame] = Math.sqrt(lowSum / binCount);
    mid[frame] = Math.sqrt(midSum / binCount);
    high[frame] = Math.sqrt(highSum / binCount);
    flux[frame] = fluxSum;
    previous.set(magnitude.subarray(0, fftSize / 2));
  }

  normalizeEnvelope(level);
  normalizeEnvelope(low);
  normalizeEnvelope(mid);
  normalizeEnvelope(high);

  const hopSeconds = hop / analysisRate;
  const onsets = detectOnsets(flux, hopSeconds);
  const { beats, tempo, tempoConfidence } = suggestBeats(flux, hopSeconds, onsets);

  return {
    sampleRate: analysisRate,
    hop,
    hopSeconds,
    frames: frameCount,
    duration,
    level,
    low,
    mid,
    high,
    waveform,
    onsets,
    beats,
    tempo,
    tempoConfidence,
  };
}

/**
 * Spectral-flux onset detection: adaptive threshold over a local mean, with a
 * refractory period so one transient cannot produce a burst of onsets.
 *
 * @param {Float32Array} flux
 * @param {number} hopSeconds
 * @returns {number[]} onset times in seconds
 */
export function detectOnsets(flux, hopSeconds) {
  const count = flux.length;
  if (count < 8) return [];
  const meanWindow = Math.max(3, Math.round(0.35 / hopSeconds));
  const thresholdFactor = 1.55;
  const minimumGap = 0.09;
  /** @type {number[]} */
  const onsets = [];
  let lastTime = -Infinity;

  // Local mean via a running sum.
  let sum = 0;
  for (let i = 0; i < Math.min(count, meanWindow); i += 1) sum += flux[i];
  for (let i = 1; i < count - 1; i += 1) {
    const from = Math.max(0, i - meanWindow);
    const to = Math.min(count - 1, i + meanWindow);
    if (i - meanWindow - 1 >= 0) sum -= flux[i - meanWindow - 1];
    if (i + meanWindow < count) sum += flux[i + meanWindow];
    const localMean = sum / Math.max(1, to - from + 1);
    const isPeak = flux[i] > flux[i - 1] && flux[i] >= flux[i + 1];
    const time = i * hopSeconds;
    if (isPeak && flux[i] > localMean * thresholdFactor && time - lastTime >= minimumGap) {
      onsets.push(Math.round(time * 1000) / 1000);
      lastTime = time;
    }
  }
  return onsets;
}

/**
 * Suggest beat markers from the onset envelope.
 *
 * Uses autocorrelation of the flux signal to find a plausible period, then
 * phases a grid against the strongest onsets. Confidence is the ratio between
 * the winning period's correlation and the average correlation across the
 * plausible tempo range, so a flat, beatless signal reports low confidence and
 * the UI can say so instead of inventing a tempo.
 *
 * @param {Float32Array} flux
 * @param {number} hopSeconds
 * @param {number[]} onsets
 * @returns {{beats:number[], tempo:number, tempoConfidence:number}}
 */
export function suggestBeats(flux, hopSeconds, onsets) {
  const count = flux.length;
  if (count < 16 || onsets.length < 4) return { beats: [], tempo: 0, tempoConfidence: 0 };

  // Subtract the mean so autocorrelation measures periodicity, not level.
  let mean = 0;
  for (let i = 0; i < count; i += 1) mean += flux[i];
  mean /= count;
  const centered = new Float32Array(count);
  for (let i = 0; i < count; i += 1) centered[i] = flux[i] - mean;

  const minLag = Math.max(2, Math.round(0.30 / hopSeconds)); // 200 BPM
  const maxLag = Math.max(minLag + 1, Math.round(1.2 / hopSeconds)); // 50 BPM

  let bestLag = 0;
  let bestScore = 0;
  let scoreSum = 0;
  let scoreCount = 0;
  const scores = new Map();
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i + lag < count; i += 1) sum += centered[i] * centered[i + lag];
    const score = sum / (count - lag);
    scores.set(lag, score);
    scoreSum += score;
    scoreCount += 1;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (!bestLag || scoreCount === 0) return { beats: [], tempo: 0, tempoConfidence: 0 };

  const average = scoreSum / scoreCount;
  const confidence = average > 1e-9 ? Math.min(1, Math.max(0, (bestScore / average - 1) / 2.5)) : 0;

  // Refine the period by parabolic interpolation around the peak.
  const previous = scores.get(bestLag - 1) ?? bestScore;
  const next = scores.get(bestLag + 1) ?? bestScore;
  const denominator = previous - 2 * bestScore + next;
  const adjustment = Math.abs(denominator) > 1e-12 ? (0.5 * (previous - next)) / denominator : 0;
  const period = (bestLag + Math.max(-0.5, Math.min(0.5, adjustment))) * hopSeconds;
  if (!(period > 0.2 && period < 2)) return { beats: [], tempo: 0, tempoConfidence: 0 };

  // Phase the grid against the onset list: try every onset as the downbeat and
  // keep the phase that lands on the most onsets.
  let bestPhase = onsets[0];
  let bestHits = -1;
  for (const candidate of onsets) {
    let hits = 0;
    for (const onset of onsets) {
      const delta = Math.abs(((onset - candidate) % period + period * 1.5) % period - period / 2);
      if (period / 2 - delta < period * 0.18) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestPhase = candidate;
    }
  }

  const duration = count * hopSeconds;
  /** @type {number[]} */
  const beats = [];
  for (let time = bestPhase; time < duration; time += period) {
    beats.push(Math.round(time * 1000) / 1000);
    if (beats.length > 4000) break;
  }

  const tempo = Math.round(60 / period);
  return { beats, tempo, tempoConfidence: Math.round(confidence * 100) / 100 };
}

/**
 * Root-mean-square level of a sample range, for the live meter.
 * @param {Float32Array} mono
 * @param {number} startSample
 * @param {number} sampleCount
 * @returns {number}
 */
export function rmsOf(mono, startSample, sampleCount) {
  const start = Math.max(0, Math.floor(startSample));
  const end = Math.min(mono.length, start + Math.max(1, Math.floor(sampleCount)));
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += mono[i] * mono[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}
