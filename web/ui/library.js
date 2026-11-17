/**
 * Media library panel.
 *
 * Media enters a project here: files are imported through the server (which probes
 * them and keeps a thumbnail) and every asset can be dropped on the timeline or
 * clicked onto it at the playhead.
 *
 * Two habits make the file easier to follow:
 *
 *  - The chrome (header, tabs, toolbar, search box, footer) is built once and only
 *    its *state* is repainted, because rebuilding the search input on every
 *    keystroke would steal the caret. Everything below the toolbar is rebuilt per
 *    render; tiles carry no state of their own, so a repaint can never go stale.
 *  - Drag payloads are text flavours: `application/x-motion-lab-asset` carries a
 *    media id, `application/x-motion-lab-builtin` carries JSON for the procedural
 *    layers (graphic / text / adjustment) that have no file behind them, and
 *    `text/plain` always carries a label so a card dropped elsewhere still reads.
 */

import { assetPreviewUrl } from '../api.js';
import { button, clear, confirmDialog, el, emptyState, fitCanvas, hint, iconButton, ICONS, promptDialog } from './dom.js';

/**
 * Import a module that lives outside `web/`: the browser asks for these at the
 * server's `/core/` mount, which Node cannot resolve when it loads this file from
 * disk for a syntax check, so the on-disk spelling is the fallback. Both spellings
 * name the same module in the browser, so only one instance is ever created.
 * @param {string} served @param {string} onDisk
 */
async function importCore(served, onDisk) {
  try {
    return await import(served);
  } catch (error) {
    if (/** @type {any} */ (error)?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return import(onDisk);
  }
}

const { defaultClip, defaultGraphic, defaultTextStyle, formatDuration, usedAssetIds } =
  await importCore('/core/schema.js', '../../core/schema.js');
const { drawGraphicThumbnail } = await importCore('/core/graphics.js', '../../core/graphics.js');
const { clamp, clamp01, formatBytes } = await importCore('/core/math.js', '../../core/math.js');

/** @typedef {import('../../core/schema.js').AssetMeta} AssetMeta */

const ASSET_FORMAT = 'application/x-motion-lab-asset';
const BUILTIN_FORMAT = 'application/x-motion-lab-builtin';
const GRAPHIC_FORMAT = 'application/x-motion-lab-graphic';

/** Tabs in order; `id` matches `AssetMeta.kind`, except for the procedural picker. */
const TABS = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Videos' },
  { id: 'audio', label: 'Audio' },
  { id: 'graphics', label: 'Graphics' },
];

/** The sources core/graphics.js can draw, in picker order. */
const GRAPHIC_TILES = [
  { kind: 'gradient', label: 'Gradient', sub: 'Animated colour field' },
  { kind: 'shape', label: 'Shape', sub: 'Seed-driven geometry' },
  { kind: 'particles', label: 'Particles', sub: 'Drifting particle field' },
  { kind: 'waveform', label: 'Waveform', sub: 'Audio-style trace' },
  { kind: 'bars', label: 'Bars', sub: 'Frequency bars' },
  { kind: 'rings', label: 'Rings', sub: 'Concentric rings' },
  { kind: 'noise', label: 'Noise', sub: 'Fractal grain' },
  { kind: 'grid', label: 'Grid', sub: 'Perspective grid' },
];

/** Room a newly created layer asks for, unless the composition ends sooner. */
const STILL_DURATION = 5;

/**
 * Build the media library.
 *
 * @param {object} options
 * @param {import('../store.js').Store} options.store
 * @param {import('../media.js').MediaEngine} options.media
 * @param {import('../preview.js').Preview} options.preview
 * @param {import('../timeline.js').Timeline} options.timeline
 * @param {typeof import('../api.js').api} options.api
 * @returns {{root:HTMLElement, render:()=>void, scheduleRender:()=>void}}
 */
export function buildLibraryPanel({ store, media, preview, timeline, api }) {
  /** Asset ids the document references; recomputed per render and read by tiles. */
  let usedIds = new Set();
  /** Asset ids the user last touched here, which is what the highlight follows. */
  let pickedIds = new Set();
  /** @type {HTMLElement|null} */
  let contextMenu = null;
  let frame = 0;
  let dragDepth = 0;

  /* ------------------------------------------------------------ chrome */

  const relinkAllButton = button('Relink all missing', 'btn btn--tiny btn--danger', {
    title: 'Choose the missing files; clips that use them are restored',
    onclick: () => relinkAllMissing(),
  });
  relinkAllButton.classList.add('hidden');

  const gridButton = button('Grid', 'btn btn--tiny', { title: 'Large thumbnails', onclick: () => setView('grid') });
  const listButton = button('List', 'btn btn--tiny', { title: 'One row per asset', onclick: () => setView('list') });

  const fileInput = /** @type {HTMLInputElement} */ (el('input', {
    class: 'hidden', type: 'file', multiple: true, accept: 'image/*,video/*,audio/*',
  }));
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = ''; // clearing it lets the same file be chosen twice in a row
    if (files.length) void importFiles(files);
  });

  const header = el('div', { class: 'panel__header' }, [
    el('div', { class: 'panel__title', text: 'Media' }),
    el('div', { class: 'panel__spacer' }),
    relinkAllButton,
    el('div', { class: 'btn-group' }, [gridButton, listButton]),
    button(`${ICONS.plus} Import`, 'btn btn--tiny', { title: 'Import images, video or audio from disk', onclick: () => fileInput.click() }),
  ]);

  /** @type {Map<string, HTMLButtonElement>} */
  const tabButtons = new Map();
  const tabsBar = el('div', { class: 'tabs' }, TABS.map((tab) => {
    const node = button(tab.label, 'tab', {
      title: tab.id === 'graphics' ? 'Procedural layers you can add without importing' : `Show ${tab.label.toLowerCase()} only`,
      onclick: () => selectTab(tab.id),
    });
    tabButtons.set(tab.id, node);
    return node;
  }));

  const search = /** @type {HTMLInputElement} */ (el('input', {
    class: 'search', type: 'search', placeholder: 'Search media...', value: store.ui.libraryQuery ?? '',
  }));
  search.addEventListener('input', () => {
    store.ui.libraryQuery = search.value;
    // One repaint per frame instead of one per keystroke keeps big libraries snappy.
    scheduleRender();
  });

  const toolbar = el('div', { class: 'library-toolbar' }, [
    search,
    button(`${ICONS.plus} Folder`, 'btn btn--tiny', { title: 'Create a folder to file media in', onclick: () => createFolder() }),
  ]);

  const folderBox = el('div', {});
  const assetArea = el('div', {});
  const body = el('div', { class: 'panel__body' }, [folderBox, assetArea]);

  const progressName = el('div', { class: 'progress-row__name', text: '' });
  const progressFill = el('div', { class: 'progress-row__fill' });
  const progressState = el('div', { class: 'progress-row__state', text: '' });
  const progressRow = el('div', { class: 'library-toolbar hidden' }, [
    el('div', { class: 'progress-row grow' }, [progressName, el('div', { class: 'progress-row__bar' }, [progressFill]), progressState]),
  ]);

  const footer = el('div', { class: 'library-toolbar' });

  const dropOverlay = el('div', {
    class: 'dropzone hidden',
    style: {
      position: 'absolute', inset: '0', zIndex: '60', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: '4px', background: 'rgba(8, 8, 12, 0.92)',
    },
  }, [
    el('div', { text: 'Drop files to import' }),
    el('div', { class: 'muted', text: 'Images, video and audio land in the folder you are viewing.' }),
  ]);

  const root = el('div', { class: 'panel', style: { flex: '1', position: 'relative' } }, [
    header, tabsBar, toolbar, body, progressRow, footer, dropOverlay, fileInput,
  ]);

  /* ------------------------------------------------------------ import */

  /** @param {boolean} active */
  const showDropTarget = (active) => {
    dropOverlay.classList.toggle('hidden', !active);
    dropOverlay.classList.toggle('dropzone--active', active);
  };

  /** @param {DragEvent} event */
  const isFileDrag = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');

  // dragenter/dragleave fire for every child, so nesting is counted instead of
  // reading each leave as "the pointer left the panel".
  root.addEventListener('dragenter', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth += 1;
    showDropTarget(true);
  });
  root.addEventListener('dragover', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  root.addEventListener('dragleave', (event) => {
    if (!isFileDrag(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showDropTarget(false);
  });
  root.addEventListener('drop', (event) => {
    // An asset card dragged back onto the panel is not an import.
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth = 0;
    showDropTarget(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) void importFiles(files);
  });

  /** @param {File[]} files */
  async function importFiles(files) {
    const folderId = store.ui.libraryFolderId;
    showProgress(files.length === 1 ? `Importing "${files[0].name}"` : `Importing ${files.length} files`, 0);
    // `onProgress` is a single slot on the engine, so the previous owner is put back
    // once the import settles.
    const previous = media.onProgress;
    media.onProgress = (name, value) => showProgress(name ? `Importing "${name}"` : 'Finishing import', value);
    try {
      const imported = await media.importFiles([...files], { folderId: folderId ?? undefined });
      const folder = folderId ? ` into "${folderName(folderId)}"` : '';
      store.notify('ok', `Imported ${imported.length} file${imported.length === 1 ? '' : 's'}${folder}.`, { title: 'Library' });
    } catch (error) {
      store.notify('error', `Import failed: ${describeError(error)}`, { title: 'Library' });
    } finally {
      media.onProgress = previous;
      progressRow.classList.add('hidden');
      progressFill.style.width = '0%';
      scheduleRender();
    }
  }

  /** @param {string} text @param {number} value 0..1 */
  function showProgress(text, value) {
    const percent = Math.round(clamp01(value) * 100);
    progressRow.classList.remove('hidden');
    progressName.textContent = text;
    progressState.textContent = `${percent}%`;
    progressFill.style.width = `${percent}%`;
  }

  /* ------------------------------------------------------------ tabs and folders */

  /** @param {string} id */
  function selectTab(id) {
    if (store.ui.libraryTab === id) return;
    store.ui.libraryTab = id;
    render();
  }

  /** @param {'grid'|'list'} view */
  function setView(view) {
    if (store.ui.libraryView === view) return;
    store.ui.libraryView = view;
    render();
  }

  /** Clicking the active folder again clears the filter, the quickest way back to all media. */
  function selectFolder(/** @type {string|null} */ folderId) {
    store.ui.libraryFolderId = folderId && store.ui.libraryFolderId !== folderId ? folderId : null;
    render();
  }

  async function createFolder() {
    const name = await promptDialog({
      title: 'New folder',
      message: 'Media imported while a folder is selected is filed into it.',
      value: 'New folder',
    });
    const trimmed = (name ?? '').trim();
    if (!trimmed) return;
    const folder = store.addFolder(trimmed);
    store.ui.libraryFolderId = folder.id;
    store.notify('ok', `Folder "${trimmed}" is ready.`, { title: 'Library' });
    render();
  }

  /** @param {string|null} folderId */
  const folderName = (folderId) => store.doc.folders.find((folder) => folder.id === folderId)?.name ?? 'folder';

  /**
   * A folder stands for everything filed under it, so viewing one also shows the
   * media in its subfolders. That is what makes "move to the folder you are viewing"
   * a real one-click action instead of a no-op on media that is already there.
   * @param {string} folderId
   * @returns {Set<string>} the folder and its descendants, at any depth.
   */
  function folderScope(folderId) {
    const scope = new Set([folderId]);
    const walk = (parentId) => {
      for (const folder of store.doc.folders) {
        if (folder.parentId !== parentId || scope.has(folder.id)) continue;
        scope.add(folder.id);
        walk(folder.id);
      }
    };
    walk(folderId);
    return scope;
  }

  /**
   * Flatten `doc.folders` into parent-before-child order with a depth, so the list
   * can be indented without recursing mid-render. Folders whose parent has gone (an
   * older document, a hand-edited one) are listed at the root rather than lost.
   * @param {Array<{id:string,name:string,parentId?:string}>} folders
   */
  function folderTree(folders) {
    /** @type {Map<string, any[]>} */
    const byParent = new Map();
    for (const folder of folders) {
      const key = folder.parentId ?? '';
      if (!byParent.has(key)) byParent.set(key, []);
      /** @type {any[]} */ (byParent.get(key)).push(folder);
    }
    const ordered = [];
    const seen = new Set();
    const walk = (parentId, depth) => {
      for (const folder of byParent.get(parentId) ?? []) {
        if (seen.has(folder.id)) continue;
        seen.add(folder.id);
        ordered.push({ folder, depth });
        walk(folder.id, depth + 1);
      }
    };
    walk('', 0);
    for (const folder of folders) if (!seen.has(folder.id)) ordered.push({ folder, depth: 0 });
    return ordered;
  }

  function renderFolders() {
    clear(folderBox);
    const countIn = (/** @type {Set<string>} */ scope) =>
      store.doc.assets.filter((asset) => scope.has(asset.folderId ?? '')).length;
    folderBox.append(folderRow(null, 'All media', 0, store.doc.assets.length, store.ui.libraryFolderId === null));
    for (const { folder, depth } of folderTree(store.doc.folders)) {
      folderBox.append(folderRow(folder.id, folder.name, depth, countIn(folderScope(folder.id)), store.ui.libraryFolderId === folder.id));
    }
  }

  /** A folder row doubles as a drop target: the fastest way to file a card dragged out of the grid. */
  function folderRow(/** @type {string|null} */ folderId, name, depth, count, active) {
    const row = el('div', {
      class: `folder${active ? ' folder--active' : ''}`,
      style: { paddingLeft: `${8 + depth * 12}px` },
      title: folderId ? `Show only "${name}" — drop an asset here to file it` : 'Show every asset',
      onclick: () => selectFolder(folderId),
      ondragover: (event) => {
        if (![...(event.dataTransfer?.types ?? [])].includes(ASSET_FORMAT)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        row.classList.add('folder--active');
      },
      ondragleave: () => row.classList.toggle('folder--active', active),
      ondrop: (event) => {
        const assetId = event.dataTransfer?.getData(ASSET_FORMAT) ?? '';
        if (!assetId) return;
        event.preventDefault();
        row.classList.toggle('folder--active', active);
        moveAsset(assetId, folderId);
      },
    }, [
      el('span', { class: 'grow', text: name }),
      el('span', { class: 'folder__count', text: String(count) }),
    ]);
    return row;
  }

  /* ------------------------------------------------------------ assets */

  /** @returns {AssetMeta[]} the assets the current tab, folder and query select. */
  function visibleAssets() {
    const { libraryTab: tab, libraryFolderId: folderId, libraryQuery } = store.ui;
    const query = (libraryQuery ?? '').trim().toLowerCase();
    const scope = folderId ? folderScope(folderId) : null;
    return store.doc.assets.filter((asset) => {
      if (tab !== 'all' && asset.kind !== tab) return false;
      if (scope && !scope.has(asset.folderId ?? '')) return false;
      if (!query) return true;
      // The original file name is searched too, so media can be found by the name it
      // was imported with even after it was renamed here.
      return (asset.name ?? '').toLowerCase().includes(query) || (asset.fileName ?? '').toLowerCase().includes(query);
    });
  }

  const isProblem = (/** @type {AssetMeta} */ asset) =>
    asset.status === 'missing' || asset.status === 'unsupported' || asset.status === 'error';

  /** @param {AssetMeta} asset @returns {string} the badge message for a status. */
  function statusLabel(asset) {
    if (asset.status === 'missing') return 'File missing';
    if (asset.status === 'unsupported') return 'Unsupported format';
    if (asset.status === 'error') return 'Could not be read';
    if (asset.status === 'analyzing') return 'Analysing...';
    return 'Ready';
  }

  /** @param {AssetMeta} asset @returns {string} a short file-type label. */
  function fileType(asset) {
    const extension = /\.([a-z0-9]+)$/i.exec(asset.fileName ?? '')?.[1];
    if (extension) return extension.toUpperCase();
    return (asset.mime ?? '').split('/')[1]?.toUpperCase() ?? asset.kind.toUpperCase();
  }

  /** @param {AssetMeta} asset @returns {string} the summary line under the name. */
  function describeAsset(asset) {
    return [
      asset.width && asset.height ? `${asset.width}\u00d7${asset.height}` : '',
      asset.duration > 0 ? formatDuration(asset.duration) : '',
      asset.fps ? `${Math.round(asset.fps)} fps` : '',
      asset.size > 0 ? formatBytes(asset.size) : '',
      fileType(asset),
    ].filter(Boolean).join(' \u00b7 ');
  }

  function renderAssets() {
    clear(assetArea);
    if (store.ui.libraryTab === 'graphics') {
      renderGraphicsPicker();
      return;
    }
    const assets = visibleAssets();
    if (store.doc.assets.length === 0) {
      assetArea.append(el('div', { class: 'empty-state' }, [
        el('strong', { text: 'No media yet' }),
        el('div', { text: 'Drop images, video or audio anywhere on this panel, or import them from disk.' }),
        button('Import files...', 'btn btn--primary', { onclick: () => fileInput.click() }),
      ]));
      return;
    }
    if (assets.length === 0) {
      assetArea.append(emptyState(store.ui.libraryQuery
        ? `Nothing matches "${store.ui.libraryQuery}" here.`
        : 'This folder is empty. Import files, or drop an asset onto a folder name to file it.'));
      return;
    }
    const list = store.ui.libraryView === 'list';
    const container = el('div', { class: list ? 'asset-list' : 'asset-grid' });
    for (const asset of assets) container.append(assetTile(asset, list));
    assetArea.append(container);
  }

  /**
   * One builder for both views: a row is a card with a flatter layout and the same
   * problem affordances, so keeping them together stops the views from drifting.
   * @param {AssetMeta} asset @param {boolean} list
   */
  function assetTile(asset, list) {
    const problem = isProblem(asset);
    const picked = pickedIds.has(asset.id);
    const classes = list
      ? `asset-row${picked ? ' asset-row--selected' : ''}`
      : `asset-card${usedIds.has(asset.id) ? ' asset-card--used' : ''}${problem ? ' asset-card--problem' : ''}${picked ? ' asset-card--selected' : ''}`;
    const summary = `${asset.name} \u00b7 ${describeAsset(asset)}`;
    return el('div', {
      class: classes,
      draggable: 'true',
      title: problem ? asset.statusDetail ?? statusLabel(asset) : `${summary} — click to add at the playhead, or drag it onto a track`,
      onclick: () => primaryAction(asset),
      oncontextmenu: (event) => {
        event.preventDefault();
        openAssetMenu(asset, event.clientX, event.clientY);
      },
      ondragstart: (event) => startAssetDrag(event, asset),
    }, [
      list
        ? thumbnailNode(asset, 'asset-row__thumb')
        : el('div', { class: 'asset-card__thumb' }, [
          thumbnailNode(asset, ''),
          el('span', { class: 'asset-card__kind', text: asset.kind }),
          asset.duration > 0 ? el('span', { class: 'asset-card__dur', text: formatDuration(asset.duration) }) : null,
        ]),
      el('div', { class: list ? 'grow' : 'asset-card__meta' }, [
        el('div', { class: list ? 'asset-row__name' : 'asset-card__name', text: asset.name, title: asset.name }),
        el('div', { class: 'asset-card__sub', text: describeAsset(asset) }),
      ]),
      // The grid marks a used asset with the card's own corner dot; a row has no such
      // pseudo-element, so it gets an explicit one.
      list && usedIds.has(asset.id) ? el('span', { class: 'badge-dot badge-dot--ok', title: 'Used in the composition' }) : null,
      problem ? el('span', { class: 'asset-card__badge', text: statusLabel(asset), title: asset.statusDetail ?? '' }) : null,
      problem ? hint('error', asset.statusDetail ?? 'This file needs attention before it can be used.') : null,
      problem ? relinkButton(asset) : null,
    ]);
  }

  /** A button rather than a plain click: a clip made from a file that cannot be read would have nothing to draw. */
  function relinkButton(/** @type {AssetMeta} */ asset) {
    return button(asset.status === 'missing' ? 'Relink...' : 'Replace file...', 'btn btn--tiny btn--primary', {
      title: 'Choose a replacement file — clips keep their placement, effects and keyframes',
      onclick: (event) => {
        event.stopPropagation();
        chooseReplacement(asset);
      },
    });
  }

  /**
   * The server thumbnail is the fast path. When there is none the media engine can
   * measure one from the decoded element, and if even that fails the tile gets a
   * glyph instead of a broken image.
   * @param {AssetMeta} asset @param {string} className '' inside a card thumb box
   */
  function thumbnailNode(asset, className) {
    // `addedAt` changes when a file is replaced, so it doubles as a cache key for a
    // thumbnail the server serves with a long max-age.
    const image = /** @type {HTMLImageElement} */ (el('img', {
      class: className,
      alt: '',
      loading: 'lazy',
      src: `${assetPreviewUrl(asset.id)}${asset.addedAt ? `?v=${encodeURIComponent(asset.addedAt)}` : ''}`,
    }));
    image.addEventListener('error', () => {
      media.thumbnailDataUrl(asset).then((dataUrl) => {
        if (dataUrl) {
          image.src = dataUrl;
          return;
        }
        // The tile may already have been repainted, and replacing a detached node is
        // a no-op, so this is always safe.
        image.replaceWith(placeholderNode(asset, className));
      }).catch(() => image.replaceWith(placeholderNode(asset, className)));
    }, { once: true });
    return image;
  }

  /** @param {AssetMeta} asset @param {string} className */
  function placeholderNode(asset, className) {
    return el('span', {
      class: className || 'muted',
      style: { fontSize: className ? '13px' : '26px', lineHeight: '1' },
      text: ICONS[asset.kind] ?? ICONS.graphic,
    });
  }

  /* ------------------------------------------------------------ drag sources */

  /** @param {DragEvent} event @param {AssetMeta} asset */
  function startAssetDrag(event, asset) {
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(ASSET_FORMAT, asset.id);
    event.dataTransfer.setData('text/plain', asset.name);
  }

  /** @param {DragEvent} event @param {{kind:string, graphicKind?:string}} payload */
  function startBuiltinDrag(event, payload, label) {
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(BUILTIN_FORMAT, JSON.stringify(payload));
    // A graphic also announces its kind on its own flavour, so a drop target can
    // handle the common case without parsing JSON.
    if (payload.graphicKind) event.dataTransfer.setData(GRAPHIC_FORMAT, payload.graphicKind);
    event.dataTransfer.setData('text/plain', label);
  }

  /* ------------------------------------------------------------ building clips */

  const clipStart = () => clamp(store.playback.time, 0, store.doc.composition.duration);

  /**
   * A clip can never be longer than the room left in the composition, so adding media
   * near the end of the timeline produces a usable clip instead of one that starts
   * beyond the out point.
   * @param {number} natural seconds the source would like to occupy
   */
  function clipDuration(natural) {
    const { fps, duration } = store.doc.composition;
    const smallest = 1 / Math.max(1, fps);
    return clamp(natural, smallest, Math.max(smallest, duration - clipStart()));
  }

  /** @param {AssetMeta} asset */
  function addAssetToComposition(asset) {
    if (isProblem(asset)) {
      chooseReplacement(asset);
      return;
    }
    const track = store.defaultTrackFor(asset.kind);
    if (!track) {
      store.notify('warn', `This composition has no ${asset.kind === 'audio' ? 'audio' : 'visual'} track to put that on.`);
      return;
    }
    // Stills get a fixed length because they have none of their own; video and audio
    // keep their real duration.
    const natural = asset.kind === 'image' || !(asset.duration > 0) ? STILL_DURATION : asset.duration;
    store.addClip(defaultClip({
      name: asset.name,
      kind: asset.kind,
      assetId: asset.id,
      trackId: track.id,
      start: clipStart(),
      duration: clipDuration(natural),
      inPoint: 0,
    }));
    selectOnly(asset.id);
    notifyViews();
  }

  /**
   * Add a procedural, text or adjustment layer.
   *
   * Built-ins go on the topmost visual track: the renderer draws tracks from the last
   * one up, so the first visual track is the one that ends up on top — which is
   * exactly what an adjustment layer has to cover.
   * @param {'graphic'|'text'|'adjustment'} kind @param {string} [graphicKind]
   */
  function addBuiltinClip(kind, graphicKind) {
    const track = store.defaultTrackFor(kind === 'adjustment' ? 'visual' : kind);
    if (!track) {
      store.notify('warn', 'Add a visual track first — built-in layers need one to live on.');
      return;
    }
    const patch = { kind, trackId: track.id, start: clipStart(), duration: clipDuration(STILL_DURATION) };
    if (kind === 'graphic') {
      patch.name = GRAPHIC_TILES.find((entry) => entry.kind === graphicKind)?.label ?? 'Graphic';
      // The seed is picked once, here; everything drawn from it stays identical
      // between preview, export and a reload.
      patch.graphic = { ...defaultGraphic(graphicKind), seed: Math.floor(Math.random() * 1000000) };
    } else if (kind === 'text') {
      patch.name = 'Text';
      patch.text = defaultTextStyle();
    } else {
      patch.name = 'Adjustment layer';
    }
    store.addClip(defaultClip(patch));
    notifyViews();
  }

  /* ------------------------------------------------------------ graphics picker */

  function renderGraphicsPicker() {
    const query = (store.ui.libraryQuery ?? '').trim().toLowerCase();
    const matches = (text) => !query || text.toLowerCase().includes(query);
    /** @type {Array<{tile:HTMLElement, draw:(()=>void)|null}>} */
    const tiles = GRAPHIC_TILES
      .filter((entry) => matches(entry.label))
      .map((entry) => builtinTile({ kind: 'graphic', graphicKind: entry.kind, label: entry.label, sub: entry.sub }));
    if (matches('Text')) tiles.push(builtinTile({ kind: 'text', icon: ICONS.text, label: 'Text', sub: 'Title, caption or lower third' }));
    if (matches('Adjustment layer')) tiles.push(builtinTile({ kind: 'adjustment', icon: ICONS.layers, label: 'Adjustment layer', sub: 'Grades every track below it' }));
    if (tiles.length === 0) {
      assetArea.append(emptyState(`No built-in layer matches "${store.ui.libraryQuery}".`));
      return;
    }
    assetArea.append(hint('info', 'Procedural layers are generated while rendering, so they stay sharp at any resolution. Click a tile to add it at the playhead, or drag it onto a track.'));
    assetArea.append(el('div', { class: 'picker-grid' }, tiles.map((entry) => entry.tile)));
    // Tiles are measured once they are in the document, so each preview is drawn at
    // its real device resolution instead of a guessed one.
    for (const entry of tiles) entry.draw?.();
  }

  /**
   * @param {object} options
   * @param {'graphic'|'text'|'adjustment'} options.kind
   * @param {string} [options.graphicKind]
   * @param {string} [options.icon] drawn in the thumb instead of a canvas preview
   * @param {string} options.label
   * @param {string} options.sub
   * @returns {{tile:HTMLElement, draw:(()=>void)|null}}
   */
  function builtinTile({ kind, graphicKind, icon, label, sub }) {
    const canvas = icon ? null : el('canvas');
    const thumb = el('div', { class: 'picker-tile__thumb' }, [
      icon ? el('span', { class: 'muted', style: { fontSize: '30px', lineHeight: '1' }, text: icon }) : canvas,
    ]);
    const tile = el('button', {
      class: 'picker-tile',
      type: 'button',
      draggable: 'true',
      title: `Add "${label}" at the playhead`,
      onclick: () => addBuiltinClip(kind, graphicKind),
      ondragstart: (event) => startBuiltinDrag(event, graphicKind ? { kind, graphicKind } : { kind }, `${label} layer`),
    }, [
      thumb,
      el('div', { class: 'picker-tile__label', text: label }),
      el('div', { class: 'picker-tile__sub', text: sub }),
    ]);
    return { tile, draw: canvas && graphicKind ? () => drawTilePreview(canvas, thumb, graphicKind) : null };
  }

  /**
   * Draw one picker preview, squared off inside a thumb box that is wider than it is
   * tall. A tile with no layout yet (the panel is still hidden) is retried once on the
   * next frame and then left alone.
   * @param {HTMLElement} canvas @param {HTMLElement} thumb @param {string} kind
   */
  function drawTilePreview(canvas, thumb, kind, attempt = 0) {
    const rect = thumb.getBoundingClientRect();
    const height = Math.max(1, rect.height);
    if (rect.width < 8) {
      if (attempt < 1) requestAnimationFrame(() => drawTilePreview(canvas, thumb, kind, attempt + 1));
      return;
    }
    const ctx = fitCanvas(/** @type {HTMLCanvasElement} */ (canvas), thumb, height);
    const side = Math.max(1, Math.min(height, rect.width));
    ctx.save();
    ctx.translate((rect.width - side) / 2, (height - side) / 2);
    ctx.scale(side / 200, side / 200);
    drawGraphicThumbnail(ctx, kind, 200, {}, 1.4);
    ctx.restore();
  }

  /* ------------------------------------------------------------ actions */

  /** @param {AssetMeta} asset */
  function primaryAction(asset) {
    // Selecting first means the inspector follows the click even when the asset turns
    // out to be unusable.
    selectOnly(asset.id);
    addAssetToComposition(asset);
  }

  /** @param {string} assetId */
  function selectOnly(assetId) {
    pickedIds = new Set([assetId]);
    store.ui.selectedAssetIds = [assetId];
    // Other panels show library selections too, so the change is announced rather
    // than kept local.
    store.emit('selection');
  }

  /** @param {string} assetId @param {string|null} folderId */
  function moveAsset(assetId, folderId) {
    const asset = store.doc.assets.find((entry) => entry.id === assetId);
    store.moveAssetToFolder(assetId, folderId);
    if (!asset) return;
    store.notify('info', folderId
      ? `"${asset.name}" filed under "${folderName(folderId)}".`
      : `"${asset.name}" is no longer in a folder.`, { title: 'Library', timeout: 3000 });
  }

  /** @param {AssetMeta} asset */
  async function renameAsset(asset) {
    const name = await promptDialog({
      title: 'Rename media',
      message: 'The name shown in the library and on clips created from it.',
      value: asset.name,
    });
    const trimmed = (name ?? '').trim();
    if (!trimmed || trimmed === asset.name) return;
    store.edit('Rename media', () => {
      asset.name = trimmed;
    }, { topics: ['library'] });
    try {
      await api.updateAsset(asset.id, { name: trimmed });
    } catch (error) {
      store.notify('warn', `Renamed here, but the server kept the old name: ${describeError(error)}`, { title: 'Library' });
    }
  }

  /** @param {AssetMeta} asset */
  function chooseReplacement(asset) {
    pickFiles(`${asset.kind}/*`, false, (files) => {
      // A missing file is relinked and a readable one is replaced; the server has an
      // endpoint for each even though the work behind them is the same.
      void replaceAsset(asset, files[0], asset.status === 'missing' ? 'relink' : 'file');
    });
  }

  /**
   * Swap the file behind an asset id, keeping every clip that references it.
   * @param {AssetMeta} asset @param {File} file @param {'file'|'relink'} endpoint
   * @returns {Promise<boolean>} false when the server refused the file
   */
  async function replaceAsset(asset, file, endpoint) {
    const verb = endpoint === 'relink' ? 'relink' : 'replace';
    let updated;
    try {
      ({ asset: updated } = await api.replaceAssetFile(asset.id, file, endpoint));
    } catch (error) {
      store.notify('error', `Could not ${verb} "${asset.name}": ${describeError(error)}`, { title: 'Library' });
      return false;
    }
    // The server re-probed the file, but the document owns the display name and the
    // folder, so the two are merged. A resolved problem must also lose the
    // explanation that came with it.
    const merged = { ...asset, ...updated };
    if (!('statusDetail' in (updated ?? {}))) delete merged.statusDetail;
    store.registerAsset(merged);
    forgetDecoded(asset.id);
    if (asset.kind === 'audio') refreshAnalysis(asset.id);
    store.notify('ok', `"${asset.name}" ${verb === 'relink' ? 'relinked' : 'replaced'}. Clips that use it keep their placement, effects and keyframes.`, { title: 'Library' });
    notifyViews();
    return true;
  }

  /**
   * The media engine caches decoded elements and samples by asset id, so a replaced
   * file has to be dropped from those caches or the preview keeps drawing the old
   * bytes.
   * @param {string} assetId
   */
  function forgetDecoded(assetId) {
    const cached = media.loaded.get(assetId);
    if (cached?.element instanceof HTMLVideoElement) {
      cached.element.pause();
      cached.element.removeAttribute('src');
      cached.element.load();
    }
    media.loaded.delete(assetId);
    media.loading.delete(assetId);
    media.audioBuffers.delete(assetId);
    media.pendingSeeks.delete(assetId);
  }

  /** New audio means new samples, so the stored analysis (and its markers) is rebuilt. */
  function refreshAnalysis(/** @type {string} */ assetId) {
    store.edit('Re-analyse audio', () => {
      delete store.doc.audio[assetId];
    });
    store.invalidateMappings();
    media.ensureAnalysis(assetId).catch(() => {}); // the engine reports its own failures
  }

  async function relinkAllMissing() {
    const missing = store.doc.assets.filter((asset) => asset.status === 'missing');
    if (missing.length === 0) return;
    pickFiles('*/*', true, async (files) => {
      // The original file name is the only identifier that survives a file moving on
      // disk, so that is what the chosen files are matched against.
      const byName = new Map(missing.map((asset) => [(asset.fileName || asset.name).toLowerCase(), asset]));
      let relinked = 0;
      for (const file of files) {
        const asset = byName.get(file.name.toLowerCase());
        if (!asset) continue;
        byName.delete(file.name.toLowerCase());
        if (await replaceAsset(asset, file, 'relink')) relinked += 1;
      }
      if (relinked === 0) store.notify('warn', 'None of those files matched the missing media. Pick files with the same names as the originals.', { title: 'Library' });
      else store.notify('ok', `Relinked ${relinked} file${relinked === 1 ? '' : 's'}.`, { title: 'Library' });
    });
  }

  /** @param {AssetMeta} asset */
  async function deleteAsset(asset) {
    const clips = store.doc.clips.filter((clip) => clip.assetId === asset.id).length;
    const confirmed = await confirmDialog({
      title: 'Delete media',
      message: clips > 0
        ? `"${asset.name}" is used by ${clips} clip${clips === 1 ? '' : 's'}. Deleting it removes the file from the media folder and those clips lose their picture.`
        : `Delete "${asset.name}"? The file is removed from the media folder.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.deleteAsset(asset.id);
    } catch (error) {
      store.notify('error', `Could not delete "${asset.name}": ${describeError(error)}`, { title: 'Library' });
      return;
    }
    store.removeAsset(asset.id);
    store.ui.selectedAssetIds = (store.ui.selectedAssetIds ?? []).filter((id) => id !== asset.id);
    store.notify('info', `"${asset.name}" deleted.`, { title: 'Library' });
  }

  /** @param {AssetMeta} asset */
  function revealInfo(asset) {
    const clips = store.doc.clips.filter((clip) => clip.assetId === asset.id).length;
    const rows = [
      ['Asset id', asset.id],
      ['File name', asset.fileName ?? '—'],
      ['Kind', asset.kind],
      ['Type', asset.mime || '—'],
      ['Size', formatBytes(asset.size ?? 0)],
      ['Dimensions', asset.width && asset.height ? `${asset.width} \u00d7 ${asset.height}` : '—'],
      ['Duration', asset.duration > 0 ? formatDuration(asset.duration) : '—'],
      ['Frame rate', asset.fps ? `${Math.round(asset.fps)} fps` : '—'],
      ['Folder', asset.folderId ? folderName(asset.folderId) : 'All media'],
      ['Origin', asset.origin ?? '—'],
      ['Added', asset.addedAt ? new Date(asset.addedAt).toLocaleString() : '—'],
      ['Status', statusLabel(asset)],
      ['Used by', `${clips} clip${clips === 1 ? '' : 's'}`],
    ].map(([key, value]) => el('div', { class: 'kv' }, [
      el('span', { class: 'kv__k', text: key }),
      el('span', { class: 'kv__v', text: value }),
    ]));
    const close = () => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (/** @type {KeyboardEvent} */ event) => {
      if (event.key === 'Escape') close();
    };
    const backdrop = el('div', {
      class: 'modal-backdrop',
      onclick: (event) => {
        if (event.target === backdrop) close();
      },
    }, [
      el('div', { class: 'modal modal--sm' }, [
        el('div', { class: 'modal__head' }, [
          el('div', { class: 'modal__title', text: asset.name }),
          el('div', { class: 'modal__sub', text: 'Media info' }),
          iconButton(ICONS.close, 'Close', close),
        ]),
        el('div', { class: 'modal__body' }, [
          ...rows,
          // Reported exactly as the server wrote it: those strings are written for
          // people and say more than this panel could.
          asset.statusDetail ? hint(isProblem(asset) ? 'error' : 'info', asset.statusDetail) : null,
        ]),
        el('div', { class: 'modal__foot' }, [
          el('div', { class: 'grow' }),
          button('Close', 'btn btn--primary', { onclick: close }),
        ]),
      ]),
    ]);
    (document.getElementById('modal-root') ?? document.body).append(backdrop);
    document.addEventListener('keydown', onKey);
  }

  /* ------------------------------------------------------------ context menu */

  /** @param {AssetMeta} asset @param {number} clientX @param {number} clientY */
  function openAssetMenu(asset, clientX, clientY) {
    closeAssetMenu();
    selectOnly(asset.id);
    const problem = isProblem(asset);
    // A file that cannot be read is the first thing to fix, so relinking leads.
    /** @type {Array<[string, boolean, () => void]>} */
    const entries = [
      ['Add to composition', !problem, () => addAssetToComposition(asset)],
      ['Relink...', problem, () => chooseReplacement(asset)],
      ['Replace file...', true, () => chooseReplacement(asset)],
      ['Rename...', true, () => { void renameAsset(asset); }],
      ['Re-analyse audio', asset.kind === 'audio', () => refreshAnalysis(asset.id)],
      ['Reveal info', true, () => revealInfo(asset)],
    ];
    const items = [el('div', { class: 'menu__label', text: asset.name })];
    for (const [label, when, action] of entries) if (when) items.push(menuItem(label, action));
    items.push(el('div', { class: 'menu__note', text: 'Replacing the file keeps every clip that uses it: placement, effects and keyframes are untouched.' }));
    items.push(el('div', { class: 'menu__sep' }));
    items.push(el('div', { class: 'menu__label', text: 'Move to folder' }));
    // The folder being viewed is offered as a one-click target, so filing a fresh
    // import does not need a second trip through the folder list.
    if (store.ui.libraryFolderId && store.ui.libraryFolderId !== asset.folderId) {
      items.push(menuItem(`Move to "${folderName(store.ui.libraryFolderId)}"`, () => moveAsset(asset.id, store.ui.libraryFolderId)));
    }
    for (const folder of store.doc.folders) {
      items.push(menuItem(`${asset.folderId === folder.id ? ICONS.check : '\u00a0'} ${folder.name}`, () => moveAsset(asset.id, folder.id)));
    }
    if (asset.folderId) items.push(menuItem('Remove from folder', () => moveAsset(asset.id, null)));
    items.push(el('div', { class: 'menu__sep' }));
    items.push(menuItem('Delete', () => { void deleteAsset(asset); }, true));

    contextMenu = el('div', {
      class: 'menu__panel',
      style: { position: 'fixed', left: `${clientX}px`, top: `${clientY}px`, zIndex: '400' },
    }, items);
    document.body.append(contextMenu);
    setTimeout(() => {
      document.addEventListener('pointerdown', onMenuPointerDown, true);
      document.addEventListener('keydown', onMenuKey);
    }, 0);
    render();
  }

  /** @param {string} text @param {() => void} action @param {boolean} [danger] */
  function menuItem(text, action, danger = false) {
    return el('button', {
      class: `menu__item${danger ? ' menu__item--danger' : ''}`,
      text,
      title: text.trim(),
      onclick: () => {
        closeAssetMenu();
        action();
      },
    });
  }

  function closeAssetMenu() {
    contextMenu?.remove();
    contextMenu = null;
    document.removeEventListener('pointerdown', onMenuPointerDown, true);
    document.removeEventListener('keydown', onMenuKey);
  }

  /** @param {PointerEvent} event */
  function onMenuPointerDown(event) {
    if (!contextMenu?.contains(/** @type {Node} */ (event.target))) closeAssetMenu();
  }

  /** @param {KeyboardEvent} event */
  function onMenuKey(event) {
    if (event.key === 'Escape') closeAssetMenu();
  }

  /* ------------------------------------------------------------ helpers */

  /**
   * A one-shot hidden file input. The native picker is the only way to reach the
   * filesystem from a page, so every "choose a file" affordance shares this.
   * @param {string} accept @param {boolean} multiple @param {(files:File[])=>void} onFiles
   */
  function pickFiles(accept, multiple, onFiles) {
    const input = /** @type {HTMLInputElement} */ (el('input', {
      class: 'hidden', type: 'file', accept, ...(multiple ? { multiple: true } : {}),
    }));
    document.body.append(input);
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      if (files.length) onFiles(files);
    });
    input.addEventListener('cancel', () => input.remove());
    input.click();
  }

  /**
   * Both views repaint from the document, but a library action can land while the
   * store is batching its topics, so they are asked directly. The invalidations
   * coalesce into the same next frame either way.
   */
  function notifyViews() {
    preview?.invalidate?.(true);
    timeline?.invalidate?.(true);
  }

  /** @param {unknown} error */
  const describeError = (error) => (error instanceof Error ? error.message : String(error));

  function renderFooter() {
    const assets = store.doc.assets;
    const bytes = assets.reduce((total, asset) => total + (asset.size || 0), 0);
    const usedCount = assets.filter((asset) => usedIds.has(asset.id)).length;
    clear(footer);
    footer.append(
      el('span', { class: 'muted nowrap', text: `${assets.length} item${assets.length === 1 ? '' : 's'}` }),
      el('span', { class: 'muted', text: '\u00b7' }),
      el('span', { class: 'muted nowrap', text: formatBytes(bytes) }),
      el('div', { class: 'grow' }),
      el('span', {
        class: `stat-chip${usedCount > 0 ? ' stat-chip--ok' : ''}`,
        text: `${usedCount} in use`,
        title: 'Assets the composition references, including audio connections',
      }),
    );
  }

  function render() {
    // A tab can only be chosen in this panel, but a restored session should not be
    // able to paint an empty grid.
    if (!TABS.some((tab) => tab.id === store.ui.libraryTab)) store.ui.libraryTab = 'all';
    if (store.ui.libraryView !== 'list') store.ui.libraryView = 'grid';
    // A folder can disappear through undo, so the filter is revalidated here.
    if (store.ui.libraryFolderId && !store.doc.folders.some((folder) => folder.id === store.ui.libraryFolderId)) {
      store.ui.libraryFolderId = null;
    }
    for (const [id, node] of tabButtons) node.classList.toggle('tab--active', id === store.ui.libraryTab);
    if (search.value !== store.ui.libraryQuery) search.value = store.ui.libraryQuery ?? '';
    gridButton.classList.toggle('btn--active', store.ui.libraryView === 'grid');
    listButton.classList.toggle('btn--active', store.ui.libraryView === 'list');

    const missing = store.doc.assets.filter((asset) => asset.status === 'missing');
    relinkAllButton.classList.toggle('hidden', missing.length === 0);
    relinkAllButton.title = `Choose the ${missing.length} missing file${missing.length === 1 ? '' : 's'}; clips that use them are restored`;

    usedIds = usedAssetIds(store.doc);
    pickedIds = new Set(store.ui.selectedAssetIds ?? []);
    renderFolders();
    renderAssets();
    renderFooter();
  }

  function scheduleRender() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  }

  render();

  return { root, render, scheduleRender };
}
