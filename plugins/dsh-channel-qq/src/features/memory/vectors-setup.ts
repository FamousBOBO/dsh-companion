/** 记忆向量的装配：查询适配器（800ms）+ 批量重建适配器（15s）。
 *
 * 两个适配器打同一个服务，区别只在超时：
 *   - **查询**：`memory.vectorTimeoutMs`（800ms）是"别拖住一回合"的上限；
 *   - **重建**：离线任务要嵌几百上千条长文本，每批 16 条在共享 CPU 上经常超过
 *     1s。复用 800ms 的适配器会让每批都判超时、一条也写不进去（2026-10-21 线上
 *     实测：97 条记忆块长期补不上）。所以重建用独立的宽超时适配器，并且有自己的
 *     冷却状态，不会被查询侧的失败连坐。
 */

import * as path from 'node:path'
import { createEmbedAdapter } from '../../adapters/providers/embed.js'
import type { EmbedPort } from '../../ports/memory.js'
import type { SubHost } from '../plugin-kit.js'
import {
  VEC_FILE_NAME, VEC_MANIFEST_NAME, createVectorRecall, loadVectorIndex, type VectorRecall,
} from './vector-store.js'

/** 批量重建的超时。 */
export const BULK_EMBED_TIMEOUT_MS = 15_000

export interface MemoryVectors {
  /** 命中检索用的向量面；索引为空/装配失败时为 undefined（退回关键词）。 */
  readonly recall: VectorRecall | undefined
  /** 查询嵌入（宽超时，仅当 `vectorEnabled` 关着时为 null）。 */
  readonly embed: EmbedPort | null
  /** 批量重建嵌入（15s 超时）。 */
  readonly bulk: EmbedPort | null
}

/**
 * 向量检索的装配（P6e·e2 / e3）：
 *
 *   - `memory.vectorEnabled` 关着 → 三个都返回空，检索走 e1 的关键词路径；
 *   - 开着但索引为空 / 装配失败 → 记日志、照常退回关键词，**绝不挡启动**；
 *     但嵌入器仍然返回给夜间任务——索引为空正是 `reindex` 要去修的状态。
 */
export async function setupVectors(host: SubHost, dir: string): Promise<MemoryVectors> {
  if (!host.config.memory.vectorEnabled) return { recall: undefined, embed: null, bulk: null }
  try {
    const base = {
      baseUrl: host.config.memory.vectorUrl,
      dim: host.config.memory.vectorDim,
      log: host.log,
    }
    const embed = createEmbedAdapter({ ...base, timeoutMs: host.config.memory.vectorTimeoutMs })
    const bulk = createEmbedAdapter({
      ...base,
      timeoutMs: Math.max(BULK_EMBED_TIMEOUT_MS, host.config.memory.vectorTimeoutMs),
    })
    const { index } = await loadVectorIndex({
      file: path.join(dir, VEC_FILE_NAME),
      manifestFile: path.join(dir, VEC_MANIFEST_NAME),
      dim: host.config.memory.vectorDim,
      log: host.log,
    })
    if (index.size() === 0) {
      host.log('memory.vector: 向量索引为空（夜间 reindex 任务会建它），本回合起退回关键词检索')
      return { recall: undefined, embed, bulk }
    }
    host.log(`memory.vector: ${index.size()} 条向量已加载（服务 ${host.config.memory.vectorUrl}，余弦权重 ${host.config.memory.vectorWeight}）`)
    return { recall: createVectorRecall(embed, index, host.config.memory.vectorWeight), embed, bulk }
  } catch (error) {
    host.log(`memory.vector: 装配失败，退回关键词检索：${error instanceof Error ? error.message : String(error)}`)
    return { recall: undefined, embed: null, bulk: null }
  }
}
