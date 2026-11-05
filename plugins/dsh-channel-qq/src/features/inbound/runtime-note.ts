/** 每包开头的运行环境事实：现取 + 缓存（一分钟刷新一次）。
 *
 * 缓存是因为 `runtimeFacts` 是异步的，而组包里的注入路径是同步的；
 * 一分钟的延迟对"换了模型/网关"这种低频变化完全够用。
 */

import { runtimeNoteOf } from '../../core/runtime-note.js'
import type { SubHost } from '../plugin-kit.js'

export interface RuntimeNoteRefresher {
  /** 当前的一段文字；拿不到事实时为空串（包保持原样）。 */
  note(): string
  dispose(): void
}

export function createRuntimeNoteRefresher(host: SubHost): RuntimeNoteRefresher {
  let text = ''
  let reported = false
  const refresh = async (): Promise<void> => {
    let facts = null
    try {
      facts = await host.bridge.runtimeFacts?.() ?? null
    } catch {
      facts = null
    }
    text = facts === null ? '' : runtimeNoteOf(facts)
    if (!reported) {
      reported = true
      host.log(facts === null
        ? 'runtime-note: 拿不到运行环境事实（模型能力这条暂不注入）'
        : `runtime-note: ${facts.provider}/${facts.model} vision=${String(facts.vision)} window=${String(facts.contextWindow)}`)
    }
  }
  void refresh()
  const timer = setInterval(() => { void refresh() }, 60_000)
  timer.unref?.()
  return {
    note: () => text,
    dispose: () => clearInterval(timer),
  }
}
