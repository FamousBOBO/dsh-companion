/** 网关健康度：一个进程级的"别再去撞那堵墙"标记。
 *
 * 原来它是一个模块级变量（`bridge.ts` 顶上的 `let gatewayBackoffUntil = 0`）。
 * 模块级可变状态有三个毛病：**跨实例共享**（测试里造第二个 bridge 会继承第一个
 * 的退避）、**跨测试泄漏**、**没法在后台显示**。收成一个显式对象之后，组合根持有
 * 它、注入给需要的会话，测试可以各自造一个。
 *
 * 语义只有两条：`arm()` **只会推迟、不会提前**（一次新的失败只会让退避更晚结束），
 * 以及"当前是否在退避期内"由调用方传入的 `now` 判断——这个类自己不读时钟。
 */
export class GatewayHealth {
  /** 退避截止时刻（毫秒；0 表示没在退避）。 */
  private until = 0

  /** 现在（`nowMs`）还在退避期内吗。 */
  isBackingOff(nowMs: number): boolean {
    return nowMs < this.until
  }

  /** 退避截止时刻；攒批闸门用它判断"要不要再等一会儿"。 */
  deadline(): number {
    return this.until
  }

  /** 把退避推到"现在 + delay"；已经更晚的话保持不变。 */
  arm(nowMs: number, delayMs: number): void {
    this.until = Math.max(this.until, nowMs + delayMs)
  }
}
