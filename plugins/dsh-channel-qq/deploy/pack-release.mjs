/**
 * 本地打包一次发布：产物 + **逐文件 sha256 清单**。
 *
 * 为什么要有清单：这条网络路径有 1KB 级的 MTU 黑洞（见 `http-push-fast.mjs` 的
 * 排查记录），历史上出现过"传上去的文件少了一截、解包也能成功"的情况。发布是
 * 唯一一个"传坏了会直接让机器人起不来"的动作，所以它必须自带校验材料：
 * 服务器侧解包之后先 `sha256sum -c`，对不上就**不切换**。
 *
 * 用法：
 *   node deploy/pack-release.mjs                 # 构建 + 打包到 .deploy-tmp/
 *   node deploy/pack-release.mjs --no-build      # 用现有的 lib/（CI 里已经构建过）
 *   node deploy/pack-release.mjs --out /tmp/x.tar.gz
 *
 * 产物里**包含 lib/ 与 lib-test/**：服务器只做"验签 + 解包 + 切换"，不再构建。
 * 本地构建的好处是发布过程与构建工具链解耦——服务器上 tsc 版本变了也不会让
 * 一次发布莫名其妙地失败。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const argv = process.argv.slice(2)
const noBuild = argv.includes('--no-build')
const outFlag = argv.indexOf('--out')
const outFile = outFlag === -1
  ? path.join(root, '.deploy-tmp', 'release.tar.gz')
  : path.resolve(argv[outFlag + 1])

/** 发布内容：源码、产物、测试、脚本、资源、清单文件。**不含** node_modules（服务器侧已有）。 */
const INCLUDE = [
  'package.json', 'cordis.patch.yml', 'tsconfig.json', 'tsconfig.test.json',
  'src', 'build', 'assets', 'scripts', 'test', 'deploy', 'eval',
  'MANIFEST.sha256', 'RELEASE.json',
]

function run(cmd, args) {
  // Windows 上 npm 是 npm.cmd：Node 20+ 不允许直接 spawn .cmd/.bat，必须过 shell；
  // 这里的 args 全是本文件里的常量，没有注入面。
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 目录递归列出文件（相对 root 的 POSIX 路径）。 */
function walk(rel, out = []) {
  const abs = path.join(root, rel)
  if (!existsSync(abs)) return out
  if (statSync(abs).isFile()) { out.push(rel); return out }
  for (const name of readdirSync(abs).sort()) walk(`${rel}/${name}`, out)
  return out
}

if (!noBuild) {
  console.log('=== 构建 ===')
  // Windows 上没有裸 `npm`（是 npm.cmd），execFileSync 不做后缀解析——发布脚本
  // 要在开发机上跑，所以这里自己挑可执行名。
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  run(npm, ['run', 'build'])
  run(npm, ['run', 'typecheck:tests'])
}

console.log('=== 写清单 ===')
const files = []
for (const entry of INCLUDE) {
  for (const file of walk(entry)) {
    if (file.startsWith('node_modules/') || file.startsWith('.deploy-tmp/')) continue
    if (file === 'MANIFEST.sha256' || file === 'RELEASE.json') continue
    files.push(file)
  }
}
files.sort()
const manifest = files.map((f) => `${sha256(path.join(root, f))}  ${f}`).join('\n') + '\n'

let commit = 'unknown'
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
} catch { /* 不在 git 仓库里也能打包 */ }

const version = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const release = {
  name: 'dsh-channel-qq',
  version,
  commit,
  builtAt: new Date().toISOString(),
  fileCount: files.length,
}

writeFileSync(path.join(root, 'MANIFEST.sha256'), manifest, 'utf8')
writeFileSync(path.join(root, 'RELEASE.json'), JSON.stringify(release, null, 2) + '\n', 'utf8')

console.log(`  ${files.length} 个文件，${commit.slice(0, 8)}，版本 ${version}`)
console.log('=== 打包 ===')
mkdirSync(path.dirname(outFile), { recursive: true })
// Windows 上 `-f F:\x` 会被 GNU tar 当成"远端主机 F"，所以路径转正斜杠 + --force-local。
run('tar', ['--force-local', '--exclude=node_modules', '-czf', outFile.split(path.sep).join('/'), ...INCLUDE])
console.log(`  ${outFile}  （sha256 ${sha256(outFile).slice(0, 16)}…）`)
console.log('下一步：把产物传上去，再在服务器上跑 `node deploy/release.mjs <tarball>`')
