/** 群聊准入判定（P6g `group.planner`）：这条消息**该不该进 agent**。
 *
 * 现状是"所有够格的消息都进 agent，由模型自己决定说不说"——一次主 agent 调用不便宜，
 * 而大部分群消息（别人的对话、纯表情、另一个机器人发的）本来就不需要她开口。
 * 这个模块把这些判定**收到一处、前移到入站那一刻**，并且每条都给**具名理由**
 * （日志与后台能回答"她为什么没理这条"）。
 *
 * 三档（不是两档，因为"不确定"和"不要"是两件事）：
 *   - `speak`：确定要说话（被叫到 / 私聊）——立刻进 agent，不看概率；
 *   - `consider`：够格参与攒批与概率门（现状行为）——**不确定的那一档**；
 *   - `ignore`：确定不需要（没被叫且要求 @、来自别的机器人、纯表情没正文）。
 *
 * `core/` 的规矩（R8）：纯函数，不读时钟、不掷随机——骰子由调用方掷好传进来。
 *
 * **没做的那一半**（写在明面上）：「规则 + 便宜模型」里的**便宜模型**需要一条
 * 调模型的接缝；本轮只落规则那半，`consider` 就是留给它的位置——将来接上之后，
 * 模型只在 `consider` 这一档被问到"要不要接这句"，`speak`/`ignore` 仍然零调用。
 */

/** 判定用到的输入（全是已经算好的事实，这个函数不做任何 IO）。 */
export interface PlanInput {
  readonly isGroup: boolean
  /** 被叫：@ / 命中关键词 / 回复她（私聊另算，见下）。 */
  readonly called: boolean
  /** 配置里的"需要 @ 才回"。 */
  readonly requireMention: boolean
  /** 发送者是另一个机器人（防 bot 互刷）。 */
  readonly fromBot: boolean
  /** 这条消息有没有正文（只有表情/图片时为 false）。 */
  readonly hasText: boolean
}

export type PlanDecision = 'speak' | 'consider' | 'ignore'

export interface Plan {
  readonly decision: PlanDecision
  /** 具名理由：进日志、进后台的"为什么没理它"。 */
  readonly reason: string
}

/** 一条消息的准入判定。顺序即优先级（先判"确定要"，再判"确定不要"，剩下的是"看情况"）。 */
export function planInbound(input: PlanInput): Plan {
  // 私聊永远是要说话的地方（那边没有人替她把话挡下来）。
  if (!input.isGroup) return { decision: 'speak', reason: 'private' }
  if (input.called) return { decision: 'speak', reason: 'called' }
  // 要求 @ 才回：没被叫就别进 agent——这与现状的 requireMention 门同一条判据，
  // 区别只在于这里会记下理由（现状是 debug 模式下才有日志）。
  if (input.requireMention) return { decision: 'ignore', reason: 'require-mention' }
  // 另一个机器人发的：它有自己的触发规则，回它只会变成两个 bot 互相刷屏。
  if (input.fromBot) return { decision: 'ignore', reason: 'from-bot' }
  // 纯表情/图片、没正文：没有可接的话头（正文里的 `[图片]` 标记不算正文）。
  if (!input.hasText) return { decision: 'ignore', reason: 'non-text' }
  // 其余交给攒批与概率门（现状行为）：这一档才是将来"便宜模型"要回答的地方。
  return { decision: 'consider', reason: 'candidate' }
}
