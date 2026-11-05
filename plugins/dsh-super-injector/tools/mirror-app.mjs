#!/usr/bin/env node
// 把隔离 checkout 做成「完整镜像」：复制 app 的全部 @deepseek-ai 包
// ⇒ 类型解析 100% 完整、版本与运行中的应用完全一致、且外部无法触碰
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.USERPROFILE || 'C:/Users/Administrator';
const CK = path.join(HOME, '.dsh/super-injector/checkout');
const APP = 'D:/app/DSH Desktop/resources/app/node_modules/@deepseek-ai';

function items(d) { try { return fs.readdirSync(d).length } catch { return -1 } }

function copyTree(src, dst, stats) {
  fs.mkdirSync(dst, { recursive: true });
  let ents;
  try { ents = fs.readdirSync(src, { withFileTypes: true }) } catch { return }
  for (const it of ents) {
    const s = path.join(src, it.name), d = path.join(dst, it.name);
    if (it.isSymbolicLink()) {
      // 保留链接语义（指向 app 内的相对目标时按字面重建；否则跳过避免指回外部）
      let tgt = '';
      try { tgt = fs.readlinkSync(s) } catch {}
      if (tgt && !path.isAbsolute(tgt)) {
        try { fs.symlinkSync(tgt, d, 'junction') ; stats.links++ } catch {}
      } else { stats.skipped++ }
      continue;
    }
    if (it.isDirectory()) {
      if (it.name === 'node_modules') { stats.skipped++; continue }  // 子 node_modules 不递归（避免爆炸）
      copyTree(s, d, stats);
    } else {
      try { fs.copyFileSync(s, d); stats.files++ } catch { stats.failed++ }
    }
  }
}

console.log('=== 镜像 app 的 @deepseek-ai → 隔离 checkout/node_modules/@deepseek-ai ===');
const dstRoot = path.join(CK, 'node_modules/@deepseek-ai');
fs.rmSync(dstRoot, { recursive: true, force: true });
const stats = { files: 0, links: 0, skipped: 0, failed: 0 };
const t0 = Date.now();
copyTree(APP, dstRoot, stats);
console.log(`复制完成: files=${stats.files} links=${stats.links} skipped=${stats.skipped} failed=${stats.failed} 用时=${((Date.now()-t0)/1000).toFixed(1)}s`);

// 同时保留 vendor/* 与 packages/core/tools（build.sh 的 link_pkg 目标）
console.log('\n=== 补齐 build.sh 需要的 vendor/* 与 packages/* ===');
const pairs = [
  ['vendor/cordis', 'cordis'],
  ['vendor/cosmokit', 'cosmokit'],
  ['vendor/schemastery', 'schemastery'],
  ['packages/core/tools', 'dsh-tools'],
  ['packages/llm/llm', 'dsh-llm'],
  ['packages/core/system-prompt', 'dsh-system-prompt'],
];
for (const [rel, pkg] of pairs) {
  const src = path.join(APP, pkg);
  const dst = path.join(CK, rel);
  if (!fs.existsSync(path.join(src, 'package.json'))) { console.log(`  ✗ ${rel}: 源缺 (${pkg})`); continue }
  fs.rmSync(dst, { recursive: true, force: true });
  const st = { files: 0, links: 0, skipped: 0, failed: 0 };
  copyTree(src, dst, st);
  console.log(`  ✓ ${rel.padEnd(26)} files=${st.files} pkg.json=${fs.existsSync(path.join(dst,'package.json'))?'Y':'N'}`);
}
// packages 目录里也放一份（guard 需要 packages 存在）
fs.mkdirSync(path.join(CK, 'packages/core'), { recursive: true });

// @types/node 与 typescript 必须保留（上面 rm 没动它们）
console.log('\n=== 关键项终检 ===');
const need = [
  ['node_modules/@types/node', 'index.d.ts'],
  ['node_modules/typescript', 'package.json'],
  ['node_modules/.bin/tsc.cmd', null],
  ['node_modules/@deepseek-ai/dsh-tools', 'package.json'],
  ['node_modules/@deepseek-ai/dsh-llm', 'package.json'],
  ['node_modules/@deepseek-ai/dsh-scope', 'package.json'],
  ['node_modules/@deepseek-ai/dsh-agent', 'package.json'],
  ['node_modules/@deepseek-ai/dsh-session', 'package.json'],
  ['node_modules/@deepseek-ai/cordis', 'package.json'],
  ['node_modules/@deepseek-ai/cosmokit', 'package.json'],
  ['node_modules/@deepseek-ai/schemastery', 'package.json'],
  ['vendor/cordis', 'package.json'],
  ['vendor/cosmokit', 'package.json'],
  ['vendor/schemastery', 'package.json'],
  ['packages/core/tools', 'package.json'],
  ['packages/llm/llm', 'package.json'],
  ['packages/core/system-prompt', 'package.json'],
];
let ok = 0, bad = [];
for (const [rel, probe] of need) {
  const p = path.join(CK, rel);
  const good = fs.existsSync(p) && (!probe || fs.existsSync(path.join(p, probe)));
  if (good) ok++; else bad.push(rel);
  console.log(`  ${good ? '✓' : '✗'} ${rel} items=${items(p)}`);
}
console.log(`\n就绪 ${ok}/${need.length}${bad.length ? '  缺失: ' + bad.join(', ') : '  —— 完整 ✓'}`);
