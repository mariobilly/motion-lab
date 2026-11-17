/**
 * Motion Lab — batch look generator.
 *
 * Turns a folder of source photographs into a set of finished stills by driving
 * the *app's own* engine and export pipeline. Nothing here re-implements
 * rendering: it builds one composition that holds every look in its own time
 * slot, posts it to `/api/exports`, and lets the same headless-Chrome harness
 * that powers a normal export render each frame.
 *
 * One composition rather than fifty exports is deliberate. The export browser
 * and the prepared asset set are the expensive parts, so putting all fifty looks
 * on one timeline means fifty stills cost one launch, and every look is
 * guaranteed to have been rendered at the export resolution through the same
 * code path the editor previews with.
 *
 * Usage:
 *   node scripts/generate-looks.mjs --source <folder of photos> [--out <folder>]
 *
 * Options:
 *   --source <dir>     Folder of source images (required).
 *   --out <dir>        Output folder (default: Pictures\Motion Lab\look-set in
 *                      your user folder).
 *   --count <n>        How many looks to render (default 50).
 *   --width/--height   Output size (default 1080x1350).
 *   --slot <seconds>   Seconds of timeline per look (default 2).
 *   --port <n>         Port the studio is already running on (default 5470).
 *   --keep-projects    Leave the generated project in the workspace.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserPage, findBrowser, findFreePort, sleep } from '../server/cdp.js';
import { probeTools, run } from '../server/media.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

/**
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const SOURCE_DIR = arg('source');
if (!SOURCE_DIR) {
  console.error('Usage: node scripts/generate-looks.mjs --source <folder of photos> [--out <folder>] [--count 50]');
  process.exit(2);
}
const OUT_DIR = resolve(arg('out', join(homedir(), 'Pictures', 'Motion Lab', 'look-set')));
const COUNT = Number(arg('count', '50'));
const WIDTH = Number(arg('width', '1080'));
const HEIGHT = Number(arg('height', '1350'));
const SLOT = Number(arg('slot', '2'));
const PORT = Number(arg('port', '5470'));
const BASE = `http://127.0.0.1:${PORT}`;
const KEEP_PROJECTS = process.argv.includes('--keep-projects');

/* ------------------------------------------------------------------ *
 * The look table
 *
 * Each entry is one finished treatment. They are grouped so the set reads as a
 * survey of what the effect engine can do: film emulation, print and graphic
 * processes, digital distortion, texture, light, particles and compositing.
 *
 * `base` is an index into the source list, which lets a treatment be paired with
 * a photograph whose content suits it (a neon night shot for the glitch looks,
 * a harbour for the cool grades) rather than at random.
 * ------------------------------------------------------------------ */

/** @typedef {{type:string, params:Record<string, any>, enabled?:boolean}} Look */

/**
 * @typedef {object} LookSpec
 * @property {string} name
 * @property {string} group
 * @property {string} note
 * @property {number} base
 * @property {Look[]} stack
 * @property {any} [graphic]   An extra procedural layer, composited over the photo.
 * @property {number} [zoom]   How much the still drifts over its slot, in scale.
 * @property {number} [exposure] Exposure applied to the photo layer itself.
 */

/** @type {LookSpec[]} */
const LOOKS = [
  /* ---- colour and film emulation -------------------------------- */
  { name: 'Kodachrome Warm', group: 'Colour', base: 0, note: 'Warm reversal film: strong reds, clean whites, gentle contrast.',
    stack: [{ type: 'temperature', params: { amount: 28 } }, { type: 'contrast', params: { amount: 22 } }, { type: 'saturation', params: { amount: 26 } }, { type: 'vibrance', params: { amount: 12 } }] },
  { name: 'Noir Duotone', group: 'Colour', base: 1, note: 'Deep blue shadows against warm highlights, with a heavy vignette.',
    stack: [{ type: 'duotone', params: { shadowColor: '#050a1e', highlightColor: '#ffd9a8', strength: 100, midpoint: 48 } }, { type: 'contrast', params: { amount: 34 } }, { type: 'vignette', params: { amount: 58, softness: 46 } }] },
  { name: 'Faded Polaroid', group: 'Colour', base: 2, note: 'Lifted blacks, milky highlights and a green-cyan drift.',
    stack: [{ type: 'fade', params: { amount: 46 } }, { type: 'temperature', params: { amount: -16 } }, { type: 'tint', params: { amount: -22 } }, { type: 'vibrance', params: { amount: 22 } }, { type: 'vignette', params: { amount: 26, softness: 72 } }] },
  { name: 'Cyanotype', group: 'Colour', base: 3, note: 'Prussian blue print with compressed highlights.',
    stack: [{ type: 'duotone', params: { shadowColor: '#03203f', highlightColor: '#cfeaff', strength: 100, midpoint: 55 } }, { type: 'levels', params: { black: 6, white: 92, gamma: 1.05, outBlack: 2, outWhite: 98 } }, { type: 'grain', params: { size: 1.5, amount: 16, colored: false, animate: 0 } }] },
  { name: 'Cross Process', group: 'Colour', base: 4, note: 'The classic C-41-in-E6 look: cyan shadows, yellow highlights.',
    stack: [{ type: 'curves', params: { rgb: [[0, 0.06], [0.25, 0.22], [0.5, 0.52], [0.75, 0.82], [1, 1]], red: [[0, 0], [0.25, 0.3], [0.5, 0.55], [0.75, 0.78], [1, 1]], green: [[0, 0], [0.25, 0.24], [0.5, 0.5], [0.75, 0.79], [1, 1]], blue: [[0, 0.12], [0.25, 0.2], [0.5, 0.45], [0.75, 0.72], [1, 0.96]], mix: 100 } }, { type: 'saturation', params: { amount: 22 } }, { type: 'contrast', params: { amount: 16 } }] },
  { name: 'Bleach Bypass', group: 'Colour', base: 5, note: 'Silver-retained look: desaturated, contrasty, metallic.',
    stack: [{ type: 'saturation', params: { amount: -58 } }, { type: 'contrast', params: { amount: 46 } }, { type: 'levels', params: { black: 4, white: 96, gamma: 0.92, outBlack: 0, outWhite: 100 } }, { type: 'grain', params: { size: 1.8, amount: 22, colored: false, animate: 0 } }] },
  { name: 'Teal & Orange', group: 'Colour', base: 6, note: 'The blockbuster grade: cool shadows, warm skin tones.',
    stack: [{ type: 'duotone', params: { shadowColor: '#0a2b33', highlightColor: '#ffb168', strength: 42, midpoint: 46 } }, { type: 'temperature', params: { amount: 18 } }, { type: 'saturation', params: { amount: 14 } }, { type: 'contrast', params: { amount: 24 } }] },
  { name: 'Silver Gelatin', group: 'Colour', base: 7, note: 'Neutral black and white with a long tonal scale.',
    stack: [{ type: 'saturation', params: { amount: -100 } }, { type: 'curves', params: { rgb: [[0, 0], [0.25, 0.2], [0.5, 0.5], [0.75, 0.8], [1, 1]], red: [[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]], green: [[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]], blue: [[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]], mix: 100 } }, { type: 'paper', params: { scale: 2.6, intensity: 22 } }] },
  { name: 'Infrared Garden', group: 'Colour', base: 8, note: 'False-colour infrared: foliage glows, skies go dark.',
    stack: [{ type: 'curves', params: { rgb: [[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]], red: [[0, 0.1], [0.25, 0.42], [0.5, 0.72], [0.75, 0.9], [1, 1]], green: [[0, 0.02], [0.25, 0.18], [0.5, 0.36], [0.75, 0.6], [1, 0.86]], blue: [[0, 0], [0.25, 0.08], [0.5, 0.2], [0.75, 0.42], [1, 0.7]], mix: 100 } }, { type: 'vibrance', params: { amount: 40 } }, { type: 'contrast', params: { amount: 20 } }] },
  { name: 'Muted Cinema', group: 'Colour', base: 9, note: 'Restrained palette and soft roll-off, the quiet drama grade.',
    stack: [{ type: 'saturation', params: { amount: -26 } }, { type: 'fade', params: { amount: 20 } }, { type: 'tint', params: { amount: 10 } }, { type: 'levels', params: { black: 2, white: 94, gamma: 1.08, outBlack: 4, outWhite: 98 } }, { type: 'vignette', params: { amount: 30, softness: 68 } }] },

  /* ---- print and graphic processes ------------------------------ */
  { name: 'Halftone Newsprint', group: 'Print', base: 10, note: 'Coarse rotated dot screen printed on cheap paper.',
    stack: [{ type: 'halftone', params: { spacing: 8, dotSize: 92, angle: 45, ink: '#14120f', paper: '#f2ead8' } }, { type: 'paper', params: { scale: 3, intensity: 30 } }, { type: 'contrast', params: { amount: 12 } }] },
  { name: 'Risograph Two Colour', group: 'Print', base: 11, note: 'Two-ink riso with deliberate misregistration.',
    stack: [{ type: 'posterize', params: { levels: 5, blend: 100 } }, { type: 'paletteMap', params: { palette: ['#f5f2e8', '#ff4d6d', '#2b4cff', '#1b1b2f'], strength: 100, dither: true, ditherAmount: 0.8 } }, { type: 'paper', params: { scale: 3.4, intensity: 26 } }] },
  { name: 'Comic Ink Outline', group: 'Print', base: 12, note: 'Bold contour ink over flat colour.',
    stack: [{ type: 'edges', params: { threshold: 0.16, thickness: 2, ink: '#0a0a12', baseFade: 70, colorEdges: false } }, { type: 'posterize', params: { levels: 6, blend: 100 } }, { type: 'saturation', params: { amount: 34 } }] },
  { name: 'Screen Print Flat', group: 'Print', base: 13, note: 'Four flat inks, no gradient anywhere.',
    stack: [{ type: 'paletteMap', params: { palette: ['#101820', '#f2aa4c', '#e4572e', '#f7f3e8'], strength: 100, dither: false, ditherAmount: 0 } }, { type: 'contrast', params: { amount: 30 } }, { type: 'edges', params: { threshold: 0.24, thickness: 1, ink: '#101820', baseFade: 0, colorEdges: true } }] },
  { name: 'Pixel Mosaic', group: 'Print', base: 14, note: 'Large blocks with the palette pulled down to eight tones.',
    stack: [{ type: 'pixelate', params: { blockSize: 26 } }, { type: 'posterize', params: { levels: 12, blend: 100 } }, { type: 'saturation', params: { amount: 22 } }] },
  { name: 'X-Ray Invert', group: 'Print', base: 15, note: 'Inverted luminance: a radiograph of the scene.',
    stack: [{ type: 'curves', params: { rgb: [[0, 1], [0.25, 0.72], [0.5, 0.5], [0.75, 0.28], [1, 0]], red: [[0, 1], [0.25, 0.75], [0.5, 0.5], [0.75, 0.25], [1, 0]], green: [[0, 1], [0.25, 0.78], [0.5, 0.52], [0.75, 0.26], [1, 0]], blue: [[0, 1], [0.25, 0.82], [0.5, 0.58], [0.75, 0.3], [1, 0.06]], mix: 100 } }, { type: 'bloom', params: { threshold: 42, radius: 26, amount: 0.9 } }, { type: 'contrast', params: { amount: 30 } }] },
  { name: 'Embossed Metal', group: 'Print', base: 16, note: 'Edge relief pressed into dark metal.',
    stack: [{ type: 'saturation', params: { amount: -78 } }, { type: 'contrast', params: { amount: 34 } }, { type: 'levels', params: { black: 6, white: 78, gamma: 0.86, outBlack: 0, outWhite: 100 } }, { type: 'edges', params: { threshold: 0.34, thickness: 1, ink: '#dfe7f0', baseFade: 8, colorEdges: false } }, { type: 'paper', params: { scale: 1.6, intensity: 16 } }] },
  { name: 'Blueprint', group: 'Print', base: 17, note: 'White line work on engineering blue.',
    stack: [{ type: 'edges', params: { threshold: 0.13, thickness: 2, ink: '#eaf4ff', baseFade: 0, colorEdges: true } }, { type: 'duotone', params: { shadowColor: '#061a3a', highlightColor: '#123f77', strength: 100, midpoint: 50 } }, { type: 'paletteMap', params: { palette: ['#061a3a', '#0d2f5c', '#eaf4ff'], strength: 88, dither: false, ditherAmount: 0 } }] },
  { name: 'Neon Posterize', group: 'Print', base: 18, note: 'Hard posterised bands in acid colour.',
    stack: [{ type: 'posterize', params: { levels: 4, blend: 100 } }, { type: 'paletteMap', params: { palette: ['#0b032d', '#843b62', '#fbb040', '#00e5ff'], strength: 92, dither: true, ditherAmount: 0.6 } }, { type: 'bloom', params: { threshold: 60, radius: 20, amount: 0.6 } }] },
  { name: 'Duotone Offset', group: 'Print', base: 19, note: 'A single misregistered colour plate.',
    stack: [{ type: 'posterize', params: { levels: 7, blend: 100 } }, { type: 'rgbOffset', params: { distance: 5, angle: 18, animate: 0 } }, { type: 'paletteMap', params: { palette: ['#f7f2e7', '#1b2a4a', '#e05a47'], strength: 82, dither: false, ditherAmount: 0 } }] },

  /* ---- digital and distortion ---------------------------------- */
  { name: 'Kaleidoscope Bloom', group: 'Distortion', base: 20, note: 'Eight-fold mirror symmetry with a soft glow.',
    stack: [{ type: 'kaleidoscope', params: { segments: 8, rotation: 12, zoom: 1.1, spin: 0 } }, { type: 'bloom', params: { threshold: 58, radius: 22, amount: 0.7 } }, { type: 'vibrance', params: { amount: 30 } }] },
  { name: 'Mirror Tunnel', group: 'Distortion', base: 21, note: 'Six-fold symmetry pushed in tight.',
    stack: [{ type: 'kaleidoscope', params: { segments: 6, rotation: -24, zoom: 1.5, spin: 0 } }, { type: 'contrast', params: { amount: 26 } }, { type: 'duotone', params: { shadowColor: '#12002e', highlightColor: '#4de1ff', strength: 40, midpoint: 50 } }] },
  { name: 'Wave Distortion', group: 'Distortion', base: 22, note: 'A slow horizontal ripple, as if seen through water.',
    stack: [{ type: 'wave', params: { amplitude: 22, wavelength: 150, phase: 0, animate: 0, waveKind: 'sine' } }, { type: 'saturation', params: { amount: 16 } }, { type: 'vignette', params: { amount: 26, softness: 70 } }] },
  { name: 'Chromatic Aberration', group: 'Distortion', base: 23, note: 'Channels pulled apart, the cheap-lens look.',
    stack: [{ type: 'rgbOffset', params: { distance: 9, angle: 0, animate: 0 } }, { type: 'contrast', params: { amount: 20 } }, { type: 'bloom', params: { threshold: 66, radius: 14, amount: 0.4 } }] },
  { name: 'Digital Glitch', group: 'Distortion', base: 24, note: 'Slice displacement and block corruption.',
    stack: [{ type: 'glitch', params: { amount: 55, slices: 22, blockSize: 34, rate: 6, colorTear: true } }, { type: 'contrast', params: { amount: 28 } }, { type: 'saturation', params: { amount: 30 } }] },
  { name: 'Datamosh', group: 'Distortion', base: 25, note: 'Heavier glitch with a neon palette pull.',
    stack: [{ type: 'glitch', params: { amount: 78, slices: 40, blockSize: 82, rate: 4, colorTear: true } }, { type: 'paletteMap', params: { palette: ['#05010f', '#ff2d78', '#12d6ff', '#f8f8ff'], strength: 58, dither: true, ditherAmount: 0.4 } }, { type: 'bloom', params: { threshold: 52, radius: 24, amount: 0.85 } }] },
  { name: 'VHS Tape', group: 'Distortion', base: 26, note: 'Tape wobble, colour bleed and scanline grain.',
    stack: [{ type: 'rgbOffset', params: { distance: 4, angle: 90, animate: 0 } }, { type: 'wave', params: { amplitude: 6, wavelength: 220, phase: 0, animate: 0, waveKind: 'triangle' } }, { type: 'grain', params: { size: 1.2, amount: 30, colored: true, animate: 0 } }, { type: 'saturation', params: { amount: -18 } }, { type: 'vignette', params: { amount: 34, softness: 60 } }] },
  { name: 'CRT Scanlines', group: 'Distortion', base: 27, note: 'Shadow-mask grid over a glowing tube.',
    graphic: { kind: 'grid', options: { count: 84, size: 0.14, speed: 0.05, amount: 0.32, colorA: '#7ef9ff', colorB: '#7ef9ff', colorC: '#ffffff' }, blend: 'overlay', opacity: 0.5 },
    stack: [{ type: 'bloom', params: { threshold: 50, radius: 20, amount: 0.75 } }, { type: 'vibrance', params: { amount: 34 } }, { type: 'contrast', params: { amount: 18 } }] },
  { name: 'Data Corrupt', group: 'Distortion', base: 28, note: 'Everything wrong at once, on purpose.',
    stack: [{ type: 'glitch', params: { amount: 92, slices: 60, blockSize: 46, rate: 9, colorTear: true } }, { type: 'kaleidoscope', params: { segments: 4, rotation: 45, zoom: 1.25, spin: 0 } }, { type: 'posterize', params: { levels: 5, blend: 100 } }, { type: 'contrast', params: { amount: 34 } }] },
  { name: 'Liquid Mirror', group: 'Distortion', base: 29, note: 'Radial ripple with the highlights blooming through.',
    stack: [{ type: 'wave', params: { amplitude: 34, wavelength: 90, phase: 40, animate: 0, waveKind: 'noise' } }, { type: 'bloom', params: { threshold: 44, radius: 30, amount: 1 } }, { type: 'levels', params: { black: 3, white: 92, gamma: 1.1, outBlack: 0, outWhite: 100 } }] },

  /* ---- texture and analogue ------------------------------------- */
  { name: 'Light Leak', group: 'Texture', base: 30, note: 'A warm flare bleeding in from the corner.',
    graphic: { kind: 'gradient', options: { gradientKind: 'radial', colorA: '#ff8a3d', colorB: '#00000000', colorC: '#ffd166', amount: 0.8, speed: 0.1, rotation: 0, width: 1, height: 1 }, blend: 'screen', opacity: 0.55, transform: { x: 380, y: -420, scaleX: 1.1, scaleY: 1.1 } },
    stack: [{ type: 'fade', params: { amount: 18 } }, { type: 'temperature', params: { amount: 22 } }, { type: 'vibrance', params: { amount: 24 } }] },
  { name: 'Halftone Paper', group: 'Texture', base: 31, note: 'Fine dot screen on a fibrous stock.',
    stack: [{ type: 'halftone', params: { spacing: 5, dotSize: 100, angle: 30, ink: '#2a2118', paper: '#efe3cc' } }, { type: 'paper', params: { scale: 2.2, intensity: 44 } }, { type: 'levels', params: { black: 4, white: 97, gamma: 1, outBlack: 0, outWhite: 100 } }] },
  { name: 'Old Film Reel', group: 'Texture', base: 32, note: 'Scratches, dust, grain and a soft gate vignette.',
    stack: [{ type: 'scratches', params: { count: 14, length: 92, width: 1.4, opacity: 42, bright: true, jitter: 0.5 } }, { type: 'grain', params: { size: 2.2, amount: 34, colored: false, animate: 0 } }, { type: 'saturation', params: { amount: -30 } }, { type: 'vignette', params: { amount: 48, softness: 52 } }, { type: 'paper', params: { scale: 3.6, intensity: 16 } }] },
  { name: 'Holographic Foil', group: 'Texture', base: 33, note: 'Iridescent sheen laid over the picture.',
    graphic: { kind: 'gradient', options: { gradientKind: 'mesh', colorA: '#7b2ff7', colorB: '#00e0ff', colorC: '#ff5fa2', count: 8, speed: 0.12, amount: 0.7 }, blend: 'overlay', opacity: 0.58 },
    stack: [{ type: 'vibrance', params: { amount: 40 } }, { type: 'contrast', params: { amount: 16 } }, { type: 'bloom', params: { threshold: 62, radius: 18, amount: 0.5 } }] },
  { name: 'Static Interference', group: 'Texture', base: 34, note: 'Television snow over a held image.',
    stack: [{ type: 'animatedNoise', params: { noiseKind: 'static', amount: 22, scale: 1.2, speed: 0, mono: true } }, { type: 'posterize', params: { levels: 10, blend: 100 } }, { type: 'contrast', params: { amount: 22 } }] },
  { name: 'Fog Over Water', group: 'Texture', base: 35, note: 'Drifting fog lifted through the midtones.',
    stack: [{ type: 'animatedNoise', params: { noiseKind: 'fog', amount: 34, scale: 4, speed: 0, mono: true } }, { type: 'fade', params: { amount: 26 } }, { type: 'levels', params: { black: 8, white: 88, gamma: 1.16, outBlack: 6, outWhite: 96 } }] },
  { name: 'Dust & Scratches', group: 'Texture', base: 36, note: 'Archive damage with the density of a print.',
    stack: [{ type: 'animatedNoise', params: { noiseKind: 'dust', amount: 44, scale: 1.2, speed: 0, mono: false } }, { type: 'scratches', params: { count: 22, length: 70, width: 1, opacity: 30, bright: false, jitter: 0.8 } }, { type: 'grain', params: { size: 1.6, amount: 18, colored: false, animate: 0 } }] },
  { name: 'Wet Plate', group: 'Texture', base: 37, note: 'Collodion unevenness around a soft centre.',
    stack: [{ type: 'paper', params: { scale: 5.5, intensity: 54 } }, { type: 'vignette', params: { amount: 62, softness: 34 } }, { type: 'saturation', params: { amount: -40 } }, { type: 'duotone', params: { shadowColor: '#241a10', highlightColor: '#e8d9b8', strength: 56, midpoint: 52 } }] },
  { name: 'Woven Canvas', group: 'Texture', base: 38, note: 'Coarse fabric weave pressed into the image.',
    stack: [{ type: 'paper', params: { scale: 6.5, intensity: 68 } }, { type: 'halftone', params: { spacing: 4, dotSize: 74, angle: 20, ink: '#3b3226', paper: '#e6dcc6' } }, { type: 'contrast', params: { amount: 14 } }] },
  { name: 'Watercolour Wash', group: 'Texture', base: 39, note: 'Soft pigment blooms with the line work removed.',
    stack: [{ type: 'bloom', params: { threshold: 34, radius: 44, amount: 1.2 } }, { type: 'posterize', params: { levels: 11, blend: 58 } }, { type: 'paper', params: { scale: 8, intensity: 40 } }, { type: 'saturation', params: { amount: 18 } }] },

  /* ---- light and exposure --------------------------------------- */
  { name: 'Dream Bloom', group: 'Light', base: 40, note: 'Everything bright bleeds into everything else.',
    stack: [{ type: 'bloom', params: { threshold: 40, radius: 48, amount: 1.4 } }, { type: 'exposure', params: { amount: 14 } }, { type: 'vibrance', params: { amount: 20 } }] },
  { name: 'Sun Bleached', group: 'Light', base: 41, note: 'Overexposed and desaturated by months of sunlight.',
    stack: [{ type: 'exposure', params: { amount: 34 } }, { type: 'saturation', params: { amount: -34 } }, { type: 'fade', params: { amount: 38 } }, { type: 'levels', params: { black: 14, white: 100, gamma: 0.94, outBlack: 10, outWhite: 100 } }] },
  { name: 'Golden Hour Haze', group: 'Light', base: 42, note: 'Low warm sun through airborne dust.',
    graphic: { kind: 'gradient', options: { gradientKind: 'linear', colorA: '#ffb347', colorB: '#ff5e3a', colorC: '#ffe1a8', amount: 0.6, rotation: 20, speed: 0.08 }, blend: 'screen', opacity: 0.34 },
    stack: [{ type: 'temperature', params: { amount: 30 } }, { type: 'bloom', params: { threshold: 50, radius: 34, amount: 0.8 } }, { type: 'fade', params: { amount: 16 } }, { type: 'vibrance', params: { amount: 18 } }] },
  { name: 'Neon Night Grade', group: 'Light', base: 43, note: 'Magenta and cyan pushed hard, blacks kept black.',
    stack: [{ type: 'duotone', params: { shadowColor: '#06021a', highlightColor: '#ff43c8', strength: 30, midpoint: 44 } }, { type: 'saturation', params: { amount: 46 } }, { type: 'bloom', params: { threshold: 56, radius: 22, amount: 0.9 } }, { type: 'levels', params: { black: 6, white: 98, gamma: 0.96, outBlack: 0, outWhite: 100 } }] },
  { name: 'High Key', group: 'Light', base: 44, note: 'Airy and bright, with the shadows opened right up.',
    stack: [{ type: 'exposure', params: { amount: 46 } }, { type: 'fade', params: { amount: 52 } }, { type: 'levels', params: { black: 0, white: 88, gamma: 1.24, outBlack: 22, outWhite: 100 } }, { type: 'vignette', params: { amount: 12, softness: 80 } }] },
  { name: 'Low Key Drama', group: 'Light', base: 45, note: 'Deep shadow with a single bright accent.',
    stack: [{ type: 'exposure', params: { amount: -26 } }, { type: 'contrast', params: { amount: 52 } }, { type: 'levels', params: { black: 8, white: 84, gamma: 1.14, outBlack: 0, outWhite: 96 } }, { type: 'vignette', params: { amount: 66, softness: 40 } }] },
  { name: 'Chiaroscuro', group: 'Light', base: 46, note: 'Strong single-source light, everything else falling away.',
    // Deliberately gentler than a literal chiaroscuro: this look has to survive
    // being pointed at a night photograph, where a hard contrast boost plus a
    // vignette would simply produce a black rectangle.
    stack: [{ type: 'exposure', params: { amount: 12 } }, { type: 'contrast', params: { amount: 18 } }, { type: 'levels', params: { black: 0, white: 96, gamma: 1.22, outBlack: 0, outWhite: 100 } }, { type: 'bloom', params: { threshold: 46, radius: 34, amount: 1.1 } }, { type: 'duotone', params: { shadowColor: '#0e0b08', highlightColor: '#f4e6c4', strength: 43, midpoint: 46 } }, { type: 'vignette', params: { amount: 34, softness: 60 } }] },

  /* ---- particles and procedural layers -------------------------- */
  { name: 'Fireflies', group: 'Particles', base: 47, note: 'Warm drifting sparks over a darkened frame.',
    graphic: { kind: 'particles', options: { count: 220, size: 0.42, speed: 0.5, spread: 0.85, complexity: 3, amount: 0.6, colorA: '#ffcf5c', colorB: '#ff7a18', colorC: '#fff3c4' }, blend: 'screen', opacity: 0.9 },
    stack: [{ type: 'exposure', params: { amount: -14 } }, { type: 'bloom', params: { threshold: 58, radius: 20, amount: 0.6 } }, { type: 'vignette', params: { amount: 36, softness: 62 } }] },
  { name: 'Ember Field', group: 'Particles', base: 48, note: 'Dense embers rising through smoke.',
    graphic: { kind: 'particles', options: { count: 460, size: 0.55, speed: 1.3, spread: 1, complexity: 5, amount: 0.9, colorA: '#ff4d1f', colorB: '#ffb703', colorC: '#fff1a8' }, blend: 'screen', opacity: 1 },
    stack: [{ type: 'temperature', params: { amount: 34 } }, { type: 'contrast', params: { amount: 26 } }, { type: 'bloom', params: { threshold: 48, radius: 26, amount: 1 } }, { type: 'vignette', params: { amount: 44, softness: 56 } }] },
  { name: 'Particle Halo', group: 'Particles', base: 49, note: 'Concentric sparks radiating from the centre.',
    graphic: { kind: 'particles', options: { count: 320, size: 0.38, speed: 0.8, spread: 0.2, complexity: 4, amount: 0.75, colorA: '#9be7ff', colorB: '#ffffff', colorC: '#6f8cff' }, blend: 'screen', opacity: 0.8 },
    stack: [{ type: 'bloom', params: { threshold: 52, radius: 34, amount: 0.9 } }, { type: 'duotone', params: { shadowColor: '#04061a', highlightColor: '#cfe4ff', strength: 34, midpoint: 50 } }, { type: 'vignette', params: { amount: 40, softness: 60 } }] },
  { name: 'Starfield', group: 'Particles', base: 0, note: 'Cold pinpoints over a night sky treatment.',
    graphic: { kind: 'particles', options: { count: 520, size: 0.2, speed: 0.25, spread: 1, complexity: 2, amount: 0.3, colorA: '#ffffff', colorB: '#bcd4ff', colorC: '#ffe9c4' }, blend: 'screen', opacity: 1 },
    stack: [{ type: 'exposure', params: { amount: -30 } }, { type: 'duotone', params: { shadowColor: '#01030f', highlightColor: '#8fb6ff', strength: 64, midpoint: 46 } }, { type: 'bloom', params: { threshold: 70, radius: 12, amount: 0.5 } }] },
  { name: 'Echo Ghosts', group: 'Composite', base: 1, note: 'Repeated offset copies of the image, faded back.',
    stack: [{ type: 'trails', params: { count: 8, spacing: 0.06, falloff: 0.74, blend: 0.62, additive: true } }, { type: 'bloom', params: { threshold: 60, radius: 22, amount: 0.6 } }, { type: 'saturation', params: { amount: 20 } }] },
  { name: 'Stutter Frame', group: 'Composite', base: 2, note: 'Held frames doubled over each other.',
    stack: [{ type: 'frameStep', params: { hold: 4, mix: 0.72 } }, { type: 'trails', params: { count: 5, spacing: 0.1, falloff: 0.6, blend: 0.42, additive: false } }, { type: 'contrast', params: { amount: 22 } }] },
  { name: 'Strobe Cut', group: 'Composite', base: 3, note: 'A single hard frame, as a strobe would show it.',
    stack: [{ type: 'strobe', params: { rate: 8, duty: 50, depth: 100, phase: 0 } }, { type: 'contrast', params: { amount: 30 } }, { type: 'saturation', params: { amount: 24 } }] },
  { name: 'Spectrum Bars', group: 'Composite', base: 4, note: 'A frequency analyser burned into the frame.',
    graphic: { kind: 'bars', options: { bandCount: 64, amount: 0.72, speed: 0.6, complexity: 4, mirror: true, colorA: '#12d6ff', colorB: '#ff2d78', colorC: '#ffffff' }, blend: 'screen', opacity: 0.62, transform: { y: 520 } },
    stack: [{ type: 'bloom', params: { threshold: 54, radius: 20, amount: 0.7 } }, { type: 'vibrance', params: { amount: 26 } }, { type: 'vignette', params: { amount: 30, softness: 66 } }] },
  { name: 'Waveform Scan', group: 'Composite', base: 5, note: 'Oscilloscope traces drawn over the picture.',
    graphic: { kind: 'waveform', options: { count: 4, size: 0.42, speed: 0.7, smoothing: 0.55, colorA: '#7cffb2', colorB: '#12d6ff', colorC: '#ffffff' }, blend: 'screen', opacity: 0.75 },
    stack: [{ type: 'exposure', params: { amount: -12 } }, { type: 'contrast', params: { amount: 20 } }, { type: 'bloom', params: { threshold: 50, radius: 18, amount: 0.65 } }] },
  { name: 'Concentric Rings', group: 'Composite', base: 6, note: 'Rings pulsing out from the centre of frame.',
    graphic: { kind: 'rings', options: { count: 22, amount: 0.65, speed: 0.9, size: 0.9, colorA: '#ffd166', colorB: '#ff2d78', colorC: '#ffffff' }, blend: 'screen', opacity: 0.7 },
    stack: [{ type: 'bloom', params: { threshold: 56, radius: 26, amount: 0.8 } }, { type: 'vibrance', params: { amount: 22 } }, { type: 'vignette', params: { amount: 34, softness: 64 } }] },

  /* ---- composition and masks ------------------------------------ */
  { name: 'Duotone Split', group: 'Composite', base: 7, note: 'Cool above, warm below, joined by a feathered edge.',
    mask: 'split', maskInvert: true,
    stack: [{ type: 'duotone', params: { shadowColor: '#03202f', highlightColor: '#7ce4ff', strength: 100, midpoint: 50 } }, { type: 'contrast', params: { amount: 18 } }] },
  { name: 'Vignette Mask', group: 'Composite', base: 8, note: 'A soft elliptical window holding the centre.',
    mask: 'ellipse', maskFeather: 0.42,
    stack: [{ type: 'contrast', params: { amount: 26 } }, { type: 'saturation', params: { amount: 28 } }, { type: 'bloom', params: { threshold: 56, radius: 24, amount: 0.7 } }] },
  { name: 'Knockout Text', group: 'Composite', base: 9, note: 'The picture held inside a band of type.',
    text: 'MOTION\nLAB', mask: 'band',
    stack: [{ type: 'halftone', params: { spacing: 7, dotSize: 96, angle: 45, ink: '#101018', paper: '#f4efe2' } }, { type: 'contrast', params: { amount: 20 } }] },
  { name: 'Masked Colour Pop', group: 'Composite', base: 10, note: 'Full colour inside the window, monochrome outside it.',
    mask: 'band', maskFeather: 0.06, maskHeight: 0.42,
    stack: [{ type: 'saturation', params: { amount: 52 } }, { type: 'vibrance', params: { amount: 30 } }, { type: 'contrast', params: { amount: 24 } }], desaturateBase: true },
  { name: 'Polygon Aperture', group: 'Composite', base: 11, note: 'A hand-drawn five-sided window over the frame.',
    mask: 'polygon', maskFeather: 0.05,
    stack: [{ type: 'posterize', params: { levels: 8, blend: 100 } }, { type: 'paletteMap', params: { palette: ['#0d0b1a', '#ff6b9d', '#ffd166', '#f7f3e8'], strength: 74, dither: true, ditherAmount: 0.5 } }] },
  { name: 'Freehand Cut', group: 'Composite', base: 12, note: 'An irregular torn edge revealing the treatment.',
    mask: 'polygonFree', maskFeather: 0.14,
    stack: [{ type: 'grain', params: { size: 2.4, amount: 30, colored: false, animate: 0 } }, { type: 'scratches', params: { count: 10, length: 100, width: 1.6, opacity: 34, bright: true, jitter: 0.9 } }, { type: 'saturation', params: { amount: -46 } }] },
  { name: 'Animated Noise Field', group: 'Composite', base: 13, note: 'Fine animated noise resolving into form.',
    stack: [{ type: 'animatedNoise', params: { noiseKind: 'film', amount: 40, scale: 2.2, speed: 0, mono: true } }, { type: 'edges', params: { threshold: 0.2, thickness: 1, ink: '#e8e8f0', baseFade: 88, colorEdges: false } }, { type: 'contrast', params: { amount: 28 } }] },
  { name: 'Palette Map Poster', group: 'Composite', base: 14, note: 'Six inks chosen from the picture itself.',
    stack: [{ type: 'paletteMap', params: { palette: ['#0f1020', '#33415c', '#7d8cc4', '#f2c14e', '#f78154', '#f4f1de'], strength: 100, dither: true, ditherAmount: 0.7 } }, { type: 'paper', params: { scale: 3.2, intensity: 28 } }] },
  { name: 'Grid Overlay', group: 'Composite', base: 15, note: 'A slow technical grid drifting over the image.',
    graphic: { kind: 'grid', options: { count: 14, size: 0.3, speed: 0.16, amount: 0.55, colorA: '#8fe3ff', colorB: '#ff8fd0', colorC: '#ffffff' }, blend: 'screen', opacity: 0.42 },
    stack: [{ type: 'duotone', params: { shadowColor: '#050a18', highlightColor: '#a8d8ff', strength: 46, midpoint: 50 } }, { type: 'contrast', params: { amount: 22 } }, { type: 'bloom', params: { threshold: 60, radius: 18, amount: 0.55 } }] },
  { name: 'Shapes & Grain', group: 'Composite', base: 16, note: 'Flat geometric shapes over a heavily grained frame.',
    graphic: { kind: 'shape', options: { count: 5, size: 0.5, speed: 0.4, spread: 0.6, rotation: 12, shapeKind: 'circle', colorA: '#ffd166', colorB: '#ef476f', colorC: '#06d6a0' }, blend: 'multiply', opacity: 0.55 },
    stack: [{ type: 'grain', params: { size: 2, amount: 34, colored: false, animate: 0 } }, { type: 'fade', params: { amount: 24 } }, { type: 'contrast', params: { amount: 18 } }] },
  { name: 'Aurora Blend', group: 'Composite', base: 17, note: 'A drifting aurora field blended into the photograph.',
    graphic: { kind: 'gradient', options: { gradientKind: 'aurora', colorA: '#03102b', colorB: '#00d9a3', colorC: '#7b5cff', amount: 0.7, speed: 0.25, complexity: 3 }, blend: 'screen', opacity: 0.48 },
    stack: [{ type: 'bloom', params: { threshold: 54, radius: 30, amount: 0.85 } }, { type: 'vibrance', params: { amount: 30 } }, { type: 'levels', params: { black: 4, white: 96, gamma: 1, outBlack: 0, outWhite: 100 } }] },
  { name: 'Conic Burst', group: 'Composite', base: 18, note: 'A hard conic sweep radiating from centre.',
    graphic: { kind: 'gradient', options: { gradientKind: 'conic', colorA: '#ff2d78', colorB: '#12d6ff', colorC: '#ffd166', rotation: 20, speed: 0.15, amount: 0.6 }, blend: 'overlay', opacity: 0.5 },
    stack: [{ type: 'bloom', params: { threshold: 58, radius: 24, amount: 0.75 } }, { type: 'saturation', params: { amount: 34 } }, { type: 'vignette', params: { amount: 40, softness: 58 } }] },
  { name: 'Noise Silk', group: 'Composite', base: 19, note: 'Fine noise turned into a silky interference pattern.',
    graphic: { kind: 'noise', options: { colorA: '#ffffff', colorB: '#000000', amount: 0.5, size: 0.35, complexity: 4, speed: 0.2 }, blend: 'overlay', opacity: 0.4 },
    stack: [{ type: 'paper', params: { scale: 2, intensity: 34 } }, { type: 'levels', params: { black: 6, white: 94, gamma: 1.06, outBlack: 2, outWhite: 98 } }, { type: 'saturation', params: { amount: -22 } }] },
  { name: 'Kinetic Type', group: 'Composite', base: 20, note: 'Large type cropped by the frame edge.',
    text: 'MOTION LAB', textSize: 300, textAlign: 'center',
    stack: [{ type: 'contrast', params: { amount: 30 } }, { type: 'duotone', params: { shadowColor: '#0a0618', highlightColor: '#ffe0a3', strength: 40, midpoint: 48 } }, { type: 'grain', params: { size: 1.6, amount: 20, colored: false, animate: 0 } }] },
];

/* ------------------------------------------------------------------ *
 * Source selection
 * ------------------------------------------------------------------ */

/**
 * Pick source images spread across the folder.
 *
 * Files named `<name>_<uuid>_<n>.<ext>` (several variants of one picture, as
 * image generators often save them) are grouped into one set, so selecting
 * every Nth *set* gives a wide spread of subjects rather than near-copies of
 * the same thing. Any other file is a set of its own. The remainder are shuffled deterministically so a re-run
 * chooses the same files.
 *
 * @param {string} dir
 * @param {number} count
 * @returns {Promise<string[]>}
 */
async function pickSources(dir, count) {
  const files = (await fs.readdir(dir)).filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).sort();
  if (files.length === 0) throw new Error(`No PNG, JPG or WebP images in ${dir}`);
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  for (const name of files) {
    const match = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(\d+)\./i.exec(name);
    const key = match ? match[1] : name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(name);
  }
  const sets = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  // Deterministic shuffle of the set order, so the sample spans the whole folder
  // instead of clustering at the start of the alphabet.
  let state = 0x2f6e2b1;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return ((state >>> 0) % 1000000) / 1000000;
  };
  for (let i = sets.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [sets[i], sets[j]] = [sets[j], sets[i]];
  }

  const chosen = [];
  for (let index = 0; index < count; index += 1) {
    const [key, list] = sets[index % sets.length];
    // Which of the four variants: rotate so repeats of a set differ.
    const variant = list[Math.floor(index / sets.length) % list.length];
    chosen.push(join(dir, variant ?? list[0]));
    void key;
  }
  return chosen;
}

/* ------------------------------------------------------------------ *
 * Media import
 * ------------------------------------------------------------------ */

/**
 * @param {string} path
 * @param {string} kindHint
 * @returns {Promise<any>}
 */
async function uploadAsset(path, kindHint) {
  const data = await fs.readFile(path);
  const form = new FormData();
  form.append('file', new Blob([data]), basename(path));
  form.append('kindHint', kindHint);
  const response = await fetch(`${BASE}/api/assets`, { method: 'POST', body: form });
  const body = await response.json();
  if (!response.ok) throw new Error(`Upload failed for ${basename(path)}: ${body?.error?.message ?? response.status}`);
  return body.assets[0];
}

/* ------------------------------------------------------------------ *
 * Composition building
 * ------------------------------------------------------------------ */

/**
 * @param {any} source
 * @returns {{width:number, height:number}}
 */
function sourceSize(source) {
  return { width: source.width || WIDTH, height: source.height || HEIGHT };
}

async function main() {
  console.log('Motion Lab — batch look generator');
  console.log('==================================');
  console.log(`source   ${SOURCE_DIR}`);
  console.log(`output   ${OUT_DIR}`);
  console.log(`looks    ${COUNT} at ${WIDTH}x${HEIGHT}, ${SLOT}s per look\n`);

  /* ---- health ---- */
  let health;
  try {
    health = await (await fetch(`${BASE}/api/health`)).json();
  } catch {
    console.error(`No Motion Lab server on ${BASE}. Start it with:  node server/index.js --port ${PORT}`);
    process.exit(2);
  }
  if (!health.tools.ffmpeg) {
    console.error('ffmpeg is required for the contact sheet and thumbnails.');
    process.exit(2);
  }
  const browser = findBrowser();
  if (!browser) {
    console.error('A Chromium browser is required: the exporter renders every frame in one.');
    process.exit(2);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });

  /* ---- pick and import sources ---- */
  const sources = await pickSources(SOURCE_DIR, COUNT);
  if (process.argv.includes('--list-sources')) {
    // Useful for auditing the set: which photograph each look was built from.
    for (const [index, look] of LOOKS.slice(0, COUNT).entries()) {
      console.log(`${String(index + 1).padStart(2, '0')}  ${look.name.padEnd(24)} ${basename(sources[look.base % sources.length])}`);
    }
    return;
  }
  console.log(`\u25a0 Importing ${sources.length} source images`);
  const t0 = Date.now();
  /** @type {any[]} */
  const assets = [];
  for (const [index, path] of sources.entries()) {
    const asset = await uploadAsset(path, 'image');
    assets.push({ ...asset, sourcePath: path });
    if ((index + 1) % 5 === 0 || index === sources.length - 1) {
      process.stdout.write(`  ${index + 1}/${sources.length} imported (${((Date.now() - t0) / 1000).toFixed(0)}s)\r`);
    }
  }
  console.log(`\n  imported in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  /* ---- build one composition holding every look ---- */
  console.log('\n\u25a0 Building the composition');
  const duration = COUNT * SLOT;
  const bundle = {
    looks: LOOKS.slice(0, COUNT).map((look, index) => ({
      index,
      name: look.name,
      group: look.group,
      note: look.note,
      base: look.base % assets.length,
      stack: look.stack,
      graphic: look.graphic ?? null,
      mask: look.mask ?? null,
      maskInvert: Boolean(look.maskInvert),
      maskFeather: look.maskFeather ?? null,
      maskHeight: look.maskHeight ?? null,
      text: look.text ?? null,
      textSize: look.textSize ?? null,
      textAlign: look.textAlign ?? null,
      desaturateBase: Boolean(look.desaturateBase),
      slot: SLOT,
    })),
    assets: assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      sourcePath: asset.sourcePath,
      width: asset.width,
      height: asset.height,
    })),
    composition: { width: WIDTH, height: HEIGHT, fps: 30, duration, background: '#000000' },
  };

  const harnessPort = await findFreePort(9860);
  const page = new BrowserPage({ profileDir: join(ROOT, 'workspace', 'looks-builder-chrome'), width: 1200, height: 800 });
  await page.launch(browser, harnessPort);
  try {
    await page.navigate(`${BASE}/harness.html`, 90000);
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const ready = await page.evaluate(`typeof window.MotionLabHarness === 'object' && window.MotionLabHarness !== null`).catch(() => false);
      if (ready) break;
      await sleep(150);
    }
    const built = await page.evaluate(`(async () => {
      const {
        createProject, defaultClip, defaultGraphic, neutralTransform, uid,
      } = await import('/core/schema.js');
      const { setKeyframe, easingPreset } = await import('/core/keyframes.js');
      const { defaultParams } = await import('/core/effectRegistry.js');

      const bundle = ${JSON.stringify(bundle).replace(/<\//g, '<\\/')};
      const doc = createProject({ name: 'Look set' }, bundle.composition);
      doc.assets = bundle.assets.map((asset) => ({
        id: asset.id, kind: 'image', name: asset.name, fileName: asset.name,
        size: 0, mime: 'image/png', width: asset.width, height: asset.height,
        duration: 0, origin: 'library', status: 'ok', addedAt: new Date().toISOString(),
      }));

      const visual = doc.tracks.filter((track) => track.kind === 'visual');
      const [overlay, main, background] = visual;
      doc.tracks = [overlay, main, background];

      const effectsFor = (stack) => stack.map((entry) => ({
        id: uid('fx'),
        type: entry.type,
        enabled: entry.enabled !== false,
        seed: 1000 + Math.round(Math.random() * 8000),
        params: { ...defaultParams(entry.type), ...entry.params },
      }));

      for (const look of bundle.looks) {
        const start = look.index * look.slot;
        const asset = bundle.assets[look.base];

        /* the photograph */
        const photo = defaultClip({
          name: look.name, kind: 'image', assetId: asset.id, trackId: main.id,
          start, duration: look.slot, seed: 100 + look.index,
        });
        photo.transform = { ...neutralTransform(), scaleX: 1.04, scaleY: 1.04 };
        // A slow drift, so each still is an unmistakably film-like frame rather
        // than a flat duplicate of the source.
        setKeyframe(photo, 'transform.scale.x', start, 1.02, easingPreset('Linear'));
        setKeyframe(photo, 'transform.scale.x', start + look.slot, 1.02 + 0.06 + (look.index % 5) * 0.012, easingPreset('Linear'));
        setKeyframe(photo, 'transform.scale.y', start, 1.02, easingPreset('Linear'));
        setKeyframe(photo, 'transform.scale.y', start + look.slot, 1.02 + 0.06 + (look.index % 5) * 0.012, easingPreset('Linear'));
        setKeyframe(photo, 'transform.position.x', start, -18, easingPreset('Linear'));
        setKeyframe(photo, 'transform.position.x', start + look.slot, 18, easingPreset('Linear'));

        /* a monochrome base when the look wants a colour pop inside the mask */
        if (look.desaturateBase) {
          photo.effects.stack.push({ id: uid('fx'), type: 'saturation', enabled: true, seed: 1, params: { ...defaultParams('saturation'), amount: -100 } });
          photo.effects.stack.push({ id: uid('fx'), type: 'contrast', enabled: true, seed: 2, params: { ...defaultParams('contrast'), amount: 14 } });
        }

        /* the treatment stack, applied to the photograph */
        photo.effects.stack.push(...effectsFor(look.stack));

        /* masks */
        if (look.mask === 'split') {
          photo.masks.push({
            id: uid('mask'), name: 'Split', shape: 'rect', enabled: true, inverted: look.maskInvert,
            position: { x: 0.5, y: 0.34 }, size: { x: 1.4, y: 0.68 }, rotation: 0, roundness: 0,
            feather: look.maskFeather ?? 0.18, opacity: 1, points: [], pointsClosed: true,
          });
        } else if (look.mask === 'ellipse') {
          photo.masks.push({
            id: uid('mask'), name: 'Soft oval', shape: 'ellipse', enabled: true, inverted: false,
            position: { x: 0.5, y: 0.5 }, size: { x: 0.8, y: 0.8 }, rotation: 0, roundness: 0,
            feather: look.maskFeather ?? 0.4, opacity: 1, points: [], pointsClosed: true,
          });
        } else if (look.mask === 'band') {
          photo.masks.push({
            id: uid('mask'), name: 'Band', shape: 'rect', enabled: true, inverted: false,
            position: { x: 0.5, y: 0.5 }, size: { x: 1.4, y: look.maskHeight ?? 0.34 }, rotation: -3,
            roundness: 0.12, feather: look.maskFeather ?? 0.1, opacity: 1, points: [], pointsClosed: true,
          });
        } else if (look.mask === 'polygon') {
          photo.masks.push({
            id: uid('mask'), name: 'Pentagon', shape: 'polygon', enabled: true, inverted: false,
            position: { x: 0.5, y: 0.5 }, size: { x: 0.86, y: 0.86 }, rotation: -90, roundness: 0,
            feather: look.maskFeather ?? 0.04, opacity: 1,
            points: [ { x: 0.5, y: 0.02 }, { x: 0.98, y: 0.37 }, { x: 0.8, y: 0.96 }, { x: 0.2, y: 0.96 }, { x: 0.02, y: 0.37 } ],
            pointsClosed: true,
          });
        } else if (look.mask === 'polygonFree') {
          photo.masks.push({
            id: uid('mask'), name: 'Torn edge', shape: 'polygon', enabled: true, inverted: false,
            position: { x: 0.5, y: 0.5 }, size: { x: 0.95, y: 0.95 }, rotation: 0, roundness: 0,
            feather: look.maskFeather ?? 0.12, opacity: 1,
            points: [ { x: 0.08, y: 0.14 }, { x: 0.42, y: 0.05 }, { x: 0.75, y: 0.17 }, { x: 0.94, y: 0.45 }, { x: 0.86, y: 0.78 }, { x: 0.55, y: 0.95 }, { x: 0.22, y: 0.86 }, { x: 0.05, y: 0.6 } ],
            pointsClosed: true,
          });
        }

        doc.clips.push(photo);

        /* the procedural layer */
        if (look.graphic) {
          const spec = look.graphic.options ?? {};
          const layer = defaultClip({
            name: look.name + ' overlay', kind: 'graphic', trackId: overlay.id,
            start, duration: look.slot, seed: 400 + look.index,
            graphic: { ...defaultGraphic(spec.kind ?? look.graphic.kind), ...spec, kind: look.graphic.kind, seed: 400 + look.index },
          });
          layer.blend = look.graphic.blend ?? 'screen';
          layer.transform = { ...neutralTransform(), ...(look.graphic.transform ?? {}), opacity: look.graphic.opacity ?? 0.8 };
          doc.clips.push(layer);
        }

        /* the type layer */
        if (look.text) {
          const type = defaultClip({ name: look.name + ' type', kind: 'text', trackId: overlay.id, start, duration: look.slot });
          type.text = {
            ...type.text,
            content: look.text,
            fontSize: look.textSize ?? 190,
            fontWeight: 700,
            letterSpacing: 14,
            lineHeight: 0.98,
            align: look.textAlign ?? 'center',
            baseline: 'middle',
            uppercase: true,
            color: '#ffffff',
            shadowColor: 'rgba(0,0,0,0.55)', shadowBlur: 24, shadowY: 8,
          };
          // The type acts as a window onto the treated photograph beneath it.
          type.blend = 'source-over';
          type.transform = { ...neutralTransform() };
          if (look.name === 'Knockout Text') {
            type.masks.push({
              id: uid('mask'), name: 'Type band', shape: 'rect', enabled: true, inverted: false,
              position: { x: 0.5, y: 0.5 }, size: { x: 1.3, y: 0.3 }, rotation: 0, roundness: 0.1,
              feather: 0.08, opacity: 1, points: [], pointsClosed: true,
            });
          }
          doc.clips.push(type);
        }
      }

      window.__lookDoc = doc;
      return {
        clips: doc.clips.length,
        looks: bundle.looks.length,
        duration: doc.composition.duration,
        assets: doc.assets.length,
        effects: doc.clips.reduce((n, clip) => n + clip.effects.stack.length, 0),
        keyframes: doc.clips.reduce((n, clip) => n + clip.keyframes.reduce((m, ch) => m + ch.keys.length, 0), 0),
        masks: doc.clips.reduce((n, clip) => n + clip.masks.length, 0),
      };
    })()`, { awaitPromise: true, timeoutMs: 300000 });

    console.log(`  ${built.looks} looks, ${built.clips} clips, ${built.effects} effects, ${built.keyframes} keyframes, ${built.masks} masks, ${built.duration}s timeline`);

    const docJson = await page.evaluate('JSON.stringify(window.__lookDoc)');
    const doc = JSON.parse(docJson);

    /* ---- submit one export job for the whole set ---- */
    console.log('\n\u25a0 Rendering through the export pipeline');
    const items = LOOKS.slice(0, COUNT).map((look, index) => ({
      time: index * SLOT + SLOT / 2,
      fileName: `${String(index + 1).padStart(2, '0')}-${look.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`,
    }));

    const started = Date.now();
    const { job } = await (await fetch(`${BASE}/api/exports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        doc,
        kind: 'stills',
        items,
        width: WIDTH,
        height: HEIGHT,
        fps: 30,
        rangeStart: 0,
        rangeEnd: doc.composition.duration,
        fileName: 'look-set',
      }),
    })).json();
    console.log(`  job ${job.id}`);

    let finished = null;
    let lastStage = '';
    for (;;) {
      const { job: current } = await (await fetch(`${BASE}/api/exports/${job.id}`)).json();
      if (current.stage !== lastStage) {
        lastStage = current.stage;
        console.log(`  ${current.stage}`);
      }
      if (['done', 'failed', 'cancelled'].includes(current.status)) {
        finished = current;
        break;
      }
      await sleep(600);
    }

    if (finished.status !== 'done') {
      console.error(`\nExport failed: ${finished.error ?? finished.status}`);
      for (const warning of finished.warnings ?? []) console.error(`  ! ${warning}`);
      process.exit(1);
    }
    for (const warning of finished.warnings ?? []) console.log(`  ! ${warning}`);

    /* ---- collect the results ---- */
    const sessionDir = join(ROOT, 'workspace', 'exports', job.id);
    const outDir = join(sessionDir, 'out');
    const files = (await fs.readdir(outDir)).filter((name) => name.endsWith('.png')).sort();
    console.log(`  rendered ${files.length} stills in ${((Date.now() - started) / 1000).toFixed(0)}s`);

    for (const name of files) {
      await fs.copyFile(join(outDir, name), join(OUT_DIR, name));
    }

    /* ---- contact sheet + index ----
     * The numbered stills stay at the top level so the folder is exactly the set
     * of outputs; everything describing the set goes in `_meta/` to keep it out
     * of the way.
     */
    console.log('\n\u25a0 Contact sheet and index');
    const metaDir = join(OUT_DIR, '_meta');
    await fs.mkdir(metaDir, { recursive: true });
    const sheetPath = join(metaDir, 'contact-sheet.png');
    await makeContactSheet(files.map((name) => join(OUT_DIR, name)), sheetPath, tools(), WIDTH, HEIGHT);
    await writeIndex(files, OUT_DIR, metaDir, { width: WIDTH, height: HEIGHT });

    console.log(`\nDone. ${files.length} outputs in ${OUT_DIR}`);
    if (!KEEP_PROJECTS) {
      await fs.rm(sessionDir, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
      console.log('(render scratch removed; pass --keep-projects to keep the export session)');
    }
  } finally {
    await page.close();
  }
}

/** @returns {Awaited<ReturnType<typeof probeTools>>} */
function tools() {
  return /** @type {any} */ (globalThis.__mlTools);
}

/**
 * Tile the stills into one overview image with ffmpeg.
 * @param {string[]} files
 * @param {string} target
 * @param {Awaited<ReturnType<typeof probeTools>>} toolset
 * @param {number} frameWidth
 * @param {number} frameHeight
 */
async function makeContactSheet(files, target, toolset, frameWidth, frameHeight) {
  const columns = 5;
  const rows = Math.ceil(files.length / columns);
  const tileWidth = 300;
  const tileHeight = Math.round((tileWidth * frameHeight) / frameWidth);
  const listPath = join(dirname(files[0]), 'contact-list.txt');
  // ffmpeg's concat demuxer wants one quoted path per line.
  await fs.writeFile(listPath, files.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');

  const result = await run(toolset.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-vf', `scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=decrease,pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2:color=0x111111,tile=${columns}x${rows}:margin=12:padding=8:color=0x08080c`,
    '-frames:v', '1', target,
  ], { timeoutMs: 300000 });
  await fs.rm(listPath, { force: true }).catch(() => {});
  if (result.code === 0) {
    const stat = await fs.stat(target);
    console.log(`  _meta/contact-sheet.png  ${columns}x${rows} grid, ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  } else {
    console.log(`  ! contact sheet failed: ${result.stderr.trim().slice(0, 200)}`);
  }
}

/**
 * A short README and a CSV index so the folder explains itself.
 * @param {string[]} files
 * @param {string} outDir
 * @param {string} metaDir
 * @param {{width:number, height:number}} meta
 */
async function writeIndex(files, outDir, metaDir, meta) {
  const lines = [
    `# Motion Lab — ${files.length} look outputs`,
    '',
    `Generated by Motion Lab's own export pipeline: the same headless-Chrome`,
    `renderer the editor previews with, at ${meta.width}\u00d7${meta.height}. Every file in this`,
    'folder is one look applied to one source photograph; they were all rendered',
    `from a single composition (one 2-second slot per look) in one export pass.`,
    '',
    `- **${files.length} stills**, each a distinct treatment`,
    `- \`_meta/contact-sheet.png\` — every output at a glance`,
    `- \`_meta/index.csv\` — machine-readable file / look / group / description`,
    '',
    '| # | File | Look | Group | What it does |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const [index, look] of LOOKS.slice(0, files.length).entries()) {
    lines.push(`| ${index + 1} | ${files[index]} | ${look.name} | ${look.group} | ${look.note} |`);
  }
  lines.push('');
  await fs.writeFile(join(metaDir, 'README.md'), lines.join('\n'), 'utf8');
  // A copy at the top level means the folder is self-describing even if the
  // metadata directory is moved or ignored.
  await fs.copyFile(join(metaDir, 'README.md'), join(outDir, 'README.md'));

  const csv = ['index,file,look,group,note'];
  for (const [index, look] of LOOKS.slice(0, files.length).entries()) {
    csv.push([index + 1, files[index], look.name, look.group, `"${look.note.replace(/"/g, "'")}"`].join(','));
  }
  await fs.writeFile(join(metaDir, 'index.csv'), csv.join('\n'), 'utf8');
  await fs.copyFile(join(metaDir, 'index.csv'), join(outDir, 'index.csv'));
  console.log('  README.md and index.csv (also in _meta/)');
}

globalThis.__mlTools = await probeTools();
try {
  await main();
} catch (error) {
  console.error('\nLook generation failed:', error);
  process.exit(1);
}
