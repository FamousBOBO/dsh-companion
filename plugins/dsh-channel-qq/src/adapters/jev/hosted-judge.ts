/** opencode **云端 Jev** 判断端口：`systemone` 端点 → {@link JudgePort}。
 *
 * 这一层只做四件事：**组问句 → POST → 读答案 → 折判**。业务规则在
 * `app/inbound/judge-gates.ts`（决策表）与 `judge-verdict.ts`（折判），
 * 协议形状在 `hosted-protocol.ts`，与本地路径**共用同一份**。
 *
 * 五个"为什么"：
 *   1. **不渲染 token**：云端自己分词，`request.state` 原样当 `state` 发。
 *      本地那套 `render-v1` 在这里完全不参与——混进来只会让两边口径漂移。
 *   2. **key 每次现取**：`apiKey()` 是回调而不是字符串。凭据改了下一轮就生效，
 *      而值不会出现在配置快照、后台响应或日志里（凭据库之外的任何副本都是泄漏面）。
 *   3. **必须带自定义 UA**：不带 UA 的请求会被 Cloudflare 挡成 `403 error code 1010`，
 *      那个错误体里**没有任何提示**。实测踩过。
 *   4. **错误分两类**：只有"我们自己的请求形状/代码坏了"才算 `invalid`（累积失败到暂停）；
 *      对端不稳（429 / 5xx / 网络 / 超时 / 401）一律 `no-route`——这一轮没判，不是这轮判错。
 *   5. **成本记账**：每次成功都回调 `onUsage`，让后台能回答"这套判断一个月大概多少钱"。
 */

import type { HttpClient } from '../../ports/http.js'
import type { JudgePort, JudgeRequest, JudgeVerdict } from '../../app/inbound/judge-port.js'
import type { VerdictLimits } from '../../app/inbound/judge-verdict.js'
import type { GateId, Scene } from '../../app/inbound/judge-gates.js'
import { foldVerdict } from '../../app/inbound/judge-verdict.js'
import {
  answersOf,
  bodyOf,
  buildQuestions,
  targetIdsOf,
  usageOf,
  type HostedUsage,
} from './hosted-protocol.js'

/** 造云端判断端口要的全部依赖。 */
export interface HostedJudgeDeps {
  readonly http: HttpClient
  /** 完整端点（含路径），例如 `https://opencode.ai/inference/systemone/v1/systemone`。 */
  readonly endpoint: string
  /** 模型 id（`jev-1.13` / `jev-1.13-free`）。 */
  readonly model: string
  /** **每次判断前现取**；返回 `null` = 凭据未配置（按不可用处理，不抛）。 */
  readonly apiKey: () => Promise<string | null>
  /** 请求的 `User-Agent`；空串时用兜底值（见文件头第 3 条）。 */
  readonly userAgent: string
  readonly timeoutMs: number
  readonly log: (line: string) => void
  readonly gates: readonly GateId[]
  /** 短语场景（生产固定是 `SCENES` 全量）。 */
  readonly scenes: readonly Scene[]
  readonly limits: VerdictLimits
  readonly targetWindow: number
  /** 成功一次的用量回调（成本账本）；缺省 = 不记。 */
  readonly onUsage?: ((usage: HostedUsage, request: JudgeRequest) => void) | undefined
}

/** 兜底 UA：宁可写死一个，也不让请求裸奔被 1010 挡掉。 */
const FALLBACK_UA = 'dsh-companion/jev-opencode'

/**
 * 判一次。
 *
 * 返回值的 `kind` 就是记账口径（见文件头第 4 条）：`no-route` 不累积失败，
 * `invalid` 累积。两类都**不抛**——判断层绝不把异常传进群聊循环。
 */
export function createHostedJudge(deps: HostedJudgeDeps): JudgePort {
  return {
    async decide(request: JudgeRequest): Promise<JudgeVerdict> {
      const key = await deps.apiKey()
      if (key === null) {
        deps.log('judge: jev-opencode 但凭据未配置（凭据引用名见 judge.remoteApiKeyRef）')
        return { kind: 'no-route', detail: '凭据未配置' }
      }
      const targets = targetIdsOf(request, deps.targetWindow)
      const questions = buildQuestions({ gates: deps.gates, scenes: deps.scenes, targets })
      const response = await call(deps, key, request, questions)
      if (response.kind !== 'ok') {
        deps.log(`judge: jev-opencode ${response.kind}（${response.detail}），本轮不判断`)
        return response.kind === 'invalid'
          ? { kind: 'invalid', reason: response.detail }
          : { kind: 'no-route', detail: response.detail }
      }
      const answers = answersOf(response.payload, {
        gates: deps.gates,
        scenes: deps.scenes,
        targets,
      })
      if (answers === null) {
        deps.log('judge: jev-opencode 回复结构不可用（answers 段缺失或形状不对）')
        return { kind: 'invalid', reason: 'shape' }
      }
      const folded = foldVerdict(answers, request, deps.limits, deps.targetWindow)
      // 成功一行：**带上用量**。没有这一行，"云端到底有没有真的在判"只能靠猜——
      // 而失败分支都会打日志、成功分支沉默时，最典型的误判是"看着像在工作其实全在 no-route"。
      const usage = usageOf(response.payload)
      deps.log(`judge: jev-opencode ${folded.verdict.kind === 'decision' ? folded.verdict.action : folded.verdict.kind}`
        + `（${usage.inputTokens} tok / $${usage.costUsd.toFixed(8)}）`)
      return folded.verdict
    },
  }
}

/** 一次调用的结果（`ok` 才带 payload）。 */
type CallOutcome =
  | { readonly kind: 'ok'; readonly payload: unknown }
  | { readonly kind: 'no-route'; readonly detail: string }
  | { readonly kind: 'invalid'; readonly detail: string }

/** 发一次请求并按状态码分类（分类表见文件头第 4 条）。 */
async function call(
  deps: HostedJudgeDeps,
  key: string,
  request: JudgeRequest,
  questions: ReturnType<typeof buildQuestions>,
): Promise<CallOutcome> {
  const body = bodyOf(deps.model, request.state, questions)
  let response
  try {
    response = await deps.http.request(deps.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'user-agent': deps.userAgent === '' ? FALLBACK_UA : deps.userAgent,
      },
      body,
      timeoutMs: deps.timeoutMs,
    })
  } catch (error) {
    // 网络层/超时：对端没给出任何可用回答，这一轮按没判处理。
    return { kind: 'no-route', detail: `transport:${describe(error)}` }
  }
  if (!response.ok) return failureOf(response)
  let payload: unknown
  try {
    payload = response.json()
  } catch (error) {
    // 200 但正文不是 JSON：那是我们解析不了，算形状错。
    return { kind: 'invalid', detail: `bad-json:${describe(error)}` }
  }
  const usage = usageOf(payload)
  deps.onUsage?.(usage, request)
  return { kind: 'ok', payload }
}

/** 非 2xx 的分类：401/403/429/5xx 按"没判"，400 按"配置错"。 */
function failureOf(response: { readonly status: number; text(): string }): CallOutcome {
  const body = clip(response.text())
  const type = errorTypeOf(body)
  if (response.status === 400) return { kind: 'invalid', detail: `bad-request:${type}` }
  if (response.status === 401 || response.status === 403) {
    // 403 + 1010 = Cloudflare 挡 UA；403 其余 = 凭据/权限。两者都不是"判错"。
    return { kind: 'no-route', detail: `auth:${String(response.status)}:${type}` }
  }
  return { kind: 'no-route', detail: `status:${String(response.status)}:${type}` }
}

/** 错误体里的 `error.type`（读不到时返回 `?`）。 */
function errorTypeOf(body: string): string {
  const match = /"type"\s*:\s*"([^"]+)"/.exec(body)
  if (match?.[1] !== undefined) return match[1]
  if (/error code 1010/.test(body)) return 'cloudflare-1010'
  return '?'
}

/** 压成一行并截断（日志与 `detail` 都走它）。 */
function clip(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160)
}

/** 异常只留一句话。 */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}:${error.message}`.slice(0, 160)
  return String(error).slice(0, 160)
}
