#!/usr/bin/env node
/**
 * Sanitized acceptance record for the host-injection run (part ②).
 *
 * Reads the raw captures on disk and writes two files under `--out`:
 *   - `capture.json` — machine-readable: every case with its full System Prompt,
 *     injected snapshot, tool results and Token estimates;
 *   - `capture.txt`  — the same content as a reading report.
 *
 * Paths, the host launch token, and session ids are replaced with placeholders, so the
 * record can be shared without leaking this machine's layout.
 *
 * Usage: node scripts/wardrobe-host-record.mjs --src <captureDir> --out <outDir>
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const suiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.resolve(argOf('src', path.join(suiteRoot, 'data-dev/logs/wardrobe-host-acceptance')));
const outDir = path.resolve(argOf('out', path.join(src, 'record')));

// Redaction patterns rebuilt from the host's own paths, so this file never spells one out.
// The DSH install root is derived from `DSH_COMPANION_MODULE_ROOT` (set by the suite launcher)
// rather than hardcoded, and the operator home comes from `os.homedir()`.
const hostInstallRoot = (() => {
  const moduleRoot = String(process.env.DSH_COMPANION_MODULE_ROOT ?? '').trim();
  if (!moduleRoot) return '';
  // `<install>/resources/app/dsh/node_modules` -> `<install>`
  const marker = path.join('resources', 'app', 'dsh');
  const at = moduleRoot.indexOf(marker);
  return at > 0 ? moduleRoot.slice(0, at - 1) : '';
})();
const operatorHome = os.homedir();

const PLACEHOLDERS = [
  [suiteRoot, '<dev-clone>'],
  [suiteRoot.replaceAll('\\', '/'), '<dev-clone>'],
  ...(hostInstallRoot ? [[hostInstallRoot, '<dsh-install>'], [hostInstallRoot.replaceAll('\\', '/'), '<dsh-install>']] : []),
  ...(operatorHome ? [[operatorHome, '<home>'], [operatorHome.replaceAll('\\', '/'), '<home>']] : []),
];

const scrub = (value) => {
  let text = String(value);
  for (const [from, to] of PLACEHOLDERS) text = text.split(from).join(to);
  return text
    .replace(/token=[A-Za-z0-9_-]{20,}/g, 'token=<redacted>')
    .replace(/session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'session-<uuid>');
};

/** Rough Token estimate: CJK ≈ 1 token/char, ASCII ≈ 1 token/4 chars. */
const estimateTokens = (text) => {
  let cjk = 0;
  let ascii = 0;
  for (const char of String(text)) {
    if (char.codePointAt(0) > 0x2e7f) cjk += 1;
    else ascii += 1;
  }
  return Math.round(cjk + ascii / 4);
};

const SNAPSHOT_MARKER = '【当前穿着】\n场景';
const RULE_MARKER = '【穿着规则】';
const GARMENT_PATTERN = /白色|蓝色|粉色|灰色|睡衣|卫衣|长裤|运动鞋/;

const cases = [
  { dir: '14-00', label: '14:00 (daytime)' },
  { dir: '22-40', label: '22:40 (night window)' },
  { dir: 'no-identity-dryrun', label: '22:40, visual identity removed (dryRun)' },
  // The wardrobe-tool turn at 14:00 was captured in a separate run; it carries both the
  // injected snapshot and the `companion_wardrobe_detail` result, which is what point 5 of the
  // acceptance compares.
  { file: 'tool-wardrobe-1400.json', label: '14:00, wardrobe tool queried' },
];

const entries = [];
for (const item of cases) {
  const file = item.file ? path.join(src, item.file) : path.join(src, item.dir, 'model-request.json');
  const label = item.label;
  if (!fs.existsSync(file)) {
    console.log(`skip (missing): ${label}`);
    continue;
  }
  const raw = fs.readFileSync(file, 'utf8');
  const record = JSON.parse(raw);
  const body = JSON.parse(record.body);

  const systemText = typeof body.messages[0]?.content === 'string' ? body.messages[0].content : '';
  let snapshot = '';
  const toolResults = [];
  for (const message of body.messages) {
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    const at = text.indexOf(SNAPSHOT_MARKER);
    if (at >= 0) snapshot = text.slice(at);
    if (message.role === 'tool') toolResults.push(text);
  }
  const ruleAt = systemText.indexOf(RULE_MARKER);
  const staticRule = ruleAt < 0 ? '' : systemText.slice(ruleAt).split('\n\n')[0];

  entries.push({
    label,
    source: item.file ?? `${item.dir}/model-request.json`,
    sourceSha256: crypto.createHash('sha256').update(raw).digest('hex'),
    model: body.model,
    stream: body.stream,
    toolCount: (body.tools ?? []).length,
    messageRoles: body.messages.map(message => message.role),
    systemPrompt: scrub(systemText),
    systemPromptChars: systemText.length,
    systemPromptTokens: estimateTokens(systemText),
    staticWardrobeRule: scrub(staticRule),
    staticRuleChars: staticRule.length,
    staticRuleNamesGarments: GARMENT_PATTERN.test(staticRule),
    injectedSnapshot: scrub(snapshot),
    snapshotChars: snapshot.length,
    snapshotTokens: estimateTokens(snapshot),
    snapshotCount: [...body.messages].filter((message) => {
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      return text.includes(SNAPSHOT_MARKER);
    }).length,
    toolResults: toolResults.map(text => scrub(text)),
  });
  console.log(`${label}: system ${systemText.length} chars, snapshot ${snapshot.length} chars, tool results ${toolResults.length}`);
}

const record = {
  generatedAt: new Date().toISOString(),
  host: 'DeepSeek Harness 0.2.1-rc.3 (desktop), profile companion-dev, DSH_HOME=<dev-clone>/data-dev/home',
  patchLayers: [
    'config/profile/companion.patch.yml (the suite preset)',
    'acceptance-llm.patch.yml (local llm-pi-ai route -> 127.0.0.1:39217)',
    'acceptance-preset-fix.patch.yml (drops the preset duplicate `skill` row)',
  ],
  isolation: {
    bind: '127.0.0.1 only (--host 127.0.0.1)',
    llmRoute: 'http://127.0.0.1:39217/v1 (local recorder, synthetic completions)',
    imageRoute: 'http://127.0.0.1:39218 (local recorder that logs and answers 500)',
    qq: 'off',
    bilibili: 'off',
    health: 'off',
    expression: 'off',
    pasteSearch: 'off',
    billingApis: false,
  },
  cases: entries,
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'capture.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');

const lines = [
  '# 真实宿主注入验收记录（脱敏）',
  '',
  `生成时间：${record.generatedAt}`,
  `宿主：${record.host}`,
  '',
  '## 隔离条件',
  ...Object.entries(record.isolation).map(([key, value]) => `- ${key}: ${value}`),
  '- patch 层：',
  ...record.patchLayers.map(layer => `  - ${layer}`),
  '',
];

for (const entry of entries) {
  lines.push('='.repeat(78));
  lines.push(`## ${entry.label}`);
  lines.push('');
  lines.push(`- 来源：${entry.source}`);
  lines.push(`- 源文件 sha256：${entry.sourceSha256}`);
  lines.push(`- 模型路由：${entry.model}（stream=${entry.stream}）`);
  lines.push(`- 工具数：${entry.toolCount}`);
  lines.push(`- 消息角色序列：${entry.messageRoles.join(' → ')}`);
  lines.push(`- System Prompt：${entry.systemPromptChars} 字符，≈${entry.systemPromptTokens} tokens`);
  lines.push(`- 静态穿着规则段：${entry.staticRuleChars} 字符；点名衣物：${entry.staticRuleNamesGarments ? '是' : '否'}`);
  lines.push(`- 动态穿着快照：${entry.snapshotChars} 字符，≈${entry.snapshotTokens} tokens；出现次数：${entry.snapshotCount}`);
  lines.push('');
  lines.push('### 静态穿着规则（System Prompt 内）');
  lines.push('```');
  lines.push(entry.staticWardrobeRule);
  lines.push('```');
  lines.push('');
  lines.push('### 动态注入正文（agent/pre-step 快照）');
  lines.push('```');
  lines.push(entry.injectedSnapshot);
  lines.push('```');
  for (const [index, text] of entry.toolResults.entries()) {
    lines.push('');
    lines.push(`### 工具返回 #${index + 1}`);
    lines.push('```json');
    lines.push(text);
    lines.push('```');
  }
  lines.push('');
}

fs.writeFileSync(path.join(outDir, 'capture.txt'), `${lines.join('\n')}\n`, 'utf8');
console.log(`\nwrote ${outDir}/capture.json and capture.txt`);
