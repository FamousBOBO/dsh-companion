/** 黑话词典（B4）：词条存储、与口癖分离、工具开关。
 *
 * 防的是"黑话混进口癖"：两个列表必须互不污染；开关关着时不能多出两个工具。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { LearnStore } = await import('../src/features/learn/store.js')
const { registerLearnTools } = await import('../src/features/learn/tools.js')
const { resolveConfig } = await import('../src/config.js')
const { createQQApi } = await import('../src/adapters/onebot/qq-api.js')
const { fakeClient, fakeOut, toolRecorder } = await import('./fakes/host.js')

function storeIn(dir: string, slang = true) {
  const config = resolveConfig({
    selfId: 1, admins: [280], primaryGroup: 107,
    learn: { enabled: true, slang, file: path.join(dir, 'learned.json'), autoCapture: true, minOccurrences: 3 },
  })
  return { config, store: new LearnStore(config.learn, { workspacePath: dir, dshHome: dir, log: () => {} }) }
}

test('黑话：rememberWord 存词条+释义，top 不再混入，slang 能查到', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'slang-'))
  try {
    const { store } = storeIn(dir)
    await store.remember('真的会谢', 107)
    const word = await store.rememberWord('蒸馍', '“怎么”的谐音，群里用来调侃', 107)
    assert.equal(word.kind, 'slang')
    assert.equal(word.meaning, '“怎么”的谐音，群里用来调侃')
    assert.deepEqual(store.top(20, 107).map((p) => p.text), ['真的会谢'], '口癖列表不混入黑话')
    assert.deepEqual(store.slang(20, 107).map((p) => p.text), ['蒸馍'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('黑话：释义为空 → 报错；落盘后能读回', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'slang-'))
  try {
    const { config, store } = storeIn(dir)
    await assert.rejects(() => store.rememberWord('蒸馍', '  ', 107), /释义/)
    await store.rememberWord('蒸馍', '怎么的谐音', 107)
    await store.flush()
    const again = new LearnStore(config.learn, { workspacePath: dir, dshHome: dir, log: () => {} })
    await again.load()
    assert.equal(again.slang(10, 107)[0]?.meaning, '怎么的谐音')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('黑话工具：开关关着只有 4 个；打开后多两个且能记/查', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'slang-'))
  try {
    const off = storeIn(dir, false)
    const offCtx = toolRecorder()
    const offApi = createQQApi(fakeClient() as never)
    registerLearnTools(offCtx.ctx, off.config, offApi, fakeOut() as never, () => {}, off.store)
    assert.equal(offCtx.definitions.length, 4)
    assert.equal(offCtx.definitions.some((d) => d.name === 'qq_learn_word'), false)

    const on = storeIn(dir, true)
    const ctx = toolRecorder()
    registerLearnTools(ctx.ctx, on.config, createQQApi(fakeClient() as never), fakeOut() as never, () => {}, on.store)
    assert.equal(ctx.definitions.length, 6)
    const learn = ctx.definitions.find((d) => d.name === 'qq_learn_word')!
    const list = ctx.definitions.find((d) => d.name === 'qq_slang')!
    await (learn.execute as (a: unknown) => Promise<unknown>)({ text: '蒸馍', meaning: '怎么的谐音' })
    const result = await (list.execute as (a: unknown) => Promise<unknown>)({})
    assert.equal((result as { count: number }).count, 1)
    assert.equal((result as { words: Array<{ meaning: string }> }).words[0]!.meaning, '怎么的谐音')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
