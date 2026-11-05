/**
 * verify-gen-hook.mjs — 验证「模块代次」修复：热重载是否真的换掉**依赖模块**
 *
 * ══ 这个测试为什么必须存在（本次事故的教训）═══════════════════════════════════
 *   原缺陷的症状极其隐蔽：`dev_reload_package` 报「重载完成」，而运行中的插件
 *   **半新半旧**（入口是新的、依赖是旧的）。当时我据此读到一个旧行为，
 *   差点把自己正确的代码判成"过度修复"。
 *   ⇒ 判据：**"重载完成" ≠ "新代码在跑"** —— 必须有可判别探针。
 *
 * ══ 本测试的结构（对照实验，不是自评）══════════════════════════════════════════
 *   构造一个真的双文件插件包（index.js + dep.js），
 *   用**与注入器相同的方式**（代次+1 后动态 import 同一入口 URL）触发重载，
 *   断言 **dep 里的值也变了** —— 旧实现这里必然拿到旧值。
 *
 *   对照组：不 bump 代次再 import 一次 ⇒ 必须拿到**旧值**（证明入口 URL 不变时
 *   确实会命中缓存，即该测试的判据是有效判据，不是空过）。
 */
import { registerHooks } from 'node:module'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const DIR = 'C:/Users/Administrator/AppData/Local/Temp/gen-hook-verify'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

// ── 被测机制（与 src/index.ts 里的 installGenerationHook 同构）──────────────
const moduleGeneration = new Map()
const normalizeDir = (d) => d.replace(/\\/g, '/')
let installed = false
function installGenerationHook() {
  registerHooks({
    resolve(spec, ctx, next) {
      const r = next(spec, ctx)
      try {
        const url = r?.url
        if (typeof url !== 'string' || !url.startsWith('file:')) return r
        const gen = generationOf(url)
        if (gen <= 1) return r
        const u = new URL(url)
        if (u.searchParams.get('__mgen') === String(gen)) return r
        u.searchParams.set('__mgen', String(gen))
        return { ...r, url: u.href }
      } catch { return r }
    },
  })
  installed = true
}
function generationOf(url) {
  let p
  try { p = decodeURIComponent(new URL(url).pathname.replace(/^\//, '')).replace(/\\/g, '/') } catch { return 1 }
  if (/^[A-Za-z]:/.test(p) === false && process.platform === 'win32') p = decodeURIComponent(url).replace('file:///', '')
  let best = 1, bestLen = -1
  for (const [dir, gen] of moduleGeneration) {
    if ((p === dir || p.startsWith(dir + '/')) && dir.length > bestLen) { best = gen; bestLen = dir.length }
  }
  return best
}
function bumpGeneration(dir) {
  const k = normalizeDir(dir)
  const n = (moduleGeneration.get(k) ?? 1) + 1
  moduleGeneration.set(k, n)
  return n
}

// ── 夹具：一个真的"双文件插件包" ─────────────────────────────────────────────
const pkgDir = join(DIR, 'pkg')
mkdirSync(join(pkgDir, 'lib'), { recursive: true })
writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'fixture-pkg', type: 'module', main: './lib/index.js' }))
writeFileSync(join(pkgDir, 'lib', 'dep.js'), `export const V = 'OLD'\n`)
writeFileSync(join(pkgDir, 'lib', 'index.js'), `import { V } from './dep.js'\nexport const get = () => V\n`)

const ENTRY = pathToFileURL(join(pkgDir, 'lib', 'index.js')).href

let pass = 0, fail = 0
const chk = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  — ' + extra : ''}`) }
}

console.log('═══ 模块代次钩子 · 对照实验 ═══\n')
installGenerationHook()
chk('registerHooks 装上', installed)

// ① 首次加载（gen 1）
const a = await import(ENTRY)
chk('首次加载 ⇒ OLD', a.get() === 'OLD', `实际 ${a.get()}`)

// ② 改磁盘上的依赖
writeFileSync(join(pkgDir, 'lib', 'dep.js'), `export const V = 'NEW'\n`)

// ③ 对照组：**不 bump**，再 import 同一 URL
const ctrl = await import(ENTRY)
chk('【对照】不 bump ⇒ 仍是 OLD（证明缓存确实会命中，判据有效）',
  ctrl.get() === 'OLD', `实际 ${ctrl.get()}`)

// ④ 实验组：bump 后 import **同一个入口 URL**
bumpGeneration(pkgDir)
const after = await import(ENTRY)
chk('【实验】bump 后 ⇒ NEW（依赖被重读 = 修复生效）',
  after.get() === 'NEW', `实际 ${after.get()}`)

chk('入口 URL 本身没变（修复不依赖换入口）', ENTRY === pathToFileURL(join(pkgDir, 'lib', 'index.js')).href)

// ⑤ 连续 bump 仍然有效（多轮重载）
writeFileSync(join(pkgDir, 'lib', 'dep.js'), `export const V = 'THIRD'\n`)
bumpGeneration(pkgDir)
const third = await import(ENTRY)
chk('连续第二次重载 ⇒ THIRD', third.get() === 'THIRD', `实际 ${third.get()}`)

console.log(`\n═══ ${pass} 通过 / ${fail} 失败 ═══`)
process.exit(fail ? 1 : 0)
