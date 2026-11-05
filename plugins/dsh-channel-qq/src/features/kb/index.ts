/** 知识库子插件：来源扫描 → 解析/分块 → 检索工具 + 每回合证据 + 后台页。
 *
 * 三件事的分工（与记忆、技能划清边界）：
 *   - **记忆** = 从聊天里沉淀的一句话事实，会自动注入、会衰减；
 *   - **知识库** = 用户给的原文（本插件），分块带出处，按需检索；
 *   - **技能** = 做事步骤，显式加载。
 *
 * 启动顺序上的两个选择：
 *   - 装载时**只读库、不扫描**；首轮扫描延迟几秒在后台跑，避免刚启动就与 QQ
 *     连接、会话恢复抢磁盘；
 *   - 向量装配失败只记一行日志、退回关键词——知识库不能因为 embed 服务没起来
 *     就整个不可用。
 */

import * as path from 'node:path'
import { registerSpecs } from '../../adapters/dsh-host/tools.js'
import { createEmbedAdapter } from '../../adapters/providers/embed.js'
import { ingestUrl } from './url-ingest.js'
import { parseScopes } from '../../core/kb/score.js'
import type { EmbedPort } from '../../ports/memory.js'
import type { SubPlugin, SubHost } from '../plugin-kit.js'
import { KbIngestor } from './ingest.js'
import { kbResource } from './resource.js'
import { KbRetriever } from './retriever.js'
import { createKbService } from './service.js'
import { KbStore } from './store.js'
import { qqKbSearch } from './tools.js'
import { KbVectors } from './vectors.js'

/** 首轮扫描延迟：让连接与会话恢复先跑完。 */
const FIRST_SCAN_DELAY_MS = 8_000
/** 批量建索引的超时（配置里的 800ms 是"不拖住一回合"的上限，不是批量任务的上限）。 */
const BULK_EMBED_TIMEOUT_MS = 15_000

/** 后台资源：清单与动作（扫描/重建/删除/URL 入库）。 */
function registerKbResource(host: SubHost, service: ReturnType<typeof createKbService>): void {
  const workspacePath = host.config.workspacePath
  host.registerResource('kb', kbResource({
    service,
    log: host.log,
    scopes: () => parseScopes(host.config.kb.scopes),
    ingestUrls: () => host.config.kb.ingestUrls,
    ...(workspacePath === null ? {} : {
      ingestUrl: (url: string) => ingestUrl({
        workspacePath,
        maxBytes: host.config.kb.maxFileBytes,
        log: host.log,
        scan: () => service.ingest(true),
      }, url),
    }),
  }))
}

export const kbPlugin: SubPlugin = {
  name: 'kb',
  // 整段 watched：目录、开关、注入预算、可见范围、向量权重改完都要重新装配。
  watches: ['kb', 'memory.vectorEnabled', 'memory.vectorUrl', 'memory.vectorDim', 'memory.vectorTimeoutMs'],
  async apply(host) {
    const cfg = host.config.kb
    // 工作区为空时退到 <dshHome>/channel-qq：知识库永远有地方落盘（哪怕没人扫描）。
    const root = host.config.workspacePath ?? path.join(host.dshHome, 'channel-qq')
    const store = new KbStore({ root, log: host.log })
    const loaded = await store.load()
    const ingestor = new KbIngestor({
      store, workspace: root, dirs: cfg.dirs, maxBytes: cfg.maxFileBytes,
      doclingUrl: cfg.doclingUrl, log: host.log,
    })
    const { vectors, embed, bulk } = await setupVectors(host, store.dir)
    const retriever = new KbRetriever({
      store, vectors, embed, log: host.log,
      vectorWeight: () => host.config.kb.vectorWeight,
      rerankWeight: () => host.config.kb.rerankWeight,
      scopes: () => parseScopes(host.config.kb.scopes).scopes,
    })
    let reindexing = false
    const bulkEmbed = bulk ?? embed
    const reindex = async (): Promise<{ embedded: number; failed: number; total: number; skipped: boolean }> => {
      if (vectors === null || bulkEmbed === null) return { embedded: 0, failed: 0, total: 0, skipped: true }
      if (reindexing) return { embedded: 0, failed: 0, total: vectors.size(), skipped: true }
      reindexing = true
      try {
        return { ...(await vectors.rebuild(store.activeChunks(), bulkEmbed)), skipped: false }
      } catch (error) {
        host.log(`kb.vector: 重建失败（不影响关键词检索）：${(error as Error).message}`)
        return { embedded: 0, failed: 0, total: vectors.size(), skipped: true }
      } finally {
        reindexing = false
      }
    }
    const service = createKbService({
      store, retriever, ingestor, vectors, reindex,
      enabled: () => host.config.kb.enabled,
      injectTop: () => host.config.kb.injectTop,
      injectChars: () => host.config.kb.injectChars,
    })
    host.provide('kb', service)
    host.provide('kbEvidence', async (input) => await service.evidence(input))
    registerKbResource(host, service)
    const stopTools = cfg.enabled
      ? registerSpecs(host.bridge.toolHost(), [qqKbSearch(service)], host.log, 'kb')
      : ((): void => {})
    const stopScans = scheduleScans(host, async () => {
      if (!host.config.kb.enabled) return
      await ingestor.run(false)
      if (vectors !== null) await reindex()
    })
    const stats = service.stats()
    host.log(`kb: ${loaded.docs} 份文档 / ${loaded.chunks} 块已加载（可检索 ${stats.activeChunks} 块，`
      + `向量 ${vectors?.size() ?? 0}，目录 ${cfg.dirs}）`)
    if (!cfg.enabled) host.log('kb: 已关闭（后台仍可查看/扫描；工具不注册）')
    return () => {
      stopScans()
      stopTools()
    }
  },
}

/** 向量装配：记忆的 embed 服务不可用/N 未开启时返回 null（检索退回关键词）。 */
async function setupVectors(host: SubHost, dir: string): Promise<{
  vectors: KbVectors | null
  embed: EmbedPort | null
  bulk: EmbedPort | null
}> {
  if (!host.config.memory.vectorEnabled) return { vectors: null, embed: null, bulk: null }
  try {
    const base = {
      baseUrl: host.config.memory.vectorUrl,
      dim: host.config.memory.vectorDim,
      log: host.log,
    }
    const embed = createEmbedAdapter({ ...base, timeoutMs: host.config.memory.vectorTimeoutMs })
    // 批量重建单独一个适配器：它有自己的冷却状态，而且超时放宽到 15s——
    // 首次索引要嵌几百块，800ms 会让每批都超时、整轮一条也写不进去。
    const bulk = createEmbedAdapter({
      ...base,
      timeoutMs: Math.max(BULK_EMBED_TIMEOUT_MS, host.config.memory.vectorTimeoutMs),
    })
    const vectors = new KbVectors({ dir, dim: host.config.memory.vectorDim, log: host.log })
    const count = await vectors.load()
    host.log(count === 0
      ? 'kb.vector: 索引为空（首轮扫描后会自动重建）'
      : `kb.vector: ${count} 条向量已加载（服务 ${host.config.memory.vectorUrl}）`)
    return { vectors, embed, bulk }
  } catch (error) {
    host.log(`kb.vector: 装配失败，退回关键词检索：${(error as Error).message}`)
    return { vectors: null, embed: null, bulk: null }
  }
}

/** 首轮延迟 + 定时扫描；返回卸载器。 */
function scheduleScans(host: SubHost, run: () => Promise<void>): () => void {
  const fire = (): void => { void run().catch((error: unknown) => host.log(`kb: 扫描失败：${(error as Error).message}`)) }
  const first = setTimeout(fire, FIRST_SCAN_DELAY_MS)
  first.unref?.()
  const minutes = Math.max(0, host.config.kb.pollMinutes)
  const timer = minutes > 0 ? setInterval(fire, minutes * 60_000) : null
  timer?.unref?.()
  return () => {
    clearTimeout(first)
    if (timer !== null) clearInterval(timer)
  }
}
