/** 技能：frontmatter 解析、可见范围、序列化往返、仓库读写。
 *
 * 可见范围是这次改动的核心安全面：一条 `visibility: dm` 的技能如果能在群里被
 * 列出/加载，就等于把私聊指令泄露给群友。所以判据在纯函数层逐条钉住，而不是
 * 只测"工具能跑"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  parseSkillFile, policyOf, skillVisibleTo, META_PREFIX, type SkillViewer,
} from '../src/core/skills/model.js'
import { serializeSkillFile } from '../src/core/skills/serialize.js'
import {
  promoteStaged, readSkillBody, removeSkill, scanSkills, stageSkill, writeSkill,
} from '../src/features/skills/store.js'
import { skillGestureName } from '../src/adapters/dsh-host/skills.js'
import { SkillStats } from '../src/features/skills/stats.js'

const viewer = (over: Partial<SkillViewer> = {}): SkillViewer => ({
  room: 'group-100', userId: null, isAdmin: false, admins: [1], ...over,
})

const SKILL = (meta = ''): string => `---
name: demo-skill
description: 一个演示技能
whenToUse: 当需要演示时
metadata:
  channel-qq.visibility: all
${meta}---

正文第一行
正文第二行
`

test('解析：合法技能取出名字、描述、正文与默认策略', () => {
  const parsed = parseSkillFile(SKILL(), 'demo-skill')
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.skill.name, 'demo-skill')
  assert.equal(parsed.skill.description, '一个演示技能')
  assert.equal(parsed.skill.whenToUse, '当需要演示时')
  assert.match(parsed.skill.body, /正文第一行/)
  assert.equal(parsed.skill.policy.visibility, 'all')
  assert.equal(parsed.skill.policy.enabled, true)
})

test('解析：名字必须与目录一致（目录包）', () => {
  const parsed = parseSkillFile(SKILL(), 'other-name')
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.equal(parsed.error.field, 'name')
})

test('解析：非法名字 / 缺描述 / 畸形 frontmatter 都给出可读错误', () => {
  const badName = parseSkillFile(SKILL().replace('name: demo-skill', 'name: Demo_Skill'), 'Demo_Skill')
  assert.equal(badName.ok, false)
  const noDesc = parseSkillFile(SKILL().replace('description: 一个演示技能\n', ''), 'demo-skill')
  assert.equal(noDesc.ok, false)
  const broken = parseSkillFile('---\nname: x\nthis line has no colon\n---\nbody')
  assert.equal(broken.ok, false)
  if (!broken.ok) assert.match(broken.error.message, /第 \d+ 行/)
  const noFrontmatter = parseSkillFile('# 只有正文')
  assert.equal(noFrontmatter.ok, false)
})

test('可见范围：all / dm / groups / rooms / none / 仅管理员 / 停用', () => {
  const policy = (meta: Record<string, string>) => policyOf(meta)
  assert.equal(skillVisibleTo(policy({}), viewer()), true)

  const dm = policy({ [`${META_PREFIX}visibility`]: 'dm' })
  assert.equal(skillVisibleTo(dm, viewer({ room: 'dm-1' })), true)
  assert.equal(skillVisibleTo(dm, viewer({ room: 'group-100' })), false)

  const groups = policy({ [`${META_PREFIX}visibility`]: 'groups', [`${META_PREFIX}rooms`]: 'group-100,group-200' })
  assert.equal(skillVisibleTo(groups, viewer({ room: 'group-100' })), true)
  assert.equal(skillVisibleTo(groups, viewer({ room: 'group-200' })), true)
  assert.equal(skillVisibleTo(groups, viewer({ room: 'group-999' })), false)
  assert.equal(skillVisibleTo(groups, viewer({ room: 'dm-1' })), false)
  // 即便 rooms 里误写了 dm-1，groups 模式也不命中私聊
  assert.equal(skillVisibleTo(policy({ [`${META_PREFIX}visibility`]: 'groups', [`${META_PREFIX}rooms`]: 'dm-1' }), viewer({ room: 'dm-1' })), false)

  const rooms = policy({ [`${META_PREFIX}visibility`]: 'rooms', [`${META_PREFIX}rooms`]: 'dm-1' })
  assert.equal(skillVisibleTo(rooms, viewer({ room: 'dm-1' })), true)

  const none = policy({ [`${META_PREFIX}visibility`]: 'none' })
  assert.equal(skillVisibleTo(none, viewer()), false)

  const adminOnly = policy({ [`${META_PREFIX}admins-only`]: 'true' })
  assert.equal(skillVisibleTo(adminOnly, viewer({ isAdmin: false })), false)
  assert.equal(skillVisibleTo(adminOnly, viewer({ isAdmin: true })), true)

  const disabled = policy({ [`${META_PREFIX}enabled`]: 'false' })
  assert.equal(skillVisibleTo(disabled, viewer()), false)
})

test('可见范围：系统回合（room=null）只看得见 all', () => {
  const system = viewer({ room: null, userId: null, isAdmin: false })
  assert.equal(skillVisibleTo(policyOf({}), system), true)
  assert.equal(skillVisibleTo(policyOf({ [`${META_PREFIX}visibility`]: 'dm' }), system), false)
  assert.equal(skillVisibleTo(policyOf({ [`${META_PREFIX}visibility`]: 'groups', [`${META_PREFIX}rooms`]: 'group-1' }), system), false)
})

test('序列化往返：策略与其它 metadata 都保留', () => {
  const parsed = parseSkillFile(SKILL(), 'demo-skill')
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const text = serializeSkillFile({
    name: parsed.skill.name,
    description: parsed.skill.description,
    whenToUse: parsed.skill.whenToUse,
    body: parsed.skill.body,
    metadata: { ...parsed.skill.metadata, author: 'someone' },
    policy: { ...parsed.skill.policy, visibility: 'groups', rooms: ['group-100'], adminsOnly: true },
  })
  const again = parseSkillFile(text, 'demo-skill')
  assert.equal(again.ok, true)
  if (!again.ok) return
  assert.equal(again.skill.policy.visibility, 'groups')
  assert.deepEqual(again.skill.policy.rooms, ['group-100'])
  assert.equal(again.skill.policy.adminsOnly, true)
  assert.equal(again.skill.metadata.author, 'someone')
  assert.match(text, /author: someone/)
})

test('仓库：写入/扫描/读取/删除，坏文件留在列表里并带原因', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-skills-'))
  try {
    const policy = policyOf({})
    await writeSkill(root, {
      name: 'alpha', description: '第一个', whenToUse: '', body: '正文 A', metadata: {}, policy,
    })
    await fs.mkdir(path.join(root, 'broken'), { recursive: true })
    await fs.writeFile(path.join(root, 'broken', 'SKILL.md'), '---\nname: broken\n---\n没有描述\n')

    const entries = await scanSkills(root)
    assert.deepEqual(entries.map((e) => e.name), ['alpha', 'broken'])
    const alpha = entries.find((e) => e.name === 'alpha')
    assert.equal(alpha?.error, '')
    assert.equal(alpha?.policy?.visibility, 'all')
    const broken = entries.find((e) => e.name === 'broken')
    assert.notEqual(broken?.error, '')

    assert.equal(await readSkillBody(root, 'alpha', 'bundle'), '正文 A')
    await removeSkill(root, 'alpha')
    assert.deepEqual((await scanSkills(root)).map((e) => e.name), ['broken'])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('导入：先落待审区，转正后才进入主目录', async () => {  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-skills-'))
  try {
    const entry = await stageSkill(root, [{ path: 'SKILL.md', content: SKILL() }])
    assert.equal(entry.staged, true)
    assert.equal(entry.name, 'demo-skill')
    // 待审区不在主目录扫描里
    assert.deepEqual(await scanSkills(root), [])
    assert.deepEqual((await scanSkills(root, { staged: true })).map((e) => e.name), ['demo-skill'])
    await promoteStaged(root, 'demo-skill')
    assert.deepEqual((await scanSkills(root)).map((e) => e.name), ['demo-skill'])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('触发：/名字 在全文任意位置都能认出来（组包会在前面拼房间指令）', () => {
  assert.equal(skillGestureName('/demo-skill 你好'), 'demo-skill')
  assert.equal(skillGestureName('房间：群 123，发送时用 groupId\n/demo-skill 请照做'), 'demo-skill')
  // 路径与分数不是触发
  assert.equal(skillGestureName('看看 /usr/bin 和 5/8'), null)
  assert.equal(skillGestureName('/Demo_Skill'), null)
})

test('使用计数：加载与触发分开记，重新实例化后还在', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-stats-'))
  const file = path.join(dir, 'stats.json')
  try {
    const stats = new SkillStats(file, () => {})
    await stats.record('demo', 'load')
    await stats.record('demo', 'load')
    await stats.record('demo', 'trigger')
    const again = new SkillStats(file, () => {})
    const all = await again.all()
    assert.equal(all.demo?.loads, 2)
    assert.equal(all.demo?.triggers, 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
