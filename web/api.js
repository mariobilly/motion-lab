/**
 * HTTP client for the Motion Lab server.
 *
 * Thin on purpose: every call either returns data or throws an `ApiError` whose
 * message is written to be shown to the user as-is ("that file is missing",
 * "ffmpeg is not installed"), because the UI surfaces server-side problems
 * verbatim rather than inventing its own wording.
 */

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {string} [code]
   */
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code ?? 'error';
  }
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function request(path, init) {
  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw new ApiError(
      `Motion Lab could not reach its server. Is it still running? (${error instanceof Error ? error.message : error})`,
      0,
      'offline',
    );
  }
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const message = body && typeof body === 'object' && body.error
      ? String(body.error.message ?? 'Request failed')
      : `Request failed with HTTP ${response.status}`;
    throw new ApiError(message, response.status, body?.error?.code);
  }
  return body;
}

/**
 * @param {string} path
 * @returns {Promise<any>}
 */
function json(path) {
  return request(path);
}

/**
 * @param {string} path
 * @param {any} body
 * @param {string} [method]
 * @returns {Promise<any>}
 */
function send(path, body, method = 'POST') {
  return request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

export const api = {
  health: () => json('/api/health'),

  /* projects */
  listProjects: () => json('/api/projects'),
  createProject: (doc, id) => send('/api/projects', { doc, id }),
  loadProject: (id) => json(`/api/projects/${encodeURIComponent(id)}`),
  saveProject: (id, doc, options = {}) => request(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ doc, ...options }),
  }),
  deleteProject: (id) => request(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  duplicateProject: (id, name) => send(`/api/projects/${encodeURIComponent(id)}/duplicate`, { name }),
  projectDraft: (id) => json(`/api/projects/${encodeURIComponent(id)}/draft`),
  saveDraft: (id, doc, reason) => send(`/api/projects/${encodeURIComponent(id)}/draft`, { doc, reason }),
  clearDraft: (id) => request(`/api/projects/${encodeURIComponent(id)}/draft`, { method: 'DELETE' }),
  validateProject: (id) => json(`/api/projects/${encodeURIComponent(id)}/validate`),
  packageProject: (id) => send(`/api/projects/${encodeURIComponent(id)}/package`, {}),
  importProjectFile: async (file) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request('/api/projects/import', { method: 'POST', body: form });
  },

  /* assets */
  listAssets: () => json('/api/assets'),
  uploadAssets: async (files, fields = {}, onProgress) => {
    const form = new FormData();
    for (const file of files) form.append('file', file, file.name);
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    return request('/api/assets', { method: 'POST', body: form });
  },
  updateAsset: (id, patch) => send(`/api/assets/${encodeURIComponent(id)}`, patch, 'PATCH'),
  deleteAsset: (id) => request(`/api/assets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Replace the file behind an asset id, keeping every clip that uses it. */
  replaceAssetFile: async (id, file, endpoint = 'file') => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request(`/api/assets/${encodeURIComponent(id)}/${endpoint}`, { method: 'POST', body: form });
  },
  probeAsset: (id) => send(`/api/assets/${encodeURIComponent(id)}/probe`, {}),
  uploadPreview: async (id, blob, width, height) => {
    const form = new FormData();
    form.append('file', blob, 'preview.jpg');
    form.append('width', String(width));
    form.append('height', String(height));
    return request(`/api/assets/${encodeURIComponent(id)}/preview`, { method: 'POST', body: form });
  },
  uploadSamples: async (id, blob) => {
    const form = new FormData();
    form.append('file', blob, 'samples.wav');
    return request(`/api/assets/${encodeURIComponent(id)}/samples`, { method: 'POST', body: form });
  },

  /* exports */
  exportFormats: () => json('/api/exports/formats'),
  startExport: (payload) => send('/api/exports', payload),
  exportJob: (id) => json(`/api/exports/${encodeURIComponent(id)}`),
  cancelExport: (id) => send(`/api/exports/${encodeURIComponent(id)}/cancel`, {}),
};

/**
 * @param {string} assetId
 * @returns {string}
 */
export function assetFileUrl(assetId) {
  return `/api/assets/${encodeURIComponent(assetId)}/file`;
}

/**
 * @param {string} assetId
 * @returns {string}
 */
export function assetPreviewUrl(assetId) {
  return `/api/assets/${encodeURIComponent(assetId)}/preview`;
}

/**
 * @param {string} assetId
 * @returns {string}
 */
export function assetAudioUrl(assetId) {
  return `/api/assets/${encodeURIComponent(assetId)}/audio`;
}

/**
 * @param {string} assetId
 * @param {number} time
 * @returns {string}
 */
export function assetFrameUrl(assetId, time) {
  return `/api/assets/${encodeURIComponent(assetId)}/frames?at=${time.toFixed(3)}`;
}
