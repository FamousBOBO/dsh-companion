// 媒体投递：把本机文件发到 VoceChat，把收到的媒体落成本机文件。
//
// 为什么单独一个文件（2026-11-18，`docs/media/capability-audit.md`）：
//
//   生图与 TTS 一直是好的，但生成物**发不出去**。`companion-media` 的 handoff 写死了
//   `qq_sticker` / `qq_voice`（它不知道自己在哪个通道），而 vc 会话里那 28 个 `qq_*`
//   工具是可见的 —— 于是「在 VoceChat 里画一张图」的真实结果是：图发到了主人的 QQ。
//   静默成功，比失败难查得多。
//
// 平台的三个端点实测（0.5.40）：
//
//   POST /api/resource/file/prepare   → "<file_id>"
//   POST /api/resource/file/upload    multipart: chunk_data + chunk_is_last=true + file_id
//   POST /api/user/{uid}/send         content-type: vocechat/file, body {"path":"…"}
//
// 三条硬约束，全部来自实测而不是推断：
//
//   1. **绝不能把字节当 body 直发**（`image/png` → 415）。唯一正确形态是传 path。
//   2. **markdown 里的 `![](...)` 不会变成图片**，只会变成一段带链接的文本。
//   3. **路径边界。** 只发 `workspace` 或 `channel-vocechat` 目录内的文件；越界一律拒绝。
//      这是 `companion-media` 已经写明的 `channelBoundary` 契约，在这里执行。

import fs from 'node:fs';
import path from 'node:path';

/** 图片扩展名 → MIME。`unknown` 一律拒绝而不是猜：发错类型比不发更糟。 */
const IMAGE_MIME = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.bmp', 'image/bmp'],
]);
const AUDIO_MIME = new Map([
  ['.wav', 'audio/wav'], ['.mp3', 'audio/mpeg'], ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/opus'], ['.m4a', 'audio/mp4'], ['.flac', 'audio/flac'], ['.aac', 'audio/aac'],
]);
const VIDEO_MIME = new Map([
  ['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.mov', 'video/quicktime'],
]);
const FILE_MIME = new Map([
  ['.pdf', 'application/pdf'], ['.txt', 'text/plain'], ['.md', 'text/markdown'],
  ['.json', 'application/json'], ['.zip', 'application/zip'],
]);

/**
 * 按扩展名判定 MIME。
 *
 * `kind` 只影响**工具行为**（图片会不会被客户端当图渲染），不改变上传路径 —— 平台只看
 * 上传时给的 MIME。返回 `null` 表示"认不出"，调用方必须拒绝，不能退回
 * `application/octet-stream` 硬发：那会让一张图在客户端变成一个附件下载。
 */
export function mimeOf(filePath) {
  const ext = path.extname(String(filePath ?? '')).toLowerCase();
  if (IMAGE_MIME.has(ext)) return { mime: IMAGE_MIME.get(ext), kind: 'image' };
  if (AUDIO_MIME.has(ext)) return { mime: AUDIO_MIME.get(ext), kind: 'audio' };
  if (VIDEO_MIME.has(ext)) return { mime: VIDEO_MIME.get(ext), kind: 'video' };
  if (FILE_MIME.has(ext)) return { mime: FILE_MIME.get(ext), kind: 'file' };
  return null;
}

/**
 * 文件是否在允许发送的目录之内。
 *
 * 用 `realpath` 比较而不是字符串前缀：`workspace/../secrets` 这种写法在字符串上
 * 通得过、在真实路径上不通。目录不存在时视为不允许（不是"放行"）。
 *
 * @param {string} filePath 绝对路径
 * @param {string[]} roots  允许的根目录（绝对路径）
 * @returns {{ok: true, real: string} | {ok: false, reason: string}}
 */
export function withinRoots(filePath, roots) {
  const target = String(filePath ?? '').trim();
  if (!target) return { ok: false, reason: 'empty-path' };
  if (!path.isAbsolute(target)) return { ok: false, reason: 'not-absolute' };
  let real;
  try { real = fs.realpathSync(target); } catch { return { ok: false, reason: 'not-found' }; }
  for (const root of roots ?? []) {
    const base = String(root ?? '').trim();
    if (!base) continue;
    let realBase;
    try { realBase = fs.realpathSync(base); } catch { continue; }
    const rel = path.relative(realBase, real);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return { ok: true, real };
  }
  return { ok: false, reason: 'outside-boundary' };
}

/** 读一个文件用于发送。大小上限来自配置，超了明确拒绝而不是硬传。 */
export function readForSend(filePath, maxBytes) {
  const cap = Number(maxBytes) > 0 ? Number(maxBytes) : 20 * 1024 * 1024;
  let stat;
  try { stat = fs.statSync(filePath); } catch { return { ok: false, reason: 'not-found' }; }
  if (!stat.isFile()) return { ok: false, reason: 'not-a-file' };
  if (stat.size === 0) return { ok: false, reason: 'empty-file' };
  if (stat.size > cap) return { ok: false, reason: `too-large:${stat.size}>${cap}` };
  try {
    return { ok: true, bytes: fs.readFileSync(filePath), size: stat.size };
  } catch (error) {
    return { ok: false, reason: `read-failed:${String(error?.message ?? error).slice(0, 80)}` };
  }
}

/**
 * 入站媒体的本地落盘。
 *
 * 为什么必须落盘：模型不能直接"看"平台的 path，它能做的是读本机文件。放在
 * `<dataRoot>/home/vocechat-adapter/inbox/` 下并按 mid 命名，于是同一条消息重投时
 * 命中同一个文件（SSE 断线重连确实会重投），也不会把上次的内容覆盖成新的时间戳。
 *
 * 返回的 `relative` 是给模型看的那一段（相对 inbox），`absolute` 是它真正要打开的那个。
 */
export function inboxTarget({ dataRoot, mid, mime }) {
  const dir = path.join(String(dataRoot ?? ''), 'home', 'vocechat-adapter', 'inbox');
  const ext = extensionFor(mime);
  const name = `mid-${Number(mid) || 0}${ext}`;
  return { dir, absolute: path.join(dir, name), relative: name };
}

function extensionFor(mime) {
  const value = String(mime ?? '').toLowerCase();
  for (const [ext, known] of [...IMAGE_MIME, ...AUDIO_MIME, ...VIDEO_MIME, ...FILE_MIME]) {
    if (known === value) return ext;
  }
  return '.bin';
}

/** 写文件，必要时建目录。返回 `{ok, absolute, size}`；永不抛。 */
export function writeInbox({ dir, absolute }, bytes) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absolute, bytes);
    return { ok: true, absolute, size: bytes?.byteLength ?? bytes?.length ?? 0 };
  } catch (error) {
    return { ok: false, reason: `write-failed:${String(error?.message ?? error).slice(0, 100)}` };
  }
}

export { IMAGE_MIME, AUDIO_MIME, VIDEO_MIME, FILE_MIME };
