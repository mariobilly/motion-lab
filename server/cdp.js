/**
 * A minimal Chrome DevTools Protocol client.
 *
 * Motion Lab's exporter renders every frame in a real browser, because that is
 * exactly the environment the editor previews in -- same canvas implementation,
 * same blend modes, same text rasteriser. A frame rendered here is the frame the
 * user already saw, not an approximation produced by a second renderer.
 *
 * Only the handful of domains the exporter needs are implemented: Target,
 * Page/Runtime for navigation and evaluation, and Page.captureScreenshot to
 * pull the composited canvas out.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** Candidate Chrome/Edge binaries, most preferred first. */
export function findBrowser() {
  const candidates = [
    process.env.MOTION_LAB_BROWSER,
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe` : null,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean);
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

/** @typedef {(method:string, params?:any, sessionId?:string) => Promise<any>} CdpSend */

export class CdpConnection {
  /**
   * @param {WebSocket} socket
   */
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    /** @type {Map<number, {resolve:(value:any)=>void, reject:(error:Error)=>void}>} */
    this.pending = new Map();
    /** @type {Map<string, Array<(params:any, sessionId?:string)=>void>>} */
    this.handlers = new Map();
    this.closed = false;

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (!entry) return;
        if (message.error) entry.reject(new Error(`${message.error.message ?? 'CDP error'} (${message.error.code ?? '?'})`));
        else entry.resolve(message.result);
        return;
      }
      if (message.method) {
        const listeners = this.handlers.get(message.method);
        if (listeners) for (const listener of listeners) listener(message.params, message.sessionId);
      }
    });
    socket.addEventListener('close', () => {
      this.closed = true;
      for (const [, entry] of this.pending) entry.reject(new Error('The browser connection closed unexpectedly.'));
      this.pending.clear();
    });
  }

  /**
   * @param {string} method
   * @param {(params:any, sessionId?:string)=>void} handler
   * @param {string} [sessionId]
   */
  on(method, handler, sessionId) {
    const key = sessionId ? `${sessionId}:${method}` : method;
    if (!this.handlers.has(key)) this.handlers.set(key, []);
    /** @type {Array<(params:any, sessionId?:string)=>void>} */ (this.handlers.get(key)).push(handler);
  }

  /**
   * @param {string} method
   * @param {any} [params]
   * @param {string} [sessionId]
   * @returns {Promise<any>}
   */
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * A launched browser plus one attached page.
 */
export class BrowserPage {
  /**
   * @param {object} options
   * @param {string} options.profileDir
   * @param {number} [options.width]
   * @param {number} [options.height]
   */
  constructor({ profileDir, width = 1280, height = 800 }) {
    this.profileDir = profileDir;
    this.width = width;
    this.height = height;
    this.port = 0;
    /** @type {import('node:child_process').ChildProcess|null} */
    this.process = null;
    /** @type {CdpConnection|null} */
    this.connection = null;
    /** @type {string|null} */
    this.sessionId = null;
    this.targetId = null;
    /** @type {string[]} */
    this.consoleErrors = [];
  }

  /**
   * @param {string} browserPath
   * @param {number} port
   */
  async launch(browserPath, port) {
    this.port = port;
    rmSync(this.profileDir, { recursive: true, force: true, maxRetries: 3 });
    mkdirSync(this.profileDir, { recursive: true });
    const args = [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${resolve(this.profileDir)}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-default-apps',
      '--metrics-recording-only',
      '--mute-audio',
      '--hide-scrollbars',
      '--disable-lcd-text',
      '--force-device-scale-factor=1',
      '--allow-file-access-from-files',
      '--autoplay-policy=no-user-gesture-required',
      `--window-size=${this.width},${this.height}`,
      'about:blank',
    ];
    this.process = spawn(browserPath, args, { stdio: 'ignore', windowsHide: true });

    const version = await this.waitForDevtools();
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolvePromise, rejectPromise) => {
      socket.addEventListener('open', () => resolvePromise(undefined));
      socket.addEventListener('error', () => rejectPromise(new Error('Could not open the browser debug socket.')));
    });
    this.connection = new CdpConnection(/** @type {any} */ (socket));

    const created = await this.connection.send('Target.createTarget', { url: 'about:blank' });
    this.targetId = created.targetId;
    const attached = await this.connection.send('Target.attachToTarget', { targetId: this.targetId, flatten: true });
    this.sessionId = attached.sessionId;

    // Keep the page's console visible to the exporter so a render-time error
    // shows up as a real error message rather than a blank frame.
    this.connection.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error' || params.type === 'warning') {
        const text = (params.args ?? [])
          .map((/** @type {any} */ arg) => arg.value ?? arg.description ?? '')
          .join(' ');
        this.consoleErrors.push(text);
        if (this.consoleErrors.length > 40) this.consoleErrors.shift();
      }
    }, this.sessionId || undefined);
    this.connection.on('Runtime.exceptionThrown', (params) => {
      const text = params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'Unknown page error';
      this.consoleErrors.push(String(text));
      if (this.consoleErrors.length > 40) this.consoleErrors.shift();
    }, this.sessionId || undefined);

    await this.connection.send('Page.enable', {}, this.sessionId || undefined);
    await this.connection.send('Runtime.enable', {}, this.sessionId || undefined);
    return this;
  }

  async waitForDevtools() {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (this.process && this.process.exitCode !== null) {
        throw new Error(`The browser exited immediately (code ${this.process.exitCode}).`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/json/version`);
        if (response.ok) return await response.json();
      } catch {
        /* not listening yet */
      }
      await sleep(100);
    }
    throw new Error('Timed out waiting for the browser to start.');
  }

  /**
   * Navigate and wait until the document has finished loading.
   *
   * Readiness is polled through `document.readyState` rather than relying on the
   * `Page.loadEventFired` event: polling cannot miss an event that fired before
   * the listener was attached, and it still resolves for pages that load too
   * fast (or never fire the event) without a spurious timeout.
   *
   * @param {string} url
   * @param {number} [timeoutMs]
   */
  async navigate(url, timeoutMs = 60000) {
    const connection = this.requireConnection();
    await connection.send('Page.navigate', { url }, this.sessionId || undefined);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const state = await this.evaluate('document.readyState', { timeoutMs: 5000 });
        if (state === 'complete' || state === 'interactive') return;
      } catch {
        /* the execution context is being replaced mid-navigation */
      }
      if (Date.now() > deadline) {
        throw new Error(`The page at ${url} did not finish loading within ${timeoutMs} ms.`);
      }
      await sleep(120);
    }
  }

  /**
   * @param {string} expression
   * @param {{awaitPromise?:boolean, timeoutMs?:number}} [options]
   * @returns {Promise<any>}
   */
  async evaluate(expression, options = {}) {
    const connection = this.requireConnection();
    const result = await connection.send('Runtime.evaluate', {
      expression,
      awaitPromise: options.awaitPromise ?? false,
      returnByValue: true,
      timeout: options.timeoutMs,
    }, this.sessionId || undefined);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Evaluation failed';
      throw new Error(String(detail));
    }
    return result.result?.value;
  }

  /**
   * Capture a rectangle of the page as a PNG buffer.
   * @param {{x:number,y:number,width:number,height:number,scale?:number}} clip
   * @returns {Promise<Buffer>}
   */
  async captureClip(clip) {
    const connection = this.requireConnection();
    const result = await connection.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      fromSurface: true,
      clip: {
        x: clip.x,
        y: clip.y,
        width: clip.width,
        height: clip.height,
        scale: clip.scale ?? 1,
      },
    }, this.sessionId || undefined);
    return Buffer.from(result.data, 'base64');
  }

  requireConnection() {
    if (!this.connection) throw new Error('The browser is not connected.');
    return this.connection;
  }

  async close() {
    try {
      if (this.connection && this.targetId) {
        await this.connection.send('Target.closeTarget', { targetId: this.targetId });
      }
    } catch {
      /* the browser may already be gone */
    }
    this.connection?.close();
    if (this.process && this.process.exitCode === null) {
      this.process.kill();
      // Give it a moment to release the profile directory on Windows.
      await sleep(300);
      if (this.process.exitCode === null) {
        try {
          this.process.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/**
 * Find a free TCP port, starting from `preferred`.
 * @param {number} preferred
 * @returns {Promise<number>}
 */
export async function findFreePort(preferred) {
  const net = await import('node:net');
  for (let port = preferred; port < preferred + 200; port += 1) {
    const free = await new Promise((resolvePromise) => {
      const server = net.createServer();
      server.once('error', () => resolvePromise(false));
      server.once('listening', () => {
        server.close(() => resolvePromise(true));
      });
      server.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error(`No free port found near ${preferred}.`);
}
