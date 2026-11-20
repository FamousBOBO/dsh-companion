/** 渲染器与参考实现的**逐 token 一致性**（金样由 Python 侧产出）。
 *
 * 为什么这条测试值得单独存在：打分器只读指定槽位上的 `yes` / `no` logit。
 * 槽位偏一个 token，概率就整份作废——而且**不会报错**，只会给出看起来合理的错答案。
 * 所以这里不是"大致对一下"，是逐 id 比对整条序列 + 逐槽比对位置。
 *
 * 金样怎么来：`tools/gen-render-golden.py` 用 `jev_style_decision_gguf.py` 的 `Renderer`
 * 跑同一批夹具，把 `ids` / `prefix_len` / `slots` / `head_tokens` 全写下来。
 * 改渲染器（哪怕只加一个空格）都必须先重跑那个脚本，再让它红给你看。
 *
 * 权重与显卡都不需要：这条测试只跑分词，不跑模型。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { Tokenizer } from '@huggingface/tokenizers'
import { createRenderer, optionNames, readoutOf, renderOptions, type RenderQuestion } from '../src/adapters/jev/render-v1.js'

interface GoldenCase {
  readonly name: string
  readonly state: string
  readonly question: RenderQuestion
  readonly ids: readonly number[]
  readonly prefix_len: number
  readonly slots: readonly number[]
  readonly names: readonly string[]
  readonly head_tokens: number
}

interface Golden {
  readonly tokens: {
    readonly yes: readonly number[]
    readonly no: readonly number[]
    readonly arrow: readonly number[]
    readonly newline: readonly number[]
    readonly dash: readonly number[]
  }
  readonly cases: readonly GoldenCase[]
}

/**
 * 金样按**源码树**的位置读，不按构建产物的位置读。
 *
 * `golden.ts` 用的是 `process.cwd()`（`npm test` 从仓库根跑），但那个工具只处理 `.txt`。
 * 这里要读 `.json`，所以自己拼路径：`build/lib-test/test/…` 里没有 `golden/`，
 * 快照永远是源码树里的那一份（和 `test/golden.ts` 的口径一致）。
 */
const golden = JSON.parse(
  readFileSync(path.join(process.cwd(), 'test', 'golden', 'jev', 'render-v1.json'), 'utf8'),
) as Golden

/**
 * 分词器由**测试自己**装配（`tokenizer.json` 与 `tokenizer_config.json` 都要）。
 *
 * 路径来自环境变量 `JEV_TOKENIZER_DIR`：这两个文件是模型发布物（约 12 MB），
 * 不进仓库。没设就跳过整组用例——**跳过要说清楚**，不能悄悄返回"通过"。
 */
const TOKENIZER_DIR = process.env['JEV_TOKENIZER_DIR'] ?? ''

function tokenizerOrNull(): Tokenizer | null {
  if (TOKENIZER_DIR === '') return null
  try {
    return new Tokenizer(
      JSON.parse(readFileSync(`${TOKENIZER_DIR}\\tokenizer.json`, 'utf8')),
      JSON.parse(readFileSync(`${TOKENIZER_DIR}\\tokenizer_config.json`, 'utf8')),
    )
  } catch {
    return null
  }
}

const tokenizer = tokenizerOrNull()
const readout = { yes: golden.tokens.yes[0] ?? 9542, no: golden.tokens.no[0] ?? 874, arrow: golden.tokens.arrow[0] ?? 1411 }

test('渲染器金样：逐 token 与参考实现一致', { skip: tokenizer === null ? 'JEV_TOKENIZER_DIR 未设置（或文件缺失）' : false }, () => {
  if (tokenizer === null) return
  const renderer = createRenderer(tokenizer, readout)
  assert.deepEqual(renderer.rows, [readout.yes, readout.no])
  for (const item of golden.cases) {
    const rendered = renderer.render(item.state, item.question)
    assert.deepEqual(rendered.ids, item.ids, `${item.name}: ids 不一致`)
    assert.equal(rendered.prefixLen, item.prefix_len, `${item.name}: prefix_len 不一致`)
    assert.deepEqual(rendered.slots, item.slots, `${item.name}: slots 不一致`)
    assert.deepEqual(rendered.names, item.names, `${item.name}: names 不一致`)
    assert.equal(rendered.headTokens, item.head_tokens, `${item.name}: head_tokens 不一致`)
  }
})

test('常量 token：yes / no / -> / 换行 / 破折号 与金样一致', { skip: tokenizer === null ? 'JEV_TOKENIZER_DIR 未设置（或文件缺失）' : false }, () => {
  if (tokenizer === null) return
  const enc = (text: string): number[] =>
    tokenizer.encode(text, { add_special_tokens: false }).ids.map((id: number) => Number(id))
  assert.deepEqual(enc(' yes'), golden.tokens.yes)
  assert.deepEqual(enc(' no'), golden.tokens.no)
  assert.deepEqual(enc(' ->'), golden.tokens.arrow)
  assert.deepEqual(enc('\n'), golden.tokens.newline)
  assert.deepEqual(enc('- '), golden.tokens.dash)
})

test('readout_config 的槽位 token 与分词器自洽（不自洽就直接抛）', { skip: tokenizer === null ? 'JEV_TOKENIZER_DIR 未设置（或文件缺失）' : false }, () => {
  if (tokenizer === null) return
  const good = createRenderer(tokenizer, readout)
  good.verify()
  // 换一个错的 id：`verify()` 必须在构造期就拦住，而不是等到群里发出错话。
  const bad = createRenderer(tokenizer, { ...readout, yes: 1 })
  assert.throws(() => bad.verify(), /不自洽/)
})

test('预算超限报错而不是截断', { skip: tokenizer === null ? 'JEV_TOKENIZER_DIR 未设置（或文件缺失）' : false }, () => {
  if (tokenizer === null) return
  const renderer = createRenderer(tokenizer, readout)
  assert.throws(() => renderer.render('状态很短。', { t: 'noul', ins: '问题', crit: null }, { headMax: 4 }),
    /head budget/)
  assert.throws(() => renderer.render('状态很短。', { t: 'noul', ins: '问题', crit: null }, { maxLen: 8 }),
    /the limit is/)
})

test('问句形状校验与参考实现同口径', () => {
  // `optionNames` / `renderOptions` 是纯函数，不需要分词器，所以这组用例在没设路径时也跑。
  assert.throws(() => optionNames({ t: 'noul', ins: '   ', crit: null }), /non-empty string/)
  assert.throws(() => optionNames({ t: 'choice', ins: '问题', crit: {} }), /at least one option/)
  assert.throws(() => optionNames({ t: 'choice', ins: '问题', crit: [] }), /non-empty dict/)
  assert.throws(() => optionNames({ t: 'score', ins: '问题', crit: ['只有一级'] }), /2..10/)
  assert.throws(() => optionNames({ t: 'noul', ins: '问题', crit: 'false' }), /null or {false/)
  assert.throws(() => optionNames({ t: 'nope', ins: '问题', crit: null }), /unknown question type/)
  assert.deepEqual(optionNames({ t: 'noul', ins: '问题', crit: null }), ['false', 'true'])
  assert.deepEqual(optionNames({ t: 'score', ins: '问题', crit: ['a', 'b', 'c'] }), ['0', '1', '2'])
  assert.deepEqual(
    renderOptions({ t: 'noul', ins: '问题', crit: null }),
    ['false: no, the statement does not hold', 'true: yes, the statement holds'],
  )
  assert.deepEqual(
    renderOptions({ t: 'choice', ins: '问题', crit: { a: null, b: '', c: '有描述' } }),
    ['a', 'b', 'c: 有描述'],
  )
})

test('readoutOf 从配置里读出三项（缺字段就抛）', () => {
  const config = { slot_tokens: { yes: { id: 9542 }, no: { id: 874 }, verdict_slot: { id: 1411 } } }
  assert.deepEqual(readoutOf(config), { yes: 9542, no: 874, arrow: 1411 })
  assert.throws(() => readoutOf({}), /缺 slot_tokens/)
  assert.throws(() => readoutOf({ slot_tokens: { yes: { id: 1 } } }), /缺 no/)
  assert.throws(() => readoutOf({ slot_tokens: { yes: { id: 'x' }, no: { id: 2 }, verdict_slot: { id: 3 } } }),
    /不是整数/)
})
