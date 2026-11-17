/**
 * Tiny HTTP helpers: routing, JSON bodies, range-aware static files and
 * multipart parsing. Written against `node:http` only so the whole server runs
 * from a bare checkout with no install step.
 */

import { createReadStream, promises as fs } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
};

/**
 * @param {string} path
 * @returns {string}
 */
export function mimeFor(path) {
  const table = /** @type {Record<string,string>} */ (MIME_TYPES);
  return table[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} body
 * @param {Record<string,string>} [headers]
 */
export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} message
 * @param {Record<string,string>} [headers]
 */
export function sendText(res, status, message, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(message);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {any} [detail]
 */
export function sendError(res, status, code, message, detail) {
  sendJson(res, status, { error: { code, message, ...(detail === undefined ? {} : { detail }) } });
}

/**
 * Read and JSON-parse a request body, with a size ceiling.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<any>}
 */
export async function readBodyJson(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error(`Request body exceeded ${limit} bytes`);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<Buffer>}
 */
export async function readBuffer(req, limit = 512 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error(`Request body exceeded ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Serve a file with HTTP range support (needed for video scrubbing).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} filePath
 * @param {{download?:string, cacheSeconds?:number}} [options]
 */
export async function serveFile(req, res, filePath, options = {}) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    sendError(res, 404, 'not-found', 'File not found.');
    return;
  }
  if (!stat.isFile()) {
    sendError(res, 404, 'not-found', 'Not a file.');
    return;
  }

  /** @type {Record<string,string>} */
  const headers = {
    'content-type': mimeFor(filePath),
    'accept-ranges': 'bytes',
    'cache-control': options.cacheSeconds ? `public, max-age=${options.cacheSeconds}` : 'no-cache',
    'last-modified': stat.mtime.toUTCString(),
  };
  if (options.download) headers['content-disposition'] = `attachment; filename="${options.download.replace(/"/g, '')}"`;

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      if (Number.isFinite(start) && start <= end && start < stat.size) {
        headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
        headers['content-length'] = String(end - start + 1);
        res.writeHead(206, headers);
        createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      res.end();
      return;
    }
  }

  headers['content-length'] = String(stat.size);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

/**
 * Minimal multipart/form-data parser: enough for file uploads plus simple text
 * fields, without pulling in a dependency.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{fields:Record<string,string>, files:Array<{field:string, fileName:string, contentType:string, data:Buffer}>}>}
 */
export async function readMultipart(req) {
  const contentType = String(req.headers['content-type'] ?? '');
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundaryMatch) throw new Error('Expected a multipart/form-data request.');
  const boundary = Buffer.from(`--${boundaryMatch[1] ?? boundaryMatch[2]}`);
  /** @type {any} */
  const body = await readBuffer(req);

  /** @type {Record<string,string>} */
  const fields = {};
  /** @type {Array<{field:string, fileName:string, contentType:string, data:Buffer}>} */
  const files = [];

  let index = body.indexOf(boundary);
  if (index < 0) throw new Error('Malformed multipart body: boundary not found.');
  index += boundary.length;

  while (index < body.length) {
    // Skip the CRLF after the boundary.
    if (body[index] === 0x0d && body[index + 1] === 0x0a) index += 2;
    if (body[index] === 0x2d && body[index + 1] === 0x2d) break; // closing --
    const headerEnd = body.indexOf('\r\n\r\n', index);
    if (headerEnd < 0) break;
    const headerText = body.subarray(index, headerEnd).toString('utf8');
    const contentStart = headerEnd + 4;
    const nextBoundary = body.indexOf(boundary, contentStart);
    const contentEnd = nextBoundary < 0 ? body.length : nextBoundary - 2;
    const data = body.subarray(contentStart, Math.max(contentStart, contentEnd));

    const nameMatch = /name="([^"]*)"/i.exec(headerText);
    const fileMatch = /filename="([^"]*)"/i.exec(headerText);
    const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headerText);
    const field = nameMatch ? nameMatch[1] : 'file';

    if (fileMatch) {
      files.push({
        field,
        fileName: fileMatch[1] || 'upload.bin',
        contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
        data: Buffer.from(data),
      });
    } else {
      fields[field] = data.toString('utf8');
    }
    if (nextBoundary < 0) break;
    index = nextBoundary + boundary.length;
  }

  return { fields, files };
}

/**
 * Resolve a request path against a root directory, refusing traversal.
 * @param {string} root
 * @param {string} requestPath
 * @returns {string|null}
 */
export function safeJoin(root, requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const normalized = normalize(decoded).replace(/^([/\\])+/, '');
  const full = resolve(root, normalized);
  const rootResolved = resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) return null;
  return full;
}

/**
 * Append a line to a log file (best effort; never throws).
 * @param {string} filePath
 * @param {string} line
 */
export async function appendLog(filePath, line) {
  try {
    await fs.appendFile(filePath, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    /* logging must never break the request */
  }
}

export { fs, join, resolve };
