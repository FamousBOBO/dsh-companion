/** 跨通道判断服务：**发布出去的那一份**必须自带状态渲染，且两边逐字可比。
 *
 * 为什么单独一个测试文件：这段代码的错都表现为"VoceChat 那边判断得很怪"，
 * 而排查时会一路怀疑到模型——实际错在这里（抬头写成 `QQ 4`、正文被剥前缀、
 * 缺端口却报 ready）。每条断言挡一个静默错。
 *
 * 取服务的方式与 VoceChat 那边一致：**从进程注册表按发布键取**，而不是用返回值——
 * `publishServiceToPeers` 返回的是释放函数，不是服务本身。
 */

import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { test } from 'node:test'

import { JUDGE_SERVICE, publishJudgeToPeers } from '../src/features/inbound/presence-wiring-judge-publish.js'
import type { JudgePort } from '../src/app/inbound/judge-port.js'

const DSH_HOME = 'D:\\DSH\\dsh-production\\data\\home'
/** 发布键里的 root（= `dshHome` 的父目录；发布方用的是 `realpath` 之后的 dirname）。 */
const ROOT = dirname(DSH_HOME)

/** 一个假 `SubHost`（只带这段代码用到的面）。 */
function host() {
  return {
    config: { presence: { replyMaxChars: 70, replyWindowMs: 600_000 } },
    dshHome: DSH_HOME,
    log: () => {},
  }
}

/** 一条旁听。 */
function line(id: number, userId: number, text: string, self = false) {
  return { messageId: id, name: '', userId, text, self, atMs: 1_792_000_000_000 }
}

/** 记录调用的假端口。 */
function spyPort() {
  const seen: Array<{ state: string }> = []
  const port: JudgePort = {
    async decide(request) {
      seen.push({ state: request.state })
      return { kind: 'decision', action: 'silent', reason: 'test' }
    },
  }
  return { port, seen }
}

/** 从进程注册表取刚发布的那一份（与 VoceChat 的 `judge-link.mjs` 同一条取法）。 */
function serviceNow(): {
  decide?: (input: unknown) => Promise<{ kind: string }>
  info?: () => unknown
  ready?: () => boolean
} | null {
  // `process[Symbol.for(...)]` 在 TS 里是唯一符号索引，类型上要显式放宽：
  // 生产者与消费者用的都是这同一枚 symbol，类型系统只认 `Process` 的声明。
  const holder = process as unknown as Record<symbol, unknown>
  const table = holder[Symbol.for('dsh.companion.ports.v1')]
  if (!(table instanceof Map)) return null
  const entry = (table as Map<string, { service?: unknown }>).get(`${JUDGE_SERVICE}\u0000${ROOT}`)
    ?? (table as Map<string, { service?: unknown }>).get(ROOT)
  return (entry?.service ?? null) as {
    decide?: (input: unknown) => Promise<{ kind: string }>
    info?: () => unknown
    ready?: () => boolean
  } | null
}

/** 发布一次，返回"调用一次 decide"的小工具。 */
function publish(port: JudgePort | undefined, backend: string, model = 'jev-1.13') {
  publishJudgeToPeers(host() as never, { port, backend: () => backend, model: () => model })
  return async (input: Record<string, unknown>) => {
    const service = serviceNow()
    if (typeof service?.decide !== 'function') throw new Error('判断服务没发布')
    return await service.decide(input)
  }
}

test('发布名与研究过的消费者一致（改名会让 VoceChat 永远等不到端口）', () => {
  assert.equal(JUDGE_SERVICE, 'companionJudge')
})

test('状态渲染：VoceChat 用 uid 抬头，QQ 用 QQ 抬头（同一份实现，只换标签）', async () => {
  const { port, seen } = spyPort()
  const call = publish(port, 'jev-opencode')
  const shared = {
    room: 'vc-chan-1',
    lines: [line(237, 1, '生产入站验证 10:06:39')],
    nowMs: 1_792_000_000_000,
    nowLabel: '2026-11-20 20:45',
    selfId: 4,
  }
  await call({ ...shared, origin: 'vc' })
  await call({ ...shared, origin: 'qq' })
  assert.match(seen[0]?.state ?? '', /uid 1/, 'VoceChat 的发送者是 uid，不是 QQ 号')
  assert.match(seen[1]?.state ?? '', /QQ 1/)
  // 其余部分逐字节一致：换的只有标签，行文与结尾那一句都不许漂。
  const vc = (seen[0]?.state ?? '').replace('uid 1', 'X')
  const qq = (seen[1]?.state ?? '').replace('QQ 1', 'X')
  assert.equal(vc, qq)
})

test('正文不经过 QQ 前缀剥离（VoceChat 正文本来就没有前缀）', async () => {
  const { port, seen } = spyPort()
  const call = publish(port, 'jev-opencode')
  // 一行长得像 QQ 前缀的正文：按 `stripSenderPrefix` 的规则会被剥掉前半截。
  await call({
    origin: 'vc', room: 'vc-chan-1',
    lines: [line(1, 1, '2026-11-08 21:03 小王(10001)：正文')],
    nowMs: 1_792_000_000_000, nowLabel: '2026-11-20 20:45', selfId: 4,
  })
  assert.match(seen[0]?.state ?? '', /2026-11-08 21:03 小王\(10001\)：正文/, '别人说的话一个字都不许被吃掉')
})

test('没有端口或后端是 host → ready() 为 false、info() 为 null', () => {
  publish(undefined, 'host', '')
  assert.equal(serviceNow()?.ready?.(), false, '不许让对端以为能判')
  assert.equal(serviceNow()?.info?.(), null)
})

test('有端口且后端不是 host → ready() 为 true，info 报后端与模型', () => {
  publish(spyPort().port, 'jev-opencode', 'jev-1.13')
  assert.equal(serviceNow()?.ready?.(), true)
  assert.deepEqual(serviceNow()?.info?.(), { backend: 'jev-opencode', model: 'jev-1.13' })
})

test('端口缺席时 decide 返回 no-route（不是抛、也不是假装 silent）', async () => {
  const call = publish(undefined, 'jev-opencode')
  const verdict = await call({
    origin: 'vc', room: 'vc-chan-1', lines: [line(1, 1, '在吗')],
    nowMs: 1_792_000_000_000, nowLabel: '2026-11-20 20:45', selfId: 4,
  })
  assert.equal(verdict.kind, 'no-route')
})

test('发布是覆盖式的（同一进程里换后端不会留下旧服务）', () => {
  publish(spyPort().port, 'jev-local', 'model.gguf')
  assert.deepEqual(serviceNow()?.info?.(), { backend: 'jev-local', model: 'model.gguf' })
  publish(undefined, 'host', '')
  assert.equal(serviceNow()?.ready?.(), false)
})
