/** 云端判断端口的**装配**（宿主侧）：把 `judge.*` 的远程字段折成 {@link JudgePort}。
 *
 * 为什么与 `judge-host.ts`（本地那一路）分开：两边要回答的问题完全不同——
 * 本地要读 12 MB 分词器、查显存、spawn 进程；云端只要一个端点、一把现取的 key、
 * 一个 `User-Agent`。合成一个函数就得让"显存"这个与云端毫无关系的东西出现在云端路径里。
 *
 * 四条口径（与本地那一路刻意不同，逐条说明理由）：
 *   1. **没有懒初始化**：云端不需要预热，第一次 `decide` 就是一次 HTTP。所以装配期就能
 *      判断"配置全不全"，不必等群里真的有人说第一句话。
 *   2. **关着时一个对象都不造**：`backend !== 'jev-opencode'` → 返回 `null`，
 *      装配侧于是完全不接这一路（行为回到 `host` 或 `jev-local`）。
 *   3. **key 只现取、不缓存**：`apiKey()` 每次调用都问一次凭据库。缓存等于把密钥留在
 *      一个长期存活的闭包里——热重载之后那个闭包还在。
 *   4. **成本账本**：`usage()` 给后台诊断用（累计轮数与美元），**不含 key、不含正文**。
 */

import type { HttpClient } from '../../ports/http.js'
import { credentialResolver } from './credentials.js'
import type { JudgePort } from '../../app/inbound/judge-port.js'
import type { VerdictLimits } from '../../app/inbound/judge-verdict.js'
import { SCENES, parseGateList, type GateId } from '../../app/inbound/judge-gates.js'
import { DEFAULTS, positiveOr, type PresenceView } from '../../app/inbound/presence-flow.js'
import { createHostedJudge } from '../jev/hosted-judge.js'
import type { HostedUsage } from '../jev/hosted-protocol.js'

/** `judge` 段里云端那部分（结构类型：不把整份配置拖进来）。 */
export interface HostedJudgeView {
  readonly backend: string
  readonly remoteBaseUrl: string
  readonly remoteModel: string
  readonly remoteApiKeyRef: string
  readonly remoteTimeoutMs: number
  readonly remoteUserAgent: string
  readonly phraseMinProbability: number
  readonly gatesEnabled: string
}

/** 云端判断的实时状态（后台诊断用；**没有任何密钥字段**）。 */
export interface HostedJudgeInfo {
  readonly backend: 'jev-opencode'
  readonly model: string
  readonly endpoint: string
  /** 已完成的判断轮数。 */
  readonly calls: number
  /** 累计花费（美元；免费 id 恒为 0）。 */
  readonly costUsd: number
  /** 累计 input token（用来核对"一轮多少钱"是否与实测一致）。 */
  readonly inputTokens: number
  /** 最近一次用量里的 `billing_source`（`balance` / `free` / 空）。 */
  readonly billing: string
}

/** 装配结果。 */
export interface HostedJudgeHost {
  readonly port: JudgePort
  readonly info: () => HostedJudgeInfo
}

/** 造云端判断要的全部依赖。 */
export interface HostedJudgeHostDeps {
  /** 现取 `judge` 段（热改立即生效）。 */
  readonly config: () => HostedJudgeView | null
  /** 现取 `presence` 段（折判的字数上限与时间窗从那里来）。 */
  readonly presence: () => PresenceView | null
  readonly http: HttpClient
  /** 按引用名取凭据（`host.bridge.credential`；宿主没装则是 `undefined`）。 */
  readonly credential?: ((ref: string) => Promise<string | null>) | undefined
  /** 宿主上下文（用于 `credentialResolver` 那条既有通路）。 */
  readonly host: unknown
  readonly log: (line: string) => void
  /** 现取"这一路该不该开"（`backend === 'jev-opencode'`）。 */
  readonly enabled: () => boolean
}

/** 端点/模型为空即"没配全"（凭据引用名有默认值，不算缺）。 */
function missingOf(config: HostedJudgeView): string[] {
  return (['remoteBaseUrl', 'remoteModel'] as const).filter((key) => config[key] === '')
}

/** 折判阈值：`judge.phraseMinProbability` + `presence.replyMaxChars` / `replyWindowMs`（与本地同一处口径）。 */
function limitsOf(config: HostedJudgeView, presence: PresenceView | null): VerdictLimits {
  return {
    phraseMinProbability: Number.isFinite(config.phraseMinProbability)
      ? Math.min(1, Math.max(0, config.phraseMinProbability))
      : 0.3,
    replyMaxChars: positiveOr(presence?.replyMaxChars ?? DEFAULTS.replyMaxChars, DEFAULTS.replyMaxChars),
    windowMs: positiveOr(presence?.replyWindowMs ?? DEFAULTS.replyWindowMs, DEFAULTS.replyWindowMs),
  }
}

/** 启用的门（每次现取：后台关掉一门，下一轮就不问它）。 */
function gateListOf(config: HostedJudgeView): readonly GateId[] {
  return parseGateList(config.gatesEnabled)
}

/** 取凭据：优先用 `bridge.credential`，没有就退回既有 `credentialResolver`。 */
function keyReader(deps: HostedJudgeHostDeps, ref: string): () => Promise<string | null> {
  const direct = deps.credential
  if (direct !== undefined) return () => direct(ref)
  return credentialResolver(deps.host, ref)
}

/**
 * 造云端判断端口（**同步返回**，没有任何初始化开销）。
 *
 * 返回 `null` = 配置层面就不该开（`backend` 不是 `jev-opencode`、端点或模型为空）。
 * 装配期就说清楚，而不是等第一次判断；否则日志里会出现"明明配了却一直不说话"。
 */
export function hostedJudgeHost(deps: HostedJudgeHostDeps): HostedJudgeHost | null {
  if (!deps.enabled()) return null
  const config = deps.config()
  if (config === null) {
    deps.log('judge: backend=jev-opencode 但读不到 judge 段，云端判断不启用')
    return null
  }
  const missing = missingOf(config)
  if (missing.length > 0) {
    deps.log(`judge: backend=jev-opencode 但 ${missing.join(' / ')} 未配置，云端判断不启用`)
    return null
  }
  /** 成本账本（只累加，不含正文与 key）。 */
  const ledger = { calls: 0, costUsd: 0, inputTokens: 0, billing: '' }
  deps.log(`judge: jev-opencode 启用（${config.remoteModel} @ ${config.remoteBaseUrl}）`)
  const port = createHostedJudge({
    http: deps.http,
    endpoint: config.remoteBaseUrl,
    model: config.remoteModel,
    apiKey: keyReader(deps, config.remoteApiKeyRef),
    userAgent: config.remoteUserAgent,
    timeoutMs: positiveOr(config.remoteTimeoutMs, 8_000),
    log: deps.log,
    gates: gateListOf(config),
    scenes: SCENES,
    limits: limitsOf(config, deps.presence()),
    targetWindow: positiveOr(deps.presence()?.judgeMaxEntries ?? DEFAULTS.judgeMaxEntries, DEFAULTS.judgeMaxEntries),
    onUsage: (usage: HostedUsage) => {
      ledger.calls += 1
      ledger.costUsd += usage.costUsd
      ledger.inputTokens += usage.inputTokens
      ledger.billing = usage.billing
    },
  })
  return {
    port,
    info: () => ({
      backend: 'jev-opencode',
      model: config.remoteModel,
      endpoint: config.remoteBaseUrl,
      calls: ledger.calls,
      costUsd: ledger.costUsd,
      inputTokens: ledger.inputTokens,
      billing: ledger.billing,
    }),
  }
}
