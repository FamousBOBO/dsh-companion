/** 技能接缝的端口类型（只有类型，没有实现）。
 *
 * `features/` 只认识这里的形状；真正接宿主的那一段在
 * `adapters/dsh-host/skills.ts`（R2：`@deepseek-ai/*` 只出现在 adapters）。
 */

/** 一个可以交给宿主目录的技能。 */
export interface HostSkillEntry {
  readonly name: string
  readonly description: string
  readonly whenToUse: string
  readonly body: string
}

/** provider 的最小契约：列全局可见技能、按名字取正文。 */
export interface HostSkillProviderSpec {
  readonly name: string
  readonly list: () => Promise<readonly HostSkillEntry[]>
  readonly get: (name: string) => Promise<string | null>
  /**
   * 可选：目录签名。宿主对 provider 目录做缓存，只有 provider 主动
   * `invalidate()` 才会重扫；外部改文件（后台写、手工编辑）不会自动通知它。
   * 给一个签名字符串，适配器会轮询并在变化时让宿主的目录缓存失效。
   */
  readonly signature?: () => Promise<string>
}

/** `/name` 触发命中后要注入的内容。 */
export interface SkillTriggerHit {
  readonly name: string
  readonly content: string
}

/** 触发处理器：按当前会话判可见范围（动态）。 */
export type SkillTriggerHandler = (input: {
  readonly sessionId: string
  readonly text: string
}) => Promise<SkillTriggerHit | null>

/** 一份技能草稿（记忆候选/知识库文档晋升为技能时用）。 */
export interface SkillDraftInput {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly body: string
  /** 来源说明（写进 metadata.source，便于回溯是哪条记忆/哪份文档）。 */
  readonly source?: string
}

/** 技能草稿入口：只写**待审区**，绝不自动启用。 */
export interface SkillDrafts {
  create(input: SkillDraftInput): Promise<{ name: string; note: string }>
}

/** 宿主的技能接入面。 */
export interface SkillHost {
  /**
   * 注册 provider 与 `/name` 触发。
   * @returns 卸载器；宿主没有 skill 服务时为 `undefined`。
   */
  install(
    provider: HostSkillProviderSpec,
    trigger: SkillTriggerHandler,
    log: (line: string) => void,
  ): (() => void) | undefined
}
