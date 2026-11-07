/** 部署级回归：**发布物里到底有没有副歌定位脚本**。
 *
 * 为什么这条必须进 `npm test`：`chorusScriptPath()` 是从 `build/lib/features/song/` 逐层上溯
 * 找 `tools/song/find_chorus.py` 的。开发机上第 4 跳能命中仓库根的 `tools/`，所以本地全绿；
 * 而发布包只有 `build/`（`npm pack` 的 `files` 与 `deploy/pack-release.mjs` 的 `INCLUDE`
 * 都不带 `tools/`）。装到服务器之后上溯落空 → `createChorusPort` 拿到一条不存在的路径 →
 * 每条点歌都停在"没找准副歌"这一步。这个缺口在开发机上**永远看不见**。
 *
 * 守两层：
 *   1. **真实仓库形状**（只读）：从 `build/lib` 与 `build/lib-test` 两条入口出发，
 *      `chorusScriptPath()` 都必须命中 `build/tools/song/find_chorus.py`；而且那一份与
 *      `tools/song/find_chorus.py` **内容相同**（防止"改了源码忘记重建"给出一个
 *      看起来合理的旧答案——那种偏差比"根本没脚本"更难查）。
 *   2. **复制脚本的行为**（hermetic）：在临时目录里搭一套最小 `scripts/` + `tools/song/`，
 *      真的跑 `build-tools.mjs`，断言"只复制 .py、`--check` 在缺文件时变红"。
 *      不去动仓库里共享的 `build/`——测试**不该**为了验自己而弄坏别人的构建产物。
 *
 * 找不到插件根时（例如把编译产物跑在仓库之外）用 `t.skip` 说明缺什么，绝不假装通过。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { chorusScriptPath } = await import('../src/features/song/index.js')

/** 上溯找插件根（同时有 `package.json` 与 `scripts/build-tools.mjs`）。 */
function pluginRoot(): string | null {
  // 三个起点：当前工作目录（`npm test` 时就是插件根）、测试文件所在目录、
  // `chorusScriptPath()` 解析出的脚本所在目录（与"测试产物放哪"无关）。
  const starts = [process.cwd(), import.meta.dirname, path.dirname(chorusScriptPath())]
  for (const start of starts) {
    let cursor = start
    for (let depth = 0; depth < 8; depth += 1) {
      if (existsSync(path.join(cursor, 'package.json'))
        && existsSync(path.join(cursor, 'scripts', 'build-tools.mjs'))) {
        return cursor
      }
      const parent = path.dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
  }
  return null
}

/** 跑一次 `build-tools.mjs`（只认退出码与输出）。 */
function runBuildTools(root: string, ...flags: string[]): { code: number | null; out: string } {
  const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-tools.mjs'), ...flags], {
    cwd: root, encoding: 'utf-8', timeout: 30_000,
  })
  return { code: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() }
}

/** 取插件根，取不到就跳过（并把"缺什么"写进跳过原因）。 */
function needRoot(t: { skip(message?: string): void }): string | null {
  const root = pluginRoot()
  if (root === null) {
    t.skip('找不到插件根（需要 package.json + scripts/build-tools.mjs；把编译产物跑在仓库外时会这样）')
  }
  return root
}

test('chorusScriptPath：从 build/lib 与 build/lib-test 两条入口都命中发布物那一份', (t) => {
  const root = needRoot(t)
  if (root === null) return
  const shipped = path.join(root, 'build', 'tools', 'song', 'find_chorus.py')
  // 没有 build 产物时不能假装通过：说清该先跑什么。
  assert.equal(existsSync(shipped), true, `缺少 ${shipped}：先跑 npm run build（build 链里的 build:tools 会复制脚本）`)
  assert.equal(chorusScriptPath(path.join(root, 'build', 'lib', 'features', 'song')), shipped)
  assert.equal(chorusScriptPath(path.join(root, 'build', 'lib-test', 'src', 'features', 'song')), shipped)

  // 位置与文件名：`build/tools/song`（发布物）与 `tools/song`（源码树兜底）两种布局都认。
  const normalized = shipped.split(path.sep).join('/')
  assert.equal(normalized.includes('/build/tools/song/'), true, `发布物路径形状变了：${shipped}`)
  assert.equal(path.basename(shipped), 'find_chorus.py')
})

test('chorusScriptPath 默认形态：测试在仓库内跑时必须指向真实存在的脚本', (t) => {
  const root = needRoot(t)
  if (root === null) return
  // 默认形态从**测试文件自己的位置**上溯，所以只有在仓库内跑才有意义。
  // 把编译产物搬到别处跑时（只为跑单个用例）它当然会落空——那是运行方式的问题，
  // 不是脚本不见了，所以这里跳过而不是失败。
  const inside = import.meta.dirname.startsWith(root)
  if (!inside) {
    t.skip(`测试产物在仓库之外（${import.meta.dirname}），默认形态的上溯没有意义；请用 npm test`)
    return
  }
  const resolved = chorusScriptPath()
  assert.equal(existsSync(resolved), true, `chorusScriptPath() 指向一个不存在的文件：${resolved}`)
  assert.equal(
    resolved.split(path.sep).join('/').includes('/build/tools/song/')
      || resolved.split(path.sep).join('/').endsWith('/tools/song/find_chorus.py'),
    true,
    `脚本落在了意料之外的位置：${resolved}`,
  )
})

test('build/tools/song 里的脚本与 tools/song 是同一份内容（防"改了源码忘记重建"）', async (t) => {
  const root = needRoot(t)
  if (root === null) return
  const source = path.join(root, 'tools', 'song', 'find_chorus.py')
  const copy = path.join(root, 'build', 'tools', 'song', 'find_chorus.py')
  assert.equal(existsSync(source), true, `源码脚本不见了：${source}`)
  assert.equal(existsSync(copy), true, `缺少构建副本 ${copy}：先跑 npm run build`)
  // 比内容而不是比大小：算法改动常常行数不变。
  assert.equal(await fs.readFile(copy, 'utf-8'), await fs.readFile(source, 'utf-8'),
    'build/tools/song 里是旧版本：跑 npm run build（或 build:tools）重新复制')
})

test('build-tools.mjs：只复制 *.py；缺文件时 --check 变红', (t) => {
  const root = needRoot(t)
  if (root === null) return

  // 搭一套最小骨架：把**真实脚本**的复本放进去，root 由脚本自己按 import.meta.url 算出。
  const sandbox = mkdtempSync(path.join(tmpdir(), 'song-build-tools-'))
  try {
    mkdirSync(path.join(sandbox, 'scripts'), { recursive: true })
    mkdirSync(path.join(sandbox, 'tools', 'song'), { recursive: true })
    writeFileSync(path.join(sandbox, 'scripts', 'build-tools.mjs'),
      readFileSync(path.join(root, 'scripts', 'build-tools.mjs'), 'utf-8'), 'utf-8')
    writeFileSync(path.join(sandbox, 'tools', 'song', 'find_chorus.py'), '# 假脚本\n', 'utf-8')
    // 同目录放一个 .mjs：验收脚本不该跟着发布包走，这条要**真的被过滤**而不是碰巧没有。
    writeFileSync(path.join(sandbox, 'tools', 'song', 'e2e-acceptance.mjs'), '// 验收脚本\n', 'utf-8')

    const built = runBuildTools(sandbox)
    assert.equal(built.code, 0, built.out)
    assert.equal(existsSync(path.join(sandbox, 'build', 'tools', 'song', 'find_chorus.py')), true)
    assert.equal(existsSync(path.join(sandbox, 'build', 'tools', 'song', 'e2e-acceptance.mjs')), false,
      '只该复制 .py：e2e-acceptance.mjs 需要 RVC + NapCat，不该进发布物')

    assert.equal(runBuildTools(sandbox, '--check').code, 0)

    // 删掉副本 → --check 必须红。这条最能防"有人把这步从 build 链里摘掉"。
    rmSync(path.join(sandbox, 'build', 'tools', 'song', 'find_chorus.py'))
    const missing = runBuildTools(sandbox, '--check')
    assert.equal(missing.code, 1, `脚本缺失时 --check 必须失败：${missing.out}`)
    assert.match(missing.out, /缺|没有/)

    // 再跑一次普通模式应当自愈（先清旧副本再复制）。
    assert.equal(runBuildTools(sandbox).code, 0)
    assert.equal(runBuildTools(sandbox, '--check').code, 0)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test('build-tools.mjs：tools/song 下一个 .py 都没有时明确失败（不静默生成空目录）', (t) => {
  const root = needRoot(t)
  if (root === null) return
  const sandbox = mkdtempSync(path.join(tmpdir(), 'song-build-tools-empty-'))
  try {
    mkdirSync(path.join(sandbox, 'scripts'), { recursive: true })
    mkdirSync(path.join(sandbox, 'tools', 'song'), { recursive: true })
    writeFileSync(path.join(sandbox, 'scripts', 'build-tools.mjs'),
      readFileSync(path.join(root, 'scripts', 'build-tools.mjs'), 'utf-8'), 'utf-8')
    writeFileSync(path.join(sandbox, 'tools', 'song', 'only-a-readme.mjs'), '// 没有 .py\n', 'utf-8')
    const run = runBuildTools(sandbox)
    assert.equal(run.code, 1, `没有 .py 时必须失败，否则发布物会缺脚本：${run.out}`)
    assert.match(run.out, /没有/)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})
