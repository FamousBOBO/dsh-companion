import fs from 'node:fs';
import path from 'node:path';
import { Code, mediaError } from './errors.mjs';
import { nowIso, resolveInside, sha256Hex } from './ids.mjs';

// Media normalization: sniff the real container, refuse what we cannot prove,
// and never trust a filename or a declared MIME type on its own.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) { offset += 1; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 >= buf.length) return null;
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function gifSize(buf) {
  const head = buf.subarray(0, 6).toString('latin1');
  if (head !== 'GIF87a' && head !== 'GIF89a') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function webpSize(buf) {
  if (buf.length < 30) return null;
  if (buf.subarray(0, 4).toString('latin1') !== 'RIFF' || buf.subarray(8, 12).toString('latin1') !== 'WEBP') return null;
  const chunk = buf.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  return null;
}

/** Identify the real image container from its bytes. */
export function sniffImage(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const png = pngSize(buf);
  if (png) return { mime: 'image/png', format: 'png', ...png };
  const gif = gifSize(buf);
  if (gif) return { mime: 'image/gif', format: 'gif', ...gif };
  const jpeg = jpegSize(buf);
  if (jpeg) return { mime: 'image/jpeg', format: 'jpeg', ...jpeg };
  const webp = webpSize(buf);
  if (webp) return { mime: 'image/webp', format: 'webp', ...webp };
  return null;
}

/** Audio containers we accept from the TTS backend. */
export function sniffAudio(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') {
    return { mime: 'audio/wav', format: 'wav' };
  }
  if (buf.length > 3 && buf.subarray(0, 3).toString('latin1') === 'ID3') return { mime: 'audio/mpeg', format: 'mp3' };
  if (buf.length > 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return { mime: 'audio/mpeg', format: 'mp3' };
  return null;
}

/**
 * Decide which vision route a picture belongs to.
 *
 * The old stack distinguishes stickers by a `sticker_` attachment prefix and by
 * GIF/animation containers; everything unclassified stays on the local route so
 * an unknown picture never silently leaves the machine.
 */
export function classifyKind({ filename = '', mime = '', format = '', source = 'desktop', hint = '' } = {}) {
  if (hint === 'sticker' || hint === 'screen' || hint === 'image') return hint;
  if (source === 'screen-fixture' || source === 'screen') return 'screen';
  const base = String(filename || '').split(/[\\/]/).pop() ?? '';
  if (base.startsWith('sticker_')) return 'sticker';
  if (format === 'gif' || mime === 'image/gif') return 'sticker';
  return 'image';
}

function checkLimits({ width, height, bytes, limits }) {
  if (limits.maxImageBytes && bytes > limits.maxImageBytes) {
    throw mediaError(Code.TOO_LARGE, `image is ${bytes} bytes; limit is ${limits.maxImageBytes}`);
  }
  if (width && height) {
    if (width < limits.minDimension || height < limits.minDimension) {
      throw mediaError(Code.BAD_INPUT, `image is ${width}x${height}; below the ${limits.minDimension}px minimum`);
    }
    if (limits.maxPixels && width * height > limits.maxPixels) {
      throw mediaError(Code.TOO_LARGE, `image is ${width}x${height}; over the pixel limit`);
    }
  }
}

/**
 * Build a validated MediaInput. The owner comes from the channel/identity
 * contract (`owner`), never from anything inside the picture.
 */
export function normalizeMediaInput(input, { limits, sessionId, owner, source = 'desktop', ref, quotedFrom } = {}) {
  const bytes = Buffer.isBuffer(input?.bytes) ? input.bytes : Buffer.from(input?.bytes ?? []);
  if (!bytes.length) throw mediaError(Code.BAD_INPUT, 'empty media payload');
  const sniffed = sniffImage(bytes);
  if (!sniffed) throw mediaError(Code.UNSUPPORTED_TYPE, 'not a PNG/JPEG/WebP/GIF image');
  const effectiveLimits = {
    maxImageBytes: limits?.maxImageBytes ?? Infinity,
    maxPixels: limits?.maxPixels ?? Infinity,
    minDimension: limits?.minDimension ?? 1,
  };
  checkLimits({ width: sniffed.width, height: sniffed.height, bytes: bytes.length, limits: effectiveLimits });
  const digest = sha256Hex(bytes);
  const kind = classifyKind({
    filename: input?.filename ?? '',
    mime: sniffed.mime,
    format: sniffed.format,
    source,
    hint: input?.kindHint ?? '',
  });
  if (!sessionId) throw mediaError(Code.BAD_INPUT, 'a runtime session is required for media work');
  if (!owner?.userId) throw mediaError(Code.BAD_INPUT, 'a resolved owner is required for media work');
  return {
    mediaId: `sha256:${digest}`,
    sourceEventId: input?.sourceEventId,
    sessionId,
    owner: { userId: owner.userId, persona: owner.persona ?? '' },
    kind,
    source,
    mime: sniffed.mime,
    format: sniffed.format,
    bytes: bytes.length,
    width: sniffed.width,
    height: sniffed.height,
    sha256: digest,
    capturedAt: input?.capturedAt ?? nowIso(),
    ref,
    quotedFrom,
  };
}

/** Persist bytes under the managed root and return the relative reference. */
export function writeManaged(root, relativeDir, bytes, filename) {
  const dir = resolveInside(root, relativeDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = resolveInside(root, path.posix.join(relativeDir, filename));
  fs.writeFileSync(target, bytes);
  return path.posix.join(relativeDir, filename);
}

export function readManaged(root, relative) {
  return fs.readFileSync(resolveInside(root, relative));
}

/**
 * Split an animated GIF into at most `max` PNG frames using FFmpeg.
 * Returns [] when FFmpeg is unavailable or the file has a single frame, so the
 * caller can fall back to the still frame instead of failing the turn.
 */
export async function extractGifFrames({ bytes, max = 4, ffmpegPath = 'ffmpeg', run, timeoutMs = 30_000, tempDir }) {
  if (!run) return [];
  const dir = tempDir;
  fs.mkdirSync(dir, { recursive: true });
  const input = path.join(dir, `frame-src-${Date.now()}.gif`);
  fs.writeFileSync(input, bytes);
  const pattern = path.join(dir, 'frame-%02d.png');
  try {
    const result = await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', input, '-vsync', '0', '-frames:v', String(max), pattern], { timeoutMs });
    if (result?.code) return [];
    const frames = fs.readdirSync(dir)
      .filter(name => /^frame-\d+\.png$/.test(name))
      .sort()
      .slice(0, max)
      .map(name => ({ name, bytes: fs.readFileSync(path.join(dir, name)) }));
    return frames;
  } catch {
    return [];
  } finally {
    for (const name of fs.readdirSync(dir).filter(name => name.startsWith('frame-'))) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(input); } catch { /* best effort */ }
  }
}
