/**
 * Report what the generated look set actually covers.
 *
 * Reads the recipe table in `generate-looks.mjs`, the effect registry and the
 * finished folder, and prints an honest summary: how many outputs exist, which
 * effects appear, which masks and procedural layers were used, and whether any
 * output is a duplicate of another.
 *
 * Usage: node scripts/verify-looks.mjs [--dir <look set folder>]
 * (default: Pictures\Motion Lab\look-set in your user folder)
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EFFECT_REGISTRY, EFFECT_CATEGORIES } from '../core/effectRegistry.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dirIndex = process.argv.indexOf('--dir');
const DIR = dirIndex >= 0 ? resolve(process.argv[dirIndex + 1]) : join(homedir(), 'Pictures', 'Motion Lab', 'look-set');

let passed = 0;
let failed = 0;
const failures = [];

/**
 * @param {string} label
 * @param {boolean} condition
 * @param {string} [detail]
 */
function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${label}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  \u2717 ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('Generated look set');
  console.log('==================');
  console.log(`folder  ${DIR}\n`);

  const source = await fs.readFile(join(ROOT, 'scripts', 'generate-looks.mjs'), 'utf8');
  const entries = await fs.readdir(DIR);
  const metaDir = join(DIR, '_meta');
  const metaEntries = await fs.readdir(metaDir).catch(() => []);
  // Two-digit prefix exactly, so nothing else can be mistaken for an output.
  const looks = entries.filter((name) => /^[0-9]{2}-.+\.png$/.test(name)).sort();

  check('50 numbered look outputs are present', looks.length === 50, `${looks.length} files`);
  check('a contact sheet was written', metaEntries.includes('contact-sheet.png'));
  check('an index was written', metaEntries.includes('README.md') && metaEntries.includes('index.csv'));
  check('an index also sits at the top level', entries.includes('README.md') && entries.includes('index.csv'));
  const comparisons = await fs.readdir(join(metaDir, 'comparison')).catch(() => []);
  const sources = await fs.readdir(join(metaDir, 'sources')).catch(() => []);
  check('every output has a before/after pair', comparisons.length === 50, `${comparisons.length} pairs`);
  check('every pair has its untreated source', sources.length === 50, `${sources.length} sources`);
  check('a comparison sheet was written', metaEntries.includes('comparison-sheet.png'));

  /* ---- dimensions and uniqueness ---- */
  const hashes = new Map();
  let duplicates = 0;
  /** @type {Map<string, {width:number, height:number, bytes:number}>} */
  const sizes = new Map();
  let total = 0;
  for (const name of looks) {
    const buffer = await fs.readFile(join(DIR, name));
    total += buffer.length;
    const hash = createHash('sha256').update(buffer).digest('hex');
    if (hashes.has(hash)) duplicates += 1;
    hashes.set(hash, name);
    sizes.set(name, {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
      bytes: buffer.length,
    });
  }
  const dimensions = [...sizes.values()];
  check('every output is unique', duplicates === 0, `${hashes.size} distinct hashes`);
  check('every output is 1080x1350', dimensions.every((size) => size.width === 1080 && size.height === 1350), `${dimensions[0]?.width}x${dimensions[0]?.height}`);
  // Deliberately generous: a pixel mosaic of a flat sky is a legitimate 12 KB
  // PNG at this size, so byte count alone cannot distinguish "fine" from
  // "broken". `scripts/report-looks.mjs` measures the actual pixels.
  check('no output is suspiciously empty', dimensions.every((size) => size.bytes > 8_000), `smallest ${(Math.min(...dimensions.map((s) => s.bytes)) / 1024).toFixed(0)} KB`);
  console.log(`  total ${(total / 1024 / 1024).toFixed(1)} MB, average ${(total / looks.length / 1024).toFixed(0)} KB per output`);

  /* ---- effect coverage ---- */
  const used = new Set();
  for (const match of source.matchAll(/type: '([a-zA-Z]+)'/g)) used.add(match[1]);
  const rendererLevel = ['trails', 'frameStep', 'strobe'];
  const registry = Object.keys(EFFECT_REGISTRY);
  const missing = registry.filter((type) => !used.has(type));
  const byCategory = new Map(EFFECT_CATEGORIES.map((category) => [category, []]));
  for (const type of registry) {
    const definition = EFFECT_REGISTRY[type];
    if (used.has(type)) byCategory.get(definition.category)?.push(definition.label);
  }
  console.log('\nEffect coverage');
  for (const [category, labels] of byCategory) {
    console.log(`  ${category.padEnd(12)} ${labels.length ? labels.join(', ') : '\u2014 none \u2014'}`);
  }
  check('every effect in the registry is used', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${registry.length} effects`);
  check('the renderer-level effects are covered', rendererLevel.every((type) => used.has(type)), rendererLevel.join(', '));

  /* ---- procedural layers, masks and type ---- */
  const graphicKinds = [...source.matchAll(/kind: '([a-z]+)', options:/g)].map((match) => match[1]);
  const maskKinds = [...source.matchAll(/mask: '([a-zA-Z]+)'/g)].map((match) => match[1]);
  const textLayers = [...source.matchAll(/text: '([^']+)'/g)].map((match) => match[1]);
  console.log(`\n  procedural layers  ${[...new Set(graphicKinds)].sort().join(', ')}`);
  console.log(`  mask shapes        ${[...new Set(maskKinds)].sort().join(', ')}`);
  console.log(`  text layers        ${textLayers.length}`);
  check('procedural layers are used', new Set(graphicKinds).size >= 7, `${new Set(graphicKinds).size} kinds`);
  check('mask shapes are used', new Set(maskKinds).size >= 4, `${new Set(maskKinds).size} shapes`);
  check('text layers are used', textLayers.length >= 2, `${textLayers.length}`);

  /* ---- grouping ---- */
  const groups = [...source.matchAll(/group: '([^']+)'/g)].map((match) => match[1]);
  const counts = new Map();
  for (const group of groups) counts.set(group, (counts.get(group) ?? 0) + 1);
  console.log('\nGroups');
  for (const [group, count] of counts) console.log(`  ${group.padEnd(12)} ${count}`);
  check('the set spans several creative groups', counts.size >= 6, `${counts.size} groups`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) for (const failure of failures) console.log(`  \u2022 ${failure}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Look verification crashed:', error);
  process.exit(1);
});
