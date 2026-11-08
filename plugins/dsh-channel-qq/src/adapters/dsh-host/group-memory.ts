/** 群记忆的**适配层**（P1 §5.2）：把 `companion-foundation/group-memory.mjs` 的存储接到这条路径上。
 *
 * 为什么是一个适配层而不是直接 import：存储是**另一个插件行**的文件（foundation），
 * 而 `src/app/` 不许 import `adapters/`、更不许碰兄弟插件的实现（分层 R8 与"安装位置无关"）。
 * 这里做三件事，每件都必须有：
 *   1. **惰性加载**：没装/路径不对就返回 `null`，群聊照常跑（§5.5「记忆服务不可用时不影响基础群聊」）；
 *   2. **形状归一化**：存储返回它自己的行形状（`group_id`/`member_id`/`source_message_ids` 都是 TEXT），
 *      这里翻译成 {@link GroupMemoryRecall} 的 number 形状——**转换只在这一处**；
 *   3. **绝不抛**：这条路径上的任何异常都只能让"这一轮少一段记忆"。
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EMPTY_RECALL,
  normalizeRecall,
  type GroupMemoryRecall,
} from '../../app/inbound/group-memory-contract.js'

/** 存储的最小面（`companion-foundation/group-memory.mjs` 的 `createGroupMemoryStore(file)`）。 */
interface GroupMemoryStore {
  query(input: {
    groupId: number | string
    memberIds?: readonly (number | string)[]
    topic?: string
    query?: string
    limit?: number
  }): unknown
}

/** 一个 store 实例 + 它从哪来（诊断用：只放文件路径与原因码，不放正文）。 */
export interface GroupMemoryHandle {
  readonly store: GroupMemoryStore | null
  readonly file: string
  readonly reason: string
}

/** 模块缓存：一个进程一份（与 `expression-bridge.ts` 的"算一次"同一个理由）。 */
let cached: GroupMemoryHandle | null = null

/** 库文件路径（`dataRoot` 算不出来时退回环境变量，两者都没有就是空串 = 永久降级）。 */
export function groupMemoryFileOf(dataRoot: string | null): string {
  const explicit = String(process.env.DSH_COMPANION_GROUP_MEMORY_DB ?? '').trim()
  if (explicit !== '' && path.isAbsolute(explicit)) return path.normalize(explicit)
  if (dataRoot !== null && dataRoot !== '') return path.join(dataRoot, 'home', 'group-memory', 'group-memory.db')
  return ''
}

/**
 * 找到并打开群记忆库。
 *
 * 找不到模块、打不开库都不是错误：`store: null` + 一个原因码，**群聊照常跑**。
 */
export function openGroupMemory(dataRoot: string | null): GroupMemoryHandle {
  const file = groupMemoryFileOf(dataRoot)
  if (cached !== null && cached.file === file) return cached
  if (file === '') {
    cached = { store: null, file, reason: 'no-path' }
    return cached
  }
  const moduleFile = findStoreModule()
  if (moduleFile === null) {
    cached = { store: null, file, reason: 'module-missing' }
    return cached
  }
  try {
    const require = createRequire(import.meta.url)
    const loaded = require(moduleFile) as {
      createGroupMemoryStore?: (options: { file: string }) => GroupMemoryStore
    }
    if (typeof loaded.createGroupMemoryStore !== 'function') {
      cached = { store: null, file, reason: 'factory-missing' }
      return cached
    }
    cached = { store: loaded.createGroupMemoryStore({ file }), file, reason: 'ok' }
    return cached
  } catch (error) {
    cached = {
      store: null,
      file,
      reason: `open-failed:${error instanceof Error ? error.message : String(error)}`,
    }
    return cached
  }
}

/** 只读一次记忆（**绝不抛**；拿不到就是 {@link EMPTY_RECALL}）。 */
export function recallGroupMemory(input: {
  dataRoot: string | null
  groupId: number
  memberIds: readonly number[]
  topic: string
  budgetChars: number
}): GroupMemoryRecall {
  try {
    const handle = openGroupMemory(input.dataRoot)
    if (handle.store === null) return EMPTY_RECALL
    const raw = handle.store.query({
      groupId: input.groupId,
      // 成员维只查这一批正在说话的人：查全部等于把整个群的画像塞进提示词（§5.4 明确禁止）。
      memberIds: [...input.memberIds].slice(0, 10),
      topic: input.topic,
      query: input.topic,
      limit: 8,
    })
    return normalizeRecall(raw, {
      groupId: input.groupId,
      memberIds: input.memberIds,
      budgetChars: input.budgetChars,
    })
  } catch {
    return EMPTY_RECALL
  }
}

/**
 * 写一批候选记忆（P1 §5.3）。
 *
 * 逐条写、逐条容错：一条坏了不该让整批丢；返回值只用于日志（不进提示词）。
 * 形状对齐存储侧（`writeMemberFact({ groupId, memberId, content, kind, sourceMessageIds })`），
 * 但**只传存储真的会用的字段**——多传的字段在严格实现里会被当成"契约外输入"。
 */
export function rememberGroupFacts(input: {
  dataRoot: string | null
  groupId: number
  facts: readonly {
    scope: 'group' | 'member'
    memberId?: number
    content: string
    kind: 'explicit' | 'observed' | 'guess'
    sourceMessageIds: readonly number[]
  }[]
}): { written: number; merged: number; rejected: number } {
  const handle = openGroupMemory(input.dataRoot)
  if (handle.store === null) return { written: 0, merged: 0, rejected: input.facts.length }
  const store = handle.store as GroupMemoryStore & {
    writeMemberFact?: (row: unknown) => { ok?: boolean; reason?: string }
    writeGroupFact?: (row: unknown) => { ok?: boolean; reason?: string }
  }
  let written = 0
  let merged = 0
  let rejected = 0
  for (const fact of input.facts) {
    try {
      if (fact.scope === 'member' && typeof fact.memberId !== 'number') {
        rejected += 1
        continue
      }
      const row = {
        groupId: input.groupId,
        ...(fact.scope === 'member' ? { memberId: fact.memberId } : {}),
        content: fact.content,
        kind: fact.kind,
        sourceMessageIds: [...fact.sourceMessageIds],
      }
      const result = fact.scope === 'member'
        ? store.writeMemberFact?.(row)
        : store.writeGroupFact?.(row)
      if (result?.ok === true) {
        // `merged` = 同群同内容已存在，来源被合并（存储侧的语义）；两者都算"这条已经知道了"。
        if (result.reason === 'merged') merged += 1
        else written += 1
      } else {
        rejected += 1
      }
    } catch {
      rejected += 1
    }
  }
  return { written, merged, rejected }
}

/** 测试/诊断用：丢掉缓存（换库文件之后必须调，否则会一直用旧句柄）。 */
export function resetGroupMemoryCache(): void {
  cached = null
}

/** 往上找 `companion-foundation/group-memory.mjs`（最多 8 层；找不到返回 null，不猜）。 */
function findStoreModule(): string | null {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 8; i += 1) {
      const sibling = path.join(path.dirname(dir), 'companion-foundation', 'group-memory.mjs')
      if (existsSync(sibling)) return sibling
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    /* 找不到就是没有 */
  }
  return null
}
