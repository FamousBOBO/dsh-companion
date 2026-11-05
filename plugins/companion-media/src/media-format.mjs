import zlib from 'node:zlib';
import { Code, mediaError } from './errors.mjs';

/**
 * Container sniffing and audio wrapping.
 *
 * Declared MIME types and filenames are never trusted: every produced or
 * downloaded artefact is identified from its bytes. A "PNG" that is really an
 * HTML error page must be rejected here, not written to disk and handed to the
 * chat channel.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngInfo(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { mime: 'image/png', format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegInfo(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) { offset += 1; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && offset + 9 < buf.length) {
      return { mime: 'image/jpeg', format: 'jpeg', height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return { mime: 'image/jpeg', format: 'jpeg', width: null, height: null };
}

function gifInfo(buf) {
  const head = buf.subarray(0, 6).toString('latin1');
  if (head !== 'GIF87a' && head !== 'GIF89a') return null;
  return { mime: 'image/gif', format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function webpInfo(buf) {
  if (buf.length < 30) return null;
  if (buf.subarray(0, 4).toString('latin1') !== 'RIFF' || buf.subarray(8, 12).toString('latin1') !== 'WEBP') return null;
  return { mime: 'image/webp', format: 'webp', width: null, height: null };
}

/** Identify an image container from its bytes. Returns null for anything else. */
export function sniffImage(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (!buf.length) return null;
  return pngInfo(buf) ?? gifInfo(buf) ?? jpegInfo(buf) ?? webpInfo(buf) ?? null;
}

function wavInfo(buf) {
  if (buf.length > 44 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') {
    const byteRate = buf.length >= 32 ? buf.readUInt32LE(28) : 0;
    const dataSize = Math.max(0, buf.length - 44);
    const duration = byteRate > 0 ? Number((dataSize / byteRate).toFixed(2)) : null;
    return { mime: 'audio/wav', format: 'wav', durationSeconds: duration };
  }
  return null;
}

function mp3Info(buf) {
  if (buf.length > 3 && buf.subarray(0, 3).toString('latin1') === 'ID3') return { mime: 'audio/mpeg', format: 'mp3', durationSeconds: null };
  if (buf.length > 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return { mime: 'audio/mpeg', format: 'mp3', durationSeconds: null };
  return null;
}

function oggInfo(buf) {
  if (buf.length > 4 && buf.subarray(0, 4).toString('latin1') === 'OggS') {
    if (buf.includes(Buffer.from('OpusHead'))) return { mime: 'audio/ogg', format: 'ogg', durationSeconds: null };
    return { mime: 'audio/ogg', format: 'ogg', durationSeconds: null };
  }
  return null;
}

function flacInfo(buf) {
  if (buf.length > 4 && buf.subarray(0, 4).toString('latin1') === 'fLaC') return { mime: 'audio/flac', format: 'flac', durationSeconds: null };
  return null;
}

const ADTS = buf => buf.length > 2 && buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0;

/** Identify an audio container from its bytes. */
export function sniffAudio(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (!buf.length) return null;
  return wavInfo(buf) ?? oggInfo(buf) ?? flacInfo(buf) ?? mp3Info(buf) ?? (ADTS(buf) ? { mime: 'audio/aac', format: 'aac', durationSeconds: null } : null);
}

/** Wrap raw 16-bit little-endian mono PCM in a WAV container. */
export function pcmToWav(pcm, { sampleRate = 24_000, channels = 1, bitsPerSample = 16 } = {}) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm ?? []);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export const extensionFor = (mime, fallback = 'bin') => {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'audio/wav': 'wav',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/aac': 'aac',
    'audio/flac': 'flac',
  };
  return map[String(mime || '').toLowerCase()] ?? fallback;
};

/** Reject an artefact that is bigger than the configured cap, with the cap in the message. */
export function assertSize(bytes, maxBytes, { what = 'artefact' } = {}) {
  const size = Buffer.isBuffer(bytes) ? bytes.length : 0;
  if (!size) throw mediaError(Code.UPSTREAM, `${what} is empty`);
  if (maxBytes && size > maxBytes) throw mediaError(Code.TOO_LARGE, `${what} is ${size} bytes; the configured limit is ${maxBytes}`);
  return size;
}

/**
 * Pull the first image out of a ZIP archive (NovelAI's official endpoint answers
 * a ZIP attachment). Supports stored (method 0) and deflate (method 8) entries,
 * which is everything a PNG-in-ZIP response uses. No dependency, no temp files.
 */
export function firstImageFromZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw mediaError(Code.UNSUPPORTED_TYPE, 'response is not a ZIP archive');
  const entries = buf.readUInt16LE(eocd + 10);
  let pointer = buf.readUInt32LE(eocd + 16);
  for (let index = 0; index < entries; index += 1) {
    if (buf.readUInt32LE(pointer) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pointer + 10);
    const compressedSize = buf.readUInt32LE(pointer + 20);
    const nameLength = buf.readUInt16LE(pointer + 28);
    const extraLength = buf.readUInt16LE(pointer + 30);
    const commentLength = buf.readUInt16LE(pointer + 32);
    const localOffset = buf.readUInt32LE(pointer + 42);
    const name = buf.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    pointer += 46 + nameLength + extraLength + commentLength;
    if (!/\.(png|jpe?g|webp)$/i.test(name)) continue;
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buf.subarray(start, start + compressedSize);
    const bytes = method === 0 ? payload : zlib.inflateRawSync(payload);
    return { bytes, name };
  }
  throw mediaError(Code.UNSUPPORTED_TYPE, 'ZIP response contains no PNG/JPEG/WebP image');
}

/**
 * Parse a Server-Sent-Events body from NovelAI, returning the concatenated
 * base64 image payload. Events are `data: {"image":"<b64>","final":bool}`.
 */
export function parseNaiSse(text) {
  const chunks = [];
  let error = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const event = JSON.parse(payload);
      if (typeof event.image === 'string' && event.image) chunks.push(event.image);
      // NovelAI reports mid-stream failures inside the event, not via HTTP status.
      if (typeof event.error === 'string' && event.error) error = event.error;
    } catch { /* a partial line is skipped, not fatal */ }
  }
  return { base64: chunks.join(''), error };
}
