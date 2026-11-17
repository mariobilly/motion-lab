/**
 * Workspace layout: where projects and media live, and the small primitives for
 * reading and writing them atomically.
 *
 *   <workspace>/
 *     projects/<projectId>.json          the versioned project document
 *     projects/<projectId>.draft.json    crash-recovery draft (autosave)
 *     projects/<projectId>.lock          present while a project is open
 *     media/<assetId>/original.<ext>     the untouched imported file
 *     media/<assetId>/preview.jpg        a small thumbnail the library draws
 *     media/<assetId>/audio.f32          decoded mono PCM for mixing
 *     media/<assetId>/meta.json          dimensions, duration, status
 *     exports/<jobId>/                   render scratch space
 */

import { promises as fs } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

/**
 * @typedef {object} Workspace
 * @property {string} root
 * @property {string} projects
 * @property {string} media
 * @property {string} exports
 * @property {string} logFile
 */

/**
 * @param {string} root
 * @returns {Promise<Workspace>}
 */
export async function openWorkspace(root) {
  const workspace = {
    root: resolve(root),
    projects: resolve(root, 'projects'),
    media: resolve(root, 'media'),
    exports: resolve(root, 'exports'),
    logFile: resolve(root, 'motion-lab.log'),
  };
  await Promise.all([
    fs.mkdir(workspace.projects, { recursive: true }),
    fs.mkdir(workspace.media, { recursive: true }),
    fs.mkdir(workspace.exports, { recursive: true }),
  ]);
  return workspace;
}

/**
 * Atomic JSON write: write to a temporary file, then rename over the target so
 * an interrupted write can never leave a half-saved project behind.
 * @param {string} filePath
 * @param {any} value
 */
export async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), 'utf8');
  await fs.rename(temporary, filePath);
}

/**
 * @param {string} filePath
 * @returns {Promise<any|null>}
 */
export async function readJson(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
export async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listFiles(dir, extension = '') {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && (!extension || extname(entry.name).toLowerCase() === extension))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * Sanitise a user-supplied name into a safe file stem.
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
export function safeStem(name, fallback = 'file') {
  const stem = basename(String(name || ''))
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return stem || fallback;
}

/**
 * Delete a directory tree, ignoring errors.
 * @param {string} dir
 */
export async function removeTree(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* best effort */
  }
}

/**
 * Recursively sum the size of a directory.
 * @param {string} dir
 * @returns {Promise<number>}
 */
export async function directorySize(dir) {
  let total = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) total += await directorySize(full);
      else if (entry.isFile()) total += (await fs.stat(full)).size;
    }
  } catch {
    /* missing directory counts as zero */
  }
  return total;
}

export { fs, join, resolve };
