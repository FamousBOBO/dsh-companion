/** 本地 Jev 判断适配器：把 `JudgeRequest` 变成"九门 + 四个短语库 + 目标"的一次打分，再折成 verdict。
 *
 * 这一层只做四件事：**组问句 → 渲染 → 打分 → 概率**。业务规则在
 * `app/inbound/judge-gates.ts`（决策表）与 `judge-verdict.ts`（折判），
 * 分词与槽位在 `render-v1.ts`，进程在 `scorer-client.ts`。
 *
 * 四个"为什么"：
 *   1. **不生成文本**：文案从短语库里**选**，所以这里没有 prompt、没有 system 角色、
 *      没有 chat 模板——一条 token 都不进"生成"路径。
 *   2. **温度取自 `readout_config.json` 的 `temperatures.global`**：那是校准过的；
 *      换温度等于换概率，`phraseMinProbability` 那个阈值就失去意义。
 *   3. **九门 + 四个短语库 + 目标都在一次请求里**：实测 13 个问句 347 ms，
 *      拆成几次请求反而更慢（每次都要重新解码 prefix）。
 *   4. **按场景分别问短语**：一个库四五条选项，比"一次在全库二十条里选"判得准
 *      （选项越少，同一个句子的概率越集中）。
 */

import type { JudgePort, JudgeRequest, JudgeVerdict } from '../../app/inbound/judge-port.js'
import {
  GATE_QUESTIONS,
  phrasesOf,
  SCENES,
  type GateId,
  type Scene,
} from '../../app/inbound/judge-gates.js'
import {
  foldVerdict,
  type FoldOutcome,
  type ScoredAnswer,
  type TypedAnswers,
  type VerdictLimits,
} from '../../app/inbound/judge-verdict.js'
import type { Clock } from '../../ports/clock.js'
import type { Renderer, RenderQuestion } from './render-v1.js'
import type { ScorerClient } from './scorer-client.js'
import type { ScoreQuestion } from './scorer-protocol.js'

/** 造一个本地 Jev 判断端口要的全部依赖。 */
export interface LocalJudgeDeps {
  readonly scorer: ScorerClient
  readonly renderer: Renderer
  /** 校准温度（`readout_config.json` 的 `temperatures.global`）。 */
  readonly temperature: number
  readonly clock: Clock
  readonly log: (line: string) => void
  /** 超过这个毫秒数就放弃（覆盖 spawn + 打分全过程）。 */
  readonly timeoutMs: number
  /** 启用的门（`judge.gatesEnabled` 解析后的结果）。 */
  readonly gates: readonly GateId[]
  /** 折判阈值。 */
  readonly limits: VerdictLimits
  /** 目标选择最多看最近几条消息号（`judge.targetWindow`）。 */
  readonly targetWindow: number
  /** 折判结果的观测回调（写 shadow 账本用）；缺省 = 不记。 */
  readonly onFolded?: ((outcome: FoldOutcome, request: JudgeRequest) => void) | undefined
}

/** 短语选择的问句（四个库共用同一句：问法一致，概率才可比）。 */
const PHRASE_QUESTION = '她插一句最合适的是哪一句'
/** 目标选择的问句。 */
const TARGET_QUESTION = '她最自然的做法是回应哪一条消息'

/** 计划里的一道问句。 */
interface Planned {
  /** 问句 id：门 id / `phrase:<scene>` / `target`。 */
  readonly id: string
  readonly question: RenderQuestion
  /** 槽位对应的选项名（顺序与 `slots` 一致）。 */
  readonly names: readonly string[]
  /** 短语场景（只有 `phrase:*` 有）。 */
  readonly scene?: Scene
}

/**
 * 造一个本地 Jev 判断端口。
 *
 * 计划阶段就排好全部问句：**门永远问**（启用的那些），四个短语库也永远问，
 * 目标只在有候选消息号时问。一次请求打完，再由决策表挑用哪个库的结果。
 */
export function createLocalJudge(deps: LocalJudgeDeps): JudgePort {
  return {
    async decide(request: JudgeRequest): Promise<JudgeVerdict> {
      const planned = plan(request, deps.gates, deps.targetWindow)
      if (planned.length === 0) {
        return { kind: 'no-route', detail: '这一轮没有可判断的消息' }
      }
      const rendered: Array<{ item: Planned; value: ReturnType<Renderer['render']> }> = []
      for (const item of planned) {
        try {
          rendered.push({ item, value: deps.renderer.render(request.state, item.question) })
        } catch (error) {
          return { kind: 'invalid', reason: `render:${describe(error)}` }
        }
      }
      // **协议细节（抄错会静默给出错答案）**：`prefix` 是状态段，`questions[].ids` 只放
      // **问句段**，而 `slots` 仍然是 **prefix+question 的绝对位置**。
      // 参考实现就是这么发的（`jev_style_decision_gguf.py` 的 `_scores_many`：
      // `"ids": r.ids[r.prefix_len:]`）。整条 `ids` 一起发的话，打分器会把状态段当成问句
      // 的开头去贴位置，槽位对不上——它**不报错**，只是读回一批错位置的 logit，
      // 于是九门全部判成 true（实测表现为"每一条都 safety:conflict"）。
      const questions: ScoreQuestion[] = rendered.map((entry) => ({
        ids: entry.value.ids.slice(entry.value.prefixLen),
        slots: entry.value.slots,
        rows: deps.renderer.rows,
      }))
      // 所有问句共用同一份状态，所以 prefix 取第一道问句的前缀段即可。
      const prefix = rendered[0]?.value.ids.slice(0, rendered[0].value.prefixLen) ?? []
      const outcome = await deps.scorer.score({
        prefix,
        questions,
        timeoutMs: deps.timeoutMs,
        clock: deps.clock,
      })
      if (outcome.kind === 'no-route') {
        deps.log(`judge: 不可用（${outcome.detail}）`)
        return { kind: 'no-route', detail: outcome.detail }
      }
      if (outcome.kind !== 'scores') {
        deps.log(`judge: 打分失败（${outcome.kind}:${outcome.detail}）`)
        return { kind: 'invalid', reason: `${outcome.kind}:${outcome.detail}` }
      }
      const answers = collect(rendered, outcome.results, deps.temperature)
      if (answers === null) return { kind: 'invalid', reason: 'scores-shape' }
      const folded = foldVerdict(answers, request, deps.limits, deps.targetWindow)
      deps.onFolded?.(folded, request)
      return folded.verdict
    },
  }
}

/** 排这一轮的全部问句。 */
function plan(request: JudgeRequest, gates: readonly GateId[], targetWindow: number): Planned[] {
  const planned: Planned[] = gates.map((id) => ({
    id,
    question: { t: 'noul', ins: GATE_QUESTIONS[id], crit: null },
    names: ['false', 'true'],
  }))
  for (const scene of SCENES) {
    const bank = phrasesOf(scene)
    planned.push({
      id: `phrase:${scene}`,
      question: { t: 'choice', ins: PHRASE_QUESTION, crit: bank },
      names: Object.keys(bank),
      scene,
    })
  }
  const targets = request.lines
    .filter((line) => !line.self && line.messageId !== null)
    .map((line) => line.messageId as number)
  const windowed = targetWindow > 0 ? targets.slice(-targetWindow) : targets
  if (windowed.length > 0) {
    planned.push({
      id: 'target',
      question: {
        t: 'choice',
        ins: TARGET_QUESTION,
        crit: Object.fromEntries(windowed.map((id) => [String(id), null])),
      },
      names: windowed.map((id) => String(id)),
    })
  }
  return planned
}

/** 把打分器的原始 logit 变成概率与答案（形状不对返回 `null`）。 */
function collect(
  rendered: ReadonlyArray<{ item: Planned; value: ReturnType<Renderer['render']> }>,
  results: ReadonlyArray<ReadonlyArray<readonly number[]>>,
  temperature: number,
): TypedAnswers | null {
  if (results.length !== rendered.length) return null
  const gates: Partial<Record<GateId, ScoredAnswer>> = {}
  const phrases: Partial<Record<Scene, ScoredAnswer>> = {}
  let target: ScoredAnswer | undefined
  for (let index = 0; index < rendered.length; index++) {
    const entry = rendered[index]
    const rows = results[index]
    if (entry === undefined || rows === undefined) return null
    const scored = probabilitiesOf(rows, entry.item.names, temperature)
    if (scored === null) return null
    const id = entry.item.id
    if (id === 'target') { target = scored; continue }
    if (entry.item.scene !== undefined) { phrases[entry.item.scene] = scored; continue }
    gates[id as GateId] = scored
  }
  return { gates, phrases, target }
}

/** 每槽的 `yes - no` 分数 → softmax(scores / T) → 答案与概率。 */
function probabilitiesOf(
  rows: ReadonlyArray<readonly number[]>,
  names: readonly string[],
  temperature: number,
): ScoredAnswer | null {
  if (names.length === 0 || rows.length !== names.length) return null
  const temps = Number.isFinite(temperature) && temperature > 0 ? temperature : 1
  const scores: number[] = []
  for (const row of rows) {
    const yes = row[0]
    const no = row[1]
    if (typeof yes !== 'number' || typeof no !== 'number') return null
    if (!Number.isFinite(yes) || !Number.isFinite(no)) return null
    scores.push((yes - no) / temps)
  }
  const top = Math.max(...scores)
  const exps = scores.map((score) => Math.exp(score - top))
  const total = exps.reduce((sum, value) => sum + value, 0)
  if (!(total > 0)) return null
  let best = 0
  for (let index = 1; index < exps.length; index++) {
    if ((exps[index] ?? 0) > (exps[best] ?? 0)) best = index
  }
  const name = names[best]
  if (name === undefined) return null
  return { answer: name, topProbability: (exps[best] ?? 0) / total }
}

/** 异常只留一句话（不打堆栈进配置面日志）。 */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}:${error.message}`.slice(0, 200)
  return String(error).slice(0, 200)
}
