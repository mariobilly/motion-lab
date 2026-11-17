/**
 * Builds the sample media the starter projects use.
 *
 * Everything is synthesised locally so the app ships with real, playable media
 * and no binary fixtures:
 *
 *   photo-dusk.png     a photographic still, rendered by the engine itself
 *   text-plate.png     a second still for the stylised reel
 *   clip-harbour.mp4   a 7 s drifting camera move
 *   clip-neon.mp4      a 6 s abstract light study
 *   track-pulse.wav    a synthesised 28 s cue with a clear bass line, mid
 *                      chords and hats -- deliberately easy to see reacting
 *
 * Photos are rendered by driving the engine's own component registry in a
 * headless browser, so the samples exercise the same code path the editor does.
 *
 * Usage: node scripts/make-sample-media.mjs [--force]
 */

import { promises as fs, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserPage, findBrowser, findFreePort, sleep } from '../server/cdp.js';
import { encodeVideo, probeTools, run } from '../server/media.js';
import { openWorkspace, writeJsonAtomic } from '../server/workspace.js';
import { uid } from '../core/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const force = process.argv.includes('--force');

/**
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function isServing(url) {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * @param {number} samples
 * @param {number} sampleRate
 * @param {(t:number)=>number} fn
 * @returns {Float32Array}
 */
function render(samples, sampleRate, fn) {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) out[i] = fn(i / sampleRate);
  return out;
}

/**
 * A short, musical cue: a four-bar loop with a syncopated bass, sustained
 * mid-range chords, a filtered noise hat and a kick. Deliberately obvious so
 * the audio-reactive panel has something to latch onto.
 * @param {number} duration
 * @param {number} sampleRate
 * @returns {{left:Float32Array, right:Float32Array}}
 */
function synthesiseMusic(duration, sampleRate) {
  const total = Math.round(duration * sampleRate);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const tempo = 96;
  const beat = 60 / tempo;
  const bar = beat * 4;

  // A simple deterministic noise source for hats.
  let noiseState = 0x1234567;
  const noise = () => {
    noiseState ^= noiseState << 13;
    noiseState ^= noiseState >>> 17;
    noiseState ^= noiseState << 5;
    return ((noiseState >>> 0) / 2147483648) - 1;
  };

  const bassNotes = [55, 55, 82.41, 55, 73.42, 55, 61.74, 82.41];
  const chordRoots = [220, 174.61, 261.63, 196];

  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    const beatIndex = Math.floor(t / beat);
    const beatPhase = (t % beat) / beat;
    const barIndex = Math.floor(t / bar);
    const barPhase = (t % bar) / bar;

    /* ---- kick: pitch-swept sine on every beat, accent on 1 ---- */
    const kickEnvelope = Math.exp(-beatPhase * 9);
    const kickFrequency = 48 + 92 * Math.exp(-beatPhase * 26);
    const kick = Math.sin(2 * Math.PI * kickFrequency * t) * kickEnvelope * (beatIndex % 4 === 0 ? 0.72 : 0.5);

    /* ---- bass: eighth notes with a low-pass-ish sine + fifth ---- */
    const eighth = Math.floor(t / (beat / 2));
    const bassFrequency = bassNotes[eighth % bassNotes.length];
    const bassPhase = (t % (beat / 2)) / (beat / 2);
    const bassEnvelope = Math.exp(-bassPhase * 5) * (1 - Math.exp(-bassPhase * 60));
    const bass = (Math.sin(2 * Math.PI * bassFrequency * t) * 0.75 + Math.sin(2 * Math.PI * bassFrequency * 2 * t) * 0.12) * bassEnvelope * 0.55;

    /* ---- chords: slowly swelling triad, mid band ---- */
    const root = chordRoots[barIndex % chordRoots.length];
    const swell = 0.5 - 0.5 * Math.cos(Math.PI * 2 * barPhase);
    const chord =
      (Math.sin(2 * Math.PI * root * t) * 0.5 +
        Math.sin(2 * Math.PI * root * 1.2 * t) * 0.35 +
        Math.sin(2 * Math.PI * root * 1.5 * t) * 0.35 +
        Math.sin(2 * Math.PI * root * 2 * t) * 0.12) * swell * 0.24;

    /* ---- hats: bright noise on eighth offbeats ---- */
    const offbeat = (Math.floor(t / (beat / 2)) % 2) === 1;
    const hatPhase = (t % (beat / 2)) / (beat / 2);
    const hat = offbeat ? noise() * Math.exp(-hatPhase * 55) * 0.2 : 0;

    /* ---- occasional bright bell for the high band ---- */
    const bellTrigger = Math.abs(Math.sin(t * 0.35)) > 0.986;
    const bell = bellTrigger ? Math.sin(2 * Math.PI * 1760 * t) * Math.exp(-(t % 1) * 6) * 0.12 : 0;

    const swell2 = 0.85 + 0.15 * Math.sin(t * 0.22);
    const sample = (kick + bass + chord + hat + bell) * swell2;
    // Gentle stereo width: hats and bells lean right, bass stays centred.
    left[i] = Math.max(-1, Math.min(1, sample - hat * 0.1 - bell * 0.05));
    right[i] = Math.max(-1, Math.min(1, sample + hat * 0.25 + bell * 0.2));
  }

  // Normalise to -1.5 dBFS so the mix has headroom.
  let peak = 0;
  for (let i = 0; i < total; i += 1) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  const scale = peak > 0 ? 0.84 / peak : 1;
  for (let i = 0; i < total; i += 1) {
    left[i] *= scale;
    right[i] *= scale;
  }
  return { left, right };
}

/**
 * @param {string} target
 * @param {Float32Array} left
 * @param {Float32Array} right
 * @param {number} sampleRate
 */
async function writeWav(target, left, right, sampleRate) {
  const frames = left.length;
  const buffer = Buffer.alloc(44 + frames * 4);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + frames * 4, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(frames * 4, 40);
  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767))), offset);
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767))), offset + 4 - 2);
    offset += 4;
  }
  await fs.writeFile(target, buffer);
}

/**
 * Register a generated file as a library asset.
 * @param {Awaited<ReturnType<typeof openWorkspace>>} workspace
 * @param {string} kind
 * @param {string} name
 * @param {string} sourcePath
 * @param {any} extra
 */
async function registerAsset(workspace, kind, name, sourcePath, extra = {}) {
  const id = extra.id ?? uid('asset');
  const mediaDir = join(workspace.media, id);
  await fs.mkdir(mediaDir, { recursive: true });
  const extension = sourcePath.slice(sourcePath.lastIndexOf('.'));
  const target = join(mediaDir, `original${extension}`);
  await fs.copyFile(sourcePath, target);
  const stat = await fs.stat(target);

  const tools = await probeTools();
  let probe = { width: 0, height: 0, duration: 0, fps: 0 };
  if (tools.ffprobePath && kind !== 'image') {
    const { probeMedia } = await import('../server/media.js');
    probe = await probeMedia(tools, target);
  }

  const record = {
    id,
    kind,
    name,
    fileName: name,
    size: stat.size,
    mime: extension === '.png' ? 'image/png' : extension === '.mp4' ? 'video/mp4' : extension === '.wav' ? 'audio/wav' : 'application/octet-stream',
    width: extra.width ?? probe.width ?? 0,
    height: extra.height ?? probe.height ?? 0,
    duration: extra.duration ?? probe.duration ?? 0,
    origin: 'procedural',
    status: 'ok',
    addedAt: new Date().toISOString(),
    folderId: kind === 'audio' ? 'folder_audio' : 'folder_footage',
    ...(probe.fps ? { fps: probe.fps } : {}),
  };
  await writeJsonAtomic(join(mediaDir, 'meta.json'), record);

  if (kind !== 'audio') {
    const { makeThumbnail } = await import('../server/media.js');
    await makeThumbnail(tools, target, join(mediaDir, 'preview.jpg'), {
      time: kind === 'video' ? 1 : 0,
      width: 400,
      height: 400,
    });
  } else {
    const { decodeAudioToWav } = await import('../server/media.js');
    await decodeAudioToWav(tools, target, join(mediaDir, 'samples.wav'), 48000);
  }
  return record;
}

async function main() {
  const workspace = await openWorkspace(join(ROOT, 'workspace'));
  const staging = join(ROOT, 'workspace', 'sample-media');
  await fs.mkdir(staging, { recursive: true });

  const tools = await probeTools();
  if (!tools.ffmpeg) {
    console.error('\nffmpeg is required to build the sample video clips.');
    console.error('Install it (winget install Gyan.FFmpeg, brew install ffmpeg, apt install ffmpeg) and run again.');
    process.exit(2);
  }

  const browser = findBrowser();
  if (!browser) {
    console.error('\nA Chromium-based browser is required to render the sample stills.');
    process.exit(2);
  }

  const manifestPath = join(staging, 'manifest.json');
  if (existsSync(manifestPath) && !force) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    console.log('Sample media already built. Use --force to rebuild.');
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  console.log('Building sample media…');

  /* ---------------- stills, rendered by the engine in a browser ---------------- */
  const port = await findFreePort(9600);
  const page = new BrowserPage({ profileDir: join(staging, 'chrome-profile'), width: 1280, height: 900 });
  await page.launch(browser, port);

  // The sample stills import the engine's own modules, so the page has to be
  // served from the app's origin. If no server is already running (and none was
  // given), start one for the duration of the build -- a fresh checkout should
  // not need a second terminal to produce its sample media.
  /** @type {import('node:child_process').ChildProcess|null} */
  let ownedServer = null;
  let baseUrl = process.env.MOTION_LAB_URL ?? '';
  if (!baseUrl) {
    const candidate = `http://127.0.0.1:${process.env.MOTION_LAB_PORT ?? 5273}`;
    if (await isServing(candidate)) {
      baseUrl = candidate;
    } else {
      const serverPort = await findFreePort(5290);
      const { spawn } = await import('node:child_process');
      ownedServer = spawn(process.execPath, ['server/index.js', '--port', String(serverPort)], {
        cwd: resolve(HERE, '..'), stdio: 'ignore', windowsHide: true,
      });
      baseUrl = `http://127.0.0.1:${serverPort}`;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (await isServing(baseUrl)) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
      }
      console.log(`  (started a temporary server on ${baseUrl})`);
    }
  }
  await page.navigate(`${baseUrl}/harness.html`, 60000);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  process.on('exit', () => { try { ownedServer?.kill(); } catch { /* ignore */ } });

  const stills = [
    {
      file: 'photo-dusk.png',
      width: 1600,
      height: 2000,
      recipe: `
        const { valueNoise2d, fbm2d, clamp01, lerp, smoothstep } = await import('/core/math.js');
        const w = canvas.width, h = canvas.height;
        const image = ctx.createImageData(w, h);
        const data = image.data;
        // A layered dusk harbour: sky gradient, sun glow, water, silhouettes.
        for (let y = 0; y < h; y += 1) {
          const v = y / h;
          for (let x = 0; x < w; x += 1) {
            const u = x / w;
            const i = (y * w + x) * 4;
            // sky
            const sky = Math.pow(clamp01(1 - v / 0.62), 1.4);
            let r = lerp(28, 255, sky * 0.9) ;
            let g = lerp(22, 168, sky * 0.85);
            let b = lerp(48, 122, Math.pow(sky, 0.8));
            // sun glow
            const dx = (u - 0.68) * (w / h), dy = v - 0.55;
            const glow = Math.exp(-(dx*dx + dy*dy) * 26);
            r += glow * 190; g += glow * 120; b += glow * 40;
            // clouds
            const cloud = fbm2d(u * 4.2, v * 6.5, 8123, 5);
            const cloudMask = smoothstep(0.42, 0.78, cloud) * smoothstep(0.95, 0.3, v) * 0.85;
            r = lerp(r, 250, cloudMask * 0.55);
            g = lerp(g, 176, cloudMask * 0.6);
            b = lerp(b, 150, cloudMask * 0.5);
            // water
            if (v > 0.62) {
              const ripple = Math.sin((v - 0.62) * 190 + Math.sin(u * 42) * 2.2) * 0.5 + 0.5;
              const depth = (v - 0.62) / 0.38;
              const wr = lerp(52, 12, depth) + ripple * 26 * (1 - depth);
              const wg = lerp(46, 16, depth) + ripple * 18 * (1 - depth);
              const wb = lerp(74, 30, depth) + ripple * 40 * (1 - depth);
              const sunPath = Math.exp(-Math.pow((u - 0.68) * 9, 2)) * (1 - depth);
              r = lerp(r, wr + sunPath * 210, smoothstep(0.62, 0.66, v));
              g = lerp(g, wg + sunPath * 140, smoothstep(0.62, 0.66, v));
              b = lerp(b, wb + sunPath * 60, smoothstep(0.62, 0.66, v));
            }
            // silhouetted skyline
            const skyline = 0.62 - (fbm2d(u * 11, 0.5, 3311, 2) * 0.1 + Math.floor(fbm2d(u * 26, 1.5, 91, 1) * 12) / 90);
            if (v > skyline && v < 0.66) {
              const building = fbm2d(u * 30, v * 4, 551, 2);
              const dark = 8 + building * 18;
              r = lerp(r, dark, 0.94); g = lerp(g, dark + 4, 0.94); b = lerp(b, dark + 12, 0.94);
            }
            // grain
            const grain = (valueNoise2d(u * w * 0.9, v * h * 0.9, 4242) - 0.5) * 9;
            data[i] = clamp01((r + grain) / 255) * 255;
            data[i+1] = clamp01((g + grain) / 255) * 255;
            data[i+2] = clamp01((b + grain) / 255) * 255;
            data[i+3] = 255;
          }
        }
        ctx.putImageData(image, 0, 0);
      `,
    },
    {
      file: 'text-plate.png',
      width: 1600,
      height: 2000,
      recipe: `
        const { fbm2d, clamp01, hexToRgb } = await import('/core/math.js');
        const w = canvas.width, h = canvas.height;
        const image = ctx.createImageData(w, h);
        const data = image.data;
        // Paper-like plate with a fold and a soft vignette, for the text layer.
        for (let y = 0; y < h; y += 1) {
          for (let x = 0; x < w; x += 1) {
            const i = (y * w + x) * 4;
            const u = x / w, v = y / h;
            const fibre = fbm2d(u * 220, v * 220, 77, 3);
            const blotch = fbm2d(u * 5, v * 5, 991, 4);
            const edge = Math.min(1, Math.min(u, 1 - u) * 6) * Math.min(1, Math.min(v, 1 - v) * 6);
            const base = 216 + fibre * 22 + (blotch - 0.5) * 18;
            const shade = 1 - (1 - edge) * 0.22;
            data[i] = clamp01((base * shade) / 255) * 255;
            data[i+1] = clamp01((base * shade * 0.985) / 255) * 255;
            data[i+2] = clamp01((base * shade * 0.95) / 255) * 255;
            data[i+3] = 255;
          }
        }
        ctx.putImageData(image, 0, 0);
        // A smear of pigment across the lower third.
        const grad = ctx.createLinearGradient(0, h * 0.52, w, h * 0.9);
        grad.addColorStop(0, 'rgba(255,61,139,0.0)');
        grad.addColorStop(0.4, 'rgba(255,61,139,0.65)');
        grad.addColorStop(0.75, 'rgba(255,196,87,0.5)');
        grad.addColorStop(1, 'rgba(92,225,255,0.0)');
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = grad;
        ctx.fillRect(0, h * 0.5, w, h * 0.42);
        ctx.globalCompositeOperation = 'source-over';
      `,
    },
  ];

  for (const still of stills) {
    const dataUrl = await page.evaluate(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = ${still.width}; canvas.height = ${still.height};
      const ctx = canvas.getContext('2d');
      ${still.recipe}
      return canvas.toDataURL('image/png');
    })()`, { awaitPromise: true, timeoutMs: 120000 });
    const buffer = Buffer.from(String(dataUrl).split(',')[1], 'base64');
    await fs.writeFile(join(staging, still.file), buffer);
    console.log(`  ${still.file.padEnd(20)} ${(buffer.length / 1024).toFixed(0)} KB`);
  }

  /* ---------------- video clips ---------------- */
  const clips = [
    {
      file: 'clip-harbour.mp4',
      frames: 210,
      fps: 30,
      width: 1280,
      height: 720,
      draw: `
        const { fbm2d, clamp01, lerp, smoothstep, valueNoise2d } = await import('/core/math.js');
        const w = canvas.width, h = canvas.height;
        const drift = t * 0.16;
        const image = ctx.createImageData(w, h);
        const data = image.data;
        for (let y = 0; y < h; y += 1) {
          const v = y / h;
          for (let x = 0; x < w; x += 1) {
            const u = x / w;
            const i = (y * w + x) * 4;
            const sky = Math.pow(clamp01(1 - v / 0.6), 1.3);
            let r = lerp(24, 236, sky);
            let g = lerp(20, 150, sky * 0.9 + drift * 0.1);
            let b = lerp(44, 128, Math.pow(sky, 0.85));
            const dx = (u - (0.6 + Math.sin(t * 0.4) * 0.08)) * (w / h);
            const dy = v - 0.5;
            const glow = Math.exp(-(dx * dx + dy * dy) * 22);
            r += glow * 200; g += glow * 130; b += glow * 46;
            const cloud = fbm2d(u * 3.4 + drift, v * 5.2, 8123, 5);
            const cloudMask = smoothstep(0.42, 0.8, cloud) * smoothstep(0.98, 0.25, v) * 0.9;
            r = lerp(r, 252, cloudMask * 0.6);
            g = lerp(g, 172, cloudMask * 0.62);
            b = lerp(b, 152, cloudMask * 0.5);
            if (v > 0.6) {
              const depth = (v - 0.6) / 0.4;
              const ripple = Math.sin((v - 0.6) * 150 + t * 3 + Math.sin(u * 30) * 2) * 0.5 + 0.5;
              const wr = lerp(46, 10, depth) + ripple * 30 * (1 - depth);
              const wg = lerp(42, 14, depth) + ripple * 22 * (1 - depth);
              const wb = lerp(70, 28, depth) + ripple * 44 * (1 - depth);
              const sunPath = Math.exp(-Math.pow((u - (0.6 + Math.sin(t * 0.4) * 0.08)) * 8, 2)) * (1 - depth) * (0.7 + ripple * 0.5);
              r = lerp(r, wr + sunPath * 200, smoothstep(0.6, 0.64, v));
              g = lerp(g, wg + sunPath * 132, smoothstep(0.6, 0.64, v));
              b = lerp(b, wb + sunPath * 58, smoothstep(0.6, 0.64, v));
            }
            const skyline = 0.6 - (fbm2d(u * 9 + 0.4, 0.5, 3311, 2) * 0.09 + Math.floor(fbm2d(u * 22, 1.5, 91, 1) * 12) / 85);
            if (v > skyline && v < 0.64) {
              const building = fbm2d(u * 26, v * 4, 551, 2);
              const dark = 8 + building * 20 + Math.abs(Math.sin(u * 90 + t)) * 14 * (building > 0.55 ? 1 : 0);
              r = lerp(r, dark, 0.93); g = lerp(g, dark + 5, 0.93); b = lerp(b, dark + 14, 0.93);
            }
            const grain = (valueNoise2d(u * w, v * h, 4242 + Math.floor(t * 30)) - 0.5) * 7;
            data[i] = clamp01((r + grain) / 255) * 255;
            data[i+1] = clamp01((g + grain) / 255) * 255;
            data[i+2] = clamp01((b + grain) / 255) * 255;
            data[i+3] = 255;
          }
        }
        ctx.putImageData(image, 0, 0);
      `,
    },
    {
      file: 'clip-neon.mp4',
      frames: 180,
      fps: 30,
      width: 1280,
      height: 720,
      draw: `
        const { fbm2d, clamp01, seededRandom, hexToRgb } = await import('/core/math.js');
        const w = canvas.width, h = canvas.height;
        ctx.fillStyle = '#07060f';
        ctx.fillRect(0, 0, w, h);
        const random = seededRandom(20240);
        for (let i = 0; i < 60; i += 1) {
          const px = random(), py = random(), radius = 40 + random() * 260;
          const phase = random() * Math.PI * 2;
          const cx = (0.5 + Math.sin(t * 0.5 + phase) * 0.34) * w + px * 60 - 30;
          const cy = (0.5 + Math.cos(t * 0.42 + phase * 1.3) * 0.34) * h + py * 60 - 30;
          const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
          const hue = (i * 37 + t * 30) % 360;
          gradient.addColorStop(0, 'hsla(' + hue + ', 95%, 62%, 0.55)');
          gradient.addColorStop(1, 'hsla(' + ((hue + 60) % 360) + ', 90%, 40%, 0)');
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, w, h);
        }
        ctx.globalCompositeOperation = 'overlay';
        for (let y = 0; y < h; y += 3) {
          const wobble = fbm2d(y * 0.02, t * 0.6, 5150, 3);
          ctx.fillStyle = 'rgba(255,255,255,' + (0.03 + wobble * 0.10) + ')';
          ctx.fillRect(0, y, w, 1);
        }
        ctx.globalCompositeOperation = 'source-over';
        for (let i = 0; i < 90; i += 1) {
          const px = random(), py = random();
          const x = ((px + t * (0.04 + px * 0.06)) % 1) * w;
          const y = ((py + t * (0.02 + py * 0.05)) % 1) * h;
          const radius = 1 + random() * 3.5;
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,' + (0.25 + random() * 0.5) + ')';
          ctx.fill();
        }
      `,
    },
  ];

  const frameDir = join(staging, 'frames');
  for (const clip of clips) {
    const clipFrames = join(frameDir, clip.file.replace('.mp4', ''));
    await fs.rm(clipFrames, { recursive: true, force: true });
    await fs.mkdir(clipFrames, { recursive: true });
    process.stdout.write(`  ${clip.file} … `);
    for (let index = 0; index < clip.frames; index += 1) {
      const t = index / clip.fps;
      const dataUrl = await page.evaluate(`(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = ${clip.width}; canvas.height = ${clip.height};
        const ctx = canvas.getContext('2d');
        const t = ${t};
        ${clip.draw}
        return canvas.toDataURL('image/png');
      })()`, { awaitPromise: true, timeoutMs: 120000 });
      const buffer = Buffer.from(String(dataUrl).split(',')[1], 'base64');
      await fs.writeFile(join(clipFrames, `f${String(index + 1).padStart(5, '0')}.png`), buffer);
      if (index % 15 === 0) process.stdout.write('.');
    }
    const target = join(staging, clip.file);
    const result = await encodeVideo(tools, join(clipFrames, 'f%05d.png'), target, {
      videoEncoder: 'libx264',
      audioEncoder: 'none',
      fps: clip.fps,
      quality: 92,
    });
    if (!result.ok) throw new Error(`Encoding ${clip.file} failed: ${result.error}`);
    await fs.rm(clipFrames, { recursive: true, force: true });
    const stat = await fs.stat(target);
    console.log(` ${clip.frames} frames, ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  }

  await page.close();
  // The temporary server is only needed for the stills and clips. Stop it now:
  // a running child process would keep this script from ever exiting.
  if (ownedServer) {
    ownedServer.kill();
    ownedServer = null;
  }

  /* ---------------- music ---------------- */
  const sampleRate = 48000;
  const duration = 28;
  const { left, right } = synthesiseMusic(duration, sampleRate);
  const wavPath = join(staging, 'track-pulse.wav');
  await writeWav(wavPath, left, right, sampleRate);
  const mp3Path = join(staging, 'track-pulse.mp3');
  const mp3 = await run(tools.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', wavPath, '-c:a', 'libmp3lame', '-b:a', '192k', mp3Path,
  ], { timeoutMs: 300000 });
  const audioPath = mp3.code === 0 ? mp3Path : wavPath;
  const audioStat = await fs.stat(audioPath);
  console.log(`  ${(mp3.code === 0 ? 'track-pulse.mp3' : 'track-pulse.wav').padEnd(20)} ${(audioStat.size / 1024 / 1024).toFixed(1)} MB, ${duration}s`);

  /* ---------------- register as library assets ---------------- */
  const manifest = { builtAt: new Date().toISOString(), assets: {} };
  manifest.assets.photoDusk = await registerAsset(workspace, 'image', 'photo-dusk.png', join(staging, 'photo-dusk.png'), { width: 1600, height: 2000 });
  manifest.assets.textPlate = await registerAsset(workspace, 'image', 'text-plate.png', join(staging, 'text-plate.png'), { width: 1600, height: 2000 });
  manifest.assets.clipHarbour = await registerAsset(workspace, 'video', 'clip-harbour.mp4', join(staging, 'clip-harbour.mp4'), { duration: 7 });
  manifest.assets.clipNeon = await registerAsset(workspace, 'video', 'clip-neon.mp4', join(staging, 'clip-neon.mp4'), { duration: 6 });
  manifest.assets.trackPulse = await registerAsset(workspace, 'audio', mp3.code === 0 ? 'track-pulse.mp3' : 'track-pulse.wav', audioPath, { duration });

  await writeJsonAtomic(manifestPath, manifest);
  await fs.rm(join(staging, 'chrome-profile'), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});

  console.log('\nSample media ready:');
  for (const [key, asset] of Object.entries(manifest.assets)) {
    console.log(`  ${key.padEnd(12)} ${asset.id}  ${asset.name}  ${asset.width}×${asset.height} ${asset.duration ? `${asset.duration.toFixed(1)}s` : ''}`);
  }
  console.log('\nStarter projects are built from these by `node scripts/make-starters.mjs`.');
}

main().catch((error) => {
  console.error('\nSample media build failed:', error);
  process.exit(1);
});
