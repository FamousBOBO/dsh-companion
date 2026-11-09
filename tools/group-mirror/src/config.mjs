/**
 * 镜像进程的配置加载与校验（fail-closed）。
 *
 * 为什么单独一个文件：配置错误是这个项目里**最可能悄悄削弱隔离**的地方——
 * 白名单写成空数组却在注释里说"全都转"、假 WS 监听 0.0.0.0、把真实连接的令牌
 * 填进测试侧。这些都不是"能跑就行"的问题，所以校验放在最前面：任何一条不满足
 * 就拒绝启动，而不是带着可疑配置继续跑。
 *
 * 不变量（缺一条就拒绝启动）：
 *   1. 白名单必须显式给出，空数组 = **不转发任何群**（不是"全部"）；
 *   2. 群号必须是安全正整数，重复不允许；
 *   3. 假 OneBot WS 只能监听回环地址；
 *   4. 两个令牌都必须有值，且**不能相同**——测试侧不许持有真实连接令牌；
 *   5. 源地址必须是 http/https 的 SSE 端点，不能是 OneBot 的 ws:// 地址。
 */

/** 回环地址白名单：假 WS 只允许监听这几种写法。 */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

/** 镜像进程的默认值（保守到"什么都不做"）。 */
export const DEFAULT_MIRROR_CONFIG = Object.freeze({
  enabled: false,
  sourceUrl: '',
  sourceTokenEnv: 'NAPCAT_MIRROR_EVENT_TOKEN',
  allowedGroups: Object.freeze([]),
  fakeOneBotHost: '127.0.0.1',
  fakeOneBotPort: 3101,
  fakeOneBotTokenEnv: 'DSH_MIRROR_FAKE_ONEBOT_TOKEN',
  maxQueueEntries: 200,
  maxEventBytes: 64 * 1024,
  dedupeTtlMs: 10 * 60 * 1000,
  dedupeMaxEntries: 2000,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 60 * 1000,
  collectBody: false,
})

/** 一条校验失败。字段 `reason` 供日志与测试断言（不用错误文案做断言）。 */
export class MirrorConfigError extends Error {
  constructor(reason, message) {
    super(message)
    this.name = 'MirrorConfigError'
    this.reason = reason
  }
}

function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}

/**
 * 校验并归一化镜像配置。
 *
 * @param {object} raw  用户给的原始对象（套件配置里的 `mirror` 段）。
 * @param {object} env  环境变量来源（默认 process.env）。
 * @returns 归一化后的配置；可疑值直接抛错，不静默修正。
 */
export function normalizeMirrorConfig(raw = {}, env = process.env) {
  const merged = { ...DEFAULT_MIRROR_CONFIG, ...(raw ?? {}) }

  const groups = []
  const rawGroups = Array.isArray(merged.allowedGroups) ? merged.allowedGroups : []
  for (const value of rawGroups) {
    const n = Number(value)
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new MirrorConfigError('bad-group', 'allowedGroups 里有非正整数群号：' + JSON.stringify(value))
    }
    if (groups.includes(n)) throw new MirrorConfigError('duplicate-group', 'allowedGroups 里重复出现群号 ' + n)
    groups.push(n)
  }

  const host = String(merged.fakeOneBotHost ?? '')
  if (!LOOPBACK.has(host)) {
    throw new MirrorConfigError('bad-host', 'fakeOneBotHost 必须是回环地址（' + [...LOOPBACK].join(' / ') + '），收到 ' + JSON.stringify(host))
  }

  const port = Number(merged.fakeOneBotPort)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new MirrorConfigError('bad-port', 'fakeOneBotPort 不是合法端口：' + JSON.stringify(merged.fakeOneBotPort))
  }

  const sourceUrl = String(merged.sourceUrl ?? '').trim()
  if (merged.enabled !== false && sourceUrl === '') {
    throw new MirrorConfigError('missing-source', 'enabled 为真时必须给 sourceUrl（NapCat 的 SSE 地址）')
  }
  if (sourceUrl !== '') {
    let parsed
    try {
      parsed = new URL(sourceUrl)
    } catch {
      throw new MirrorConfigError('bad-source', 'sourceUrl 不是合法 URL：' + JSON.stringify(sourceUrl))
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      // ws:// 说明填的是 OneBot 的 WS 端点：那是双向的、能发 API 的端口，绝不能用。
      throw new MirrorConfigError('bad-source', 'sourceUrl 必须是 http/https 的 SSE 地址，收到协议 ' + parsed.protocol)
    }
  }

  const sourceTokenEnv = String(merged.sourceTokenEnv ?? '').trim()
  const fakeTokenEnv = String(merged.fakeOneBotTokenEnv ?? '').trim()
  const sourceToken = sourceTokenEnv ? String(env?.[sourceTokenEnv] ?? '') : ''
  const fakeToken = fakeTokenEnv ? String(env?.[fakeTokenEnv] ?? '') : ''

  if (merged.enabled !== false && sourceToken === '') {
    throw new MirrorConfigError('missing-source-token', 'enabled 为真时环境变量 ' + sourceTokenEnv + ' 必须有值')
  }
  if (fakeToken === '') {
    throw new MirrorConfigError('missing-fake-token', '环境变量 ' + fakeTokenEnv + ' 必须有值（假 WS 的握手 Token，不能留空）')
  }
  // 最危险的一种配置错误：把真实连接令牌填到测试侧的假 WS 上。
  if (sourceToken !== '' && fakeToken === sourceToken) {
    throw new MirrorConfigError('shared-token', '假 WS 的 Token 不能与 NapCat 事件 Token 相同——测试侧不许持有真实连接令牌')
  }

  return {
    enabled: merged.enabled !== false,
    sourceUrl,
    sourceTokenEnv,
    allowedGroups: Object.freeze(groups),
    fakeOneBotHost: host,
    fakeOneBotPort: port,
    fakeOneBotTokenEnv: fakeTokenEnv,
    maxQueueEntries: positiveInt(merged.maxQueueEntries, DEFAULT_MIRROR_CONFIG.maxQueueEntries),
    maxEventBytes: positiveInt(merged.maxEventBytes, DEFAULT_MIRROR_CONFIG.maxEventBytes),
    dedupeTtlMs: positiveInt(merged.dedupeTtlMs, DEFAULT_MIRROR_CONFIG.dedupeTtlMs),
    dedupeMaxEntries: positiveInt(merged.dedupeMaxEntries, DEFAULT_MIRROR_CONFIG.dedupeMaxEntries),
    reconnectBaseMs: positiveInt(merged.reconnectBaseMs, DEFAULT_MIRROR_CONFIG.reconnectBaseMs),
    reconnectMaxMs: positiveInt(merged.reconnectMaxMs, DEFAULT_MIRROR_CONFIG.reconnectMaxMs),
    collectBody: merged.collectBody === true,
    // 令牌只以独立对象带出：它不会被 JSON.stringify 进日志，也不会出现在配置回显里。
    secrets: Object.freeze({ sourceToken, fakeToken }),
  }
}
