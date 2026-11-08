/**
 * **唯一的适配层**：把评测运行器接到真实实现上。
 *
 * 为什么只有这一个文件：解析器与执行器是 `src/app/inbound/group-social-decision.ts` +
 * `app/inbound/presence-flow.ts` + `core/presence.ts` 里的**真实代码**，评测不许自己再写一套
 * 判定"自证"（那样测的是另一份实现，绿了也不说明线上对）。所以这里的职责只有两件：
 * **import** 与 **形状转换**（把语料里的背景消息/假时钟/假平台/假模型输出转成这些模块
 * 要的入参）。判定逻辑一个字都不在这里。
 *
 * 加载顺序：
 *   1. `build/lib/app/inbound/*.js`（tsc 产物；与线上同一份代码）
 *   2. 产物不存在时退到 `src/` 下的 `.ts`（Node 24 的类型剥离 + 本目录的 `ts-resolve-hook.mjs`
 *      负责把源码里写死的 `./x.js` 映射到 `./x.ts`）
 *   两条通道跑的是同一份源码语义；报告里会写明这次用的是哪一种（`IMPL.source`）。
 *
 * 实现方（Lead）若改导出名：**只改这个文件**，`run.mjs` 与 `corpus.mjs` 不动。
 */

import { register } from 'node:module'

/** 真实模块（相对本文件的 `build/lib` 与 `src` 两处）。 */
const EXPORTS = {
  decision: 'app/inbound/group-social-decision',
  flow: 'app/inbound/presence-flow',
  presence: 'core/presence',
}

const DEBUG = process.env.EVAL_GROUP_DEBUG === '1'

function log(line) {
  if (DEBUG) console.error(`[adapter] ${line}`)
}

/** 按候选基址依次尝试 import；`module: null` = 这个基址下没有。 */
async function tryImport(rel, bases) {
  const problems = []
  for (const base of bases) {
    const specifier = `${base}/${rel}.js`
    try {
      return { module: await import(specifier), specifier, problems }
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
      problems.push(specifier)
    }
  }
  return { module: null, problems }
}

/**
 * 加载真实模块；先后两条通道，报告里写明用到了哪一条。
 *
 * `EVAL_GROUP_IMPL=src` 强制走 TypeScript 源码那条（用来验证退路本身没坏；
 * 默认不设，走构建产物）。
 */
async function loadImpl() {
  const forceSrc = process.env.EVAL_GROUP_IMPL === 'src'
  const decision = forceSrc ? { module: null, problems: ['（EVAL_GROUP_IMPL=src 强制走源码）'] } : await tryImport(EXPORTS.decision, ['../../build/lib', '../../lib'])
  if (decision.module !== null) {
    const flow = await tryImport(EXPORTS.flow, ['../../build/lib', '../../lib'])
    const presence = await tryImport(EXPORTS.presence, ['../../build/lib', '../../lib'])
    if (flow.module === null || presence.module === null) {
      throw new Error(
        `build/lib 里有决策模块但缺执行器：${[...flow.problems, ...presence.problems].join(', ')}`
        + '\n  先跑 npm run build（评测要跑线上同一份产物，不另写一份判定）。',
      )
    }
    log(`loaded from build: ${decision.specifier}`)
    return { source: 'build/lib（tsc 产物）', decision: decision.module, flow: flow.module, presence: presence.module }
  }

  // 退路：直接跑 TS 源码（没有任何构建产物的机器上也能跑评测）。
  register('./ts-resolve-hook.mjs', import.meta.url)
  const base = new URL('../../src/', import.meta.url)
  const ts = (rel) => new URL(`${rel}.ts`, base).href
  const decisionTs = await import(ts(EXPORTS.decision))
  const flowTs = await import(ts(EXPORTS.flow))
  const presenceTs = await import(ts(EXPORTS.presence))
  log(`loaded from src: ${ts(EXPORTS.decision)}`)
  return {
    source: 'src/**.ts（没有构建产物，直接跑 TypeScript 源码）',
    decision: decisionTs,
    flow: flowTs,
    presence: presenceTs,
  }
}

const impl = await loadImpl()

/** 这次跑的是哪一份实现（报告里要写明，否则"绿了"说不清绿的是什么）。 */
export const IMPL = Object.freeze({
  source: impl.source,
  decisionModule: EXPORTS.decision,
  flowModule: EXPORTS.flow,
  presenceModule: EXPORTS.presence,
})

/** 五个动作（§6.1）。语料里的取值必须在这一组里，运行器据此校验语料本身。 */
export const ACTIONS = Object.freeze(['silent', 'observe', 'reply', 'join', 'react'])

/** 解析模型输出（真实实现）。 */
export const parseSocialDecision = impl.decision.parseSocialDecision

/** 发送前校验（真实实现）。 */
export const validateSocialDecision = impl.decision.validateSocialDecision

/** 这个动作会不会发消息（真实实现）。 */
export const sendsMessage = impl.decision.sendsMessage

/** 一次完整流程：组提示词 → 调模型 → 解析 → 校验 → 限频 → 发 → 记账（真实实现）。 */
export const runPresenceCycle = impl.flow.runPresenceCycle

/** 流程里的默认值（长度上限、时间窗、限频间隔……都从这里取，不在评测里另抄一份）。 */
export const DEFAULTS = impl.flow.DEFAULTS

/** 限频记账（真实实现）。 */
export const presence = impl.presence

// ── 形状转换（语料 → 真实模块的入参） ───────────────────────────────────────

/**
 * 语料的背景消息 → `JudgeEntry`。
 *
 * `text` 是**已渲染的入站行**（含发送者/时间/消息号），`body` 是正文。语料只写正文，
 * 抬头由这里补——这样评测输入与线上 `renderMessageContent()` 的形状一致。
 */
export function judgeEntries(background) {
  return background.map((entry) => ({
    messageId: entry.messageId ?? null,
    name: entry.name ?? '',
    userId: entry.userId,
    text: renderInboundLine(entry),
    self: entry.self === true,
    atMs: entry.atMs,
    body: entry.text,
  }))
}

/** 线上那条渲染形状的近似（评测只用于"看起来像真实输入"，判定不读它）。 */
function renderInboundLine(entry) {
  if (entry.self === true) return entry.text
  const name = entry.name === undefined || entry.name === '' ? `QQ ${String(entry.userId)}` : `${entry.name}(${String(entry.userId)})`
  return `时间 ${clockOf(entry.atMs)} ${name} #${String(entry.messageId ?? '-')}：${entry.text}`
}

function clockOf(atMs) {
  const date = new Date(atMs)
  const two = (value) => String(value).padStart(2, '0')
  return `${two(date.getHours())}:${two(date.getMinutes())}`
}

/** 解析/校验共用的上下文（`DecisionContext`）。 */
export function decisionContext({ background, nowMs, replyMaxChars, windowMs }) {
  return {
    messages: background.map((entry) => ({ messageId: entry.messageId ?? null, atMs: entry.atMs })),
    replyMaxChars,
    nowMs,
    windowMs,
  }
}

/** 假时钟：冻结在 `nowMs`（整条路径不再读系统时间，重放结果稳定）。 */
export function fakeClock(nowMs) {
  let now = nowMs
  return {
    now: () => now,
    date: () => new Date(now),
    setTimeout: () => ({ cancel: () => {} }),
    setInterval: () => ({ cancel: () => {} }),
    advance: (ms) => { now += ms },
  }
}

/**
 * 假平台：`sendGroupMessage` 的回执形态由用例决定。
 *   'ok'      正常回 `{ message_id }`（唯一算"说过话"的形态）
 *   'missing' 发出去但**没有** message_id（线上真实可能：协议换了字段名）
 *   'throw'   直接抛错
 */
export function fakePlatform(mode = 'ok') {
  const sends = []
  let nextId = 900001
  const platform = {
    selfId: 88888,
    isConnected: () => true,
    api: {
      sendGroupMessage: async (groupId, message) => {
        sends.push({ groupId, message })
        if (mode === 'throw') throw new Error('模拟发送失败')
        if (mode === 'missing') return {}
        nextId += 1
        return { message_id: nextId }
      },
    },
  }
  return { platform, sends }
}

/** 假模型：把语料里那行固定输出原样当补全结果返回（零模型调用）。 */
export function fakeComplete(raw, { kind = 'text' } = {}) {
  const engine = {
    calls: [],
    async complete(request) {
      engine.calls.push(request)
      if (kind !== 'text') return { kind, detail: '模拟不可用' }
      return { kind: 'text', text: raw }
    },
  }
  return engine
}

/**
 * 假记账状态：`emptyPresenceState(now)` 之后按用例的 `limit` 回填。
 * 限频判断本身仍走真实的 `presence.speakVerdict`——这里只提供"账本上已经有什么"。
 *
 * **默认（用例没写 `limit`）= 冷却已过、这一小时还没说过话**：一个小时的假账本。
 * 为什么不是 `emptyPresenceState()` 的原样：那个函数故意把 `speakAtMs` 设成"现在"
 * （热加载/重启后不许立刻开口，见 core/presence.ts 的口径 3），拿它当默认会让**每一条**
 * 用例都被冷却拦下——测出来的是"重启后第一轮不说"，而不是这一条用例要压的那道闸。
 * 要测冷却/额度的用例自己写 `limit`（G24 / G26），账本由真实 `speakVerdict` 判。
 */
export function fakePresenceState({ nowMs, sentLastHour = 0, sinceLastSpeakMs = null }) {
  const base = impl.presence.emptyPresenceState(nowMs)
  const speakAtMs = sinceLastSpeakMs === null ? nowMs - 3_600_000 : nowMs - sinceLastSpeakMs
  const sentTimes = Array.from({ length: sentLastHour }, (_, index) => nowMs - 1_000 - index * 1_000)
  return { ...base, speakAtMs, sentTimes }
}
