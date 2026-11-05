#!/usr/bin/env node
// 根治：为注入器建一个**专用隔离 checkout**，从「正在运行的 DSH 应用」直接取材。
// 该路径不被任何其他流程触碰 ⇒ 无论 dsh-harness 被谁掏空，自检/构建都不再受影响。
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.USERPROFILE || 'C:/Users/Administrator';
const CK = path.join(HOME, '.dsh/super-injector/checkout');   // 隔离 checkout
const APP = 'D:/app/DSH Desktop/resources/app/node_modules/@deepseek-ai';
const HARNESS = 'C:/Users/Administrator/dsh-harness';

function items(d) { try { return fs.readdirSync(d).length } catch { return -1 } }
function isHealthy(d) { return items(d) > 0 && fs.existsSync(path.join(d, 'package.json')) }

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const it of fs.readdirSync(src, { withFileTypes: true })) {
    if (it.name === 'node_modules') continue;
    const s = path.join(src, it.name), d = path.join(dst, it.name);
    if (it.isDirectory()) copyTree(s, d);
    else { try { fs.copyFileSync(s, d) } catch {} }
  }
}

const log = [];
function put(src, rel, label) {
  const dst = path.join(CK, rel);
  if (!isHealthy(src)) { log.push(`  ✗ ${label}: 源不健康 (${src}, items=${items(src)})`); return false }
  fs.rmSync(dst, { recursive: true, force: true });
  copyTree(src, dst);
  const ok = isHealthy(dst);
  const dts = (() => { let c = 0; const w = (d) => { try { for (const it of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, it.name); if (it.isDirectory()) w(f); else if (it.name.endsWith('.d.ts')) c++ } } catch {} }; w(dst); return c })();
  log.push(`  ${ok ? '✓' : '✗'} ${label.padEnd(30)} items=${String(items(dst)).padEnd(3)} d.ts=${dts}`);
  return ok;
}

console.log('=== 建隔离 checkout: ' + CK + ' ===');
fs.mkdirSync(CK, { recursive: true });

// 1) DSH 包：从正在运行的应用取（版本天然匹配）
let ok = true;
ok = put(APP + '/cordis',      'vendor/cordis',                        'vendor/cordis') && ok;
ok = put(APP + '/cosmokit',    'vendor/cosmokit',                      'vendor/cosmokit') && ok;
ok = put(APP + '/schemastery', 'vendor/schemastery',                   'vendor/schemastery') && ok;
ok = put(APP + '/dsh-tools',   'packages/core/tools',                  'packages/core/tools') && ok;

// 2) guard 要求 $CHECKOUT/packages 存在
fs.mkdirSync(path.join(CK, 'packages/core'), { recursive: true });

// 3) @types/node：优先 harness（若其为真目录），否则从 npm 缓存目录找
const typesCandidates = [
  path.join(HARNESS, 'node_modules/@types/node'),
  'C:/Users/Administrator/AppData/Local/Temp/tyfix/_types_node',
];
let typesSrc = typesCandidates.find(isHealthy);
if (!typesSrc) {
  // 自己 npm pack 一个
  const { execFileSync } = await import('node:child_process');
  const tmp = 'C:/Users/Administrator/AppData/Local/Temp/ck-types';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    execFileSync('npm', ['pack', '@types/node@22.20.0', '--pack-destination', '.'], { cwd: tmp, stdio: 'ignore', shell: true });
    const tgz = fs.readdirSync(tmp).find(f => f.endsWith('.tgz'));
    if (tgz) {
      const out = path.join(tmp, '_types_node');
      fs.mkdirSync(out, { recursive: true });
      execFileSync('tar', ['-xzf', path.join(tmp, tgz), '-C', out, '--strip-components=1'], { stdio: 'ignore', shell: true });
      typesSrc = out;
    }
  } catch (e) { log.push('  npm pack @types/node 失败: ' + e.message) }
}
ok = put(typesSrc || '', 'node_modules/@types/node', 'node_modules/@types/node') && ok;

// 4) typescript + .bin/tsc：从 harness 取（编译器本身与 checkout 内容无关）
const tsSrc = path.join(HARNESS, 'node_modules/typescript');
if (isHealthy(tsSrc)) {
  put(tsSrc, 'node_modules/typescript', 'node_modules/typescript');
  const binDir = path.join(CK, 'node_modules/.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const hb = path.join(HARNESS, 'node_modules/.bin');
  for (const f of (() => { try { return fs.readdirSync(hb) } catch { return [] } })()) {
    if (/^tsc(\.cmd|\.ps1)?$/.test(f)) {
      try { fs.copyFileSync(path.join(hb, f), path.join(binDir, f)) } catch {}
    }
  }
  log.push(`  .bin/tsc: ${fs.existsSync(path.join(binDir, 'tsc')) ? '✓ 已就位' : '✗ 缺失'}`);
} else {
  log.push(`  ✗ typescript 源不可用: ${tsSrc}`);
  ok = false;
}

// 5) 最小 package.json（guard 用 + 语义完整）
fs.writeFileSync(path.join(CK, 'package.json'), JSON.stringify({
  name: 'dsh-injector-checkout', private: true, version: '0.0.0',
  description: 'isolated build checkout for dsh-super-injector (self-contained; nothing else writes here)',
}, null, 2) + '\n');

console.log(log.join('\n'));
console.log('\n=== 结果: ' + (ok ? '隔离 checkout 就绪 ✓' : '有失败 ✗') + ' ===');

// 6) 用隔离 checkout 做一次真实编译冒烟
const tsc = path.join(CK, 'node_modules/.bin/tsc');
if (fs.existsSync(tsc)) {
  const { execFileSync } = await import('node:child_process');
  const smoke = 'C:/Users/Administrator/AppData/Local/Temp/ck-smoke';
  fs.rmSync(smoke, { recursive: true, force: true });
  fs.mkdirSync(path.join(smoke, 'src'), { recursive: true });
  fs.writeFileSync(path.join(smoke, 'src/index.ts'),
    "import type { Context } from '@deepseek-ai/cordis'\nimport { defineTool } from '@deepseek-ai/dsh-tools'\nexport const name = 'smoke'\nexport function apply(ctx: Context): void { void defineTool; void ctx }\n");
  fs.writeFileSync(path.join(smoke, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2023'], strict: true, types: ['node'], outDir: 'lib', rootDir: 'src', skipLibCheck: true, esModuleInterop: true },
    include: ['src'],
  }, null, 2));
  // 链接依赖（模拟 build.sh 的做法）
  const nm = path.join(smoke, 'node_modules');
  const links = [
    ['@deepseek-ai/cordis', 'vendor/cordis'],
    ['cosmokit', 'vendor/cosmokit'],
    ['@deepseek-ai/schemastery', 'vendor/schemastery'],
    ['@deepseek-ai/dsh-tools', 'packages/core/tools'],
    ['@types/node', 'node_modules/@types/node'],
  ];
  for (const [name, rel] of links) {
    const tgt = path.join(CK, rel);
    const dst = path.join(nm, ...name.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try { fs.symlinkSync(tgt, dst, 'junction') } catch (e) { log.push('  link ' + name + ' 失败: ' + e.message) }
  }
  try {
    const out = execFileSync(tsc, ['-p', 'tsconfig.json'], { cwd: smoke, encoding: 'utf8', shell: true });
    const built = fs.existsSync(path.join(smoke, 'lib/index.js'));
    console.log(`\n冒烟编译: ${built ? '✓ 通过（lib/index.js 已生成）' : '✗ lib 未生成'}`);
    if (out) console.log(out.slice(0, 400));
  } catch (e) {
    console.log('\n冒烟编译: ✗ 失败');
    console.log(String(e.stdout || e.message).slice(0, 600));
  }
  // 清理冒烟目录 + 验证隔离 checkout 未被影响
  fs.rmSync(smoke, { recursive: true, force: true });
  console.log('\n=== 冒烟后隔离 checkout 完整性 ===');
  for (const rel of ['vendor/cordis', 'vendor/cosmokit', 'vendor/schemastery', 'packages/core/tools', 'node_modules/@types/node', 'node_modules/typescript']) {
    console.log(`  ${isHealthy(path.join(CK, rel)) ? '✓' : '✗'} ${rel} items=${items(path.join(CK, rel))}`);
  }
}
