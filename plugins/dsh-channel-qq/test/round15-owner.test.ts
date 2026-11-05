import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import { ReminderStore } from '../src/features/reminders/store.js'
import { remindersPlugin } from '../src/features/reminders/index.js'
import { baseConfig, tempHome } from './fakes/contact.js'

/** 造一个只有 reminders 需要的假宿主（`workspacePath: null` = 生产形态）。 */
function hostFor(dir: string, dryRun: boolean): Record<string, unknown> {
  const base = baseConfig({ admins: [10001] }) as unknown as QQChannelConfig
  const config = { ...base, workspacePath: null, reminders: { enabled: false, dryRun, file: null } } as QQChannelConfig
  return {
    config,
    log: () => {},
    need: () => ({ api: {}, out: { push: async (fn: () => Promise<unknown>) => await fn() } }),
    provide: () => {},
    registerResource: () => {},
    bridge: { toolHost: () => ({ register: () => {} }) },
    dshHome: dir,
    get: () => undefined,
  }
}

const opts = (dir: string): { workspacePath: null; dshHome: string; log: (line: string) => void } =>
  ({ workspacePath: null, dshHome: dir, log: () => {} })

/**
 * P1（复审 1.3）守卫：**`apply()` 抛出后不能泄漏 OWNER**。
 *
 * 泄漏的后果不是"这次没挂上"，而是"同一路径后续任何 `new ReminderStore` 都抛
 * `OWNER_CONFLICT`"——文件坏一次 = 提醒子系统本进程内彻底无法恢复。
 */
test('P1-1.3 apply 抛出后 owner 不泄漏（同一文件还能再建 Store）', async () => {
  const home = tempHome('qq-owner-')
  const cfg = (hostFor(home.dir, false).config as QQChannelConfig).reminders
  try {
    // ── 前置断言：证明这条检测方式有效（正常 apply 之后，第二次 new **确实**抛）──
    const disposeOk = await remindersPlugin.apply(hostFor(home.dir, true) as never) as (() => Promise<void>) | undefined
    assert.throws(() => new ReminderStore(cfg, opts(home.dir)), /OWNER_CONFLICT/, '前置：apply 之后 owner 必须真的注册了')
    if (disposeOk !== undefined) await disposeOk()
    const afterDispose = new ReminderStore(cfg, opts(home.dir))
    await afterDispose.close()

    // ── 正题：坏 JSON + dryRun=false ⇒ pruneOnStartup 抛 ⇒ apply 必须关掉 store 再抛 ──
    fs.mkdirSync(path.join(home.dir, 'channel-qq'), { recursive: true })
    fs.writeFileSync(path.join(home.dir, 'channel-qq', 'reminders.json'), '{ 坏', 'utf8')
    await assert.rejects(async () => { await remindersPlugin.apply(hostFor(home.dir, false) as never) }, '坏文件下 apply 必须抛')

    // 关键断言：owner 已释放 ⇒ 同一文件能再建
    const again = new ReminderStore(cfg, opts(home.dir))
    await again.close()
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})
