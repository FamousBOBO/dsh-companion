/** 起草上下文的**装配胶水**：把宿主那几样东西（服务袋、人格注册表、账本、房间事实）
 *  收成一个 `DraftContextDeps`，再包成 contact 需要的三个入口。
 *
 * 为什么单独一个文件、而不是写在 `index.ts` 里：`index.ts` 已经贴着 400 行硬上限
 * （`scripts/check-size.mjs`），而"往哪里取"这几个 getter 有十几行纯装配代码。
 * 拆出来之后 `index.ts` 里只剩三行表达式，六个分区怎么读、怎么裁、怎么复核全在
 * `draft-context.ts` / `draft-readers.ts` / `draft-sections.ts` / `draft-freshness.ts`。
 *
 * 三个入口的分工（都是给 `contact` 自己的，不对外）：
 *   - `source`：起草前组装上下文（`attempt.ts` 在门控放行后调）；
 *   - `verify`：发送前**异步**复核（`sender.recheckAtSend`，`finalSyncGuard` 之前）；
 *   - `requireRevision`：`direct` 模式必须带冻结版本（缺失 = 拒绝），`turn` 模式为 false。
 */

import type { Clock } from '../../ports/clock.js'
import type { ServiceBag, SubHost } from '../plugin-kit.js'
import { createDraftContextSource, type DraftContextDeps } from './draft-context.js'
import { createRevisionVerifier } from './draft-freshness.js'
import type { ContactGuardVerdict, ContactSendRequest } from './sender.js'
import type { ContactStore } from './store.js'
import type { ContactRoomFacts } from './transitions.js'

/** contact 需要的三个入口（见文件头）。 */
export interface HostDrafts {
  readonly source: ReturnType<typeof createDraftContextSource>
  readonly verify: (req: ContactSendRequest) => Promise<ContactGuardVerdict | null>
  readonly requireRevision: () => boolean
}

/** 组装取数面（惰性 getter，不缓存服务引用：卸载后不该继续用旧对象）。 */
export function draftDepsOf(
  host: SubHost,
  store: ContactStore,
  roomFacts: (room: string) => ContactRoomFacts,
  clock: Clock,
  log: (line: string) => void,
): DraftContextDeps {
  return {
    // 服务袋是 `keyof ServiceBag` 的泛型 getter；这里窄成 `string → unknown`，
    // 于是 `draft-context` 不需要知道 `ServiceBag` 长什么样（也不必 import 宿主包）。
    get: (name: string): unknown => host.get(name as keyof ServiceBag),
    preset: () => host.bridge.presetRegistry(),
    config: () => host.config.contact,
    deliveries: () => store.listDeliveries(),
    counters: () => store.state.counters,
    roomFacts,
    clock,
    log,
  }
}

/** 一次装好三个入口（`index.ts` 只调这一个函数）。 */
export function createHostDrafts(
  host: SubHost,
  store: ContactStore,
  roomFacts: (room: string) => ContactRoomFacts,
  clock: Clock,
  log: (line: string) => void,
): HostDrafts {
  const deps = draftDepsOf(host, store, roomFacts, clock, log)
  return {
    source: createDraftContextSource(deps),
    verify: createRevisionVerifier(deps),
    // `direct` 的文案只能来自模型起草，所以"没有冻结版本"一定意味着装配漏接 ⇒ 拒绝。
    // `turn` 模式没有起草上下文，按老口径（两个时间戳）判，见 `precheck.freshnessIssue`。
    requireRevision: () => host.config.contact.sendMode === 'direct',
  }
}
