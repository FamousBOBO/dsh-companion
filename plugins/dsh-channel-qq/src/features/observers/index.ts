/** 入站旁路观察子插件（P5.1）：风控 / 口癖 / 链接卡片 / 偷表情包的装配。
 *
 * 逻辑本体在 `./inbound.js`（P3 从 root 的 `onEvent` 里搬出来的）；这里只把
 * 依赖接上。除宿主上下文外全部是**取值函数**——这些对象在不同的子插件里先后
 * 出现，观察者必须在事件到来时按需取，而不是在构造期抓引用（抓了就会永远
 * 看着旧实例，热重载后尤其明显）。
 */

import { InboundObservers } from './inbound.js'
import { systemHttp } from '../../adapters/http/client.js'
import type { SubPlugin } from '../plugin-kit.js'
import { expressionBridgePort, type ExpressionBridgePort } from '../expression-bridge.js'

export const observersPlugin: SubPlugin = {
  name: 'observers',
  watches: [],
  apply(host) {
    // 表情包入站旁路（可选）：端口在进程级注册表里（`companion-expression` 发布）。
    // 首次取到就缓存同一个对象（热路径上不再分配）；还没发布时每次现取——那个模块
    // 常常比本段晚挂，只在挂载时探一次会永远接不上。
    let expression: ExpressionBridgePort | null = expressionBridgePort(host.log)
    const live = (): ExpressionBridgePort | null => (expression ??= expressionBridgePort(host.log))
    if (expression !== null) host.provide('expressionBridge', expression)
    const observers = new InboundObservers({
      config: () => host.config,
      log: host.log,
      platform: () => host.get('platform')?.platform ?? null,
      out: () => host.get('platform')?.out ?? null,
      flood: () => host.get('flood') ?? null,
      learn: () => host.get('learn') ?? null,
      emoji: () => host.get('emoji')?.store ?? null,
      library: () => host.get('emoji')?.library ?? null,
      expression: () => host.get('expressionBridge') ?? live(),
      http: systemHttp,
      tagContext: () => host.bridge.tagContext(),
    })
    host.provide('observers', observers)
  },
}
