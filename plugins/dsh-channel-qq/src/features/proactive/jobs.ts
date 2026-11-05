/** 事件书 `kind: job` 的处理器注册口（P6f）。
 *
 * 处理器**按名字在运行时刻解析**（不是注册时绑定）：事件书是数据，后台改名字
 * 不需要重装插件；注册表是模块级单例，`features/memory`（e3 的夜间七任务）等
 * 子插件在自己的 `apply` 里 `registerJob(...)`、卸载时调用返回的反注册函数。
 *
 * 契约（写清楚给 e3）：
 *   - `registerJob(name, handler)` → 反注册函数；
 *   - handler 收到 `JobContext`（now/log/dshHome/workspace），返回 `JobOutcome`：
 *     省略或 `{}` = 跑成功；`{ skipped: '原因' }` = 有据可查的跳过；抛异常 = 失败；
 *   - 未知名字 → 执行器记 `failed:unknown-job:<名字>`，且不影响其它事件；
 *   - **幂等键在执行前已落盘**（先写状态再执行）：handler 跑起来时就意味着这一轮
 *     已经"消耗"掉了（崩溃重启不会重跑）；要跳过就把原因返回出来，不要静默 return。
 */

export interface JobContext {
  /** 注入的"现在"（执行器统一取一次，同一轮所有事件看同一时刻）。 */
  readonly now: Date
  readonly log: (line: string) => void
  readonly dshHome: string
  readonly workspace: string | null
}

export interface JobOutcome {
  /** 具名跳过原因（会成为状态里的 `skipped:<原因>`）。 */
  readonly skipped?: string
  /** 附注（成功时记进日志，如"抽了 3 条"）。 */
  readonly note?: string
}

export type JobHandler = (ctx: JobContext) => JobOutcome | void | Promise<JobOutcome | void>

const jobs = new Map<string, JobHandler>()

/** 注册一个 job 处理器；返回反注册函数（同名重复注册时后者生效、前者失效）。 */
export function registerJob(name: string, handler: JobHandler): () => void {
  jobs.set(name, handler)
  return () => {
    if (jobs.get(name) === handler) jobs.delete(name)
  }
}

/** 运行时刻按名字解析；没注册过返回 undefined。 */
export function resolveJob(name: string): JobHandler | undefined {
  return jobs.get(name)
}
