import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import { ReminderStore } from '../src/features/reminders/store.js'
import { resourceListOf } from '../src/features/reminders/index.js'
import { buildStatus } from '../src/features/admin/index.js'
import { baseConfig, tempHome, FakeOutboundQueue, FakePlatform } from './fakes/contact.js'
import type { SubHost } from '../src/features/plugin-kit.js'

// **第九轮**：**读失败 ≠ 没有提醒**。以前读不出来时内存是空表，后台/资源面显示 `0`——
// 运维会读成"没有提醒"，实际是"读不出来"。这条要求"用 0 冒充"的变体不进生产。

const OWNER = 10001

const makeHost = (dir: string, store: ReminderStore): SubHost => {
  const platform = new FakePlatform()
  const queue = new FakeOutboundQueue()
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const config = { ...base, workspacePath: dir, reminders: { enabled: true, dryRun: false, file: null } } as QQChannelConfig
  return {
    config,
    log: () => {},
    need: () => ({ api: platform.api, out: queue }),
    provide: () => {},
    registerResource: () => {},
    bridge: { toolHost: () => ({ register: () => {} }) },
    dshHome: dir,
    get: (name: string) => (name === 'reminders' ? store : name === 'platform' ? { api: platform.api, out: queue } : undefined),
  } as unknown as SubHost
}

const brokenStore = async (dir: string): Promise<ReminderStore> => {
  const file = path.join(dir, 'reminders.json')
  fs.writeFileSync(file, '{ 坏掉的 JSON', 'utf8')
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const store = new ReminderStore(
    { ...base.reminders, file: null },
    { workspacePath: dir, dshHome: dir, log: () => {} },
  )
  await store.load()
  return store
}

test('R9-1 读失败时资源面 `count` 必须是 **null**（不是 0），并带 `readLock` 说明', async () => {
  const home = tempHome('qq-r9-res-')
  try {
    const store = await brokenStore(home.dir)
    const list = resourceListOf(store)()
    assert.equal(list.count, null, '**不许拿 0 冒充"没有提醒"**——读不出来时给 null')
    assert.ok(list.readLock !== null, '要带 readLock 说明')
    assert.equal(list.readLock?.reason, 'unreadable')
    assert.equal(list.readLock?.source, path.join(home.dir, 'reminders.json'))
    assert.deepEqual(list.reminders, [], '列表为空是"读不出来"，由 readLock 解释')
    // 对照：正常盘上 `count` 是数字。
    const okHome = tempHome('qq-r9-res-ok-')
    try {
      const file = path.join(okHome.dir, 'reminders.json')
      fs.writeFileSync(file, `${JSON.stringify({ version: 1, reminders: [] })}\n`, 'utf8')
      const okStore = new ReminderStore(
        { ...(baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig).reminders, file: null },
        { workspacePath: okHome.dir, dshHome: okHome.dir, log: () => {} },
      )
      await okStore.load()
      const okList = resourceListOf(okStore)()
      assert.equal(okList.count, 0, '正常盘上 count 是数字 0（真·没有提醒）')
      assert.equal(okList.readLock, null)
    } finally {
      fs.rmSync(okHome.dir, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

test('R9-2 后台状态带 `remindersReadLock`（真 `buildStatus`），前端据此显示"读失败"而不是 0', async () => {
  const home = tempHome('qq-r9-admin-')
  try {
    const store = await brokenStore(home.dir)
    // 走**真的** `buildStatus()`（`SectionHost`），而不是只 grep 源码。
    const { createHost } = await import('../src/features/plugin-kit.js')
    const { resolveConfig } = await import('../src/config.js')
    const host = createHost({
      config: resolveConfig(),
      dshHome: home.dir,
      log: () => {},
      resources: {},
      bridge: {
        toolHost: () => ({ tools: { register: () => () => {} } }),
        agentGateway: () => ({} as never),
        tagContext: () => ({} as never),
        presetRegistry: () => undefined,
        agentRegistry: () => undefined,
        providersSurface: () => undefined,
        logHostError: () => {},
        reloadSections: async () => [],
      },
      scope: async () => () => {},
    }, {}, 'test') as unknown as SubHost
    ;(host as unknown as { provide: (name: string, value: unknown) => void }).provide('reminders', store)
    const status = await buildStatus(host, Date.now()) as { remindersReadLock: { reason: string } | null }
    assert.ok(status.remindersReadLock !== null, '状态里必须能看出读失败')
    assert.equal(status.remindersReadLock?.reason, 'unreadable')

    // 前端守卫：提醒页在锁生效时必须显示"读失败"，概览页那一格也不许显示 0。
    const page = fs.readFileSync(path.join(process.cwd(), 'src/admin/ui/pages/module.js'), 'utf8')
    assert.ok(page.includes('提醒读失败：数据不可读'), '提醒页要有明确的"读失败"pill')
    assert.ok(page.includes('读不出来'), '要写清"空 = 读不出来"')
    const overview = fs.readFileSync(path.join(process.cwd(), 'src/admin/ui/pages/overview.js'), 'utf8')
    assert.ok(overview.includes("lock ? '读失败'"), '概览页那一格不许显示 0')
    // 生成物也要带上（否则线上跑的是旧 UI）。
    const html = fs.readFileSync(path.join(process.cwd(), 'src/admin-html.ts'), 'utf8')
    assert.ok(html.includes('提醒读失败'), '生成物必须包含这条')
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

test('R9-3 读失败可被 grep：日志一行 + sidecar 文件名固定', async () => {
  const home = tempHome('qq-r9-grep-')
  try {
    const logs: string[] = []
    const file = path.join(home.dir, 'reminders.json')
    fs.writeFileSync(file, '{ 坏', 'utf8')
    const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
    const store = new ReminderStore(
      { ...base.reminders, file: null },
      { workspacePath: home.dir, dshHome: home.dir, log: (line) => { logs.push(line) } },
    )
    await store.load()
    assert.ok(logs.some((line) => line.includes('锁定所有写入')), `日志要能被 grep：${logs.join(' | ')}`)
    assert.ok(logs.some((line) => line.includes('readonly.json')), '日志要指出 sidecar 路径')
    assert.equal(fs.existsSync(`${file}.readonly.json`), true, 'sidecar 文件名固定为 <file>.readonly.json')
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

test('R9-4 README 写清"count=0 可能是读不出来"与恢复办法', () => {
  const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8')
  assert.ok(readme.includes('不代表'), 'README 要说清 0 不等于没有')
  assert.ok(readme.includes('readonly.json'), 'README 要指明 sidecar')
  assert.ok(readme.includes('clearReadLock'), 'README 要给出恢复入口')
})
