/** 把 `tools/song/*.py` 复制进 `build/tools/song/`。
 *
 * 为什么需要这一步：`chorusScriptPath()` 是从 `build/lib/features/song/` **逐层上溯**找
 * `tools/song/find_chorus.py` 的。开发机上第 4 跳就能命中仓库根的 `tools/`，所以本地全绿；
 * 但**发布包只有 `build/` 与源码**——`npm pack` 的 `files` 与 `deploy/pack-release.mjs`
 * 的 `INCLUDE` 都不带 `tools/`。装到服务器上之后第 4 跳落空，副歌定位每条都失败，
 * 而这个缺口在开发机上永远看不见。
 *
 * 修法选"让发布物自洽"而不是"往打包清单里加一个目录"：`build/` 本来就是发布单元，
 * 它里面自带脚本，就不依赖仓库根的布局，也不会因为有人走 `npm pack` 而不是
 * `pack-release.mjs` 而漏掉。
 *
 * **只复制 `*.py`**：同一目录下的 `e2e-acceptance.mjs` 是真机验收脚本（要 RVC + NapCat），
 * 不该跟着发布包走。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'tools', 'song')
const target = path.join(root, 'build', 'tools', 'song')
const check = process.argv.includes('--check')

if (!existsSync(source)) {
  console.error(`没有 ${source}：tools/song 下应该有 find_chorus.py`)
  process.exit(1)
}

const pyFiles = readdirSync(source).filter((name) => name.endsWith('.py'))
if (pyFiles.length === 0) {
  console.error(`没有 ${source} 里没有 .py 文件（副歌定位脚本不见了？）`)
  process.exit(1)
}

if (check) {
  const missing = pyFiles.filter((name) => !existsSync(path.join(target, name)))
  if (missing.length > 0) {
    console.error(`build/tools/song 里缺：${missing.join('、')}（先跑 npm run build）`)
    process.exit(1)
  }
  console.log(`build-tools: ${String(pyFiles.length)} 个脚本都在 build/tools/song 里`)
  process.exit(0)
}

// 先清掉旧副本：build/ 是产物目录，残留的旧脚本比缺脚本更难查。
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
for (const name of pyFiles) copyFileSync(path.join(source, name), path.join(target, name))
console.log(`build-tools: 已复制 ${pyFiles.join('、')} → ${path.relative(root, target)}`)
