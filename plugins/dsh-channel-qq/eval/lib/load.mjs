/**
 * 用例与转录的加载、校验与"离线检查"装配。
 *
 * 用例（eval/redteam、eval/scenarios、eval/persona 下的 JSON）与转录
 * （eval/transcripts/*.json）最终都归约为同一件事：**一条会话 × 一组规则**。
 * 本文件负责读出它们、把"应该出现的回复 / 反面例子"装配成可判定的会话，
 * 把格式错误在加载期就变成带文件名的清晰报错（而不是判定期一团乱）。
 *
 * 用例文件允许两种形态：单个用例对象，或 `{ "cases": [ ... ] }`（人格 30 条
 * 按类目分组存放，一个文件三条左右）。
 */

import { readdir, readFile } from 'node:fs/promises'
import * as path from 'node:path'

/** 读一个 JSON 文件；解析失败时报出文件名与原因。 */
export async function readJsonFile(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    throw new Error(`读不到文件 ${file}：${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`JSON 解析失败 ${file}：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 从一份 JSON 里取出用例列表（单对象或 { cases: [...] }）。 */
export function casesInFile(raw, file) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.cases) ? raw.cases : [raw]
  for (const c of list) {
    if (typeof c?.id !== 'string' || c.id === '') {
      throw new Error(`用例缺 id：${file}`)
    }
  }
  return list
}

/** 加载一个套件目录下的全部用例（按文件名排序，保证报告顺序稳定）。 */
export async function loadCaseSuite(dir) {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()
  const cases = []
  for (const name of names) {
    const file = path.join(dir, name)
    const raw = await readJsonFile(file)
    for (const c of casesInFile(raw, file)) cases.push({ ...c, _file: file })
  }
  return cases
}

/**
 * 消息归一化：`{ role?, speaker?, text, actions? }`。
 * role 缺省按 `user` 处理——用例的 `messages` 是**输入面**，默认是别人说的话；
 * 转录与样例里的 assistant 回复必须显式写 `"role": "assistant"`。
 */
export function normalizeMessages(messages, where) {
  if (!Array.isArray(messages)) throw new Error(`${where}：messages 必须是数组`)
  return messages.map((m, i) => {
    if (typeof m?.text !== 'string') throw new Error(`${where}：messages[${i}] 缺 text`)
    return {
      role: m.role === 'assistant' ? 'assistant' : 'user',
      speaker: typeof m.speaker === 'string' ? m.speaker : '',
      text: m.text,
      actions: Array.isArray(m.actions) ? m.actions : [],
    }
  })
}

/** 反面例子允许写成字符串或 `{ text, why, actions }`，统一成对象。 */
function asExample(e, where) {
  if (typeof e === 'string') return { text: e, why: '', actions: [] }
  if (typeof e?.text !== 'string') throw new Error(`${where}：例子缺 text`)
  return { text: e.text, why: typeof e.why === 'string' ? e.why : '', actions: Array.isArray(e.actions) ? e.actions : [] }
}

/**
 * 用例 → 离线检查。
 *
 * - `goods`：把 goodExamples 作为 assistant 回复接在 messages 之后，**必须全过**；
 * - `bads`：把 counterExamples 接在 messages 之后，**必须至少被一条规则抓住**。
 *
 * 两者都为空 → 这条用例今天只能 SKIP（需要活体 agent 或用 --session 喂真实会话）。
 */
export function caseChecks(c) {
  const where = `用例 ${c.id}`
  const base = normalizeMessages(c.messages ?? [], where)
  const goods = (c.goodExamples ?? []).map((e, i) => {
    const ex = asExample(e, `${where} goodExamples[${i}]`)
    return {
      label: `好例 ${i + 1}`,
      note: ex.why,
      messages: [...base, { role: 'assistant', speaker: '诺诺', text: ex.text, actions: ex.actions }],
    }
  })
  const bads = (c.counterExamples ?? []).map((e, i) => {
    const ex = asExample(e, `${where} counterExamples[${i}]`)
    return {
      label: `反例 ${i + 1}`,
      note: ex.why,
      messages: [...base, { role: 'assistant', speaker: '诺诺', text: ex.text, actions: ex.actions }],
    }
  })
  return { goods, bads }
}

/** 加载一条转录文件（格式见 eval/transcripts/README 说明与 README.md）。 */
export async function loadTranscript(file) {
  const raw = await readJsonFile(file)
  const where = `转录 ${file}`
  if (typeof raw?.id !== 'string' || raw.id === '') throw new Error(`${where}：缺 id`)
  if (typeof raw.case !== 'string' && !Array.isArray(raw.rules)) {
    throw new Error(`${where}：必须给 case（引用用例）或规则数组 rules 之一`)
  }
  return {
    ...raw,
    _file: file,
    messages: normalizeMessages(raw.messages ?? [], where),
  }
}

/**
 * 转录 → 判定用会话。
 *
 * - 主会话 = messages 原样（里面已经混着"应该出现的回复"）；
 * - 每条反面例子会**替换**指定的 assistant 消息（缺省最后一条），替换后必须
 *   至少被一条规则抓住。`of` 是 messages 的下标，指向要替换的 assistant 消息。
 */
export function transcriptParts(t) {
  const where = `转录 ${t.id}`
  const assistantIdx = []
  t.messages.forEach((m, i) => { if (m.role === 'assistant') assistantIdx.push(i) })
  const counters = (t.counterExamples ?? []).map((e, i) => {
    const ex = asExample(e, `${where} counterExamples[${i}]`)
    const declaredOf = e !== null && typeof e === 'object' ? e.of : undefined
    const target = declaredOf ?? assistantIdx[assistantIdx.length - 1]
    if (target === undefined || t.messages[target]?.role !== 'assistant') {
      throw new Error(`${where} counterExamples[${i}]：of=${String(target)} 不是一条 assistant 消息`)
    }
    return {
      label: `反例 ${i + 1}`,
      note: ex.why,
      messages: t.messages.map((m, j) => (j === target ? { role: 'assistant', speaker: '诺诺', text: ex.text, actions: ex.actions } : m)),
    }
  })
  return { main: t.messages, counters }
}

/** 转录规则来源：引用用例时 = 用例规则 + 转录 extraRules；自述规则时 = rules + extraRules。 */
export function transcriptRuleSources(t, caseLookup) {
  const extra = Array.isArray(t.extraRules) ? t.extraRules : []
  if (typeof t.case === 'string') {
    const found = caseLookup.get(t.case)
    if (found === undefined) return null
    return { suite: found.suite, case: found.case, extraRules: extra }
  }
  return { suite: 'transcripts', case: { id: t.id, rules: Array.isArray(t.rules) ? t.rules : [] }, extraRules: extra }
}
