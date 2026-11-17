/**
 * Quick report on the generated look folder: sizes, smallest and largest
 * outputs, and the mean brightness of each frame.
 *
 * Mean brightness is the useful number here: an output that rendered almost
 * black, or almost white, is a bug rather than a style, and this catches it
 * without opening fifty images by hand.
 *
 * Usage: node scripts/report-looks.mjs [--dir <look set folder>]
 * (default: Pictures\Motion Lab\look-set in your user folder)
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserPage, findBrowser, findFreePort } from '../server/cdp.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const index = process.argv.indexOf('--dir');
const DIR = index >= 0 ? resolve(process.argv[index + 1]) : join(homedir(), 'Pictures', 'Motion Lab', 'look-set');

const names = (await fs.readdir(DIR)).filter((name) => /^[0-9]{2}-.+\.png$/.test(name)).sort();
if (names.length === 0) {
  console.error(`No numbered outputs in ${DIR}`);
  process.exit(1);
}

/** @type {Array<{name:string, bytes:number}>} */
const sizes = [];
for (const name of names) sizes.push({ name, bytes: (await fs.stat(join(DIR, name))).size });

const bySize = [...sizes].sort((a, b) => a.bytes - b.bytes);
console.log(`${names.length} outputs in ${DIR}`);
console.log(`  total ${(sizes.reduce((n, s) => n + s.bytes, 0) / 1024 / 1024).toFixed(1)} MB`);
console.log('\nsmallest 6');
for (const entry of bySize.slice(0, 6)) console.log(`  ${String(Math.round(entry.bytes / 1024)).padStart(6)} KB  ${entry.name}`);
console.log('largest 4');
for (const entry of bySize.slice(-4)) console.log(`  ${String(Math.round(entry.bytes / 1024)).padStart(6)} KB  ${entry.name}`);

/* Mean brightness, measured in the browser so no image library is needed.
 * Images are sent a few at a time: fifty base64 PNGs in one evaluate call is a
 * ~110 MB expression, which is enough to kill the browser connection. */
const browser = findBrowser();
const page = new BrowserPage({ profileDir: join(ROOT, 'workspace', 'report-chrome'), width: 900, height: 700 });
await page.launch(browser, await findFreePort(9980));
await page.navigate('about:blank', 30000);

/** @type {Array<{name:string, mean:number, min:number, max:number, saturation:number}>} */
const stats = [];
const BATCH = 4;
for (let start = 0; start < names.length; start += BATCH) {
  const batch = [];
  for (const name of names.slice(start, start + BATCH)) {
    const buffer = await fs.readFile(join(DIR, name));
    batch.push({ name, base64: buffer.toString('base64') });
  }
  const result = await page.evaluate(`(async () => {
    const items = ${JSON.stringify(batch)};
    const out = [];
    for (const item of items) {
      const response = await fetch('data:image/png;base64,' + item.base64);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let sum = 0, n = 0, min = 255, max = 0, colourful = 0;
      for (let i = 0; i < data.length; i += 16) {
        const l = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722);
        sum += l; n += 1;
        if (l < min) min = l;
        if (l > max) max = l;
        const mx = Math.max(data[i], data[i + 1], data[i + 2]);
        const mn = Math.min(data[i], data[i + 1], data[i + 2]);
        if (mx - mn > 24) colourful += 1;
      }
      out.push({ name: item.name, mean: sum / n, min, max, saturation: colourful / n });
    }
    return out;
  })()`, { awaitPromise: true, timeoutMs: 300000 });
  stats.push(...result);
  if ((start + BATCH) % 20 === 0) process.stdout.write(`  measured ${Math.min(start + BATCH, names.length)}/${names.length}\r`);
}
console.log('');

await page.close();

const flat = stats.filter((s) => s.mean < 8 || s.mean > 246);
const grey = stats.filter((s) => s.saturation < 0.02);
console.log('\nbrightness');
console.log(`  mean range   ${Math.min(...stats.map((s) => s.mean)).toFixed(1)} .. ${Math.max(...stats.map((s) => s.mean)).toFixed(1)} (of 255)`);
console.log(`  tonal range  ${Math.min(...stats.map((s) => s.min)).toFixed(0)} .. ${Math.max(...stats.map((s) => s.max)).toFixed(0)}`);
if (flat.length) {
  console.log('\n  frames that are nearly flat (a bug rather than a style):');
  for (const entry of flat) console.log(`    ${entry.mean.toFixed(1)}  ${entry.name}`);
} else {
  console.log('  no frame is nearly black or nearly white');
}
// Monochrome is a legitimate choice for several of these looks, so it is
// reported rather than failed -- but the list should read as intentional.
console.log(`\n  effectively monochrome: ${grey.length ? grey.map((s) => s.name.replace(/^\d\d-|\.png$/g, '')).join(', ') : 'none'}`);

const dim = [...stats].sort((a, b) => a.mean - b.mean);
console.log('\ndarkest 3');
for (const entry of dim.slice(0, 3)) console.log(`  ${entry.mean.toFixed(1).padStart(6)}  ${entry.name}`);
console.log('brightest 3');
for (const entry of dim.slice(-3)) console.log(`  ${entry.mean.toFixed(1).padStart(6)}  ${entry.name}`);

process.exit(flat.length === 0 ? 0 : 1);
