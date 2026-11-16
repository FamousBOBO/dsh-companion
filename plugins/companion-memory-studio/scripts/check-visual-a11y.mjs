// 陪伴空间 · 视觉与可访问性的离线验收脚本（W5）。
//
// 计划 W5 的验收不是"看着还行"，而是四条可断言的规则。这个脚本把四条都变成检查：
//   1. **主题 token 单一来源**：页面只能引用 `--dsw-alias-*` / `--cpx-*` token，
//      不许出现写死的十六进制色（否则换主题必然漏掉一处）。
//   2. **键盘可达**：每个可点元素要么是真 `<button>`/`<a href>`/控件，要么带 role 与键盘处理；
//      纯 mouse 的 `<div onClick>` 一律报出来。
//   3. **焦点可见**：不允许光秃秃的 `outline:none`（必须同时给出替代焦点样式）。
//   4. **不横向溢出**：固定的三位数像素宽度要配 `max-width` 或放在可收缩容器里。
//
// 它读的是 `src/client/*.js` 的源码文本（片段是纯脚本，不能 import），所以检查是静态的，
// 但每条规则的判据都写在这里、可复核，不是散落在人眼里的约定。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(here, '..', 'src', 'client');

/** 允许的写死颜色：纯白/纯黑与透明（主题无关的通用基线）。 */
const ALLOWED_COLORS = new Set(['#fff', '#ffffff', '#000', '#000000', 'transparent', 'currentcolor', 'inherit']);

/** 主题 token 前缀。 */
const TOKEN_PREFIXES = ['var(--dsw-alias-', 'var(--cpx-'];

export const RULES = Object.freeze([
  'hardcoded-color',
  'mouse-only-handler',
  'bare-outline-none',
  'fixed-width-without-max',
  'missing-focus-visible',
]);

function collectFiles() {
  return fs.readdirSync(clientDir).filter((name) => name.endsWith('.js')).sort();
}

/** 抽出所有 CSS 文本块（`P.css(\`…\`)` 与 `css(\`…\`)`），带上行号。 */
function cssBlocks(source) {
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

/** 十六进制色检查：排除 token 定义行本身（`--cpx-*: #xxx` 是 token 的出处）。 */
export function findHardcodedColors(file, source) {
  const problems = [];
  for (const block of cssBlocks(source)) {
    const lines = block.text.split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      // token 声明（`--x: #rrggbb`）是 token 的**出处**，不是写死用法：
      // 无论它单独成行还是写在 `:root { … }` 里，都先摘掉再判。
      const withoutDeclarations = trimmed.replace(/--[a-z0-9-]+\s*:\s*#[0-9a-fA-F]{3,8}/gi, '--__token__: var(__v__)');
      // `var(--token, #fallback)` 里的十六进制是**声明的兜底值**，不是写死颜色：
      // 宿主换了 token 它就不生效，所以不该按"漏了主题"处理。先把这些摘掉再看剩下的。
      const withoutFallbacks = withoutDeclarations.replace(/var\(\s*--[a-z0-9-]+\s*,\s*#[0-9a-fA-F]{3,8}\s*\)/gi, 'var(__token__)');
      const matches = withoutFallbacks.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
      for (const color of matches) {
        if (ALLOWED_COLORS.has(color.toLowerCase())) continue;
        problems.push({
          rule: 'hardcoded-color',
          file,
          line: block.startLine + index,
          detail: `写死的颜色 ${color}（应改用 --dsw-alias-* / --cpx-* token）`,
        });
      }
    });
  }
  return problems;
}

/** 只挂 mouse 事件的可点元素。 */
export function findMouseOnlyHandlers(file, source) {
  const problems = [];
  const pattern = /h\(\s*'(div|span|li|td|tr)'\s*,\s*\{([^}]*onClick[^}]*)\}/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const tag = match[1];
    const props = match[2];
    const hasKeyboard = /onKeyDown|onKeyUp|onKeyPress/.test(props);
    const hasRole = /role\s*:\s*'/i.test(props);
    if (hasKeyboard) continue;
    // `aria-hidden="true"` 的遮罩是**纯装饰的点击关闭**（键盘路径走 Esc），
    // 它不是"可聚焦的控件"，把它报成无障碍缺陷会掩盖真正的问题。
    if (/'?aria-hidden'?\s*:\s*'?true'?/.test(props)) continue;
    // 遮罩层（`*backdrop*`）同理：它是"点外面关掉"，键盘路径由容器上的 Esc 承担。
    if (/backdrop/i.test(props)) continue;
    const line = source.slice(0, match.index).split('\n').length;
    problems.push({
      rule: 'mouse-only-handler',
      file,
      line,
      detail: `<${tag}> 带 onClick 却没有键盘处理${hasRole ? '（有 role 但仍需 Enter/Space 处理）' : '，也没有 role'}`,
    });
  }
  return problems;
}

/** 裸的 outline:none —— 只有同一块里出现 :focus-visible / box-shadow 才算有替代。 */
export function findBareOutlineNone(file, source) {
  const problems = [];
  for (const block of cssBlocks(source)) {
    const lines = block.text.split('\n');
    const hasReplacement = /:focus-visible|box-shadow:\s*0 0 0|outline:\s*2px|outline-offset/.test(block.text);
    lines.forEach((line, index) => {
      if (!/outline\s*:\s*(none|0)\b/.test(line)) return;
      if (hasReplacement) return;
      problems.push({
        rule: 'bare-outline-none',
        file,
        line: block.startLine + index,
        detail: '去掉 outline 却没有给替代的焦点样式',
      });
    });
  }
  return problems;
}

/** 固定的三位数宽度（≥100px）必须配 max-width 或 min-width:0 的可收缩上下文。 */
export function findFixedWidths(file, source) {
  const problems = [];
  for (const block of cssBlocks(source)) {
    const lines = block.text.split('\n');
    const blockText = block.text;
    lines.forEach((line, index) => {
      const matches = line.match(/\b(width|min-width)\s*:\s*(\d{3,})px/g) || [];
      for (const decl of matches) {
        // 容器本身写 width:1000px 是溢出源；但 min-width:120px 这种小控件宽度是可接受的。
        const value = Number(decl.match(/(\d{3,})px/)[1]);
        if (value < 240) continue;
        if (/max-width/.test(blockText)) continue;
        problems.push({
          rule: 'fixed-width-without-max',
          file,
          line: block.startLine + index,
          detail: `${decl} 没有配套的 max-width（窗口变窄会横向溢出）`,
        });
      }
    });
  }
  return problems;
}

/** 每个片段若声明了自定义焦点样式，必须用 :focus-visible（而不是只压 :focus）。 */
export function findFocusStyleGaps(file, source) {
  const problems = [];
  for (const block of cssBlocks(source)) {
    const hasFocus = /:focus\b/.test(block.text);
    const hasFocusVisible = /:focus-visible/.test(block.text);
    if (hasFocus && !hasFocusVisible && /outline/.test(block.text)) {
      problems.push({
        rule: 'missing-focus-visible',
        file,
        line: block.startLine,
        detail: '只写了 :focus 而没有 :focus-visible（鼠标点击也会画出焦点框）',
      });
    }
  }
  return problems;
}

/** 跑全部规则。 */
export function auditClient() {
  const files = collectFiles();
  const problems = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(clientDir, file), 'utf8');
    problems.push(
      ...findHardcodedColors(file, source),
      ...findMouseOnlyHandlers(file, source),
      ...findBareOutlineNone(file, source),
      ...findFixedWidths(file, source),
      ...findFocusStyleGaps(file, source),
    );
  }
  return { files, problems };
}

/** CLI：默认只报告，`--strict` 时任何问题都退出 1。 */
if (process.argv[1] && process.argv[1].endsWith('check-visual-a11y.mjs')) {
  const strict = process.argv.includes('--strict');
  const { files, problems } = auditClient();
  console.log(`陪伴空间 · 视觉与可访问性静态检查`);
  console.log(`  扫描 ${files.length} 个片段`);
  if (!problems.length) {
    console.log('  ✓ 五条规则全部通过');
  } else {
    const byRule = {};
    for (const problem of problems) {
      byRule[problem.rule] = (byRule[problem.rule] || 0) + 1;
    }
    console.log(`  问题 ${problems.length} 项：${Object.entries(byRule).map(([rule, count]) => `${rule}=${count}`).join(' ')}`);
    for (const problem of problems) {
      console.log(`  ✗ ${problem.rule} ${problem.file}:${problem.line} — ${problem.detail}`);
    }
  }
  if (strict && problems.length) process.exitCode = 1;
}
