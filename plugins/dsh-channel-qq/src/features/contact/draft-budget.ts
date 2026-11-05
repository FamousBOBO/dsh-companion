/** 起草上下文的**预算常量**与"缺失哨兵"。
 *
 * 为什么单独一个文件（而不是留在 `draft-context.ts`）：`draft-context`（组装）与
 * `draft-freshness`（发送前复核）都要用这些数字，而后者还要被前者 import——常量放在
 * 两边任何一侧都会形成**运行时循环 import**。把它们提到第三个不依赖任何人的文件里，
 * 依赖方向就永远是单向的：`draft-budget ← draft-context`、`draft-budget ← draft-freshness`。
 *
 * 这些数字是 A2 §5.4 的建议值，本轮仍是**常量**（没有进 `contact` 配置段：`src/config/**`
 * 不在本片写入范围）。提升成配置项时要同步 `CONTACT_DEFAULTS` 与 `docs/proactive-message.md`
 * 的字段表，见 REPORT §「留给下一片」。
 */

/** 各分区与整段的裁剪上限。 */
export interface DraftContextBudget {
  readonly personaChars: number
  readonly historyLines: number
  readonly historyChars: number
  readonly lineChars: number
  readonly memoryChars: number
  readonly evidenceChars: number
  readonly outboundChars: number
  readonly outboundRows: number
  /** **整段 prompt** 的上限（含既有七行）。 */
  readonly promptChars: number
}

/**
 * 分区上限。依据（A2 §5.4）：人设 1200 字（`behavior.txt` 只有 714 B，preset 文档可能几千字）；
 * 对话 12 条 / 800 字（与 `sent-log` 的 12 条同量级）；记忆 400 字（记忆自己的预算是 2400，
 * 主动消息不该吃满）；外发 3 条 / 200 字。整段 2400 字，比修复前的约 300 字多出约 2000 字
 * ⇒ 单次草稿的输入 token 大约翻 6 倍，**成本闸是 `draftDailyBudget`**，别靠砍上下文省钱。
 */
export const DRAFT_CONTEXT_BUDGET: DraftContextBudget = {
  personaChars: 1200,
  historyLines: 12,
  historyChars: 800,
  lineChars: 200,
  memoryChars: 400,
  evidenceChars: 300,
  outboundChars: 200,
  outboundRows: 3,
  promptChars: 2400,
}

/**
 * 既有七行（`draft-host.buildDraftPrompt`）的**预留**字数。
 *
 * 实测约 300 字（候选理由最多 200 字 + 固定文本），这里留 520 的余量：段落预算 =
 * `promptChars - BASE_PROMPT_RESERVE`。为什么不让 `draft-host` 回传：段落裁剪必须
 * **一次定完**并写进 `DraftContext.overBudget`，否则"裁不裁得下"会变成两个文件各判一次。
 */
export const BASE_PROMPT_RESERVE = 520

/**
 * **缺失哨兵**：`revision` 里任何一项等于它，就表示"起草时这一项本来就没有/没采到"，
 * 发送前复核时**无法比较** → 保守拒绝（`draft:stale:unverifiable`），不许静默放行。
 */
export const NO_FROZEN_VALUE = ''

/** Adaptive follow-ups need more of the conversation since the intent was formed. */
export function contextBudgetFor(candidate: { readonly intent?: unknown }): DraftContextBudget {
  return candidate.intent ? { ...DRAFT_CONTEXT_BUDGET, historyLines: 40, historyChars: 4000, promptChars: 6200 } : DRAFT_CONTEXT_BUDGET
}
