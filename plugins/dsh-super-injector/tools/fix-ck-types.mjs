#!/usr/bin/env node
// 补 @types/node 到隔离 checkout（用 Node 原生，不依赖 tar/gzip 命令）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const CK = 'C:/Users/Administrator/.dsh/super-injector/checkout';
const DST = path.join(CK, 'node_modules/@types/node');
const TMP = 'C:/Users/Administrator/AppData/Local/Temp/ck-types2';

function items(d) { try { return fs.readdirSync(d).length } catch { return -1 } }
function isHealthy(d) { return items(d) > 0 && fs.existsSync(path.join(d, 'index.d.ts')) }

// 优先：从已有的健康副本直接复制
const CANDIDATES = [
  'C:/Users/Administrator/dsh-harness/node_modules/@types/node',
  'D:/app/DSH Desktop/resources/app/node_modules/@types/node',
  'F:/dsh-ide/node_modules/@types/node',
];

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const it of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, it.name), d = path.join(dst, it.name);
    if (it.isDirectory()) copyTree(s, d);
    else { try { fs.copyFileSync(s, d) } catch {} }
  }
}

let done = false;
for (const c of CANDIDATES) {
  if (isHealthy(c)) {
    console.log(`从健康副本复制: ${c} (items=${items(c)})`);
    fs.rmSync(DST, { recursive: true, force: true });
    copyTree(c, DST);
    done = isHealthy(DST);
    if (done) break;
  } else {
    console.log(`跳过（不健康）: ${c} items=${items(c)}`);
  }
}

if (!done) {
  console.log('\n所有副本都不健康 —— 从 npm 拉取并用 Node 解包');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  execFileSync('npm', ['pack', '@types/node@22.20.0', '--pack-destination', TMP], { stdio: 'inherit', shell: true });
  const tgz = fs.readdirSync(TMP).find(f => f.endsWith('.tgz'));
  if (!tgz) { console.log('npm pack 失败'); process.exit(1) }
  console.log('tgz: ' + tgz);

  // Node 原生解析 tar（只处理常规文件）
  const buf = zlib.gunzipSync(fs.readFileSync(path.join(TMP, tgz)));
  let off = 0, count = 0;
  const STRIP = 1; // 去掉 "package/" 前缀
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every(b => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const type = String.fromCharCode(header[156]);
    off += 512;
    if (name) {
      const parts = name.split('/').slice(STRIP);
      const rel = parts.join('/');
      if (rel && (type === '0' || type === '\0' || type === '') && size > 0) {
        const target = path.join(DST, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buf.subarray(off, off + size));
        count++;
      }
    }
    off += Math.ceil(size / 512) * 512;
  }
  console.log(`解包 ${count} 个文件`);
  done = isHealthy(DST);
}

console.log(`\n@types/node: items=${items(DST)} index.d.ts=${fs.existsSync(path.join(DST, 'index.d.ts')) ? 'Y' : 'N'} => ${done ? '✓' : '✗'}`);

// 最终验证隔离 checkout 全套
console.log('\n=== 隔离 checkout 终检 ===');
const NEED = ['vendor/cordis', 'vendor/cosmokit', 'vendor/schemastery', 'packages/core/tools', 'node_modules/@types/node', 'node_modules/typescript', 'node_modules/.bin/tsc'];
let allOk = true;
for (const rel of NEED) {
  const p = path.join(CK, rel);
  const ok = fs.existsSync(p);
  if (!ok) allOk = false;
  console.log(`  ${ok ? '✓' : '✗'} ${rel} items=${items(p)}`);
}
console.log(allOk ? '\n隔离 checkout 完整 ✓' : '\n仍有缺失 ✗');
