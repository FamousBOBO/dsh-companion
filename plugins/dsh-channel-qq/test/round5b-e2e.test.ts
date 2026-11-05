import { expectOk, expectRejected } from './fakes/reminders.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { QQChannelConfig } from '../src/config.js'
import { ReminderStore } from '../src/features/reminders/store.js'
import { ReminderRunner } from '../src/features/reminders/runner.js'
import { configureReminderSeams, deliverReminder } from '../src/features/reminders/index.js'
import { configureAgendaPort, configureAgendaResolver, liveSeams } from '../src/features/reminders/agenda-seam.js'
import { baseConfig, tempHome, FakeOutboundQueue, FakePlatform } from './fakes/contact.js'
import type { SubHost } from '../src/features/plugin-kit.js'

// **端到端**：QQ → FD → **真 runtime**（round5 追加，Lead 要求）。
//
// 为什么必须单独一条：上一轮 `publication` 的教训是"两段各自成立、装配起来不成立"。
// 只断言"QQ 的实参里有 sessionId"证明不了对面能解出 scope；这条从 `ReminderRunner` 真实入口出发，
// 经 `liveSeams` → FD `createAgendaPort` → **真 runtime（node:sqlite 内存库）**，
// 断言 runtime **真的解出了 scope 并返回真实 occurrence**，而不是 `not-found` / `agenda-failed`。
//
// 反向对照也在这里：**不带 sessionId 的 CAS 必须被 runtime 拒成 `not-found`** ——
// 这条对照证明"身份是承重的"，不是"随便怎么调都能过"。

const OWNER = 10001
const SESSION = `qq-dm-${String(OWNER)}`
const zone = 'Asia/Shanghai'

const pluginRoot = path.resolve(process.cwd(), '..')
const runtimeEntry = path.join(pluginRoot, 'companion-runtime', 'index.mjs')
const foundationEntry = path.join(pluginRoot, 'companion-foundation', 'agenda-port.mjs')

/** 依赖缺失就**跳过并说明**，绝不伪装成通过。 */
async function loadModules(): Promise<{ mountRuntime?: (ctx: unknown, root: string, options?: unknown) => any, createAgendaPort?: (input: unknown) => any, reason?: string }> {
  if (!fs.existsSync(runtimeEntry) || !fs.existsSync(foundationEntry)) {
    return { reason: `找不到 runtime/foundation 入口（${runtimeEntry} / ${foundationEntry}）` }
  }
  try {
    const runtime = await import(pathToFileURL(runtimeEntry).href) as { mountRuntime?: (ctx: unknown, root: string, options?: unknown) => any }
    const agenda = await import(pathToFileURL(foundationEntry).href) as { createAgendaPort?: (input: unknown) => any }
    if (typeof runtime.mountRuntime !== 'function' || typeof agenda.createAgendaPort !== 'function') {
      return { reason: 'runtime.mountRuntime 或 foundation.createAgendaPort 未导出' }
    }
    return { mountRuntime: runtime.mountRuntime, createAgendaPort: agenda.createAgendaPort }
  } catch (error) {
    return { reason: `导入失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

test('E2E QQ→FD→RT：runtime 真的解出 scope 并接受 CAS/dispatched（未接身份时会被拒成 not-found）', async (t) => {
  const mods = await loadModules()
  if (mods.mountRuntime === undefined || mods.createAgendaPort === undefined) {
    t.skip(`端到端跳过：${mods.reason ?? '依赖不可用'}`)
    return
  }

  const home = tempHome('qq-e2e-')
  const logs: string[] = []
  const root = home.dir
  let closeRuntime: (() => void) | null = null
  try {
    // ① 真 runtime 的根目录（它自己读 `home/companion/runtime.config.json`）。
    for (const rel of ['home/companion', 'logs', 'workspace']) fs.mkdirSync(path.join(root, rel), { recursive: true })
    fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), 'bot\n', 'utf8')
    fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
      enabled: true,
      mode: 'active',
      timeZone: zone,
      agenda: { enabled: true, generationHorizonHours: 72, maxItemsPerScope: 32, querySpanDays: 14 },
    }), 'utf8')

    const now = Date.now()
    // ② 身份：`sessionId` → scope 绑定（生产由宿主提供，形状同 runtime 的 `identity.resolve`）。
    const identity = {
      resolve: (sessionId: string) => ({ userId: 'owner-1', persona: 'bot', sessionId }),
    }
    // **round6 修正**：runtime 默认会打开根目录下的数据库文件；这里显式指定 `:memory:`，
    // 才真的配得上"内存 SQLite"这个说法（之前是临时根里的**文件库**，说反了）。
    const runtime = mods.mountRuntime(null, root, { identity, now: () => now, dbFile: ':memory:' }) as {
      createSchedule?: (input: Record<string, unknown>) => any
      listSchedule?: (input: Record<string, unknown>) => any
      dispose?: () => void
    }
    // 先记下关闭函数：数据库文件得在删目录**之前**释放（Windows 上 SQLite 持有句柄会 EPERM）。
    closeRuntime = () => { try { runtime.dispose?.() } catch { /* 已关 */ } }

    // ③ FD 的 agenda 端口（它会用 `identityOf(input)` 把 sessionId 转给 runtime）。
    const port = mods.createAgendaPort({ cognitive: runtime, timeZone: zone, now: () => now })

    // ④ 先经端口建一条日程（带 sessionId）——顺带证明"这条路径本来就能解 scope"。
    const created = await port.createSchedule({ at: now + 60_000, text: '该吃药了', sessionId: SESSION }) as {
      ok: boolean
      occurrenceId?: string
      revision?: number
      code?: string
    }
    assert.equal(created.ok, true, `建日程要成功（否则这条用例的前置就不成立）：${JSON.stringify(created)}`)
    assert.ok(typeof created.occurrenceId === 'string' && created.occurrenceId !== '', '要拿到真 occurrence id')
    const occurrenceId = created.occurrenceId as string
    const revision = Number(created.revision ?? 0)

    // ⑤ **反向对照**：不带 sessionId 的 CAS 必须被 runtime 拒成 `not-found`。
    const anonymous = await port.casOccurrence({ occurrenceId, revision }) as { ok: boolean, code?: string }

    assert.equal(anonymous.ok, false, '不带身份不该通过')

    // **round6**：光断言 false 不够——必须断言**精确拒绝码**，否则"参数写错"也会让它 false。

    assert.equal(anonymous.code, 'not-found', `不带身份应被 runtime 判 not-found（实际 ${String(anonymous.code)}）`)

    // 反过来：**带身份**时同一个调用必须成功（正反对照都在这一个 occurrence 上）。

    const identified = await port.casOccurrence({ occurrenceId, revision, sessionId: SESSION }) as { ok: boolean, code?: string }

    assert.equal(identified.ok, true, `带身份必须解得开 scope（实际 code=${String(identified.code)}）`)

    // ⑥ 装配 QQ 侧：真 store + 真 runner + 真接缝（`liveSeams` 每次调用才解析端口）。
    configureAgendaPort(port)
    configureAgendaResolver(() => port)
    configureReminderSeams(liveSeams((line) => { logs.push(line) }))

    const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
    const config = {
      ...base,
      groupEnabled: true,
      reminders: { enabled: true, dryRun: false, file: null },
    } as QQChannelConfig
    const runnerLogs = logs
    const store = new ReminderStore(config.reminders, { workspacePath: root, dshHome: root, log: (line) => { logs.push(line) } })
    const platform = new FakePlatform()
    const queue = new FakeOutboundQueue()
    const host = {
      config,
      log: (line: string) => { logs.push(line) },
      get: (name: string) => (name === 'platform' ? { api: platform.api, out: queue } : name === 'reminders' ? store : undefined),
    } as unknown as SubHost
    await store.load()

    // ⑦ **从真实入口**：一条绑定到上面那个真 occurrence 的提醒，跑一拍。
    const reminder = expectOk(await store.add({
      text: '该吃药了',
      at: now - 60_000,
      room: 'dm',
      target: OWNER,
      createdBy: OWNER,
      repeat: 'none',
      occurrence: { id: occurrenceId, revision },
    }))
    const runner = new ReminderRunner(
      store,
      (item) => deliverReminder(host, item),
      (line) => { logs.push(line) },
      () => true,
      async () => null,
      async () => 'ok' as const,
      () => false,
    )
    await (runner as unknown as { tick(): Promise<void> }).tick()

    // ⑧ runtime 侧必须认这笔账：CAS 过了（不是 unknown）、事件写进去了（不是待办）。
    assert.equal(platform.count(), 1, '提醒真的发出去了')
    const after = JSON.parse(fs.readFileSync(path.join(root, 'reminders.json'), 'utf8')) as {
      reminders: Array<{ id: string, pendingDispatch?: unknown, fired?: boolean }>
    }
    const row = after.reminders.find((item) => item.id === reminder.id)
    // **round6**：`fired=true` 在 sent 与 unknown 下**都成立**，不能拿它证明"结论是 sent"。
    // 用两条只有 sent 才会有的证据：①平台真的发出去（`platform.count()===1`）②deliver 那行日志。
    assert.ok(runnerLogs.some((line) => line.includes('reminder delivered to')),
      `要有 sent 才有的投递日志：${runnerLogs.join(' | ')}`)
    assert.equal(row?.fired, true, '一次性提醒被标成已触发')
    // 反向：不许出现 unknown 的痕迹（否则就是"发不出去还当成功"）。
    assert.equal((row as { unknownAt?: number } | undefined)?.unknownAt, undefined, '不许被记成 unknown')
    assert.equal(row?.pendingDispatch, undefined, 'dispatched 写成功 ⇒ 不该有待办（若 runtime 拒了就会记待办）')
    // 日程侧：那条 occurrence 现在是 dispatched（真 runtime 的 state，不是我们的缓存）。
    const view = runtime.listSchedule?.({ sessionId: SESSION, occurrenceLimit: 50 }) as {
      occurrences?: Array<{ occurrenceId: string, status?: string }>
    } | undefined
    const occurrence = (view?.occurrences ?? []).find((item) => item.occurrenceId === occurrenceId)
    assert.ok(occurrence !== undefined, `runtime 里要能查到这条 occurrence：${JSON.stringify(view)}`)
    assert.ok(['dispatched', 'completed', 'done'].includes(String(occurrence?.status)),
      `runtime 侧的状态要是"已投递"（实际 ${String(occurrence?.status)}）`)
  } finally {
    closeRuntime?.()
    configureReminderSeams({})
    configureAgendaPort(null)
    configureAgendaResolver(null)
    fs.rmSync(home.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
