/**
 * The live audio monitor.
 *
 * A compact widget rather than a panel full of controls: four labelled bars for
 * level / low / mid / high, a number per band, and a six-second history strip,
 * so you can see whether a signal is actually moving before you connect it to
 * something.
 *
 * Two sources feed it, and they are the *same* signals the audio connections
 * read:
 *
 *  - while the transport runs, the post-gain spectrum of the live mix
 *    (`AudioEngine.spectrum()`), and
 *  - while it is paused, `sampleEnvelope()` over the stored analysis at the
 *    playhead, averaged across every analysed audio asset -- which is exactly
 *    how `rawSignal()` reads a source.
 *
 * That is why a paused monitor still moves when you scrub: the numbers it shows
 * are the numbers the renderer will use.
 */

import { button, el, fitCanvas } from './dom.js';
import { BAND_CHOICES, sampleEnvelope } from '/core/audio.js';
import { clamp01, formatNumber } from '/core/math.js';

/** The history strip shows this many samples -- 6 seconds at 30 Hz. */
const HISTORY_SAMPLES = 180;
const SAMPLE_INTERVAL = 1000 / 30;
const STRIP_HEIGHT = 56;

/** The four bands a meter can show, in display order, with their CSS modifier. */
const BANDS = Object.freeze(
  BAND_CHOICES
    .filter((choice) => ['level', 'low', 'mid', 'high'].includes(choice.value))
    .map((choice) => ({
      id: choice.value,
      label: choice.value === 'level' ? 'lvl' : choice.value,
      title: choice.label,
      modifier: choice.value === 'level' ? '' : ` meter__fill--${choice.value}`,
      color: choice.value === 'level' ? '#7cf59a'
        : choice.value === 'low' ? '#ff3d8b'
          : choice.value === 'mid' ? '#ffc857'
            : '#5ce1ff',
    })),
);

/**
 * Build the audio monitor widget.
 *
 * The caller mounts `root` wherever it likes and owns the loop: `start()` runs
 * a single animation frame loop (60 Hz while playing, throttled to 30 Hz for
 * the offline analysis so a paused editor costs almost nothing), `stop()`
 * cancels it, and `refresh()` repaints once -- handy after the document, the
 * analysis or the playhead changed.
 *
 * @param {object} options
 * @param {any} options.store The editor store (document, playhead, notices).
 * @param {any} options.audio The `AudioEngine` to meter while playing.
 * @param {any} options.media The `MediaEngine`, used to analyse an asset the
 *   project has not analysed yet.
 * @returns {{root:HTMLElement, start:()=>void, stop:()=>void, refresh:()=>void}}
 */
export function buildAudioMonitor({ store, audio, media }) {
  /* ------------------------------------------------------------ elements */

  /** @type {Map<string, HTMLElement>} */
  const fills = new Map();
  /** @type {Map<string, HTMLElement>} */
  const readouts = new Map();

  const stateDot = el('span', { class: 'badge-dot badge-dot--idle' });
  const stateLabel = el('span', { class: 'muted grow', text: 'Analysis at the playhead' });

  /** @type {string|null} */
  let pendingAssetId = null;
  const analyseButton = button('Analyse', 'btn btn--tiny', {
    title: 'Analyse an audio asset so the monitor and the audio connections can read it',
    onclick: () => {
      if (!pendingAssetId || typeof media?.ensureAnalysis !== 'function') return;
      const assetId = pendingAssetId;
      analyseButton.disabled = true;
      Promise.resolve(media.ensureAnalysis(assetId))
        .then(() => {
          analyseButton.disabled = false;
          refresh();
        })
        .catch(() => {
          analyseButton.disabled = false;
        });
    },
  });
  analyseButton.classList.add('hidden');

  const head = el('div', { class: 'row' }, [stateDot, stateLabel, analyseButton]);

  const meters = el('div', { class: 'row row--wrap' }, BANDS.map((band) => {
    const fill = el('div', { class: `meter__fill${band.modifier}`, title: band.title });
    const readout = el('span', { class: 'stat-chip', text: '0' });
    fills.set(band.id, fill);
    readouts.set(band.id, readout);
    return el('div', { class: 'row', title: `${band.title} — the raw signal an audio connection reads` }, [
      el('span', { class: 'meter__label', text: band.label }),
      el('div', { class: 'meter' }, [el('div', { class: 'meter__bar' }, [fill])]),
      readout,
    ]);
  }));

  const canvas = /** @type {HTMLCanvasElement} */ (el('canvas', { class: 'mapping-canvas' }));

  const root = el('div', {
    title: 'Level, low, mid and high — the same signals the audio connections read. Playing: the live post-gain output. Paused: the stored analysis sampled at the playhead.',
  }, [head, meters, canvas]);

  /* ------------------------------------------------------------- history */

  const history = BANDS.map(() => new Float32Array(HISTORY_SAMPLES));
  let historyIndex = 0;
  let historyFilled = 0;

  /**
   * @param {number[]} values One 0..1 value per band.
   */
  function pushHistory(values) {
    for (let index = 0; index < history.length; index += 1) {
      history[index][historyIndex] = clamp01(values[index] ?? 0);
    }
    historyIndex = (historyIndex + 1) % HISTORY_SAMPLES;
    historyFilled = Math.min(HISTORY_SAMPLES, historyFilled + 1);
  }

  /* ------------------------------------------------------------- sampling */

  /**
   * The live output spectrum.
   * @returns {number[]}
   */
  function sampleLive() {
    const spectrum = audio.spectrum() ?? {};
    return BANDS.map((band) => clamp01(Number(spectrum[band.id]) || 0));
  }

  /**
   * The stored analysis at the playhead, averaged across every analysed audio
   * asset in the project. This mirrors `rawSignal()`'s envelope read.
   * @returns {number[]}
   */
  function sampleOffline() {
    const doc = store.doc;
    const time = store.playback.time;
    const offset = doc.audioSettings?.offset ?? 0;
    const values = BANDS.map(() => 0);
    let counted = 0;
    for (const assetId of Object.keys(doc.audio ?? {})) {
      const analysis = doc.audio[assetId];
      if (!analysis) continue;
      counted += 1;
      BANDS.forEach((band, index) => {
        values[index] += sampleEnvelope(analysis, /** @type {any} */ (band.id), time, offset);
      });
    }
    if (counted > 0) {
      for (let index = 0; index < values.length; index += 1) values[index] = clamp01(values[index] / counted);
    }
    return values;
  }

  /* -------------------------------------------------------------- drawing */

  /**
   * @param {number[]} values
   */
  function paintValues(values) {
    BANDS.forEach((band, index) => {
      const value = clamp01(values[index] ?? 0);
      const fill = fills.get(band.id);
      const readout = readouts.get(band.id);
      if (fill) fill.style.width = `${Math.round(value * 100)}%`;
      if (readout) readout.textContent = formatNumber(value, 2);
    });
  }

  function drawStrip() {
    const ctx = fitCanvas(canvas, root, STRIP_HEIGHT);
    const width = Math.max(40, canvas.getBoundingClientRect().width);
    const height = STRIP_HEIGHT;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#08080c';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = '#1c1c28';
    ctx.lineWidth = 1;
    for (let step = 1; step < 4; step += 1) {
      const y = Math.round((step / 4) * height) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const columns = Math.max(2, historyFilled);
    BANDS.forEach((band, bandIndex) => {
      ctx.strokeStyle = band.color;
      ctx.lineWidth = 1.3;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let column = 0; column < columns; column += 1) {
        const slot = (historyIndex - columns + column + HISTORY_SAMPLES * 2) % HISTORY_SAMPLES;
        const value = history[bandIndex][slot];
        const x = (column / (columns - 1)) * width;
        const y = height - 3 - clamp01(value) * (height - 8);
        if (column === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });

    ctx.fillStyle = '#5d6076';
    ctx.font = '9px ui-monospace, "Cascadia Mono", Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${(HISTORY_SAMPLES / 30).toFixed(0)} s`, 4, 3);
    ctx.textAlign = 'right';
    ctx.fillText('now', width - 4, 3);
  }

  /* --------------------------------------------------------------- state */

  /** @type {boolean|null} */
  let liveState = null;

  /**
   * @param {boolean} live
   */
  function updateHead(live) {
    if (live === liveState) return;
    liveState = live;
    stateDot.className = `badge-dot badge-dot--${live ? 'ok' : 'idle'}`;
    stateLabel.textContent = live ? 'Live output' : 'Analysis at the playhead';
  }

  function updateAnalyseButton() {
    const missing = (store.doc.assets ?? []).find((/** @type {any} */ asset) => asset.kind === 'audio' && !store.doc.audio?.[asset.id]);
    pendingAssetId = missing?.id ?? null;
    analyseButton.classList.toggle('hidden', !missing);
    if (missing) {
      analyseButton.textContent = `Analyse ${missing.name}`;
      analyseButton.title = `Analyse "${missing.name}" so the monitor and the audio connections can read it`;
    }
  }

  /* ------------------------------------------------------------- the loop */

  let running = false;
  let rafId = 0;
  let lastSampleAt = 0;
  let lastOfflineAt = 0;

  function tick() {
    if (!running) {
      rafId = 0;
      return;
    }
    rafId = requestAnimationFrame(tick);
    const now = performance.now();

    if (audio.playing) {
      const values = sampleLive();
      updateHead(true);
      paintValues(values);
      if (now - lastSampleAt >= SAMPLE_INTERVAL) {
        lastSampleAt = now;
        pushHistory(values);
        drawStrip();
      }
      return;
    }

    // Offline: the analysis only changes when the playhead moves, so 30 Hz is
    // plenty -- and it keeps a paused editor from burning a frame per rAF.
    if (now - lastOfflineAt < SAMPLE_INTERVAL) return;
    lastOfflineAt = now;
    lastSampleAt = now;
    const values = sampleOffline();
    updateHead(false);
    paintValues(values);
    pushHistory(values);
    drawStrip();
  }

  /**
   * Sample once and repaint everything.
   * @returns {void}
   */
  function refresh() {
    updateAnalyseButton();
    const live = Boolean(audio.playing);
    const values = live ? sampleLive() : sampleOffline();
    updateHead(live);
    paintValues(values);
    pushHistory(values);
    drawStrip();
  }

  /**
   * Start following the audio (one loop, no matter how often this is called).
   * @returns {void}
   */
  function start() {
    if (running) return;
    running = true;
    refresh();
    lastOfflineAt = 0;
    lastSampleAt = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  /**
   * Stop the loop. The widget keeps its last painted state.
   * @returns {void}
   */
  function stop() {
    running = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  return { root, start, stop, refresh };
}
