/** 判断后端的三路**接线**：从 `judge.*` 配置造出端口，再交给执行器。
 *
 * 为什么单独一个文件：`presence-wiring.ts` 已经贴着单文件行数上限（400 行），
 * 而这段要同时读配置、判断开关、造适配器、留拆卸钩子——塞进去会直接把那个文件顶穿。
 * 分出来之后，主装配里只剩一行调用，读起来也只剩"接不接这一路"这个结论。
 *
 * 三条后端共享**同一个判断口径**（九门问句、决策表、短语库、折判函数），差别只在"谁打分"：
 *
 * | `backend` | 打分者 | 端口来源 |
 * |---|---|---|
 * | `host` | 宿主默认模型（组一段提示词，自由文本） | **没有端口**——走 `presence-cycle.ts` |
 * | `jev-opencode` | opencode 云端 `systemone` | `hostedJudgeHost` |
 * | `jev-local` | 本机 `jev-score` 子进程 | `localJudgeHost` |
 *
 * 四条口径：
 *   1. **关着时一个对象都不造**：后端不是那一路时对应 `*Host()` 直接返回 `null`，
 *      主装配于是完全不接这一路（行为回到今日的宿主模型）；
 *   2. **不抛**：配置读不到、路径没配全、显存不够、端点为空，全部折成 `null` + 一行日志；
 *   3. **拆卸跟着执行器走**：`dispose` 由主装配的 `dispose` 调用一次（两路都可能没有对象）；
 *   4. **两路只有一个能开**：`enabled()` 按后端名互斥，所以不会同时起子进程与云端请求。
 */

import type { JudgeReadyInfo, JudgeView } from '../../adapters/dsh-host/judge-host.js'
import { localJudgeHost } from '../../adapters/dsh-host/judge-host.js'
import { hostedJudgeHost, type HostedJudgeInfo } from '../../adapters/dsh-host/judge-hosted-host.js'
import { systemHttp } from '../../adapters/http/client.js'
import type { JudgePort } from '../../app/inbound/judge-port.js'
import { systemClock } from '../../ports/clock.js'
import type { SubHost } from '../plugin-kit.js'

/** 接线结果：端口（可能没有）+ 收尾 + 当前状态（后台诊断用）。 */
export interface JudgeWiring {
  /** 两条 typed 后端之一开着时才有；缺省 = 这一路不开（宿主模型那条照旧）。 */
  readonly port?: JudgePort
  /** 现取后端名（`host` / `jev-opencode` / `jev-local`）：判断分派每次现取它。 */
  readonly backend: () => string
  /** 本地打分器的就绪信息（`jev-local` 且还没启动过 = `null`）。 */
  readonly info: () => JudgeReadyInfo | null
  /** 云端判断的累计用量（`jev-opencode` 才有；没有这一路 = `null`）。 */
  readonly remoteInfo: () => HostedJudgeInfo | null
  /** 现取模型名（云端 = `judge.remoteModel`；本地 = 权重文件名；`host` = `''`）。 */
  readonly model: () => string
  readonly dispose: () => Promise<void>
}

/** 读 `judge` 段（旧配置里没有这一段时给 `null`）。 */
function judgeOf(host: SubHost): JudgeView | null {
  const section = (host.config as { readonly judge?: JudgeView }).judge
  return section ?? null
}

/** 现取模型名（只用于后台诊断与跨通道状态，不参与判断）。 */
function modelOf(host: SubHost, which: 'local' | 'remote'): string {
  const config = judgeOf(host)
  if (config === null) return ''
  if (which === 'remote') return config.remoteModel
  const file = config.modelPath.replace(/\\/g, '/').split('/').pop() ?? ''
  return file
}
/** 取凭据的回调：宿主桥没有这个面时给 `undefined`，`hostedJudgeHost` 会退回既有通路。 */
function credentialOf(host: SubHost): ((ref: string) => Promise<string | null>) | undefined {
  const lookup = host.bridge.credential
  return typeof lookup === 'function' ? (ref: string) => lookup.call(host.bridge, ref) : undefined
}

/**
 * 接上判断这一路（三选一）。
 *
 * **同步返回**：`jev-local` 的初始化（读 12 MB 分词器、查显存）推迟到第一次判断；
 * 云端那一路没有初始化开销，装配期就把"配置全不全"判掉。
 */
export function judgeWiring(host: SubHost): JudgeWiring {
  const backend = (): string => judgeOf(host)?.backend ?? 'host'
  const local = localJudgeHost({
    config: () => judgeOf(host),
    presence: () => host.config.presence ?? null,
    clock: systemClock,
    log: host.log,
    enabled: () => backend() === 'jev-local',
  })
  const remote = hostedJudgeHost({
    config: () => judgeOf(host),
    presence: () => host.config.presence ?? null,
    http: systemHttp,
    credential: credentialOf(host),
    host: host.bridge,
    log: host.log,
    enabled: () => backend() === 'jev-opencode',
  })
  if (local !== null) {
    return {
      port: local.port,
      backend,
      info: local.info,
      remoteInfo: () => null,
      model: () => modelOf(host, 'local'),
      dispose: local.dispose,
    }
  }
  if (remote !== null) {
    return {
      port: remote.port,
      backend,
      info: () => null,
      remoteInfo: remote.info,
      model: () => modelOf(host, 'remote'),
      dispose: async () => { /* 云端没有进程或句柄要收 */ },
    }
  }
  return {
    backend,
    info: () => null,
    remoteInfo: () => null,
    model: () => '',
    dispose: async () => { /* 没造对象就没什么可收 */ },
  }
}
