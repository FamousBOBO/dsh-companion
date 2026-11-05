import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/** A throwaway data directory (config, ledger, artifacts all live here). */
export function tempDataDir(prefix = 'dsh-media-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A minimal but *valid* PNG header (signature + IHDR) of the given size. */
export function makePng({ width = 1024, height = 1024, extra = 0 } = {}) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8); // IHDR length
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8; // bit depth
  header[25] = 6; // colour type
  return Buffer.concat([header, Buffer.alloc(extra, 0x11)]);
}

/** A minimal valid WAV (44-byte header + silence). */
export function makeWav({ samples = 2400, sampleRate = 24_000 } = {}) {
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Raw mono 16-bit PCM, as Breeze returns it. */
export function makePcm({ samples = 2400 } = {}) {
  return Buffer.alloc(samples * 2, 0x22);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** A single-entry ZIP, deflated — the shape NovelAI's official endpoint returns. */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const compressed = zlib.deflateRawSync(bytes);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, compressed);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** A `Response`-shaped object good enough for `src/net.mjs`. */
export function makeResponse({ status = 200, json = undefined, bytes = null, headers = {}, mime = 'application/json' } = {}) {
  const body = bytes ?? (json !== undefined ? Buffer.from(JSON.stringify(json), 'utf8') : Buffer.alloc(0));
  const map = new Map(Object.entries({ 'content-type': mime, ...headers }).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: key => map.get(String(key).toLowerCase()) ?? null,
      forEach: cb => map.forEach((value, key) => cb(value, key)),
    },
    body: null,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

/**
 * A fetch double. `routes` maps a URL (or a predicate) to either a Response
 * shape or a function returning one. Every call is recorded.
 */
export function mockFetch(routes = []) {
  const calls = [];
  const list = Array.isArray(routes) ? routes : Object.entries(routes).map(([match, response]) => ({ match, response }));
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), init, headers: init.headers ?? {}, body: init.body ?? null };
    calls.push(call);
    const hit = list.find(route => (typeof route.match === 'string' ? route.match === String(url) : route.match(String(url))));
    if (!hit) throw new Error(`mock fetch has no route for ${url}`);
    const value = typeof hit.response === 'function' ? await hit.response(call) : hit.response;
    if (value instanceof Error) throw value;
    return makeResponse(value);
  };
  return { fetchImpl, calls, route: pattern => calls.filter(call => (typeof pattern === 'string' ? call.url === pattern : pattern.test(call.url))) };
}

export function writeConfig(dataDir, config) {
  const file = path.join(dataDir, 'media', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
  return file;
}

export const PNG_B64 = makePng({ width: 832, height: 1216 }).toString('base64');
