/**
 * 下载与落盘的唯一硬边界：只做「不接受什么」，不决定「收不收」。字节判型（不信后缀/Content-Type）、
 * 体积与像素上限、SSRF（只 http/https，拒本机/私网/链路本地/云元数据/带凭据地址，重定向 ≤2 跳且
 * 每跳重判）、文件名穿越、realpath 边界、暂存目录 TTL 清理都在这里。
 *
 * 已知边界：DNS 解析结果可能不等于字面量（DNS rebinding），这里只保证字面量被拒。
 */
import fs from 'node:fs';
import path from 'node:path';

import { inside } from './paths.mjs';

/** 带机器可读原因码的拒绝错误。调用方据此记 reasonCode，不用解析中文文案。 */
export class SecurityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SecurityError';
    this.code = String(code);
  }
}

/** 宿主读图能识别的格式（与 dsh-channel-qq 的 sniffImageExtension 对齐，另加 BMP）。 */
export const IMAGE_FORMATS = Object.freeze({
  png: Object.freeze({ mime: 'image/png', ext: '.png' }),
  jpeg: Object.freeze({ mime: 'image/jpeg', ext: '.jpg' }),
  gif: Object.freeze({ mime: 'image/gif', ext: '.gif' }),
  webp: Object.freeze({ mime: 'image/webp', ext: '.webp' }),
  bmp: Object.freeze({ mime: 'image/bmp', ext: '.bmp' }),
});
export const IMAGE_KINDS = Object.freeze(Object.keys(IMAGE_FORMATS));

/** 默认上限：10 MiB 与 4000 万像素（约 8000×5000），单边不超过 10000。 */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_PIXELS = 40_000_000;
export const DEFAULT_MAX_DIMENSION = 10_000;
export const DEFAULT_REDIRECTS = 2;
export const DEFAULT_TIMEOUT_MS = 20_000;

function bytesOf(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  return null;
}

function ascii(buffer, start, end) {
  let text = '';
  for (let index = start; index < end; index += 1) text += String.fromCharCode(buffer[index]);
  return text;
}

/** PNG 的 IHDR 固定在偏移 16；GIF/BMP 是固定小端字段；JPEG 与 WebP 要扫段/看块类型。 */
function readPngSize(buffer) {
  return buffer.length < 24 ? null : { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readGifSize(buffer) {
  return buffer.length < 10 ? null : { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function readBmpSize(buffer) {
  return buffer.length < 26 ? null : { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) };
}

/** SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF15（DHT/JPG/DAC 那几个不是 SOF）。 */
function isSofMarker(marker) {
  return (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
}

function readJpegSize(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    if (isSofMarker(buffer[offset + 1])) return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function readWebpSize(buffer) {
  if (buffer.length < 30) return null;
  const chunk = ascii(buffer, 12, 16);
  if (chunk === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk !== 'VP8 ' || buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
  return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
}

/**
 * 按字节魔数判真实格式。
 * @param {Buffer|Uint8Array} input
 * @returns {{kind: string, mime: string, ext: string, width: number|null, height: number|null}|null}
 */
export function sniffImageFormat(input) {
  const buffer = bytesOf(input);
  if (!buffer || buffer.length < 12) return null;
  const finish = (kind, size) => ({
    kind, mime: IMAGE_FORMATS[kind].mime, ext: IMAGE_FORMATS[kind].ext,
    width: size?.width ?? null, height: size?.height ?? null,
  });
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return finish('png', readPngSize(buffer));
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return finish('jpeg', readJpegSize(buffer));
  if (ascii(buffer, 0, 3) === 'GIF') return finish('gif', readGifSize(buffer));
  if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 12) === 'WEBP') return finish('webp', readWebpSize(buffer));
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return finish('bmp', readBmpSize(buffer));
  return null;
}

/**
 * 校验一批下载字节能否作为表情包素材。
 * @returns {{ok: true, format: object, width: number|null, height: number|null, byteSize: number, mimeMismatch: boolean, message: string}
 *   | {ok: false, reasonCode: string, message: string}}
 */
export function validateImage({
  bytes,
  maxBytes = DEFAULT_MAX_BYTES,
  maxPixels = DEFAULT_MAX_PIXELS,
  maxDimension = DEFAULT_MAX_DIMENSION,
  declaredMime = '',
} = {}) {
  const buffer = bytesOf(bytes);
  if (!buffer || buffer.length === 0) return { ok: false, reasonCode: 'empty-body', message: '下载结果为空。' };
  if (buffer.length > maxBytes) {
    return { ok: false, reasonCode: 'too-large', message: `文件 ${buffer.length} 字节，超过上限 ${maxBytes} 字节。` };
  }
  const mime = String(declaredMime ?? '').split(';')[0].trim().toLowerCase();
  // 空 Content-Type 与 octet-stream 都当「未声明」：QQ 的图片 CDN 常年这么返回，
  // 这时以字节为准；只有明确的非图片类型才直接拒。
  const mimeDeclared = mime !== '' && mime !== 'application/octet-stream' && mime !== 'binary/octet-stream';
  if (mimeDeclared && !mime.startsWith('image/')) {
    return { ok: false, reasonCode: 'not-an-image', message: `对方返回的是 ${mime}，不是图片。` };
  }
  const format = sniffImageFormat(buffer);
  if (!format) return { ok: false, reasonCode: 'unknown-format', message: '认不出图片格式（只接受 PNG/JPEG/GIF/WebP/BMP）。' };
  const { width, height } = format;
  const dimensionsKnown = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  if (dimensionsKnown) {
    if (width > maxDimension || height > maxDimension) {
      return { ok: false, reasonCode: 'too-large-dimension', message: `尺寸 ${width}×${height} 超过单边上限 ${maxDimension}。` };
    }
    if (width * height > maxPixels) {
      return { ok: false, reasonCode: 'too-many-pixels', message: `像素数 ${width * height} 超过上限 ${maxPixels}。` };
    }
  }
  const declaredKind = mime === 'image/jpg' ? 'image/jpeg' : mime;
  const mimeMismatch = mimeDeclared && declaredKind !== format.mime;
  return {
    ok: true,
    format,
    width: dimensionsKnown ? width : null,
    height: dimensionsKnown ? height : null,
    byteSize: buffer.length,
    mimeMismatch,
    message: mimeMismatch ? `声明的 ${mime} 与字节判定的 ${format.mime} 不符，按字节为准。` : '',
  };
}

/** IPv4 字面量是否属于私网/本机/保留段（含八进制与前导零混淆写法）。 */
function isBlockedIpv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some(value => value > 255)) return true;
  if (match.slice(1).some(part => part.length > 1 && part.startsWith('0'))) return true;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true; // 本机/私网/组播与保留
  if (a === 169 && b === 254) return true; // 链路本地 + 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return a === 192 && b === 0 && c === 0;
}

function isBlockedIpv6(host) {
  if (!host.includes(':')) return false;
  const text = host.toLowerCase();
  if (text === '::' || text === '::1' || text.startsWith('::ffff:')) return true;
  if (/^f[cd]/.test(text)) return true; // 唯一本地地址 fc00::/7
  return /^fe[89ab]/.test(text); // 链路本地 fe80::/10
}

/**
 * 主机字面量是否被拒。返回空串表示通过，否则是原因码。
 * @param {string} raw URL 的 hostname（IPv6 已去掉方括号）
 */
export function blockedHostReason(raw) {
  const host = String(raw ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return 'empty-host';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback-name';
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return 'local-domain';
  if (host === 'metadata' || host === 'metadata.google.internal') return 'metadata-host';
  if (/^\d+$/.test(host)) return 'ambiguous-numeric-host';
  if (isBlockedIpv4(host)) return 'private-address';
  if (isBlockedIpv6(host)) return 'private-address';
  return '';
}

/**
 * 只放行 http/https 且主机不在私网/本机。每跳重定向都要再调一次。
 * @returns {URL} 通过检查的 URL 对象
 * @throws {SecurityError}
 */
export function assertFetchableUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new SecurityError('url-invalid', '图片地址不是合法的绝对 URL。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SecurityError('protocol-blocked', `只接受 http/https，拒绝 ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new SecurityError('credentials-blocked', '拒绝带账号密码的图片地址。');
  }
  const reason = blockedHostReason(url.hostname);
  if (reason) throw new SecurityError('host-blocked', `拒绝访问 ${url.hostname}（${reason}）。`);
  return url;
}

async function readBounded(response, maxBytes) {
  const declared = Number(response?.headers?.get?.('content-length') ?? 0);
  if (declared > 0 && declared > maxBytes) throw new SecurityError('too-large', `对方声明 ${declared} 字节，超过上限 ${maxBytes} 字节。`);
  const stream = response?.body;
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new SecurityError('too-large', `响应 ${buffer.length} 字节，超过上限 ${maxBytes} 字节。`);
    return buffer;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const piece = Buffer.from(chunk);
    total += piece.length;
    if (total > maxBytes) throw new SecurityError('too-large', `响应超过上限 ${maxBytes} 字节。`);
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

async function requestOnce(fetchImpl, url, { timeoutMs, headers }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, DEFAULT_TIMEOUT_MS * 3)));
  try {
    return await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new SecurityError('timeout', `下载超时（${timeoutMs}ms）。`);
    throw new SecurityError('transport', `下载失败：${String(error?.message ?? error).slice(0, 120)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把注入的 fetch 包成 get(url, opts)。重定向手动跟随，每跳都重新过 SSRF 闸门。
 * @param {{fetchImpl: Function, now?: () => number, defaultMaxBytes?: number, defaultTimeoutMs?: number, maxRedirects?: number}} options
 */
export function createGuardedHttp({
  fetchImpl,
  now = () => Date.now(),
  defaultMaxBytes = DEFAULT_MAX_BYTES,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  maxRedirects = DEFAULT_REDIRECTS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new SecurityError('transport-missing', 'createGuardedHttp 需要注入 fetch 实现。');

  async function get(rawUrl, options = {}) {
    const maxBytes = Number(options.maxBytes ?? defaultMaxBytes);
    const timeoutMs = Number(options.timeoutMs ?? defaultTimeoutMs);
    const deadline = now() + timeoutMs;
    const headers = options.headers ?? {};
    let current = String(rawUrl);
    const hops = [];
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const url = assertFetchableUrl(current);
      hops.push(url.toString());
      const remaining = deadline - now();
      if (remaining <= 0) throw new SecurityError('timeout', `下载超时（${timeoutMs}ms）。`);
      const response = await requestOnce(fetchImpl, url.toString(), { timeoutMs: remaining, headers });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.('location');
        if (!location) throw new SecurityError('redirect-without-location', '重定向没有 Location 头。');
        current = new URL(location, url.toString()).toString();
        continue;
      }
      const bytes = await readBounded(response, maxBytes);
      const mime = String(response.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase();
      return { ok: Boolean(response.ok), status: Number(response.status), bytes, mime, finalUrl: url.toString(), hops };
    }
    throw new SecurityError('redirect-limit', `重定向超过 ${maxRedirects} 次。`);
  }

  return { get };
}

/**
 * 文件名必须是纯文件名：不含分隔符、`..`、盘符、控制字符与 Windows 保留字符。
 * @returns {string} 原样文件名
 * @throws {SecurityError}
 */
export function assertSafeFilename(raw) {
  const text = String(raw ?? '');
  if (text === '') throw new SecurityError('filename-empty', '文件名不能为空。');
  if (text.length > 180) throw new SecurityError('filename-too-long', '文件名过长。');
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new SecurityError('filename-control', '文件名含控制字符。');
  if (text.includes('/') || text.includes('\\')) throw new SecurityError('filename-separator', '文件名不能含路径分隔符。');
  if (text.includes('..')) throw new SecurityError('filename-traversal', '文件名不能含 `..`。');
  if (path.isAbsolute(text) || /^[A-Za-z]:/.test(text)) throw new SecurityError('filename-absolute', '文件名不能是绝对路径或盘符路径。');
  if (/[<>:"|?*]/.test(text)) throw new SecurityError('filename-reserved', '文件名含系统保留字符。');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(text)) throw new SecurityError('filename-reserved', '文件名是系统保留名。');
  return text;
}

/** 在 root 下拼出一个经过校验的绝对路径（不跟随符号链接，边界由 realpathInside 负责）。 */
export function safeJoin(root, name) {
  const base = path.resolve(root);
  const target = path.resolve(base, assertSafeFilename(name));
  if (!inside(base, target)) throw new SecurityError('path-escape', '目标路径逃出了允许的目录。');
  return target;
}

function realpathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * 真实路径边界：两边都 realpath 之后，child 必须仍在 parent 里。
 * @returns {{ok: boolean, path: string|null, reason: string}}
 */
export function realpathInside(parent, child) {
  const realParent = realpathOrNull(parent);
  if (!realParent) return { ok: false, path: null, reason: 'parent-missing' };
  const realChild = realpathOrNull(child);
  if (!realChild) return { ok: false, path: null, reason: 'child-missing' };
  if (!inside(realParent, realChild)) return { ok: false, path: realChild, reason: 'outside' };
  return { ok: true, path: realChild, reason: '' };
}

/** @throws {SecurityError} 不在边界内时抛错，调用方必须当成失败而不是「差不多能用」。 */
export function assertInsideReal(parent, child) {
  const checked = realpathInside(parent, child);
  if (!checked.ok) {
    throw new SecurityError('path-escape', `路径 ${String(child)} 不在允许的目录 ${String(parent)} 内（${checked.reason}）。`);
  }
  return checked.path;
}

/**
 * 清理暂存目录里超过 TTL 的普通文件。只删一层，不递归、不跟符号链接。
 * @returns {{ok: boolean, removed: Array<{name: string, ageMs: number}>, skipped: number, reason: string}}
 */
export function cleanStage({ root, ttlMs = 600_000, now = () => Date.now(), dryRun = false, maxEntries = 500 } = {}) {
  const removed = [];
  let skipped = 0;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { ok: false, removed, skipped, reason: 'root-missing' };
  }
  for (const entry of entries.slice(0, maxEntries)) {
    const full = path.join(path.resolve(root), entry.name);
    let stat = null;
    try {
      if (entry.isFile()) stat = fs.statSync(full);
    } catch {
      stat = null;
    }
    const ageMs = stat === null ? 0 : Math.max(0, now() - stat.mtimeMs);
    if (stat === null || ageMs < ttlMs) { skipped += 1; continue; }
    if (!dryRun) {
      try { fs.unlinkSync(full); } catch { skipped += 1; continue; }
    }
    removed.push({ name: entry.name, ageMs });
  }
  return { ok: true, removed, skipped, reason: '' };
}

export default {
  SecurityError, IMAGE_FORMATS, IMAGE_KINDS, DEFAULT_MAX_BYTES, DEFAULT_MAX_PIXELS,
  DEFAULT_MAX_DIMENSION, DEFAULT_REDIRECTS, DEFAULT_TIMEOUT_MS, sniffImageFormat, validateImage,
  blockedHostReason, assertFetchableUrl, createGuardedHttp, assertSafeFilename, safeJoin,
  realpathInside, assertInsideReal, cleanStage,
};
