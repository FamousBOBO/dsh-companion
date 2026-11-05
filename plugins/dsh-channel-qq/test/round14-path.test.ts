import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import { ReminderStore } from '../src/features/reminders/store.js'
import * as fs from 'node:fs'
import { remindersPlugin } from '../src/features/reminders/index.js'
import { baseConfig, tempHome } from './fakes/contact.js'

// **task-66（P1）**：这条测试的唯一意义就是**把生产路径钉死**。
//
// 背景：`store.ts` 重写时我把 null 分支写错过两次——
//   第一次 `<workspace>/.dsh-qq/reminders.json`，第二次 `<dshHome>/reminders.json`。
// 两次测试都抓不到，因为**所有测试都传非 null 的 workspacePath**，两条公式在非 null 时同解。
// 而生产 `plugins/dsh-channel-qq/cordis.patch.yml:23` 恰恰是 `workspacePath: null`，
// 真实提醒文件在 `home/channel-qq/reminders.json`。差一个字 = 既有提醒全部读不到。

const base = baseConfig({ admins: [1] }) as unknown as QQChannelConfig

test('P1 workspacePath 为 null ⇒ <dshHome>/channel-qq/reminders.json（与老代码逐字一致）', async () => {
  const store = new ReminderStore(
    { ...base.reminders, file: null },
    { workspacePath: null, dshHome: '/H', log: () => {} },
  )
  assert.equal(store.file, path.resolve('/H/channel-qq/reminders.json'), '生产路径不许再漂')
  await store.close()
})

test('P1 workspacePath 非 null ⇒ <workspacePath>/reminders.json；相对 file 也落在同一目录', async () => {
  const a = new ReminderStore(
    { ...base.reminders, file: null },
    { workspacePath: '/W', dshHome: '/H', log: () => {} },
  )
  assert.equal(a.file, path.resolve('/W/reminders.json'))
  await a.close()

  const b = new ReminderStore(
    { ...base.reminders, file: 'sub/rm.json' },
    { workspacePath: '/W', dshHome: '/H', log: () => {} },
  )
  assert.equal(b.file, path.resolve('/W/sub/rm.json'), '相对路径基于 base 目录')
  await b.close()
})

// ── 注册表释放：`drain()` 抛错也必须释放（否则热重载会 OWNER_CONFLICT）

test('P1 `close()` 即使 `drain()` 抛错，也必须释放 owner 注册表', async () => {
  const dir = '/H2'
  const first = new ReminderStore(
    { ...base.reminders, file: null },
    { workspacePath: dir, dshHome: dir, log: () => {} },
  )
  // 白盒：让 drain 抛错（真实 drain 不会抛——tail 链被设计成不毒化；这里专门验 finally）。
  const internal = first as unknown as { queue: { close: () => void; drain: () => Promise<void> } }
  internal.queue = { close: () => {}, drain: async () => { throw new Error('drain boom') } }
  await assert.rejects(() => first.close(), /drain boom/)

  // 释放了 ⇒ 同一路径能再建新实例；没释放 ⇒ 这里会抛 OWNER_CONFLICT。
  const second = new ReminderStore(
    { ...base.reminders, file: null },
    { workspacePath: dir, dshHome: dir, log: () => {} },
  )
  assert.equal(second.file, path.resolve('/H2/reminders.json'))
  await second.close()
})

// ── P1 第三次（插件层）：生产 workspacePath 是 null，文件必须落 <dshHome>/channel-qq ──
// 这条钉的是 **apply() 那一层**：Store 自己解析 null 是对的（上面三条已证明），
// 但插件以前写成 `workspacePath: base.workspacePath ?? base.dshHome`，把 null 换成 dshHome
// ⇒ 文件落到 `<dshHome>/reminders.json`，**既有提醒全部读不到**。旧代码下这条必红。

test('P1（插件层）apply 之后文件必须是 <dshHome>/channel-qq/reminders.json', async () => {
  const home = tempHome('qq-p1-plugin')
  try {
    // 生产配置：workspacePath = null（cordis.patch.yml:23）
    const base = baseConfig({ admins: [10001] }) as unknown as QQChannelConfig
    const config = { ...base, workspacePath: null, reminders: { enabled: false, dryRun: true, file: null } } as QQChannelConfig
    let provided: { file: string } | undefined
    const host = {
      config,
      log: () => {},
      need: () => ({ api: {}, out: { push: async (fn: () => Promise<unknown>) => await fn() } }),
      provide: (name: string, value: unknown) => {
        if (name === 'reminders') provided = value as { file: string }
      },
      registerResource: () => {},
      bridge: { toolHost: () => ({ register: () => {} }) },
      dshHome: home.dir,
      get: () => undefined,
    } as never
    const dispose = await remindersPlugin.apply(host) as (() => Promise<void>) | undefined
    assert.ok(provided !== undefined, 'apply 必须 provide reminders')
    assert.equal(
      path.resolve(provided!.file),
      path.resolve(path.join(home.dir, 'channel-qq', 'reminders.json')),
      '生产 workspacePath=null ⇒ 必须落 <dshHome>/channel-qq（不是 <dshHome>）',
    )
    if (dispose !== undefined) await dispose()
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})
