/**
 * verify-deployed.mjs — 用**部署后的真产物**验证代次机制
 *
 * ══ 为什么要这个（不是重复 verify-gen-hook）═══════════════════════════════════
 *   `verify-gen-hook.mjs` 测的是**我在测试里复刻的机制**（同构但独立的一份）。
 *   本脚本改为 **import 部署路径 `/d/dsh/super-injector/lib/watch-dangle.js`** ——
 *   即宿主实际会加载的那份产物。
 *   ⇒ 判据：**"机制对" ≠ "部署的那份对"**（中间隔着 tsc 编译、部署拷贝）。
 *
 * ⚠️ 本脚本**不注入任何插件、不注册任何工具**（2026-10-17 事故的教训：
 *   一个 schema 写错的测试夹具会让**整个会话**瘫痪）。
 *   它只在**独立进程**里操作临时目录 —— 零共享路径暴露。
 */
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const DEPLOYED = 'D:/dsh/super-injector/lib/watch-dangle.js'
const DIR = 'C:/Users/Administrator/AppData/Local/Temp/deployed-verify'
let pass = 0, fail = 0
const chk = (n, c, e = '') => { c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}${e ? '  — ' + e : ''}`)) }

console.log('═══ 部署产物的代次机制验证（零插件注入）═══\n')

// ① 产物必须导出新加的四个符号（证明部署的是含修复的那份）
const art = readFileSync(DEPLOYED, 'utf8')
for (const sym of ['genState', 'bumpDir', 'genOf', 'applyGeneration']) {
  chk(`产物导出 ${sym}`, new RegExp(`export (function|const) ${sym}`).test(art))
}
chk('产物用 globalThis 存状态（**跨模块重载存活**）',
  art.includes('__dsh_super_injector_gen_state__') && art.includes('globalThis'))

const D = await import(pathToFileURL(DEPLOYED).href)

// ② 进程级状态：bump 后**新取的 genState() 仍能看到**（模拟重载后取）
D.bumpDir(DIR)
const st = D.genState()
chk('bump 后状态可见', st.generations.get(DIR.replace(/\\/g, '/')) === 1,
  `实际 ${st.generations.get(DIR.replace(/\\/g, '/'))}`)
chk('状态挂在 globalThis（重载后仍在）', globalThis.__dsh_super_injector_gen_state__ === st)

// ③ applyGeneration 行为（真产物）
const u0 = pathToFileURL(join(DIR, 'x.js')).href
chk('登记目录 + gen=1 ⇒ 加 __mgen=1', /__mgen=1/.test(D.applyGeneration(u0)))
chk('未登记目录 ⇒ 不加戳',
  !D.applyGeneration('file:///D:/never-registered/y.js').includes('__mgen'))
D.bumpDir(DIR)
chk('再 bump ⇒ __mgen=2', /__mgen=2/.test(D.applyGeneration(u0)))

// ④ **端到端**：真 import 双文件包，改依赖，bump，再 import ⇒ 应拿到新值
rmSync(DIR, { recursive: true, force: true })
mkdirSync(join(DIR, 'pkg', 'lib'), { recursive: true })
writeFileSync(join(DIR, 'pkg', 'package.json'), JSON.stringify({ name: 'p', type: 'module' }))
const depF = join(DIR, 'pkg', 'lib', 'dep.js')
const idxF = join(DIR, 'pkg', 'lib', 'index.js')
writeFileSync(depF, `export const V = 'OLD'\n`)
writeFileSync(idxF, `import { V } from './dep.js'\nexport const get = () => V\n`)

// 真实地装钩子（与插件里同构：resolve 里调 applyGeneration）
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx)
    try {
      if (typeof r?.url !== 'string') return r
      const n = D.applyGeneration(r.url)
      return n === r.url ? r : { ...r, url: n }
    } catch { return r }
  },
})

const ENTRY = pathToFileURL(idxF).href
// ⚠️ 首次：gen 还是 2（③ 里 bump 过），所以要先把该目录代次对齐到"首次"语义。
//   简化：直接再 bump 到 3，用 3 作"当前代次"。
D.bumpDir(join(DIR, 'pkg'))
const a = await import(ENTRY)
chk('首次加载 ⇒ OLD', a.get() === 'OLD', a.get())

writeFileSync(depF, `export const V = 'NEW'\n`)
const ctrl = await import(ENTRY)
chk('【对照】不 bump ⇒ 仍 OLD（缓存真存在，判据有效）', ctrl.get() === 'OLD', ctrl.get())

D.bumpDir(join(DIR, 'pkg'))
const b = await import(ENTRY)
chk('【实验】bump 后 ⇒ NEW（**依赖被重读**）', b.get() === 'NEW', b.get())

console.log(`\n═══ ${pass} 通过 / ${fail} 失败 ═══`)
process.exit(fail ? 1 : 0)
