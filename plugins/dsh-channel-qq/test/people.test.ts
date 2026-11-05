/** 人物档（PR #5）：配置形状、按房间存取、去重、路径校验、工具开关。
 *
 * 重点回归：原 PR 的 root 入口把 people 指到了 memory 组，导致 people.enabled
 * 永远是 undefined、工具从不注册；以及 room 参数直接进路径的穿越风险。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { resolveConfig } = await import('../src/config.js')
const { appendPersonNote, isRoom, readPerson } = await import('../src/features/people/store.js')
const { registerPeopleTools } = await import('../src/features/people/tools.js')
const { toolRecorder } = await import('./fakes/host.js')

function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'people-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('人物档配置：people 段解析成 enabled/dir，而不是 memory 字段', () => {
  const c = resolveConfig({ selfId: 1, admins: [280], primaryGroup: 107, people: { enabled: true, dir: '/tmp/ppl' } })
  assert.equal(c.people.enabled, true)
  assert.equal(c.people.dir, '/tmp/ppl')
})

test('人物档：按房间分开存、同文去重、非法 room 拒绝', async () => {
  const t = temp()
  try {
    assert.equal(await appendPersonNote(t.dir, 555, '小明', '爱用反问', '2026-10-22', 'group-107'), true)
    assert.equal(await appendPersonNote(t.dir, 555, '小明', '爱用反问', '2026-10-22', 'group-107'), false, '同文不重复')
    assert.equal(await appendPersonNote(t.dir, 555, '小明', '怕辣', '2026-10-22', 'group-999'), true)
    assert.equal((await readPerson(t.dir, 555, 'group-107'))?.notes.length, 1)
    assert.equal((await readPerson(t.dir, 555, 'group-999'))?.notes.length, 1)
    assert.equal(isRoom('../../etc'), false)
    await assert.rejects(() => appendPersonNote(t.dir, 555, 'x', 'y', '2026-10-22', '../../etc'), /room/)
  } finally { t.cleanup() }
})

test('人物档工具：开关关着不注册；打开后 set/get/list 可用，非法 room 被拒', async () => {
  const t = temp()
  try {
    const off = toolRecorder()
    registerPeopleTools(off.ctx, resolveConfig({ selfId: 1, admins: [280], primaryGroup: 107, workspacePath: t.dir }), () => {})
    assert.equal(off.definitions.length, 0)

    const on = toolRecorder()
    const config = resolveConfig({
      selfId: 1, admins: [280], primaryGroup: 107, workspacePath: t.dir, people: { enabled: true, dir: null },
    })
    registerPeopleTools(on.ctx, config, () => {})
    const def = on.definitions.find((d) => d.name === 'qq_person_note')!
    assert.ok(def)
    const exec = def.execute as (a: unknown, e: unknown) => Promise<unknown>
    const ctx = { agent: { id: 'qq-group-107' } }
    assert.equal((await exec({ action: 'set', target: 555, note: '爱用反问', nick: '小明' }, ctx) as { written: boolean }).written, true)
    const got = await exec({ action: 'get', target: 555 }, ctx) as { found: boolean; notes: unknown[] }
    assert.equal(got.found, true)
    assert.equal(got.notes.length, 1)
    assert.equal(existsSync(path.join(t.dir, 'people', 'group-107', '555.md')), true)
    const list = await exec({ action: 'list' }, ctx) as { count: number }
    assert.equal(list.count, 1)
    const bad = await exec({ action: 'set', target: 555, note: 'x', room: '../../etc' }, ctx) as { ok: boolean }
    assert.equal(bad.ok, false, '非法 room 直接拒绝')
  } finally { t.cleanup() }
})
