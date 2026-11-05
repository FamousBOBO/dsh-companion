/** 回合发起人：这一轮是**谁**引起的。
 *
 * 路线里的 3.5 只要求"本阶段先记录，不用于拦截"。单独一个文件、且刻意做得很小，
 * 是因为它要在 P6 的信任分级里变成判据（`policy.v2`：按发起人的信任等级决定工具
 * 放行），而**判据必须先有数据**——现在不记，将来就只能靠回溯日志猜。
 *
 * 记的是四类，不记具体内容：
 *
 *   - `user`       —— 群友 / 私聊对象发的消息（带 QQ 号）；
 *   - `notice`     —— 戳一戳、进退群一类的通知触发的回合（带触发者 QQ 号）；
 *   - `proactive`  —— 她自己到点该做的事（巡逻 / 做梦 / 自省 / 主动私聊）；
 *   - `admin`      —— 后台面板递进来的指令。
 *
 * **不要**把发起人当成"内容可信"的代名词：`user` 的内容仍然是不可信的群友输入，
 * 这正是将来要分级的原因。
 */

export type TurnOrigin =
  | { readonly kind: 'user'; readonly userId: number }
  | { readonly kind: 'notice'; readonly userId: number }
  | { readonly kind: 'proactive' }
  | { readonly kind: 'admin' }

/** 一行给日志/后台看的描述。 */
export function describeOrigin(origin: TurnOrigin): string {
  switch (origin.kind) {
    case 'user': return `user:${origin.userId}`
    case 'notice': return `notice:${origin.userId}`
    case 'proactive': return 'proactive'
    case 'admin': return 'admin'
  }
}

/** 定时任务与主动行为都算 `proactive`；后台指令单独一类。 */
export const PROACTIVE: TurnOrigin = { kind: 'proactive' }
export const ADMIN: TurnOrigin = { kind: 'admin' }
