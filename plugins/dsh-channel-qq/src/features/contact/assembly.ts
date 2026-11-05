/** contact 的装配零件：store 的位置与身份（从 `index.ts` 搬出来，那个文件贴着 400 行硬上限）。
 *
 * 只放"怎么造"，不放"什么时候造"——生命周期仍归 `contactPlugin.apply()`，
 * 这样搬动不改变任何行为（纯搬家）。
 */

import { hostname } from 'node:os'
import * as path from 'node:path'
import type { Clock } from '../../ports/clock.js'
import type { SubHost } from '../plugin-kit.js'
import { dayKeyFor } from './followup.js'
import type { ContactSender, ContactIdentity } from './sender.js'
import { ContactStore } from './store.js'

/** 发送身份（persona/世界）：门控与候选都用它，不要各算一份。 */
export function identityOf(host: SubHost): ContactIdentity {
  return { personaId: host.config.agentPreset, worldId: '' }
}

/** 账本落在 `<dshHome>/channel-qq/contact.json`，锁文件在旁边（与旧路径一致）。 */
export function buildStore(host: SubHost, clock: Clock, log: (line: string) => void): ContactStore {
  const base = path.join(host.dshHome, 'channel-qq')
  return new ContactStore({
    file: path.join(base, 'contact.json'),
    lockFile: path.join(base, 'contact.lock'),
    hostId: hostname(),
    pid: process.pid,
    log,
    clock,
    dayKey: (now) => dayKeyFor(host.config.contact.timezone, now),
  })
}

/** 供 `index.ts` 复用的类型别名（避免两边各写一遍 `ContactSender` 的导入路径）。 */
export type { ContactSender }
