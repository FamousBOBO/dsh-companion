/** 入站组包用的证据取值（记忆 + 知识库）。
 *
 * 为什么是**惰性**取值：装载表里 inbound 在 memory / kb 之前，apply 时那两个插件
 * 还没 `provide`。从前这里是直接 `host.get(...)`，于是 `memory.v2` 打开后证据一次
 * 都没注入过（2026-10-19 线上实测发现）。现在每次组包现查：晚挂的插件、以及之后
 * 的重挂，都能立刻被读到；没装/关着时返回空串，组包与从前逐字节一致。
 */

/** 组包输入（两段证据都只需要原文与房间）。 */
export interface EvidenceInput {
  readonly text: string
  readonly room: string | null
}

/** 记忆证据（`memory.v2`；空串 = 组包退回旧的关键词召回）。 */
export function lazyMemoryEvidence(host: { get(name: string): unknown }): (input: EvidenceInput & {
  readonly isGroup?: boolean
}) => Promise<string> {
  return async (input) => {
    const evidence = host.get('memoryEvidence') as
      | ((arg: typeof input) => Promise<string>) | undefined
    return evidence === undefined ? '' : await evidence(input)
  }
}

/** 知识库证据（`features/kb`）。没装/关着返回空串。 */
export function lazyKbEvidence(host: { get(name: string): unknown }): (input: EvidenceInput) => Promise<string> {
  return async (input) => {
    const evidence = host.get('kbEvidence') as
      | ((arg: typeof input) => Promise<string>) | undefined
    return evidence === undefined ? '' : await evidence(input)
  }
}

/** 两段证据一起交给组包器（apply 里只展开一次，省得每加一段就多一行）。 */
export function lazyEvidence(host: { get(name: string): unknown }): {
  readonly memoryEvidence: ReturnType<typeof lazyMemoryEvidence>
  readonly kbEvidence: ReturnType<typeof lazyKbEvidence>
} {
  return { memoryEvidence: lazyMemoryEvidence(host), kbEvidence: lazyKbEvidence(host) }
}
