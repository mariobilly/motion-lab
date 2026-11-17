/**
 * The export dialog.
 *
 * One panel covers all four export shapes the server supports:
 *
 *   video          an ffmpeg encode of the frames the harness renders
 *   png-sequence   a zip of one PNG per frame (plus the mixdown as a WAV)
 *   still          a single full-resolution PNG at the playhead
 *   package        the project document plus every media file it uses
 *
 * Two things are deliberate. First, availability is never guessed: the list of
 * formats comes from `/api/exports/formats`, which asks the local ffmpeg build
 * what it can actually encode, and an unavailable format is shown greyed out
 * with the reason rather than hidden -- so "why can't I export H.265?" has an
 * answer on screen. Second, an export job survives this dialog: the poller is
 * owned by the module, the job id is published on `store.session.exportJob` and
 * `store.emit('export')` fires on every tick, so the top bar keeps reporting
 * progress after the dialog is closed.
 *
 * Nothing here touches the document except the export range, and that goes
 * through `store.setRange()` so it is one undo step.
 */

import { validateProject } from '/core/document.js';
import { FPS_CHOICES, formatDuration, formatTimecode, snapToFrame } from '/core/schema.js';
import {
  button, el, emptyState, fitCanvas, hint, iconButton, ICONS, slider, textField,
} from './dom.js';

/** @typedef {import('/core/schema.js').ProjectDoc} ProjectDoc */
/** @typedef {import('../store.js').Store} Store */

/* ------------------------------------------------------------------ *
 * Format list
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} ExportChoice
 * @property {string} id            Format id from the server, or `still` / `package`.
 * @property {'video'|'png-sequence'|'still'|'package'} kind
 * @property {string} label
 * @property {string} extension
 * @property {string} note
 * @property {boolean} available
 * @property {string} reason        Why it is unavailable, in plain language.
 * @property {string} [encoder]     ffmpeg video encoder name.
 * @property {string} [muxer]
 */

/**
 * Turn the server's format list into dialog choices, adding the two exports that
 * do not depend on ffmpeg encoders and the sequence export if it is missing.
 *
 * @param {any[]} formats
 * @returns {ExportChoice[]}
 */
function toChoices(formats) {
  /** @type {ExportChoice[]} */
  const choices = [];
  for (const format of formats ?? []) {
    const sequence = format.id === 'png-sequence';
    choices.push({
      id: String(format.id),
      kind: sequence ? 'png-sequence' : 'video',
      label: String(format.label ?? format.id),
      extension: String(format.extension ?? ''),
      note: String(format.note ?? `${format.video ?? ''}${format.audio && format.audio !== 'none' ? ` + ${format.audio}` : ''}`),
      available: format.available !== false,
      reason: format.available === false ? 'not supported by the ffmpeg build on this machine' : '',
      encoder: format.video ? String(format.video) : undefined,
      muxer: format.muxer ? String(format.muxer) : undefined,
    });
  }
  if (!choices.some((choice) => choice.id === 'png-sequence')) {
    choices.push({
      id: 'png-sequence',
      kind: 'png-sequence',
      label: 'PNG image sequence',
      extension: 'zip',
      note: 'One PNG per frame, zipped',
      available: true,
      reason: '',
      encoder: 'png',
      muxer: 'image2',
    });
  }
  choices.push({
    id: 'still',
    kind: 'still',
    label: 'Still image (PNG)',
    extension: 'png',
    note: 'One frame at the playhead, full resolution',
    available: true,
    reason: '',
    encoder: 'png',
  });
  choices.push({
    id: 'package',
    kind: 'package',
    label: 'Project package',
    extension: 'zip',
    note: 'The project document plus every media file it uses',
    available: true,
    reason: '',
    encoder: '',
  });
  return choices;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** The resolution presets, matching the ones in project settings. */
const SIZE_PRESETS = Object.freeze([
  { id: 'landscape', label: 'Landscape', width: 1920, height: 1080 },
  { id: 'portrait', label: 'Portrait', width: 1080, height: 1920 },
  { id: 'square', label: 'Square', width: 1080, height: 1080 },
  { id: 'landscape-4k', label: '4K landscape', width: 3840, height: 2160 },
  { id: 'portrait-4k', label: 'Vertical 4K', width: 2160, height: 3840 },
]);

/**
 * @param {number} value
 * @returns {string}
 */
function formatNumber(value) {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampNumber(value, min, max) {
  const safe = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, safe));
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function safeStem(value) {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'motion-lab-export';
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * A numeric field in the app's `.field` shell; commits on blur and Enter.
 * @param {object} options
 * @returns {{root:HTMLElement, input:HTMLInputElement, set:(value:number)=>void, isFocused:()=>boolean}}
 */
function numberField(options) {
  let current = options.value;
  const input = el('input', {
    class: 'num-input',
    type: 'text',
    inputmode: 'decimal',
    value: formatNumber(current),
    title: options.title ?? options.label,
  });
  const commit = () => {
    const parsed = Number(String(input.value).replace(/[^0-9.eE+-]/g, ''));
    current = Number.isFinite(parsed) ? clampNumber(parsed, options.min, options.max) : current;
    input.value = formatNumber(current);
    options.onChange(current);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (event) => {
    if (/** @type {KeyboardEvent} */ (event).key === 'Enter') {
      event.preventDefault();
      commit();
      input.blur();
    }
  });
  const root = el('div', { class: 'field' }, [
    el('div', { class: 'field__label', text: options.label }),
    el('div', { class: 'field__control' }, [input]),
  ]);
  return {
    root,
    input,
    set: (value) => {
      current = value;
      if (document.activeElement !== input) input.value = formatNumber(value);
    },
    isFocused: () => document.activeElement === input,
  };
}

/**
 * @param {Array<[string, string]>} rows
 * @returns {HTMLElement}
 */
function kvList(rows) {
  return el('div', {}, rows.map(([key, value]) => el('div', { class: 'kv' }, [
    el('span', { class: 'kv__k', text: key }),
    el('span', { class: 'kv__v', text: value }),
  ])));
}

/**
 * A determinate progress row in the app's `.progress-list` style.
 * @param {string} name
 * @returns {{root:HTMLElement, set:(progress:number, state:string, name?:string)=>void}}
 */
function progressRow(name) {
  const label = el('div', { class: 'progress-row__name', text: name });
  const fill = el('div', { class: 'progress-row__fill', style: { width: '0%' } });
  const state = el('div', { class: 'progress-row__state', text: '' });
  const root = el('div', { class: 'progress-row' }, [
    label,
    el('div', { class: 'progress-row__bar' }, [fill]),
    state,
  ]);
  return {
    root,
    set: (progress, stateText, nameText) => {
      fill.style.width = `${Math.round(clampNumber(progress, 0, 1) * 100)}%`;
      state.textContent = stateText;
      if (nameText) label.textContent = nameText;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Job watching (module-level so a closed dialog keeps its export alive)
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} JobWatcher
 * @property {Set<(job:any)=>void>} listeners
 * @property {boolean} finished
 */

/** @type {Map<string, JobWatcher>} */
const watchers = new Map();

/**
 * Poll a job every 500 ms and publish it on the store, whatever the dialog is
 * doing. Several listeners can observe the same job; the loop stops itself once
 * the job settles.
 *
 * @param {Store} store
 * @param {import('../api.js').api} api
 * @param {string} jobId
 * @param {(job:any)=>void} listener
 * @returns {()=>void} stop listening (the job itself keeps running)
 */
function watchJob(store, api, jobId, listener) {
  let watcher = watchers.get(jobId);
  if (!watcher) {
    watcher = { listeners: new Set(), finished: false };
    watchers.set(jobId, watcher);
    const current = watcher;
    (async () => {
      for (;;) {
        /** @type {any} */
        let job;
        try {
          const response = await api.exportJob(jobId);
          job = response.job;
        } catch (error) {
          job = {
            id: jobId,
            status: 'failed',
            stage: 'Failed',
            progress: 0,
            framesDone: 0,
            framesTotal: 0,
            error: `The export job could not be read: ${describeError(error)}`,
            warnings: [],
          };
        }
        store.session.exportJob = job;
        store.emit('export');
        for (const entry of [...current.listeners]) {
          try {
            entry(job);
          } catch (error) {
            console.error('[motion-lab] export listener failed', error);
          }
        }
        if (['done', 'failed', 'cancelled'].includes(job.status)) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      }
      current.finished = true;
    })();
  }
  watcher.listeners.add(listener);
  return () => watcher?.listeners.delete(listener);
}

/* ------------------------------------------------------------------ *
 * Dialog
 * ------------------------------------------------------------------ */

/**
 * Open the export dialog.
 *
 * @param {object} options
 * @param {Store} options.store
 * @param {import('../api.js').api} options.api
 * @param {import('../media.js').MediaEngine} [options.media]
 * @param {import('../preview.js').Preview} [options.preview]
 * @param {import('../timeline.js').Timeline} [options.timeline]
 * @param {string} [options.initialKind]  `still` opens straight on the still export.
 * @returns {{close:()=>void, refresh:()=>void}}
 */
export function openExportDialog({ store, api, media, preview, timeline, initialKind }) {
  const doc = store.doc;
  const composition = doc.composition;
  const modalRoot = document.getElementById('modal-root');
  const backdrop = el('div', { class: 'modal-backdrop' });
  const body = el('div', { class: 'modal__body' });
  const foot = el('div', { class: 'modal__foot' });
  const subtitle = el('div', { class: 'modal__sub', text: 'Renders the composition exactly as the preview draws it' });
  let open = true;
  let unwatch = () => {};
  /** @type {(()=>void)|null} */
  let detachResize = null;

  const close = () => {
    if (!open) return;
    open = false;
    unwatch();
    detachResize?.();
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  };
  const isTopmost = () => {
    const all = modalRoot ? [...modalRoot.querySelectorAll('.modal-backdrop')] : [];
    return all[all.length - 1] === backdrop;
  };
  function onKey(/** @type {KeyboardEvent} */ event) {
    if (event.key === 'Escape' && isTopmost()) close();
  }

  const state = {
    /** @type {ExportChoice[]} */
    choices: [],
    choiceId: initialKind === 'still' ? 'still' : 'mp4-h264',
    /** @type {any} */
    tools: null,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    quality: 85,
    fileName: safeStem(doc.meta.name),
    time: snapToFrame(store.playback.time, composition.fps),
    running: false,
    jobId: null,
    loadingFormats: true,
    formatError: '',
    serverIssues: /** @type {any[]} */ ([]),
  };

  /**
   * @returns {ExportChoice|undefined}
   */
  const currentChoice = () => state.choices.find((choice) => choice.id === state.choiceId);

  /* ---------------- sections ---------------- */

  const formatGrid = el('div', { class: 'picker-grid' });
  const formatHint = el('div', {});

  const rangeChips = el('div', { class: 'chip-row' });
  const rangeBarWrap = el('div', { style: { margin: '6px 0 8px' } });
  const rangeBar = /** @type {HTMLCanvasElement} */ (el('canvas', { class: 'mapping-canvas', height: '34' }));
  rangeBarWrap.append(rangeBar);
  const inField = numberField({
    label: 'Range in (seconds)',
    value: doc.exportRange.in,
    min: 0,
    max: composition.duration,
    onChange: (value) => {
      store.setRange('exportRange', { in: snapToFrame(value, state.fps) }, true);
      refresh();
    },
  });
  const outField = numberField({
    label: 'Range out (seconds)',
    value: doc.exportRange.out,
    min: 0,
    max: composition.duration,
    onChange: (value) => {
      store.setRange('exportRange', { out: snapToFrame(value, state.fps) }, true);
      refresh();
    },
  });
  const stillField = numberField({
    label: 'Still at (seconds)',
    value: state.time,
    min: 0,
    max: composition.duration,
    onChange: (value) => {
      state.time = snapToFrame(value, state.fps);
      refresh();
    },
  });
  const rangeInfo = el('div', {});

  const sizeChips = el('div', { class: 'chip-row' });
  const widthField = numberField({
    label: 'Width (px)',
    value: state.width,
    min: 16,
    max: 8192,
    onChange: (value) => {
      state.width = Math.round(value);
      refresh();
    },
  });
  const heightField = numberField({
    label: 'Height (px)',
    value: state.height,
    min: 16,
    max: 8192,
    onChange: (value) => {
      state.height = Math.round(value);
      refresh();
    },
  });
  const fpsSelect = el('select', { class: 'select-input' }, FPS_CHOICES.map((fps) => el('option', {
    value: String(fps),
    text: `${fps} fps`,
    selected: fps === state.fps,
  })));
  fpsSelect.addEventListener('change', () => {
    state.fps = Number(fpsSelect.value);
    refresh();
  });
  const qualitySlider = slider({
    label: 'Quality',
    value: state.quality,
    min: 0,
    max: 100,
    step: 1,
    decimals: 0,
    onInput: (value) => {
      state.quality = Math.round(value);
      refreshQuality();
    },
  });
  const qualityHint = el('div', {});
  const fileNameInput = textField({
    label: 'File name',
    value: state.fileName,
    inline: true,
    onChange: (value) => {
      state.fileName = value;
      refresh();
    },
  });
  const outputHint = el('div', {});

  const audioHost = el('div', {});

  const warningsHost = el('div', {});

  const progressHost = el('div', { class: 'form-group hidden' });
  const progressList = el('div', { class: 'progress-list' });
  const progressMeta = el('div', {});
  const progressRowMain = progressRow('Preparing');
  progressList.append(progressRowMain.root);
  progressHost.append(
    el('div', { class: 'form-group__label', text: 'Export progress' }),
    progressList,
    progressMeta,
  );

  const resultHost = el('div', {});

  const startButton = button('Start export', 'btn btn--primary');
  const cancelButton = button('Cancel export', 'btn btn--danger hidden');
  const statusText = el('div', { class: 'hint grow', text: '' });

  /* ---------------- format section ---------------- */

  function renderFormats() {
    if (state.loadingFormats) {
      formatGrid.replaceChildren(emptyState('Asking the local ffmpeg build which formats it can write…'));
      return;
    }
    formatGrid.replaceChildren(...state.choices.map((choice) => {
      const selected = choice.id === state.choiceId;
      const tile = /** @type {HTMLButtonElement} */ (el('button', {
        class: `picker-tile${selected ? ' btn--active' : ''}`,
        title: choice.available ? `Export as ${choice.label}` : `${choice.label} — ${choice.reason}`,
        disabled: !choice.available,
        onclick: () => {
          state.choiceId = choice.id;
          if (choice.kind === 'still') state.time = snapToFrame(store.playback.time, state.fps);
          refresh();
        },
      }, [
        el('div', { class: 'picker-tile__label' }, [
          el('span', { text: choice.label }),
          choice.available ? null : el('span', { class: 'badge-dot badge-dot--error' }),
        ]),
        el('div', {
          class: 'picker-tile__sub',
          text: `.${choice.extension}${choice.note ? ` · ${choice.note}` : ''}${choice.available ? '' : ` — ${choice.reason}`}`,
        }),
      ]));
      if (!choice.available) tile.classList.add('muted');
      return tile;
    }));

    const ffmpegReady = Boolean(state.tools?.ffmpeg);
    const usable = state.choices.filter((choice) => choice.available && choice.kind === 'video');
    /** @type {HTMLElement[]} */
    const notes = [
      hint(
        ffmpegReady ? 'info' : 'warn',
        ffmpegReady
          ? `ffmpeg ${state.tools?.version ?? ''} is available, so every supported video format can be encoded. ${usable.length} of ${state.choices.filter((choice) => choice.kind === 'video').length} video formats work on this machine.`
          : 'ffmpeg is not installed on this machine, so no video format can be encoded. Only PNG image sequence, still image and project package exports are possible — install ffmpeg and restart Motion Lab to unlock video.',
      ),
    ];
    if (state.formatError) {
      notes.push(hint('warn', `The format list could not be refreshed, so a cached copy is shown: ${state.formatError}`));
    }
    formatHint.replaceChildren(...notes);
  }

  /* ---------------- range section ---------------- */

  /**
   * @param {'all'|'selection'|'loop'|'last5'} preset
   */
  function applyRangePreset(preset) {
    if (preset === 'last5') {
      const out = composition.duration;
      store.setRange('exportRange', { in: snapToFrame(Math.max(0, out - 5), composition.fps), out }, true);
    } else {
      store.setExportRangePreset(preset);
    }
    refresh();
  }

  function drawRangeBar() {
    const ctx = fitCanvas(rangeBar, rangeBarWrap, 34);
    const width = rangeBarWrap.clientWidth || 320;
    const height = 34;
    const duration = Math.max(0.001, composition.duration);
    const toX = (time) => clampNumber(time / duration, 0, 1) * (width - 2) + 1;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(1, 10, width - 2, 14);

    const loop = doc.loopRange;
    ctx.fillStyle = 'rgba(92,225,255,0.14)';
    ctx.fillRect(toX(loop.in), 10, Math.max(1, toX(loop.out) - toX(loop.in)), 14);

    const range = doc.exportRange;
    const from = toX(range.in);
    const to = toX(range.out);
    ctx.fillStyle = 'rgba(92,225,255,0.55)';
    ctx.fillRect(from, 10, Math.max(1, to - from), 14);
    ctx.strokeStyle = '#5ce1ff';
    ctx.lineWidth = 1;
    ctx.strokeRect(from + 0.5, 10.5, Math.max(1, to - from) - 1, 13);

    const playhead = toX(store.playback.time);
    ctx.fillStyle = '#ff3d8b';
    ctx.fillRect(playhead - 0.5, 4, 1, 26);

    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillText('0s', 2, 31);
    const label = `${formatDuration(duration)}`;
    ctx.fillText(label, Math.max(2, width - ctx.measureText(label).width - 2), 31);
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    const loopLabel = `loop ${formatTimecode(loop.in, composition.fps)} – ${formatTimecode(loop.out, composition.fps)}`;
    ctx.fillText(loopLabel, 2, 8);
  }

  function renderRange() {
    const range = doc.exportRange;
    const duration = Math.max(0, range.out - range.in);
    const frames = Math.max(1, Math.round(duration * state.fps));
    const still = currentChoice()?.kind === 'still';

    rangeChips.replaceChildren(
      button('Whole composition', 'chip', { onclick: () => applyRangePreset('all') }),
      button('Selected clips', 'chip', { onclick: () => applyRangePreset('selection') }),
      button('Loop range', 'chip', { onclick: () => applyRangePreset('loop') }),
      button('Last 5 s', 'chip', { onclick: () => applyRangePreset('last5') }),
      el('span', { class: 'muted nowrap', text: `export range ${formatTimecode(range.in, state.fps)} → ${formatTimecode(range.out, state.fps)}` }),
    );
    inField.set(range.in);
    outField.set(range.out);
    stillField.set(state.time);
    stillField.root.classList.toggle('hidden', !still);
    rangeInfo.replaceChildren(
      hint(
        'info',
        still
          ? `A still renders the single frame at ${state.time.toFixed(2)}s (${formatTimecode(state.time, state.fps)}) at ${state.width}×${state.height}. The range does not apply.`
          : `${duration.toFixed(2)}s · ${frames} frame${frames === 1 ? '' : 's'} at ${state.fps} fps (${formatTimecode(duration, state.fps)} long). Frames are counted as round(range × fps), the same maths the exporter uses.`,
      ),
      hint('info', 'Drag the export range on the timeline, or type exact seconds here. The loop range is drawn behind it so you can align the two without leaving the dialog.'),
    );
    drawRangeBar();
  }

  /* ---------------- output section ---------------- */

  function renderOutput() {
    const custom = !SIZE_PRESETS.some((preset) => preset.width === state.width && preset.height === state.height);
    const onComposition = state.width === composition.width && state.height === composition.height;
    sizeChips.replaceChildren(
      button(`Composition ${composition.width}×${composition.height}`, `chip${onComposition ? ' chip--active' : ''}`, {
        onclick: () => {
          state.width = composition.width;
          state.height = composition.height;
          widthField.set(state.width);
          heightField.set(state.height);
          refresh();
        },
      }),
      ...SIZE_PRESETS.map((preset) => button(preset.label, `chip${state.width === preset.width && state.height === preset.height ? ' chip--active' : ''}`, {
        title: `${preset.width}×${preset.height}`,
        onclick: () => {
          state.width = preset.width;
          state.height = preset.height;
          widthField.set(state.width);
          heightField.set(state.height);
          refresh();
        },
      })),
      button('Custom', `chip${custom ? ' chip--active' : ''}`, {
        onclick: () => widthField.input.focus(),
      }),
    );
    widthField.set(state.width);
    heightField.set(state.height);
    if (String(state.fps) !== fpsSelect.value) fpsSelect.value = String(state.fps);
    if (document.activeElement !== fileNameInput) fileNameInput.value = state.fileName;
    const stem = safeStem(state.fileName);
    const extension = currentChoice()?.kind === 'still'
      ? '.png'
      : currentChoice()?.id === 'package'
        ? '.mlab.zip'
        : `.${currentChoice()?.extension ?? 'mp4'}`;
    outputHint.replaceChildren(
      hint('info', `Layers are composition-relative, so a different export size keeps the framing and changes only the raster. Writing ${stem}${extension}.`),
      hint('info', preview
        ? `The preview is drawing a ${preview.canvas.width}×${preview.canvas.height} raster for speed; the export always renders the full ${state.width}×${state.height}.`
        : `The export renders at ${state.width}×${state.height}.`),
    );
    refreshQuality();
  }

  function refreshQuality() {
    const choice = currentChoice();
    const quality = state.quality;
    let text = 'Quality is passed to the encoder on a 0–100 scale.';
    switch (choice?.encoder) {
      case 'libx264':
      case 'libx265':
        text = `Quality maps to CRF for H.264/H.265: ${quality} becomes CRF ${Math.round(34 - quality * 0.2)} (lower is better), with the ${quality > 75 ? 'slow' : 'medium'} preset.`;
        break;
      case 'libvpx-vp9':
        text = `Quality maps to CRF for VP9: ${quality} becomes CRF ${Math.round(40 - quality * 0.3)} with a constant-quality bitrate (-b:v 0).`;
        break;
      case 'libvpx':
        text = `Quality maps to a target bitrate for VP8: ${quality} becomes ${Math.round(1200 + quality * 180)} kbps.`;
        break;
      case 'libsvtav1':
        text = `Quality maps to CRF for AV1: ${quality} becomes CRF ${Math.round(45 - quality * 0.25)}.`;
        break;
      case 'prores_ks':
        text = `Quality selects the ProRes profile: ${quality > 70 ? '422 HQ (profile 3)' : '422 (profile 2)'}. ProRes is an editing master, so it is large on purpose.`;
        break;
      case 'gif':
        text = 'Animated GIF ignores quality: it always writes a 256-colour palette and no audio.';
        break;
      default:
        if (choice?.kind === 'still') text = 'A PNG still is always lossless, so quality does not apply.';
        else if (choice?.kind === 'png-sequence') text = 'PNG frames are lossless, so quality does not apply. The mixdown travels with the frames as soundtrack.wav.';
        else if (choice?.kind === 'package') text = 'A package stores the project and its media byte for byte, so quality does not apply.';
        break;
    }
    qualityHint.replaceChildren(hint('info', text));
    qualitySlider.classList.toggle('muted', !['libx264', 'libx265', 'libvpx-vp9', 'libvpx', 'libsvtav1', 'prores_ks'].includes(String(choice?.encoder)));
  }

  /* ---------------- audio section ---------------- */

  function renderAudio() {
    const choice = currentChoice();
    const audioClips = doc.clips.filter((clip) => clip.kind === 'audio');
    const tracks = new Map(doc.tracks.map((track) => [track.id, track]));
    const anySolo = doc.tracks.some((track) => track.kind === 'audio' && track.solo);
    const range = doc.exportRange;
    const children = [];

    if (choice?.kind === 'still' || choice?.kind === 'package') {
      children.push(hint('info', choice.kind === 'still'
        ? 'A still image never carries audio. Mute or solo settings do not change the picture.'
        : 'A project package is a zip of the project and its media, so it has no audio stream of its own. The audio clips and their mixdown settings travel inside it.'));
    } else if (audioClips.length === 0) {
      children.push(hint('warn', 'This export will have no audio: the composition has no audio clips yet. Drop a track onto an audio track to include sound.'));
    } else {
      const rows = audioClips.map((clip) => {
        const track = tracks.get(clip.trackId);
        const muted = Boolean(track?.muted) || (anySolo && !track?.solo);
        const overlaps = clip.start < range.out && clip.start + clip.duration > range.in;
        const state_text = muted ? 'muted' : overlaps ? 'in range' : 'outside the range';
        return [clip.name, `${track?.name ?? 'audio track'} · ${state_text} · ${clip.assetId ? 'media linked' : 'no media'}`];
      });
      const contributing = audioClips.filter((clip) => {
        const track = tracks.get(clip.trackId);
        const muted = Boolean(track?.muted) || (anySolo && !track?.solo);
        return !muted && clip.assetId && clip.start < range.out && clip.start + clip.duration > range.in;
      });
      children.push(kvList(rows));
      if (choice?.kind === 'png-sequence') {
        children.push(hint(contributing.length ? 'info' : 'warn', contributing.length
          ? `${contributing.length} clip${contributing.length === 1 ? '' : 's'} will be mixed to soundtrack.wav and zipped next to the frames.`
          : 'No audio clip contributes inside this range, so the sequence will hold pictures only.'));
      } else {
        children.push(hint(contributing.length ? 'info' : 'warn', contributing.length
          ? `${contributing.length} clip${contributing.length === 1 ? '' : 's'} will be mixed into the export: ${contributing.map((clip) => clip.name).join(', ')}. Volume, pan, fades, track gains and the master gain are applied.`
          : 'No audio clip contributes inside this range, so the file will be silent.'));
      }
    }
    audioHost.replaceChildren(...children);
  }

  /* ---------------- warnings ---------------- */

  /**
   * @returns {boolean} whether the export is blocked
   */
  function renderWarnings() {
    const issues = validateProject(doc);
    const choice = currentChoice();
    const children = [];

    for (const issue of issues) children.push(hint(issue.level, issue.message));

    let blocking = issues.some((issue) => issue.level === 'error');

    if (!choice) {
      children.push(hint('error', 'No export format is selected yet.'));
      blocking = true;
    } else if (!choice.available) {
      children.push(hint('error', `${choice.label} is ${choice.reason}. Pick another format.`));
      blocking = true;
    } else if (choice.kind === 'video' && !state.tools?.ffmpeg) {
      children.push(hint('error', 'ffmpeg is not available, so a video encode cannot start. Export a PNG image sequence or a still instead.'));
      blocking = true;
    }

    const range = doc.exportRange;
    if (range.out - range.in <= 0) {
      children.push(hint('error', 'The export range is empty: set an out point after the in point.'));
      blocking = true;
    }
    if (state.serverIssues.length) {
      for (const issue of state.serverIssues) children.push(hint(issue.level ?? 'warn', issue.message ?? String(issue)));
    }
    if (children.length === 0) children.push(hint('info', 'No problems found: the composition, its media and the export range all check out.'));

    warningsHost.replaceChildren(...children);
    return blocking;
  }

  /* ---------------- progress & result ---------------- */

  /**
   * @param {any} job
   */
  function renderProgress(job) {
    progressHost.classList.remove('hidden');
    const total = job.framesTotal ?? 0;
    const done = job.framesDone ?? 0;
    progressRowMain.set(job.progress ?? 0, total ? `${done}/${total}` : `${Math.round((job.progress ?? 0) * 100)}%`, job.stage ?? 'Working');
    const startedAt = job.startedAt ?? Date.now();
    const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
    const rate = elapsed > 0.5 && done > 0 ? done / elapsed : 0;
    const remaining = Math.max(0, total - done);
    const eta = rate > 0 && remaining > 0 ? remaining / rate : null;
    progressMeta.replaceChildren(kvList([
      ['Stage', String(job.stage ?? '—')],
      ['Frames', total ? `${done} of ${total}` : `${done}`],
      ['Elapsed', `${elapsed.toFixed(1)} s`],
      ['Rate', rate > 0 ? `${rate.toFixed(1)} frames/s` : 'measuring…'],
      ['Estimated left', eta === null ? (remaining === 0 ? 'finishing' : 'unknown') : `${eta < 60 ? `${eta.toFixed(0)} s` : `${Math.floor(eta / 60)} min ${Math.round(eta % 60)} s`}`],
    ]));
  }

  /**
   * @param {any} job
   */
  function renderResult(job) {
    const children = [];
    if (job.status === 'done') {
      const report = job.report ?? null;
      const rows = [
        ['File', String(job.outputName ?? '—')],
        ['Size', formatBytes(job.outputSize ?? 0)],
      ];
      if (report?.format) rows.push(['Format', String(report.format)]);
      if (report?.video) {
        rows.push(['Video codec', String(report.video.codec ?? '—')]);
        rows.push(['Frames', `${report.video.frames ?? report.requestedFrames ?? '—'}${report.requestedFrames ? ` of ${report.requestedFrames} requested` : ''}`]);
        if (report.video.width) rows.push(['Raster', `${report.video.width}×${report.video.height} @ ${Math.round(report.video.fps ?? state.fps)} fps`]);
        if (report.video.duration) rows.push(['Duration', `${Number(report.video.duration).toFixed(2)} s`]);
      } else if (report?.frames !== undefined) {
        rows.push(['Frames', String(report.frames)]);
      }
      rows.push(['Audio stream', report?.hasAudio || report?.audio ? `yes${report?.audio?.codec ? ` · ${report.audio.codec}` : ''}` : 'none']);
      if (report?.assets !== undefined) rows.push(['Media files packaged', String(report.assets)]);

      const download = el('a', {
        class: 'btn btn--primary',
        href: job.downloadUrl ?? `/api/exports/${job.id}/download`,
        download: job.outputName ?? '',
        text: 'Download',
      });
      children.push(
        el('div', { class: 'form-group__label', text: 'Export finished' }),
        kvList(rows),
        el('div', { class: 'row' }, [download]),
      );
      if (job.warnings?.length) {
        children.push(el('div', { class: 'form-group__label', text: 'Notes from the encoder' }));
        for (const warning of job.warnings) children.push(hint('warn', warning));
      }
    } else if (job.status === 'cancelled') {
      children.push(
        el('div', { class: 'form-group__label', text: 'Export cancelled' }),
        hint('warn', 'The export was cancelled. Any partly written scratch files are cleaned up by the server; start again when you are ready.'),
      );
    } else if (job.status === 'failed') {
      children.push(
        el('div', { class: 'form-group__label', text: 'Export failed' }),
        hint('error', String(job.error ?? 'The export failed without a message.')),
      );
      for (const warning of job.warnings ?? []) children.push(hint('warn', warning));
      const alternative = suggestAlternative();
      if (alternative) {
        children.push(
          hint('info', `Try ${alternative.label} instead, or export a PNG image sequence and encode it yourself.`),
          el('div', { class: 'row' }, [
            button(`Switch to ${alternative.label}`, 'btn btn--tiny', {
              onclick: () => {
                state.choiceId = alternative.id;
                resultHost.replaceChildren();
                progressHost.classList.add('hidden');
                refresh();
              },
            }),
          ]),
        );
      } else {
        children.push(hint('info', 'Export a PNG image sequence instead and encode it yourself; the frames are lossless.'));
      }
    }
    resultHost.replaceChildren(...children);
  }

  /**
   * @returns {ExportChoice|undefined}
   */
  function suggestAlternative() {
    const preferred = ['webm-vp9', 'webm-vp8', 'mp4-h264', 'mkv-av1', 'mov-prores'];
    const byId = preferred
      .map((id) => state.choices.find((choice) => choice.id === id && choice.available && choice.id !== state.choiceId))
      .find(Boolean);
    return byId ?? state.choices.find((choice) => choice.kind === 'png-sequence' && choice.id !== state.choiceId);
  }

  /* ---------------- full refresh ---------------- */

  function refresh() {
    renderFormats();
    renderRange();
    renderOutput();
    renderAudio();
    const blocking = renderWarnings();
    const choice = currentChoice();
    startButton.disabled = blocking || state.running;
    startButton.title = blocking
      ? 'Sort out the errors in the warnings section first'
      : `Start the ${choice?.label ?? 'export'}`;
    cancelButton.classList.toggle('hidden', !state.running);
    statusText.textContent = state.running
      ? 'The export keeps running if you close this dialog — watch the top bar for progress.'
      : '';
  }

  /* ---------------- starting an export ---------------- */

  async function startExport() {
    const choice = currentChoice();
    if (!choice || !choice.available || state.running) return;
    const range = doc.exportRange;
    state.running = true;
    state.serverIssues = [];
    resultHost.replaceChildren();
    progressHost.classList.remove('hidden');
    progressRowMain.set(0, '0/0', 'Starting');
    refresh();

    const payload = {
      doc,
      kind: choice.kind,
      width: Math.round(state.width),
      height: Math.round(state.height),
      fps: state.fps,
      rangeStart: snapToFrame(range.in, state.fps),
      rangeEnd: snapToFrame(range.out, state.fps),
      quality: state.quality,
      fileName: choice.kind === 'still' ? `${safeStem(state.fileName)}.png` : safeStem(state.fileName),
      time: choice.kind === 'still' ? state.time : undefined,
    };
    if (choice.kind === 'video' || choice.kind === 'png-sequence') payload.format = choice.id;

    try {
      const response = await api.startExport(payload);
      state.jobId = response.job.id;
      store.session.exportJob = response.job;
      store.emit('export');
      if (response.issues?.length) {
        state.serverIssues = response.issues;
        renderWarnings();
      }
      unwatch();
      unwatch = watchJob(store, api, response.job.id, (job) => {
        if (!open) return;
        renderProgress(job);
        if (['done', 'failed', 'cancelled'].includes(job.status)) {
          state.running = false;
          renderResult(job);
          if (job.status === 'done') {
            statusText.textContent = `${job.outputName ?? 'The export'} is ready to download.`;
            store.notify('ok', `${job.outputName ?? 'The export'} is ready.`, { title: 'Export finished' });
          } else if (job.status === 'failed') {
            statusText.textContent = 'The export failed — the reason is shown above.';
            store.notify('error', String(job.error ?? 'The export failed.'), { title: 'Export failed' });
          } else {
            statusText.textContent = 'The export was cancelled.';
          }
          refresh();
        }
      });
    } catch (error) {
      state.running = false;
      progressHost.classList.add('hidden');
      state.serverIssues = [];
      resultHost.replaceChildren(
        el('div', { class: 'form-group__label', text: 'Export could not start' }),
        hint('error', describeError(error)),
      );
      refresh();
      store.notify('error', describeError(error), { title: 'Export could not start' });
    }
  }

  /* ---------------- wiring ---------------- */

  startButton.addEventListener('click', () => startExport());
  cancelButton.addEventListener('click', async () => {
    if (!state.running || !state.jobId) return;
    cancelButton.disabled = true;
    try {
      await api.cancelExport(state.jobId);
      statusText.textContent = 'Cancelling the export…';
    } catch (error) {
      statusText.textContent = `Cancel failed: ${describeError(error)}`;
    } finally {
      cancelButton.disabled = false;
    }
  });

  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);

  const head = el('div', { class: 'modal__head' }, [
    el('div', { class: 'modal__title', text: 'Export' }),
    subtitle,
    iconButton(ICONS.close, 'Close', () => close()),
  ]);

  body.append(
    el('div', { class: 'form-group' }, [
      el('div', { class: 'form-group__label', text: 'Format' }),
      formatGrid,
      formatHint,
    ]),
    el('div', { class: 'form-group' }, [
      el('div', { class: 'form-group__label', text: 'Range' }),
      rangeChips,
      el('div', { class: 'grid-2' }, [inField.root, outField.root]),
      stillField.root,
      rangeBarWrap,
      rangeInfo,
    ]),
    el('div', { class: 'form-group' }, [
      el('div', { class: 'form-group__label', text: 'Output' }),
      sizeChips,
      el('div', { class: 'grid-3' }, [widthField.root, heightField.root, el('div', { class: 'field' }, [
        el('div', { class: 'field__label', text: 'Frame rate' }),
        el('div', { class: 'field__control' }, [fpsSelect]),
      ])]),
      qualitySlider,
      qualityHint,
      el('div', { class: 'field' }, [
        el('div', { class: 'field__label', text: 'File name' }),
        el('div', { class: 'field__control' }, [fileNameInput]),
      ]),
      outputHint,
    ]),
    el('div', { class: 'form-group' }, [
      el('div', { class: 'form-group__label', text: 'Audio' }),
      audioHost,
    ]),
    el('div', { class: 'form-group' }, [
      el('div', { class: 'form-group__label', text: 'Warnings' }),
      warningsHost,
    ]),
    progressHost,
    resultHost,
  );
  foot.append(
    statusText,
    el('div', { class: 'spacer' }),
    cancelButton,
    button('Close', 'btn', { onclick: () => close() }),
    startButton,
  );

  const modal = el('div', { class: 'modal modal--lg' }, [head, body, foot]);
  backdrop.append(modal);
  modalRoot?.append(backdrop);

  // The document, the range and the playhead can all move while the dialog is
  // open (undo, the timeline, another panel); keep every derived read-out live.
  const unsubscribeTransport = store.on('transport', () => {
    if (!open) return;
    renderRange();
    refreshQuality();
  });
  const unsubscribeDoc = store.on('doc', () => {
    if (!open) return;
    refresh();
  });
  const unsubscribePlayhead = store.on('playhead', () => {
    if (!open || currentChoice()?.kind !== 'still') return;
    drawRangeBar();
  });
  detachResize = () => {
    window.removeEventListener('resize', onResize);
    unsubscribeTransport();
    unsubscribeDoc();
    unsubscribePlayhead();
  };
  function onResize() {
    if (open) drawRangeBar();
  }
  window.addEventListener('resize', onResize);

  refresh();

  /* ---------------- formats, then resume any running job ---------------- */

  (async () => {
    try {
      const response = await api.exportFormats();
      state.tools = response.tools ?? null;
      state.choices = toChoices(response.formats ?? []);
    } catch (error) {
      state.formatError = describeError(error);
      state.tools = state.tools ?? store.session.health?.tools ?? null;
      state.choices = toChoices(store.session.formats?.length ? store.session.formats : []);
    }
    state.loadingFormats = false;
    if (!open) return;
    const selected = state.choices.find((choice) => choice.id === state.choiceId);
    if (selected && (!selected.available || (selected.kind === 'video' && !state.tools?.ffmpeg))) {
      const fallback = state.choices.find((choice) => choice.id === 'mp4-h264' && choice.available)
        ?? state.choices.find((choice) => choice.kind === 'video' && choice.available)
        ?? state.choices.find((choice) => choice.kind === 'png-sequence');
      if (fallback) state.choiceId = fallback.id;
    }
    if (initialKind === 'still') state.choiceId = 'still';
    refresh();
  })();

  const running = store.session.exportJob;
  if (running?.id && !['done', 'failed', 'cancelled'].includes(running.status)) {
    state.running = true;
    state.jobId = running.id;
    progressHost.classList.remove('hidden');
    renderProgress(running);
    unwatch = watchJob(store, api, running.id, (job) => {
      if (!open) return;
      renderProgress(job);
      if (['done', 'failed', 'cancelled'].includes(job.status)) {
        state.running = false;
        renderResult(job);
        refresh();
      }
    });
    refresh();
  }

  return { close, refresh };
}
