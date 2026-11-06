#!/usr/bin/env node
// 陪伴空间 · Web 半拼装器
//
// 按 design/studio/ARCHITECTURE.md §5.1 把 src/client/*.js 片段包进浏览器模块外壳，
// 生成 package 根目录的 client.js（提交物，勿手改）。
//
// 约定：
//   * 片段是「纯脚本」，不得出现 import / export / require / JSX；
//     每个页面片段是一个 IIFE：(function (P) { ... })(P);
//   * 拼装顺序固定：core.js → home → life → health → vault → wiki → timeline → review
//     → microscope → connections → workspace → settings → overview；
//   * 缺失片段跳过并在 stdout 报告；core.js 缺失则无法确定 apply，直接失败且不写文件；
//   * 语法校验一律用 `node --check`（与契约 §6 的验收命令一致）。
//
// 用法：
//   node scripts/build-client.mjs            生成 client.js 并校验
//   node scripts/build-client.mjs --check    只拼装 + 校验，不写文件
//   node scripts/build-client.mjs --help     打印帮助
//
// 退出码：0 成功；1 片段缺失或语法检查失败。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PACKAGE_NAME = '@dsh-companion/memory-studio';
const CLIENT_FILE = path.join(PACKAGE_ROOT, 'client.js');

/** 拼装顺序即契约 §5.1 的固定顺序。 */
const FRAGMENTS = [
  { file: 'src/client/core.js', label: '外壳：P 原语 + CSS + 导航 + 主题 + apply', required: true },
  { file: 'src/client/pages-operator.js', label: '运行库控制、后台日志与QQ网页' },
  { file: 'src/client/keyword-map.js', label: '关键词与反应的连线映射' },
  { file: 'src/client/pages-chat-settings.js', label: '聊天回复设置与全局重启提醒' },
  { file: 'src/client/pages-home.js', label: '陪伴首页' },
  { file: 'src/client/pages-life.js', label: '生活与日程' },
  { file: 'src/client/pages-health.js', label: '健康与睡眠（生活与日程的二级 tab）' },
  { file: 'src/client/pages-vault.js', label: '记忆库' },
  { file: 'src/client/pages-wiki.js', label: 'Wiki 档案' },
  { file: 'src/client/pages-timeline.js', label: '时间线' },
  { file: 'src/client/pages-review.js', label: '审核' },
  { file: 'src/client/pages-microscope.js', label: '召回显微镜（诊断）' },
  { file: 'src/client/pages-connections.js', label: '连接与工具' },
  { file: 'src/client/pages-media.js', label: '媒体能力设置（按 media descriptor 渲染）' },
  { file: 'src/client/pages-workspace.js', label: '工作区' },
  { file: 'src/client/pages-settings.js', label: '设置' },
  { file: 'src/client/pages-overview.js', label: '运行状态（诊断）' },
];

const HELP = `陪伴空间 · Web 半拼装器

用法：
  node scripts/build-client.mjs            生成 client.js 并用 node --check 校验
  node scripts/build-client.mjs --check    只拼装 + 校验，不写 client.js
  node scripts/build-client.mjs --help     显示本帮助

拼装顺序（固定）：
  src/client/core.js → pages-overview.js → pages-vault.js → pages-microscope.js
  → pages-wiki.js → pages-timeline.js → pages-review.js → pages-settings.js

片段缺失会被跳过并在输出里列出；core.js 缺失时无法确定 apply，本次不写文件并失败。
`;

function parseArgs(argv) {
  const options = { check: false, help: false };
  for (const argument of argv) {
    switch (argument) {
      case '--check': options.check = true; break;
      case '--help':
      case '-h': options.help = true; break;
      default: throw new Error(`未知参数：${argument}`);
    }
  }
  return options;
}

function readFragment(relativePath) {
  const absolute = path.join(PACKAGE_ROOT, relativePath);
  if (!fs.existsSync(absolute)) return { relativePath, exists: false, bytes: 0, text: '' };
  let text = fs.readFileSync(absolute, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n');
  if (!text.endsWith('\n')) text += '\n';
  return { relativePath, exists: true, bytes: Buffer.byteLength(text, 'utf8'), text };
}

/**
 * 片段必须是纯脚本。这里只做提示性检查：真正的语法判定交给 node --check。
 */
function fragmentWarnings(fragment) {
  const warnings = [];
  if (/(^|\n)\s*(?:import|export)\s/.test(fragment.text)) {
    warnings.push('包含 import/export，浏览器外壳只接受纯脚本片段');
  }
  if (/\brequire\s*\(/.test(fragment.text)) {
    warnings.push('直接调用了 require()，片段应只用 P 原语');
  }
  if (/=>\s*<[A-Za-z]/.test(fragment.text) || /\breturn\s*<[A-Za-z][\w.]*[\s/>]/.test(fragment.text)) {
    warnings.push('疑似包含 JSX，片段必须是纯 JS（用 P.h 创建元素）');
  }
  return warnings;
}

function compose(ready) {
  const body = ready
    .map(fragment => `// ==== ${fragment.relativePath} ====\n${fragment.text}`)
    .join('\n');
  return `// 本文件由 scripts/build-client.mjs 生成，请勿手改。
// package: ${PACKAGE_NAME}
// 片段顺序与契约 design/studio/ARCHITECTURE.md §5.1 一致；改动片段后请重新运行拼装。
// 生成的运行时只依赖浏览器模块表里的 react，不引入 CDN / UMD。
window.__ModuleLoader__.load({
  id: '${PACKAGE_NAME}',
  factory(require) {
    const React = require('react');

${body}
    return { inject: ['slots', 'locale'], apply };
  },
});
`;
}

function runNodeCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, status: result.status, output };
}

/** 用同目录下的 .js 临时文件做语法预检，保证与 `node --check client.js` 同解析模式。 */
function checkText(text) {
  const temporary = path.join(PACKAGE_ROOT, `.client-build-check-${process.pid}.js`);
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    return runNodeCheck(temporary);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* 已清理 */ }
  }
}

function writeAtomically(target, text) {
  const temporary = path.join(path.dirname(target), `.client-build-${process.pid}.js`);
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* 已重命名或已清理 */ }
  }
}

function formatCheck(result) {
  if (result.ok) return '通过';
  const message = result.output.split('\n').slice(0, 6).join(' | ');
  return `失败（node --check 退出码 ${result.status}）：${message}`;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const fragments = FRAGMENTS.map(spec => ({ ...spec, ...readFragment(spec.file) }));
  const workspace = fragments.filter(fragment => fragment.exists);
  const missing = fragments.filter(fragment => !fragment.exists);
  const core = fragments.find(fragment => fragment.required);

  const out = [];
  out.push('陪伴空间 · Web 半拼装');
  out.push(`  包名   ${PACKAGE_NAME}`);
  out.push(`  模式   ${options.check ? '只校验（--check，不写文件）' : '生成 client.js'}`);
  out.push(`  目录   ${PACKAGE_ROOT}`);
  out.push('  片段：');
  for (const fragment of fragments) {
    const mark = fragment.exists ? '✔' : '✘';
    const detail = fragment.exists ? `${String(fragment.bytes).padStart(6)} 字节` : '缺失，跳过';
    out.push(`    ${mark} ${fragment.file.padEnd(34)} ${detail}  ${fragment.label}`);
  }
  if (missing.length) {
    out.push(`  跳过 ${missing.length} 个缺失片段：${missing.map(fragment => path.basename(fragment.file)).join('、')}`);
  }

  const warnings = [];
  for (const fragment of workspace) {
    for (const warning of fragmentWarnings(fragment)) warnings.push(`${fragment.relativePath}：${warning}`);
  }
  if (core.exists) {
    // 片段可能被压成单行，所以这里不依赖行首，只判断是否存在 apply 绑定。
    const hasApplyBinding = /\bfunction\s+apply\s*\(/.test(core.text)
      || /\b(?:const|let|var)\s+apply\s*=/.test(core.text)
      || /\bP\.apply\s*=\s*apply\b/.test(core.text);
    if (!hasApplyBinding) {
      warnings.push(`${core.relativePath}：未找到 apply 的声明，外壳会返回 undefined（契约 §5.1 要求 core.js 末尾定义 apply）`);
    }
  }
  if (warnings.length) {
    out.push('  片段提示：');
    for (const warning of warnings) out.push(`    ! ${warning}`);
  }

  if (!core.exists) {
    out.push(`  失败   缺少核心片段 ${core.file}：无法确定 apply，本次不生成 client.js。`);
    out.push('  下一步 等 core.js 与页面片段就绪后重新运行：node scripts/build-client.mjs');
    process.stdout.write(`${out.join('\n')}\n`);
    return 1;
  }

  const assembled = compose(workspace);
  const bytes = Buffer.byteLength(assembled, 'utf8');
  out.push(`  生成   ${workspace.length} 个片段 → ${bytes} 字节`);

  const preview = checkText(assembled);
  if (!preview.ok) {
    out.push(`  失败   语法预检未通过：${formatCheck(preview)}`);
    out.push('  结果   未写出 client.js（请先修复片段语法）');
    process.stdout.write(`${out.join('\n')}\n`);
    return 1;
  }

  if (options.check) {
    out.push(`  校验   node --check（临时文件）：${formatCheck(preview)}`);
    out.push('  结果   --check 模式，未写入 client.js');
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  }

  writeAtomically(CLIENT_FILE, assembled);
  const finalCheck = runNodeCheck(CLIENT_FILE);
  out.push(`  输出   ${CLIENT_FILE}`);
  out.push(`  校验   node --check client.js：${formatCheck(finalCheck)}`);
  if (!finalCheck.ok) {
    out.push('  结果   已写入但语法检查失败，安装前必须修复。');
    process.stdout.write(`${out.join('\n')}\n`);
    return 1;
  }
  out.push('  结果   完成。安装后浏览器请求 /plugins/@dsh-companion/memory-studio/client.js 应返回 200。');
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`拼装失败：${error?.message ?? error}\n`);
  process.exitCode = 1;
}
