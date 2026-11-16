// 陪伴空间 · 客户端 FIELDS 的源码投影（服务端与核对脚本共用）。
//
// 为什么服务端要读客户端源码：`src/client/pages-settings.js` 的 `FIELDS` 是渲染元数据
// （label / control / hint / 范围 / 选项）的**唯一所有者**，而它只存在于浏览器片段里
// （片段是纯脚本，没有 export）。目录要给搜索提供 label 与关键词，就必须读它。
//
// 这里不是「第四份字段目录」：它读的是那一份，只读不写，也不复制任何校验规则。
// 客户端片段改动后，目录与搜索会自动跟上——这正是 W1「避免手工维护第二份字段目录」
// 的要求。解析失败一律返回 `{}`，目录退化成「只有路径、没有 label」，不会崩。

import fs from 'node:fs';
import path from 'node:path';

/** 从 `const X = { ... }` 里抽出顶层 `key: <单行文本>`。 */
export function objectEntries(text, openPattern) {
  const start = text.search(openPattern);
  if (start < 0) return null;
  const brace = text.indexOf('{', start);
  if (brace < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = brace; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;
  const body = text.slice(brace + 1, end);
  const entries = [];
  let d = 0;
  let line = '';
  const flush = () => {
    const match = /^\s*([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/.exec(line);
    if (match && d === 0) entries.push({ key: match[1], text: line.trim() });
    line = '';
  };
  for (const ch of body.split('')) {
    line += ch;
    if (ch === '{') d += 1;
    else if (ch === '}') d -= 1;
    else if (ch === '\n' && d === 0) flush();
  }
  flush();
  return entries;
}

/** 从 `export function editableView() { return { ... } }` 抽出 key → 表达式文本。 */
export function editableEntries(text) {
  const start = text.search(/export function editableView\s*\(/);
  if (start < 0) return null;
  const ret = text.indexOf('return {', start);
  if (ret < 0) return null;
  const brace = text.indexOf('{', ret);
  let depth = 0;
  let end = -1;
  for (let i = brace; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;
  // 取整行：`key: 表达式,`。表达式里可能含逗号（如 `numberOr(config.x, 6)`），
  // 所以不能按逗号截断——按行尾截断才对。
  return [...text.slice(brace + 1, end).matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*([^\n]*)$/gm)]
    .map((m) => ({ key: m[1], expr: m[2].trim().replace(/,$/, '') }));
}

const STRING = (raw, name) => {
  const match = new RegExp(`\\b${name}\\s*:\\s*'([^']*)'`).exec(raw)
    ?? new RegExp(`\\b${name}\\s*:\\s*"([^"]*)"`).exec(raw);
  return match ? match[1] : null;
};
const NUMBER = (raw, name) => {
  const match = new RegExp(`\\b${name}\\s*:\\s*([-+0-9.]+)`).exec(raw);
  return match ? Number(match[1]) : null;
};

/**
 * 解析 `pages-settings.js` 的 `FIELDS`，返回 `{ [key]: {section, label, control, path, hint, min, max} }`。
 *
 * 只取目录与渲染需要的字段；`options` 之类结构化值留空（搜索不靠它）。
 */
export function parseClientFields(text) {
  const entries = objectEntries(text, /const FIELDS\s*=\s*\{/);
  if (!entries) return {};
  const out = {};
  for (const entry of entries) {
    out[entry.key] = {
      section: STRING(entry.text, 'section'),
      label: STRING(entry.text, 'label'),
      control: STRING(entry.text, 'control'),
      path: STRING(entry.text, 'path'),
      hint: STRING(entry.text, 'hint') ?? '',
      min: NUMBER(entry.text, 'min'),
      max: NUMBER(entry.text, 'max'),
    };
  }
  return out;
}

/** 解析 `SECRET_LABELS`（只写字段的中文名）。
 *
 * 这一份常被写成**单行对象**（`{ a: '…', b: '…' }`），按行解析会漏掉第二个键，
 * 所以直接按 `键: '值'` 对扫描整个对象字面量。 */
export function parseSecretLabels(text) {
  const start = text.search(/const SECRET_LABELS\s*=\s*\{/);
  if (start < 0) return {};
  const brace = text.indexOf('{', start);
  const close = text.indexOf('}', brace);
  if (brace < 0 || close < 0) return {};
  const body = text.slice(brace + 1, close);
  const out = {};
  for (const match of body.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*'([^']*)'/g)) out[match[1]] = match[2];
  return out;
}

/**
 * 读包内的 `src/client/pages-settings.js`。`packageRoot` 是本插件目录。
 * 任何失败都回空对象（目录会退化成「只有路径」，搜索仍可用）。
 */
export function readClientFields(packageRoot) {
  try {
    const file = path.join(packageRoot, 'src', 'client', 'pages-settings.js');
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    return { fields: parseClientFields(text), secretLabels: parseSecretLabels(text) };
  } catch {
    return { fields: {}, secretLabels: {} };
  }
}
