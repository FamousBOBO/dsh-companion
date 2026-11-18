// 把 VoceChat 自己生成的消息缩略图换成一张够清晰的。
//
// 为什么需要这个（2026-11-18 实测）：桌面端（exe / 网页）**不显示原图，显示的是
// `?thumbnail=true` 那张**。服务端把缩略图的**长边固定压到 480px**，而气泡按
// `min:200, max:480` 的盒子去撑满宽度 —— 一张 832×1216 的图，缩略图只有 328×480，
// 却被显示在 480 CSS px 宽的盒子里（高 DPI 屏还要再乘 devicePixelRatio）。
// 于是"不放大看就是糊的"。点开预览才走原图（`data-origin`），所以放大是清楚的。
//
// 手机端不这样：它按原图渲染，所以一直没这个问题。
//
// 修法就是**改服务端的那份缩略图**：上传成功后，用 ffmpeg 重新生成一张长边 1080 的
// JPEG 覆盖掉它。1080 覆盖 "480 CSS px × DPR 2" 这个最坏情况，体积仍在几百 KB。
// ffmpeg 不可用时退回"直接用原图覆盖缩略图" —— 那会重一些，但至少是清楚的。
//
// 三条约束：
//   1. **绝不抛。** 缩略图是锦上添花：换失败不该让本来已经发出去的图变成错误。
//   2. **保留 .meta 一致。** 服务端是照 `.meta` 里的 content_type 发 Content-Type 的，
//      换了 JPEG 就必须把 meta 一起改成 image/jpeg，否则头写着 png、字节是 jpeg。
//   3. **原子替换。** 先写临时文件再 rename，避免客户端正好在这一刻读到半个文件。

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 平台路径（`2026/11/18/<uuid>`）对应的缩略图文件位置。
 *
 * 目录结构与 `upload/file/` 完全镜像，只是根换成 `upload/thumbnail/`。
 */
export function thumbnailPathFor(uploadRoot, platformPath) {
  const root = String(uploadRoot ?? '').trim();
  const rel = String(platformPath ?? '').trim();
  if (!root || !rel) return null;
  return path.join(root, 'thumbnail', rel);
}

/** 长边缩放后的目标尺寸；读到尺寸就用它，读不到返回 null。 */
export function scaledSize(width, height, longEdge) {
  const w = Number(width);
  const h = Number(height);
  const cap = Number(longEdge);
  if (!(w > 0) || !(h > 0) || !(cap > 0)) return null;
  if (w <= cap && h <= cap) return { width: w, height: h, upscale: false };
  const scale = cap / Math.max(w, h);
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    upscale: false,
  };
}

function runFfmpeg(ffmpegPath, args, timeoutMs) {
  return new Promise(resolve => {
    execFile(ffmpegPath, args, { timeout: timeoutMs, windowsHide: true }, (error, _stdout, stderr) => {
      resolve({ ok: !error, error: error ? String(error.message).slice(0, 160) : null, stderr: String(stderr ?? '').slice(-200) });
    });
  });
}

/**
 * 用一张更清晰的图替换现有的缩略图。
 *
 * @param {object} input
 * @param {string} input.uploadRoot  `<vocechatData>/upload`
 * @param {string} input.platformPath 上传返回的 path（`2026/11/18/<uuid>`）
 * @param {string} input.originalPath 本机原图绝对路径
 * @param {number} [input.width]      原图宽（来自上传结果，比再去读一遍可靠）
 * @param {number} [input.height]
 * @param {number} [input.longEdge]   目标长边，默认 1080
 * @param {string} [input.ffmpegPath] 默认 `ffmpeg`
 * @param {number} [input.timeoutMs]
 * @param {(line: string) => void} [input.log]
 * @returns {Promise<{ok: boolean, reason?: string, mode?: string, bytes?: number, size?: object}>}
 */
export async function upgradeThumbnail({
  uploadRoot, platformPath, originalPath,
  width = 0, height = 0, longEdge = 1080,
  ffmpegPath = 'ffmpeg', timeoutMs = 30000, log = null,
} = {}) {
  const say = message => { if (typeof log === 'function') { try { log(message); } catch { /* */ } } };
  const thumb = thumbnailPathFor(uploadRoot, platformPath);
  if (!thumb) return { ok: false, reason: 'no-upload-root' };

  let originalSize = 0;
  try { originalSize = fs.statSync(originalPath).size; } catch { return { ok: false, reason: 'original-missing' }; }
  if (originalSize === 0) return { ok: false, reason: 'original-empty' };

  // 没有缩略图就别造一个：服务端没生成，说明它自己判断这张不需要缩略图
  // （小图、GIF 等），那种情况下客户端本来就用原图。
  let thumbSize = 0;
  try { thumbSize = fs.statSync(thumb).size; } catch { return { ok: false, reason: 'no-thumbnail' }; }

  const target = scaledSize(width, height, longEdge);

  // **只换得更好，不换得更差。**
  //
  // 原图比现有缩略图还小的时候（例如一张 64×64 的测试图，服务端把它放大成了 480×480），
  // 按比例算出来的目标是 64×64 —— 那等于把一张 480px 的缩略图换成 64px，屏幕上一放大
  // 反而更糊。这种情况直接跳过，保留服务端那张。
  const current = readPixelSize(thumb);
  if (current && target) {
    const currentLong = Math.max(current.width, current.height);
    const targetLong = Math.max(target.width, target.height);
    if (targetLong <= currentLong) {
      return {
        ok: false,
        reason: 'not-sharper',
        current: { width: current.width, height: current.height },
        target,
      };
    }
  }
  // 原图读不到尺寸时也不能盲换：无法证明换完更清楚。
  if (!current && !(width > 0 && height > 0)) {
    return { ok: false, reason: 'unknown-dimensions' };
  }
  const temp = `${thumb}.dsh-${process.pid}.tmp`;

  // 1. 先试 ffmpeg：体积小、清晰度够。
  const args = [
    '-y', '-loglevel', 'error',
    '-i', originalPath,
    ...(target ? ['-vf', `scale=${target.width}:${target.height}:flags=lanczos`] : []),
    '-q:v', '3',
    '-f', 'mjpeg',
    temp,
  ];
  const ran = await runFfmpeg(ffmpegPath, args, timeoutMs);
  let produced = 0;
  try { produced = fs.statSync(temp).size; } catch { produced = 0; }

  if (ran.ok && produced > 0) {
    try {
      fs.renameSync(temp, thumb);
      writeMeta(thumb, 'image/jpeg');
      say(`缩略图已升级：${platformPath} → ${target ? `${target.width}×${target.height}` : '原尺寸'} jpeg ${produced} 字节`);
      return { ok: true, mode: 'ffmpeg', bytes: produced, size: target ?? null, previousBytes: thumbSize };
    } catch (error) {
      try { fs.rmSync(temp, { force: true }); } catch { /* */ }
      return { ok: false, reason: `replace-failed:${String(error?.message ?? error).slice(0, 80)}` };
    }
  }
  try { fs.rmSync(temp, { force: true }); } catch { /* */ }

  // 2. ffmpeg 不可用 → 直接用原图覆盖。重一些，但清楚。
  //    这里只在**原图确实比缩略图更清晰**时才做：否则等于把一张 480px 的图换成另一张。
  const converted = mimeOnDisk(originalPath);
  if (!converted) {
    return { ok: false, reason: `ffmpeg-unavailable:${ran.error ?? 'no-output'}` };
  }
  try {
    const tempCopy = `${thumb}.dsh-${process.pid}.copy`;
    fs.copyFileSync(originalPath, tempCopy);
    fs.renameSync(tempCopy, thumb);
    writeMeta(thumb, converted);
    say(`缩略图改用原图覆盖（ffmpeg 不可用）：${platformPath} ${originalSize} 字节`);
    return { ok: true, mode: 'copy-original', bytes: originalSize, size: null, previousBytes: thumbSize };
  } catch (error) {
    return { ok: false, reason: `copy-failed:${String(error?.message ?? error).slice(0, 80)}` };
  }
}

/**
 * 读一张图的像素尺寸：PNG 看 IHDR，JPEG 走到第一个 SOF 段。
 *
 * 为什么不用 ffprobe：缩略图是每次发送前都要读的一个小文件，多起一个进程不值得，
 * 而且 ffprobe 在有 EXIF 的 JPEG 上要跳的段更多。这里只需要宽高两个整数。
 */
export function readPixelSize(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  if (buf.length > 24 && buf.subarray(1, 4).toString() === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xFF) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** 只接受浏览器与 VoceChat 都能处理的三种位图格式。 */
function mimeOnDisk(filePath) {  const ext = path.extname(String(filePath ?? '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return null;
}

/**
 * 把缩略图自己的 `.meta` 改成新的 MIME。
 *
 * 服务端照这个文件发 `Content-Type`：不改就会出现"头写 image/png、字节是 JPEG"。
 * 浏览器能嗅探所以看着能用，但任何严格客户端都会拒。写失败只记一笔，不回退已经换好的图。
 */
function writeMeta(thumbPath, contentType) {
  try {
    fs.writeFileSync(`${thumbPath}.meta`, JSON.stringify({ content_type: contentType, filename: null }));
  } catch { /* meta 写不进去不影响图本身 */ }
}
