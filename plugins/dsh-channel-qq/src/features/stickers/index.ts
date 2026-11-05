/** 表情包子插件（P5.1）：偷取存储 + 索引库 + 后台资源。
 *
 * 两个对象的分工见各自模块注释：`EmojiStore` 负责把主群里的图存下来，
 * `EmojiLibrary` 负责去重索引、视觉打标与语义检索。`emoji.dir` /
 * `emoji.registeredDir` 变了就地重读（P5.2，对齐旧 `applyEffects` 的两条分支）。
 */

import { EmojiLibrary } from '../../emoji-library.js'
import { EmojiStore } from '../../emoji.js'
import type { SubPlugin } from '../plugin-kit.js'

export const stickersPlugin: SubPlugin = {
  name: 'stickers',
  watches: ['emoji.dir', 'emoji.registeredDir'],
  requires: ['platform'],
  async apply(host) {
    const { api } = host.need('platform')
    const library = new EmojiLibrary(host.config.emoji, host.log)
    await library.load()
    const store = new EmojiStore(host.config.emoji, api, host.log, library)
    await store.init()
    host.provide('emoji', { library, store })
    let retagging = false
    host.registerResource('emoji', {
      label: '表情包库',
      list: () => {
        const entries = library.list(500)
        return { count: library.list(100000).length, entries }
      },
      remove: async (id) => ({ removed: await library.remove(id) }),
      actions: {
        rescan: async () => await library.rescan(),
        // 全库重新打标：视觉消息的形状修好后，旧标签要靠这一轮覆盖（见 retagAll）。
        // 一次几十到几百张图，逐张调模型，后台跑、进度写日志。
        retag: async () => {
          if (retagging) return { started: false, note: '已经在重新打标了' }
          const total = library.list(100000).length
          if (total === 0) return { started: false, note: '表情库还是空的' }
          retagging = true
          void library.retagAll(host.bridge.tagContext(), (done, all) => {
            if (done % 10 === 0 || done === all) host.log(`emoji retag 进度：${done}/${all}`)
          }).catch((error: unknown) => {
            host.log(`emoji retag 失败：${error instanceof Error ? error.message : String(error)}`)
          }).finally(() => { retagging = false })
          return { started: true, total, note: `已在后台重新打标 ${total} 张，进度看日志` }
        },
      },
    })
    return () => { void library.save() }
  },
  async reload(host) {
    const parts = host.get('emoji')
    if (parts === undefined) return []
    // 旧 applyEffects 的两条说明行按原顺序返回：索引重读 + 偷取目录切换。
    const notes = [await parts.library.reload()]
    await parts.store.init().catch(() => {})
    notes.push('偷取/注册目录已切换（表情索引已重读）')
    return notes
  },
}
