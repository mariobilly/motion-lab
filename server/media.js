/**
 * Media probing and transcoding, via ffmpeg/ffprobe when present.
 *
 * Motion Lab is designed to work without ffmpeg (you can still edit, preview and
 * export stills and PNG sequences), but video export, video proxies and audio
 * decoding need it. Rather than failing silently, `probeTools()` reports exactly
 * what is available and the UI says so up front -- "check format support before
 * export and clearly identify available alternatives".
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fsRaw } from 'node:fs';
import { join } from 'node:path';

/**
 * Untyped alias: Node's `fs.promises.writeFile` overloads reject `Buffer` under
 * `checkJs`. See the longer note in `exporter.js`.
 * @type {any}
 */
const fs = fsRaw;

/** @typedef {import('./workspace.js').Workspace} Workspace */

/**
 * @typedef {object} ToolStatus
 * @property {boolean} ffmpeg
 * @property {boolean} ffprobe
 * @property {string} [ffmpegPath]
 * @property {string} [ffprobePath]
 * @property {string} [version]
 * @property {string[]} encoders   Video encoders we can actually use.
 * @property {string[]} audioEncoders
 * @property {string[]} muxers
 * @property {string} [hardwareAcceleration]
 */

/** @type {ToolStatus|null} */
let cachedStatus = null;

/**
 * Locate ffmpeg/ffprobe: an explicit env var, then PATH, then the usual Windows
 * install locations.
 * @param {string} name
 * @returns {string|null}
 */
export function findTool(name) {
  const envKey = name === 'ffmpeg' ? 'MOTION_LAB_FFMPEG' : 'MOTION_LAB_FFPROBE';
  if (process.env[envKey] && existsSync(process.env[envKey])) return process.env[envKey];
  const pathEntries = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const entry of pathEntries) {
    if (!entry) continue;
    for (const extension of extensions) {
      const candidate = join(entry, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{input?:Buffer, timeoutMs?:number}} [options]
 * @returns {Promise<{code:number, stdout:Buffer, stderr:string}>}
 */
export function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    /** @type {Buffer[]} */
    const stdout = [];
    /** @type {Buffer[]} */
    const stderr = [];
    let settled = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          if (!settled) {
            settled = true;
            child.kill();
            reject(new Error(`${command} timed out after ${options.timeoutMs} ms`));
          }
        }, options.timeoutMs)
      : null;

    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolvePromise({
        code: code ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    if (options.input) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}

/**
 * Probe the environment once and cache the answer.
 * @param {boolean} [refresh]
 * @returns {Promise<ToolStatus>}
 */
export async function probeTools(refresh = false) {
  if (cachedStatus && !refresh) return cachedStatus;
  const ffmpegPath = findTool('ffmpeg');
  const ffprobePath = findTool('ffprobe');
  /** @type {ToolStatus} */
  const status = {
    ffmpeg: Boolean(ffmpegPath),
    ffprobe: Boolean(ffprobePath),
    encoders: [],
    audioEncoders: [],
    muxers: [],
  };
  if (ffmpegPath) {
    status.ffmpegPath = ffmpegPath;
    try {
      const version = await run(ffmpegPath, ['-hide_banner', '-version'], { timeoutMs: 10000 });
      status.version = (version.stdout.toString('utf8').split('\n')[0] ?? '').trim();
      const encoders = await run(ffmpegPath, ['-hide_banner', '-encoders'], { timeoutMs: 15000 });
      const lines = encoders.stdout.toString('utf8').split('\n');
      for (const line of lines) {
        const match = /^\s*([A-Z.]{6})\s+(\S+)/.exec(line);
        if (!match) continue;
        const [, flags, name] = match;
        if (flags.includes('V')) status.encoders.push(name);
        if (flags.includes('A')) status.audioEncoders.push(name);
      }
      const muxers = await run(ffmpegPath, ['-hide_banner', '-muxers'], { timeoutMs: 15000 });
      for (const line of muxers.stdout.toString('utf8').split('\n')) {
        const match = /^\s*E\s+(\S+)/.exec(line);
        if (match) status.muxers.push(match[1]);
      }
    } catch (error) {
      status.ffmpeg = false;
      status.encoders = [];
    }
  }
  if (ffprobePath) {
    status.ffprobePath = ffprobePath;
    // Hardware acceleration is a nice-to-have hint for the export dialog.
    try {
      const result = await run(ffprobePath, ['-hide_banner', '-hwaccels'], { timeoutMs: 8000 });
      const list = result.stdout.toString('utf8').split('\n').slice(1).map((line) => line.trim()).filter(Boolean);
      if (list.length) status.hardwareAcceleration = list.join(', ');
    } catch {
      /* optional */
    }
  }
  cachedStatus = status;
  return status;
}

/**
 * Which container/codec combinations this machine can actually write.
 * @param {ToolStatus} tools
 * @returns {Array<{id:string, label:string, extension:string, video:string, audio:string, muxer:string, note?:string, available:boolean}>}
 */
export function exportFormats(tools) {
  /** @type {Array<{id:string,label:string,extension:string,video:string,audio:string,muxer:string,note?:string,available:boolean}>} */
  const formats = [
    {
      id: 'mp4-h264',
      label: 'MP4 · H.264 / AAC',
      extension: 'mp4',
      video: 'libx264',
      audio: 'aac',
      muxer: 'mp4',
      note: 'Plays everywhere',
      available: tools.encoders.includes('libx264') && tools.muxers.includes('mp4'),
    },
    {
      id: 'mp4-h265',
      label: 'MP4 · H.265 / AAC',
      extension: 'mp4',
      video: 'libx265',
      audio: 'aac',
      muxer: 'mp4',
      note: 'Smaller files, slower',
      available: tools.encoders.includes('libx265') && tools.muxers.includes('mp4'),
    },
    {
      id: 'webm-vp9',
      label: 'WebM · VP9 / Opus',
      extension: 'webm',
      video: 'libvpx-vp9',
      audio: 'libopus',
      muxer: 'webm',
      note: 'Royalty-free, good for the web',
      available: tools.encoders.includes('libvpx-vp9') && tools.muxers.includes('webm'),
    },
    {
      id: 'webm-vp8',
      label: 'WebM · VP8 / Vorbis',
      extension: 'webm',
      video: 'libvpx',
      audio: 'libvorbis',
      muxer: 'webm',
      available: tools.encoders.includes('libvpx') && tools.muxers.includes('webm'),
    },
    {
      id: 'mkv-av1',
      label: 'MKV · AV1 / Opus',
      extension: 'mkv',
      video: 'libsvtav1',
      audio: 'libopus',
      muxer: 'matroska',
      note: 'Best compression, slowest',
      available: tools.encoders.includes('libsvtav1') && tools.muxers.includes('matroska'),
    },
    {
      id: 'mov-prores',
      label: 'MOV · ProRes 422 / PCM',
      extension: 'mov',
      video: 'prores_ks',
      audio: 'pcm_s16le',
      muxer: 'mov',
      note: 'Editing master, very large',
      available: tools.encoders.includes('prores_ks') && tools.muxers.includes('mov'),
    },
    {
      id: 'gif',
      label: 'Animated GIF',
      extension: 'gif',
      video: 'gif',
      audio: 'none',
      muxer: 'gif',
      note: 'No audio, 256 colours',
      available: tools.encoders.includes('gif') && tools.muxers.includes('gif'),
    },
    {
      id: 'png-sequence',
      label: 'PNG image sequence',
      extension: 'zip',
      video: 'png',
      audio: 'none',
      muxer: 'image2',
      note: 'One PNG per frame, zipped',
      available: true,
    },
  ];
  return formats;
}

/**
 * Probe a media file.
 * @param {ToolStatus} tools
 * @param {string} filePath
 * @returns {Promise<{duration:number, width:number, height:number, fps:number, kind:'image'|'video'|'audio', hasAudio:boolean, hasVideo:boolean, codec:string, error?:string}>}
 */
export async function probeMedia(tools, filePath) {
  const empty = { duration: 0, width: 0, height: 0, fps: 0, kind: /** @type {const} */ ('image'), hasAudio: false, hasVideo: false, codec: '' };
  if (!tools.ffprobePath) {
    return { ...empty, error: 'ffprobe is not installed, so this file could not be inspected on the server. The browser will still try to decode it.' };
  }
  try {
    const result = await run(tools.ffprobePath, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ], { timeoutMs: 30000 });
    if (result.code !== 0) {
      return { ...empty, error: result.stderr.trim() || 'ffprobe could not read this file.' };
    }
    const info = JSON.parse(result.stdout.toString('utf8'));
    const video = (info.streams ?? []).find((/** @type {any} */ stream) => stream.codec_type === 'video');
    const audio = (info.streams ?? []).find((/** @type {any} */ stream) => stream.codec_type === 'audio');
    let fps = 0;
    if (video?.avg_frame_rate && video.avg_frame_rate !== '0/0') {
      const [numerator, denominator] = String(video.avg_frame_rate).split('/').map(Number);
      if (denominator) fps = numerator / denominator;
    }
    const duration = Number(info.format?.duration ?? video?.duration ?? audio?.duration ?? 0) || 0;
    const kind = video ? (duration > 0.05 ? 'video' : 'image') : 'audio';
    return {
      duration,
      width: Number(video?.width ?? 0),
      height: Number(video?.height ?? 0),
      fps,
      kind,
      hasAudio: Boolean(audio),
      hasVideo: Boolean(video),
      codec: String(video?.codec_name ?? audio?.codec_name ?? ''),
    };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Extract a single still as a JPEG thumbnail.
 * @param {ToolStatus} tools
 * @param {string} source
 * @param {string} target
 * @param {{time?:number, width?:number, height?:number, quality?:number}} [options]
 * @returns {Promise<boolean>}
 */
export async function makeThumbnail(tools, source, target, options = {}) {
  if (!tools.ffmpegPath) return false;
  const width = options.width ?? 320;
  const height = options.height ?? 320;
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...(options.time ? ['-ss', String(options.time)] : []),
    '-i', source,
    '-frames:v', '1',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
    '-q:v', String(options.quality ?? 4),
    target,
  ];
  const result = await run(tools.ffmpegPath, args, { timeoutMs: 60000 });
  return result.code === 0;
}

/**
 * Decode an audio file to interleaved 16-bit PCM WAV at a fixed rate so the
 * browser and the server agree on the samples.
 * @param {ToolStatus} tools
 * @param {string} source
 * @param {string} target
 * @param {number} sampleRate
 * @returns {Promise<boolean>}
 */
export async function decodeAudioToWav(tools, source, target, sampleRate = 48000) {
  if (!tools.ffmpegPath) return false;
  const result = await run(tools.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', source,
    '-vn',
    '-ac', '2',
    '-ar', String(sampleRate),
    '-c:a', 'pcm_s16le',
    target,
  ], { timeoutMs: 15 * 60 * 1000 });
  return result.code === 0;
}

/**
 * Extract a video's frames as a numbered PNG sequence at a fixed frame rate,
 * starting at `startTime`. This is what makes an export frame-accurate: the
 * renderer asks for "frame 412 of this clip" and gets exactly that picture,
 * instead of whatever a video element happened to have decoded.
 *
 * @param {ToolStatus} tools
 * @param {string} source
 * @param {string} targetDir
 * @param {{startTime:number, duration:number, fps:number, width:number, height:number, onProgress?:(fraction:number)=>void, shouldCancel?:()=>boolean}} options
 * @returns {Promise<{ok:boolean, frames:number, error?:string}>}
 */
export async function extractVideoFrames(tools, source, targetDir, options) {
  if (!tools.ffmpegPath) return { ok: false, frames: 0, error: 'ffmpeg is not installed.' };
  await fs.mkdir(targetDir, { recursive: true });
  const pattern = join(targetDir, 'f%06d.png');
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', options.startTime.toFixed(6),
    '-i', source,
    '-t', options.duration.toFixed(6),
    '-vf', `fps=${options.fps},scale=${Math.max(2, Math.round(options.width))}:${Math.max(2, Math.round(options.height))}:flags=lanczos`,
    '-vsync', '0',
    pattern,
  ];
  const result = await run(tools.ffmpegPath, args, { timeoutMs: 60 * 60 * 1000 });
  if (result.code !== 0) {
    return { ok: false, frames: 0, error: result.stderr.trim() || 'ffmpeg failed to extract frames.' };
  }
  let frames = 0;
  try {
    const entries = await fs.readdir(targetDir);
    frames = entries.filter((/** @type {string} */ name) => name.endsWith('.png')).length;
  } catch {
    frames = 0;
  }
  return { ok: true, frames };
}

/**
 * Encode a PNG sequence plus an optional WAV soundtrack into a video file.
 * @param {ToolStatus} tools
 * @param {string} framePattern e.g. `/path/f%06d.png`
 * @param {string} outputPath
 * @param {object} options
 * @param {string} options.videoEncoder
 * @param {string} options.audioEncoder
 * @param {number} options.fps
 * @param {number} options.quality 0..100 (higher is better)
 * @param {string} [options.audioInput]
 * @param {string} [options.pixelFormat]
 * @param {(line:string)=>void} [options.onLog]
 * @param {string} [options.extraArgs]
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function encodeVideo(tools, framePattern, outputPath, options) {
  if (!tools.ffmpegPath) return { ok: false, error: 'ffmpeg is not installed.' };
  const quality = Math.max(0, Math.min(100, options.quality));
  /** @type {string[]} */
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(options.fps), '-i', framePattern];
  if (options.audioInput) args.push('-i', options.audioInput);

  const encoder = options.videoEncoder;
  const qualityArgs = [];
  if (encoder === 'libx264' || encoder === 'libx265') {
    // CRF: invert quality so 100 -> 14 (near lossless), 0 -> 34.
    const crf = Math.round(34 - (quality / 100) * 20);
    qualityArgs.push('-crf', String(crf), '-preset', quality > 75 ? 'slow' : 'medium');
    if (encoder === 'libx264') qualityArgs.push('-pix_fmt', options.pixelFormat ?? 'yuv420p');
  } else if (encoder === 'libvpx-vp9') {
    const crf = Math.round(40 - (quality / 100) * 30);
    qualityArgs.push('-crf', String(crf), '-b:v', '0', '-row-mt', '1');
  } else if (encoder === 'libvpx') {
    const bitrate = Math.round(1200 + (quality / 100) * 18000);
    qualityArgs.push('-b:v', `${bitrate}k`);
  } else if (encoder === 'libsvtav1') {
    const crf = Math.round(45 - (quality / 100) * 25);
    qualityArgs.push('-crf', String(crf), '-preset', '8');
  } else if (encoder === 'prores_ks') {
    qualityArgs.push('-profile:v', quality > 70 ? '3' : '2');
  }

  args.push(...qualityArgs, '-c:v', encoder, '-r', String(options.fps));
  if (options.audioInput && options.audioEncoder && options.audioEncoder !== 'none') {
    args.push('-c:a', options.audioEncoder);
    if (options.audioEncoder === 'aac') args.push('-b:a', '256k');
    if (options.audioEncoder === 'libopus') args.push('-b:a', '192k');
    args.push('-shortest');
  } else {
    args.push('-an');
  }
  if (options.extraArgs) args.push(...options.extraArgs.split(/\s+/).filter(Boolean));
  args.push(outputPath);

  const result = await run(tools.ffmpegPath, args, { timeoutMs: 6 * 60 * 60 * 1000 });
  if (result.code !== 0) {
    return { ok: false, error: result.stderr.trim() || `ffmpeg (${encoder}) failed.` };
  }
  return { ok: true };
}

/**
 * Read back the duration and stream layout of a finished export, so the app can
 * confirm "video and audio are present and in sync" rather than assuming it.
 * @param {ToolStatus} tools
 * @param {string} filePath
 * @returns {Promise<{video:{codec:string,frames:number,width:number,height:number,fps:number,duration:number}|null, audio:{codec:string,duration:number,channels:number}|null, format:{duration:number,size:number}}|null>}
 */
export async function inspectExport(tools, filePath) {
  if (!tools.ffprobePath) return null;
  try {
    const result = await run(tools.ffprobePath, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-count_frames', filePath,
    ], { timeoutMs: 120000 });
    if (result.code !== 0) return null;
    const info = JSON.parse(result.stdout.toString('utf8'));
    const video = (info.streams ?? []).find((/** @type {any} */ stream) => stream.codec_type === 'video');
    const audio = (info.streams ?? []).find((/** @type {any} */ stream) => stream.codec_type === 'audio');
    let fps = 0;
    if (video?.avg_frame_rate && video.avg_frame_rate !== '0/0') {
      const [numerator, denominator] = String(video.avg_frame_rate).split('/').map(Number);
      if (denominator) fps = numerator / denominator;
    }
    return {
      video: video
        ? {
            codec: String(video.codec_name ?? ''),
            frames: Number(video.nb_read_frames ?? video.nb_frames ?? 0) || 0,
            width: Number(video.width ?? 0),
            height: Number(video.height ?? 0),
            fps,
            duration: Number(video.duration ?? info.format?.duration ?? 0) || 0,
          }
        : null,
      audio: audio
        ? {
            codec: String(audio.codec_name ?? ''),
            duration: Number(audio.duration ?? 0) || 0,
            channels: Number(audio.channels ?? 0),
          }
        : null,
      format: {
        duration: Number(info.format?.duration ?? 0) || 0,
        size: Number(info.format?.size ?? 0) || 0,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Write a WAV file from planar float samples (used to hand the mixed soundtrack
 * to ffmpeg).
 * @param {string} filePath
 * @param {Float32Array} left
 * @param {Float32Array} right
 * @param {number} sampleRate
 * @returns {Promise<void>}
 */
export async function writeWav(filePath, left, right, sampleRate) {
  const frames = Math.min(left.length, right.length);
  const dataBytes = frames * 4;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(2, 22); // stereo
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767))), offset);
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767))), offset + 2);
    offset += 4;
  }
  await fs.writeFile(filePath, buffer);
}

/**
 * Read a PCM WAV file into planar float arrays. Accepts the 16-bit stereo
 * layout `writeWav` produces and the browser's own WAV importer output.
 * @param {string} filePath
 * @returns {Promise<{left:Float32Array, right:Float32Array, sampleRate:number}|null>}
 */
export async function readWav(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
    let offset = 12;
    let sampleRate = 48000;
    let channels = 2;
    let bits = 16;
    let dataStart = -1;
    let dataLength = 0;
    while (offset + 8 <= buffer.length) {
      const id = buffer.toString('ascii', offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      if (id === 'fmt ') {
        channels = buffer.readUInt16LE(offset + 10);
        sampleRate = buffer.readUInt32LE(offset + 12);
        bits = buffer.readUInt16LE(offset + 22);
      } else if (id === 'data') {
        dataStart = offset + 8;
        dataLength = Math.min(size, buffer.length - dataStart);
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (dataStart < 0) return null;
    const bytesPerSample = bits / 8;
    const frames = Math.floor(dataLength / (bytesPerSample * channels));
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const base = dataStart + frame * bytesPerSample * channels;
      if (bits === 16) {
        left[frame] = buffer.readInt16LE(base) / 32768;
        right[frame] = channels > 1 ? buffer.readInt16LE(base + 2) / 32768 : left[frame];
      } else if (bits === 32) {
        left[frame] = buffer.readFloatLE(base);
        right[frame] = channels > 1 ? buffer.readFloatLE(base + 4) : left[frame];
      } else if (bits === 8) {
        left[frame] = (buffer.readUInt8(base) - 128) / 128;
        right[frame] = channels > 1 ? (buffer.readUInt8(base + 1) - 128) / 128 : left[frame];
      }
    }
    return { left, right, sampleRate };
  } catch {
    return null;
  }
}

/**
 * Zip a directory using ffmpeg's nothing -- we only need stored (uncompressed)
 * entries for PNG sequences, so a tiny writer is enough and avoids a dependency.
 * @param {Array<{name:string, data:Buffer}>} entries
 * @param {string} outputPath
 * @returns {Promise<void>}
 */
export async function writeZip(entries, outputPath) {
  const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
    return table;
  })();

  /** @param {Buffer} buffer */
  const crc32 = (buffer) => {
    let crc = -1;
    for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
    return (crc ^ -1) >>> 0;
  };

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuffer.copy(local, 30);
    chunks.push(local, entry.data);

    const header = Buffer.alloc(46 + nameBuffer.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(entry.data.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(nameBuffer.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    nameBuffer.copy(header, 46);
    central.push(header);

    offset += local.length + entry.data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await fs.writeFile(outputPath, Buffer.concat([...chunks, centralBuffer, end]));
}
