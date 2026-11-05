import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Minimal but structurally valid PNG (IHDR is all the sniffer reads). */
export function pngBytes({ width = 64, height = 48, colorType = 6 } = {}) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(colorType, 17);
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([signature, ihdr, iend]);
}

export function gifBytes({ width = 120, height = 90 } = {}) {
  const header = Buffer.from('GIF89a', 'latin1');
  const dims = Buffer.alloc(4);
  dims.writeUInt16LE(width, 0);
  dims.writeUInt16LE(height, 2);
  return Buffer.concat([header, dims, Buffer.alloc(16)]);
}

export function jpegBytes({ width = 200, height = 100 } = {}) {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(11, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(1, 9);
  return Buffer.concat([soi, app0, sof, Buffer.from([0xff, 0xd9])]);
}

export function webpBytes({ width = 300, height = 200 } = {}) {
  const buf = Buffer.alloc(40);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(32, 4);
  buf.write('WEBP', 8, 'latin1');
  buf.write('VP8X', 12, 'latin1');
  buf.writeUInt32LE(10, 16);
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

/** 16-bit mono PCM WAV, optionally with a placeholder data size like Breeze. */
export function wavBytes({ samples = 2205, rate = 44100, channels = 1, placeholderSize = false } = {}) {
  const pcm = Buffer.alloc(samples * 2 * channels);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((i / 20) * Math.PI) * 8000);
    for (let channel = 0; channel < channels; channel += 1) pcm.writeInt16LE(value, (i * channels + channel) * 2);
  }
  const blockAlign = channels * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(placeholderSize ? 0xffffffff : 36 + pcm.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(placeholderSize ? 0xffffffff : pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function tempRoot(prefix = 'companion-media-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

export function fakeResponse({ status = 200, body = '', json, headers = {} } = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: key => map.get(String(key).toLowerCase()) ?? null },
    async text() { return typeof body === 'string' ? body : String(body); },
    async json() { return json ?? JSON.parse(body || '{}'); },
    async arrayBuffer() { return Buffer.isBuffer(body) ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new TextEncoder().encode(String(body)).buffer; },
    body: null,
  };
}
