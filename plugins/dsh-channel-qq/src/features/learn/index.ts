/** 口癖学习子插件（P5.1）：存储 + 定期落盘 runner + 工具面 + 后台资源。
 *
 * 卸载时先停 runner、再把内存候选 flush 落盘——"重启不能丢刚学到的口癖"
 * （原 root disposer 的注释即此意）。
 */

import { LearnStore } from './store.js'
import { LearnRunner } from './runner.js'
import { registerLearnTools } from './tools.js'
import { storeOptions } from '../plugin-kit.js'
import type { SubPlugin } from '../plugin-kit.js'

export const learnPlugin: SubPlugin = {
  name: 'learn',
  // learn.slang 决定额外的两个工具是否注册；其余开关由 store 现取，但重挂一次也安全。
  watches: ['learn'],
  requires: ['platform'],
  async apply(host) {
    const store = new LearnStore(host.config.learn, storeOptions(host))
    await store.load()
    host.provide('learn', store)
    host.registerResource('learned', {
      label: '学到的口癖',
      list: () => ({ count: store.stats().tracked, phrases: store.top(200), slang: store.slang(200) }),
      create: async (body) => await store.remember(
        String(body.text ?? ''),
        Number(body.groupId ?? host.config.primaryGroup ?? 0),
        '后台手动添加',
      ),
      remove: async (id) => ({ removed: await store.forget(id) }),
    })
    const { api, out } = host.need('platform')
    const runner = new LearnRunner(store, host.log)
    runner.start()
    const disposeTools = registerLearnTools(host.bridge.toolHost(), host.config, api, out, host.log, store)
    return async () => {
      disposeTools()
      runner.dispose()
      await store.flush().catch(() => {})
    }
  },
}
