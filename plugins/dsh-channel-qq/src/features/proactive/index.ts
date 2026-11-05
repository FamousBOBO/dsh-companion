/** 主动性子插件（P5.4 / P6f）：把主动行为的生命周期收进自己的 fiber。
 *
 * 两套实现，由 `proactive.v2` 在**装配期**选一套（开关改动会命中 watches → 重挂）：
 *
 *   - 关（默认）：旧 `Scheduler`（`./events.ts`，从 `src/scheduler.ts` 逐字搬来）——
 *     时刻表写死在代码里，行为与从前一字不差；
 *   - 开：`ProactiveExecutor`（`./executor.ts`）读**事件书**（配置里那份 JSON），
 *     并注册内建 job（`knowledge.extract`）。
 *
 * 它要的三样东西全从服务袋取——回合发起（inbound）、组包器（persona）、知识抽取
 * （memory；未就绪/未配置时返回 0，与旧 `onExtract` 闭包一致）。
 *
 * 启动时机与原实现严格对齐：`start()` 在 platform 的 `client.start()` 与 inbound
 * 的 `reattachAll()` 之后执行（装载顺序见 `src/sections.ts`）。
 */

import type { PromptComposer } from '../../app/conversation/prompt-composer.js'
import { parseEventBook, type EventBook } from '../../core/schedule/event-book.js'
import { systemClock } from '../../ports/clock.js'
import { Scheduler } from './events.js'
import { ProactiveExecutor } from './executor.js'
import { registerJob } from './jobs.js'
import { knowledgeExtractJob } from './knowledge-job.js'
import type { InboundParts, SubHost, SubPlugin } from '../plugin-kit.js'

/** host → 实例：apply 造、start 启、dispose 收，三处都要拿到同一个对象。 */
const runners = new WeakMap<SubHost, ProactiveRunner>()

/** 两套实现共同的形状（`Scheduler` 与执行器都天然满足）。 */
interface ProactiveRunner {
  start(): void
  dispose(): void
}

export const proactivePlugin: SubPlugin = {
  name: 'proactive',
  // 开关或书改了都重挂：实现选型与书的校验都在装配期完成，
  // 配一本坏书不该等到下一个整点才炸。
  watches: ['proactive'],
  requires: ['inbound', 'persona'],
  apply(host) {
    const inbound = host.need('inbound')
    const composer = host.need('persona').composer
    const runner = host.config.proactive.v2
      ? buildExecutor(host, inbound, composer)
      : buildScheduler(host, inbound, composer)
    runners.set(host, runner)
    return () => {
      runners.delete(host)
      runner.dispose()
    }
  },
  start(host) {
    runners.get(host)?.start()
  },
}

/** 旧路径：写死的时刻表。 */
function buildScheduler(host: SubHost, inbound: InboundParts, composer: PromptComposer): ProactiveRunner {
  return new Scheduler(inbound.turns, composer, host.config, host.log, {
    workspace: host.config.workspacePath ?? undefined,
    onExtract: extractVia(host),
  })
}

/** 事件书路径：数据驱动的执行器 + 内建 job 注册（卸载时反注册）。 */
function buildExecutor(host: SubHost, inbound: InboundParts, composer: PromptComposer): ProactiveRunner {
  const book = checkedBook(host)
  const executor = new ProactiveExecutor({
    turns: inbound.turns,
    registry: inbound.registry,
    prompts: composer,
    config: () => host.config,
    book: () => book,
    log: host.log,
    dshHome: host.dshHome,
    clock: systemClock,
  })
  const unregister = registerJob('knowledge.extract', knowledgeExtractJob({
    workspace: () => host.config.workspacePath,
    extract: extractVia(host),
    // v2 开着时这一步改由 e3 的 `memory.diary-extract` 做（它写新库 + 双写老库）。
    memoryV2On: () => host.config.memory.v2,
  }))
  return {
    start: () => executor.start(),
    dispose: () => {
      unregister()
      executor.dispose()
    },
  }
}

/** 知识抽取出口：memory 子插件未就绪/未配置时返回 0（与旧 `onExtract` 闭包一致）。 */
function extractVia(host: SubHost): (source: string, text: string) => Promise<number> {
  return async (source: string, text: string) => {
    const knowledge = host.get('knowledge')
    return knowledge === undefined ? 0 : await knowledge.extract(source, text)
  }
}

/** 校验配置里的书；**不合法就安全停用**（空书 + 具名日志），绝不退回会外发的默认书。
 *
 * 为什么不退回 `defaultEventBook()`（2026-10-28 修）：那本默认书里
 * `patrol` / `morning-report` / `dream` / `evolve` / `dm-visit` 全是 `enabled: true`，
 * 退回它等于"因为配置写错了，所以替用户打开巡逻与私聊拜访"——错误的配置换来的是
 * **更多**外发行为，方向正好反了。空书是唯一安全的失败姿态：什么都不跑，
 * 日志里把问题一次列全，等人在后台改好再看。
 *
 * 空的 `events` 数组本身就是合法书（`parseEventBook` 接受），所以这里不需要额外的
 * "禁用"标志位：空书 = 零事件 = 零动作。
 */
function checkedBook(host: SubHost): EventBook {
  const parsed = parseEventBook(host.config.proactive.book)
  if (parsed.ok) return parsed.book
  host.log(
    `proactive: 事件书不合法（${parsed.problems.length} 处），已按**空事件书停用**（不会退回默认书，也不会外发任何消息）：`
    + parsed.problems.slice(0, 5).join('；'),
  )
  return { version: 1, events: [] }
}
