#!/usr/bin/env node
// 用「正在运行的 DSH 应用」的包恢复 dsh-harness 依赖（版本匹配、必定健康）
// 并把恢复清单写成 manifest，供后续秒级重放
import fs from 'node:fs';
import path from 'node:path';

const H = 'C:/Users/Administrator/dsh-harness';
const APP = 'D:/app/DSH Desktop/resources/app/node_modules/@deepseek-ai';
const MANIFEST = 'C:/Users/Administrator/AppData/Local/Temp/dshfix-manifest.json';

// app 里没有的（@types/node），用 npm 拉到的副本
const EXTRA_TYPES = 'F:/dsh-ide/node_modules/@types/node';

const MAP = {
  'vendor/cordis':        APP + '/cordis',
  'vendor/cosmokit':      APP + '/cosmokit',
  'vendor/schemastery':   APP + '/schemastery',
  'packages/core/tools':  APP + '/dsh-tools',
  'node_modules/@types/node': EXTRA_TYPES,
};

function count(d) { try { return fs.readdirSync(d).length } catch { return -1 } }

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const it of fs.readdirSync(src, { withFileTypes: true })) {
    if (it.name === 'node_modules') continue; // 不递归子 node_modules
    const s = path.join(src, it.name), d = path.join(dst, it.name);
    if (it.isDirectory()) copyTree(s, d);
    else { try { fs.copyFileSync(s, d) } catch {} }
  }
}

const report = [];
let ok = true;
for (const [rel, src] of Object.entries(MAP)) {
  const dst = path.join(H, rel);
  const srcOk = count(src) > 0 && fs.existsSync(path.join(src, 'package.json'));
  if (!srcOk) { report.push(`  ✗ ${rel}: 源不可用 (${src}, items=${count(src)})`); ok = false; continue }
  fs.rmSync(dst, { recursive: true, force: true });
  copyTree(src, dst);
  const n = count(dst);
  const hasPkg = fs.existsSync(path.join(dst, 'package.json'));
  const dts = (() => { let c = 0; const w = (d) => { try { for (const it of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, it.name); if (it.isDirectory()) w(f); else if (it.name.endsWith('.d.ts')) c++ } } catch {} }; w(dst); return c })();
  report.push(`  ${n > 0 && hasPkg ? '✓' : '✗'} ${rel.padEnd(24)} items=${String(n).padEnd(3)} pkg.json=${hasPkg ? 'Y' : 'N'} d.ts=${dts}`);
  if (!(n > 0 && hasPkg)) ok = false;
}

fs.writeFileSync(MANIFEST, JSON.stringify({ at: new Date().toISOString(), map: MAP }, null, 2));
console.log('=== dsh-harness 依赖恢复 ===');
console.log(report.join('\n'));
console.log(`\nmanifest: ${MANIFEST}`);
console.log(ok ? '\n结果: 全部就绪 ✓' : '\n结果: 有失败 ✗');

// 校验 tsc
const tsc = path.join(H, 'node_modules/.bin/tsc');
console.log(`tsc: ${fs.existsSync(tsc) ? 'EXISTS' : 'MISSING'} ${tsc}`);
