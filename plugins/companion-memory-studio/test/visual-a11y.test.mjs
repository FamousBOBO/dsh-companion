import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditClient, findHardcodedColors, findMouseOnlyHandlers, findBareOutlineNone, findFixedWidths, findFocusStyleGaps, RULES } from '../scripts/check-visual-a11y.mjs';

// W5 的视觉与可访问性规则：每条都用**合成片段**验判据本身，避免"规则写错了却全绿"。

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(here, '..', 'src', 'client');

test('the five rules are named in one place and audited together', () => {
  assert.deepEqual([...RULES], [
    'hardcoded-color', 'mouse-only-handler', 'bare-outline-none',
    'fixed-width-without-max', 'missing-focus-visible',
  ]);
  const { files, problems } = auditClient();
  assert.ok(files.length >= 19, `片段数量异常：${files.length}`);
  assert.equal(Array.isArray(problems), true);
});

test('real client fragments pass all five rules', () => {
  const { problems } = auditClient();
  assert.deepEqual(problems, [], `仍有问题：${JSON.stringify(problems.slice(0, 5))}`);
});

test('a hardcoded colour is caught, but a token fallback is not', () => {
  const bad = 'P.css(`\n.x { color: #ff00aa; }\n`);';
  assert.equal(findHardcodedColors('t.js', bad).length, 1);
  // var(--token, #fallback) 是"有 token、只是带兜底"，不算漏主题。
  const good = 'P.css(`\n.x { color: var(--dsw-alias-label-primary, #abc); }\n`);';
  assert.equal(findHardcodedColors('t.js', good).length, 0);
  // token 定义行是出处，允许。
  const def = 'P.css(`\n:root { --cpx-mono-bg: #101319; }\n.x { color: var(--cpx-mono-bg); }\n`);';
  assert.equal(findHardcodedColors('t.js', def).length, 0);
  // 纯白/纯黑/透明是主题无关基线。
  const base = 'P.css(`\n.x { color: #fff; background: transparent; }\n`);';
  assert.equal(findHardcodedColors('t.js', base).length, 0);
});

test('mouse-only handlers are caught unless there is a keyboard path', () => {
  const bad = "h('div', { className: 'x', onClick: () => go() }, 'x')";
  assert.equal(findMouseOnlyHandlers('t.js', bad).length, 1);
  const ok = "h('div', { className: 'x', onClick: () => go(), onKeyDown: handler }, 'x')";
  assert.equal(findMouseOnlyHandlers('t.js', ok).length, 0);
  // 装饰性遮罩（aria-hidden / backdrop）不算可聚焦控件。
  const overlay = "h('div', { className: 'cpx-backdrop', 'aria-hidden': 'true', onClick: () => close() })";
  assert.equal(findMouseOnlyHandlers('t.js', overlay).length, 0);
});

test('a bare outline:none is caught unless a focus style replaces it', () => {
  const bad = 'P.css(`\n.x:focus { outline: none; }\n`);';
  assert.equal(findBareOutlineNone('t.js', bad).length, 1);
  const good = 'P.css(`\n.x:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }\n.x:focus { outline: none; }\n`);';
  assert.equal(findBareOutlineNone('t.js', good).length, 0);
});

test('wide fixed widths are caught when there is no max-width', () => {
  const bad = 'P.css(`\n.x { width: 720px; }\n`);';
  assert.equal(findFixedWidths('t.js', bad).length, 1);
  const ok = 'P.css(`\n.x { width: 720px; max-width: 100%; }\n`);';
  assert.equal(findFixedWidths('t.js', ok).length, 0);
  // 小控件的 min-width 不算溢出源。
  const small = 'P.css(`\n.x { min-width: 120px; }\n`);';
  assert.equal(findFixedWidths('t.js', small).length, 0);
});

test(':focus without :focus-visible is flagged when an outline is involved', () => {
  const bad = 'P.css(`\n.x:focus { outline: 2px solid var(--dsw-alias-brand-primary); }\n`);';
  assert.equal(findFocusStyleGaps('t.js', bad).length, 1);
  const ok = 'P.css(`\n.x:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); }\n`);';
  assert.equal(findFocusStyleGaps('t.js', ok).length, 0);
});

test('the audit reads every fragment, including the ones added in W1–W3', () => {
  const { files } = auditClient();
  for (const name of ['settings-search.js', 'pages-trace.js', 'pages-works.js']) {
    assert.equal(files.includes(name), true, `${name} 没有被扫描`);
  }
  // 这三个新增片段的样式必须已经在真实文件里（不是只存在于测试里）。
  for (const name of ['settings-search.js', 'pages-trace.js', 'pages-works.js']) {
    const source = fs.readFileSync(path.join(clientDir, name), 'utf8');
    assert.equal(source.includes('P.css('), true, `${name} 没有声明样式`);
  }
});
