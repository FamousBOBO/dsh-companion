/** `Clock` / `Random` 端口：把"现在几点""随机数是多少"从全局取改成注入。
 *
 * 为什么需要它（01 §A7）：全仓到处直接调
 * `Date.now()` / `new Date()` / `Math.random()`，于是**定时逻辑与概率逻辑没法
 * 确定性重放**——测"到点了没有""这次该不该接话"只能靠改系统时间或反复跑。
 * 端口化之后，测试注入一个假时钟就能精确推进时间、注入固定随机数就能复现概率分支。
 *
 * 只有类型，没有实现；真实实现见 `adapters/fs-store` 之外的 `adapters/clock`
 * （P2.3 落）。**本文件在 P2.1 只落地接口**，迁移按 06 §P2 逐步做。
 */

/** 定时器句柄。不写死成 `NodeJS.Timeout`，因为将来可能换成宿主提供的定时器。 */
export interface TimerHandle {
  /** 取消这个定时器。 */
  cancel(): void
  /**
   * 别因为这个定时器把进程吊着（有就调用，没有就算了）。
   *
   * 可选是因为它不该是端口契约的一部分："进程生命周期"是宿主的关注点；
   * 只有"合并窗口"这种纯粹的收尾等待才需要它。
   */
  unref?(): void
}

/**
 * 时间与定时器。
 *
 * `now()` 是**毫秒时间戳**（与 `Date.now()` 同义），`date()` 给需要 `Date` 对象
 * 的地方（时区计算、格式化）。两者分开是为了让大多数调用点只依赖一个数字。
 */
export interface Clock {
  now(): number
  /** `now()` 对应的本地时间；时区由部署环境的 `TZ` 决定（本项目是 Asia/Shanghai）。 */
  date(): Date
  /** 一次性定时；`fn` 抛错不应影响进程。 */
  setTimeout(fn: () => void, ms: number): TimerHandle
  /** 周期定时。 */
  setInterval(fn: () => void, ms: number): TimerHandle
}

/** 可复现的随机源。 */
export interface Random {
  /** [0, 1) 之间的浮点数，与 `Math.random()` 同义。 */
  next(): number
  /** [0, maxExclusive) 的整数。 */
  int(maxExclusive: number): number
}

/**
 * 系统实现：直接用 Node 的全局能力。
 *
 * 它就是"不改行为"的默认实现——注入它之后代码行为与改造前逐字节一致，
 * 所以迁移一个模块时可以先注入真实现，等测试需要时再换假的。
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  date: () => new Date(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    return { cancel: () => clearTimeout(handle), unref: () => handle.unref() }
  },
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms)
    return { cancel: () => clearInterval(handle), unref: () => handle.unref() }
  },
}

/** 系统随机源。 */
export const systemRandom: Random = {
  next: () => Math.random(),
  int: (maxExclusive) => Math.floor(Math.random() * maxExclusive),
}
