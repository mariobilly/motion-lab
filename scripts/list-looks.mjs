/**
 * Sizes and dimensions of a generated look set, straight from the PNG headers.
 * Usage: node scripts/list-looks.mjs [--dir <look set folder>]
 * (default: Pictures\Motion Lab\look-set in your user folder)
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const index = process.argv.indexOf('--dir');
const DIR = index >= 0 ? resolve(process.argv[index + 1]) : join(homedir(), 'Pictures', 'Motion Lab', 'look-set');

const pattern = /^[0-9][0-9]-[^\0]+[.]png$/;
const names = (await fs.readdir(DIR)).filter((name) => pattern.test(name)).sort();
/** @type {Array<{name:string, kb:number, width:number, height:number}>} */
const rows = [];
for (const name of names) {
  const buffer = await fs.readFile(join(DIR, name));
  rows.push({ name, kb: Math.round(buffer.length / 1024), width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) });
}

console.log(`${rows.length} outputs in ${DIR}`);
const total = rows.reduce((sum, row) => sum + row.kb, 0);
console.log(`total ${(total / 1024).toFixed(1)} MB, average ${Math.round(total / rows.length)} KB\n`);

const bySize = [...rows].sort((a, b) => a.kb - b.kb);
console.log('smallest 5');
for (const row of bySize.slice(0, 5)) console.log(`  ${String(row.kb).padStart(5)} KB  ${row.width}x${row.height}  ${row.name}`);
console.log('largest 5');
for (const row of bySize.slice(-5)) console.log(`  ${String(row.kb).padStart(5)} KB  ${row.width}x${row.height}  ${row.name}`);

const wrongSize = rows.filter((row) => row.width !== rows[0].width || row.height !== rows[0].height);
console.log(`\nall ${rows[0].width}x${rows[0].height}: ${wrongSize.length === 0 ? 'yes' : `NO — ${wrongSize.map((r) => r.name).join(', ')}`}`);
console.log(`under 60 KB (suspect): ${bySize.filter((r) => r.kb < 60).map((r) => `${r.name} (${r.kb} KB)`).join(', ') || 'none'}`);

// `--chunks <file>` explains a suspicious file: PNG chunk layout and bit depth,
// which is what distinguishes "compressed because it is flat" from "truncated".
const chunkIndex = process.argv.indexOf('--chunks');
if (chunkIndex >= 0 && process.argv[chunkIndex + 1]) {
  const buffer = await fs.readFile(process.argv[chunkIndex + 1]);
  let offset = 8;
  const chunks = [];
  while (offset + 8 < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    chunks.push(`${type}(${length})`);
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  console.log(`\n${process.argv[chunkIndex + 1]}`);
  console.log(`  ${buffer.length} bytes, ${buffer.readUInt32BE(16)}x${buffer.readUInt32BE(20)}, bit depth ${buffer[24]}, colour type ${buffer[25]}`);
  console.log(`  chunks: ${chunks.join(' ')}`);
}
