/** 平台子插件（P5.1）：OneBot 传输 + 端口包装 + 出站队列。
 *
 * 连接对象（`OneBotClient`）与业务看到的 `ChatPlatform` 在这里分开：
 * `client` 只留给本插件与 inbound 的事件订阅；其余功能一律拿 `api`/`out`。
 *
 * 热重载（P5.2，对齐旧 `applyEffects`）：`connection`/`accessToken` 变了就
 * **就地重连**——重建 client 会把所有已持引用（OutboundQueue、全部工具）搁浅，
 * 所以只换 socket（见 `OneBotClient.reconnect` 的注释）。
 */

import { OneBotClient } from '../../onebot.js'
import { platformOf } from '../../adapters/onebot/platform.js'
import { OutboundQueue } from '../../outbound.js'
import { createHealthProbe } from './probe.js'
import { systemClock } from '../../ports/clock.js'
import type { SubPlugin } from '../plugin-kit.js'

/** 模块级最新 platform.api 引用（platform 装配时更新；未连接时 null）。 */
export const platformApiRef: { api: import('../../ports/platform.js').QQApi | null } = { api: null }

export const platformPlugin: SubPlugin = {
  name: 'platform',
  watches: ['connection', 'accessToken'],
  apply(host) {
    const { config } = host
    const client = new OneBotClient(config.connection, config.accessToken, host.log)
    const platform = platformOf(client)
    // 指标插件晚于本插件挂载，计数用惰性取值。
    const out = new OutboundQueue(platform.api, config, host.log, {
      sent: () => host.get('metrics')?.sendOk(),
      failed: () => host.get('metrics')?.sendFailed(),
    })
    client.on('connect', () => {
      host.log('QQ link ready')
    })
    // 模块级最新 api 引用（重连时更新）：给不经过子插件装配的组件用
    // （如 plugin.ts 的出站 URL 安检 checker）。
    platformApiRef.api = platform.api
    host.provide('platform', { client, platform, api: platform.api, out })
    // 发送侧探针：复用同一个 api 与连接状态，不产生任何消息。
    host.provide('health', createHealthProbe({
      api: platform.api,
      connected: () => client.isConnected(),
      lastActivityAt: () => client.lastActivityAt(),
      selfId: () => client.selfId ?? (Number.isFinite(config.selfId) ? config.selfId : null),
      now: () => systemClock.now(),
    }))
    return () => { client.stop() }
  },
  // 与原实现一致：client.start() 在全部装配完成之后、scheduler/admin 之前。
  start(host) {
    host.need('platform').client.start()
  },
  reload(host) {
    const parts = host.get('platform')
    if (parts === undefined) return ['连接设置已保存，但 QQ 客户端尚未建立，下次启动生效']
    parts.client.reconnect(host.config.connection, host.config.accessToken)
    return [`已重连 OneBot（mode=${host.config.connection.mode} url=${host.config.connection.url}）`]
  },
}
