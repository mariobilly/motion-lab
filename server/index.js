#!/usr/bin/env node
/**
 * Motion Lab server.
 *
 * Serves the editor, the core engine modules (the browser loads them as native
 * ES modules -- there is no bundler in the loop), the render harness used by the
 * exporter, and the JSON API.
 *
 *   node server/index.js [--port 5273] [--host 127.0.0.1] [--workspace ./workspace] [--open]
 */

import { createServer } from 'node:http';
import { existsSync, promises as fsRaw } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Untyped alias: see the note in `exporter.js` about `Buffer` and
 * `fs.promises.writeFile` under `checkJs`.
 * @type {any}
 */
const fs = fsRaw;

import { appendLog, sendText, serveFile, safeJoin } from './http.js';
import { openWorkspace } from './workspace.js';
import { createApi, cleanExports } from './routes.js';
import { probeTools } from './exporter.js';
import { findBrowser } from './cdp.js';
import { exportFormats } from './media.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? process.env.MOTION_LAB_PORT ?? 5273);
const host = String(args.host ?? process.env.MOTION_LAB_HOST ?? '127.0.0.1');
const workspaceRoot = resolve(String(args.workspace ?? process.env.MOTION_LAB_WORKSPACE ?? join(ROOT, 'workspace')));
const shouldOpen = Boolean(args.open);

/**
 * Static mounts. `mount` is the URL prefix, `dir` the directory served.
 */
const MOUNTS = [
  { mount: '/', dir: join(ROOT, 'web'), index: 'index.html' },
  { mount: '/core', dir: join(ROOT, 'core') },
  { mount: '/harness', dir: join(ROOT, 'web') },
  { mount: '/vendor', dir: join(ROOT, 'web', 'vendor') },
];

async function main() {
  const workspace = await openWorkspace(workspaceRoot);
  const baseUrl = `http://${host}:${port}`;
  const api = createApi({ workspace, root: ROOT, port, baseUrl });

  await cleanExports(workspace);
  const tools = await probeTools();
  const browser = findBrowser();

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/';

    if (url.startsWith('/api/')) {
      const handled = await api(req, res);
      if (!handled) sendText(res, 404, 'Not found');
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed');
      return;
    }

    const pathname = decodeURIComponent(url.split('?')[0]);

    // A tiny live-reload channel so editing a source file refreshes the editor.
    if (pathname === '/__motionlab/reload') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      reloadClients.add(res);
      req.on('close', () => reloadClients.delete(res));
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      await serveFile(req, res, join(ROOT, 'web', 'index.html'), { cacheSeconds: 0 });
      return;
    }

    for (const mount of MOUNTS) {
      if (mount.mount === '/' || mount.mount === '/harness') continue;
      if (!pathname.startsWith(mount.mount + '/')) continue;
      const relative = pathname.slice(mount.mount.length);
      const target = safeJoin(mount.dir, relative);
      if (!target) {
        sendText(res, 400, 'Bad path');
        return;
      }
      if (existsSync(target)) {
        await serveFile(req, res, target, { cacheSeconds: 0 });
        return;
      }
    }

    // Everything else falls through to the web directory (pages, styles, icons).
    const webTarget = safeJoin(join(ROOT, 'web'), pathname);
    if (webTarget && existsSync(webTarget)) {
      await serveFile(req, res, webTarget, { cacheSeconds: 0 });
      return;
    }

    sendText(res, 404, `Not found: ${pathname}`);
  });

  server.on('error', (error) => {
    if (/** @type {any} */ (error).code === 'EADDRINUSE') {
      console.error(`\nPort ${port} is already in use. Start Motion Lab on another port, for example:\n  node server/index.js --port ${port + 1}\n`);
      process.exit(1);
    }
    throw error;
  });

  server.listen(port, host, async () => {
    const shown = host === '0.0.0.0'
      ? `http://127.0.0.1:${port}`
      : `http://${host}:${port}`;
    console.log('');
    console.log('  \u25a0 Motion Lab');
    console.log(`    Editor       ${shown}`);
    console.log(`    Workspace    ${workspace.root}`);
    console.log(`    Projects     ${workspace.projects}`);
    console.log(`    Media        ${workspace.media}`);
    console.log('');
    console.log(`    ffmpeg       ${tools.ffmpeg ? `yes -- ${tools.version ?? 'version unknown'}` : 'not found (no video encode, no audio decode)'}`);
    console.log(`    ffprobe      ${tools.ffprobe ? 'yes' : 'not found (limited media inspection)'}`);
    console.log(`    Render browser ${browser ?? 'not found -- video export unavailable'}`);
    const available = exportFormats(tools).filter((format) => format.available).map((format) => format.id);
    console.log(`    Export formats ${available.join(', ') || 'none'}`);
    if (host === '0.0.0.0') {
      const addresses = Object.values(networkInterfaces())
        .flat()
        .filter((entry) => Boolean(entry) && entry?.family === 'IPv4' && !entry?.internal);
      for (const address of addresses) if (address) console.log(`    On your network http://${address.address}:${port}`);
    }
    console.log('');
    console.log('    Press Ctrl+C to stop.');
    console.log('');

    if (shouldOpen) openInBrowser(shown);
  });

  // Notify connected editors when web/ or core/ changes.
  watchSources([join(ROOT, 'web'), join(ROOT, 'core')]);

  process.on('SIGINT', () => {
    console.log('\n  Motion Lab stopped.\n');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800);
  });
}

/** @type {Set<import('node:http').ServerResponse>} */
const reloadClients = new Set();

/**
 * @param {string[]} directories
 */
function watchSources(directories) {
  /** @type {NodeJS.Timeout|null} */
  let timer = null;
  for (const directory of directories) {
    try {
      fs.watch(directory, { recursive: true }, schedule);
    } catch {
      // Recursive watching is not available on every platform; fall back to a
      // flat watch of the directory itself, and never let this be fatal.
      try {
        fs.watch(directory, schedule);
      } catch {
        /* watching is a convenience only */
      }
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      for (const client of reloadClients) {
        try {
          client.write('event: reload\ndata: {}\n\n');
        } catch {
          reloadClients.delete(client);
        }
      }
    }, 180);
  }
}

/**
 * @param {string} url
 */
function openInBrowser(url) {
  const platform = process.platform;
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const commandArgs = platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  import('node:child_process').then(({ spawn }) => {
    try {
      spawn(command, commandArgs, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch {
      /* ignore */
    }
  });
}

main().catch(async (error) => {
  console.error('Motion Lab failed to start:', error);
  try {
    const workspace = await openWorkspace(workspaceRoot);
    await appendLog(workspace.logFile, `startup failure: ${error?.stack ?? error}`);
  } catch {
    /* nothing more we can do */
  }
  process.exit(1);
});
