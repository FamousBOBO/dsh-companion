/** 三层注入的装配面（P2/P3，调研 [20261024_memory-system-research.md] §6）。
 *
 * 从 `index.ts` 搬出来（那边有 400 行硬上限），把记忆注入升级成：
 *
 *   0. **今天的日子**（P3）：生日/纪念日在最前面占一行；
 *   1. **常驻层**（pinned）：「一直记得的事」每回合在场——准入极严
 *      （`core` 标记 + importance≥8 + confidence≥0.8），外加 affection 联动的
 *      第二条准入（高好感用户的重要偏好，feiyu 的"在意的人记得牢"）；
 *   2. **话题触发层**：原有混合检索管线，判据一字未动；
 *   3. **走神层**（wander）：`wanderPercent`% 概率从"被记得够深 + 七天没想起"
 *      的记忆里随机带一条回来（feiyu 的"突然想起来"）——房间级记录只在自己
 *      房间走神，不跨房泄露。
 *
 * 预算纪律：`maxChars` 是硬上限，话题层由检索器照旧把关，常驻/走神/日子三个
 * 块各占几行——总量超了先裁走神、再裁常驻（见 `fitBudget`）。
 * 全部开关关着 + 无命中时输出空串，与旧注入逐字节兼容。
 */

import { dueOccasions, renderOccasions } from '../../core/memory/occasions.js'
import { pickPinned, pickWander, renderConstantBlock, renderWanderBlock } from '../../core/memory/select.js'
import { withHit, type MemoryRecord } from '../../core/memory/model.js'
import type { MemoryEvidenceInput } from '../../ports/memory.js'
import type { MemoryRetriever } from './retriever.js'
import { InstantCapture } from './instant-capture.js'
import type { ExtractedItem } from './nightly-io.js'
import type { MemoryStore } from './store.js'
import type { SubHost } from '../plugin-kit.js'

/** 本地时区偏移（分钟）。服务器是 UTC，但她的"今天"按北京时间算。 */
const TZ_OFFSET_MINUTES = 8 * 60

export interface InjectV3Deps {
  readonly host: SubHost
  readonly store: MemoryStore
  readonly retriever: MemoryRetriever
  /** affection 读取（惰性：affection 子插件可能比 memory 晚挂载）；没有就 null。 */
  readonly affectionScore: () => number | null
  /** 抽取通道（已按 `captureEnabled` 判过；undefined = 即时抽取关闭）。 */
  readonly extract?: (source: string, text: string) => Promise<ExtractedItem[]>
  /** 人物侧写解析（index.ts 的 5 分钟缓存版）；memory.profiles 关着时不用。 */
  readonly profileFor?: (id: number, name: string) => string
  readonly clock: { now(): number }
  readonly random: () => number
}

/** affection 联动的常驻准入：分数 ≥ 80 的用户，重要且被验证过的偏好/人物档。 */
function affectionAdmit(score: number | null): ((record: MemoryRecord) => boolean) | undefined {
  if (score === null || score < 80) return undefined
  return (record) =>
    record.subject.type === 'user' &&
    (record.kind === 'preference' || record.kind === 'person') &&
    record.importance >= 7 &&
    record.confidence >= 0.8
}

/** 记录的房间键（`group-123`）与证据输入的房间键（`qq-group-123`）对齐。 */
function sameRoom(record: MemoryRecord, evidenceRoom: string): boolean {
  if (record.scope !== 'room' || record.room === undefined) return true
  return record.room === evidenceRoom.replace(/^qq-/, '')
}

/** 走神挑选（P2 第三层）：骰子在这里掷，room 级记忆不跨房泄露。 */
function wanderOf(
  memory: { wanderPercent: number },
  store: MemoryStore,
  room: string,
  now: number,
  roll: number,
): MemoryRecord | null {
  const percent = Math.max(0, Math.min(50, memory.wanderPercent))
  if (percent <= 0) return null
  return pickWander(store.all().filter((r) => sameRoom(r, room)), now, roll)
}

/**
 * 三块（日子/常驻/走神）合计最多占预算的 60%，剩下至少 40% 留给话题证据——
 * 顺序即优先级（日子 > 常驻 > 走神），放不下的整块不要（渲染行是整条语义，
 * 不做半条，与 DIGEST/注入的同一规矩）。
 */
function fitBudget(parts: { occasions: string; pinned: string; wander: string }, maxChars: number): string[] {
  const ceiling = Math.floor(maxChars * 0.6)
  const kept: string[] = []
  let used = 0
  for (const part of [parts.occasions, parts.pinned, parts.wander]) {
    if (part === '') continue
    const size = part.length + 2
    if (used + size > ceiling) break
    kept.push(part)
    used += size
  }
  return kept
}

/** 即时抽取器（P0）：extract 通道由 index.ts 按 `captureEnabled` 判好传入。 */
function buildCapture(deps: InjectV3Deps, store: MemoryStore): InstantCapture {
  return new InstantCapture({
    store: () => (deps.host.config.memory.v2 ? store : null),
    ...(deps.extract === undefined ? {} : { extract: deps.extract }),
    log: deps.host.log,
    random: deps.random,
    clock: deps.clock,
    dir: store.dir,
    dailyCap: deps.host.config.memory.captureDailyCap,
  })
}

/** 组装 `memoryEvidence` 端口的新实现；顺带把即时抽取器造好（index.ts 拿去接钩子）。 */
export function wireInjectionV3(deps: InjectV3Deps): {
  evidence: (input: MemoryEvidenceInput) => Promise<string>
  capture: InstantCapture
} {
  const { host, store, retriever } = deps
  const renderTime = (at: number): string => new Date(at).toISOString().slice(0, 10)
  const capture = buildCapture(deps, store)

  const evidence = async (input: MemoryEvidenceInput): Promise<string> => {
    const memory = host.config.memory
    const now = deps.clock.now()
    // 今天的日子（P3）：生日/纪念日在最前面。
    const occasions = memory.occasionsEnabled
      ? dueOccasions(store.all(), now, TZ_OFFSET_MINUTES)
      : []
    const occasionsBlock = renderOccasions(occasions, renderTime)

    // 常驻层（P2 第一层）：affection 联动的扩展准入在这里注入。
    const admitExtra = affectionAdmit(deps.affectionScore())
    const pinned = memory.pinnedEnabled
      ? pickPinned(store.all(), { ...(admitExtra === undefined ? {} : { admitExtra }) })
      : []
    const pinnedBlock = renderConstantBlock(pinned, { renderTime })

    // 走神层（P2 第三层）：骰子在这里掷（retriever 不掷——它的 roll 选项留给通用调用方）。
    const roll = memory.wanderPercent > 0 ? deps.random() : 1
    const wander = wanderOf(memory, store, input.room, now, roll)
    const wanderBlock = wander === null ? '' : renderWanderBlock(wander, { renderTime })

    // 话题层照旧（noPinned：常驻已在这里渲染，不让检索器重复带）。
    const got = await retriever.retrieve({
      text: input.text,
      room: input.room,
      now,
      noPinned: true,
      budget: {
        threshold: memory.threshold,
        maxRecords: memory.maxRecords,
        maxChars: memory.maxChars,
      },
      accept: (record: MemoryRecord) => !record.tags.includes('chunk'),
    })

    const kept = fitBudget(
      { occasions: occasionsBlock, pinned: pinnedBlock, wander: wanderBlock },
      memory.maxChars,
    )
    const parts = [...kept, got.evidence].filter((part) => part !== '')
    if (parts.length === 0) return ''
    // 走神的"想起来"也算命中（feiyu：平时想不起来，提一句又想起来了）。
    if (wander !== null) await store.put(withHit(wander, now)).catch(() => {})
    const profile = input.speakerId === undefined || memory.profiles !== true || deps.profileFor === undefined
      ? ''
      : deps.profileFor(input.speakerId, input.speakerName ?? '')
    if (profile !== '') parts.unshift(profile)
    return parts.join('\n\n')
  }
  return { evidence, capture }
}
