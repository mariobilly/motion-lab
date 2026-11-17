/**
 * Application bootstrap: wires the store, media engine, preview, timeline and
 * panels into the workspace, installs every keyboard shortcut, and owns the
 * save/autosave/recovery cycle.
 */

import { store, bindCurveBuilder } from './store.js';
import { api, ApiError } from './api.js';
import { MediaEngine } from './media.js';
import { AudioEngine } from './playback.js';
import { Preview, canvasToBlob } from './preview.js';
import { Timeline } from './timeline.js';
import { buildMappingCurves } from '/core/audio.js';
import { normalizeProject } from '/core/document.js';
import { createProject, formatTimecode } from '/core/schema.js';
import { button, confirmDialog, el, iconButton, ICONS, menu, promptDialog } from './ui/dom.js';
import { openExportDialog } from './ui/export-dialog.js';
import { openProjectsDialog, openProjectSettings, openRecoveryDialog, openTemplatesDialog, openAboutDialog } from './ui/dialogs.js';
import { openPresetsDialog } from './ui/presets.js';
import { buildLibraryPanel } from './ui/library.js';
import { buildInspector } from './ui/inspector.js';
import { renderTransport, renderTopbar } from './ui/topbar.js';
import { renderToasts } from './ui/toasts.js';

bindCurveBuilder((doc) => [...buildMappingCurves(doc, {
  rangeStart: doc.exportRange.in,
  rangeEnd: doc.exportRange.out,
}).values()]);

const media = new MediaEngine(store);
const audio = new AudioEngine(() => store.doc.audioSettings.masterGain);
const preview = new Preview({ store, media, audio });
const timeline = new Timeline({ store, media, preview });

/* Re-exported for the browser smoke test and for troubleshooting from the
   console. The smoke test asserts it is driving these very instances. */
window.__motionLab = {
  store, media, audio, preview, timeline, api,
  version: 1,
};

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

function buildShell() {
  const topbar = el('div', { class: 'topbar' });
  const transport = el('div', { class: 'transport' });
  const libraryPanel = el('section', { class: 'panel panel--left' });
  const centerPanel = el('section', { class: 'panel panel--center' });
  const inspectorPanel = el('section', { class: 'panel panel--right' });
  const workspace = el('div', { class: 'workspace' }, [libraryPanel, centerPanel, inspectorPanel]);
  const timelineSlot = el('div', {}, [timeline.root]);

  const app = document.getElementById('app');
  app.replaceChildren(topbar, transport, workspace, timelineSlot);
  app.setAttribute('aria-busy', 'false');

  centerPanel.append(preview.root);

  return {
    topbar, transport, libraryPanel, centerPanel, inspectorPanel, workspace,
  };
}

const shell = buildShell();

const library = buildLibraryPanel({ store, media, preview, timeline, api });
shell.libraryPanel.append(library.root);

const inspector = buildInspector({ store, media, preview, api });
shell.inspectorPanel.append(inspector.root);

function renderChrome() {
  renderTopbar(shell.topbar, { store, media, preview, timeline, api, actions });
  renderTransport(shell.transport, { store, media, preview, audio, timeline, actions });
  renderToasts();
}

/* ------------------------------------------------------------------ *
 * Actions shared by the menus
 * ------------------------------------------------------------------ */

const actions = {
  async newProject(options = {}) {
    if (!(await confirmDiscard())) return;
    const doc = createProject(
      { name: options.name ?? 'Untitled composition' },
      options.composition ?? { width: 1920, height: 1080, fps: 30, duration: 20 },
    );
    for (const asset of store.assets.values()) doc.assets.push(asset);
    store.loadDocument(doc, { projectId: null });
    store.session.projectId = null;
    store.session.dirty = true;
    store.session.saveState = 'dirty';
    media.releaseAll();
    await media.preloadDocument();
    preview.layout();
    preview.invalidate(true);
    timeline.rebuildHeads();
    timeline.fit();
    renderChrome();
    renderPanels();
  },

  async openProjects() {
    openProjectsDialog({
      store,
      api,
      onOpen: async (id) => {
        if (!(await confirmDiscard())) return;
        await loadProject(id);
      },
      onNew: () => actions.newProject(),
      onTemplates: () => actions.openTemplates(),
    });
  },

  async openTemplates() {
    openTemplatesDialog({
      store,
      api,
      media,
      onUse: async (doc, name) => {
        if (!(await confirmDiscard())) return;
        store.loadDocument(doc, { projectId: null });
        store.session.projectId = null;
        store.doc.meta.name = name;
        store.session.dirty = true;
        store.session.saveState = 'dirty';
        await afterLoad();
        store.notify('ok', `"${name}" is ready. Replace any sample media from the library — the animation and effects stay.`, {
          title: 'Starter project',
        });
      },
    });
  },

  async save(saveAs = false) {
    try {
      const doc = store.doc;
      if (!store.session.projectId || saveAs) {
        const created = await api.createProject(doc);
        store.session.projectId = created.project.id;
      } else {
        await api.saveProject(store.session.projectId, doc);
      }
      // A successful save supersedes any crash-recovery draft.
      if (store.session.projectId) api.clearDraft(store.session.projectId).catch(() => {});
      store.session.dirty = false;
      store.session.saveState = 'saved';
      store.session.lastSavedAt = Date.now();
      store.emit('ui');
    } catch (error) {
      store.session.saveState = 'error';
      store.emit('ui');
      store.notify('error', `Could not save: ${describeError(error)}`, { title: 'Save failed' });
    }
  },

  async saveAs() {
    await actions.save(true);
  },

  async duplicateProject() {
    if (!store.session.projectId) {
      store.notify('warn', 'Save the project first, then duplicate it.');
      return;
    }
    await actions.save();
    const name = await promptDialog({ title: 'Duplicate project', message: 'Name for the copy', value: `${store.doc.meta.name} copy` });
    if (!name) return;
    try {
      await api.duplicateProject(store.session.projectId, name);
      store.notify('ok', `Duplicated as "${name}".`, { title: 'Projects' });
    } catch (error) {
      store.notify('error', describeError(error), { title: 'Duplicate failed' });
    }
  },

  async packageProject() {
    await actions.save();
    if (!store.session.projectId) return;
    try {
      const { job } = await api.packageProject(store.session.projectId);
      store.session.exportJob = job;
      store.emit('export');
      const finished = await pollJob(job.id);
      if (finished?.status === 'done' && finished.downloadUrl) {
        triggerDownload(finished.downloadUrl, finished.outputName ?? 'project.mlab.zip');
        store.notify('ok', 'Project package downloaded. It contains the project document and every media file it uses.', { title: 'Package ready' });
      }
    } catch (error) {
      store.notify('error', describeError(error), { title: 'Packaging failed' });
    }
  },

  async importProject(file) {
    try {
      const result = await api.importProjectFile(file);
      store.notify('ok', `Imported "${result.project.name}" with ${result.importedAssets} media file(s).`, { title: 'Import' });
      await actions.openProjects();
      void result;
    } catch (error) {
      store.notify('error', describeError(error), { title: 'Import failed' });
    }
  },

  exportDialog() {
    openExportDialog({ store, api, media, preview, timeline });
  },

  exportStill() {
    openExportDialog({ store, api, media, preview, timeline, initialKind: 'still' });
  },

  projectSettings() {
    openProjectSettings({ store, media, preview, timeline, onApply: () => {
      preview.layout();
      preview.invalidate(true);
      timeline.rebuildHeads();
      timeline.invalidate(true);
      renderChrome();
    } });
  },

  presets() {
    openPresetsDialog({ store, api, media, preview, timeline });
  },

  about() {
    openAboutDialog({ store });
  },

  toggleLeft() {
    store.ui.leftOpen = !store.ui.leftOpen;
    shell.libraryPanel.classList.toggle('hidden', !store.ui.leftOpen);
    requestAnimationFrame(() => {
      preview.layout();
      timeline.invalidate(true);
    });
  },

  toggleRight() {
    store.ui.rightOpen = !store.ui.rightOpen;
    shell.inspectorPanel.classList.toggle('hidden', !store.ui.rightOpen);
    requestAnimationFrame(() => {
      preview.layout();
      timeline.invalidate(true);
    });
  },

  showShortcuts() {
    showShortcutDialog();
  },
};

/* ------------------------------------------------------------------ *
 * Project loading
 * ------------------------------------------------------------------ */

/**
 * @param {string} id
 */
async function loadProject(id) {
  preview.setBusy('Opening project…');
  try {
    const { doc, issues } = await api.loadProject(id);
    store.loadDocument(doc, { projectId: id });
    for (const issue of issues ?? []) {
      if (issue.level === 'warn') store.notify('warn', issue.message, { title: 'Project notes' });
      else if (issue.level === 'error') store.notify('error', issue.message, { title: 'Project notes' });
    }
    await afterLoad();
    if (store.session.recoveredDraft) {
      // The store flagged a newer draft; ask before silently discarding it.
      openRecoveryDialog({
        store,
        draft: store.session.recoveredDraft,
        onRecover: () => {
          const { doc: draftDoc } = normalizeProject(store.session.recoveredDraft.doc);
          store.loadDocument(draftDoc, { projectId: id });
          store.session.dirty = true;
          store.session.saveState = 'dirty';
          store.session.recoveredDraft = null;
          afterLoad();
          store.notify('ok', 'Recovered the draft from the last session. Save when you are happy with it.', { title: 'Draft recovered' });
        },
        onDiscard: () => {
          store.session.recoveredDraft = null;
          api.clearDraft(id).catch(() => {});
          store.notify('info', 'Kept the last saved version and discarded the draft.', { title: 'Recovery' });
        },
      });
    }
  } catch (error) {
    store.notify('error', describeError(error), { title: 'Could not open the project' });
  } finally {
    preview.setBusy(null);
  }
}

async function afterLoad() {
  media.releaseAll();
  preview.setBusy('Loading media…', 0);
  await media.preloadDocument((done, total, name) => {
    preview.setBusy(`Loading media… ${done}/${total}${name ? ` — ${name}` : ''}`, total ? done / total : 0);
  });
  // Analyse any audio that has no stored analysis yet.
  const audioAssets = store.doc.assets.filter((asset) => asset.kind === 'audio');
  for (const asset of audioAssets) {
    if (!store.doc.audio[asset.id]) {
      preview.setBusy(`Analysing "${asset.name}"…`, 0);
      try {
        await media.ensureAnalysis(asset.id, (stage, progress) => preview.setBusy(`${stage} — ${asset.name}`, progress));
      } catch {
        /* reported already */
      }
    } else {
      // Re-decode so live playback has samples even though analysis is stored.
      try {
        const response = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/audio`);
        if (response.ok) {
          const context = new (window.AudioContext || /** @type {any} */ (window).webkitAudioContext)();
          const decoded = await context.decodeAudioData(await response.arrayBuffer());
          await context.close();
          const channels = [];
          for (let index = 0; index < decoded.numberOfChannels; index += 1) channels.push(decoded.getChannelData(index));
          media.audioBuffers.set(asset.id, { channels, sampleRate: decoded.sampleRate, duration: decoded.duration });
        }
      } catch {
        /* live playback of this asset is unavailable; export still mixes it */
      }
    }
  }
  preview.setBusy(null);
  preview.layout();
  preview.invalidate(true);
  timeline.rebuildHeads();
  timeline.fit();
  renderChrome();
  renderPanels();
}

/**
 * @returns {Promise<boolean>} true when it is safe to discard the current doc
 */
async function confirmDiscard() {
  if (!store.session.dirty) return true;
  return confirmDialog({
    title: 'Unsaved changes',
    message: 'This project has unsaved changes. Save them before continuing?',
    confirmLabel: 'Save and continue',
    cancelLabel: 'Discard',
  }).then(async (save) => {
    if (save) await actions.save();
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * Autosave + crash recovery
 * ------------------------------------------------------------------ */

const AUTOSAVE_INTERVAL = 20000;

async function autosaveTick() {
  if (!store.session.projectId || !store.session.dirty) return;
  try {
    await api.saveDraft(store.session.projectId, store.doc, 'autosave');
    store.session.lastDraftAt = Date.now();
    store.session.saveState = store.session.saveState === 'error' ? 'error' : 'dirty';
    store.emit('ui');
  } catch {
    /* a failed autosave must not interrupt editing */
  }
}

window.addEventListener('beforeunload', (event) => {
  if (store.session.projectId && store.session.dirty) {
    // Best-effort synchronous-ish draft write; the server writes it atomically.
    try {
      navigator.sendBeacon?.(
        `/api/projects/${encodeURIComponent(store.session.projectId)}/draft`,
        new Blob([JSON.stringify({ doc: store.doc, reason: 'unload' })], { type: 'application/json' }),
      );
    } catch {
      /* ignore */
    }
    event.preventDefault();
    event.returnValue = '';
  }
});

/* ------------------------------------------------------------------ *
 * Keyboard
 * ------------------------------------------------------------------ */

function installShortcuts() {
  window.addEventListener('keydown', async (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    const mod = event.ctrlKey || event.metaKey;

    if (event.key === 'Escape') {
      const openModal = document.querySelector('.modal-backdrop');
      if (openModal) openModal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return;
    }

    if (typing) {
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        actions.save();
      }
      return;
    }

    if (mod) {
      switch (event.key.toLowerCase()) {
        case 'z':
          event.preventDefault();
          if (event.shiftKey) store.redo();
          else store.undo();
          afterHistory();
          return;
        case 'y':
          event.preventDefault();
          store.redo();
          afterHistory();
          return;
        case 's':
          event.preventDefault();
          if (event.shiftKey) actions.saveAs();
          else actions.save();
          return;
        case 'd':
          event.preventDefault();
          store.duplicateClips(store.ui.selectedClipIds);
          return;
        case 'c':
          copySelection();
          return;
        case 'v':
          pasteSelection();
          return;
        case 'a':
          event.preventDefault();
          store.selectClips(store.doc.clips.map((clip) => clip.id));
          return;
        case 'e':
          event.preventDefault();
          actions.exportDialog();
          return;
        case 'o':
          event.preventDefault();
          actions.openProjects();
          return;
        case 'k':
          event.preventDefault();
          toggleKeyframeAtPlayhead();
          return;
        default:
          break;
      }
      return;
    }

    switch (event.key) {
      case ' ':
        event.preventDefault();
        preview.togglePlay();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        preview.step(event.shiftKey ? -10 : -1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        preview.step(event.shiftKey ? 10 : 1);
        break;
      case 'Home':
        event.preventDefault();
        preview.goToStart();
        break;
      case 'End':
        event.preventDefault();
        preview.goToStart();
        preview.seek(store.doc.composition.duration);
        break;
      case 's':
        store.splitClips();
        break;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        store.deleteClips(store.ui.selectedClipIds);
        break;
      case 'l':
        store.playback.loop = !store.playback.loop;
        store.emit('transport');
        preview.invalidate(true);
        break;
      case 'o':
        store.ui.showOverlay = !store.ui.showOverlay;
        preview.invalidateOverlay();
        break;
      case 'g':
        store.ui.showSafeGuides = !store.ui.showSafeGuides;
        preview.guides.classList.toggle('hidden', !store.ui.showSafeGuides);
        break;
      case 'i':
        if (event.shiftKey) actions.toggleRight();
        else actions.toggleLeft();
        break;
      case '1':
        preview.setQuality(1);
        break;
      case '2':
        preview.setQuality(0.5);
        break;
      case '3':
        preview.setQuality(0.25);
        break;
      case '?':
        showShortcutDialog();
        break;
      default:
        break;
    }
  });
}

function afterHistory() {
  timeline.rebuildHeads();
  timeline.invalidate(true);
  preview.invalidate(true);
  renderPanels();
  renderChrome();
}

function copySelection() {
  const clip = store.primaryClip;
  if (!clip) return;
  store.clipboard.clips = JSON.parse(JSON.stringify([clip]));
  store.notify('info', `Copied "${clip.name}".`, { title: 'Clipboard', timeout: 2500 });
}

function pasteSelection() {
  const copied = store.clipboard.clips;
  if (!copied?.length) return;
  const at = store.playback.time;
  const offset = Math.min(...copied.map((clip) => clip.start));
  /** @type {string[]} */
  const ids = [];
  store.edit('Paste clips', () => {
    for (const source of copied) {
      const clip = JSON.parse(JSON.stringify(source));
      clip.id = `clip_${Math.random().toString(36).slice(2, 10)}`;
      clip.start = at + (source.start - offset);
      clip.keyframes = clip.keyframes.map((channel) => ({
        ...channel,
        id: `chan_${Math.random().toString(36).slice(2, 10)}`,
        keys: channel.keys.map((key) => ({ ...key, id: `key_${Math.random().toString(36).slice(2, 10)}` })),
      }));
      store.doc.clips.push(clip);
      ids.push(clip.id);
    }
  });
  store.selectClips(ids);
}

function toggleKeyframeAtPlayhead() {
  const clip = store.primaryClip;
  if (!clip) {
    store.notify('warn', 'Select a clip first, then press K to key a property at the playhead.');
    return;
  }
  const channel = store.ui.graphChannel ?? 'transform.opacity';
  import('/core/keyframes.js').then(({ findChannel, setKeyframe, removeKeyframe, channelValue }) => {
    const time = store.playback.time;
    const entry = findChannel(clip, channel);
    const existing = entry?.keys.find((key) => Math.abs(key.time - time) < 1e-3);
    store.edit(existing ? 'Remove keyframe' : 'Add keyframe', () => {
      if (existing) removeKeyframe(clip, channel, existing.id);
      else setKeyframe(clip, channel, time, channelValue(clip, channel, time, 1));
    });
    preview.invalidate(true);
    timeline.invalidate(true);
  });
}

/* ------------------------------------------------------------------ *
 * Panels
 * ------------------------------------------------------------------ */

function renderPanels() {
  library.render();
  inspector.render();
}

store.on('doc', () => {
  inspector.scheduleRender();
  library.scheduleRender();
  timeline.invalidate(true);
});
store.on('selection', () => {
  inspector.scheduleRender();
  library.scheduleRender();
});
store.on('ui', () => {
  renderChrome();
  renderToasts();
});
store.on('library', () => {
  library.scheduleRender();
  inspector.scheduleRender();
});
store.on('playhead', () => {
  timeline.followPlayhead?.();
});
store.on('transport', () => {
  renderChrome();
  preview.invalidate(true);
});
store.on('export', () => renderChrome());

/* ------------------------------------------------------------------ *
 * Dialogs referenced from more than one place
 * ------------------------------------------------------------------ */

function showShortcutDialog() {
  const rows = [
    ['Space', 'Play / pause'],
    ['← / →', 'One frame back / forward'],
    ['Shift + ← / →', 'Ten frames'],
    ['Home / End', 'Go to range start / composition end'],
    ['S', 'Split selected clips at the playhead'],
    ['Delete', 'Delete selected clips'],
    ['K', 'Toggle a keyframe on the current property'],
    ['L', 'Toggle the loop'],
    ['O', 'Toggle on-canvas overlays'],
    ['G', 'Toggle safe guides'],
    ['1 / 2 / 3', 'Full / half / quarter preview quality'],
    ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
    ['Ctrl+D', 'Duplicate selection'],
    ['Ctrl+C / Ctrl+V', 'Copy / paste clips'],
    ['Ctrl+A', 'Select all clips'],
    ['Ctrl+S / Ctrl+Shift+S', 'Save / save as'],
    ['Ctrl+E', 'Export'],
    ['Ctrl+O', 'Projects'],
    ['Ctrl + scroll', 'Zoom the timeline'],
    ['Right-click a clip', 'Clip menu'],
    ['Right-click the ruler', 'Add or remove an audio marker'],
    ['Double-click the preview', 'Re-fit the preview'],
  ];
  const backdrop = el('div', { class: 'modal-backdrop' }, [
    el('div', { class: 'modal modal--md' }, [
      el('div', { class: 'modal__head' }, [
        el('div', { class: 'modal__title', text: 'Keyboard shortcuts' }),
        el('div', { class: 'modal__sub', text: 'Motion Lab' }),
        iconButton(ICONS.close, 'Close', () => backdrop.remove()),
      ]),
      el('div', { class: 'modal__body' }, [
        el('div', { class: 'grid-2' }, rows.map(([keys, description]) => el('div', { class: 'row' }, [
          el('kbd', { text: keys }),
          el('span', { class: 'muted', text: description }),
        ]))),
      ]),
      el('div', { class: 'modal__foot' }, [
        el('div', { class: 'spacer' }),
        button('Close', 'btn btn--primary', { onclick: () => backdrop.remove() }),
      ]),
    ]),
  ]);
  document.getElementById('modal-root').append(backdrop);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * @param {string} jobId
 * @param {(job:any)=>void} [onTick]
 * @returns {Promise<any>}
 */
async function pollJob(jobId, onTick) {
  for (;;) {
    const { job } = await api.exportJob(jobId);
    onTick?.(job);
    if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
}

/**
 * @param {string} url
 * @param {string} [name]
 */
export function triggerDownload(url, name) {
  const anchor = el('a', { href: url, download: name ?? '' });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  preview.mount();
  timeline.mount();
  installShortcuts();

  try {
    const health = await api.health();
    store.session.health = health;
    store.session.formats = health.formats ?? [];
  } catch (error) {
    store.notify('error', describeError(error), { title: 'Server unreachable' });
  }

  try {
    await media.refreshLibrary();
  } catch (error) {
    store.notify('warn', `The media library could not be listed: ${describeError(error)}`, { title: 'Library' });
  }

  // Open the most recent project, or start a fresh one.
  try {
    const { projects } = await api.listProjects();
    if (projects.length > 0) {
      const mostRecent = projects[0];
      const draftInfo = mostRecent.hasDraft ? await api.projectDraft(mostRecent.id).catch(() => null) : null;
      await loadProject(mostRecent.id);
      if (draftInfo?.draft && draftInfo.draft.doc) {
        store.session.recoveredDraft = draftInfo.draft;
        store.notify('warn', 'A newer autosaved draft was found for this project. Use Projects → Recover draft, or it will be offered now.', {
          title: 'Draft available',
        });
      }
    } else {
      await actions.newProject({ name: 'Untitled composition' });
    }
  } catch (error) {
    store.notify('warn', `Could not list projects: ${describeError(error)}`, { title: 'Projects' });
    await actions.newProject({ name: 'Untitled composition' });
  }

  renderChrome();
  renderPanels();
  preview.layout();
  preview.invalidate(true);
  timeline.fit();
  setInterval(autosaveTick, AUTOSAVE_INTERVAL);
  document.getElementById('boot')?.classList.add('hidden');
  window.__motionLab.ready = true;

  // Keep the transport clock readable even when nothing else changes.
  setInterval(() => {
    const node = document.getElementById('transport-timecode');
    if (node) node.textContent = formatTimecode(store.playback.time, store.doc.composition.fps);
  }, 60);
}

boot();

export { media, audio, preview, timeline, actions, shell, pollJob, canvasToBlob, menu };
