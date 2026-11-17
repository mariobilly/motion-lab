/**
 * The HTTP API and static file server.
 *
 * Endpoints (all JSON unless noted):
 *
 *   GET    /api/health                     tool status, workspace, capabilities
 *   GET    /api/projects                   list saved projects
 *   POST   /api/projects                   create
 *   GET    /api/projects/:id               load
 *   PUT    /api/projects/:id               save
 *   POST   /api/projects/:id/duplicate     duplicate
 *   DELETE /api/projects/:id               delete
 *   GET    /api/projects/:id/draft         crash-recovery draft, if any
 *   POST   /api/projects/:id/draft         autosave draft
 *   POST   /api/projects/import            import a project (json or package)
 *
 *   GET    /api/assets                     library listing
 *   POST   /api/assets                     upload (multipart)
 *   POST   /api/assets/:id/file            replace the file, keep the id
 *   DELETE /api/assets/:id
 *   GET    /api/assets/:id/file            original bytes (range supported)
 *   GET    /api/assets/:id/preview         thumbnail
 *   POST   /api/assets/:id/preview         store a browser-generated thumbnail
 *   POST   /api/assets/:id/samples         store decoded PCM for mixing
 *   GET    /api/assets/:id/audio           decoded PCM as WAV
 *   GET    /api/assets/:id/frames?at=      a still from a video, as JPEG
 *
 *   GET    /api/exports/formats            supported formats on this machine
 *   POST   /api/exports                    start a job
 *   GET    /api/exports/:id                job status
 *   POST   /api/exports/:id/cancel         cancel
 *   GET    /api/exports/:id/download       result bytes
 */

import { promises as fs } from 'node:fs';
import { basename, extname, join } from 'node:path';

import {
  appendLog, readBodyJson, readMultipart, sendError, sendJson, sendText, serveFile, safeJoin,
} from './http.js';
import { exists, listFiles, readJson, removeTree, safeStem, writeJsonAtomic } from './workspace.js';
import {
  decodeAudioToWav, exportFormats, makeThumbnail, probeMedia, probeTools, run,
} from './media.js';
import { cleanExports, createJob, exportFormats as formatsFor, jobs, runExport } from './exporter.js';
import { normalizeProject, validateProject } from '../core/document.js';
import { PROJECT_VERSION, uid } from '../core/schema.js';

/** @typedef {import('./workspace.js').Workspace} Workspace */

/**
 * @param {object} context
 * @param {Workspace} context.workspace
 * @param {string} context.root          Project checkout root (for static files).
 * @param {number} context.port
 * @param {string} context.baseUrl
 * @returns {(req:import('node:http').IncomingMessage, res:import('node:http').ServerResponse) => Promise<boolean>}
 */
export function createApi({ workspace, root, port, baseUrl }) {
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<boolean>} true when the request was handled
   */
  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return false;

    try {
      /* ---------------- health ---------------- */
      if (path === '/api/health' && req.method === 'GET') {
        const tools = await probeTools();
        sendJson(res, 200, {
          ok: true,
          app: 'motion-lab',
          version: PROJECT_VERSION,
          workspace: workspace.root,
          baseUrl,
          tools: {
            ffmpeg: tools.ffmpeg,
            ffprobe: tools.ffprobe,
            version: tools.version ?? null,
            hardwareAcceleration: tools.hardwareAcceleration ?? null,
          },
          formats: exportFormats(tools),
        });
        return true;
      }

      /* ---------------- projects ---------------- */
      if (path === '/api/projects' && req.method === 'GET') {
        sendJson(res, 200, { projects: await listProjects(workspace) });
        return true;
      }

      if (path === '/api/projects' && req.method === 'POST') {
        const body = await readBodyJson(req);
        const { doc } = normalizeProject(body.doc);
        doc.meta.id = body.id ? String(body.id) : doc.meta.id;
        doc.meta.updatedAt = Date.now();
        await saveProject(workspace, doc);
        sendJson(res, 201, { project: await projectSummary(workspace, doc.meta.id) });
        return true;
      }

      if (path === '/api/projects/import' && req.method === 'POST') {
        const result = await importProject(workspace, req);
        sendJson(res, 201, result);
        return true;
      }

      const projectMatch = /^\/api\/projects\/([^/]+)(\/[a-z]+)?$/.exec(path);
      if (projectMatch) {
        const id = decodeURIComponent(projectMatch[1]);
        const action = projectMatch[2] ?? '';
        const projectFile = join(workspace.projects, `${id}.json`);
        const draftPath = join(workspace.projects, `${id}.draft.json`);

        if (action === '' && req.method === 'GET') {
          const raw = await readJson(projectFile);
          if (!raw) {
            sendError(res, 404, 'not-found', `Project "${id}" was not found.`);
            return true;
          }
          const { doc, issues } = normalizeProject(raw);
          doc.meta.lastOpenedAt = Date.now();
          sendJson(res, 200, { doc, issues, draft: (await exists(draftPath)) ? await readJson(draftPath) : null });
          return true;
        }

        if (action === '' && req.method === 'PUT') {
          const body = await readBodyJson(req);
          const { doc, issues } = normalizeProject(body.doc ?? body);
          doc.meta.id = id;
          doc.meta.updatedAt = Date.now();
          await saveProject(workspace, doc);
          if (body.clearDraft !== false) await removeTree(draftPath);
          sendJson(res, 200, { ok: true, savedAt: doc.meta.updatedAt, issues });
          return true;
        }

        if (action === '' && req.method === 'DELETE') {
          await removeTree(projectFile);
          await removeTree(draftPath);
          sendJson(res, 200, { ok: true });
          return true;
        }

        if (action === '/duplicate' && req.method === 'POST') {
          const raw = await readJson(projectFile);
          if (!raw) {
            sendError(res, 404, 'not-found', `Project "${id}" was not found.`);
            return true;
          }
          const { doc } = normalizeProject(raw);
          const body = await readBodyJson(req).catch(() => ({}));
          doc.meta.id = uid('proj');
          doc.meta.name = body.name ? String(body.name) : `${doc.meta.name} copy`;
          doc.meta.createdAt = Date.now();
          doc.meta.updatedAt = Date.now();
          delete doc.meta.thumbnail;
          await saveProject(workspace, doc);
          sendJson(res, 201, { project: await projectSummary(workspace, doc.meta.id) });
          return true;
        }

        if (action === '/draft' && req.method === 'GET') {
          const draft = await readJson(draftPath);
          sendJson(res, 200, { draft });
          return true;
        }

        if (action === '/draft' && req.method === 'POST') {
          const body = await readBodyJson(req);
          const draft = {
            savedAt: Date.now(),
            doc: body.doc,
            reason: body.reason ?? 'autosave',
          };
          await writeJsonAtomic(draftPath, draft);
          sendJson(res, 200, { ok: true, savedAt: draft.savedAt });
          return true;
        }

        if (action === '/draft' && req.method === 'DELETE') {
          await removeTree(draftPath);
          sendJson(res, 200, { ok: true });
          return true;
        }

        if (action === '/package' && req.method === 'POST') {
          const raw = await readJson(projectFile);
          if (!raw) {
            sendError(res, 404, 'not-found', `Project "${id}" was not found.`);
            return true;
          }
          const { doc } = normalizeProject(raw);
          const job = createJob(workspace, doc, { kind: 'package' });
          runExport({ workspace, baseUrl, doc, job, options: { kind: 'package', fileName: doc.meta.name } })
            .catch((error) => appendLog(workspace.logFile, `package job failed: ${error}`));
          sendJson(res, 202, { job: jobState(job) });
          return true;
        }

        if (action === '/validate' && req.method === 'GET') {
          const raw = await readJson(projectFile);
          if (!raw) {
            sendError(res, 404, 'not-found', `Project "${id}" was not found.`);
            return true;
          }
          const { doc, issues } = normalizeProject(raw);
          sendJson(res, 200, { issues: [...issues, ...validateProject(doc)] });
          return true;
        }
      }

      /* ---------------- assets ---------------- */
      if (path === '/api/assets' && req.method === 'GET') {
        sendJson(res, 200, { assets: await listAssets(workspace) });
        return true;
      }

      if (path === '/api/assets' && req.method === 'POST') {
        const { fields, files } = await readMultipart(req);
        const uploaded = [];
        for (const file of files) {
          const record = await ingestAsset(workspace, file, fields);
          uploaded.push(record);
        }
        sendJson(res, 201, { assets: uploaded });
        return true;
      }

      const assetMatch = /^\/api\/assets\/([^/]+)(\/[a-z]+)?$/.exec(path);
      if (assetMatch) {
        const id = decodeURIComponent(assetMatch[1]);
        const action = assetMatch[2] ?? '';
        const mediaDir = join(workspace.media, id);
        const metaFile = join(mediaDir, 'meta.json');
        const meta = await readJson(metaFile);

        if (action === '' && req.method === 'GET') {
          if (!meta) {
            sendError(res, 404, 'not-found', 'That media file is not in the library.');
            return true;
          }
          sendJson(res, 200, { asset: meta });
          return true;
        }

        if (action === '' && req.method === 'PATCH') {
          const body = await readBodyJson(req);
          if (!meta) {
            sendError(res, 404, 'not-found', 'That media file is not in the library.');
            return true;
          }
          if (body.name) meta.name = String(body.name).slice(0, 200);
          if (body.folderId !== undefined) {
            if (body.folderId) meta.folderId = String(body.folderId);
            else delete meta.folderId;
          }
          await writeJsonAtomic(metaFile, meta);
          sendJson(res, 200, { asset: meta });
          return true;
        }

        if (action === '' && req.method === 'DELETE') {
          await removeTree(mediaDir);
          sendJson(res, 200, { ok: true });
          return true;
        }

        if (action === '/file' && req.method === 'GET') {
          const original = await findOriginalFile(mediaDir);
          if (!original) {
            sendError(res, 404, 'not-found', 'The original file for this asset is missing.');
            return true;
          }
          await serveFile(req, res, original, { cacheSeconds: 60 });
          return true;
        }

        if (action === '/file' && (req.method === 'POST' || req.method === 'PUT')) {
          const { files } = await readMultipart(req);
          if (files.length === 0) {
            sendError(res, 400, 'bad-request', 'No file was uploaded.');
            return true;
          }
          const record = await replaceAssetFile(workspace, id, files[0], meta);
          sendJson(res, 200, { asset: record });
          return true;
        }

        if (action === '/relink' && req.method === 'POST') {
          const { files } = await readMultipart(req);
          if (files.length === 0) {
            sendError(res, 400, 'bad-request', 'No file was uploaded.');
            return true;
          }
          const record = await replaceAssetFile(workspace, id, files[0], meta);
          sendJson(res, 200, { asset: record });
          return true;
        }

        if (action === '/preview' && req.method === 'GET') {
          const preview = join(mediaDir, 'preview.jpg');
          if (await exists(preview)) {
            await serveFile(req, res, preview, { cacheSeconds: 300 });
            return true;
          }
          const original = await findOriginalFile(mediaDir);
          if (!original) {
            sendError(res, 404, 'not-found', 'No preview available.');
            return true;
          }
          const tools = await probeTools();
          const generated = await makeThumbnail(tools, original, preview, { time: 1, width: 400, height: 400 });
          if (generated) {
            await serveFile(req, res, preview, { cacheSeconds: 300 });
            return true;
          }
          sendError(res, 404, 'not-found', 'No preview available for this file.');
          return true;
        }

        if (action === '/preview' && req.method === 'POST') {
          const { fields, files } = await readMultipart(req);
          if (files.length === 0) {
            sendError(res, 400, 'bad-request', 'No preview data was uploaded.');
            return true;
          }
          await fs.mkdir(mediaDir, { recursive: true });
          await fs.writeFile(join(mediaDir, 'preview.jpg'), files[0].data);
          if (fields.width && fields.height && meta) {
            meta.width = Number(fields.width) || meta.width;
            meta.height = Number(fields.height) || meta.height;
            meta.status = 'ok';
            delete meta.statusDetail;
            await writeJsonAtomic(metaFile, meta);
          }
          sendJson(res, 200, { ok: true });
          return true;
        }

        if (action === '/samples' && req.method === 'POST') {
          await fs.mkdir(mediaDir, { recursive: true });
          const { files } = await readMultipart(req);
          if (files.length === 0) {
            sendError(res, 400, 'bad-request', 'No audio data was uploaded.');
            return true;
          }
          await fs.writeFile(join(mediaDir, 'samples.wav'), files[0].data);
          sendJson(res, 200, { ok: true, bytes: files[0].data.length });
          return true;
        }

        if (action === '/audio' && req.method === 'GET') {
          const samples = join(mediaDir, 'samples.wav');
          if (await exists(samples)) {
            await serveFile(req, res, samples, { cacheSeconds: 300 });
            return true;
          }
          const original = await findOriginalFile(mediaDir);
          if (!original) {
            sendError(res, 404, 'not-found', 'No audio available.');
            return true;
          }
          const tools = await probeTools();
          const generated = await decodeAudioToWav(tools, original, join(mediaDir, 'decoded.wav'), 48000);
          if (generated) {
            await serveFile(req, res, join(mediaDir, 'decoded.wav'), { cacheSeconds: 300 });
            return true;
          }
          sendError(res, 503, 'no-audio-tool', 'Decoding audio needs ffmpeg on the server.');
          return true;
        }

        if (action === '/frames' && req.method === 'GET') {
          const at = Number(url.searchParams.get('at') ?? 0);
          const original = await findOriginalFile(mediaDir);
          if (!original) {
            sendError(res, 404, 'not-found', 'The original file for this asset is missing.');
            return true;
          }
          const tools = await probeTools();
          const target = join(mediaDir, 'frame.jpg');
          const ok = await makeThumbnail(tools, original, target, { time: Math.max(0, at), width: 640, height: 640 });
          if (ok) {
            await serveFile(req, res, target, { cacheSeconds: 0 });
            return true;
          }
          sendError(res, 503, 'no-frame-tool', 'Extracting video frames needs ffmpeg on the server.');
          return true;
        }

        if (action === '/probe' && req.method === 'POST') {
          const original = await findOriginalFile(mediaDir);
          if (!original || !meta) {
            sendError(res, 404, 'not-found', 'The original file for this asset is missing.');
            return true;
          }
          const tools = await probeTools(true);
          const probe = await probeMedia(tools, original);
          if (probe.error) {
            meta.status = 'error';
            meta.statusDetail = probe.error;
          } else {
            meta.width = probe.width || meta.width;
            meta.height = probe.height || meta.height;
            meta.duration = probe.duration || meta.duration;
            if (probe.fps) meta.fps = probe.fps;
            meta.status = 'ok';
            delete meta.statusDetail;
          }
          await writeJsonAtomic(metaFile, meta);
          sendJson(res, 200, { asset: meta, probe });
          return true;
        }
      }

      /* ---------------- exports ---------------- */
      if (path === '/api/exports/formats' && req.method === 'GET') {
        const tools = await probeTools();
        sendJson(res, 200, {
          formats: exportFormats(tools),
          tools: { ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, version: tools.version ?? null },
        });
        return true;
      }

      if (path === '/api/exports' && req.method === 'POST') {
        const body = await readBodyJson(req);
        const docInput = body.doc
          ? body.doc
          : await readJson(join(workspace.projects, `${body.projectId}.json`));
        if (!docInput) {
          sendError(res, 404, 'not-found', 'No project document was supplied and none could be loaded.');
          return true;
        }
        const { doc, issues } = normalizeProject(docInput);
        const job = createJob(workspace, doc, { kind: body.kind ?? 'video' });
        runExport({
          workspace,
          baseUrl,
          doc,
          job,
          options: {
            kind: body.kind ?? 'video',
            format: body.format,
            width: body.width ?? doc.composition.width,
            height: body.height ?? doc.composition.height,
            fps: body.fps ?? doc.composition.fps,
            rangeStart: body.rangeStart ?? doc.exportRange.in,
            rangeEnd: body.rangeEnd ?? doc.exportRange.out,
            quality: body.quality ?? 85,
            time: body.time,
            // `stills` renders a list of frames from one browser session, which
            // is what makes a batch of fifty look outputs cheap.
            items: Array.isArray(body.items) ? body.items : undefined,
            fileName: body.fileName,
            captureScale: body.captureScale ?? 1,
            keepScratch: Boolean(body.keepScratch),
          },
        }).catch((error) => appendLog(workspace.logFile, `export ${job.id} failed: ${error?.stack ?? error}`));
        sendJson(res, 202, { job: jobState(job), issues });
        return true;
      }

      const exportMatch = /^\/api\/exports\/([^/]+)(\/[a-z-]+)?(\/.*)?$/.exec(path);
      if (exportMatch) {
        const id = decodeURIComponent(exportMatch[1]);
        const action = exportMatch[2] ?? '';
        const rest = exportMatch[3] ?? '';
        const job = jobs.get(id);

        if (rest && (action === '/assets' || action === '/video')) {
          // Serve prepared export media to the render harness.
          const relative = decodeURIComponent(rest.replace(/^\//, ''));
          const base = action === '/assets' ? 'assets' : 'video';
          const target = safeJoin(join(workspace.exports, id), `${base}/${relative}`);
          if (!target) {
            sendError(res, 400, 'bad-request', 'Invalid export media path.');
            return true;
          }
          await serveFile(req, res, target, { cacheSeconds: 3600 });
          return true;
        }

        if (action === '' && req.method === 'GET') {
          if (!job) {
            sendError(res, 404, 'not-found', 'That export job is no longer tracked. It may have finished long ago.');
            return true;
          }
          sendJson(res, 200, { job: jobState(job) });
          return true;
        }

        if (action === '/cancel' && req.method === 'POST') {
          if (!job) {
            sendError(res, 404, 'not-found', 'That export job is not tracked.');
            return true;
          }
          job.cancel?.();
          sendJson(res, 200, { job: jobState(job) });
          return true;
        }

        if (action === '/download' && req.method === 'GET') {
          if (!job || !job.outputPath) {
            sendError(res, 404, 'not-found', 'That export has no downloadable result yet.');
            return true;
          }
          await serveFile(req, res, job.outputPath, { download: job.outputName ?? basename(job.outputPath) });
          return true;
        }

        if (action === '/scratch' && rest && req.method === 'GET') {
          const target = safeJoin(join(workspace.exports, id), decodeURIComponent(rest.replace(/^\//, '')));
          if (!target) {
            sendError(res, 400, 'bad-request', 'Invalid path.');
            return true;
          }
          await serveFile(req, res, target, { cacheSeconds: 0 });
          return true;
        }
      }

      sendError(res, 404, 'no-route', `No API route matches ${req.method} ${path}.`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendLog(workspace.logFile, `api error on ${req.method} ${path}: ${message}`);
      sendError(res, 500, 'internal', message);
      return true;
    }
  };
}

/* ------------------------------------------------------------------ *
 * Project helpers
 * ------------------------------------------------------------------ */

/**
 * @param {Workspace} workspace
 * @param {import('../core/schema.js').ProjectDoc} doc
 */
async function saveProject(workspace, doc) {
  await writeJsonAtomic(join(workspace.projects, `${doc.meta.id}.json`), doc);
}

/**
 * @param {Workspace} workspace
 * @param {string} id
 */
async function projectSummary(workspace, id) {
  const raw = await readJson(join(workspace.projects, `${id}.json`));
  if (!raw) return null;
  const hasDraft = await exists(join(workspace.projects, `${id}.draft.json`));
  return {
    id: raw.meta?.id ?? id,
    name: raw.meta?.name ?? 'Untitled',
    createdAt: raw.meta?.createdAt ?? 0,
    updatedAt: raw.meta?.updatedAt ?? 0,
    lastOpenedAt: raw.meta?.lastOpenedAt ?? null,
    thumbnail: raw.meta?.thumbnail ?? null,
    width: raw.composition?.width ?? 0,
    height: raw.composition?.height ?? 0,
    fps: raw.composition?.fps ?? 30,
    duration: raw.composition?.duration ?? 0,
    trackCount: Array.isArray(raw.tracks) ? raw.tracks.length : 0,
    clipCount: Array.isArray(raw.clips) ? raw.clips.length : 0,
    assetCount: Array.isArray(raw.assets) ? raw.assets.length : 0,
    hasDraft,
  };
}

/**
 * @param {Workspace} workspace
 */
async function listProjects(workspace) {
  const files = await listFiles(workspace.projects, '.json');
  /** @type {any[]} */
  const summaries = [];
  for (const file of files) {
    if (file.endsWith('.draft.json')) continue;
    const raw = await readJson(file);
    if (!raw || raw.format !== 'motion-lab') continue;
    const id = basename(file, '.json');
    summaries.push(await projectSummary(workspace, id));
  }
  return summaries
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/**
 * Import a project from JSON or a `.mlab.zip` package.
 * @param {Workspace} workspace
 * @param {import('node:http').IncomingMessage} req
 */
async function importProject(workspace, req) {
  const { fields, files } = await readMultipart(req);
  if (files.length === 0) throw new Error('No file was uploaded.');
  const file = files[0];
  const isZip = file.data.length > 4 && file.data.readUInt32LE(0) === 0x04034b50;

  if (!isZip) {
    const parsed = JSON.parse(file.data.toString('utf8'));
    const payload = parsed.doc ?? parsed;
    const { doc, issues } = normalizeProject(payload);
    doc.meta.id = uid('proj');
    doc.meta.name = fields.name ? String(fields.name) : (doc.meta.name || 'Imported project');
    doc.meta.updatedAt = Date.now();
    await saveProject(workspace, doc);
    return { project: await projectSummary(workspace, doc.meta.id), issues, importedAssets: 0 };
  }

  const entries = readZipEntries(file.data);
  const projectEntry = entries.find((entry) => entry.name === 'project.json');
  if (!projectEntry) throw new Error('That zip does not look like a Motion Lab package: project.json is missing.');
  const { doc, issues } = normalizeProject(JSON.parse(projectEntry.data.toString('utf8')));
  doc.meta.id = uid('proj');
  doc.meta.name = fields.name ? String(fields.name) : `${doc.meta.name}`;
  doc.meta.updatedAt = Date.now();

  let importedAssets = 0;
  for (const entry of entries) {
    const match = /^media\/([^/]+)\/(.+)$/.exec(entry.name);
    if (!match) continue;
    const [, assetId, fileName] = match;
    const mediaDir = join(workspace.media, assetId);
    await fs.mkdir(mediaDir, { recursive: true });
    const extension = extname(fileName) || '.bin';
    await fs.writeFile(join(mediaDir, `original${extension}`), entry.data);
    const asset = doc.assets.find((candidate) => candidate.id === assetId);
    if (asset) {
      asset.fileName = fileName;
      asset.status = 'ok';
      delete asset.statusDetail;
    }
    importedAssets += 1;
  }
  await saveProject(workspace, doc);
  return { project: await projectSummary(workspace, doc.meta.id), issues, importedAssets };
}

/**
 * Read stored (uncompressed) zip entries. Packages written by Motion Lab use
 * the stored method, which keeps this reader tiny and dependency-free.
 * @param {Buffer} buffer
 * @returns {Array<{name:string, data:Buffer}>}
 */
function readZipEntries(buffer) {
  /** @type {Array<{name:string, data:Buffer}>} */
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const dataStart = offset + 30 + nameLength + extraLength;
    if (method !== 0) {
      throw new Error(`The package entry "${name}" uses compression method ${method}; Motion Lab packages are stored uncompressed. Re-export the package from Motion Lab.`);
    }
    entries.push({ name, data: buffer.subarray(dataStart, dataStart + (compressedSize || uncompressedSize)) });
    offset = dataStart + (compressedSize || uncompressedSize);
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * Asset helpers
 * ------------------------------------------------------------------ */

/**
 * @param {Workspace} workspace
 */
async function listAssets(workspace) {
  let directories = [];
  try {
    const entries = await fs.readdir(workspace.media, { withFileTypes: true });
    directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  /** @type {any[]} */
  const assets = [];
  for (const directory of directories) {
    const meta = await readJson(join(workspace.media, directory, 'meta.json'));
    if (!meta) continue;
    const original = await findOriginalFile(join(workspace.media, directory));
    if (!original) {
      meta.status = 'missing';
      meta.statusDetail = 'The original file is no longer in the media folder. Relink it or re-import.';
    } else if (meta.status === 'missing') {
      meta.status = 'ok';
      delete meta.statusDetail;
    }
    meta.hasPreview = await exists(join(workspace.media, directory, 'preview.jpg'));
    assets.push(meta);
  }
  return assets.sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
}

/**
 * @param {string} mediaDir
 * @returns {Promise<string|null>}
 */
async function findOriginalFile(mediaDir) {
  try {
    const entries = await fs.readdir(mediaDir);
    const match = entries.find((name) => name.startsWith('original.'));
    return match ? join(mediaDir, match) : null;
  } catch {
    return null;
  }
}

/**
 * Store an uploaded file as a new asset.
 * @param {Workspace} workspace
 * @param {{fileName:string, contentType:string, data:Buffer}} file
 * @param {Record<string,string>} fields
 */
async function ingestAsset(workspace, file, fields) {
  const id = uid('asset');
  const mediaDir = join(workspace.media, id);
  await fs.mkdir(mediaDir, { recursive: true });
  const extension = (extname(file.fileName) || guessExtension(file.contentType)).toLowerCase();
  await fs.writeFile(join(mediaDir, `original${extension}`), file.data);

  const tools = await probeTools();
  const probe = await probeMedia(tools, join(mediaDir, `original${extension}`));
  const hint = fields.kindHint || '';
  let kind = probe.hasVideo ? (probe.duration > 0.05 ? 'video' : 'image') : probe.hasAudio ? 'audio' : 'image';
  if (hint && ['image', 'video', 'audio'].includes(hint)) kind = hint;

  /** @type {any} */
  const record = {
    id,
    kind,
    name: fields.name || basename(file.fileName).replace(/\.[^.]+$/, ''),
    fileName: basename(file.fileName),
    size: file.data.length,
    mime: file.contentType || 'application/octet-stream',
    width: probe.width || 0,
    height: probe.height || 0,
    duration: probe.duration || 0,
    origin: 'library',
    status: probe.error && !tools.ffprobe ? 'analyzing' : probe.error ? 'error' : 'ok',
    addedAt: new Date().toISOString(),
    ...(probe.fps ? { fps: probe.fps } : {}),
    ...(probe.error ? { statusDetail: probe.error } : {}),
    ...(fields.folderId ? { folderId: fields.folderId } : {}),
  };
  if (record.status === 'analyzing') {
    record.statusDetail = 'Stored on the server. The browser will read its dimensions and duration when the library loads.';
  }

  // Best-effort server-side preview; the browser fills in the rest.
  if (kind === 'image' || kind === 'video') {
    await makeThumbnail(tools, join(mediaDir, `original${extension}`), join(mediaDir, 'preview.jpg'), {
      time: kind === 'video' ? 0.5 : 0,
      width: 400,
      height: 400,
    });
  }
  if (kind === 'audio') {
    await decodeAudioToWav(tools, join(mediaDir, `original${extension}`), join(mediaDir, 'samples.wav'), 48000);
  }

  await writeJsonAtomic(join(mediaDir, 'meta.json'), record);
  return { ...record, hasPreview: await exists(join(mediaDir, 'preview.jpg')) };
}

/**
 * Replace an asset's file while keeping its id, so every clip that references it
 * keeps its placement, effects and animation.
 * @param {Workspace} workspace
 * @param {string} id
 * @param {{fileName:string, contentType:string, data:Buffer}} file
 * @param {any} meta
 */
async function replaceAssetFile(workspace, id, file, meta) {
  const mediaDir = join(workspace.media, id);
  await fs.mkdir(mediaDir, { recursive: true });
  // Remove the previous original so a stale file cannot be picked up later.
  const existing = await findOriginalFile(mediaDir);
  if (existing) await removeTree(existing);
  const extension = (extname(file.fileName) || guessExtension(file.contentType)).toLowerCase();
  const target = join(mediaDir, `original${extension}`);
  await fs.writeFile(target, file.data);

  const tools = await probeTools();
  const probe = await probeMedia(tools, target);
  const record = {
    ...(meta ?? { id, origin: 'library', addedAt: new Date().toISOString() }),
    id,
    fileName: basename(file.fileName),
    size: file.data.length,
    mime: file.contentType || 'application/octet-stream',
    width: probe.width || meta?.width || 0,
    height: probe.height || meta?.height || 0,
    duration: probe.duration || meta?.duration || 0,
    status: probe.error ? 'error' : 'ok',
  };
  if (probe.fps) record.fps = probe.fps;
  if (probe.error) record.statusDetail = probe.error;
  else delete record.statusDetail;

  if (record.kind === 'audio') {
    await decodeAudioToWav(tools, target, join(mediaDir, 'samples.wav'), 48000);
  } else {
    await makeThumbnail(tools, target, join(mediaDir, 'preview.jpg'), {
      time: record.kind === 'video' ? 0.5 : 0,
      width: 400,
      height: 400,
    });
  }
  await writeJsonAtomic(join(mediaDir, 'meta.json'), record);
  return { ...record, hasPreview: await exists(join(mediaDir, 'preview.jpg')) };
}

/**
 * @param {string} contentType
 * @returns {string}
 */
function guessExtension(contentType) {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/mp4': '.m4a',
    'audio/ogg': '.ogg',
    'audio/flac': '.flac',
  };
  const table = /** @type {Record<string,string>} */ (map);
  return table[contentType] ?? '.bin';
}

/**
 * Shape a job for the API (strips the closure).
 * @param {import('./exporter.js').ExportJob} job
 */
export function jobState(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    stage: job.stage,
    progress: Number(job.progress.toFixed(4)),
    framesTotal: job.framesTotal,
    framesDone: job.framesDone,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    outputName: job.outputName ?? null,
    outputMime: job.outputMime ?? null,
    outputSize: job.outputSize ?? null,
    downloadUrl: job.outputName ? `/api/exports/${job.id}/download` : null,
    error: job.error ?? null,
    warnings: job.warnings ?? [],
    report: job.report ?? null,
  };
}

export { cleanExports, exists, run, sendText };