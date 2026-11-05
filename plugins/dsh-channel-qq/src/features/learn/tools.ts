/** 群聊学习的工具面 (P4.2)：4 个工具——查口癖 / 手动记 / 忘掉 / 运行状态。
 *
 * spec 逐字节来自原来的 `registerLearnTools`——P4 的判据是工具名、描述与参数
 * schema 一条都不许变（`test/golden/tools/other-tools.txt` 钉着这一点）。
 * 原来的注册函数 75 行、超 60 行硬上限，所以一个工具一个工厂函数，注册函数
 * 只负责组表。ctx 只收成 `ToolHost`（features/ 不该认识 cordis 宿主）。
 */

import { registerSpecs, params, type ToolHost, type ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQChannelConfig } from '../../config.js'
import type { QQApi } from '../../ports/platform.js'
import type { OutboundQueue } from '../../outbound.js'
import type { LearnStore } from './store.js'

/** 配置里关掉学习时，四个工具统一的回复。 */
type Disabled = { ok: boolean; note: string }

/** `qq_learned_phrases` — 看看群友最近在复读什么。 */
function qqLearnedPhrases(config: QQChannelConfig, store: LearnStore, disabled: Disabled): ToolSpec {
  return {
    name: 'qq_learned_phrases',
    description: '看看群友最近在复读什么（本群高频短句/口头禅，带出现次数和语境）。这是"活人感"的素材库：学到了就在合适的时候自然用出来，比如聊到对应的梗时顺口接一句；不要生硬堆砌、不要每句都塞，也不要拿它冒充别人说话。',
    parameters: params({
      limit: { type: 'number', description: '返回几条，默认 20' },
      groupId: { type: 'number', description: '只看某个群；不传 = 所有群一起看' },
    }),
    run: (args) => {
      if (!config.learn.enabled) return disabled
      const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(200, Math.round(Number(args.limit)))) : 20
      const groupId = Number.isFinite(Number(args.groupId)) ? Number(args.groupId) : undefined
      const phrases = store.top(limit, groupId)
      return { count: phrases.length, phrases }
    },
  }
}

/** `qq_learn_phrase` — 手动记住一句群里的梗/口头禅。 */
function qqLearnPhrase(config: QQChannelConfig, store: LearnStore, disabled: Disabled): ToolSpec {
  return {
    name: 'qq_learn_phrase',
    description: '手动记住一句群里的梗/口头禅（自动学习可能还没攒够次数）。遇到明显会反复出现、又值得学的短句时用；之后说的时候自然一点，别生硬塞。',
    parameters: params({
      text: { type: 'string', description: '要记住的短语，写群里真实说过的原话（2–20 字）' },
      groupId: { type: 'number', description: '这句话属于哪个群；不传 = 主群' },
    }, ['text']),
    run: async (args) => {
      if (!config.learn.enabled) return disabled
      const text = String(args.text ?? '').trim()
      if (text === '') throw new Error('text 不能为空，填一句群里真实说过的短话。')
      const groupId = Number.isFinite(Number(args.groupId)) ? Number(args.groupId) : (config.primaryGroup ?? 0)
      const phrase = await store.remember(text, groupId)
      return { ok: true, phrase }
    },
  }
}

/** `qq_forget_phrase` — 忘掉某个短语。 */
function qqForgetPhrase(config: QQChannelConfig, store: LearnStore, disabled: Disabled): ToolSpec {
  return {
    name: 'qq_forget_phrase',
    description: '忘掉某个短语（学歪了、太怪、或者不该学的，用它清掉）。下次查询就不会再出现。',
    parameters: params({
      text: { type: 'string', description: '要忘掉的短语原文' },
    }, ['text']),
    run: async (args) => {
      if (!config.learn.enabled) return disabled
      const text = String(args.text ?? '').trim()
      if (text === '') throw new Error('text 不能为空，写清楚要忘掉哪句。')
      const forgotten = await store.forget(text)
      return forgotten
        ? { ok: true, forgotten: true, text }
        : { ok: true, forgotten: false, text, note: '没找到这句，可能还没学到或者已经被忘了' }
    },
  }
}

/** `qq_learn_word` — 记一条黑话/新词（带释义）。 */
function qqLearnWord(config: QQChannelConfig, store: LearnStore, disabled: Disabled): ToolSpec {
  return {
    name: 'qq_learn_word',
    description: '记一条群里的黑话/新词，并写清它在群里是什么意思。遇到看不懂或明显是小圈子用法的词时，先问清楚再用它记下来；之后见到这个词能想起释义。',
    parameters: params({
      text: { type: 'string', description: '词条本身（群里实际用的写法，2–20 字）' },
      meaning: { type: 'string', description: '一句释义：在群里是什么意思、怎么用' },
      groupId: { type: 'number', description: '属于哪个群；不传 = 主群' },
    }, ['text', 'meaning']),
    run: async (args) => {
      if (!config.learn.enabled) return disabled
      const groupId = Number.isFinite(Number(args.groupId)) ? Number(args.groupId) : (config.primaryGroup ?? 0)
      const word = await store.rememberWord(String(args.text ?? ''), String(args.meaning ?? ''), groupId)
      return { ok: true, word }
    },
  }
}

/** `qq_slang` — 查群里的黑话词条。 */
function qqSlang(config: QQChannelConfig, store: LearnStore, disabled: Disabled): ToolSpec {
  return {
    name: 'qq_slang',
    description: '查群里记过的黑话/新词（带释义与出现次数）。聊天里遇到这些词时按释义理解，不要按字面猜。',
    parameters: params({
      limit: { type: 'number', description: '返回几条，默认 50' },
      groupId: { type: 'number', description: '只看某个群；不传 = 所有群' },
    }),
    run: (args) => {
      if (!config.learn.enabled) return disabled
      const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(200, Math.round(Number(args.limit)))) : 50
      const groupId = Number.isFinite(Number(args.groupId)) ? Number(args.groupId) : undefined
      const words = store.slang(limit, groupId)
      return { count: words.length, words }
    },
  }
}

/** `qq_learn_stats` — 群聊学习的运行状态。 */
function qqLearnStats(config: QQChannelConfig, store: LearnStore, disabled: Disabled): ToolSpec {
  return {
    name: 'qq_learn_stats',
    description: '群聊学习的运行状态：内存里跟踪多少条候选、已经落盘多少条、落盘文件在哪。怀疑"学了但没生效"时先看这个。',
    parameters: params({}),
    run: () => {
      if (!config.learn.enabled) return disabled
      return {
        ...store.stats(),
        enabled: config.learn.enabled,
        autoCapture: config.learn.autoCapture,
        minOccurrences: config.learn.minOccurrences,
        file: store.file,
      }
    },
  }
}

/**
 * 注册群聊学习工具。
 *
 * 参数顺序与原来一致（调用方 src/index.ts 不改）；api/out 本组工具用不到，
 * 但保留在签名里，调用方按原样传参。
 */
export function registerLearnTools(
  ctx: ToolHost,
  config: QQChannelConfig,
  api: QQApi,
  out: OutboundQueue,
  log: (line: string) => void,
  store: LearnStore,
): () => void {
  const disabled = { ok: false, note: '群聊学习已在配置里关闭' }
  const specs: ToolSpec[] = [
    qqLearnedPhrases(config, store, disabled),
    qqLearnPhrase(config, store, disabled),
    qqForgetPhrase(config, store, disabled),
    qqLearnStats(config, store, disabled),
    // B4：默认不注册（关着时工具面与旧版逐字节一致）。
    ...(config.learn.slang ? [qqLearnWord(config, store, disabled), qqSlang(config, store, disabled)] : []),
  ]
  return registerSpecs(ctx, specs, log, 'learn')
}
