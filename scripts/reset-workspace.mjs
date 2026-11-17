/**
 * Rebuild the sample media and the starter projects from scratch.
 *
 * This is the reset button for a workshop that has accumulated test projects and
 * duplicate imports: it clears the media library, re-imports the generated
 * sample files, re-analyses the music, and re-creates the three starter
 * projects. It is deliberately destructive — your own imported media goes too —
 * so pass `--keep-media` to rebuild only the starter projects.
 *
 * Usage: node scripts/reset-workspace.mjs [--keep-media]
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openWorkspace } from '../server/workspace.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = join(ROOT, 'workspace');
const keepMedia = process.argv.includes('--keep-media');

/**
 * Run one of the other build scripts in this directory and wait for it.
 * @param {string} script
 * @param {string[]} args
 * @returns {Promise<void>}
 */
function runScript(script, args = []) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join('scripts', script), ...args], {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolvePromise(undefined) : reject(new Error(`${script} exited with ${code}`))));
  });
}

async function main() {
  const workspace = await openWorkspace(WORKSPACE);

  if (!keepMedia) {
    let removed = 0;
    for (const name of await fs.readdir(workspace.media)) {
      await fs.rm(join(workspace.media, name), { recursive: true, force: true, maxRetries: 3 });
      removed += 1;
    }
    console.log(`Cleared ${removed} media folder(s).`);
  } else {
    console.log('Keeping the existing media library.');
  }

  let cleared = 0;
  for (const name of await fs.readdir(workspace.projects)) {
    if (name.endsWith('.json')) {
      await fs.rm(join(workspace.projects, name), { force: true });
      cleared += 1;
    }
  }
  console.log(`Cleared ${cleared} project file(s).`);

  // Render scratch space belongs to jobs that no longer exist.
  await fs.rm(workspace.exports, { recursive: true, force: true, maxRetries: 3 });
  await fs.mkdir(workspace.exports, { recursive: true });

  if (!keepMedia) {
    console.log('\nRebuilding the sample media…');
    await runScript('make-sample-media.mjs', ['--force']);
  }

  console.log('\nRebuilding the starter projects…');
  await runScript('make-starters.mjs');

  const media = (await fs.readdir(workspace.media)).length;
  const projects = (await fs.readdir(workspace.projects)).filter((name) => name.endsWith('.json')).length;
  console.log(`\nWorkspace ready: ${media} media folder(s), ${projects} project(s).`);
}

main().catch((error) => {
  console.error('\nReset failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
