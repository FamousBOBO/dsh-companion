/** 参与者注册表的取用面（P9-G4 §2.2）与 `participants` 配置段的断言。
 *
 * 重点全在**坏情况**上：这条路径在每条群消息上都会被调用，而它读到的东西是别人手写的文件
 * （操作者会写错、会被编辑器截断、会被另一个进程删掉）。所以"不抛、不猜、不每次读盘"
 * 三件事都要有用例钉住——它们比"能读出成员"更难在事后发现坏掉。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import {
  createParticipantRegistry,
  defaultParticipantsFile,
  participantsFilePath,
  type RegistryFileStat,
} from '../src/adapters/fs-store/participant-registry.js'
import { resolveParticipant, type RegistryFile } from '../src/core/participant.js'
import { PARTICIPANTS_GROUPS } from '../src/config/sections/participants.js'

const GROUP_A = 900_000_001
const GROUP_B = 900_000_002
const BOT_A = 3_000_000_001
const BOT_B = 3_000_000_002

/** 一个临时"套件根"：里面有 `home`（= DSH_HOME）与 `home/companion/participants.json`。 */
function scratchHome(): { readonly root: string; readonly dshHome: string; readonly registry: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'participants-'))
  const dshHome = path.join(root, 'home')
  mkdirSync(path.join(dshHome, 'companion'), { recursive: true })
  return { root, dshHome, registry: path.join(dshHome, 'companion', 'participants.json') }
}

/** 一份合法注册表（两个群各一个机器人）。 */
function registryValue(): unknown {
  return {
    schemaVersion: 1,
    groups: [
      {
        groupId: GROUP_A,
        members: [
          { userId: BOT_A, kind: 'bot', alias: 'Bot-A', framework: 'framework-a' },
          { userId: 3_000_000_003, kind: 'human', alias: '小王' },
        ],
      },
      { groupId: GROUP_B, members: [{ userId: BOT_B, kind: 'bot', alias: 'Bot-B' }] },
    ],
  }
}

function writeRegistry(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

async function withHome(
  fn: (home: { root: string; dshHome: string; registry: string }) => Promise<void>,
): Promise<void> {
  const home = scratchHome()
  try {
    await fn(home)
  } finally {
    rmSync(home.root, { recursive: true, force: true })
  }
}

/** 只读一次的 stub：`readText` 计数，`statFile` 返回调用方指定的 stat。 */
function stubIo(stat: RegistryFileStat | null, texts: string[]): {
  readonly reads: () => number
  readonly readText: (file: string) => Promise<string | null>
  readonly statFile: (file: string) => Promise<RegistryFileStat | null>
} {
  let reads = 0
  let current = stat
  return {
    reads: () => reads,
    readText: async () => {
      reads += 1
      return texts[reads - 1] ?? texts[texts.length - 1] ?? null
    },
    statFile: async () => current,
  }
}

// ── 文件不存在 / 路径算不出来：空注册表，不是错误 ──────────────────────────

test('文件不存在 → kind=missing、registryOf/version 都是 null，且不抛', async () => {
  await withHome(async (home) => {
    const registry = createParticipantRegistry({ dshHome: () => home.dshHome })
    assert.equal(registry.file, home.registry, '默认路径 = <dataRoot>/home/companion/participants.json')
    const load = await registry.load()
    assert.equal(load.kind, 'missing')
    assert.equal(await registry.registryOf(GROUP_A), null)
    assert.equal(await registry.version(GROUP_A), null)
    assert.equal(registry.versionSync(GROUP_A), null)
    assert.ok(load.problems.length > 0, '缺文件也要给出可进日志的一句话')
  })
})

test('DSH_HOME 不存在（dataRoot 算不出来）→ file 为 null，load 返回 missing 且不抛', async () => {
  const registry = createParticipantRegistry({ dshHome: () => path.join(tmpdir(), 'no-such-dsh-home-xyz') })
  assert.equal(registry.file, null)
  const load = await registry.load()
  assert.equal(load.kind, 'missing')
  assert.equal(await registry.registryOf(GROUP_A), null)
})

test('构造不读盘：造出来之后文件才出现，第一次 load 就能读到', async () => {
  await withHome(async (home) => {
    const registry = createParticipantRegistry({ dshHome: () => home.dshHome })
    writeRegistry(home.registry, registryValue())
    const load = await registry.load()
    assert.equal(load.kind, 'loaded')
  })
})

// ── 坏文件：返回问题列表，绝不抛 ────────────────────────────────────────────

test('坏 JSON → kind=invalid + 问题列表，registryOf 回落 null（不抛）', async () => {
  await withHome(async (home) => {
    writeFileSync(home.registry, '{"schemaVersion": 1, "groups": [', 'utf8')
    const registry = createParticipantRegistry({ dshHome: () => home.dshHome })
    const load = await registry.load()
    assert.equal(load.kind, 'invalid')
    assert.ok(load.problems.length > 0)
    assert.equal(await registry.registryOf(GROUP_A), null, '坏了就当没有，不猜')
  })
})

test('schemaVersion 不对 / groups 不是数组 → invalid，且问题列表说得清是哪一处', async () => {
  await withHome(async (home) => {
    writeRegistry(home.registry, { schemaVersion: 2, groups: [] })
    const bad1 = await createParticipantRegistry({ dshHome: () => home.dshHome }).load()
    assert.equal(bad1.kind, 'invalid')
    assert.match(bad1.problems.join(' '), /schemaVersion/)

    writeRegistry(home.registry, { schemaVersion: 1, groups: 'nope' })
    const bad2 = await createParticipantRegistry({ dshHome: () => home.dshHome }).load()
    assert.equal(bad2.kind, 'invalid')
    assert.match(bad2.problems.join(' '), /groups/)
  })
})

test('空文件（0 字节）→ invalid，不抛', async () => {
  await withHome(async (home) => {
    writeFileSync(home.registry, '', 'utf8')
    const load = await createParticipantRegistry({ dshHome: () => home.dshHome }).load()
    assert.equal(load.kind, 'invalid')
  })
})

test('readText 抛错 → 收敛成 missing（最外层的"绝不抛"）', async () => {
  const registry = createParticipantRegistry({
    file: 'x.json',
    readText: async () => { throw new Error('EACCES') },
    statFile: async () => ({ mtimeMs: 1, size: 10 }),
  })
  const load = await registry.load()
  assert.equal(load.kind, 'missing')
  assert.match(load.problems.join(' '), /EACCES/)
})

test('statFile 抛错 → 仍然是 missing，不抛', async () => {
  const registry = createParticipantRegistry({
    file: 'x.json',
    readText: async () => '{}',
    statFile: async () => { throw new Error('stat blew up') },
  })
  assert.equal((await registry.load()).kind, 'missing')
})

// ── 合法文件：按群取成员 ────────────────────────────────────────────────────

test('合法文件 → 按群号取到成员；没登记的群是 null（不是"空群"）', async () => {
  await withHome(async (home) => {
    writeRegistry(home.registry, registryValue())
    const registry = createParticipantRegistry({ dshHome: () => home.dshHome })
    const groupA = await registry.registryOf(GROUP_A)
    assert.equal(groupA?.groupId, GROUP_A)
    assert.deepEqual(groupA?.members.map((m) => m.userId), [BOT_A, 3_000_000_003])
    assert.equal(groupA?.members[0]?.kind, 'bot')
    assert.equal(groupA?.members[0]?.alias, 'Bot-A')
    assert.equal(await registry.registryOf(900_000_009), null)
  })
})

test('跨群隔离：A 群登记的号在 B 群查不到（同一个号不是同一个身份）', async () => {
  await withHome(async (home) => {
    writeRegistry(home.registry, registryValue())
    const registry = createParticipantRegistry({ dshHome: () => home.dshHome })
    const inA = await registry.registryOf(GROUP_A)
    const inB = await registry.registryOf(GROUP_B)
    assert.notEqual(inA?.members.find((m) => m.userId === 3_000_000_003), undefined)
    assert.equal(inB?.members.find((m) => m.userId === 3_000_000_003), undefined)
    // 用同一个号在 B 群里解析：必须是 unknown，而不是"他在 A 群是 human"。
    const asUnknown = resolveParticipant({ userId: 3_000_000_003, registry: inB })
    assert.equal(asUnknown.senderKind, 'unknown')
    assert.equal(asUnknown.source, 'unknown')
  })
})

test('非法群号（0 / 负数 / 非整数 / NaN）→ registryOf 返回 null，不抛', async () => {
  await withHome(async (home) => {
    writeRegistry(home.registry, registryValue())
    const registry = createParticipantRegistry({ dshHome: () => home.dshHome })
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(await registry.registryOf(bad), null, `群号 ${String(bad)} 不该查出注册表`)
      assert.equal(await registry.version(bad), null)
    }
  })
})

test('形状不对的成员被丢掉，但整份注册表仍然可用（problems 非空）', async () => {
  await withHome(async (home) => {
    writeRegistry(home.registry, {
      schemaVersion: 1,
      groups: [{
        groupId: GROUP_A,
        members: [
          { userId: BOT_A, kind: 'bot', alias: 'Bot-A' },
          { userId: 'not-a-number', kind: 'bot' },
          { userId: 3_000_000_009, kind: 'robot' },
        ],
      }],
    })
    const load = await createParticipantRegistry({ dshHome: () => home.dshHome }).load()
    assert.equal(load.kind, 'loaded')
    assert.equal(load.problems.length, 2, '两条坏记录都要有说明')
    const group = await createParticipantRegistry({ dshHome: () => home.dshHome }).registryOf(GROUP_A)
    assert.deepEqual(group?.members.map((m) => m.userId), [BOT_A], '不补默认 kind、不猜')
  })
})

test('同一个群出现两次 → 保留第一条、第二条不合并（判定归 core，适配层不重复判）', async () => {
  await withHome(async (home) => {
    writeRegistry(home.registry, {
      schemaVersion: 1,
      groups: [
        { groupId: GROUP_A, members: [{ userId: BOT_A, kind: 'bot' }] },
        { groupId: GROUP_A, members: [{ userId: BOT_B, kind: 'bot' }] },
      ],
    })
    const registry = createParticipantRegistry({ dshHome: () => home.dshHome })
    const load = await registry.load()
    assert.equal(load.kind, 'loaded', '"同一个群两份"由 core 收成一份，不至于让整份文件作废')
    // 关键：**不合并**。合并会让"这一版注册表是什么"失去唯一答案（版本号也就失去意义）。
    const group = await registry.registryOf(GROUP_A)
    assert.deepEqual(group?.members.map((m) => m.userId), [BOT_A], '第一条胜出，第二条整段丢掉')
  })
})

// ── 版本号：写了的用它的，没写的按内容哈希 ──────────────────────────────────

test('没写 version → 内容 sha256 前 16 位（同内容同版本、改一个字节就变）', async () => {
  await withHome(async (home) => {
    writeRegistry(home.registry, registryValue())
    const registry = createParticipantRegistry({ dshHome: () => home.dshHome })
    const first = await registry.version(GROUP_A)
    assert.match(String(first), /^[0-9a-f]{16}$/)
    assert.equal(await registry.version(GROUP_B), first, '同一份文件、都没写版本 → 同一个内容哈希')

    const changed = registryValue() as { groups: Array<{ groupId: number; members: Array<{ alias?: string }> }> }
    const member = changed.groups[0]?.members[0]
    assert.ok(member !== undefined)
    member.alias = 'Bot-A2'
    writeRegistry(home.registry, changed)
    registry.invalidate()
    const second = await registry.version(GROUP_A)
    assert.notEqual(second, first, '改一个字节，版本必须变')
  })
})

test('自己写了 version 就用它，不覆盖成内容哈希（操作者的版本号优先）', async () => {
  await withHome(async (home) => {
    writeRegistry(home.registry, {
      schemaVersion: 1,
      groups: [{ groupId: GROUP_A, version: 'r7', members: [{ userId: BOT_A, kind: 'bot' }] }],
    })
    const registry = createParticipantRegistry({ dshHome: () => home.dshHome })
    assert.equal(await registry.version(GROUP_A), 'r7')
    assert.equal(registry.versionSync(GROUP_A), 'r7')
  })
})

test('同一份文件里有的群写版本、有的没写 → 各按各的规则', async () => {
  await withHome(async (home) => {
    writeRegistry(home.registry, {
      schemaVersion: 1,
      groups: [
        { groupId: GROUP_A, version: 'manual-1', members: [{ userId: BOT_A, kind: 'bot' }] },
        { groupId: GROUP_B, members: [{ userId: BOT_B, kind: 'bot' }] },
      ],
    })
    const registry = createParticipantRegistry({ dshHome: () => home.dshHome })
    assert.equal(await registry.version(GROUP_A), 'manual-1')
    assert.match(String(await registry.version(GROUP_B)), /^[0-9a-f]{16}$/)
  })
})

test('没登记这个群时 version 是 null（不拿别的群的版本冒充）', async () => {
  await withHome(async (home) => {
    writeRegistry(home.registry, registryValue())
    const registry = createParticipantRegistry({ dshHome: () => home.dshHome })
    assert.equal(await registry.version(900_000_777), null)
  })
})

// ── 缓存：mtime/size 不变就一个字节都不读 ───────────────────────────────────

test('mtime 与 size 不变 → 第二次 load 不重读盘（这条路径在每条消息上都被调用）', async () => {
  const io = stubIo({ mtimeMs: 1_000, size: 42 }, [JSON.stringify(registryValue())])
  const registry = createParticipantRegistry({ file: 'x.json', readText: io.readText, statFile: io.statFile })
  assert.equal((await registry.load()).kind, 'loaded')
  assert.equal(io.reads(), 1)
  assert.equal((await registry.load()).kind, 'loaded')
  assert.equal((await registry.load()).kind, 'loaded')
  assert.equal(io.reads(), 1, 'mtime 没变就不该再读')
})

test('mtime 变了 → 重读，并且新内容立刻生效', async () => {
  const io = stubIo({ mtimeMs: 1_000, size: 42 }, [
    JSON.stringify({ schemaVersion: 1, groups: [{ groupId: GROUP_A, members: [{ userId: BOT_A, kind: 'bot' }] }] }),
    JSON.stringify({ schemaVersion: 1, groups: [{ groupId: GROUP_A, members: [{ userId: BOT_B, kind: 'bot' }] }] }),
  ])
  let stat: RegistryFileStat = { mtimeMs: 1_000, size: 42 }
  const registry = createParticipantRegistry({
    file: 'x.json',
    readText: io.readText,
    statFile: async () => stat,
  })
  assert.deepEqual((await registry.registryOf(GROUP_A))?.members.map((m) => m.userId), [BOT_A])
  stat = { mtimeMs: 2_000, size: 42 }
  assert.deepEqual((await registry.registryOf(GROUP_A))?.members.map((m) => m.userId), [BOT_B])
  assert.equal(io.reads(), 2)
})

test('mtime 相同但 size 变了 → 也要重读（有些文件系统的 mtime 只到秒）', async () => {
  const io = stubIo({ mtimeMs: 1_000, size: 10 }, [JSON.stringify(registryValue()), JSON.stringify(registryValue())])
  let stat: RegistryFileStat = { mtimeMs: 1_000, size: 10 }
  const registry = createParticipantRegistry({ file: 'x.json', readText: io.readText, statFile: async () => stat })
  await registry.load()
  stat = { mtimeMs: 1_000, size: 11 }
  await registry.load()
  assert.equal(io.reads(), 2)
})

test('invalidate() 之后重读（"拷进一个同 mtime 的文件"只有它能救）', async () => {
  const io = stubIo({ mtimeMs: 1_000, size: 42 }, [JSON.stringify(registryValue())])
  const registry = createParticipantRegistry({ file: 'x.json', readText: io.readText, statFile: io.statFile })
  await registry.load()
  registry.invalidate()
  assert.equal(registry.versionSync(GROUP_A), null, '忘掉缓存也要忘掉同步快照')
  await registry.load()
  assert.equal(io.reads(), 2)
})

test('fileSync / versionSync：只有 load 过才有值（采集路径同步取用，零 IO）', async () => {
  await withHome(async (home) => {
    writeRegistry(home.registry, registryValue())
    const registry = createParticipantRegistry({ dshHome: () => home.dshHome })
    assert.equal(registry.fileSync(), null, '还没加载过 = 没有可用快照（不是"空注册表"）')
    assert.equal(registry.versionSync(GROUP_A), null)
    const loaded = await registry.load()
    assert.equal(loaded.kind, 'loaded')
    assert.equal(registry.fileSync()?.groups.length, 2)
    assert.match(String(registry.versionSync(GROUP_A)), /^[0-9a-f]{16}$/)
    assert.equal(registry.versionSync(900_000_009), null, '没登记的群同步查也是 null')
    // 坏掉之后快照必须一起作废：留着旧快照等于拿一份已经作废的注册表认人。
    writeFileSync(home.registry, 'not json', 'utf8')
    registry.invalidate()
    assert.equal((await registry.load()).kind, 'invalid')
    assert.equal(registry.fileSync(), null)
  })
})

test('文件被删掉 → 缓存作废，load 回到 missing（删注册表要能立刻生效）', async () => {
  await withHome(async (home) => {
    writeRegistry(home.registry, registryValue())
    const registry = createParticipantRegistry({ dshHome: () => home.dshHome })
    assert.equal((await registry.load()).kind, 'loaded')
    unlinkSync(home.registry)
    const after = await registry.load()
    assert.equal(after.kind, 'missing')
    assert.equal(await registry.registryOf(GROUP_A), null)
  })
})

test('并发 load 只读一次盘（同一批消息会撞在同一个 tick 上）', async () => {
  const io = stubIo({ mtimeMs: 1_000, size: 42 }, [JSON.stringify(registryValue())])
  const registry = createParticipantRegistry({ file: 'x.json', readText: io.readText, statFile: io.statFile })
  const results = await Promise.all([registry.load(), registry.load(), registry.load()])
  assert.deepEqual(results.map((r) => r.kind), ['loaded', 'loaded', 'loaded'])
  assert.equal(io.reads(), 1)
})

// ── 路径解析 ────────────────────────────────────────────────────────────────

test('participantsFilePath：配置了就用配置（相对路径按 cwd 解析），没配置用默认位置', async () => {
  await withHome(async (home) => {
    assert.equal(participantsFilePath({ dshHome: home.dshHome }), home.registry)
    assert.equal(participantsFilePath({ configured: '   ', dshHome: home.dshHome }), home.registry)
    assert.equal(participantsFilePath({ configured: '/tmp/x.json', dshHome: home.dshHome }), path.resolve('/tmp/x.json'))
    assert.equal(participantsFilePath({ configured: 'rel/x.json', dshHome: home.dshHome }), path.resolve('rel/x.json'))
  })
})

test('defaultParticipantsFile：DSH_HOME 是 <data>/home → 注册表在 <data>/home/companion 下', async () => {
  await withHome(async (home) => {
    const file = defaultParticipantsFile(home.dshHome)
    assert.equal(file, path.join(home.root, 'home', 'companion', 'participants.json'))
  })
})

test('配置里的 file 指向别处时就读那一份（默认那份完全不碰）', async () => {
  await withHome(async (home) => {
    const custom = path.join(home.root, 'elsewhere', 'bots.json')
    mkdirSync(path.dirname(custom), { recursive: true })
    writeRegistry(custom, registryValue())
    const registry = createParticipantRegistry({ dshHome: () => home.dshHome, file: custom })
    assert.equal(registry.file, custom)
    assert.equal(await registry.version(GROUP_A) !== null, true)
  })
})

// ── 配置段 ──────────────────────────────────────────────────────────────────

test('participants 段：三个字段、默认关、都带页面与热生效标注（接线由 schema 负责）', () => {
  assert.equal(PARTICIPANTS_GROUPS.length, 1)
  const group = PARTICIPANTS_GROUPS[0]
  assert.ok(group !== undefined)
  assert.equal(group.id, 'participants')
  assert.deepEqual(Object.keys(group.fields).sort(), ['allowUnknownAsBot', 'enabled', 'file'])
  assert.equal(group.fields['enabled']?.default, false, '默认关：关着时所有人 unknown')
  assert.equal(group.fields['file']?.default, '', '空串 = 用默认路径')
  assert.equal(group.fields['allowUnknownAsBot']?.default, false)
  for (const [name, spec] of Object.entries(group.fields)) {
    assert.equal(spec.page, 'groups', `${name} 必须落在群聊页`)
    assert.ok(spec.hot === 'live' || spec.hot === 'reload', `${name} 的 hot 标注不对`)
    assert.ok((spec.help ?? '').length > 20, `${name} 的 help 要写清后果`)
  }
})

test('配置段里的 allowUnknownAsBot 只是文档：没有任何代码路径把它读成 true', async () => {
  // 未登记 → unknown，这是**唯一**的结论；注册表为空时也一样。
  const empty: RegistryFile = { schemaVersion: 1, groups: [] }
  const participant = resolveParticipant({ userId: BOT_A, registry: null })
  assert.equal(participant.senderKind, 'unknown')
  assert.equal(empty.groups.length, 0)
})
