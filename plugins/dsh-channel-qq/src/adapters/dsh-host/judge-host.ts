/** 本地 Jev 判断的**装配**（宿主侧）：把 `judge.*` 配置变成 `JudgePort`。
 *
 * 为什么在 `adapters/dsh-host/`：这一层要做三件"外面"的事——读文件（权重目录里的
 * `readout_config.json` 与 `tokenizer.json`）、起进程（`jev-score`）、读显存。
 * 这三件都属于"运行时知识"，`app/` 与 `features/` 不该直接碰（分层检查 R8）。
 *
 * 四条口径：
 *   1. **懒到第一次判断才装配**：读分词器（12 MB JSON）与查显存都要时间，
 *      而"群里没人说话"是常态。装配函数本身是同步的（不改变 `wirePresence` 的形状），
 *      真正的初始化发生在第一次 `decide` 里；
 *   2. **关着时一个对象都不造**：`backend !== 'jev-local'` 或三个路径没配全 → 立刻返回
 *      `null`，装配侧于是完全不接这一路（行为回到今日的宿主模型）；
 *   3. **配置不合法不抛**：缺文件、readout 形状不对、分词器坏了 → 记一行日志后按
 *      "这一路不可用"处理（判断返回 `no-route`，群里不说话）；
 *   4. **显存不够就不启动**：`minFreeVramMb` 是唯一的保护闸（见 `vram-guard.ts`）。
 */

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { createLocalJudge } from '../jev/local-judge.js'
import { createRenderer, readoutOf } from '../jev/render-v1.js'
import { createScorerClient, type ScorerClient } from '../jev/scorer-client.js'
import type { ScorerOptions } from '../jev/scorer-protocol.js'
import { parseGateList, type GateId } from '../../app/inbound/judge-gates.js'
import type { VerdictLimits } from '../../app/inbound/judge-verdict.js'
import type { JudgePort } from '../../app/inbound/judge-port.js'
import { DEFAULTS, positiveOr, type PresenceView } from '../../app/inbound/presence-flow.js'
import type { Clock } from '../../ports/clock.js'
import { freeVramMb, vramIsEnough } from './vram-guard.js'

/** `judge` 段的形状（结构类型：不把整份配置拖进来）。 */
export interface JudgeView {
  readonly backend: string
  /** 云端端点（`jev-opencode` 用；`jev-local` 不看这几个）。 */
  readonly remoteBaseUrl: string
  readonly remoteModel: string
  readonly remoteApiKeyRef: string
  readonly remoteTimeoutMs: number
  readonly remoteUserAgent: string
  readonly scorerPath: string
  readonly modelPath: string
  readonly tokenizerPath: string
  readonly contextSize: number
  readonly ubatch: number
  readonly seqMax: number
  readonly outputsMax: number
  readonly nGpuLayers: number
  readonly threads: number
  readonly minFreeVramMb: number
  readonly timeoutMs: number
  readonly phraseMinProbability: number
  readonly gatesEnabled: string
}

/** 打分器就绪信息（后台诊断用）。 */
export interface JudgeReadyInfo {
  readonly desc: string
  readonly loadMs: number

  /** `ready` 行里的后端清单原文（后台诊断用：看的是驱动与后端版本）。 */
  readonly systemInfo?: string
  /** 渲染器与分词器是否自洽（装配时已校验过一次）。 */
  readonly rendererVerified: boolean
}

/** 装配结果：端口 + 收尾 + 就绪信息。 */
export interface LocalJudgeHost {
  readonly port: JudgePort
  /** 打分器进程的就绪信息（还没启动过 = `null`）。 */
  readonly info: () => JudgeReadyInfo | null
  readonly dispose: () => Promise<void>
}

/** 造本地判断要的全部依赖。 */
export interface LocalJudgeHostDeps {
  /** 现取 `judge` 段（热改立即生效）。 */
  readonly config: () => JudgeView | null
  /** 现取 `presence` 段（折判阈值从那里来）。 */
  readonly presence: () => PresenceView | null
  readonly clock: Clock
  readonly log: (line: string) => void
  /** 现取"这一路该不该开"（`backend === 'jev-local'`）。 */
  readonly enabled: () => boolean
}

/** 从配置里取打分器的启动参数。 */
function optionsOf(config: JudgeView): ScorerOptions {
  return {
    binaryPath: config.scorerPath,
    modelPath: config.modelPath,
    contextSize: positiveOr(config.contextSize, 2048),
    ubatch: positiveOr(config.ubatch, 256),
    seqMax: positiveOr(config.seqMax, 4),
    outputsMax: positiveOr(config.outputsMax, 64),
    nGpuLayers: Number.isFinite(config.nGpuLayers) ? Math.max(0, Math.trunc(config.nGpuLayers)) : 99,
    threads: positiveOr(config.threads, 6),
  }
}

/** 折判阈值：`judge.phraseMinProbability` + `presence.replyMaxChars` / `replyWindowMs`。 */
function limitsOf(config: JudgeView, presence: PresenceView | null): VerdictLimits {
  return {
    phraseMinProbability: Number.isFinite(config.phraseMinProbability)
      ? Math.min(1, Math.max(0, config.phraseMinProbability))
      : 0.3,
    replyMaxChars: positiveOr(presence?.replyMaxChars ?? DEFAULTS.replyMaxChars, DEFAULTS.replyMaxChars),
    windowMs: positiveOr(presence?.replyWindowMs ?? DEFAULTS.replyWindowMs, DEFAULTS.replyWindowMs),
  }
}

/** 读 `readout_config.json`（模型目录里，与 GGUF 同级）。 */
function readoutAt(modelPath: string): Record<string, unknown> {
  const file = path.join(path.dirname(modelPath), 'readout_config.json')
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`readout_config.json 不是对象：${file}`)
  }
  return parsed as Record<string, unknown>
}

/** 校准温度（`temperatures.global`，夹在 `clamp` 里）。 */
export function temperatureOf(config: Record<string, unknown>): number {
  const temps = config['temperatures']
  if (temps === null || typeof temps !== 'object') return 1
  const node = temps as Record<string, unknown>
  const global = node['global']
  if (typeof global !== 'number' || !Number.isFinite(global) || global <= 0) return 1
  const clamp = node['clamp']
  const low = Array.isArray(clamp) && typeof clamp[0] === 'number' ? clamp[0] as number : 0.3
  const high = Array.isArray(clamp) && typeof clamp[1] === 'number' ? clamp[1] as number : 5
  return Math.min(high, Math.max(low, global))
}

/** 分身：`@huggingface/tokenizers` 要 `tokenizer.json` 与同目录的 `tokenizer_config.json`。 */
type TokenizerLike = { encode(text: string, options: { add_special_tokens: boolean }): { ids: number[] } }

async function tokenizerAt(tokenizerPath: string): Promise<TokenizerLike> {
  const { Tokenizer } = await import('@huggingface/tokenizers')
  const dir = path.dirname(tokenizerPath)
  return new Tokenizer(
    JSON.parse(readFileSync(tokenizerPath, 'utf8')),
    JSON.parse(readFileSync(path.join(dir, 'tokenizer_config.json'), 'utf8')),
  ) as TokenizerLike
}

/** 一次装配的产物（初始化成功后才有）。 */
interface Built {
  readonly port: JudgePort
  readonly scorer: ScorerClient
  readonly info: JudgeReadyInfo
}

/**
 * 装配一次（异步：分词器 import + 显存查询）。
 *
 * 返回 `null` 表示"这一路不可用"——**四种原因分开记日志**，因为处置完全不同：
 * 关着 / 没配全 / 显存不够 / 文件坏了。
 */
async function buildOnce(deps: LocalJudgeHostDeps): Promise<Built | null> {
  const config = deps.config()
  if (config === null) {
    deps.log('judge: backend=jev-local 但读不到 judge 段，本地判断不启用')
    return null
  }
  const missing = (['scorerPath', 'modelPath', 'tokenizerPath'] as const).filter((key) => config[key] === '')
  if (missing.length > 0) {
    deps.log(`judge: backend=jev-local 但 ${missing.join(' / ')} 未配置，本地判断不启用（判断按不可用处理）`)
    return null
  }
  const free = await freeVramMb()
  if (!vramIsEnough(free, config.minFreeVramMb)) {
    const seen = free === null ? '未知' : String(free)
    deps.log(`judge: 空闲显存 ${seen} MB，要求至少 ${String(config.minFreeVramMb)} MB，`
      + '本地判断不启用（不降级到 CPU：CPU 又慢又费内存）')
    return null
  }
  let renderer
  let temperature = 1
  try {
    const readoutConfig = readoutAt(config.modelPath)
    renderer = createRenderer(await tokenizerAt(config.tokenizerPath), readoutOf(readoutConfig))
    renderer.verify()
    temperature = temperatureOf(readoutConfig)
  } catch (error) {
    deps.log(`judge: 渲染器装配失败（${describe(error)}），本地判断不启用`)
    return null
  }
  const scorer = createScorerClient(optionsOf(config))
  const port = createLocalJudge({
    scorer,
    renderer,
    temperature,
    clock: deps.clock,
    log: deps.log,
    timeoutMs: positiveOr(config.timeoutMs, 3_000),
    gates: gateListOf(deps),
    limits: limitsOf(config, deps.presence()),
    targetWindow: positiveOr(deps.presence()?.judgeMaxEntries ?? DEFAULTS.judgeMaxEntries, DEFAULTS.judgeMaxEntries),
    // 折判观测（阴影账本）：短语概率是"这个阈值该不该重标"的唯一证据。
    onFolded: (folded) => {
      deps.log(`judge: ${folded.scene ?? '无场景'}`
        + `${folded.phrase === null ? '' : ` ${folded.phrase.name}@${folded.phrase.probability.toFixed(3)}`}`
        + ` → ${folded.verdict.kind}`)
    },
  })
  return {
    port,
    scorer,
    info: { desc: '', loadMs: 0, rendererVerified: true, systemInfo: '' },
  }
}

/** 启用的门（每次现取：后台关掉一门，下一轮就不问它）。 */
function gateListOf(deps: LocalJudgeHostDeps): readonly GateId[] {
  const config = deps.config()
  return parseGateList(config === null ? '' : config.gatesEnabled)
}

/**
 * 造本地判断端口（**同步返回**，初始化推迟到第一次判断）。
 *
 * 返回 `null` = 配置层面就不该开（`backend` 不是 `jev-local` 或三个路径不全）。
 * 那种情况**不必等到第一次判断**才知道——装配期就该说清楚，否则日志里会出现
 * "明明配了却一直不说话"。
 */
export function localJudgeHost(deps: LocalJudgeHostDeps): LocalJudgeHost | null {
  if (!deps.enabled()) return null
  const config = deps.config()
  if (config === null) {
    deps.log('judge: backend=jev-local 但读不到 judge 段，本地判断不启用')
    return null
  }
  const missing = (['scorerPath', 'modelPath', 'tokenizerPath'] as const).filter((key) => config[key] === '')
  if (missing.length > 0) {
    deps.log(`judge: backend=jev-local 但 ${missing.join(' / ')} 未配置，本地判断不启用（判断按不可用处理）`)
    return null
  }
  // 懒初始化：一个 promise，首次判断时等到它；失败也只试一次（不在群里反复重试）。
  let pending: Promise<Built | null> | null = null
  let built: Built | null = null
  let disposed = false

  const ensure = (): Promise<Built | null> => {
    if (disposed) return Promise.resolve(null)
    if (built !== null) return Promise.resolve(built)
    pending ??= buildOnce(deps).then((value) => {
      built = value
      return value
    })
    return pending
  }

  const port: JudgePort = {
    async decide(request) {
      const ready = await ensure()
      if (ready === null) return { kind: 'no-route', detail: '本地判断未就绪（装配失败或配置不全）' }
      return await ready.port.decide(request)
    },
  }
  return {
    port,
    info: () => {
      if (built === null) return null
      const ready = built.scorer.info()
      return ready === null
        ? null
        : {
          ...built.info,
          desc: ready.desc,
          loadMs: ready.loadMs,

          systemInfo: ready.systemInfo,
        }
    },
    dispose: async () => {
      disposed = true
      const value = built ?? await pending
      built = null
      pending = null
      if (value !== null) await value.scorer.close()
    },
  }
}

/** 异常只留一句话（不打堆栈进配置面日志）。 */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}:${error.message}`.slice(0, 200)
  return String(error).slice(0, 200)
}
