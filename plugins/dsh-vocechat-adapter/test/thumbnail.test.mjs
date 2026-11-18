// 缩略图升级：桌面端"不放大看就是糊的"那一条。
//
// 事故原样：她发 832×1216 的生图，桌面端（exe / 网页）显示成一片模糊，点开放大才清楚；
// 手机端一直是清楚的。原因不在图本身 —— 客户端桌面上**不加载原图**，加载的是服务端
// `?thumbnail=true` 那张，而服务端把长边固定压到 480px，再撑进 480 CSS px 的盒子、
// 高 DPI 屏乘 devicePixelRatio。手机端按原图渲染，所以没这个问题。
//
// 这里钉的不是"函数返回 true"，而是四个会让图片变形或损坏的具体坏结果：
//   1. 缩放算错 → 图被拉伸；
//   2. 缩略图不存在却硬造一个 → 本来是原图直出的小图反而变糊；
//   3. .meta 没跟着改 MIME → 头写 png、字节是 jpeg；
//   4. 换失败却抛错 → 一张清楚的图因为缩略图问题变成"发送失败"。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { scaledSize, thumbnailPathFor, upgradeThumbnail } from '../thumbnail.mjs';

function tmp(prefix = 'vc-thumb-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 用 ffmpeg 现造一张测试图；ffmpeg 不可用时返回 false，调用方跳过。
 *
 * 目标文件名**没有扩展名**（平台里的缩略图就是这样：`2026/11/18/<uuid>`），
 * 所以必须先写到一个带扩展名的临时文件再改名 —— 直接让 ffmpeg 写无扩展名路径会报
 * `Unable to choose an output format`（踩过）。
 */
function makeImage(file, size = '160x240', ffmpeg = 'ffmpeg') {
  const temp = `${file}.make.png`;
  try {
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=orange:s=${size}`, '-frames:v', '1', temp], { windowsHide: true });
    fs.renameSync(temp, file);
    return true;
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch { /* */ }
    return false;
  }
}

test('缩放按长边等比例，不拉伸也不放大', () => {
  // 竖图：长边是高
  assert.deepEqual(scaledSize(832, 1216, 1080), { width: 739, height: 1080, upscale: false });
  // 横图：长边是宽
  assert.deepEqual(scaledSize(1216, 832, 1080), { width: 1080, height: 739, upscale: false });
  // 需要放大吗？不需要 —— 小图保持原样，硬放大只会更糊更占空间。
  assert.deepEqual(scaledSize(64, 64, 1080), { width: 64, height: 64, upscale: false });
  // 恰好等于上限
  assert.deepEqual(scaledSize(1080, 1080, 1080), { width: 1080, height: 1080, upscale: false });
});

test('尺寸非法时返回 null，让调用方跳过缩放而不是算出一个 0', () => {
  assert.equal(scaledSize(0, 100, 1080), null);
  assert.equal(scaledSize(100, 0, 1080), null);
  assert.equal(scaledSize(100, 100, 0), null);
  assert.equal(scaledSize(undefined, undefined, 1080), null);
});

test('平台 path 映射到缩略图目录（镜像结构，不是同名同目录）', () => {
  assert.equal(
    thumbnailPathFor('D:/VC/upload', '2026/11/18/abc'),
    path.join('D:/VC/upload', 'thumbnail', '2026/11/18/abc'),
  );
  assert.equal(thumbnailPathFor('', '2026/11/18/abc'), null);
  assert.equal(thumbnailPathFor('D:/VC/upload', ''), null);
});

test('缩略图不存在时不动手：那是"客户端本来就用原图"的情况', async () => {
  const root = tmp();
  const original = path.join(root, 'original.png');
  assert.equal(makeImage(original), true, '需要 ffmpeg 造测试图');

  const result = await upgradeThumbnail({
    uploadRoot: root,
    platformPath: '2026/11/18/nope',
    originalPath: original,
    width: 160, height: 240,
  });
  // 关键：不是"创建了一张缩略图"，而是明确不做。
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-thumbnail');
  assert.equal(fs.existsSync(path.join(root, 'thumbnail', '2026/11/18/nope')), false);
});

test('原图缺失时也明确拒绝，而不是留下半个文件', async () => {
  const root = tmp();
  const thumb = path.join(root, 'thumbnail', '2026/11/18/abc');
  fs.mkdirSync(path.dirname(thumb), { recursive: true });
  fs.writeFileSync(thumb, 'stale');

  const result = await upgradeThumbnail({
    uploadRoot: root,
    platformPath: '2026/11/18/abc',
    originalPath: path.join(root, 'missing.png'),
    width: 100, height: 100,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'original-missing');
  // 旧缩略图原样留着：宁可糊，也不能让它变成"图片打不开"。
  assert.equal(fs.readFileSync(thumb, 'utf8'), 'stale');
});

test('升级成功后缩略图更大更清晰，且 .meta 的 MIME 跟着改', async () => {
  const root = tmp();
  const original = path.join(root, 'original.png');
  assert.equal(makeImage(original, '800x1200'), true, '需要 ffmpeg 造测试图');

  const platformPath = '2026/11/18/ok';
  const thumbDir = path.join(root, 'thumbnail', '2026/11/18');
  fs.mkdirSync(thumbDir, { recursive: true });
  const thumb = path.join(thumbDir, 'ok');
  // 模拟服务端：一张长边 480 的缩略图 + 写着 png 的 meta
  assert.equal(makeImage(thumb, '320x480'), true);
  fs.writeFileSync(`${thumb}.meta`, JSON.stringify({ content_type: 'image/png', filename: null }));
  const before = fs.statSync(thumb).size;

  const result = await upgradeThumbnail({
    uploadRoot: root,
    platformPath,
    originalPath: original,
    width: 800, height: 1200,
    longEdge: 1080,
    ffmpegPath: 'ffmpeg',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.mode, 'ffmpeg');
  assert.deepEqual(result.size, { width: 720, height: 1080, upscale: false });
  assert.equal(result.previousBytes, before);

  // 尺寸必须真的是 720×1080（读回来验，不信任参数）
  const out = path.join(thumbDir, 'ok.out.png');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', thumb, out], { windowsHide: true });
  const meta = fs.readFileSync(`${thumb}.meta`, 'utf8');
  assert.equal(JSON.parse(meta).content_type, 'image/jpeg', '换了 JPEG 字节就必须改 meta，否则头与字节不符');
  assert.ok(fs.statSync(thumb).size > before, '升级后的缩略图应当比原来大');
});

test('ffmpeg 不可用时退回用原图覆盖，并把 meta 改成原图的 MIME', async () => {
  const root = tmp();
  const original = path.join(root, 'original.png');
  assert.equal(makeImage(original, '400x600'), true, '需要 ffmpeg 造测试图');
  const platformPath = '2026/11/18/fallback';
  const thumbDir = path.join(root, 'thumbnail', '2026/11/18');
  fs.mkdirSync(thumbDir, { recursive: true });
  const thumb = path.join(thumbDir, 'fallback');
  assert.equal(makeImage(thumb, '320x480'), true);
  fs.writeFileSync(`${thumb}.meta`, JSON.stringify({ content_type: 'image/jpeg', filename: null }));

  const result = await upgradeThumbnail({
    uploadRoot: root,
    platformPath,
    originalPath: original,
    width: 400, height: 600,
    ffmpegPath: 'definitely-not-ffmpeg',
    timeoutMs: 5000,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.mode, 'copy-original');
  assert.deepEqual(fs.readFileSync(thumb), fs.readFileSync(original), '退路就是把原图搬过去');
  // 原图是 png，meta 必须从 jpeg 改回 png
  assert.equal(JSON.parse(fs.readFileSync(`${thumb}.meta`, 'utf8')).content_type, 'image/png');
});

test('认不出 MIME 的格式不会让缩略图变成二进制垃圾', async () => {
  const root = tmp();
  const original = path.join(root, 'original.tiff');
  fs.writeFileSync(original, Buffer.from([1, 2, 3, 4]));
  const thumbDir = path.join(root, 'thumbnail', '2026/11/18');
  fs.mkdirSync(thumbDir, { recursive: true });
  fs.writeFileSync(path.join(thumbDir, 'weird'), 'old');

  const result = await upgradeThumbnail({
    uploadRoot: root,
    platformPath: '2026/11/18/weird',
    originalPath: original,
    ffmpegPath: 'definitely-not-ffmpeg',
  });
  assert.equal(result.ok, false);
  // 尺寸都读不出来 → 无法证明换完更清楚，直接不动手。（这比"试了再失败"更安全：
  // 一次失败的 copy 会把原缩略图覆盖成一张打不开的文件。）
  assert.equal(result.reason, 'unknown-dimensions');
  assert.equal(fs.readFileSync(path.join(thumbDir, 'weird'), 'utf8'), 'old');
});

test('原图比现有缩略图还清晰度低时不换 —— 换完屏幕上反而更糊', async () => {
  const root = tmp();
  const original = path.join(root, 'small.png');
  // 原图 64×64，服务端把它放大成了 480×480 的缩略图（这是服务端真实行为）
  assert.equal(makeImage(original, '64x64'), true, '需要 ffmpeg 造测试图');
  const thumbDir = path.join(root, 'thumbnail', '2026/11/18');
  fs.mkdirSync(thumbDir, { recursive: true });
  const thumb = path.join(thumbDir, 'small');
  assert.equal(makeImage(thumb, '480x480'), true);
  const beforeBytes = fs.statSync(thumb).size;

  const result = await upgradeThumbnail({
    uploadRoot: root,
    platformPath: '2026/11/18/small',
    originalPath: original,
    width: 64, height: 64,
    longEdge: 1080,
  });
  // 关键：拒绝。照比例算目标是 64×64，那会把 480px 的缩略图换成 64px。
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-sharper');
  assert.deepEqual(result.current, { width: 480, height: 480 });
  assert.deepEqual(result.target, { width: 64, height: 64, upscale: false });
  assert.equal(fs.statSync(thumb).size, beforeBytes, '文件必须一个字节都没动');
});

test('readPixelSize 能认 PNG 与 JPEG 两种', async () => {
  const root = tmp();
  const png = path.join(root, 'a.png');
  const jpg = path.join(root, 'b.jpg');
  assert.equal(makeImage(png, '120x80'), true, '需要 ffmpeg 造测试图');
  assert.equal(makeImage(jpg, '90x60'), true);
  const { readPixelSize } = await import('../thumbnail.mjs');
  assert.deepEqual(readPixelSize(png), { width: 120, height: 80 });
  assert.deepEqual(readPixelSize(jpg), { width: 90, height: 60 });
  assert.equal(readPixelSize(path.join(root, 'missing.png')), null);
});
