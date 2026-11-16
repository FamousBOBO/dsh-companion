// 陪伴空间 · 视觉与可访问性的离线验收脚本（W5）。
//
// 计划 W5 的验收不是"看着还行"，而是可断言的规则。这个脚本把每条都变成检查：
//
//   hardcoded-color              不许写死十六进制色（必须走 --dsw-alias-* / --cpx-* token）
//   undefined-token              用到的 --cpx-* 必须在某处真的定义（否则"token 化"是假话）
//   mouse-only-handler           可点元素必须有键盘路径
//   aria-hidden-subtree          不该有可聚焦/带 role 的节点藏在 aria-hidden 子树里
//   bare-outline-none            不许光秃秃地 outline:none（必须有替代焦点样式）
//   fixed-width-without-max      ≥240px 的固定宽度必须有 max-width
//   missing-focus-visible        只写 :focus 而不写 :focus-visible 的地方会被鼠标点击画出焦点框
//
// **判据按"单条规则块"而不是"整个 CSS 块"算。** 早期版本按整块判，于是
// `.a { width: 720px }` + `.b { max-width: 100% }` 被一起放行、`.a:focus { outline:none }` +
// `.b:focus-visible { outline: … }` 也被一起放行 —— 两处都是实测出来的盲区（M6）。
// 同理，行内 `style` 里的颜色也必须扫，不能只看 `P.css()` 的字面量。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(here, '..', 'src', 'client');

/** 允许的写死颜色：纯白/纯黑与透明（主题无关的通用基线）。 */
const ALLOWED_COLORS = new Set(['#fff', '#ffffff', '#000', '#000000', 'transparent', 'currentcolor', 'inherit']);

/** 需要本地定义的 token 前缀（`--dsw-alias-*` 由宿主提供，本地无法校验）。 */
const LOCALLY_DEFINED_PREFIX = '--cpx-';

export const RULES = Object.freeze([
  'hardcoded-color',
  'undefined-token',
  'mouse-only-handler',
  'aria-hidden-subtree',
  'bare-outline-none',
  'fixed-width-without-max',
  'missing-focus-visible',
]);

function collectFiles() {
  return fs.readdirSync(clientDir).filter((name) => name.endsWith('.js')).sort();
}

/** 抽出所有 CSS 文本块（`P.css(\`…\`)` 与 `css(\`…\`)`），带上行号。 */
export function cssBlocks(source) {
  const blocks = [];
  const pattern = /(?:P\.css|css)\(\s*`([\s\S]*?)`\s*\)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const before = source.slice(0, match.index);
    const startLine = before.split('\n').length;
    blocks.push({ text: match[1], startLine });
  }
  return blocks;
}

/**
 * 把一段 CSS 拆成**单条规则块**：`{ selector, body, startLine }`。
 *
 * 按 `}` 逐条切开，连同它前面的选择器一起成为一条。这样 `.a {…}` 与 `.b {…}` 各自
 * 独立判，一条规则的豁免不会传染给另一条。
 */
export function cssRules(blockText, startLine) {
  const rules = [];
  let selector = '';
  let body = '';
  let depth = 0;
  let line = startLine;
  let ruleStartLine = startLine;
  for (let index = 0; index < blockText.length; index += 1) {
    const ch = blockText[index];
    if (ch === '\n') line += 1;
    if (ch === '{') {
      if (depth === 0) {
        ruleStartLine = line;
        selector = selector.trim();
      }
      depth += 1;
      if (depth > 1) body += ch;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        rules.push({ selector, body, startLine: ruleStartLine });
        selector = '';
        body = '';
        continue;
      }
      body += ch;
      continue;
    }
    if (depth === 0) selector += ch;
    else body += ch;
  }
  return rules;
}

/** 摘掉 token 声明与 `var(--x, #fallback)` 的兜底值，剩下的十六进制才算"写死"。 */
function coloursOf(text) {
  const withoutDeclarations = text.replace(/(--[a-z0-9-]+)\s*:\s*#[0-9a-fA-F]{3,8}/gi, '$1: var(__v__)');
  const withoutFallbacks = withoutDeclarations.replace(/var\(\s*--[a-z0-9-]+\s*,\s*#[0-9a-fA-F]{3,8}\s*\)/gi, 'var(__token__)');
  return (withoutFallbacks.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((color) => !ALLOWED_COLORS.has(color.toLowerCase()));
}

/** 十六进制色检查：CSS 规则块 + 行内 `style` 对象都要扫。 */
export function findHardcodedColors(file, source) {
  const problems = [];
  for (const block of cssBlocks(source)) {
    for (const rule of cssRules(block.text, block.startLine)) {
      for (const color of coloursOf(rule.body)) {
        problems.push({
          rule: 'hardcoded-color',
          file,
          line: rule.startLine,
          detail: `写死的颜色 ${color}（${rule.selector.slice(0, 40)} 应改用 token）`,
        });
      }
    }
  }
  // 行内 style：`style: { color: '#ff0000' }` —— 早期版本完全看不见这一类。
  const inline = /style\s*:\s*\{([^}]*)\}/g;
  let match;
  while ((match = inline.exec(source)) !== null) {
    const line = source.slice(0, match.index).split('\n').length;
    for (const color of coloursOf(match[1])) {
      problems.push({ rule: 'hardcoded-color', file, line, detail: `行内样式里的写死颜色 ${color}` });
    }
  }
  return problems;
}

/** token 定义与使用：用到的本地 token 必须真的定义过。 */
export function findUndefinedTokens(file, source, defined) {
  const problems = [];
  const used = new Set();
  const pattern = new RegExp(`var\\(\\s*(${LOCALLY_DEFINED_PREFIX}[a-z0-9-]+)`, 'gi');
  let match;
  while ((match = pattern.exec(source)) !== null) used.add(match[1].toLowerCase());
  for (const token of used) {
    if (defined.has(token)) continue;
    const line = source.split('\n').findIndex((text) => text.includes(token)) + 1;
    problems.push({
      rule: 'undefined-token',
      file,
      line: line > 0 ? line : 1,
      detail: `${token} 用到却从未定义（带着十六进制兜底 = 换主题永远不生效）`,
    });
  }
  return problems;
}

/**
 * 从源码里抽出所有本地 token 定义（`--cpx-x: …`）。
 *
 * 跨文件收集：`core.js` 定义，别的片段使用 —— 所以定义集是全局的，不是单文件的。
 */
export function collectDefinedTokens(sources) {
  const defined = new Set();
  const pattern = new RegExp(`(${LOCALLY_DEFINED_PREFIX}[a-z0-9-]+)\\s*:`, 'gi');
  for (const source of sources) {
    let match;
    while ((match = pattern.exec(source)) !== null) defined.add(match[1].toLowerCase());
  }
  return defined;
}

/**
 * 从 `h('div', { … })` 里取 props 原文。
 *
 * 旧版用 `[^}]*`，遇到 `style: { … }` 这种嵌套对象就整体匹配不到（实测盲区）。
 * 这里用花括号配平来取"整段 props"。
 */
function propsAt(source, openBraceIndex) {
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex + 1, index);
    }
  }
  return '';
}

/** 只挂 mouse 事件的可点元素。 */
export function findMouseOnlyHandlers(file, source) {
  const problems = [];
  const head = /h\(\s*'(div|span|li|td|tr)'\s*,\s*\{/g;
  let match;
  while ((match = head.exec(source)) !== null) {
    const tag = match[1];
    const props = propsAt(source, match.index + match[0].length - 1);
    if (!/onClick/.test(props)) continue;
    if (/onKeyDown|onKeyUp|onKeyPress/.test(props)) continue;
    // 纯装饰的点击关闭：`aria-hidden="true"` 或 `*backdrop*`（键盘路径由容器的 Esc 承担）。
    // 例外只对**没有 role** 的装饰层成立：带 role 的节点即使 aria-hidden，也说明作者
    // 本意是可交互的，放行它就是在放过真缺陷。
    const decorative = /'?aria-hidden'?\s*:\s*'?true'?/.test(props) || /backdrop/i.test(props);
    const hasRole = /role\s*:\s*'/i.test(props);
    if (decorative && !hasRole) continue;
    const line = source.slice(0, match.index).split('\n').length;
    problems.push({
      rule: 'mouse-only-handler',
      file,
      line,
      detail: `<${tag}> 带 onClick 却没有键盘处理${hasRole ? '（有 role 但仍需 Enter/Space）' : '，也没有 role'}`,
    });
  }
  return problems;
}

/**
 * `aria-hidden="true"` 子树里不许有可聚焦/带 role 的节点。
 *
 * 这是 H4 的回归点：面板（`role="dialog"`）曾经整个挂在 `aria-hidden` 的遮罩下面，
 * 按 ARIA 它被移出无障碍树，屏幕阅读器看不到 —— 而"遮罩可以 aria-hidden"这条
 * 白名单恰好把它放行了。所以白名单必须由**这条新规则**兜底。
 */
export function findAriaHiddenSubtree(file, source) {
  const problems = [];
  const head = /h\(\s*'(div|span|section)'\s*,\s*\{/g;
  let match;
  while ((match = head.exec(source)) !== null) {
    const props = propsAt(source, match.index + match[0].length - 1);
    if (!/'?aria-hidden'?\s*:\s*'?true'?/.test(props)) continue;
    // 该节点的子树：props 之后到它自己的 `h(...)` 调用闭括号为止。这里用宽松但有界的
    // 窗口（4000 字符）判断，命中 role/focusable 就报 —— 误报宁可人工复核，也不放过 H4。
    const openCall = source.indexOf('(', source.indexOf('h(', match.index));
    let closeIndex = openCall;
    let depth = 0;
    for (let index = openCall; index < source.length; index += 1) {
      const ch = source[index];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) { closeIndex = index; break; }
      }
    }
    const subtree = source.slice(openCall, closeIndex);
    const roleHit = subtree.match(/role\s*:\s*'(dialog|listbox|option|button|menu|tab|textbox|switch|checkbox)'/i);
    const focusHit = /tabIndex\s*:\s*-?\d|'aria-modal'|ref\s*:\s*inputRef|autofocus/i.test(subtree);
    if (roleHit || focusHit) {
      const line = source.slice(0, match.index).split('\n').length;
      problems.push({
        rule: 'aria-hidden-subtree',
        file,
        line,
        detail: `${roleHit ? `子树里有 role="${roleHit[1]}"` : '子树里有可聚焦节点'}（aria-hidden 会把它们移出无障碍树）`,
      });
    }
  }
  return problems;
}

/** 裸的 outline:none —— 必须由**同一个选择器**的 :focus-visible 规则补上焦点环。 */
export function findBareOutlineNone(file, source) {
  const problems = [];
  for (const block of cssBlocks(source)) {
    const rules = cssRules(block.text, block.startLine);
    /** 这个选择器（去掉 :focus 伪类）是否另有 :focus-visible 版本给了可见环。 */
    const hasFocusVisibleTwin = (selector) => {
      const base = selector.replace(/:focus\b(?!-visible)/, '').trim();
      return rules.some((other) => {
        if (!other.selector.includes(':focus-visible')) return false;
        if (other.selector.replace(':focus-visible', '').trim() !== base) return false;
        return /outline\s*:\s*2px|box-shadow\s*:\s*0 0 0|outline-offset/.test(other.body);
      });
    };
    for (const rule of rules) {
      if (!/outline\s*:\s*(none|0)\b/.test(rule.body)) continue;
      // 同一条规则里带替代，或同一选择器另有 :focus-visible 规则 —— 都算有替代。
      // 不同选择器的替代**不算**（那正是审查报告里的盲区：一条规则的豁免传染给另一条）。
      const inSameRule = /box-shadow\s*:\s*0 0 0|outline\s*:\s*2px|outline-offset/.test(rule.body);
      if (inSameRule || hasFocusVisibleTwin(rule.selector)) continue;
      problems.push({
        rule: 'bare-outline-none',
        file,
        line: rule.startLine,
        detail: `${rule.selector.slice(0, 40)} 去掉 outline 却没有给替代焦点样式`,
      });
    }
  }
  return problems;
}

/** 固定的三位数宽度（≥240px）必须配 max-width —— 按**同一条规则**判。 */
export function findFixedWidths(file, source) {
  const problems = [];
  for (const block of cssBlocks(source)) {
    for (const rule of cssRules(block.text, block.startLine)) {
      const matches = rule.body.match(/\b(width|min-width)\s*:\s*(\d{3,})px/g) || [];
      if (!matches.length) continue;
      if (/max-width/.test(rule.body)) continue;
      for (const decl of matches) {
        const value = Number(decl.match(/(\d{3,})px/)[1]);
        if (value < 240) continue;
        problems.push({
          rule: 'fixed-width-without-max',
          file,
          line: rule.startLine,
          detail: `${decl} 没有配套的 max-width（窗口变窄会横向溢出）`,
        });
      }
    }
  }
  return problems;
}

/** 只写 :focus 而不写 :focus-visible 的规则块。 */
export function findFocusStyleGaps(file, source) {
  const problems = [];
  for (const block of cssBlocks(source)) {
    for (const rule of cssRules(block.text, block.startLine)) {
      if (!/:focus\b(?!-visible)/.test(rule.selector)) continue;
      if (!/outline/.test(rule.body)) continue;
      problems.push({
        rule: 'missing-focus-visible',
        file,
        line: rule.startLine,
        detail: `${rule.selector.slice(0, 40)} 只有 :focus 没有 :focus-visible（鼠标点击也会画出焦点框）`,
      });
    }
  }
  return problems;
}

/** 跑全部规则（token 定义集是跨文件的，所以先收集再判）。 */
export function auditClient() {
  const files = collectFiles();
  const sources = new Map(files.map((file) => [file, fs.readFileSync(path.join(clientDir, file), 'utf8')]));
  const defined = collectDefinedTokens([...sources.values()]);
  const problems = [];
  for (const [file, source] of sources) {
    problems.push(
      ...findHardcodedColors(file, source),
      ...findUndefinedTokens(file, source, defined),
      ...findMouseOnlyHandlers(file, source),
      ...findAriaHiddenSubtree(file, source),
      ...findBareOutlineNone(file, source),
      ...findFixedWidths(file, source),
      ...findFocusStyleGaps(file, source),
    );
  }
  return { files, problems, defined };
}

/** CLI：默认只报告，`--strict` 时任何问题都退出 1。 */
if (process.argv[1] && process.argv[1].endsWith('check-visual-a11y.mjs')) {
  const strict = process.argv.includes('--strict');
  const { files, problems, defined } = auditClient();
  console.log(`陪伴空间 · 视觉与可访问性静态检查`);
  console.log(`  扫描 ${files.length} 个片段 / 本地 token 定义 ${defined.size} 个`);
  if (!problems.length) {
    console.log(`  ✓ ${RULES.length} 条规则全部通过`);
  } else {
    const byRule = {};
    for (const problem of problems) byRule[problem.rule] = (byRule[problem.rule] || 0) + 1;
    console.log(`  问题 ${problems.length} 项：${Object.entries(byRule).map(([rule, count]) => `${rule}=${count}`).join(' ')}`);
    for (const problem of problems) {
      console.log(`  ✗ ${problem.rule} ${problem.file}:${problem.line} — ${problem.detail}`);
    }
  }
  if (strict && problems.length) process.exitCode = 1;
}
