/**
 * The top chrome: the project bar and the transport.
 *
 * Both render functions rebuild their container from scratch, because
 * `main.js` calls them on every `ui` and `transport` tick of the store and a
 * pulled-apart topbar is worse than a rebuilt one. Everything that ticks faster
 * than that -- the transport clock, the selection summary, the level meter, the
 * save-state chip -- is driven by a store subscription, a single interval or a
 * single animation-frame loop, and the *next* render cancels the previous one
 * first. That is what keeps repeated rendering from leaking timers.
 *
 * The transport is the only place the app shows the audio output level: the
 * same `AudioEngine.spectrum()` numbers an audio connection reads, so what the
 * meter shows is what the renderer reacts to.
 */

import { button, clear, confirmDialog, el, ICONS, iconButton, menu, slider } from './dom.js';
import { formatTimecode, timeToFrame, uid } from '/core/schema.js';
import { clamp01 } from '/core/math.js';

/* ------------------------------------------------------------------ *
 * Module-level handles
 *
 * Only one topbar and one transport exist, so one handle each is enough. They
 * are cancelled at the start of every render, which is what makes repeated
 * calls safe.
 * ------------------------------------------------------------------ */

/** @type {number} */ let meterRafId = 0;
/** @type {number} */ let saveClockId = 0;
/** @type {number} */ let exportTickId = 0;
/** @type {null|(()=>void)} */ let transportOff = null;
/** @type {null|(()=>void)} */ let topbarOff = null;

/** Preview raster sizes offered in the topbar. */
const QUALITY_CHOICES = Object.freeze([
  { value: 1, label: 'Full', title: 'Render the preview at composition resolution' },
  { value: 0.5, label: 'Half', title: 'Half-resolution preview — identical timing and framing' },
  { value: 0.25, label: 'Quarter', title: 'Quarter-resolution preview — fastest, identical result' },
]);

/** The four signals the transport meter shows. */
const METER_BANDS = Object.freeze([
  { id: 'level', label: 'Level', title: 'Overall output level' },
  { id: 'low', label: 'Low', title: 'Low band — bass' },
  { id: 'mid', label: 'Mid', title: 'Mid band' },
  { id: 'high', label: 'High', title: 'High band' },
]);

/** `modifier` maps onto the existing `.meter__fill--*` classes. */
const METER_MODIFIERS = Object.freeze(['', ' meter__fill--low', ' meter__fill--mid', ' meter__fill--high']);

const LOOP_GLYPH = '\u21bb';

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Human save state for the topbar chip.
 * @param {any} session
 * @returns {string}
 */
function saveStateLabel(session) {
  const state = session.saveState ?? 'saved';
  if (state === 'saving') return 'Saving…';
  if (state === 'dirty') return 'Unsaved changes';
  if (state === 'error') return 'Save failed';
  if (!session.lastSavedAt) return 'Saved';
  const seconds = Math.max(0, Math.round((Date.now() - session.lastSavedAt) / 1000));
  if (seconds < 5) return 'Saved just now';
  if (seconds < 60) return `Saved ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Saved ${minutes} min ago`;
  return `Saved ${Math.round(minutes / 60)} h ago`;
}

/**
 * A menu row. Clicking it closes the panel before running the action, which is
 * what "click a menu item" is expected to do.
 *
 * @param {string} text
 * @param {() => void} action
 * @param {{close?:()=>void, disabled?:boolean, danger?:boolean, shortcut?:string}} [options]
 * @returns {HTMLElement}
 */
function menuItem(text, action, options = {}) {
  return el('button', {
    class: `menu__item${options.danger ? ' menu__item--danger' : ''}`,
    disabled: options.disabled === true,
    title: text,
    onclick: () => {
      options.close?.();
      action();
    },
  }, [
    el('span', { class: 'grow', text }),
    options.shortcut ? el('kbd', { text: options.shortcut }) : null,
  ]);
}

/**
 * @param {any} store
 * @returns {string[]} the ids of the current selection, newest first
 */
function selectedClipIds(store) {
  return store.ui.selectedClipIds.filter((/** @type {string} */ id) => Boolean(store.getClip(id)));
}

/**
 * Copy every selected clip into the store clipboard, in the shape `Ctrl+V`
 * (and the Edit menu's Paste) expects.
 * @param {any} store
 */
function copySelection(store) {
  const clips = selectedClipIds(store).map((id) => store.getClip(id));
  if (clips.length === 0) {
    store.notify('warn', 'Select a clip first — Copy copies the current timeline selection.', { title: 'Clipboard' });
    return;
  }
  store.clipboard.clips = JSON.parse(JSON.stringify(clips));
  store.notify('info', clips.length === 1 ? `Copied "${clips[0].name}".` : `Copied ${clips.length} clips.`, {
    title: 'Clipboard',
    timeout: 2500,
  });
}

/**
 * Paste the clipboard at the playhead, keeping the clips' relative offsets.
 * @param {any} store
 */
function pasteSelection(store) {
  const copied = store.clipboard.clips;
  if (!copied || copied.length === 0) {
    store.notify('warn', 'The clipboard is empty — copy a clip first.', { title: 'Clipboard' });
    return;
  }
  const at = store.playback.time;
  const offset = Math.min(...copied.map((/** @type {any} */ clip) => clip.start));
  /** @type {string[]} */
  const ids = [];
  store.edit('Paste clips', () => {
    for (const source of copied) {
      const clip = JSON.parse(JSON.stringify(source));
      clip.id = uid('clip');
      clip.start = Math.max(0, at + (source.start - offset));
      clip.keyframes = clip.keyframes.map((/** @type {any} */ channel) => ({
        ...channel,
        id: uid('chan'),
        keys: channel.keys.map((/** @type {any} */ key) => ({ ...key, id: uid('key') })),
      }));
      clip.effects.stack = clip.effects.stack.map((/** @type {any} */ effect) => ({ ...effect, id: uid('fx') }));
      clip.masks = clip.masks.map((/** @type {any} */ mask) => ({ ...mask, id: uid('mask') }));
      store.doc.clips.push(clip);
      ids.push(clip.id);
    }
  });
  store.selectClips(ids);
  store.notify('ok', ids.length === 1 ? 'Pasted 1 clip at the playhead.' : `Pasted ${ids.length} clips at the playhead.`, {
    title: 'Clipboard',
    timeout: 2500,
  });
}

/**
 * Point the loop range at the selected clips and switch looping on.
 * @param {any} store
 */
function setLoopToSelection(store) {
  const clips = selectedClipIds(store).map((id) => store.getClip(id));
  if (clips.length === 0) {
    store.notify('warn', 'Select one or more clips first, then set the loop to them.', { title: 'Loop range' });
    return;
  }
  const from = Math.min(...clips.map((clip) => clip.start));
  const to = Math.max(...clips.map((clip) => clip.start + clip.duration));
  store.setRange('loopRange', { in: from, out: to }, true);
  store.playback.loop = true;
  store.emit('transport');
}

/**
 * @param {any} store
 * @returns {string}
 */
function selectionSummary(store) {
  const ids = selectedClipIds(store);
  if (ids.length === 0) return 'No selection';
  if (ids.length === 1) return store.getClip(ids[0])?.name ?? '1 clip';
  return `${ids.length} clips selected`;
}

/**
 * @param {any} job
 * @returns {boolean}
 */
function jobRunning(job) {
  return Boolean(job) && !['done', 'failed', 'cancelled'].includes(job.status);
}

/* ------------------------------------------------------------------ *
 * Topbar
 * ------------------------------------------------------------------ */

/**
 * Render the project bar: brand, project name, save state, the Projects and
 * Edit menus, project settings, panel toggles, preview quality, loop and
 * Export (or the live export progress chip).
 *
 * Fully replaces `container`'s children. Safe to call repeatedly: the previous
 * save-state clock, export-progress clock and store subscriptions are cancelled
 * first.
 *
 * @param {HTMLElement} container The `.topbar` element.
 * @param {{store:any, media:any, preview:any, timeline:any, api:any, actions:any}} ctx
 * @returns {void}
 */
export function renderTopbar(container, ctx) {
  const { store, preview, api, actions } = ctx;

  if (saveClockId) {
    clearInterval(saveClockId);
    saveClockId = 0;
  }
  if (exportTickId) {
    clearInterval(exportTickId);
    exportTickId = 0;
  }
  topbarOff?.();
  topbarOff = null;

  clear(container);
  container.classList.add('topbar');
  container.style.height = '46px';

  const composition = store.doc.composition;
  const fps = composition.fps;

  /* ------------------------------------------------------------ brand */

  const brand = el('div', { class: 'brand', title: 'Motion Lab' }, [
    el('div', { class: 'brand__mark' }),
    el('div', {}, [
      el('div', { class: 'brand__name', text: 'Motion Lab' }),
      el('div', {
        class: 'brand__sub',
        text: `${composition.width}\u00d7${composition.height} \u00b7 ${fps} fps`,
      }),
    ]),
  ]);

  /* ------------------------------------------------------- project name */

  const nameInput = /** @type {HTMLInputElement} */ (el('input', {
    class: 'project-name',
    type: 'text',
    value: store.doc.meta.name,
    title: 'Rename this project',
    spellcheck: 'false',
    onchange: () => commitName(),
    onkeydown: (/** @type {KeyboardEvent} */ event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        nameInput.blur();
      } else if (event.key === 'Escape') {
        nameInput.value = store.doc.meta.name;
        nameInput.blur();
      }
    },
  }));

  function commitName() {
    const value = nameInput.value.trim() || 'Untitled composition';
    nameInput.value = value;
    if (value === store.doc.meta.name) return;
    store.edit('Rename project', () => {
      store.doc.meta.name = value;
    });
  }

  /* --------------------------------------------------------- save state */

  const saveState = el('span', {
    class: 'save-state',
    title: 'Autosave keeps a recovery draft every 20 seconds; Save writes the project itself',
  });

  function paintSaveState() {
    saveState.dataset.state = store.session.saveState ?? 'saved';
    saveState.textContent = saveStateLabel(store.session);
  }
  paintSaveState();
  saveClockId = setInterval(paintSaveState, 1000);

  /* ------------------------------------------------------------ menus */

  const projectsMenu = menu({
    trigger: button(`${ICONS.layers} Projects`, 'btn', { title: 'New, open, save and package projects' }),
    build: (close) => {
      const importInput = /** @type {HTMLInputElement} */ (el('input', {
        type: 'file',
        accept: '.mlab,.mlab.zip,.zip,application/zip,application/json',
        class: 'hidden',
        onchange: () => {
          const file = importInput.files?.[0];
          importInput.value = '';
          if (!file) return;
          close();
          actions.importProject(file);
        },
      }));
      return el('div', {}, [
        importInput,
        el('div', { class: 'menu__label', text: 'Project' }),
        menuItem('New…', () => actions.newProject(), { close, shortcut: 'Ctrl+N' }),
        menuItem('Open…', () => actions.openProjects(), { close, shortcut: 'Ctrl+O' }),
        menuItem('Starter projects…', () => actions.openTemplates(), { close }),
        menuItem('Duplicate', () => actions.duplicateProject(), { close }),
        el('div', { class: 'menu__sep' }),
        menuItem('Save', () => actions.save(), { close, shortcut: 'Ctrl+S' }),
        menuItem('Save as', () => actions.saveAs(), { close, shortcut: 'Ctrl+Shift+S' }),
        menuItem('Download package', () => actions.packageProject(), { close }),
        el('button', {
          class: 'menu__item',
          text: 'Import package…',
          title: 'Import a .mlab package exported from another machine',
          onclick: () => importInput.click(),
        }),
        el('div', { class: 'menu__sep' }),
        menuItem('Keyboard shortcuts', () => actions.showShortcuts(), { close, shortcut: '?' }),
        menuItem('About Motion Lab', () => actions.about(), { close }),
        el('div', { class: 'menu__sep' }),
        menuItem('Delete project', () => deleteProject(), {
          close,
          danger: true,
          disabled: !store.session.projectId,
        }),
        el('div', {
          class: 'menu__note',
          text: store.session.projectId
            ? 'Packages contain the project document and every media file it uses.'
            : 'This project has not been saved yet, so there is nothing to delete.',
        }),
      ]);
    },
  });

  async function deleteProject() {
    const id = store.session.projectId;
    if (!id) {
      store.notify('warn', 'This project has not been saved yet — there is nothing to delete.', { title: 'Projects' });
      return;
    }
    const confirmed = await confirmDialog({
      title: 'Delete project',
      message: `Delete "${store.doc.meta.name}" and the media it stores? This cannot be undone.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Keep',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.deleteProject(id);
      store.notify('ok', 'Project deleted. Starting a new composition.', { title: 'Projects' });
      await actions.newProject({ name: 'Untitled composition' });
    } catch (error) {
      store.notify('error', `Could not delete the project: ${describeError(error)}`, { title: 'Projects' });
    }
  }

  const editMenu = menu({
    trigger: button(`${ICONS.undo} Edit`, 'btn', { title: 'Undo, history and clip editing' }),
    build: (close) => {
      const history = store.history.past;
      const last = history[history.length - 1];
      const hasSelection = selectedClipIds(store).length > 0;
      return el('div', {}, [
        el('div', { class: 'menu__label', text: 'History' }),
        menuItem('Undo', () => store.undo(), { close, disabled: !store.canUndo(), shortcut: 'Ctrl+Z' }),
        menuItem('Redo', () => store.redo(), { close, disabled: !store.canRedo(), shortcut: 'Ctrl+Shift+Z' }),
        el('div', {
          class: 'menu__note',
          text: last
            ? `Last step: ${last.label}`
            : 'Nothing to undo yet — every edit lands here, one entry per gesture.',
        }),
        el('div', { class: 'menu__sep' }),
        el('div', { class: 'menu__label', text: 'Clips' }),
        menuItem('Split at playhead', () => splitAtPlayhead(), { close, disabled: !hasSelection, shortcut: 'S' }),
        menuItem('Duplicate clips', () => store.duplicateClips(store.ui.selectedClipIds), { close, disabled: !hasSelection, shortcut: 'Ctrl+D' }),
        menuItem('Delete clips', () => store.deleteClips(store.ui.selectedClipIds), { close, disabled: !hasSelection, danger: true, shortcut: 'Delete' }),
        el('div', { class: 'menu__sep' }),
        menuItem('Select all', () => store.selectClips(store.doc.clips.map((/** @type {any} */ clip) => clip.id)), { close, shortcut: 'Ctrl+A' }),
        menuItem('Copy', () => copySelection(store), { close, disabled: !hasSelection, shortcut: 'Ctrl+C' }),
        menuItem('Paste', () => pasteSelection(store), { close, disabled: !(store.clipboard.clips?.length), shortcut: 'Ctrl+V' }),
      ]);
    },
  });

  function splitAtPlayhead() {
    const count = store.splitClips();
    if (count === 0) {
      store.notify('warn', 'Nothing to split — the playhead has to be inside a selected clip.', { title: 'Split' });
    }
  }

  /* ------------------------------------------------- right-hand controls */

  const leftToggle = iconButton(
    ICONS.layers,
    store.ui.leftOpen ? 'Hide the media library (Ctrl+I)' : 'Show the media library (Ctrl+I)',
    () => actions.toggleLeft(),
    `btn btn--icon${store.ui.leftOpen ? ' btn--active' : ''}`,
  );
  const rightToggle = iconButton(
    ICONS.sparkle,
    store.ui.rightOpen ? 'Hide the inspector (Ctrl+Shift+I)' : 'Show the inspector (Ctrl+Shift+I)',
    () => actions.toggleRight(),
    `btn btn--icon${store.ui.rightOpen ? ' btn--active' : ''}`,
  );

  const qualityGroup = el('div', { class: 'btn-group' }, QUALITY_CHOICES.map((choice) => button(
    choice.label,
    `btn${store.playback.quality === choice.value ? ' btn--active' : ''}`,
    {
      title: choice.title,
      onclick: () => preview.setQuality(choice.value),
    },
  )));

  const loopButton = button(`${LOOP_GLYPH} Loop`, `btn${store.playback.loop ? ' btn--active' : ''}`, {
    title: 'Loop playback over the loop range (L)',
    onclick: () => {
      store.playback.loop = !store.playback.loop;
      store.emit('transport');
      preview.invalidate(true);
    },
  });

  const exportButton = button('Export', 'btn btn--primary', {
    title: 'Export video, a still image or the soundtrack (Ctrl+E)',
    onclick: () => actions.exportDialog(),
  });

  /**
   * A compact replacement for the Export button while a job is running.
   * Clicking it reopens the export dialog, where the job can be watched or
   * cancelled.
   * @param {any} job
   * @returns {HTMLElement}
   */
  function exportChip(job) {
    const stage = String(job.stage ?? 'Exporting');
    const percent = Math.round(clamp01(Number(job.progress) || 0) * 100);
    return el('button', {
      class: 'stat-chip',
      title: `${stage} — ${percent}%. Click for the export dialog.`,
      onclick: () => actions.exportDialog(),
    }, [
      el('span', { class: 'row' }, [
        el('span', { text: `${stage} ${percent}%` }),
        el('span', { class: 'progress', style: { width: '44px' } }, [
          el('div', { class: 'progress__fill', style: { width: `${percent}%` } }),
        ]),
      ]),
    ]);
  }

  const exportSlot = el('div', { class: 'row' });
  let exportSignature = '';
  function paintExportSlot() {
    const job = store.session.exportJob;
    const running = jobRunning(job);
    const signature = running ? `${job.id}:${job.stage}:${job.progress}` : 'idle';
    if (signature === exportSignature) return;
    exportSignature = signature;
    exportSlot.replaceChildren(running ? exportChip(job) : exportButton);
  }
  paintExportSlot();
  if (jobRunning(store.session.exportJob)) {
    exportTickId = setInterval(() => {
      if (!jobRunning(store.session.exportJob)) {
        clearInterval(exportTickId);
        exportTickId = 0;
        paintExportSlot();
        return;
      }
      paintExportSlot();
    }, 500);
  }

  /* ------------------------------------------------------------- assembly */

  container.append(
    brand,
    nameInput,
    saveState,
    projectsMenu.root,
    editMenu.root,
    button(`${ICONS.sparkle} Project settings`, 'btn', {
      title: 'Composition size, frame rate, duration and audio settings',
      onclick: () => actions.projectSettings(),
    }),
    button(`${ICONS.layers} Presets`, 'btn', {
      title: 'Reusable effect stacks, animations, audio connections and templates',
      onclick: () => actions.presets(),
    }),
    el('div', { class: 'grow' }),
    leftToggle,
    rightToggle,
    qualityGroup,
    loopButton,
    exportSlot,
  );

  /* Keep the two chips that mirror store state honest between renders. */
  const offUi = store.on('ui', () => {
    paintSaveState();
    paintExportSlot();
  });
  const offTransport = store.on('transport', () => {
    loopButton.classList.toggle('btn--active', Boolean(store.playback.loop));
    leftToggle.classList.toggle('btn--active', Boolean(store.ui.leftOpen));
    rightToggle.classList.toggle('btn--active', Boolean(store.ui.rightOpen));
    for (const [index, node] of [...qualityGroup.children].entries()) {
      node.classList.toggle('btn--active', store.playback.quality === QUALITY_CHOICES[index]?.value);
    }
  });
  const offExport = store.on('export', paintExportSlot);
  topbarOff = () => {
    offUi();
    offTransport();
    offExport();
  };
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

/**
 * Render the transport row: playback controls, the live timecode, the master
 * gain, the output meter, the loop range and the current selection.
 *
 * Fully replaces `container`'s children. Safe to call repeatedly: the previous
 * meter animation-frame loop and store subscriptions are cancelled first, so a
 * re-render can never leave a second loop running.
 *
 * @param {HTMLElement} container The `.transport` element.
 * @param {{store:any, media:any, preview:any, audio:any, timeline:any, actions:any}} ctx
 * @returns {void}
 */
export function renderTransport(container, ctx) {
  const { store, preview, audio } = ctx;

  if (meterRafId) {
    cancelAnimationFrame(meterRafId);
    meterRafId = 0;
  }
  transportOff?.();
  transportOff = null;

  clear(container);
  container.classList.add('transport');
  container.style.height = '40px';

  const composition = store.doc.composition;
  const fps = composition.fps;

  /* ------------------------------------------------- playback controls */

  const playButton = iconButton(
    store.playback.playing ? ICONS.pause : ICONS.play,
    store.playback.playing ? 'Pause (Space)' : 'Play (Space)',
    () => preview.togglePlay(),
    'btn btn--icon',
  );

  const loopButton = button(`${LOOP_GLYPH} Loop`, `btn${store.playback.loop ? ' btn--active' : ''}`, {
    title: 'Loop playback over the loop range (L)',
    onclick: () => {
      store.playback.loop = !store.playback.loop;
      store.emit('transport');
    },
  });

  /* ---------------------------------------------------------- the clock */

  const timecode = el('span', {
    class: 'timecode',
    id: 'transport-timecode',
    title: 'Playhead position, mm:ss:ff',
    text: formatTimecode(store.playback.time, fps),
  });

  const durationClock = el('span', {
    class: 'timecode timecode--muted',
    title: 'Composition duration and the current frame index',
  });

  function paintClock() {
    const time = store.playback.time;
    const frame = timeToFrame(time, fps);
    const lastFrame = Math.max(0, timeToFrame(composition.duration, fps) - 1);
    timecode.textContent = formatTimecode(time, fps);
    durationClock.textContent = `${formatTimecode(composition.duration, fps)} \u00b7 f${String(frame).padStart(5, '0')}/${lastFrame}`;
  }
  paintClock();

  /* ---------------------------------------------------- master gain/mute */

  const settings = store.doc.audioSettings;
  let gainGestureOpen = false;
  let gainGestureStart = settings.masterGain;

  /**
   * Write the gain, live and into the document.
   * @param {number} value
   */
  function writeMasterGain(value) {
    settings.masterGain = value;
    audio.setMasterGain(value);
  }

  /**
   * Finish a gain gesture as exactly one undo entry.
   *
   * The document is put back to where the drag started and the final value is
   * written through `store.edit`, so the store sees a real change -- that is
   * what marks the open gesture dirty and makes `endGesture` commit it. A drag
   * that ends where it started therefore records nothing at all.
   *
   * @param {number} value
   */
  function closeGainGesture(value) {
    if (!gainGestureOpen) {
      store.edit('Set master volume', () => writeMasterGain(value));
      return;
    }
    gainGestureOpen = false;
    writeMasterGain(gainGestureStart);
    store.edit('Set master volume', () => writeMasterGain(value));
    store.endGesture(true);
  }

  const gainSlider = slider({
    label: 'Master',
    value: settings.masterGain,
    min: 0,
    max: 2,
    step: 0.01,
    decimals: 2,
    title: 'Master output gain for playback and for the exported mixdown',
    onInput: (value, committing) => {
      if (committing) {
        closeGainGesture(value);
        return;
      }
      if (!gainGestureOpen) {
        // Open the gesture before the first write, so one drag is one undo step.
        gainGestureOpen = true;
        gainGestureStart = settings.masterGain;
        store.beginGesture('Set master volume');
      }
      writeMasterGain(value);
    },
    onCommit: () => {
      if (gainGestureOpen) closeGainGesture(settings.masterGain);
    },
  });

  const muteButton = iconButton(
    ICONS.mute,
    audio.muted ? 'Unmute the mix' : 'Mute the mix',
    () => {
      audio.setMuted(!audio.muted);
      store.emit('transport');
    },
    `btn btn--icon${audio.muted ? ' btn--active' : ''}`,
  );

  /* -------------------------------------------------------------- meter */

  /** @type {HTMLElement[]} */
  const meterFills = METER_BANDS.map((band, index) => el('div', {
    class: `meter__fill${METER_MODIFIERS[index]}`,
    title: band.title,
  }));

  const meter = el('div', {
    class: 'meter',
    title: 'Post-gain output level — the same spectrum an audio connection reads',
  }, [
    el('span', { class: 'meter__label', text: 'out' }),
    ...METER_BANDS.map((band, index) => el('div', { class: 'meter__bar', title: band.title }, [meterFills[index]])),
  ]);

  /**
   * @param {number[]} values 0..1 per band
   */
  function paintMeter(values) {
    for (let index = 0; index < meterFills.length; index += 1) {
      const value = clamp01(Number(values[index]) || 0);
      meterFills[index].style.width = `${Math.round(value * 100)}%`;
    }
  }

  function idleMeter() {
    paintMeter([0, 0, 0, 0]);
  }

  /**
   * Follow the output while the audio engine is running. The loop idles itself
   * the moment playback stops and does not reschedule, so a paused transport
   * costs nothing.
   */
  function startMeter() {
    if (!audio.playing) {
      idleMeter();
      return;
    }
    const tick = () => {
      if (!audio.playing) {
        meterRafId = 0;
        idleMeter();
        return;
      }
      const spectrum = audio.spectrum();
      paintMeter(METER_BANDS.map((band) => spectrum[band.id]));
      meterRafId = requestAnimationFrame(tick);
    };
    meterRafId = requestAnimationFrame(tick);
  }

  /* ------------------------------------------------- loop range + selection */

  const loopChip = el('span', { class: 'stat-chip', title: 'Loop range (yellow band in the timeline)' });

  const loopToSelection = button('Loop to selection', 'btn btn--tiny', {
    title: 'Set the loop range to the selected clips and switch looping on',
    onclick: () => setLoopToSelection(store),
  });

  const selectionChip = el('span', { class: 'stat-chip', title: 'Current timeline selection' });

  function paintState() {
    const range = store.doc.loopRange;
    loopChip.textContent = `loop ${formatTimecode(range.in, fps)} \u2192 ${formatTimecode(range.out, fps)}`;
    selectionChip.textContent = selectionSummary(store);
    loopButton.classList.toggle('btn--active', Boolean(store.playback.loop));
    muteButton.classList.toggle('btn--active', Boolean(audio.muted));
    muteButton.title = audio.muted ? 'Unmute the mix' : 'Mute the mix';
    playButton.textContent = store.playback.playing ? ICONS.pause : ICONS.play;
    playButton.title = store.playback.playing ? 'Pause (Space)' : 'Play (Space)';
  }
  paintState();

  /* ------------------------------------------------------------ assembly */

  container.append(
    iconButton(ICONS.start, 'Go to the start of the range (Home)', () => preview.goToStart(), 'btn btn--icon'),
    iconButton(ICONS.prevFrame, 'One frame back (\u2190)', () => preview.step(-1), 'btn btn--icon'),
    playButton,
    iconButton(ICONS.nextFrame, 'One frame forward (\u2192)', () => preview.step(1), 'btn btn--icon'),
    iconButton(ICONS.end, 'Go to the end of the composition (End)', () => preview.goToEnd(), 'btn btn--icon'),
    loopButton,
    timecode,
    durationClock,
    el('div', { class: 'grow' }),
    loopChip,
    loopToSelection,
    selectionChip,
    gainSlider,
    muteButton,
    meter,
  );

  startMeter();

  /* Cheap text/state updates between renders. */
  const offPlayhead = store.on('playhead', () => {
    paintClock();
    paintState();
  });
  const offSelection = store.on('selection', paintState);
  const offTransport = store.on('transport', paintState);
  const offDoc = store.on('doc', () => {
    paintClock();
    paintState();
  });
  transportOff = () => {
    offPlayhead();
    offSelection();
    offTransport();
    offDoc();
  };
}
