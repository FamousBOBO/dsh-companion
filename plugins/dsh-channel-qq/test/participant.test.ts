/** P9-G4 §2：参与者身份模型（注册表归一化、按群隔离、身份解析）。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  normalizeMember,
  normalizeRegistryFile,
  registryFor,
  resolveParticipant,
  type RegistryFile,
} from '../src/core/participant.js'

const GROUP = 145326153
const OTHER = 900000001
const SELF = 2668517323
const BOT_A = 10001
const HUMAN_B = 10002

function registryFile(): RegistryFile {
  return {
    schemaVersion: 1,
    groups: [
      {
        groupId: GROUP,
        version: 'v1',
        members: [
          { userId: BOT_A, kind: 'bot', alias: 'Bot-A', framework: 'framework-a', verifiedAt: 1_700_000_000_000 },
          { userId: HUMAN_B, kind: 'human', alias: '小王' },
        ],
      },
    ],
  }
}

// ── 归一化：形状不对就整条丢掉，不补默认 kind ────────────────────────

test('成员：缺 kind / kind 不认识 / userId 非法 → 整条丢掉（不补默认值）', () => {
  assert.equal(normalizeMember({ userId: BOT_A }), null, '缺 kind 不许猜成 human')
  assert.equal(normalizeMember({ userId: BOT_A, kind: 'robot' }), null, '只认 bot / human')
  assert.equal(normalizeMember({ userId: 'abc', kind: 'bot' }), null)
  assert.equal(normalizeMember({ userId: 0, kind: 'bot' }), null)
  assert.equal(normalizeMember(null), null)
  assert.equal(normalizeMember('x'), null)
})

test('成员：合法的号可以写成字符串（配置手写常见），未知元数据缺省而不猜测', () => {
  const member = normalizeMember({ userId: String(BOT_A), kind: 'bot', alias: '  Bot-A  ' })
  assert.equal(member?.userId, BOT_A)
  assert.equal(member?.alias, 'Bot-A')
  assert.equal(member?.framework, undefined)
  assert.equal(member?.modelFamily, undefined, '未知元数据不能补一个值')
})

test('注册表：schemaVersion 必须为 1，groups 必须是数组', () => {
  assert.equal(normalizeRegistryFile({ groups: [] }).ok, false)
  assert.equal(normalizeRegistryFile({ schemaVersion: 2, groups: [] }).ok, false)
  assert.equal(normalizeRegistryFile({ schemaVersion: 1, groups: {} }).ok, false)
  assert.equal(normalizeRegistryFile(null).ok, false)
})

test('注册表：同一个群出现两次是配置错误 → 整段丢掉并记问题（不挑一份）', () => {
  const parsed = normalizeRegistryFile({
    schemaVersion: 1,
    groups: [
      { groupId: GROUP, version: 'v1', members: [] },
      { groupId: GROUP, version: 'v2', members: [] },
    ],
  })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.file.groups.length, 1, '只留第一份，不合并')
})

// ── 按群隔离：A 群的登记不许泄漏到 B 群 ──────────────────────────────

test('跨群隔离：A 群登记的 bot 在 B 群查不到（同一个号在别的群是另一个人）', () => {
  const file = registryFile()
  const inA = resolveParticipant({ userId: BOT_A, registry: registryFor(file, GROUP) })
  const inB = resolveParticipant({ userId: BOT_A, registry: registryFor(file, OTHER) })
  assert.equal(inA.senderKind, 'known_bot')
  assert.equal(inB.senderKind, 'unknown', '没登记的群一律 unknown，不许跨群复用')
})

// ── 身份解析的顺序 ──────────────────────────────────────────────────

test('解析顺序：自己的号优先于注册表（她自己的号由配置决定，是可信平台身份）', () => {
  const file: RegistryFile = {
    schemaVersion: 1,
    groups: [{ groupId: GROUP, version: 'v1', members: [{ userId: SELF, kind: 'bot', alias: 'X' }] }],
  }
  const participant = resolveParticipant({
    userId: SELF,
    selfId: SELF,
    registry: registryFor(file, GROUP),
  })
  assert.equal(participant.senderKind, 'self')
  assert.equal(participant.source, 'trusted_platform')
})

test('解析：selfId 缺省时不猜（不会拿 0 或别人的号顶替）', () => {
  const participant = resolveParticipant({ userId: BOT_A, registry: registryFor(registryFile(), GROUP) })
  assert.equal(participant.senderKind, 'known_bot', 'selfId 缺省只影响"我是不是自己"这一条')
  const self = resolveParticipant({ userId: SELF, selfId: undefined, registry: null })
  assert.equal(self.senderKind, 'unknown', '不传 selfId 就不能把自己当成 self')
})

test('解析：未登记一律 unknown，且不带 botProfileId（人类没有"人格标识"）', () => {
  const unknown = resolveParticipant({ userId: 99999, registry: registryFor(registryFile(), GROUP) })
  assert.equal(unknown.senderKind, 'unknown')
  assert.equal(unknown.source, 'unknown')
  assert.equal(unknown.botProfileId, undefined)

  const human = resolveParticipant({ userId: HUMAN_B, registry: registryFor(registryFile(), GROUP) })
  assert.equal(human.senderKind, 'known_human')
  assert.equal(human.botProfileId, undefined, '人类不该带 botProfileId')
})

test('解析：已确认的 bot 带 botProfileId，未知元数据仍是 undefined', () => {
  const bot = resolveParticipant({ userId: BOT_A, registry: registryFor(registryFile(), GROUP) })
  assert.equal(bot.botProfileId, 'Bot-A')
  assert.equal(bot.source, 'manual_registry')
  assert.equal(bot.verifiedAt, 1_700_000_000_000)
})

test('解析：注册表为 null 时全员 unknown（不是"全是人"）', () => {
  for (const userId of [BOT_A, HUMAN_B, 12345]) {
    assert.equal(resolveParticipant({ userId, registry: null }).senderKind, 'unknown')
  }
})
