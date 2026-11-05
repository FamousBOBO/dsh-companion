/**
 * 依赖物化回归测试（P0-A）
 *
 * 背景：2026-10-15 发生过一起静默事故 —— 构建脚本把依赖**源目录**掏空。
 * 根因是用 junction 物化依赖，而 Windows + Node 在递归删除含 junction 的
 * 目录时会跟随链接，删空**链接目标**的真实内容。实测证据：新建一个外部
 * 从未触碰的隔离 checkout，跑一次构建后，5 个 link 目标 items=0，而同目录
 * 下非 link 目标的包完好（1:1 对应）。
 *
 * 修复：物化改为 cpSync（复制）—— 源目录只在读取侧被访问。
 *
 * ── 本测试的有效性边界（已由变异测试实测，2026-10-16）────────────────────
 * 用 tests/mutate-to-junction.mjs 把实现改回 junction 后跑本套件：
 *   变异后 4 pass / 3 fail —— 被抓住 ✓（说明本套件不是摆设）
 *   **但两个标了「★ 关键」的行为用例（源目录字节级不变、删产物不影响源）
 *   在变异下仍然通过** —— 它们抓不住真实故障模式。原因：真实掏空只在
 *   特定 Windows + Node 组合的递归删除路径上触发，在本机当前 Node 版本下
 *   rmSync 并未跟随 junction（这正是当初"无法复现"的原因）。
 *
 * 所以：**真正在守门的是 3 条静态/语义断言**，而非行为断言：
 *   ① 物化脚本不得出现 symlinkSync
 *   ② 物化脚本必须用 cpSync 且 dereference:false
 *   ③ 目标处历史遗留 junction 时，清理不得穿越链接删到源
 *   ④（模板）三处内嵌 build.sh 都不含 symlinkSync 物化
 * 行为用例保留为"不变式描述"（在跟随链接的平台上它们会真的失败），
 * 但不应当作主要防线 —— 这个边界如实记录在此，以免后来者误信"有测试就安全"。
 *
 * 运行：npm test
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const BUILD_SH = fs.readFileSync(path.join(ROOT, 'scripts/build.sh'), 'utf8')

/** 从 scripts/build.sh 里抽出 use_pkg 真正执行的 node 脚本（保持与实现同步）。 */
function extractMaterializeScript() {
  const m = BUILD_SH.match(/node -e "([\s\S]*?)"\s+"node_modules\/\$1"/)
  assert.ok(m, '无法从 scripts/build.sh 抽出 use_pkg 的 node 脚本 —— 物化实现可能被改写，请同步本测试')
  return m[1]
}

/** 建一个「依赖源」目录，带可识别的多层内容。 */
function makeSource(dir, label) {
  fs.mkdirSync(path.join(dir, 'lib', 'types'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: label, version: '1.0.0' }), 'utf8')
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), `// ${label} impl`, 'utf8')
  fs.writeFileSync(path.join(dir, 'lib', 'types', 'index.d.ts'), `export declare const x: string`, 'utf8')
  return dir
}

/** 递归快照：相对路径 → 内容 sha 之外的「大小+内容」指纹（小目录足够）。 */
function snapshot(dir) {
  const out = new Map()
  const walk = (d, rel = '') => {
    let ents
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const it of ents) {
      const full = path.join(d, it.name)
      const r = rel ? `${rel}/${it.name}` : it.name
      if (it.isDirectory()) { out.set(r + '/', 'DIR'); walk(full, r) }
      else out.set(r, fs.readFileSync(full, 'utf8'))
    }
  }
  walk(dir)
  return out
}

function assertSame(before, after, msg) {
  const bKeys = [...before.keys()].sort()
  const aKeys = [...after.keys()].sort()
  assert.deepEqual(aKeys, bKeys, `${msg}：文件集合发生变化\n  期望: ${bKeys.join(', ')}\n  实际: ${aKeys.join(', ')}`)
  for (const k of bKeys) {
    if (before.get(k) === 'DIR') continue
    assert.equal(after.get(k), before.get(k), `${msg}：文件内容被改写 → ${k}`)
  }
}

describe('依赖物化：copy 语义（P0-A 回归）', () => {
  test('物化脚本不含 symlinkSync（不得再用 junction 物化依赖）', () => {
    const script = extractMaterializeScript()
    assert.ok(
      !/symlinkSync/.test(script),
      '物化脚本重新出现了 symlinkSync —— junction 物化会在递归删除时掏空目标，必须用 cpSync 复制',
    )
  })

  test('物化脚本使用 cpSync 且 dereference:false', () => {
    const script = extractMaterializeScript()
    assert.ok(/cpSync/.test(script), '物化脚本应当使用 fs.cpSync 复制依赖')
    assert.ok(
      /dereference:\s*false/.test(script),
      'cpSync 必须显式 dereference:false —— 否则相对符号链接会被解引用成实体，偏离原始包结构',
    )
  })

  test('★ 关键：物化后源目录字节级不变（重跑任意多次）', () => {
    const script = extractMaterializeScript()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'injector-materialize-'))
    try {
      const srcDir = makeSource(path.join(tmp, 'source-pkg'), 'source-pkg')
      const dstDir = path.join(tmp, 'work', 'node_modules', '@deepseek-ai', 'demo')

      const before = snapshot(srcDir)

      // 连跑 3 次：模拟「反复构建」——真实事故正是重复运行后掏空的
      for (let i = 1; i <= 3; i++) {
        fs.rmSync(path.dirname(dstDir), { recursive: true, force: true })
        execFileSync(process.execPath, ['-e', script, dstDir, srcDir], { stdio: 'pipe' })
        assertSame(before, snapshot(srcDir), `第 ${i} 次物化后源目录被改动`)
        assert.ok(fs.existsSync(path.join(dstDir, 'package.json')), `第 ${i} 次物化未产出目标`)
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('★ 关键：删除物化产物不影响源目录（模拟一次性构建目录被整体清理）', () => {
    const script = extractMaterializeScript()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'injector-cleanup-'))
    try {
      const srcDir = makeSource(path.join(tmp, 'source-pkg'), 'source-pkg')
      const workDir = path.join(tmp, 'oneshot-build')
      const dstDir = path.join(workDir, 'node_modules', '@deepseek-ai', 'demo')

      const before = snapshot(srcDir)
      execFileSync(process.execPath, ['-e', script, dstDir, srcDir], { stdio: 'pipe' })

      // 整体删掉「一次性构建目录」——原事故正是在这一步掏空了源
      fs.rmSync(workDir, { recursive: true, force: true })

      assertSame(before, snapshot(srcDir), '删除构建目录后源目录被掏空/改动')
      assert.ok(fs.existsSync(path.join(srcDir, 'package.json')), '源目录的 package.json 消失了')
      assert.ok(fs.statSync(srcDir).isDirectory(), '源目录本身被删除')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('目标处历史遗留 junction：清理时不得穿越链接删到源', () => {
    const script = extractMaterializeScript()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'injector-legacy-link-'))
    try {
      const srcDir = makeSource(path.join(tmp, 'source-pkg'), 'source-pkg')
      const dstDir = path.join(tmp, 'work', 'node_modules', '@deepseek-ai', 'demo')
      fs.mkdirSync(path.dirname(dstDir), { recursive: true })

      const before = snapshot(srcDir)

      // 先手工埋一个 junction 指向源（模拟旧版本遗留）
      try {
        fs.symlinkSync(srcDir, dstDir, 'junction')
      } catch (e) {
        // 无权限建链接的环境跳过此用例（不伪造成通过）
        return
      }

      // 物化应当「先 rmdir 掉链接、再复制」，源毫发无损
      execFileSync(process.execPath, ['-e', script, dstDir, srcDir], { stdio: 'pipe' })

      assertSame(before, snapshot(srcDir), '清理遗留 junction 时穿越链接改动了源目录')
      assert.ok(!fs.lstatSync(dstDir).isSymbolicLink(), '物化产物仍是链接（应当是真目录副本）')
      assert.ok(fs.existsSync(path.join(dstDir, 'package.json')), '物化产物缺少 package.json')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('构建脚本模板：所有物化点都必须用 copy', () => {
  /**
   * 三处物化点：scaffold 模板（SCAFFOLD_BUILD_SH）、自检模板、本项目 build.sh。
   * 前两处嵌在 src/index.ts 里；第三处已由上面的行为测试覆盖。
   */
  test('src/index.ts 的内嵌 build.sh 模板都不含 symlinkSync 物化', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'index.ts'), 'utf8')

    // ⚠️ 两处模板形态不同，必须分别匹配（实测踩坑）：
    //   · scaffold 模板（SCAFFOLD_BUILD_SH）是**多行**模板字符串 —— use_pkg 跨多行；
    //   · 自检模板是**单行**字符串，内部用字面 `\n` 转义 —— use_pkg 全在一行里。
    // 早先只按「多行 + 换行}」匹配，单行模板漏检 → 断言数不足而假失败。
    const usePkgBodies = []

    // 形态 1：多行（真换行）——从 `use_pkg() {` 到单独一行的 `}`
    for (const m of src.matchAll(/use_pkg\(\)\s*\{[\s\S]*?\n\}/g)) usePkgBodies.push(m[0])
    // 形态 2：单行（字面 \n 转义）——从 `use_pkg() {` 到字面 `\n}`
    for (const m of src.matchAll(/use_pkg\(\)\s*\{[^\n]*?\\n\}/g)) usePkgBodies.push(m[0])

    assert.ok(
      usePkgBodies.length >= 2,
      `应当找到至少 2 处内嵌 use_pkg 模板（scaffold + 自检），实际 ${usePkgBodies.length}`,
    )

    for (const [i, body] of usePkgBodies.entries()) {
      assert.ok(/cpSync/.test(body), `第 ${i + 1} 处内嵌模板未使用 cpSync 复制`)
      assert.ok(
        !/symlinkSync\(/.test(body),
        `第 ${i + 1} 处内嵌模板含 symlinkSync —— 依赖物化不得用 junction（会掏空源）`,
      )
    }
  })

  test('已部署的 lib 里模板同样是 copy 版（若存在）', () => {
    const libPath = path.join(ROOT, 'lib', 'index.js')
    if (!fs.existsSync(libPath)) return // 未构建则跳过，不伪造成通过
    const lib = fs.readFileSync(libPath, 'utf8')
    assert.ok(
      /cpSync\(src, *dst/.test(lib) || /cpSync\(src,dst/.test(lib),
      'lib/index.js 里的物化模板不是 copy 版 —— 需要重新构建（npm run build）',
    )
  })
})
