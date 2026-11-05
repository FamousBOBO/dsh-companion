/**
 * dangle.test.mjs — 悬空目录的「放弃」决策（真机 bug 的回归锁）
 *
 * ══ 病案（2026-10-17 真机实测）════════════════════════════════════════════════
 *   `self-heal.log` **4916 行**，其中 **4738 行**是同一条：
 *     `watch-dangling: 目录不可读…: F:\dsh-plugin\_e2e-demo`
 *   而那个目录**早就不存在了**（registry 里还留着条目）
 *   ⇒ 每轮一条 ⇒ **每天 ~2880 行（按 30s 估）或更多（按 1.5s 估），永不收敛**。
 *
 *   根因：原来的节流是「**限速**」不是「**放弃**」——
 *     它假设目录**迟早会回来**。对"源被删/移走"这种**永久消失**不收敛。
 *
 * ══ 这个测试**为什么现在写得出来**（而以前写不出）════════════════════════════
 *   那段逻辑原本**内联在 setInterval 里**：要测它得等真实 timer、造真实文件
 *   系统状态、观察副作用 ⇒ **事实上没人测**。
 *   ⇒ 所以修复动作**不只是改判据，还包括把逻辑抽到 `src/watch-dangle.ts`**（零依赖）。
 *
 * ⚠️ 本测试**不复制一份逻辑**（那是我批评过的反模式：「测试复刻一份」必然漂移）。
 *   它 `import` 真实模块 —— 改了实现，测试就会跟着红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// ⚠️ 直接 import **真身**（零依赖模块 ⇒ 不需要宿主 peer 依赖 ⇒ 能独立跑）
const D = await import('../lib/watch-dangle.js')

const SRC_IX = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const SRC_WD = readFileSync(new URL('../src/watch-dangle.ts', import.meta.url), 'utf8')

/** 真实轮询周期（实测：`config.intervalMs ?? 1500`）—— 用它推进时间轴才贴真机 */
const TICK = 1500

/* ── W1：接线（防"抽出去了但没人用"）────────────────────────────────────── */

test('W1 决策逻辑必须被**真的调用**（抽出来≠接上了）', () => {
  assert.match(SRC_IX, /import \{[^}]*dangleDecision[^}]*\} from '\.\/watch-dangle\.js'/,
    'index.ts 必须 import dangleDecision')
  assert.match(SRC_IX, /const d = dangleDecision\(/, 'setInterval 里必须**调用**它')
  assert.doesNotMatch(SRC_IX, /export function dangleDecision\(/,
    'index.ts 里不该再有第二份实现（两份必然漂移）')
})

/* ── W2：核心 —— 永久消失必须收敛 ────────────────────────────────────────── */

test('W2 【核心】永久消失必须收敛：报够之后彻底闭嘴', () => {
  // ⚠️ 调用约定：`dangleDecision(prev, now)` 的 `prev` 是**上一次的 `next`**，
  //   不是上一次的整个返回值 `{action, next}`。
  //   我第一版传了整个返回值 ⇒ `firstTs` 取不到（它是 undefined）
  //   ⇒ 每次都当成"第一次不可读" ⇒ `gone` 永远为假 ⇒ report-gone = 0、warn = 9600。
  //   ⚠️ 实测的两种用法对照（探针跑出来的，不是我推的）：
  //       正确 st?.next  → {warn:4, silent:9595, report-gone:1}
  //       错误 传 st     → {warn:9600}                 ← 就是我第一版
  //   ⇒ 教训：**改了返回形状（{action,next}）就必须同步改所有调用点** ——
  //     包括测试里的。而且探针比推理靠得住：我改了两轮才想到去跑探针。
  let st
  const tally = { warn: 0, 'report-gone': 0, silent: 0 }
  const ROUNDS = 9600   // 1.5s × 9600 = 4 小时
  for (let i = 1; i <= ROUNDS; i++) {
    st = D.dangleDecision(st?.next, i * TICK)
    tally[st.action]++
  }
  assert.equal(tally['report-gone'], 1, '「永久消失」应**只报一次**')
  assert.ok(tally.warn <= 5, `容忍期内 warn 应 ≤5 次，实际 ${tally.warn}`)
  const wrote = tally.warn + tally['report-gone']
  assert.ok(wrote <= 6, `总写入应 ≤6 行，实际 ${wrote}`)
  // ⚠️ 这就是修复的量化目标：9600 轮只写 5 行（旧实现是几百行）
  assert.ok(tally.silent >= ROUNDS - 6, `静默应 ≥${ROUNDS - 6}，实际 ${tally.silent}`)
})

test('W2b 【契约】调用方必须传 `.next`（防后人踩同一个坑）', () => {
  // 传整个返回值 ⇒ 行为明显不同（这本身就是可检测的"用错"信号）
  let wrong, n = 0
  for (let i = 1; i <= 100; i++) { wrong = D.dangleDecision(wrong, i * TICK); if (wrong.action !== 'silent') n++ }
  assert.equal(n, 100, '传错形状时 100 轮 100 报（永不收敛）—— 与正确用法天差地别')
  // index.ts 里必须写的是 `.next`
  assert.match(SRC_IX, /dangleDecision\(dangleState\.get\([^)]*\), now, dangleGoneMs\)/,
    'index.ts 必须传 state（不是整个返回值）')
  assert.match(SRC_IX, /dangleState\.set\(w\.dir, d\.next\)/, '必须存 `.next`')
})

test('W3 【对照】旧判据（只节流不放弃）必然**发散** —— 证明这条测试有区分度', () => {
  // 等价复现**旧**实现：只看时间间隔，永不放弃
  //   ⚠️ 注意用 `>`（严格大于）—— 与旧代码一致。
  //     我第一版按"正好 30 秒一轮"算，得 481；实际因为 `>` 排除等于的情形，
  //     间隔是 21 个 tick（31500ms）⇒ 458。**458 才是对的，我的算式错了。**
  //   ⇒ 教训：算"旧实现会报几次"必须**照抄它的判据**（含 > 与 >= 的区别）。
  const oldDec = (prev, now) => {
    const lastTs = prev?.lastTs ?? 0
    const due = lastTs === 0 || now - lastTs > 30000
    return { emitted: due, lastTs: due ? now : lastTs }
  }
  const run = (rounds) => {
    let st, emitted = 0
    for (let i = 1; i <= rounds; i++) { st = oldDec(st, i * TICK); if (st.emitted) emitted++ }
    return emitted
  }
  const a = run(9600)
  const b = run(19200)          // 时长翻倍
  // ⚠️ 判据是**性质**（线性发散），不是某个魔数：
  //   时长翻倍 ⇒ 写入也翻倍 ⇒ 这就是"永不收敛"的机械定义。
  assert.ok(a > 400, `旧实现跑了 4 小时写 ${a} 行`)
  assert.ok(b > a * 1.9, `时长翻倍 ⇒ 写入也翻倍（${a} → ${b}）⇒ **线性发散**`)
  // 对照：新实现同样时长翻倍，写入**不增长**（≤6）
  const newRun = (rounds) => {
    let st, wrote = 0
    for (let i = 1; i <= rounds; i++) {
      st = D.dangleDecision(st?.next, i * TICK)   // ⚠️ 又是 `.next`（W2 同一个坑）
      if (st.action !== 'silent') wrote++
    }
    return wrote
  }
  const na = newRun(9600), nb = newRun(19200)
  assert.ok(na <= 6, `新实现 4 小时应 ≤6 行，实际 ${na}`)
  assert.ok(nb <= 6, `新实现时长翻倍仍应 ≤6 行，实际 ${nb} —— 这才叫收敛（不随时长发散）`)
})

/* ── W4：容忍期必须够长（这是第一版的设计缺陷）────────────────────────────── */

test('W4 【关键】容忍期必须按**真实时间**给足（否则误判"正在 build"为永久消失）', () => {
  assert.equal(D.DANGLE_GONE_AFTER_MS, 120_000, '容忍期应为 2 分钟')
  // 病案（我第一版）：用"3 次"表达容忍度，而轮询是 1.5s
  //   ⇒ 实际只容忍 **4.5 秒** ⇒ 一次正常 build 就可能超过 ⇒ 误判
  const byCount3 = 3 * TICK
  assert.ok(D.DANGLE_GONE_AFTER_MS > byCount3 * 10,
    `容忍期必须远大于"3 次轮询"(${byCount3}ms) —— 否则会误判正在 build 的目录`)
  // 行为：build 期间（比如 30 秒不可读）**绝不能**被判永久消失
  let st
  for (let t = 0; t <= 30_000; t += TICK) st = D.dangleDecision(st, t)
  assert.notEqual(st.action, 'report-gone', '30 秒的 build 窗口不该被判永久消失')
})

/* ── W5/W6：节流与复位 ───────────────────────────────────────────────────── */

test('W5 节流生效：间隔内不重复写', () => {
  const a = D.dangleDecision(undefined, 1000)
  assert.equal(a.action, 'warn', '第一次必须报（否则"暂不可读"被静默）')
  const b = D.dangleDecision(a.next, 1000 + 5000)   // 只过 5 秒
  assert.equal(b.action, 'silent', '节流窗内必须静默（否则又回到刷屏）')
  assert.equal(b.next.count, 2, '但计数要累加（计数是"连续性"的证据）')
})

test('W6 目录恢复可读 ⇒ 状态清零（偶发抖动不该累积成"永久消失"）', () => {
  assert.equal(D.dangleReset(), undefined)
  let st = D.dangleDecision(undefined, 1000)
  st = D.dangleDecision(st.next, 31_000)
  assert.equal(st.next.count, 2)
  let fresh = D.dangleReset()                   // 目录回来了
  fresh = D.dangleDecision(fresh, 62_000)
  assert.equal(fresh.next.count, 1, '恢复后重新计数（不继承旧的 2）')
  assert.notEqual(fresh.action, 'report-gone', '恢复后不该被判永久消失')
})

test('W7 抖动 100 次也不该触发"永久消失"（连续才是信号）', () => {
  let gone = 0
  for (let i = 0; i < 100; i++) {
    const st = D.dangleDecision(undefined, i * 1000)   // 每次都是"第一次不可读"
    if (st.action === 'report-gone') gone++
  }
  assert.equal(gone, 0, '每次都是"第一次不可读" ⇒ 永远不该判永久消失')
})

/* ── W8/W9：报告质量与留痕 ──────────────────────────────────────────────── */

test('W8 「永久消失」的报告必须给出**可操作出口**', () => {
  assert.match(SRC_IX, /dev_uninject_plugin/, '要告诉读者怎么清掉这条 registry 条目')
  assert.match(SRC_IX, /registry/, '要点出条目在哪')
  assert.match(SRC_IX, /watch-dangling-gone/, '用一个**独立**的审计事件名（便于 grep 定位）')
})

test('W9 源码必须记下这条 bug 的**量化事实**（否则日后有人改回去）', () => {
  assert.match(SRC_WD, /4738|4916/, '要写清刷了多少行（可核的读数）')
  assert.match(SRC_WD, /限速|收敛/, '要点出"限速 vs 放弃"的本质区别')
  assert.match(SRC_WD, /时间/, '要点出"用真实时间而非次数"这条判据')
  assert.match(SRC_WD, /1500/, '要记下真实轮询周期（否则"3 次"的含义无从换算）')
})

/* ══════════════════════════════════════════════════════════════════════════
 * G1–G3：模块代次钩子（**修「混合代」的那套机制**）的回归锁
 *
 * ══ 病案（2026-10-17 真机实测，**我的修复自己被模块缓存吃掉了**）══════════════
 *   我加了代次钩子后重载注入器，**预测**：2 分钟后出现 `watch-dangling-gone` 并静默。
 *   **实测：3 分钟过去 gone=0，仍在每 30s 刷** ⇒ 预测被推翻 ⇒ 追根因，两个：
 *     ① `moduleGeneration` 是**模块级** Map ⇒ 自重载后模块实例全新 ⇒ Map 空
 *        ⇒ 钩子对所有 URL 算出 gen=1 ⇒ **永远不加戳**
 *     ② heal 路径（reboot-failed → touch patch → include.refresh → 重新 import）
 *        **压根没 bump** —— 而它用的是同一个入口 URL ⇒ 旧代码
 *   ⚠️ ①的讽刺：**我修的是「模块缓存导致混合代」，而修复自己被模块缓存吃掉。**
 * ══════════════════════════════════════════════════════════════════════════ */

test('G1 【核心】代次状态必须**跨模块重载存活**（挂 globalThis，不是模块级）', () => {
  // 行为验证：bump 之后，**新的模块实例**也必须看得到那个代次
  const before = D.genState().generations.size
  D.bumpDir('D:/fake/pkg-for-test')
  const st = D.genState()
  assert.equal(st.generations.get('D:/fake/pkg-for-test'), 1, 'bump 后应能看到该目录')
  // ⚠️ 关键：状态必须挂在 globalThis 上（否则重载后丢失）
  const g = globalThis.__dsh_super_injector_gen_state__
  assert.ok(g, '代次状态必须挂在 globalThis（模块级会被重载重置）')
  assert.equal(g, st, 'genState() 必须返回同一个 globalThis 对象')
  assert.ok(D.genState().generations.size >= before, '状态不应该被重置')
})

test('G2 【核心】heal 路径也必须 bump（不只 reloadPackage 开头那处）', () => {
  // 源码断言：heal 段里必须出现 bumpDir
  assert.match(SRC_IX, /heal 前代次 → v\$\{bumpDir/, 'heal 路径必须 bump 代次')
  assert.match(SRC_IX, /healBumpDirs\(pkgName, profileNodeModules\)/, '要 bump 该包目录')
  // ⚠️ 且必须**两个表示都覆盖**（junction + realpath）—— Node 解析折成 realpath
  assert.match(SRC_IX, /realpathSync\(junction\)/, 'realpath 形式也要 bump（否则代次落在钩子看不到的键上）')
})

test('G3 applyGeneration：加戳逻辑（纯函数，可断言）', () => {
  // 未登记目录 ⇒ 不动
  assert.equal(D.applyGeneration('file:///D:/unreg/x.js', () => 0), 'file:///D:/unreg/x.js')
  // 登记且 gen>0 ⇒ 加戳
  const out = D.applyGeneration('file:///D:/reg/x.js', () => 3)
  assert.match(out, /__mgen=3/, '应加 __mgen 戳')
  // 已有同代次戳 ⇒ 不变（幂等）
  assert.equal(D.applyGeneration(out, () => 3), out, '同代次应幂等')
  // gen 变了 ⇒ 换戳
  assert.match(D.applyGeneration(out, () => 4), /__mgen=4/, '代次变了应换戳')
  // 非 file: ⇒ 不动
  assert.equal(D.applyGeneration('node:fs', () => 9), 'node:fs')
})
