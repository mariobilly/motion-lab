// Desktop launcher for Motion Lab (run hidden by launch.vbs).
// Starts the normal Motion Lab server (server/index.js) unless one is already running, opens the editor in
// its own Edge app window, and stops the server it started once that window is closed.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PORT = 5273;
const APP_URL = `http://127.0.0.1:${PORT}/`;
const APP_DIR = resolve(import.meta.dirname, '..');
const DATA_DIR = join(process.env.LOCALAPPDATA ?? APP_DIR, 'MotionLab');
const PROFILE_DIR = join(DATA_DIR, 'browser');
const LOG = join(DATA_DIR, 'launcher.log');

mkdirSync(DATA_DIR, { recursive: true });
const log = (msg) => appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);

async function isRunning() {
  try {
    const res = await fetch(APP_URL, { signal: AbortSignal.timeout(1500) });
    return res.ok && (await res.text()).includes('Motion Lab');
  } catch {
    return false;
  }
}

function openWindow() {
  const edge = [
    join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].find((p) => existsSync(p));
  if (!edge) {
    log('Edge not found; opening default browser');
    return spawn('cmd', ['/c', 'start', '', APP_URL], { stdio: 'ignore', windowsHide: true });
  }
  // A dedicated profile makes this a separate Edge instance, so we can tell when its window closes.
  return spawn(edge, [
    `--app=${APP_URL}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--window-size=1600,1000',
    '--no-first-run',
    '--no-default-browser-check',
  ], { stdio: 'ignore' });
}

if (await isRunning()) {
  log('server already running; opening a window');
  openWindow().unref();
  process.exit(0);
}

const out = openSync(join(DATA_DIR, 'server.log'), 'a');
const server = spawn(process.execPath, [join(APP_DIR, 'server', 'index.js'), '--port', String(PORT)], {
  cwd: APP_DIR,
  stdio: ['ignore', out, out],
  windowsHide: true,
});
server.on('exit', (code) => log(`server exited (${code})`));

for (let i = 0; i < 40 && !(await isRunning()); i += 1) {
  if (server.exitCode !== null) {
    log('server failed to start; see server.log');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 250));
}
log(`server ready at ${APP_URL}`);

const win = openWindow();
win.on('exit', () => {
  log('window closed; stopping server');
  server.kill();
  setTimeout(() => process.exit(0), 500);
});
