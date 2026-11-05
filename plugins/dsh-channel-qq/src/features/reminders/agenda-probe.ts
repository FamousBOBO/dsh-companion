/**
 * **agenda 探测的纯逻辑**（round8）：能力校验 + 候选解析。
 *
 * 为什么单独一个文件：`agenda-seam.ts` 已经顶到 400 行硬上限（`scripts/check-size.mjs`），
 * 而这两件事是**纯函数**（不碰全局状态），搬出来既能压行数，也方便测试直接调
 * **与生产同一条代码路径**（round8 的要求：不许用测试里另写的假 resolver 冒充"真实装配"）。
 */

import type { AgendaPort, AgendaProbe } from './agenda-seam.js'

/** 三个能力缺一不可（`task-60` P1）：少一个就不是"能用的端口"，而是旧/残缺对象。 */
const REQUIRED_METHODS = ['casOccurrence', 'markOccurrenceDispatched', 'nextOccurrence'] as const

/**
 * **这个对象到底能不能当 agenda 端口用**。
 *
 * 以前 `resolveAgendaPort()` 拿到**第一个 object** 就用——旧版本的对象、
 * 或不是 agenda 的服务（名字撞了）都会**遮住**后面真正正确的端口，而且失败表现是
 * "莫名其妙 not-found"，很难查。这里按**能力**判：三个方法都得是函数。
 */
export function agendaPortCapability(value: unknown): { ok: boolean; missing: string[] } {
  if (value === null || typeof value !== 'object') return { ok: false, missing: [...REQUIRED_METHODS] }
  const missing = REQUIRED_METHODS.filter((key) => {
    const method = (value as Record<string, unknown>)[key]
    return typeof method !== 'function'
  })
  return { ok: missing.length === 0, missing }
}

/** 候选服务名（顺序是承重的：首选错了就永远取不到）。 */
export const AGENDA_SERVICE_CANDIDATES = ['companionAgenda', 'companion:agenda', 'agenda', 'companion-agenda'] as const

/**
 * **真实装配的候选解析**：`plugin.ts::probeAgendaPort()` 就是调这个。
 *
 * 规矩：
 *   - 逐个候选用 `ctx.get(name)` 取（**可选查询**：宿主没装时返回 undefined，不像属性访问会抛）；
 *   - 拿到对象后**校验能力**，不合格记一行日志继续找下一个；
 *   - 全都没有对象 ⇒ `absent`；有对象但都不合格 ⇒ `incompatible`；`ctx.get` 抛过 ⇒ `failed`
 *     （后两者**不许 CAS 放行**）。
 */
export function probeAgendaCandidates(
  get: (name: string) => unknown,
  log: (line: string) => void,
  candidates: readonly string[] = AGENDA_SERVICE_CANDIDATES,
): AgendaProbe {
  let sawObject = false
  let sawError = false
  for (const name of candidates) {
    let service: unknown
    try {
      service = get(name)
    } catch (error) {
      sawError = true
      log(`reminders: 取 agenda 服务 ${name} 抛错：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (service === null || typeof service !== 'object') continue
    sawObject = true
    const capability = agendaPortCapability(service)
    if (!capability.ok) {
      log(`reminders: agenda 候选 ${name} 不可用（缺 ${capability.missing.join('/')}）→ 继续找下一个`)
      continue
    }
    log(`reminders: agenda 服务命中 ${name}（探测顺序 ${candidates.join(' → ')}）`)
    return { port: service as AgendaPort, state: 'ok' }
  }
  if (sawError) return { port: null, state: 'failed' }
  if (sawObject) return { port: null, state: 'incompatible' }
  return { port: null, state: 'absent' }
}
