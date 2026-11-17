#!/usr/bin/env node
/**
 * 外部模块校验（部署期）。首席裁决 2026-11-14：`dsh-bili-scroll` 的版本号不足以证明装的是同一份代码。
 *
 * 实测事实：本机 profile 里的 `dsh-bili-scroll@2.4.0` 是 211655 字节（sha256
 * 784DFA67…），**不含** provider publish 代码；另有一份备份副本同版本号但是 213810 字节
 * （sha256 127D04BE…）、含 publish。两者 `package.json` 的 version 都是 `2.4.0`。
 * 因此"按版本号认为装对了"是错的。
 *
 * 这个脚本做三件事，只读、不联网、不改任何文件：
 *
 *   1. 对安装副本 `index.js` 算 SHA-256，与下面 `PINS` 里的**固定值**比对；
 *   2. 检查源码里是否真的存在 provider 注册表 publish 代码
 *      （`dsh.companion.bilibili.providers.v1` 的 `providers.set`）；
 *   3. 把结论打成具名 code：`ok` / `hash-mismatch` / `provider-publish-absent` / `file-missing`。
 *
 * 退出码：0 = 通过；1 = 不通过（部署/更新时应当拒绝并明确报告不可用）。
 *
 * 用法：
 *   node tools/verify-external-modules.mjs [--module-root <dir>] [--json]
 * 默认模块根：<dataDir>/home/profiles/companion/node_modules（可用环境变量覆盖）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SUITE_ROOT = path.resolve(here, '..');

/**
 * 固定的外部模块指纹。
 *
 * `indexSha256` 是**验收过的那一份**的 SHA-256（含 provider publish 代码、`available()` 会
 * 真的就绪）。换版本或换 tarball 时必须同时更新这里，否则校验不通过 —— 这正是本脚本的目的：
 * 让"同版本号、不同字节"无法悄悄装进来。
 *
 * 注意：`expectedBytes` 只作为人类可读的辅助信息，判据是 sha256。
 */
export const PINS = Object.freeze({
  'dsh-bili-scroll': Object.freeze({
    version: '2.4.0',
    indexSha256: '127d04be2fc842cb35daad207114993e06e5da5f4218e12d3799a023e52c6114',
    expectedBytes: 213810,
    requiresProviderPublish: true,
  }),
});

const PUBLISH_MARKERS = Object.freeze([
  'dsh.companion.bilibili.providers.v1',
  'providers.set(',
]);

function textOf(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
}

function argOf(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? textOf(argv[index + 1]) : '';
}

/** 默认模块根：数据根下的 companion profile。与 runtime 的 `dshHome` 同一条规则。 */
function defaultModuleRoot() {
  const dataDir = process.env.DSH_COMPANION_DATA_DIR
    || path.join(SUITE_ROOT, 'data');
  return path.join(dataDir, 'home', 'profiles', 'companion', 'node_modules');
}

function sha256OfFile(file) {
  const bytes = fs.readFileSync(file);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * SHA-256 comparison that ignores hex case.
 *
 * The computed digest is lower-case (`digest('hex')`) but a pin may be written upper-case — the
 * documented pin in `docs/03-modules-support-matrix.md` is `127D04BE…`. Comparing raw strings
 * would then reject the *correct* bytes, and the operator would "fix" it by replacing the module
 * with the one actually on disk. Hex is case-insensitive by definition, so compare it that way.
 */
function sameSha256(left, right) {
  return textOf(left).trim().toLowerCase() === textOf(right).trim().toLowerCase();
}

/**
 * @param {{moduleRoot: string, name?: string, pins?: object}} options
 *   `pins` exists so the two gates can be tested independently: gate 1 (hash) and gate 2
 *   (provider publish markers) must each be provable, and forging a sha256 for the real pin is
 *   not something a test should have to do.
 */
export function verifyModule({ moduleRoot, name = 'dsh-bili-scroll', pins = PINS } = {}) {
  const pin = pins[name];
  if (!pin) return { ok: false, code: 'no-pin', name, note: '这个模块没有固定指纹，不能校验' };
  const directory = path.join(moduleRoot, name);
  const entry = path.join(directory, 'index.js');
  if (!fs.existsSync(entry)) {
    return {
      ok: false, code: 'file-missing', name, directory, entry,
      note: '安装副本不存在：provider 永远不会就绪，B站活动必须被拒绝派发',
    };
  }
  let bytes = 0;
  let sha256 = '';
  let source = '';
  try {
    bytes = fs.statSync(entry).size;
    sha256 = sha256OfFile(entry);
    source = fs.readFileSync(entry, 'utf8');
  } catch (error) {
    return { ok: false, code: 'read-failed', name, entry, reason: textOf(error?.message).slice(0, 160) };
  }
  const missingMarkers = pin.requiresProviderPublish
    ? PUBLISH_MARKERS.filter(marker => !source.includes(marker))
    : [];
  const base = {
    name, directory, entry, bytes, sha256, pinnedSha256: pin.indexSha256,
    version: (() => { try { return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version ?? ''; } catch { return ''; } })(),
    bytesMatch: bytes === pin.expectedBytes,
  };
  if (!sameSha256(sha256, pin.indexSha256)) {
    return {
      ok: false, code: 'hash-mismatch', ...base,
      note: '安装副本与验收过的 tarball 不是同一份字节：同版本号不等于同一份代码',
      missingMarkers,
    };
  }
  if (missingMarkers.length) {
    return {
      ok: false, code: 'provider-publish-absent', ...base,
      note: `源码里没有 provider 注册表 publish 代码（缺 ${missingMarkers.join(' / ')}）：provider 永远不会 ready`,
      missingMarkers,
    };
  }
  return { ok: true, code: 'ok', ...base, missingMarkers: [] };
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const moduleRoot = argOf(argv, '--module-root') || defaultModuleRoot();
  const results = Object.keys(PINS).map(name => verifyModule({ moduleRoot, name }));
  const ok = results.every(result => result.ok === true);
  const report = {
    generatedAt: new Date().toISOString(),
    moduleRoot,
    host: os.platform(),
    readOnly: true,
    ok,
    modules: results,
    ruling: ok
      ? '全部通过：可以派发依赖这些模块的活动'
      : '不通过：安装或更新时应拒绝，并明确报告该能力不可用（不要让 planner 照常派活）',
  };
  if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    const lines = [`=== 外部模块校验（只读）===`, `模块根：${moduleRoot}`];
    for (const result of results) {
      lines.push(`${result.ok ? '通过' : '不通过'}  ${result.name}  code=${result.code}`);
      if (result.bytes) lines.push(`        bytes=${result.bytes} sha256=${String(result.sha256).slice(0, 16)}… pinned=${String(result.pinnedSha256).slice(0, 16)}…`);
      if (result.note) lines.push(`        ${result.note}`);
    }
    lines.push(report.ruling);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  if (!ok) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();

export default { PINS, verifyModule };
