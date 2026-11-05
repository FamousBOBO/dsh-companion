/** 语录子插件（P5.1）：语录存储 + 工具面 + 后台资源。
 *
 * 存储对象在注册工具之前加载完成（"半初始化的 store 绝不能被模型够到"），
 * 卸载时工具先注销、再落盘。热重载行为与旧 `applyEffects` 一致：`quotes.*`
 * 不在热路径清单里，store 全程读活动配置，无需动作（watches 为空）。
 */

import { QuoteStore } from './store.js'
import { registerQuoteTools } from './tools.js'
import { storeOptions } from '../plugin-kit.js'
import type { SubPlugin } from '../plugin-kit.js'

export const quotesPlugin: SubPlugin = {
  name: 'quotes',
  watches: [],
  requires: ['platform'],
  async apply(host) {
    const store = new QuoteStore(host.config.quotes, storeOptions(host))
    await store.load()
    host.provide('quotes', store)
    host.registerResource('quotes', {
      label: '群语录',
      list: () => ({ count: store.stats().total, quotes: store.list(300), stats: store.stats() }),
      create: async (body) => await store.add({
        text: String(body.text ?? ''),
        speaker: String(body.speaker ?? '匿名'),
        speakerId: Number(body.speakerId ?? host.config.admins[0] ?? 0),
        groupId: Number(body.groupId ?? host.config.primaryGroup ?? 0),
        tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t)) : [],
        note: body.note === undefined ? undefined : String(body.note),
      }),
      remove: async (id) => ({ removed: await store.remove(id) }),
    })
    const { api, out } = host.need('platform')
    const disposeTools = registerQuoteTools(host.bridge.toolHost(), host.config, api, out, host.log, store)
    return async () => {
      disposeTools()
      await store.save().catch(() => {})
    }
  },
}
