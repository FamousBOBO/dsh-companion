import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditClient, cssRules, findHardcodedColors, findUndefinedTokens, findMouseOnlyHandlers,
  findAriaHiddenSubtree, findBareOutlineNone, findFixedWidths, findFocusStyleGaps,
  collectDefinedTokens, RULES,
} from '../scripts/check-visual-a11y.mjs';

// W5 的视觉与可访问性规则：每条都用**合成片段**验判据本身的正反两面。
//
// 这里还专门钉住四类历史盲区（审查报告 M6）：
//   - 块级 max-width 不能豁免另一条规则的固定宽度；
//   - 块级 :focus-visible 不能豁免另一条规则的 outline:none；
//   - props 里嵌套对象（style: {...}）不能让 onClick 检测漏掉整行；
//   - 行内 style 里的十六进制色必须可见。

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(here, '..', 'src', 'client');

test('the rule set is named in one place and audited together', () => {
  assert.deepEqual([...RULES], [
    'hardcoded-color', 'undefined-token', 'mouse-only-handler', 'aria-hidden-subtree',
    'bare-outline-none', 'fixed-width-without-max', 'missing-focus-visible',
  ]);
  const { files, problems, defined } = auditClient();
  assert.ok(files.length >= 19, `片段数量异常：${files.length}`);
  assert.equal(Array.isArray(problems), true);
  assert.ok(defined.size >= 30, `本地 token 定义太少：${defined.size}`);
});

test('real client fragments pass every rule', () => {
  const { problems } = auditClient();
  assert.deepEqual(problems, [], `仍有问题：${JSON.stringify(problems.slice(0, 5))}`);
});

test('cssRules splits one declaration block into independent rules', () => {
  const rules = cssRules('.a { width: 720px; }\n.b { max-width: 100%; }', 1);
  assert.equal(rules.length, 2);
  assert.equal(rules[0].selector, '.a');
  assert.equal(rules[1].selector, '.b');
});

test('a hardcoded colour is caught, but a token fallback is not', () => {
  assert.equal(findHardcodedColors('t.js', 'P.css(`\n.x { color: #ff00aa; }\n`);').length, 1);
  assert.equal(findHardcodedColors('t.js', 'P.css(`\n.x { color: var(--dsw-alias-label-primary, #abc); }\n`);').length, 0);
  assert.equal(findHardcodedColors('t.js', 'P.css(`\n:root { --cpx-mono-bg: #101319; }\n.x { color: var(--cpx-mono-bg); }\n`);').length, 0);
  assert.equal(findHardcodedColors('t.js', 'P.css(`\n.x { color: #fff; background: transparent; }\n`);').length, 0);
});

test('inline style colours are visible to the scan (blind spot 4)', () => {
  const source = "h('span', { style: { color: '#ff0000' } }, 'x')";
  const problems = findHardcodedColors('t.js', source);
  assert.equal(problems.length, 1);
  // token 化的行内样式不算。
  const ok = "h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, 'x')";
  assert.equal(findHardcodedColors('t.js', ok).length, 0);
});

test('an undefined local token is caught even when it has a hex fallback', () => {
  const defined = collectDefinedTokens(['P.css(`:root { --cpx-known: #111; }`)']);
  const bad = 'P.css(`.x { color: var(--cpx-unknown, #222); }`)';
  assert.equal(findUndefinedTokens('t.js', bad, defined).length, 1);
  const good = 'P.css(`.x { color: var(--cpx-known); }`)';
  assert.equal(findUndefinedTokens('t.js', good, defined).length, 0);
  // 宿主 token 不归我们校验。
  assert.equal(findUndefinedTokens('t.js', 'P.css(`.x { color: var(--dsw-alias-label-primary); }`)', defined).length, 0);
});

test('mouse-only handlers are caught unless there is a keyboard path', () => {
  assert.equal(findMouseOnlyHandlers('t.js', "h('div', { className: 'x', onClick: () => go() }, 'x')").length, 1);
  assert.equal(findMouseOnlyHandlers('t.js', "h('div', { className: 'x', onClick: () => go(), onKeyDown: handler }, 'x')").length, 0);
  assert.equal(findMouseOnlyHandlers('t.js', "h('div', { className: 'cpx-backdrop', 'aria-hidden': 'true', onClick: () => close() })").length, 0);
});

test('nested props objects do not hide an onClick (blind spot 3)', () => {
  const nested = "h('div', { style: { padding: '4px' }, onClick: () => go() }, 'x')";
  assert.equal(findMouseOnlyHandlers('t.js', nested).length, 1);
});

test('a decorative overlay may be aria-hidden, but a dialog inside it may not (H4)', () => {
  // 装饰遮罩：子树里只有 onClose，没有 role / 可聚焦节点 → 放行。
  const overlayOnly = "h('div', { className: 'cpx-cat-backdrop', 'aria-hidden': 'true', onClick: () => close() })";
  assert.equal(findAriaHiddenSubtree('t.js', overlayOnly).length, 0);
  // 把面板塞进同一个 aria-hidden 容器：必须报出来。
  const nested = "h('div', { className: 'cpx-cat-overlay', 'aria-hidden': 'true' }, h('div', { className: 'cpx-cat-panel', role: 'dialog', 'aria-modal': 'true' }, 'x'))";
  assert.equal(findAriaHiddenSubtree('t.js', nested).length, 1);
  // 兄弟节点结构（本项目采用）：遮罩 aria-hidden、面板在它外面 → 放行。
  const siblings = "h('div', { className: 'cpx-cat-overlay' }, h('div', { className: 'cpx-cat-backdrop', 'aria-hidden': 'true' }), h('div', { role: 'dialog' }))";
  assert.equal(findAriaHiddenSubtree('t.js', siblings).length, 0);
});

test('a bare outline:none is caught unless the same rule replaces it', () => {
  assert.equal(findBareOutlineNone('t.js', 'P.css(`\n.x:focus { outline: none; }\n`);').length, 1);
  assert.equal(findBareOutlineNone('t.js', 'P.css(`\n.x:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }\n.x:focus { outline: none; }\n`);').length, 0);
});

test('a replacement in a sibling rule does not exempt outline:none (blind spot 1)', () => {
  // `.a:focus-visible` 有替代，但 `.a:focus { outline:none }` 是同一条里没有替代 →
  // 旧版按整块判会放行，这里必须独立判定。
  const mixed = 'P.css(`\n.a:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); }\n.b { outline: none; }\n`)';
  assert.equal(findBareOutlineNone('t.js', mixed).length, 1);
});

test('wide fixed widths are caught per rule, not per block (blind spot 2)', () => {
  assert.equal(findFixedWidths('t.js', 'P.css(`\n.x { width: 720px; }\n`);').length, 1);
  const mixed = 'P.css(`\n.a { width: 720px; }\n.b { max-width: 100%; }\n`)';
  assert.equal(findFixedWidths('t.js', mixed).length, 1, '兄弟规则的 max-width 不该豁免 .a');
  assert.equal(findFixedWidths('t.js', 'P.css(`\n.x { width: 720px; max-width: 100%; }\n`);').length, 0);
  assert.equal(findFixedWidths('t.js', 'P.css(`\n.x { min-width: 120px; }\n`);').length, 0);
});

test(':focus without :focus-visible is flagged per selector', () => {
  assert.equal(findFocusStyleGaps('t.js', 'P.css(`\n.x:focus { outline: 2px solid var(--dsw-alias-brand-primary); }\n`);').length, 1);
  assert.equal(findFocusStyleGaps('t.js', 'P.css(`\n.x:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); }\n`);').length, 0);
});

test('the audit reads every fragment, including the ones added in W1–W3', () => {
  const { files } = auditClient();
  for (const name of ['settings-search.js', 'pages-trace.js', 'pages-works.js']) {
    assert.equal(files.includes(name), true, `${name} 没有被扫描`);
    const source = fs.readFileSync(path.join(clientDir, name), 'utf8');
    assert.equal(source.includes('P.css('), true, `${name} 没有声明样式`);
  }
});
