/**
 * watch-dangle.ts — 悬空目录的「放弃」决策（**零依赖纯函数**）
 *
 * ══ 为什么单独一个文件 ═════════════════════════════════════════════════════════
 *   这段逻辑原本**内联在 `setInterval` 里**（index.ts）。内联的后果：
 *     · 要测它得等真实 timer、造真实文件系统状态、观察副作用 ⇒ **事实上没人测**
 *     · 于是"永不放弃"这个缺陷活了很久：`self-heal.log` 被刷 **4738 行**，
 *       刷的是一个**早就不存在**的目录，**每 30 秒一条、每天 ~2880 行**。
 *
 *   ⇒ 拆成独立文件的两个理由（都是**可测性**）：
 *     ① 零依赖 ⇒ 测试可以 `import` **真身**，不必"复刻一份"（复刻必然漂移）
 *     ② 纯函数 ⇒ 输入 (state, now) 输出 decision，无 timer 无文件系统
 *
 * ⚠️ 判据（本项目反复栽过）：**不可测的逻辑 = 没人测的逻辑。**
 *   所以"抽出来"不是洁癖，是修复的一部分 —— 不抽出来，这个测试根本写不出。
 *
 * ══ 它解决什么 ═══════════════════════════════════════════════════════════════
 *   旧实现是「**限速**」不是「**放弃**」：每 30 秒报一次，假设目录**迟早会回来**。
 *   对"源被删/移走"这种**永久消失**，它**永不收敛**。
 *
 *   ⚠️ 关键判据：**"暂时"与"永久"必须用「次数」区分，不能靠时间间隔** ——
 *     同一个 30 秒间隔，既可能是"正在 build"（该等），
 *     也可能是"已经删了三天"（该放弃）。时间维度上二者**不可区分**。
 */

export type DangleState = {
  count: number
  lastTs: number
  /** 第一次发现它不可读的时刻（判"连续多久"的起点） */
  firstTs: number
  /** 是否已经报过「永久消失」（报过就彻底闭嘴） */
  goneReported: boolean
} | undefined

export type DangleAction =
  /** 容忍期内：节流上报（可能只是暂时不可读 —— 正在 build / 权限抖动） */
  | 'warn'
  /** 越过容忍期：**只报这一次**（并给出可操作出口），之后彻底闭嘴 */
  | 'report-gone'
  /** 静默：容忍期内未到上报点，或已报过（重复报没有新信息） */
  | 'silent'

export interface DangleDecision {
  action: DangleAction
  next: NonNullable<DangleState>
}

/**
 * 上报节流窗口（同一条悬空消息最多这么频繁地写一次日志）。
 *
 * ⚠️ 这个值与「轮询周期」**无关** —— 轮询周期是 `intervalMs`（实测缺省 **1500ms**，
 *   见 index.ts `config.intervalMs ?? 1500`）。
 *   我第一版把容忍度写成"3 次"，于是实际只容忍了 **4.5 秒** ——
 *   而一次正常 build 就可能超过 ⇒ **会把"正在 build"误判成"永久消失"**。
 *   ⇒ 教训：**判据里的"次数"必须换算成"真实时间"再审视**，
 *     否则轮询周期一改（1500↔60000），同一个数字的含义就变了 40 倍。
 */
export const DANGLE_THROTTLE_MS = 30_000

/**
 * 判为「永久消失」前，必须**连续不可读**多久（真实时间）。
 *
 * ⚠️ 为什么用**时间**而不是次数（这是第一版的错）：
 *   轮询周期是**可配置**的（1500ms ~ 任意）。用"次数"表达容忍度 ⇒
 *   同一个 `3` 在 1500ms 下是 4.5 秒、在 60000ms 下是 3 分钟 —— **含义漂移**。
 *   而这里的意图是**时间语义**：「给它 2 分钟，还不回来就是真没了」。
 *   ⇒ 判据：**表达意图要用与意图同量纲的量**（时间是时间，次数是次数）。
 *
 * 为什么是 2 分钟：p50 的 build 远小于此；而"源被删/移走"是永久的 ——
 * 2 分钟足够区分二者，又不至于让真消失的条目刷屏太久（最多 ~5 行而非无限行）。
 */
export const DANGLE_GONE_AFTER_MS = 120_000

/**
 * 一次轮询的决策。**纯函数**：同入参必同出参，无时钟无 IO。
 *
 * @param prev 该目录的历史状态（`undefined` = 第一次发现它不可读）
 * @param now  当前时刻（由调用方传入 —— 便于测试推进时间轴）
 * @param goneAfterMs 连续不可读多久后判「永久消失」（真实时间语义）
 * @param throttleMs  同一目录的上报节流窗口
 */
export function dangleDecision(
  prev: DangleState,
  now: number,
  goneAfterMs: number = DANGLE_GONE_AFTER_MS,
  throttleMs: number = DANGLE_THROTTLE_MS,
): DangleDecision {
  const firstTs = prev?.firstTs ?? now
  const count = (prev?.count ?? 0) + 1
  const goneReported = prev?.goneReported ?? false
  const lastTs = prev?.lastTs ?? 0
  const gone = now - firstTs >= goneAfterMs

  // ① 容忍期内：节流上报（目录可能只是暂时不可读）
  if (!gone) {
    const due = lastTs === 0 || now - lastTs >= throttleMs
    return due
      ? { action: 'warn', next: { count, lastTs: now, firstTs, goneReported } }
      : { action: 'silent', next: { count, lastTs, firstTs, goneReported } }
  }

  // ② 越过容忍期、尚未报过：报一次「永久消失」（带可操作出口）
  if (!goneReported) {
    return { action: 'report-gone', next: { count, lastTs: now, firstTs, goneReported: true } }
  }

  // ③ 已报过：静默（重复报没有新信息）
  return { action: 'silent', next: { count, lastTs, firstTs, goneReported: true } }
}

/**
 * 目录恢复可读时的复位。返回 `undefined` 表示"清零"。
 *
 * ⚠️ 为什么需要它：没有复位，**偶发抖动**（临时的权限抖动/半秒的 build 窗口）
 *   会累积成"永久消失"的误判 ⇒ 真去重载时反而不动了。
 *   ⇒ 判据：**"连续不可读"才是信号** —— 一恢复就清零。
 */
export function dangleReset(): DangleState {
  return undefined
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 进程级状态槽 —— **模块重载后必须还活着**
 *
 * ══ 🔴 v0.3.6b 修（真机实测：修复「没有生效」，根因是我自己引入的）═══════════
 * 病案（2026-10-17 实测，`self-heal.log` 可核）：
 *   我加了「模块代次」钩子后重载注入器，**预测**：2 分钟后应出现
 *   `watch-dangling-gone` 并彻底静默。**实测：3 分钟过去，gone = 0，仍在每 30s 刷。**
 *   ⇒ 预测被推翻 ⇒ 追根因。
 *
 * 根因（**模块级变量在重载时被重置**）：
 *   `moduleGeneration` 是**模块级** `new Map()` ⇒
 *   注入器自我重载时，它的**模块实例是全新的** ⇒ **Map 是空的** ⇒
 *   新实例的 `resolve` 钩子对任何 URL 都算出 `gen = 1`
 *   ⇒ `if (gen <= 1) return result` ⇒ **永远不加戳** ⇒ 又是旧代码。
 *
 * ⚠️ 讽刺之处：**我修的是「模块缓存导致混合代」，而我的修复自己被模块缓存吃掉了。**
 *   ⇒ 判据（本项目第 N 次同族）：**跨重载要存活的状态，不能放在会被重载的模块里。**
 *     必须挂到 `globalThis`（进程级），或落到磁盘。
 *
 * 实现：把状态挂在 `globalThis.__dshSuperInjectorState`（带类型守卫）。
 *   ⚠️ 用 Symbol.for 而不是裸字符串？—— 不：这里需要**跨模块实例**共享，
 *     而 `Symbol.for` 恰好也是进程级（同一 registry）⇒ 两者都行。
 *     选裸字符串键是为了**可诊断**（能在 devtools / 断点里直接看到）。
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface GenHookGlobalState {
  /** 目录(realpath, 正斜杠) → 当前代次 */
  generations: Map<string, number>
  /** 钩子是否已装（进程级：装一次就够，重载不必重装） */
  installed: boolean
  /** 为什么没装（诊断） */
  reason: string
}

/* ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 已知边界（**实测确认，不是推测**）：注入器**无法自我热重载换代码**
 *
 * ══ 实测证据（2026-10-17，`self-heal.log` 可核）═══════════════════════════════
 *   我给注入器加了代次钩子后，连续两次 `dev_reload_package super-injector`，
 *   **预测**：2 分钟后出现 `watch-dangling-gone` 并停止刷屏。
 *   **两次实测：gone 都是 0，仍在每 30s 刷** ⇒ 预测被推翻。
 *
 *   决定性证据是日志里的**计数器**（可机械判，不靠推理）：
 *     · 新代码用 `bumpDir`（`?? 0`）⇒ 首次 bump 应打 **v1**
 *     · 旧代码用 `bumpGeneration`（`?? 1`）⇒ 首次 bump 打 **v2**
 *     实测日志里只有 **v2 / v3**，**没有 v1** ⇒ **跑的是旧代码**。
 *
 * ══ 为什么（硬约束，与时序有关）═══════════════════════════════════════════════
 *   自重载的实际路径：
 *     `reloadPackage` → bump → `self-reload` → **`reboot-failed`**
 *     → heal 路径（touch patch → `include.refresh` 重新装配）
 *     → loader 用**同一个入口 URL** 再 `import` 一次
 *     → **命中 Node 的 ESM 注册表**（"正在执行 import 的"与"被缓存的"是**同一进程**）
 *     ⇒ 旧模块实例原封不动拿回来。
 *
 *   ⚠️ 我加的 `globalThis` 状态**解决不了这一条** —— 它保证"重载后状态还在"，
 *     但前提是**新模块真的被求值了**。而这里连新模块都没被求值。
 *   ⚠️ `reboot-failed: selfEntry 无官方 _dispose（loader 契约缺失）` 是前因：
 *     官方自杀式重启路径走不通 ⇒ 才落到 heal ⇒ heal 不换 URL ⇒ 缓存命中。
 *
 * ══ 影响范围（诚实划界）═══════════════════════════════════════════════════════
 *   ✅ **对别的插件有效** —— `bumpDir` 已在跑（日志 v2/v3 就是证据）。
 *      改任意**别的**插件 → 重载 → 它的依赖树会被真正重读。
 *   ❌ **对注入器自身无效** —— 必须**重启宿主**才能换代码。
 *   ⇒ 这一条要写进 README/INSTALL，免得下一个人也以为"重载了就生效"。
 *
 * ══ 教训（本项目第 N 次同族）══════════════════════════════════════════════════
 *   **"重载完成" ≠ "新代码在跑"。** 必须有**可判别探针**（计数器/独立事件名）——
 *   而这次正是靠 `gen-bump` 的 v1-vs-v2 才定性的；光看"重载成功"会一直误判。
 * ═══════════════════════════════════════════════════════════════════════════ */


const GLOBAL_KEY = '__dsh_super_injector_gen_state__'

/** 取（或初始化）进程级的代次状态。**跨模块重载存活**。 */
export function genState(): GenHookGlobalState {
  const g = globalThis as unknown as Record<string, GenHookGlobalState | undefined>
  let st = g[GLOBAL_KEY]
  if (!st || !(st.generations instanceof Map)) {
    st = { generations: new Map(), installed: false, reason: '' }
    g[GLOBAL_KEY] = st
  }
  return st
}

/** 把某目录的代次 +1（**进程级**，重载后仍在）。返回新代次。 */
export function bumpDir(dir: string): number {
  const st = genState()
  const key = dir.replace(/\\/g, '/')
  const next = (st.generations.get(key) ?? 0) + 1
  st.generations.set(key, next)
  return next
}

/**
 * 给 URL 算代次（落在哪个已登记目录下）。
 * 前缀匹配必须按路径段 —— 防 `/a/bc` 误配 `/a/b`。
 */
export function genOf(path: string): number {
  const st = genState()
  if (st.generations.size === 0) return 0
  const p = path.replace(/\\/g, '/')
  let best = 0
  let bestLen = -1
  for (const [dir, gen] of st.generations) {
    if ((p === dir || p.startsWith(dir + '/')) && dir.length > bestLen) {
      best = gen
      bestLen = dir.length
    }
  }
  return best
}

/**
 * `resolve` 钩子的全部逻辑（**纯**：入参 → 新 URL 或原样）。
 *
 * ⚠️ 抽成纯函数是为了**能测**：钩子本身注册进 Node 之后就不好断言了，
 *   而"给定 URL 与代次，应返回什么 URL"是可断言的。
 *
 * @param url         Node 解析出的绝对 URL（相对说明符已被解析）
 * @param generationOf  (path) => gen 的取值器（注入以便测试）
 */
export function applyGeneration(
  url: string,
  generationOf: (path: string) => number = genOf,
): string {
  if (typeof url !== 'string' || !url.startsWith('file:')) return url
  let path: string
  try {
    path = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
    // Windows: file:///C:/x → pathname 是 /C:/x
    if (/^[A-Za-z]:/.test(path)) path = path.replace(/^\//, '')
  } catch { return url }
  const gen = generationOf(path)
  if (gen <= 0) return url          // 未登记 ⇒ 不动
  try {
    const u = new URL(url)
    if (u.searchParams.get('__mgen') === String(gen)) return url
    u.searchParams.set('__mgen', String(gen))
    return u.href
  } catch { return url }
}


