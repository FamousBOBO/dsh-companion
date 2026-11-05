/** 好感度子插件（P5.1）：状态存储 + 学弟专属悬浮窗（本机端口）。
 *
 * `affectionPort` 变了就地重绑（P5.2，对齐旧 `applyEffects` 的 `relisten`）；
 * 悬浮窗的任务注入走 inbound 的 `turns.adminPrompt`——用取值函数取，因为
 * 面板可能在回合运行时才被点（旧实现同样是"turns 不在就什么也不做"）。
 */

import { AffectionStore } from '../../affection.js'
import type { SubPlugin } from '../plugin-kit.js'

export const affectionPlugin: SubPlugin = {
  name: 'affection',
  watches: ['affectionPort'],
  async apply(host) {
    const affection = new AffectionStore(host.dshHome, host.log)
    await affection.load()
    await affection.serve(host.config.affectionPort, {
      workspacePath: host.config.workspacePath,
      onSubmit: (prompt: string) => {
        const inbound = host.get('inbound')
        if (inbound === undefined) return
        void inbound.turns.adminPrompt(prompt).catch((e: Error) => host.log(`admin prompt failed: ${e.message}`))
      },
    })
    host.provide('affection', affection)
    host.registerResource('affection', {
      label: '好感度与阶段',
      list: () => ({
        score: affection.read().score,
        stage: affection.read().stage,
        events: affection.read().events.slice(-30).reverse(),
        stageHistory: affection.read().stageHistory.slice(-10).reverse(),
      }),
    })
  },
  async reload(host) {
    const affection = host.get('affection')
    if (affection === undefined) return []
    return [await affection.relisten(host.config.affectionPort)]
  },
}
