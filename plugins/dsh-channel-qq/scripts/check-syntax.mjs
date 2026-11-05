/** 语法门禁：`verify` 里必须有人"真的解析一遍"这些脚本。
 *
 * 为什么值得单开一条（这是踩出来的）：`deploy/static-audit.mjs` 被一次改写弄出
 * 语法错误（多了一个 `}`），而它**不在 `verify` 里**（按设计它是一份给人看的报告），
 * 于是坏了几个小时没人发现——直到在服务器上跑它才炸。代价是"发布出去的产物里
 * 躺着一个跑不起来的脚本"，而这本来一条 `node --check` 就能拦住。
 *
 * 检查范围：`scripts/`、`deploy/`、`eval/` 下的 `.mjs` 与 `.js`（含后台 UI 的原生
 * ES 模块）。`node --check` 只解析不执行，所以这里不会触发任何副作用。
 */

import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOTS = ['scripts', 'deploy', 'eval']
const EXT = ['.mjs', '.js']

async function walk(dir, out = []) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(abs, out)
    else if (EXT.some(e => entry.name.endsWith(e))) out.push(abs)
  }
  return out
}

const files = []
for (const rel of ROOTS) await walk(path.join(root, rel), files)
files.sort()

const bad = []
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    const detail = String(error.stderr ?? error.message).split('\n').slice(0, 4).join('\n')
    bad.push({ file: path.relative(root, file), detail })
  }
}

if (bad.length > 0) {
  console.error(`check-syntax: ${bad.length} 个脚本解析不过`)
  for (const item of bad) console.error(`\n  ${item.file}\n${item.detail}`)
  process.exit(1)
}
console.log(`check-syntax: 通过（${files.length} 个脚本都能被解析）`)
