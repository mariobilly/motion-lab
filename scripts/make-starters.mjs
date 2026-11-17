/**
 * Build the three starter projects as real project files in the workspace.
 *
 * The editor can also create these from its Templates dialog; this script exists
 * so a fresh checkout has them on disk immediately, and so the smoke test has
 * known-good documents to open.
 *
 * Usage: node scripts/make-starters.mjs
 */

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openWorkspace, writeJsonAtomic } from '../server/workspace.js';
import {
  createProject, defaultClip, defaultGraphic, defaultMapping, defaultTextStyle, neutralTransform, uid,
} from '../core/schema.js';
import { setKeyframe, easingPreset } from '../core/keyframes.js';
import { defaultParams } from '../core/effectRegistry.js';
import { normalizeProject } from '../core/document.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = join(ROOT, 'workspace');

/**
 * @param {Record<string, any>} manifest
 * @returns {Record<string, string>} asset ids by role
 */
function roles(manifest) {
  const assets = manifest?.assets ?? {};
  return {
    photo: assets.photoDusk?.id ?? '',
    plate: assets.textPlate?.id ?? '',
    harbour: assets.clipHarbour?.id ?? '',
    neon: assets.clipNeon?.id ?? '',
    music: assets.trackPulse?.id ?? '',
  };
}

/**
 * @param {Record<string, any>} manifest
 * @returns {any[]}
 */
function assetList(manifest) {
  return Object.values(manifest?.assets ?? {}).map((asset) => ({ ...asset, hasPreview: true }));
}

/* ------------------------------------------------------------------ *
 * 1. Audio-reactive poster
 * ------------------------------------------------------------------ */

function audioReactivePoster(manifest) {
  const media = roles(manifest);
  const doc = createProject({ name: 'Audio-reactive poster' }, { width: 1080, height: 1920, fps: 30, duration: 12, aspect: 'portrait' });
  doc.assets = assetList(manifest);
  const [overlay, main, background] = doc.tracks.filter((track) => track.kind === 'visual');
  const audioTrack = doc.tracks.find((track) => track.kind === 'audio');

  /* Animated gradient bed */
  doc.clips.push(defaultClip({
    name: 'Aurora bed', kind: 'graphic', trackId: background.id, start: 0, duration: 12, seed: 1337,
    graphic: {
      ...defaultGraphic('gradient'), kind: 'gradient', gradientKind: 'aurora', seed: 1337,
      colorA: '#07061a', colorB: '#ff2d78', colorC: '#5ce1ff', amount: 0.7, speed: 0.5, complexity: 3,
    },
  }));

  /* Concentric rings the bass will drive */
  const rings = defaultClip({
    name: 'Bass rings', kind: 'graphic', trackId: main.id, start: 0, duration: 12, seed: 88,
    graphic: {
      ...defaultGraphic('rings'), kind: 'rings', seed: 88, count: 18,
      colorA: '#ff2d78', colorB: '#ffd166', colorC: '#ffffff', amount: 0.7, speed: 1.2, size: 0.85,
    },
  });
  rings.blend = 'screen';
  doc.clips.push(rings);

  /* Frequency bars driven by the mids */
  const bars = defaultClip({
    name: 'Mid bars', kind: 'graphic', trackId: overlay.id, start: 0, duration: 12, seed: 512,
    graphic: {
      ...defaultGraphic('bars'), kind: 'bars', seed: 512, bandCount: 56,
      colorA: '#5ce1ff', colorB: '#ff2d78', colorC: '#ffffff', amount: 0.6, speed: 0.9, complexity: 4, mirror: true,
    },
  });
  bars.blend = 'screen';
  bars.transform = { ...neutralTransform(), opacity: 0.55, scaleX: 1, scaleY: 0.6, y: 520 };
  doc.clips.push(bars);

  /* Masked title with a gradient fill */
  const title = defaultClip({ name: 'Title', kind: 'text', trackId: overlay.id, start: 0.5, duration: 11, seed: 4 });
  title.text = {
    ...defaultTextStyle(), content: 'PULSE', fontSize: 250, fontWeight: 700, letterSpacing: 18,
    lineHeight: 1, maxWidth: 0, uppercase: true, align: 'center',
    strokeColor: '#05050f', strokeWidth: 5,
    shadowColor: 'rgba(0,0,0,0.6)', shadowBlur: 30, shadowY: 12,
    gradientFrom: '#ffffff', gradientTo: '#5ce1ff',
  };
  title.masks.push({
    id: uid('mask'), name: 'Band mask', shape: 'rect', enabled: true, inverted: false,
    position: { x: 0.5, y: 0.5 }, size: { x: 1.4, y: 0.26 }, rotation: -3, roundness: 0.15,
    feather: 0.08, opacity: 1, points: [], pointsClosed: true,
  });
  // Six keys: a slow zoom plus a fade in, so the poster breathes.
  setKeyframe(title, 'transform.scale.x', 0.5, 0.94, easingPreset('Ease in-out'));
  setKeyframe(title, 'transform.scale.x', 11.5, 1.1, easingPreset('Ease in-out'));
  setKeyframe(title, 'transform.scale.y', 0.5, 0.94, easingPreset('Ease in-out'));
  setKeyframe(title, 'transform.scale.y', 11.5, 1.1, easingPreset('Ease in-out'));
  setKeyframe(title, 'transform.opacity', 0.5, 0, easingPreset('Linear'));
  setKeyframe(title, 'transform.opacity', 2.2, 1, easingPreset('Linear'));
  doc.clips.push(title);

  /* Music and the connections */
  doc.clips.push(defaultClip({
    name: 'Music', kind: 'audio', assetId: media.music, trackId: audioTrack.id,
    start: 0, duration: 12, volume: 0.9, fadeIn: 1, fadeOut: 2,
  }));
  doc.mappings.push(
    defaultMapping({ name: 'Bass → ring scale X', source: media.music, band: 'low', target: 'transform.scale.x', clipId: rings.id, sensitivity: 1.4, min: 0.8, max: 1.45, attack: 0.01, release: 0.2 }),
    defaultMapping({ name: 'Bass → ring scale Y', source: media.music, band: 'low', target: 'transform.scale.y', clipId: rings.id, sensitivity: 1.4, min: 0.8, max: 1.45, attack: 0.01, release: 0.2 }),
    defaultMapping({ name: 'Mid → bar opacity', source: media.music, band: 'mid', target: 'transform.opacity', clipId: bars.id, sensitivity: 1.2, min: 0.3, max: 0.85, attack: 0.02, release: 0.24 }),
    defaultMapping({ name: 'Highs → title scale', source: media.music, band: 'high', target: 'transform.scale.x', clipId: title.id, sensitivity: 1, min: 0.97, max: 1.06, attack: 0.015, release: 0.18 }),
  );
  doc.exportRange = { in: 0, out: 12 };
  doc.loopRange = { in: 0, out: 4 };
  return doc;
}

/* ------------------------------------------------------------------ *
 * 2. Stylised video reel
 * ------------------------------------------------------------------ */

function stylisedReel(manifest) {
  const media = roles(manifest);
  const doc = createProject({ name: 'Stylised video reel' }, { width: 1920, height: 1080, fps: 30, duration: 20, aspect: 'landscape' });
  doc.assets = assetList(manifest);
  const [overlay, main, background] = doc.tracks.filter((track) => track.kind === 'visual');
  const audioTrack = doc.tracks.find((track) => track.kind === 'audio');

  /* A background bed so the reel is never empty, even before media is dropped in */
  doc.clips.push(defaultClip({
    name: 'Gradient bed', kind: 'graphic', trackId: background.id, start: 0, duration: 20, seed: 2201,
    graphic: {
      ...defaultGraphic('gradient'), kind: 'gradient', gradientKind: 'mesh', seed: 2201,
      colorA: '#08131f', colorB: '#f2762e', colorC: '#2e6f8f', amount: 0.55, speed: 0.35, count: 8,
    },
  }));

  /* Three slots. Each carries a name that says what to do with it, and the first
   * two reference the sample clips so the reel plays out of the box. */
  const slots = [
    {
      name: media.harbour ? 'Clip 1 — harbour' : 'Clip 1 (drop media here)',
      assetId: media.harbour, start: 0, duration: 7, inPoint: 0.3,
      effects: [
        { type: 'halftone', params: { ...defaultParams('halftone'), spacing: 7, dotSize: 105, angle: 40, ink: '#0b0a12', paper: '#f3ead9' } },
        { type: 'contrast', params: { ...defaultParams('contrast'), amount: 18 } },
      ],
      scale: 1.02, x: 0, y: 0,
    },
    {
      name: media.neon ? 'Clip 2 — neon' : 'Clip 2 (drop media here)',
      assetId: media.neon, start: 6.5, duration: 7, inPoint: 0.2,
      effects: [
        { type: 'frameStep', params: { ...defaultParams('frameStep'), hold: 2, mix: 0.85 } },
        { type: 'rgbOffset', params: { ...defaultParams('rgbOffset'), distance: 3, angle: 0 } },
      ],
      scale: 1.08, x: 60, y: -30,
    },
    {
      name: 'Clip 3 (drop media here)',
      assetId: media.plate || media.photo, start: 13, duration: 7, inPoint: 0,
      effects: [
        { type: 'wave', params: { ...defaultParams('wave'), amplitude: 12, wavelength: 180, animate: 0.8 } },
        { type: 'grain', params: { ...defaultParams('grain'), amount: 16, size: 1.8 } },
      ],
      scale: 1.12, x: -40, y: 20,
    },
  ];

  for (const [index, slot] of slots.entries()) {
    const clip = defaultClip({
      name: slot.name, kind: slot.assetId ? 'video' : 'image', trackId: main.id,
      start: slot.start, duration: slot.duration, inPoint: slot.inPoint, seed: 300 + index * 17,
    });
    if (slot.assetId) clip.assetId = slot.assetId;
    clip.transform = { ...neutralTransform(), scaleX: slot.scale, scaleY: slot.scale, x: slot.x, y: slot.y };
    for (const effect of slot.effects) {
      clip.effects.stack.push({ id: uid('fx'), type: effect.type, enabled: true, seed: 900 + index * 13, params: effect.params });
    }
    // Cross-fades in and out of every slot, plus a slow drift on the middle one.
    const fade = 0.7;
    setKeyframe(clip, 'transform.opacity', slot.start, 0, easingPreset('Ease out'));
    setKeyframe(clip, 'transform.opacity', slot.start + fade, 1, easingPreset('Linear'));
    setKeyframe(clip, 'transform.opacity', slot.start + slot.duration - fade, 1, easingPreset('Linear'));
    setKeyframe(clip, 'transform.opacity', slot.start + slot.duration, 0, easingPreset('Ease in'));
    setKeyframe(clip, 'transform.scale.x', slot.start, slot.scale, easingPreset('Ease in-out'));
    setKeyframe(clip, 'transform.scale.x', slot.start + slot.duration, slot.scale * 1.12, easingPreset('Ease in-out'));
    setKeyframe(clip, 'transform.scale.y', slot.start, slot.scale, easingPreset('Ease in-out'));
    setKeyframe(clip, 'transform.scale.y', slot.start + slot.duration, slot.scale * 1.12, easingPreset('Ease in-out'));
    doc.clips.push(clip);
  }

  /* A grade over everything beneath, and a title */
  const grade = defaultClip({ name: 'Teal & orange grade', kind: 'adjustment', trackId: overlay.id, start: 0, duration: 20 });
  grade.effects.stack.push({ id: uid('fx'), type: 'duotone', enabled: true, seed: 41, params: { ...defaultParams('duotone'), shadowColor: '#04212b', highlightColor: '#ffbe73', strength: 22 } });
  grade.effects.stack.push({ id: uid('fx'), type: 'vignette', enabled: true, seed: 42, params: { ...defaultParams('vignette'), amount: 32, softness: 55 } });
  grade.effects.stack.push({ id: uid('fx'), type: 'bloom', enabled: true, seed: 43, params: { ...defaultParams('bloom'), threshold: 72, radius: 16, amount: 0.35 } });
  doc.clips.push(grade);

  const title = defaultClip({ name: 'Reel title', kind: 'text', trackId: overlay.id, start: 1, duration: 6, seed: 7 });
  title.text = {
    ...defaultTextStyle(), content: 'MOTION LAB', fontSize: 150, fontWeight: 700, letterSpacing: 22,
    maxWidth: 0, uppercase: true, align: 'center', color: '#ffffff',
    strokeColor: '#04141b', strokeWidth: 4,
    shadowColor: 'rgba(0,0,0,0.5)', shadowBlur: 24, shadowY: 8,
  };
  title.masks.push({
    id: uid('mask'), name: 'Title band', shape: 'rect', enabled: true, inverted: false,
    position: { x: 0.5, y: 0.5 }, size: { x: 1.2, y: 0.24 }, rotation: 0, roundness: 0.4,
    feather: 0.14, opacity: 1, points: [], pointsClosed: true,
  });
  setKeyframe(title, 'transform.position.y', 1, 90, easingPreset('Ease out'));
  setKeyframe(title, 'transform.position.y', 3.5, 0, easingPreset('Ease in-out'));
  setKeyframe(title, 'transform.opacity', 1, 0, easingPreset('Linear'));
  setKeyframe(title, 'transform.opacity', 2.2, 1, easingPreset('Linear'));
  setKeyframe(title, 'transform.opacity', 5.4, 1, easingPreset('Linear'));
  setKeyframe(title, 'transform.opacity', 6.6, 0, easingPreset('Ease in'));
  doc.clips.push(title);

  doc.clips.push(defaultClip({
    name: 'Music', kind: 'audio', assetId: media.music, trackId: audioTrack.id,
    start: 0, duration: 20, volume: 0.85, fadeIn: 1.5, fadeOut: 3,
  }));
  doc.exportRange = { in: 0, out: 20 };
  doc.loopRange = { in: 0, out: 6.5 };
  return doc;
}

/* ------------------------------------------------------------------ *
 * 3. Animated photograph
 * ------------------------------------------------------------------ */

function animatedPhotograph(manifest) {
  const media = roles(manifest);
  const doc = createProject({ name: 'Animated photograph' }, { width: 1080, height: 1920, fps: 25, duration: 15, aspect: 'portrait' });
  doc.assets = assetList(manifest);
  const [overlay, main, background] = doc.tracks.filter((track) => track.kind === 'visual');

  /* A paper-toned bed so the frame is never empty if the photo is missing. */
  doc.clips.push(defaultClip({
    name: 'Paper bed', kind: 'graphic', trackId: background.id, start: 0, duration: 15, seed: 6600,
    graphic: {
      ...defaultGraphic('noise'), kind: 'noise', seed: 6600, complexity: 4, size: 0.8,
      colorA: '#efe6d6', colorB: '#c9b89c', amount: 0.45, speed: 0.45,
    },
  }));

  const photo = defaultClip({
    name: 'Photograph', kind: 'image', assetId: media.photo, trackId: main.id, start: 0, duration: 15, seed: 21,
  });
  photo.transform = { ...neutralTransform(), scaleX: 1.05, scaleY: 1.05 };
  // A slow zoom, a gentle drift and a fade up: the classic "living photograph".
  setKeyframe(photo, 'transform.scale.x', 0, 1, easingPreset('Ease in-out'));
  setKeyframe(photo, 'transform.scale.x', 15, 1.35, easingPreset('Ease in-out'));
  setKeyframe(photo, 'transform.scale.y', 0, 1, easingPreset('Ease in-out'));
  setKeyframe(photo, 'transform.scale.y', 15, 1.35, easingPreset('Ease in-out'));
  setKeyframe(photo, 'transform.position.x', 0, -34, easingPreset('Ease out'));
  setKeyframe(photo, 'transform.position.x', 8, 26, easingPreset('Ease in-out'));
  setKeyframe(photo, 'transform.position.x', 15, -10, easingPreset('Ease in'));
  setKeyframe(photo, 'transform.opacity', 0, 0, easingPreset('Ease out'));
  setKeyframe(photo, 'transform.opacity', 2.5, 1, easingPreset('Linear'));
  photo.effects.stack.push({ id: uid('fx'), type: 'grain', enabled: true, seed: 61, params: { ...defaultParams('grain'), amount: 20, size: 1.6 } });
  photo.effects.stack.push({ id: uid('fx'), type: 'vignette', enabled: true, seed: 62, params: { ...defaultParams('vignette'), amount: 38, softness: 60 } });
  photo.effects.stack.push({ id: uid('fx'), type: 'scratches', enabled: true, seed: 63, params: { ...defaultParams('scratches'), count: 6, opacity: 22, length: 80, jitter: 0.4 } });
  photo.effects.stack.push({ id: uid('fx'), type: 'fade', enabled: true, seed: 64, params: { ...defaultParams('fade'), amount: 12 } });
  doc.clips.push(photo);

  const caption = defaultClip({ name: 'Caption', kind: 'text', trackId: overlay.id, start: 2.5, duration: 11, seed: 9 });
  caption.text = {
    ...defaultTextStyle(), content: 'A photograph,\nanimated', fontSize: 92, fontWeight: 400, italic: true,
    letterSpacing: 2, lineHeight: 1.25, maxWidth: 640, align: 'center', color: '#fdf8ef',
    shadowColor: 'rgba(20,10,0,0.55)', shadowBlur: 20, shadowY: 6,
  };
  caption.masks.push({
    id: uid('mask'), name: 'Soft oval', shape: 'ellipse', enabled: true, inverted: false,
    position: { x: 0.5, y: 0.72 }, size: { x: 0.92, y: 0.3 }, rotation: 0, roundness: 0,
    feather: 0.35, opacity: 1, points: [], pointsClosed: true,
  });
  setKeyframe(caption, 'transform.position.y', 2.5, 60, easingPreset('Ease out'));
  setKeyframe(caption, 'transform.position.y', 5.5, 0, easingPreset('Ease in-out'));
  setKeyframe(caption, 'transform.opacity', 2.5, 0, easingPreset('Linear'));
  setKeyframe(caption, 'transform.opacity', 4.5, 1, easingPreset('Linear'));
  setKeyframe(caption, 'transform.opacity', 11.5, 1, easingPreset('Linear'));
  setKeyframe(caption, 'transform.opacity', 13.5, 0, easingPreset('Ease in'));
  doc.clips.push(caption);

  doc.exportRange = { in: 0, out: 15 };
  doc.loopRange = { in: 0, out: 5 };
  return doc;
}

async function main() {
  const workspace = await openWorkspace(WORKSPACE);
  let manifest = null;
  try {
    manifest = JSON.parse(await fs.readFile(join(WORKSPACE, 'sample-media', 'manifest.json'), 'utf8'));
  } catch {
    console.warn('No sample-media manifest found. Run `node scripts/make-sample-media.mjs` first');
    console.warn('if you want the starter projects to reference the sample clips and music.');
  }

  // The photograph is written last so it is the most recently updated project
  // and therefore the one the editor opens on a fresh checkout: it needs no
  // audio analysis to look right, whereas the poster does.
  const starters = [
    audioReactivePoster(manifest),
    stylisedReel(manifest),
    animatedPhotograph(manifest),
  ];

  for (const doc of starters) {
    const { doc: normalized, issues } = normalizeProject(doc);
    normalized.meta.id = `proj_starter_${normalized.meta.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    normalized.meta.createdAt = Date.now();
    normalized.meta.updatedAt = Date.now();
    await writeJsonAtomic(join(workspace.projects, `${normalized.meta.id}.json`), normalized);
    const warnings = issues.filter((issue) => issue.level !== 'info');
    console.log(`  ${normalized.meta.name}`);
    console.log(`    ${normalized.composition.width}×${normalized.composition.height} @ ${normalized.composition.fps}fps, ${normalized.composition.duration}s`);
    console.log(`    ${normalized.clips.length} clips, ${normalized.clips.reduce((n, clip) => n + clip.effects.stack.length, 0)} effects, ${normalized.clips.reduce((n, clip) => n + clip.keyframes.reduce((m, channel) => m + channel.keys.length, 0), 0)} keyframes, ${normalized.mappings.length} audio connections`);
    for (const warning of warnings) console.log(`    ! ${warning.message}`);
  }
  console.log(`\n${starters.length} starter projects written to ${workspace.projects}`);
}

main().catch((error) => {
  console.error('Failed to build the starter projects:', error);
  process.exit(1);
});
