/**
 * Workspace dialogs.
 *
 * Five self-contained panels live here: the project browser, composition
 * settings, crash-recovery, the starter-project library and the about panel.
 * They share one small modal shell (below) so every dialog behaves the same way
 * -- Escape closes the top-most one, a click on the backdrop cancels, and a
 * nested dialog such as `promptDialog()` always wins over the one beneath it.
 *
 * Two rules this file follows strictly:
 *  - Nothing is written to the document outside `store.edit()`, so opening a
 *    dialog, typing in it and cancelling leaves the undo history untouched.
 *  - Nothing is read from the DOM at import time. Every element is built inside
 *    the exported function that shows it, which keeps the module safe to import
 *    in a Node parse check and in the browser alike.
 *
 * The starter projects are authored here, in code, with real animation,
 * effects, masks and audio connections -- not descriptions of them. Each one is
 * also pushed into `doc.presets` as a `template` preset (using a cycle-free copy
 * of the document, because a preset that contained its own document would make
 * the document impossible to serialise for undo).
 */

import { createMapping } from '/core/audio.js';
import { normalizeProject } from '/core/document.js';
import { defaultParams } from '/core/effectRegistry.js';
import { easingPreset, setKeyframe } from '/core/keyframes.js';
import { renderFrameToCanvas } from '/core/render.js';
import {
  FPS_CHOICES, clampRanges, createProject, defaultClip, defaultGraphic, defaultTextStyle,
  defaultTrack, formatDuration, snapToFrame, uid,
} from '/core/schema.js';
import {
  button, clear, colorField, confirmDialog, el, emptyState, hint, iconButton, ICONS,
  promptDialog, select, textField,
} from './dom.js';

/** @typedef {import('/core/schema.js').ProjectDoc} ProjectDoc */

/* ------------------------------------------------------------------ *
 * Modal shell
 * ------------------------------------------------------------------ */

/**
 * The shared dialog frame. Returns live handles so callers can fill the body and
 * footer after the frame is on screen (which is what lets a canvas preview
 * measure itself).
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.subtitle]
 * @param {'modal--sm'|'modal--md'|'modal--lg'} [options.size]
 * @param {boolean} [options.footer]     Set false for a border-less, footer-less panel.
 * @param {()=>void} [options.onClose]
 * @returns {{backdrop:HTMLElement, modal:HTMLElement, body:HTMLElement, foot:HTMLElement, setSubtitle:(text:string)=>void, close:()=>void, isOpen:()=>boolean}}
 */
function openModal(options) {
  const root = document.getElementById('modal-root');
  const backdrop = el('div', { class: 'modal-backdrop' });
  const body = el('div', { class: 'modal__body' });
  const foot = el('div', { class: 'modal__foot' });
  const subtitle = el('div', { class: 'modal__sub', text: options.subtitle ?? '' });
  let open = true;

  /** @returns {boolean} true when this backdrop is the one on top. */
  const isTopmost = () => {
    const all = root ? [...root.querySelectorAll('.modal-backdrop')] : [];
    return all[all.length - 1] === backdrop;
  };
  const onKey = (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'Escape') return;
    if (!isTopmost()) return;
    close();
  };
  const close = () => {
    if (!open) return;
    open = false;
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    options.onClose?.();
  };

  const head = el('div', { class: 'modal__head' }, [
    el('div', { class: 'modal__title', text: options.title }),
    subtitle,
    iconButton(ICONS.close, 'Close', () => close()),
  ]);
  const modal = el('div', { class: `modal ${options.size ?? 'modal--md'}` }, [
    head,
    body,
    options.footer === false ? null : foot,
  ]);
  backdrop.append(modal);
  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) close();
  });
  root?.append(backdrop);
  document.addEventListener('keydown', onKey);

  return {
    backdrop,
    modal,
    body,
    foot,
    setSubtitle: (text) => {
      subtitle.textContent = text;
    },
    close,
    isOpen: () => open,
  };
}

/* ------------------------------------------------------------------ *
 * Small shared pieces
 * ------------------------------------------------------------------ */

/**
 * @param {number} value
 * @returns {string}
 */
function formatNumber(value) {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

/**
 * Clamp that tolerates NaN.
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
 * A numeric text field in the app's `.field` shell. Commits on blur and Enter,
 * and reports the clamped value back through `onChange`.
 *
 * @param {object} options
 * @param {string} options.label
 * @param {number} options.value
 * @param {number} options.min
 * @param {number} options.max
 * @param {string} [options.title]
 * @param {(value:number)=>void} options.onChange
 * @returns {{root:HTMLElement, input:HTMLInputElement, set:(value:number)=>void}}
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
      input.value = formatNumber(value);
    },
  };
}

/**
 * A `.kv` list from label/value pairs.
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
 * @param {HTMLElement} parent
 * @param {HTMLElement[]} children
 */
function replaceChildren(parent, children) {
  parent.replaceChildren(...children.filter(Boolean));
}

/**
 * Download a URL through a temporary `<a download>` element.
 * @param {string} url
 * @param {string} [name]
 */
function triggerDownload(url, name) {
  const anchor = el('a', { href: url, download: name ?? '' });
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * Poll an export job to completion.
 * @param {import('../api.js').api} api
 * @param {string} jobId
 * @param {(job:any)=>void} [onTick]
 * @returns {Promise<any>} the settled job state
 */
async function pollJob(api, jobId, onTick) {
  for (;;) {
    const { job } = await api.exportJob(jobId);
    onTick?.(job);
    if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
    await delay(500);
  }
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
 * @param {string} value
 * @returns {string}
 */
function safeFileName(value) {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'motion-lab';
}

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

/**
 * The project browser: every saved project in the workspace folder, with open,
 * duplicate, rename, package, delete and draft-recovery actions, plus the entry
 * points for a new project, the starter projects and package import.
 *
 * @param {object} options
 * @param {import('../store.js').Store} options.store
 * @param {import('../api.js').api} options.api
 * @param {(projectId:string)=>void|Promise<void>} options.onOpen
 * @param {()=>void|Promise<void>} options.onNew
 * @param {()=>void|Promise<void>} options.onTemplates
 * @returns {{close:()=>void, refresh:()=>Promise<void>}}
 */
export function openProjectsDialog({ store, api, onOpen, onNew, onTemplates }) {
  const list = el('div', {});
  const status = el('div', { class: 'hint', text: 'Loading projects…' });
  const progressHost = el('div', { class: 'form-group' });
  const fileInput = el('input', {
    type: 'file',
    accept: '.zip,.json,application/zip,application/json',
    class: 'hidden',
  });

  const workspacePath = store.session.health?.workspace ?? null;
  const modal = openModal({
    title: 'Projects',
    subtitle: 'Saved in the workspace folder on disk',
    size: 'modal--lg',
  });

  /** @param {string} message @param {'info'|'warn'|'error'} [level] */
  const setStatus = (message, level = 'info') => {
    status.className = level === 'warn' ? 'hint hint--warn' : level === 'error' ? 'hint hint--danger' : 'hint';
    status.textContent = message;
  };

  /**
   * @param {number} value 0..1
   * @param {string} label
   */
  const showProgress = (value, label) => {
    progressHost.replaceChildren(
      el('div', { class: 'form-group__label', text: label }),
      el('div', { class: 'progress' }, [
        el('div', { class: 'progress__fill', style: { width: `${Math.round(clampNumber(value, 0, 1) * 100)}%` } }),
      ]),
    );
  };
  const hideProgress = () => progressHost.replaceChildren();

  /**
   * Package a project and hand the zip to the browser.
   * @param {any} project
   */
  async function downloadPackage(project) {
    setStatus(`Packaging “${project.name}”…`);
    showProgress(0, 'Building the project package');
    try {
      const { job } = await api.packageProject(project.id);
      store.session.exportJob = job;
      store.emit('export');
      const finished = await pollJob(api, job.id, (tick) => {
        // Keep the top bar's progress honest while the package is built.
        store.session.exportJob = tick;
        store.emit('export');
        showProgress(tick.progress, `${tick.stage} — ${Math.round(tick.progress * 100)}%`);
      });
      store.session.exportJob = finished;
      store.emit('export');
      if (finished.status === 'done' && finished.downloadUrl) {
        triggerDownload(finished.downloadUrl, finished.outputName ?? 'project.mlab.zip');
        setStatus(`Downloaded ${finished.outputName ?? 'the project package'}.`);
        store.notify('ok', 'The package holds the project document and every media file it uses, so it opens on another machine.', { title: 'Package ready' });
      } else if (finished.status === 'cancelled') {
        setStatus('Packaging was cancelled.', 'warn');
      } else {
        setStatus(finished.error ?? 'Packaging failed.', 'error');
        store.notify('error', finished.error ?? 'Packaging failed.', { title: 'Package failed' });
      }
    } catch (error) {
      setStatus(describeError(error), 'error');
      store.notify('error', describeError(error), { title: 'Package failed' });
    } finally {
      hideProgress();
    }
  }

  /**
   * Show the draft next to the saved summary and offer to reopen with it.
   * Applying sets `session.recoveredDraft` and reopens the project through the
   * same path the Open button uses, so the app's own recovery dialog confirms
   * the swap with the media reloaded around it.
   *
   * @param {any} project
   * @param {HTMLElement} host
   */
  async function showDraft(project, host) {
    host.replaceChildren(el('div', { class: 'hint', text: 'Looking for a recoverable draft…' }));
    try {
      const { draft } = await api.projectDraft(project.id);
      if (!draft?.doc) {
        host.replaceChildren(hint('info', 'This project has no recoverable draft any more.'));
        return;
      }
      const { doc: draftDoc } = normalizeProject(draft.doc);
      const apply = button('Apply draft', 'btn btn--primary btn--tiny', {
        onclick: async () => {
          modal.close();
          store.session.recoveredDraft = draft;
          await onOpen(project.id);
        },
      });
      const cancel = button('Keep saved version', 'btn btn--tiny', {
        onclick: () => host.replaceChildren(),
      });
      host.replaceChildren(el('div', { class: 'form-group' }, [
        el('div', { class: 'form-group__label', text: 'Recoverable draft' }),
        kvList([
          ['Autosaved', new Date(draft.savedAt ?? Date.now()).toLocaleString()],
          ['Reason', String(draft.reason ?? 'autosave')],
          ['Clips', `${draftDoc.clips.length} in draft · ${project.clipCount} saved`],
          ['Tracks', `${draftDoc.tracks.length} in draft · ${project.trackCount} saved`],
          ['Duration', `${draftDoc.composition.duration}s draft · ${project.duration}s saved`],
          ['Frame rate', `${draftDoc.composition.fps} fps draft · ${project.fps} fps saved`],
        ]),
        el('div', { class: 'row' }, [apply, cancel]),
        hint('warn', 'Recovering reopens the project with the draft. Until you save, the version on disk stays as it is.'),
      ]));
    } catch (error) {
      host.replaceChildren(hint('error', `The draft could not be read: ${describeError(error)}`));
    }
  }

  /**
   * One project row plus the slot its inline draft preview expands into.
   * @param {any} project
   * @returns {HTMLElement}
   */
  function buildTile(project) {
    const thumb = el('div', { class: 'project-tile__thumb' }, [
      project.thumbnail
        ? el('img', { src: project.thumbnail, alt: `${project.name} poster frame` })
        : el('span', { text: 'No preview' }),
    ]);
    const draftHost = el('div', {});
    const tile = el('div', { class: `project-tile${project.id === store.session.projectId ? ' project-tile--current' : ''}` }, [
      thumb,
      el('div', { class: 'project-tile__main' }, [
        el('div', { class: 'project-tile__name', text: project.name }),
        el('div', {
          class: 'project-tile__meta',
          text: `${project.width}×${project.height} @ ${project.fps} · ${formatDuration(project.duration)} · ${project.clipCount} clip${project.clipCount === 1 ? '' : 's'}`,
        }),
        el('div', {
          class: 'project-tile__meta',
          text: `Updated ${new Date(project.updatedAt).toLocaleString()}${project.hasDraft ? ' · newer draft available' : ''}`,
        }),
      ]),
      el('div', { class: 'project-tile__actions' }, [
        project.id === store.session.projectId
          ? el('span', { class: 'stat-chip', text: 'Open now' })
          : button('Open', 'btn btn--tiny btn--primary', { onclick: () => onOpen(project.id) }),
        button('Duplicate', 'btn btn--tiny', {
          onclick: async () => {
            const name = await promptDialog({
              title: 'Duplicate project',
              message: `Name for the copy of “${project.name}”`,
              value: `${project.name} copy`,
            });
            if (!name) return;
            try {
              await api.duplicateProject(project.id, name);
              setStatus(`Duplicated as “${name}”.`);
              store.notify('ok', `Duplicated as “${name}”.`, { title: 'Projects' });
              await refresh();
            } catch (error) {
              setStatus(describeError(error), 'error');
            }
          },
        }),
        button('Rename', 'btn btn--tiny', {
          onclick: async () => {
            const name = await promptDialog({ title: 'Rename project', message: 'Project name', value: project.name });
            if (!name) return;
            try {
              const { doc } = await api.loadProject(project.id);
              doc.meta.name = name;
              await api.saveProject(project.id, doc);
              setStatus(`Renamed to “${name}”.`);
              await refresh();
            } catch (error) {
              setStatus(describeError(error), 'error');
            }
          },
        }),
        button('Download package', 'btn btn--tiny', { onclick: () => downloadPackage(project) }),
        project.hasDraft
          ? button('Recover draft', 'btn btn--tiny', { onclick: () => showDraft(project, draftHost) })
          : null,
        button('Delete', 'btn btn--tiny btn--danger', {
          onclick: async () => {
            const confirmed = await confirmDialog({
              title: 'Delete project',
              message: `Delete “${project.name}” from the workspace folder? Its media stays in the library.`,
              confirmLabel: 'Delete',
              danger: true,
            });
            if (!confirmed) return;
            try {
              await api.deleteProject(project.id);
              setStatus(`Deleted “${project.name}”.`);
              await refresh();
            } catch (error) {
              setStatus(describeError(error), 'error');
            }
          },
        }),
      ]),
    ]);
    return el('div', {}, [tile, draftHost]);
  }

  /** @param {File} file */
  async function importProject(file) {
    setStatus(`Importing “${file.name}”…`);
    showProgress(0.2, 'Reading the package');
    try {
      const result = await api.importProjectFile(file);
      setStatus(`Imported “${result.project?.name ?? file.name}” with ${result.importedAssets ?? 0} media file(s).`);
      store.notify('ok', `Imported “${result.project?.name ?? file.name}”.`, { title: 'Import' });
      for (const issue of result.issues ?? []) {
        if (issue.level !== 'info') store.notify(issue.level, issue.message, { title: 'Imported project' });
      }
      await refresh();
    } catch (error) {
      setStatus(describeError(error), 'error');
      store.notify('error', describeError(error), { title: 'Import failed' });
    } finally {
      hideProgress();
    }
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) await importProject(file);
  });

  async function refresh() {
    setStatus('Loading projects…');
    try {
      const { projects } = await api.listProjects();
      if (projects.length === 0) {
        clear(list);
        list.append(emptyState('No projects yet. Start a new one, or pick a starter project to see how Motion Lab fits together.'));
      } else {
        list.replaceChildren(...projects.map(buildTile));
      }
      setStatus(`${projects.length} project${projects.length === 1 ? '' : 's'} on disk.`);
    } catch (error) {
      clear(list);
      setStatus(describeError(error), 'error');
    }
  }

  modal.body.append(
    el('div', { class: 'form-group' }, [
      el('div', { class: 'row row--wrap' }, [
        button('New project', 'btn btn--primary', {
          onclick: async () => {
            modal.close();
            await onNew?.();
          },
        }),
        button('Starter projects', 'btn', {
          onclick: async () => {
            modal.close();
            await onTemplates?.();
          },
        }),
        button('Import package…', 'btn', { onclick: () => fileInput.click() }),
        fileInput,
      ]),
      hint('info', workspacePath
        ? `Projects live in the workspace folder on disk: ${workspacePath}. A package (.mlab.zip) carries the project document and its media, so it can be moved to another machine.`
        : 'Projects live in the workspace folder on disk, next to the media library. A package (.zip) carries the project document and its media.'),
    ]),
    progressHost,
    list,
    status,
  );
  modal.foot.append(
    el('div', { class: 'spacer' }),
    button('Close', 'btn', { onclick: () => modal.close() }),
  );

  refresh();
  return { close: () => modal.close(), refresh };
}

/* ------------------------------------------------------------------ *
 * Project settings
 * ------------------------------------------------------------------ */

/** The composition presets offered as chips in settings and export. */
const COMPOSITION_PRESETS = Object.freeze([
  { id: 'landscape', label: 'Landscape', width: 1920, height: 1080, aspect: 'landscape' },
  { id: 'portrait', label: 'Portrait', width: 1080, height: 1920, aspect: 'portrait' },
  { id: 'square', label: 'Square', width: 1080, height: 1080, aspect: 'square' },
  { id: 'landscape-4k', label: '4K landscape', width: 3840, height: 2160, aspect: 'landscape' },
  { id: 'portrait-4k', label: 'Vertical 4K', width: 2160, height: 3840, aspect: 'portrait' },
]);

/**
 * Count what a re-snap to `fps` would move, without touching the document.
 *
 * @param {ProjectDoc} doc
 * @param {number} fps
 * @param {number} duration
 * @returns {{clips:number, clipsShifted:number, clipsBeyond:number, keysMoved:number, totalKeys:number}}
 */
function snapReport(doc, fps, duration) {
  let clips = 0;
  let clipsShifted = 0;
  let clipsBeyond = 0;
  let keysMoved = 0;
  let totalKeys = 0;
  for (const clip of doc.clips) {
    const start = snapToFrame(clip.start, fps);
    const length = Math.max(1 / fps, snapToFrame(clip.duration, fps));
    if (Math.abs(start - clip.start) > 1e-9) clipsShifted += 1;
    if (Math.abs(start - clip.start) > 1e-9 || Math.abs(length - clip.duration) > 1e-9) clips += 1;
    if (start + length > duration + 1e-9) clipsBeyond += 1;
    for (const channel of clip.keyframes) {
      for (const key of channel.keys) {
        totalKeys += 1;
        if (Math.abs(snapToFrame(key.time, fps) - key.time) > 1e-9) keysMoved += 1;
      }
    }
  }
  return { clips, clipsShifted, clipsBeyond, keysMoved, totalKeys };
}

/**
 * Move every key of a channel onto the frame grid, keeping the last value when
 * two keys land on the same frame.
 *
 * @param {import('/core/schema.js').Keyframe[]} keys
 * @param {number} fps
 * @returns {import('/core/schema.js').Keyframe[]}
 */
function resnapKeys(keys, fps) {
  /** @type {Map<number, import('/core/schema.js').Keyframe>} */
  const byTime = new Map();
  for (const key of keys) {
    const time = snapToFrame(key.time, fps);
    const existing = byTime.get(time);
    if (existing) {
      existing.value = key.value;
      existing.ease = key.ease;
    } else {
      byTime.set(time, { ...key, time });
    }
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Composition settings: size, frame rate, duration, background and name, with a
 * live warning about what a frame-grid change will move.
 *
 * Resolution changes never touch clip geometry -- layer transforms are
 * composition-relative, so the framing of every layer survives a resize
 * untouched.
 *
 * @param {object} options
 * @param {import('../store.js').Store} options.store
 * @param {import('../media.js').MediaEngine} [options.media]
 * @param {import('../preview.js').Preview} [options.preview]
 * @param {import('../timeline.js').Timeline} [options.timeline]
 * @param {()=>void} [options.onApply]
 * @returns {{close:()=>void}}
 */
export function openProjectSettings({ store, media, preview, timeline, onApply }) {
  const composition = store.doc.composition;
  const draft = {
    name: store.doc.meta.name,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    duration: composition.duration,
    background: composition.background,
    aspect: composition.aspect,
  };

  const modal = openModal({
    title: 'Project settings',
    subtitle: 'Composition, timing and identity',
    size: 'modal--md',
  });

  const chipRow = el('div', { class: 'chip-row' });
  const widthField = numberField({
    label: 'Width (px)',
    value: draft.width,
    min: 16,
    max: 8192,
    onChange: (value) => {
      draft.width = Math.round(value);
      draft.aspect = 'custom';
      refresh();
    },
  });
  const heightField = numberField({
    label: 'Height (px)',
    value: draft.height,
    min: 16,
    max: 8192,
    onChange: (value) => {
      draft.height = Math.round(value);
      draft.aspect = 'custom';
      refresh();
    },
  });
  const durationField = numberField({
    label: 'Duration (seconds)',
    value: draft.duration,
    min: 0.1,
    max: 3600,
    onChange: (value) => {
      draft.duration = value;
      refresh();
    },
  });
  const liveHint = el('div', {});

  const fpsSelect = select({
    label: 'Frame rate',
    value: String(draft.fps),
    options: FPS_CHOICES.map((fps) => ({ value: String(fps), label: `${fps} fps` })),
    onChange: (value) => {
      draft.fps = Number(value);
      refresh();
    },
  });

  const nameField = textField({
    label: 'Project name',
    value: draft.name,
    onChange: (value) => {
      draft.name = value;
      refresh();
    },
  });

  const backgroundField = colorField({
    label: 'Background colour',
    value: draft.background,
    onChange: (value) => {
      draft.background = value;
    },
  });

  /**
   * @param {number} width
   * @param {number} height
   * @param {string} aspect
   */
  function applyPreset(width, height, aspect) {
    draft.width = width;
    draft.height = height;
    draft.aspect = aspect;
    widthField.set(width);
    heightField.set(height);
    refresh();
  }

  function refresh() {
    const custom = !COMPOSITION_PRESETS.some((preset) => preset.width === draft.width && preset.height === draft.height);
    chipRow.replaceChildren(
      ...COMPOSITION_PRESETS.map((preset) => button(
        preset.label,
        `chip${draft.width === preset.width && draft.height === preset.height ? ' chip--active' : ''}`,
        {
          title: `${preset.width}×${preset.height}`,
          onclick: () => applyPreset(preset.width, preset.height, preset.aspect),
        },
      )),
      button(
        'Custom',
        `chip${custom ? ' chip--active' : ''}`,
        {
          title: 'Type any size in the width and height fields',
          onclick: () => {
            draft.aspect = 'custom';
            widthField.input.focus();
            refresh();
          },
        },
      ),
    );

    const report = snapReport(store.doc, draft.fps, draft.duration);
    const children = [];
    if (report.clipsShifted === 0 && report.keysMoved === 0) {
      children.push(hint('info', `Nothing moves: every clip start, clip duration and keyframe already sits on the ${draft.fps} fps grid.`));
    } else {
      children.push(hint(
        report.clipsShifted > 0 ? 'warn' : 'info',
        `${report.clipsShifted} of ${store.doc.clips.length} clips shift, and ${report.keysMoved} of ${report.totalKeys} keyframes move, `
        + `when the timing is re-snapped to the ${draft.fps} fps grid.`,
      ));
    }
    if (report.clipsBeyond > 0) {
      children.push(hint('warn', `${report.clipsBeyond} clip${report.clipsBeyond === 1 ? '' : 's'} extend past the new duration. They keep rendering, but playback and exports stop at the composition end.`));
    }
    if (draft.width !== composition.width || draft.height !== composition.height) {
      children.push(hint('info', 'Changing the resolution does not scale any layer: clip geometry is stored relative to the composition, so every layer keeps its framing at the new size.'));
    }
    if (draft.background !== composition.background) {
      children.push(hint('info', 'The background paints underneath every layer and shows wherever nothing is drawn.'));
    }
    replaceChildren(liveHint, children);
  }

  modal.body.append(
    el('div', { class: 'form-group' }, [
      el('div', { class: 'form-group__label', text: 'Composition preset' }),
      chipRow,
    ]),
    el('div', { class: 'form-group' }, [
      el('div', { class: 'form-group__label', text: 'Size' }),
      el('div', { class: 'grid-2' }, [widthField.root, heightField.root]),
    ]),
    el('div', { class: 'form-group' }, [
      el('div', { class: 'form-group__label', text: 'Timing' }),
      el('div', { class: 'grid-2' }, [fpsSelect, durationField.root]),
      hint('info', 'Changing the frame rate re-snaps the animation timing: every clip start, clip duration and keyframe moves to the nearest frame of the new grid.'),
    ]),
    el('div', { class: 'form-group' }, [
      el('div', { class: 'form-group__label', text: 'Identity' }),
      el('div', { class: 'grid-2' }, [nameField, backgroundField]),
    ]),
    el('div', { class: 'form-group' }, [
      el('div', { class: 'form-group__label', text: 'What will change' }),
      liveHint,
    ]),
  );
  modal.foot.append(
    el('div', { class: 'spacer' }),
    button('Cancel', 'btn', { onclick: () => modal.close() }),
    button('Apply', 'btn btn--primary', {
      onclick: () => {
        const fps = FPS_CHOICES.includes(/** @type {any} */ (draft.fps)) ? draft.fps : composition.fps;
        const width = Math.round(clampNumber(draft.width, 16, 8192));
        const height = Math.round(clampNumber(draft.height, 16, 8192));
        const duration = clampNumber(draft.duration, 0.1, 3600);
        const background = draft.background;
        const aspect = /** @type {any} */ (draft.aspect);
        const name = draft.name.trim() || 'Untitled composition';

        store.edit('Project settings', () => {
          const target = store.doc.composition;
          target.width = width;
          target.height = height;
          target.fps = fps;
          target.duration = duration;
          target.background = background;
          target.aspect = aspect;
          store.doc.meta.name = name;

          for (const clip of store.doc.clips) {
            clip.start = snapToFrame(clip.start, fps);
            clip.duration = Math.max(1 / fps, snapToFrame(clip.duration, fps));
            for (const channel of clip.keyframes) channel.keys = resnapKeys(channel.keys, fps);
            clip.keyframes = clip.keyframes.filter((channel) => channel.keys.length > 0);
          }
          store.doc.exportRange.in = snapToFrame(store.doc.exportRange.in, fps);
          store.doc.exportRange.out = snapToFrame(store.doc.exportRange.out, fps);
          store.doc.loopRange.in = snapToFrame(store.doc.loopRange.in, fps);
          store.doc.loopRange.out = snapToFrame(store.doc.loopRange.out, fps);
          clampRanges(store.doc);
        });

        store.notify('ok', `Composition set to ${width}×${height} @ ${fps} fps, ${duration}s.`, { title: 'Project settings' });
        modal.close();
        if (onApply) onApply();
        else {
          preview?.layout();
          preview?.invalidate(true);
          timeline?.rebuildHeads();
          timeline?.invalidate(true);
        }
      },
    }),
  );

  refresh();
  return { close: () => modal.close() };
}

/* ------------------------------------------------------------------ *
 * Recovery
 * ------------------------------------------------------------------ */

/**
 * Crash-recovery prompt: the draft against the saved version, with Recover and
 * Discard wired straight to the caller.
 *
 * @param {object} options
 * @param {import('../store.js').Store} options.store
 * @param {{savedAt?:number, reason?:string, doc?:unknown}|null} options.draft
 * @param {()=>void} options.onRecover
 * @param {()=>void} options.onDiscard
 * @returns {{close:()=>void}}
 */
export function openRecoveryDialog({ store, draft, onRecover, onDiscard }) {
  const modal = openModal({
    title: 'Recover unsaved work',
    subtitle: 'Motion Lab autosaves while you edit',
    size: 'modal--sm',
  });

  if (!draft?.doc) {
    modal.body.append(
      hint('info', 'There is no draft to recover for this project. The saved version is open.'),
    );
    modal.foot.append(
      el('div', { class: 'spacer' }),
      button('Close', 'btn btn--primary', { onclick: () => modal.close() }),
    );
    return { close: () => modal.close() };
  }

  const { doc: draftDoc, issues } = normalizeProject(draft.doc);
  const savedDoc = store.doc;

  modal.body.append(
    el('div', { class: 'form-group' }, [
      el('div', { class: 'form-group__label', text: 'Draft' }),
      kvList([
        ['Autosaved', new Date(draft.savedAt ?? Date.now()).toLocaleString()],
        ['Reason', String(draft.reason ?? 'autosave')],
        ['Project', draftDoc.meta.name],
      ]),
    ]),
    el('div', { class: 'form-group' }, [
      el('div', { class: 'form-group__label', text: 'Draft against the saved version' }),
      kvList([
        ['Clips', `${draftDoc.clips.length} draft · ${savedDoc.clips.length} saved`],
        ['Tracks', `${draftDoc.tracks.length} draft · ${savedDoc.tracks.length} saved`],
        ['Duration', `${draftDoc.composition.duration}s draft · ${savedDoc.composition.duration}s saved`],
        ['Frame rate', `${draftDoc.composition.fps} fps draft · ${savedDoc.composition.fps} fps saved`],
      ]),
    ]),
    hint(
      'info',
      'Recovering replaces what is open in the editor with the draft. Discarding keeps the saved version and deletes the draft from disk.',
    ),
    ...issues.filter((issue) => issue.level !== 'info').map((issue) => hint(issue.level, issue.message)),
  );
  modal.foot.append(
    el('div', { class: 'spacer' }),
    button('Discard draft', 'btn btn--danger', {
      onclick: () => {
        modal.close();
        onDiscard?.();
      },
    }),
    button('Recover draft', 'btn btn--primary', {
      onclick: () => {
        modal.close();
        onRecover?.();
      },
    }),
  );
  return { close: () => modal.close() };
}

/* ------------------------------------------------------------------ *
 * Starter projects
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} StarterProject
 * @property {string} name
 * @property {string} category
 * @property {string} description
 * @property {ProjectDoc} doc
 */

/**
 * A deep, cycle-free copy of a document -- used for the template preset payload
 * so a preset never contains the document that contains it.
 * @param {ProjectDoc} doc
 * @returns {ProjectDoc}
 */
function documentPayload(doc) {
  return /** @type {ProjectDoc} */ (JSON.parse(JSON.stringify({ ...doc, presets: [] })));
}

/**
 * Starter 1: portrait audio-reactive poster. The aurora bed, rings and bars are
 * real procedural layers; the two scale connections and the opacity connection
 * are wired to the rings and bars already, and light up as soon as an analysed
 * track is chosen as their source.
 *
 * @returns {StarterProject}
 */
function buildAudioReactivePoster() {
  const doc = createProject(
    { name: 'Audio-reactive poster' },
    { width: 1080, height: 1920, fps: 30, duration: 12, background: '#05060e', aspect: 'portrait' },
  );
  const [overlay, main, background] = doc.tracks;

  const bed = defaultClip({
    name: 'Aurora bed',
    kind: 'graphic',
    trackId: background.id,
    start: 0,
    duration: 12,
    seed: 2311,
    graphic: {
      ...defaultGraphic('gradient'),
      kind: 'gradient',
      gradientKind: 'aurora',
      colorA: '#12043a',
      colorB: '#0b7ea8',
      colorC: '#ff2e88',
      amount: 0.72,
      speed: 0.45,
      complexity: 4,
      size: 1,
      width: 1,
      height: 1,
    },
  });
  for (const channel of ['transform.scale.x', 'transform.scale.y']) {
    setKeyframe(bed, channel, 0, 1, easingPreset('Ease in-out'));
    setKeyframe(bed, channel, 6, 1.14, easingPreset('Ease in-out'));
    setKeyframe(bed, channel, 12, 1.02, easingPreset('Ease in-out'));
  }

  const rings = defaultClip({
    name: 'Bass rings',
    kind: 'graphic',
    trackId: main.id,
    start: 0,
    duration: 12,
    seed: 515,
    graphic: {
      ...defaultGraphic('rings'),
      kind: 'rings',
      count: 7,
      colorA: '#ff2e88',
      colorB: '#12d6ff',
      colorC: '#ffd166',
      amount: 0.55,
      speed: 0.9,
      size: 0.82,
      spread: 0.55,
      complexity: 3,
    },
  });
  rings.blend = 'screen';
  rings.transform = { ...rings.transform, opacity: 0.9 };

  const bars = defaultClip({
    name: 'Mid bars',
    kind: 'graphic',
    trackId: main.id,
    start: 0,
    duration: 12,
    seed: 808,
    graphic: {
      ...defaultGraphic('bars'),
      kind: 'bars',
      bandCount: 56,
      mirror: true,
      smoothing: 0.55,
      colorA: '#12d6ff',
      colorB: '#ff2e88',
      amount: 0.7,
      size: 0.6,
      speed: 1,
    },
  });
  bars.blend = 'screen';
  bars.transform = { ...bars.transform, y: 470, scaleX: 1.04, scaleY: 0.5 };

  const title = defaultClip({
    name: 'Poster title',
    kind: 'text',
    trackId: overlay.id,
    start: 0.4,
    duration: 11.4,
    seed: 7,
  });
  title.text = {
    ...defaultTextStyle(),
    content: 'PULSE\nPOSTER',
    fontSize: 132,
    fontWeight: 800,
    letterSpacing: 10,
    lineHeight: 1.02,
    uppercase: true,
    align: 'center',
    baseline: 'middle',
    maxWidth: 820,
    color: '#ffffff',
    gradientFrom: '#ff2e88',
    gradientTo: '#12d6ff',
    shadowColor: 'rgba(4,4,12,0.72)',
    shadowBlur: 30,
    shadowY: 12,
  };
  title.masks.push({
    id: uid('mask'),
    name: 'Title band',
    shape: 'rect',
    enabled: true,
    inverted: false,
    position: { x: 0.5, y: 0.5 },
    size: { x: 0.94, y: 0.3 },
    rotation: 0,
    roundness: 0.06,
    feather: 0.02,
    opacity: 1,
    points: [],
    pointsClosed: true,
  });
  // Six keyframes: a fade-in and a slow zoom on both axes.
  setKeyframe(title, 'transform.opacity', 0.8, 0, easingPreset('Ease out'));
  setKeyframe(title, 'transform.opacity', 2.4, 1, easingPreset('Ease out'));
  setKeyframe(title, 'transform.scale.x', 0.8, 0.94, easingPreset('Ease in-out'));
  setKeyframe(title, 'transform.scale.x', 7.5, 1.08, easingPreset('Ease in-out'));
  setKeyframe(title, 'transform.scale.y', 0.8, 0.94, easingPreset('Ease in-out'));
  setKeyframe(title, 'transform.scale.y', 7.5, 1.08, easingPreset('Ease in-out'));

  doc.clips.push(bed, rings, bars, title);
  doc.mappings.push(
    createMapping('', 'transform.scale.x', {
      name: 'Bass → ring scale X',
      band: 'low',
      clipId: rings.id,
      sensitivity: 1.35,
      min: 0.8,
      max: 1.45,
      smoothing: 0.4,
      attack: 0.01,
      release: 0.2,
      mode: 'set',
    }),
    createMapping('', 'transform.scale.y', {
      name: 'Bass → ring scale Y',
      band: 'low',
      clipId: rings.id,
      sensitivity: 1.35,
      min: 0.8,
      max: 1.45,
      smoothing: 0.4,
      attack: 0.01,
      release: 0.2,
      mode: 'set',
    }),
    createMapping('', 'transform.opacity', {
      name: 'Mids → bar opacity',
      band: 'mid',
      clipId: bars.id,
      sensitivity: 1.5,
      min: 0.3,
      max: 1,
      smoothing: 0.5,
      attack: 0.02,
      release: 0.24,
      mode: 'set',
    }),
  );
  doc.notes = [
    'The three audio connections are already aimed at the rings and the bars: open the Audio panel, choose an analysed track as their source, and the poster starts moving with the music.',
  ];
  return {
    name: 'Audio-reactive poster',
    category: 'Audio reactive',
    description: '1080×1920 · 30 fps · 12 s — aurora bed, bass-driven rings, mid-driven bars and a masked gradient title.',
    doc,
  };
}

/**
 * Starter 2: landscape stylised reel. Three media slots sit on their own tracks
 * and cross-fade; each carries a different treatment, and a teal/orange duotone
 * adjustment layer grades everything underneath.
 *
 * @returns {StarterProject}
 */
function buildStylisedReel() {
  const doc = createProject(
    { name: 'Stylised video reel' },
    { width: 1920, height: 1080, fps: 30, duration: 20, background: '#08080c', aspect: 'landscape' },
  );
  const musicTrack = doc.tracks.find((track) => track.kind === 'audio');
  const titleTrack = defaultTrack({ name: 'Title', kind: 'visual', height: 74 });
  const gradeTrack = defaultTrack({ name: 'Teal & orange grade', kind: 'adjustment', height: 74 });
  const slot3Track = defaultTrack({ name: 'Slot 3', kind: 'visual' });
  const slot2Track = defaultTrack({ name: 'Slot 2', kind: 'visual' });
  const slot1Track = defaultTrack({ name: 'Slot 1', kind: 'visual' });
  // Track order is top-down: index 0 draws last, so the title and the grade sit
  // above the three slots.
  doc.tracks = [titleTrack, gradeTrack, slot3Track, slot2Track, slot1Track, musicTrack];

  const slot1 = defaultClip({
    name: 'Clip 1 (drop media here)',
    kind: 'video',
    assetId: '',
    trackId: slot1Track.id,
    start: 0,
    duration: 8,
    seed: 101,
  });
  slot1.effects.stack.push(
    {
      id: uid('fx'),
      type: 'halftone',
      enabled: true,
      seed: 1201,
      params: { ...defaultParams('halftone'), spacing: 8, dotSize: 104, angle: 42, ink: '#0d0d14', paper: '#f2ece0' },
    },
    {
      id: uid('fx'),
      type: 'contrast',
      enabled: true,
      seed: 1202,
      params: { ...defaultParams('contrast'), amount: 26, pivot: 48 },
    },
  );
  setKeyframe(slot1, 'transform.opacity', 0, 1, easingPreset('Linear'));
  setKeyframe(slot1, 'transform.opacity', 6.5, 1, easingPreset('Ease in-out'));
  setKeyframe(slot1, 'transform.opacity', 8, 0, easingPreset('Ease in-out'));
  setKeyframe(slot1, 'transform.scale.x', 0, 1.04, easingPreset('Ease in-out'));
  setKeyframe(slot1, 'transform.scale.x', 8, 1.16, easingPreset('Ease in-out'));

  const slot2 = defaultClip({
    name: 'Clip 2 (drop media here)',
    kind: 'video',
    assetId: '',
    trackId: slot2Track.id,
    start: 6,
    duration: 8,
    seed: 202,
  });
  slot2.effects.stack.push({
    id: uid('fx'),
    type: 'frameStep',
    enabled: true,
    seed: 2201,
    params: { ...defaultParams('frameStep'), hold: 3, mix: 100 },
  });
  setKeyframe(slot2, 'transform.opacity', 6, 0, easingPreset('Ease in-out'));
  setKeyframe(slot2, 'transform.opacity', 8, 1, easingPreset('Linear'));
  setKeyframe(slot2, 'transform.opacity', 12.5, 1, easingPreset('Ease in-out'));
  setKeyframe(slot2, 'transform.opacity', 14, 0, easingPreset('Ease in-out'));
  setKeyframe(slot2, 'transform.scale.y', 6, 1.14, easingPreset('Ease in-out'));
  setKeyframe(slot2, 'transform.scale.y', 14, 1.02, easingPreset('Ease in-out'));

  const slot3 = defaultClip({
    name: 'Clip 3 (drop media here)',
    kind: 'image',
    assetId: '',
    trackId: slot3Track.id,
    start: 13,
    duration: 7,
    seed: 303,
  });
  slot3.effects.stack.push({
    id: uid('fx'),
    type: 'wave',
    enabled: true,
    seed: 3201,
    params: { ...defaultParams('wave'), amplitude: 18, wavelength: 120, animate: 0.5, waveKind: 'sine' },
  });
  setKeyframe(slot3, 'transform.opacity', 13, 0, easingPreset('Ease in-out'));
  setKeyframe(slot3, 'transform.opacity', 15, 1, easingPreset('Linear'));
  setKeyframe(slot3, 'transform.opacity', 20, 1, easingPreset('Linear'));
  setKeyframe(slot3, 'transform.rotation', 13, -3, easingPreset('Ease in-out'));
  setKeyframe(slot3, 'transform.rotation', 20, 3, easingPreset('Ease in-out'));

  const grade = defaultClip({
    name: 'Teal & orange',
    kind: 'adjustment',
    trackId: gradeTrack.id,
    start: 0,
    duration: 20,
    seed: 33,
  });
  grade.effects.stack.push({
    id: uid('fx'),
    type: 'duotone',
    enabled: true,
    seed: 3301,
    params: { ...defaultParams('duotone'), shadowColor: '#0e3b3f', highlightColor: '#ff8a3d', strength: 68, midpoint: 52 },
  });

  const heading = defaultClip({
    name: 'Reel title',
    kind: 'text',
    trackId: titleTrack.id,
    start: 0,
    duration: 20,
    seed: 9,
  });
  heading.text = {
    ...defaultTextStyle(),
    content: 'REEL 01',
    fontSize: 148,
    fontWeight: 800,
    letterSpacing: 18,
    uppercase: true,
    align: 'center',
    baseline: 'middle',
    maxWidth: 1400,
    color: '#f6f1e7',
    gradientFrom: '#ffffff',
    gradientTo: '#ffd9a8',
    shadowColor: 'rgba(0,0,0,0.6)',
    shadowBlur: 26,
    shadowY: 10,
  };
  heading.masks.push({
    id: uid('mask'),
    name: 'Caption band',
    shape: 'rect',
    enabled: true,
    inverted: false,
    position: { x: 0.5, y: 0.8 },
    size: { x: 0.62, y: 0.16 },
    rotation: 0,
    roundness: 0.08,
    feather: 0.06,
    opacity: 1,
    points: [],
    pointsClosed: true,
  });
  setKeyframe(heading, 'transform.opacity', 0.6, 0, easingPreset('Ease out'));
  setKeyframe(heading, 'transform.opacity', 2, 1, easingPreset('Linear'));
  setKeyframe(heading, 'transform.opacity', 18.5, 1, easingPreset('Ease in'));
  setKeyframe(heading, 'transform.opacity', 20, 0, easingPreset('Ease in'));
  setKeyframe(heading, 'transform.position.y', 0.6, 90, easingPreset('Ease out'));
  setKeyframe(heading, 'transform.position.y', 2.6, 0, easingPreset('Ease in-out'));

  doc.clips.push(slot1, slot2, slot3, grade, heading);
  doc.notes = [
    'Drop a video or photo onto each of the three slots in the media library — the cross-fade, the halftone, the frame stepping, the wave and the duotone grade are already in place.',
    'The Music track is empty on purpose: drop a track on it and the reel keeps its timing.',
  ];
  return {
    name: 'Stylised video reel',
    category: 'Video',
    description: '1920×1080 · 30 fps · 20 s — three cross-fading slots with halftone, frame stepping and wave treatments under a teal/orange grade.',
    doc,
  };
}

/**
 * Starter 3: portrait animated photograph with a slow zoom, a horizontal drift,
 * grain, vignette, scratches and a masked caption.
 *
 * @returns {StarterProject}
 */
function buildAnimatedPhotograph() {
  const doc = createProject(
    { name: 'Animated photograph' },
    { width: 1080, height: 1920, fps: 25, duration: 15, background: '#0a0a0f', aspect: 'portrait' },
  );
  const [overlay, main] = doc.tracks;

  const photo = defaultClip({
    name: 'Photo (drop an image here)',
    kind: 'image',
    assetId: '',
    trackId: main.id,
    start: 0,
    duration: 15,
    seed: 61,
  });
  setKeyframe(photo, 'transform.scale.x', 0, 1, easingPreset('Ease in-out'));
  setKeyframe(photo, 'transform.scale.x', 15, 1.35, easingPreset('Ease in-out'));
  setKeyframe(photo, 'transform.scale.y', 0, 1, easingPreset('Ease in-out'));
  setKeyframe(photo, 'transform.scale.y', 15, 1.35, easingPreset('Ease in-out'));
  setKeyframe(photo, 'transform.position.x', 0, -34, easingPreset('Ease in-out'));
  setKeyframe(photo, 'transform.position.x', 7.5, 18, easingPreset('Ease in-out'));
  setKeyframe(photo, 'transform.position.x', 15, 34, easingPreset('Ease in-out'));
  photo.effects.stack.push(
    {
      id: uid('fx'),
      type: 'grain',
      enabled: true,
      seed: 6101,
      params: { ...defaultParams('grain'), size: 1.6, amount: 24, colored: false, animate: 8 },
    },
    {
      id: uid('fx'),
      type: 'vignette',
      enabled: true,
      seed: 6102,
      params: { ...defaultParams('vignette'), amount: 44, softness: 55 },
    },
    {
      id: uid('fx'),
      type: 'scratches',
      enabled: true,
      seed: 6103,
      params: { ...defaultParams('scratches'), count: 10, length: 92, width: 1.1, opacity: 26, jitter: 0.4, bright: false },
    },
  );

  const caption = defaultClip({
    name: 'Caption',
    kind: 'text',
    trackId: overlay.id,
    start: 0.5,
    duration: 13,
    seed: 12,
  });
  caption.text = {
    ...defaultTextStyle(),
    content: 'still, but moving',
    fontSize: 84,
    fontWeight: 500,
    italic: true,
    letterSpacing: 2,
    align: 'center',
    baseline: 'middle',
    maxWidth: 860,
    color: '#f4f1ea',
    shadowColor: 'rgba(0,0,0,0.55)',
    shadowBlur: 18,
    shadowY: 6,
  };
  caption.masks.push({
    id: uid('mask'),
    name: 'Ellipse mask',
    shape: 'ellipse',
    enabled: true,
    inverted: false,
    position: { x: 0.5, y: 0.78 },
    size: { x: 0.92, y: 0.2 },
    rotation: 0,
    roundness: 0,
    feather: 0.34,
    opacity: 1,
    points: [],
    pointsClosed: true,
  });
  setKeyframe(caption, 'transform.opacity', 1, 0, easingPreset('Ease out'));
  setKeyframe(caption, 'transform.opacity', 2.8, 1, easingPreset('Linear'));
  setKeyframe(caption, 'transform.position.y', 1, 40, easingPreset('Ease out'));
  setKeyframe(caption, 'transform.position.y', 3.4, 0, easingPreset('Ease in-out'));

  doc.clips.push(photo, caption);
  doc.notes = [
    'Drop a photograph onto the “Photo (drop an image here)” clip in the media library — the zoom, drift, grain, vignette and scratches keep their timing.',
  ];
  return {
    name: 'Animated photograph',
    category: 'Photo',
    description: '1080×1920 · 25 fps · 15 s — a slow push in with a drift, grain, vignette and scratches, plus a masked italic caption.',
    doc,
  };
}

/**
 * Build the three starter projects and give each one a `template` preset for all
 * three, so a project opened from a starter carries the whole set.
 *
 * @returns {StarterProject[]}
 */
function buildStarterProjects() {
  const starters = [buildAudioReactivePoster(), buildStylisedReel(), buildAnimatedPhotograph()];
  const payloads = starters.map((starter) => documentPayload(starter.doc));
  const createdAt = Date.now();
  for (const starter of starters) {
    starter.doc.presets = starters.map((entry, index) => ({
      id: uid('preset'),
      name: entry.name,
      kind: /** @type {'template'} */ ('template'),
      category: entry.category,
      description: entry.description,
      createdAt,
      data: payloads[index],
    }));
  }
  return starters;
}

/**
 * Render a document frame into a fixed-size canvas, letterboxed so portrait and
 * square compositions are not stretched by the tile.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {ProjectDoc} doc
 * @param {object} [options]
 * @param {number} [options.time]
 * @param {any} [options.frameSource]
 */
function drawDocumentPreview(canvas, doc, options = {}) {
  const width = canvas.width;
  const height = canvas.height;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = doc.composition.background || '#0a0a0f';
  ctx.fillRect(0, 0, width, height);
  const time = options.time ?? Math.min(doc.composition.duration * 0.35, 4);
  const renderHeight = 320;
  const renderWidth = Math.max(16, Math.round(renderHeight * (doc.composition.width / doc.composition.height)));
  const { canvas: frame } = renderFrameToCanvas(doc, time, {
    width: renderWidth,
    height: renderHeight,
    frameSource: options.frameSource,
  });
  const scale = Math.min(width / renderWidth, height / renderHeight);
  const drawWidth = renderWidth * scale;
  const drawHeight = renderHeight * scale;
  ctx.drawImage(
    /** @type {any} */ (frame),
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

/**
 * The starter-project picker. Each tile is a real render of the document it
 * would open, and clicking one hands the finished document to `onUse`.
 *
 * @param {object} options
 * @param {import('../store.js').Store} options.store
 * @param {import('../api.js').api} options.api
 * @param {import('../media.js').MediaEngine} [options.media]
 * @param {(doc:ProjectDoc, name:string)=>void|Promise<void>} options.onUse
 * @returns {{close:()=>void}}
 */
export function openTemplatesDialog({ store, api, media, onUse }) {
  const modal = openModal({
    title: 'Starter projects',
    subtitle: 'Real animation, effects and audio connections — swap the media and keep the timing',
    size: 'modal--lg',
  });

  const starters = buildStarterProjects();
  const grid = el('div', { class: 'picker-grid' });

  for (const starter of starters) {
    const canvas = el('canvas', { width: '320', height: '180' });
    const tile = /** @type {HTMLButtonElement} */ (el('button', {
      class: 'picker-tile',
      title: `Use “${starter.name}”`,
      onclick: async () => {
        modal.close();
        await onUse?.(starter.doc, starter.name);
      },
    }, [
      el('div', { class: 'picker-tile__thumb' }, [canvas]),
      el('div', { class: 'picker-tile__label', text: starter.name }),
      el('div', { class: 'picker-tile__sub', text: `${starter.category} — ${starter.description}` }),
    ]));
    grid.append(tile);
    try {
      drawDocumentPreview(canvas, starter.doc, { frameSource: media?.frameSource });
    } catch (error) {
      const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
      ctx.fillStyle = '#0a0a0f';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#8a8f9c';
      ctx.font = '14px monospace';
      ctx.fillText('Preview unavailable', 12, 24);
      store.notify('warn', `The preview for “${starter.name}” could not be drawn: ${describeError(error)}`, { title: 'Starter projects' });
    }
  }

  const available = [...store.assets.values()].filter((asset) => asset.status === 'ok');
  const savedHint = hint('info', available.length
    ? `Each starter opens as an unsaved project: edit it, then save it. Your ${available.length} library item${available.length === 1 ? '' : 's'} stay available while you swap media into the slots.`
    : 'Each starter opens as an unsaved project: edit it, then save it. Import media afterwards and drop it onto the named slots.');
  modal.body.append(
    savedHint,
    grid,
    el('div', { class: 'form-group' }, [
      el('div', { class: 'form-group__label', text: 'What each starter contains' }),
      kvList(starters.map((starter) => [starter.name, `${starter.doc.clips.length} clips · ${starter.doc.tracks.length} tracks · ${starter.doc.mappings.length} audio connection${starter.doc.mappings.length === 1 ? '' : 's'}`])),
    ]),
  );
  modal.foot.append(
    el('div', { class: 'spacer' }),
    button('Close', 'btn', { onclick: () => modal.close() }),
  );

  // The saved projects are untouched by a starter; say so with the real count.
  api.listProjects()
    .then(({ projects }) => {
      if (!modal.isOpen()) return;
      savedHint.textContent += ` ${projects.length} saved project${projects.length === 1 ? '' : 's'} in the workspace are not touched.`;
    })
    .catch(() => {
      /* the projects dialog reports a broken server; nothing to add here */
    });

  return { close: () => modal.close() };
}

/* ------------------------------------------------------------------ *
 * About
 * ------------------------------------------------------------------ */

/**
 * The about panel: what the app is, the four stages it renders through, what
 * this machine can do, and where the workspace lives.
 *
 * @param {object} options
 * @param {import('../store.js').Store} options.store
 * @returns {{close:()=>void}}
 */
export function openAboutDialog({ store }) {
  const health = store.session.health;
  const tools = health?.tools ?? null;
  const formats = health?.formats ?? store.session.formats ?? [];
  const usable = formats.filter((format) => format.available);

  const modal = openModal({
    title: 'Motion Lab',
    subtitle: 'A layered, animated studio for photos, video and music',
    size: 'modal--sm',
  });

  modal.body.append(
    el('div', { class: 'form-group' }, [
      el('div', { class: 'form-group__label', text: 'How it fits together' }),
      el('div', { class: 'hint', text: 'Motion Lab renders in four stages: the browser UI edits a JSON project document, a small Node server owns projects, media and export jobs, headless Chrome renders each frame with the exact renderer the preview uses, and ffmpeg encodes those frames together with the mixed soundtrack. That is why an exported frame and a previewed frame are the same picture.' }),
    ]),
    el('div', { class: 'form-group' }, [
      el('div', { class: 'form-group__label', text: 'This machine' }),
      health
        ? kvList([
            ['App version', String(health.version ?? 4)],
            ['Server', String(health.baseUrl ?? 'running')],
            ['Workspace', String(health.workspace ?? 'unknown')],
            ['ffmpeg', tools?.ffmpeg ? String(tools.version ?? 'available') : 'not found'],
            ['ffprobe', tools?.ffprobe ? 'available' : 'not found'],
            ['Hardware acceleration', tools?.hardwareAcceleration ? String(tools.hardwareAcceleration) : 'software encoding'],
            ['Formats available', `${usable.length} of ${formats.length}`],
          ])
        : hint('warn', 'The server has not answered yet, so tool status is unknown. Reload once it is running.'),
    ]),
    el('div', { class: 'form-group' }, [
      el('div', { class: 'form-group__label', text: 'Capabilities' }),
      tools?.ffmpeg
        ? hint('info', `ffmpeg is available, so every supported video format can be encoded. Available right now: ${usable.map((format) => format.label).join(', ') || 'none'}.`)
        : hint('warn', 'ffmpeg is not installed, so video and audio encoding is unavailable. PNG image sequences, still images and project packages still export normally — install ffmpeg and restart to unlock video.'),
      hint('info', 'Frame rendering uses a Chromium-based browser driven over the DevTools protocol. If Chrome or Edge is missing, project-package exports still work; video, PNG and still exports need the browser, and video also needs ffmpeg.'),
    ]),
    el('div', { class: 'form-group' }, [
      el('div', { class: 'form-group__label', text: 'Where your work lives' }),
      hint('info', health?.workspace
        ? `Projects, media and export scratch live under ${health.workspace}. Nothing is uploaded anywhere: the server is local to this machine.`
        : 'Projects, media and exports live in the workspace folder on this machine. Nothing is uploaded anywhere.'),
    ]),
  );
  modal.foot.append(
    el('div', { class: 'spacer' }),
    button('Close', 'btn btn--primary', { onclick: () => modal.close() }),
  );
  return { close: () => modal.close() };
}
