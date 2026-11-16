#!/usr/bin/env node
/**
 * W1 前置：把 Studio（陪伴空间）三份手工设置的字段目录收编成**一份**。
 *
 * 现状（G0 实测，见 docs/25-g0-studio-inventory-20261116.md §4.2）：同一批 21 个可写键
 * 存在三处互相对齐的副本——
 *   1. `lib/write.mjs` 的 `SETTINGS_SPEC`（权威校验规则：section/key/check）
 *   2. `lib/read.mjs` 的 `editableView()`（21 键的归一化默认值）
 *   3. `src/client/pages-settings.js` 的 `FIELDS`（渲染元数据：label/control/hint/范围/选项）
 * 注释里靠一句「一一对应」人工保证，没有任何机制阻止它们漂移。
 *
 * 这个脚本做的事：以 `SETTINGS_SPEC` 为权威，把另外两处**从源码里读出来**做三方差分，
 * 发现问题就非零退出。它不是新的第四份目录，而是一份**可执行的核对**——目录的唯一真相
 * 仍然是源码里的那三处，只是「一致」这件事从注释变成了断言。
 *
 * 用法：
 *   node plugins/companion-memory-studio/scripts/check-settings-catalog.mjs
 *   node plugins/companion-memory-studio/scripts/check-settings-catalog.mjs --json
 *
 * 退出码：0 = 三份一致；1 = 有漂移（列出每个不一致键与原因）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { objectEntries, editableEntries, parseSecretLabels } from '../lib/client-fields.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = path.join(ROOT, 'lib', 'write.mjs');
const READ = path.join(ROOT, 'lib', 'read.mjs');
const CLIENT = path.join(ROOT, 'src', 'client', 'pages-settings.js');

const readText = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

const problems = [];
const note = (kind, key, detail) => problems.push({ kind, key, detail });

const writeText = readText(WRITE);
const readTextSrc = readText(READ);
const clientText = readText(CLIENT);

const spec = objectEntries(writeText, /const SETTINGS_SPEC\s*=\s*Object\.freeze\(/);
const secret = objectEntries(writeText, /const SECRET_SPEC\s*=\s*Object\.freeze\(/);
const view = editableEntries(readTextSrc);
const fields = objectEntries(clientText, /const FIELDS\s*=\s*\{/);
const secretLabels = parseSecretLabels(clientText);

if (!spec) problems.push({ kind: 'fatal', key: 'SETTINGS_SPEC', detail: `找不到 ${path.relative(ROOT, WRITE)} 里的 SETTINGS_SPEC` });
if (!secret) problems.push({ kind: 'fatal', key: 'SECRET_SPEC', detail: `找不到 ${path.relative(ROOT, WRITE)} 里的 SECRET_SPEC` });
if (!view) problems.push({ kind: 'fatal', key: 'editableView', detail: `找不到 ${path.relative(ROOT, READ)} 里的 editableView()` });
if (!fields) problems.push({ kind: 'fatal', key: 'FIELDS', detail: `找不到 ${path.relative(ROOT, CLIENT)} 里的 FIELDS` });

if (spec && view && fields && secret) {
  const specKeys = spec.map((e) => e.key);
  const viewKeys = view.map((e) => e.key);
  const fieldKeys = fields.map((e) => e.key);
  const secretKeys = secret.map((e) => e.key);

  // 1) 三份可写键集合必须完全相同（这是计划 W1「同一字段只出现一个主要写表单」的机器判据）。
  const union = new Set([...specKeys, ...viewKeys, ...fieldKeys]);
  for (const key of union) {
    if (!specKeys.includes(key)) note('missing-in-write', key, 'write.mjs SETTINGS_SPEC 里没有这个键');
    if (!viewKeys.includes(key)) note('missing-in-read', key, 'read.mjs editableView() 没有返回这个键');
    if (!fieldKeys.includes(key)) note('missing-in-client', key, 'pages-settings.js FIELDS 里没有这个键');
  }

  // 2) 重复键（同一份目录里写两遍，后者会静默覆盖前者）。
  for (const [name, keys] of [['SETTINGS_SPEC', specKeys], ['editableView', viewKeys], ['FIELDS', fieldKeys], ['SECRET_SPEC', secretKeys]]) {
    const seen = new Set();
    for (const key of keys) {
      if (seen.has(key)) note('duplicate-key', key, `${name} 里出现多次`);
      seen.add(key);
    }
  }

  // 3) 只写密钥不能出现在任何可读目录里（GET 永不返回明文）。
  for (const key of secretKeys) {
    if (specKeys.includes(key)) note('secret-in-spec', key, '只写密钥不该出现在 SETTINGS_SPEC');
    if (fieldKeys.includes(key)) note('secret-in-client', key, '只写密钥不该出现在客户端 FIELDS（会被渲染成可回填控件）');
    if (viewKeys.includes(key)) note('secret-in-view', key, '只写密钥不该出现在 editableView（读投影会带出明文）');
  }

  // 3b) 每个只写密钥都要有中文名（SECRET_SPEC ⊆ SECRET_LABELS）。
//
// 缺 label 的只写密钥在界面上无法命名（"清除…？"对话框、校验错误都会读到
// `undefined`）。这一条不判就永远发现不了：只写密钥不参与三方差分（它本来
// 就不该出现在那三份可读目录里），所以它是**唯一**一条只写密钥自己的规则。
for (const key of secretKeys) {
  if (!Object.hasOwn(secretLabels, key)) {
    note('secret-missing-label', key, 'SECRET_SPEC 里的密钥在 SECRET_LABELS 里没有中文名');
  }
}
for (const key of Object.keys(secretLabels)) {
  if (!secretKeys.includes(key)) {
    note('label-missing-secret', key, 'SECRET_LABELS 里有名字，但 SECRET_SPEC 里没有这个只写密钥');
  }
}

// 4) 客户端每条必须有渲染所需的 label / control / path。
  for (const entry of fields) {
    for (const required of ['label', 'control', 'path']) {
      if (!new RegExp(`\\b${required}\\s*:`).test(entry.text)) note('client-missing-meta', entry.key, `FIELDS.${entry.key} 缺 ${required}`);
    }
  }

  // 5) 服务端每条必须有 section + key（backend 例外：它写在配置根部）+ check。
  for (const entry of spec) {
    if (entry.key === 'backend') {
      if (!/\bkey\s*:\s*'backend'/.test(entry.text)) note('spec-shape', entry.key, 'backend 的 key 应为 root 级 backend');
      continue;
    }
    if (!/\bsection\s*:/.test(entry.text) || !/\bkey\s*:/.test(entry.text)) note('spec-shape', entry.key, `SETTINGS_SPEC.${entry.key} 缺 section 或 key`);
    // `check` 必须存在，而且**不能是恒真的空校验**。
  //
  // 只判"有没有 check:" 等于放行 `check: () => true` —— 那和没有校验完全等价，
  // 却会让核对打印「✓ 三份一致」（审查实测：把 check 换成 () => true，脚本仍 exit 0）。
  if (!/\bcheck\s*:/.test(entry.text)) {
    note('spec-shape', entry.key, `SETTINGS_SPEC.${entry.key} 缺 check（没有校验就等于没有约束）`);
  } else if (/check\s*:\s*\(?\)?\s*=>\s*(true|!0)\b/.test(entry.text) || /check\s*:\s*function\s*\(?\)?\s*\{\s*return\s+true/.test(entry.text)) {
    note('spec-shape', entry.key, `SETTINGS_SPEC.${entry.key} 的 check 恒真（等于没有校验）`);
  }
  }

  // 6) 客户端 path 与服务端 {section,key} 拼出来的路径必须一致
  //    （两套写法：客户端点路径 vs 服务端 section+key；这条断言把两者钉在一起）。
  const specPathsByKey = new Map();
  for (const entry of spec) {
    const section = /\bsection\s*:\s*(null|'([^']*)')/.exec(entry.text);
    const key = /\bkey\s*:\s*'([^']*)'/.exec(entry.text);
    if (!key) continue;
    const sectionName = section ? section[2] ?? null : null;
    specPathsByKey.set(entry.key, sectionName ? `${sectionName}.${key[1]}` : key[1]);
  }
  for (const entry of fields) {
    const clientPath = /\bpath\s*:\s*'([^']*)'/.exec(entry.text);
    if (!clientPath) continue;
    const serverPath = specPathsByKey.get(entry.key);
    if (serverPath === undefined) continue; // 已由 missing-in-write 报告
    if (serverPath !== clientPath[1]) {
      note('path-mismatch', entry.key, `客户端 path '${clientPath[1]}' ≠ 服务端 ${serverPath}`);
    }
  }

  const summary = {
    ok: problems.length === 0,
    counts: {
      writeSpec: specKeys.length,
      readView: viewKeys.length,
      clientFields: fieldKeys.length,
      writeOnlySecrets: secretKeys.length,
    },
    keys: { writeSpec: specKeys, readView: viewKeys, clientFields: fieldKeys, secrets: secretKeys },
    problems,
  };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('陪伴空间 · 设置字段目录核对');
    console.log(`  write.mjs  SETTINGS_SPEC  ${specKeys.length} 键`);
    console.log(`  read.mjs   editableView   ${viewKeys.length} 键`);
    console.log(`  client     FIELDS         ${fieldKeys.length} 键`);
    console.log(`  write.mjs  SECRET_SPEC    ${secretKeys.length} 键（只写）`);
    if (problems.length === 0) {
      console.log('\n✓ 三份一致（含 path 拼接），且只写密钥未泄漏到任何可读目录。');
    } else {
      console.log(`\n✗ 发现 ${problems.length} 处漂移：`);
      for (const p of problems) console.log(`  · [${p.kind}] ${p.key} — ${p.detail}`);
    }
  }
  process.exitCode = problems.length === 0 ? 0 : 1;
} else {
  const summary = { ok: false, problems };
  if (process.argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log('陪伴空间 · 设置字段目录核对');
    for (const p of problems) console.log(`  ✗ [${p.kind}] ${p.key} — ${p.detail}`);
  }
  process.exitCode = 1;
}
