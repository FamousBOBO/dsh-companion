/**
 * 从 models.dev 生成内置模型目录（`assets/model-context.json`）。
 *
 *   node scripts/update-model-catalog.mjs           # 生成
 *   node scripts/update-model-catalog.mjs --check   # 只校验文件是否最新（CI 用）
 *
 * 为什么内置一份：后台「模型供应商」页要在**不联网**的情况下给出上下文长度，
 * 而且网关的 `/v1/models` 通常只给 id、不给窗口。models.dev 是社区维护的
 * 权威数据（GitHub: sst/models.dev），比凭记忆填的数字可靠。
 *
 * 只收常见对话模型：DeepSeek / GLM / Qwen / Kimi / GPT / Claude / Gemini。
 * 生成物是纯 JSON 资产，运行时由供应商页做前缀匹配。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outFile = path.join(root, 'assets', 'model-context.json')
const check = process.argv.includes('--check')
const SOURCE = 'https://models.dev/api.json'

/** 只收这些家族（按模型 id 前缀判断），避免把几千个冷门模型塞进仓库。 */
const FAMILIES = [
  'deepseek', 'glm', 'qwen', 'kimi', 'moonshot', 'gpt-', 'o1', 'o3', 'o4',
  'claude', 'gemini', 'grok', 'mistral', 'llama',
]
/** 单个家族最多收多少条（去重后按上下文取大的）。 */
const MAX_PER_FAMILY = 40

const response = await fetch(SOURCE, { headers: { 'user-agent': 'dsh-channel-qq/model-catalog' } })
if (!response.ok) throw new Error(`models.dev 拉取失败 HTTP ${response.status}`)
const data = await response.json()

/** id 规范化：去掉供应商前缀、转小写。 */
function normalize(id) {
  return String(id).toLowerCase().replace(/^[^/]+\//, '')
}

const byId = new Map()
for (const [provider, info] of Object.entries(data)) {
  for (const [rawId, model] of Object.entries(info.models ?? {})) {
    const id = normalize(rawId)
    if (!FAMILIES.some((family) => id.startsWith(family))) continue
    const context = Number(model.limit?.context)
    const output = Number(model.limit?.output)
    if (!Number.isFinite(context) || context <= 0) continue
    const modalities = Array.isArray(model.modalities?.input) ? model.modalities.input : []
    const entry = {
      id,
      name: String(model.name ?? rawId),
      context: Math.trunc(context),
      ...Number.isFinite(output) && output > 0 ? { output: Math.trunc(output) } : {},
      ...modalities.includes('image') ? { image: true } : {},
      ...modalities.includes('pdf') ? { pdf: true } : {},
      provider,
    }
    // 同一个 id 在多个供应商里出现：上下文取更大的那条，能力取并集
    // （某些网关只挂纯文本变体，不能因此把模型本身的多模态抹掉）。
    const existing = byId.get(id)
    if (existing === undefined) { byId.set(id, entry); continue }
    const merged = { ...existing, ...entry.context > existing.context ? entry : existing }
    if (existing.image === true || entry.image === true) merged.image = true
    if (existing.pdf === true || entry.pdf === true) merged.pdf = true
    byId.set(id, merged)
  }
}

let entries = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
for (const family of FAMILIES) {
  const group = entries.filter((entry) => entry.id.startsWith(family))
  if (group.length <= MAX_PER_FAMILY) continue
  const keep = new Set(group.slice(-MAX_PER_FAMILY).map((entry) => entry.id))
  entries = entries.filter((entry) => !entry.id.startsWith(family) || keep.has(entry.id))
}

const payload = {
  source: SOURCE,
  generatedAt: new Date().toISOString().slice(0, 10),
  models: entries,
}
const text = `${JSON.stringify(payload, null, 2)}\n`

if (check) {
  let current = ''
  try { current = readFileSync(outFile, 'utf8') } catch { current = '' }
  const stable = (value) => value.replace(/"generatedAt": "[^"]*"/, '"generatedAt": "X"').trim()
  if (stable(current) !== stable(text)) {
    console.error('assets/model-context.json 与 models.dev 不一致——跑 node scripts/update-model-catalog.mjs')
    process.exit(1)
  }
  console.log(`model-catalog: 一致（${entries.length} 条）`)
} else {
  mkdirSync(path.dirname(outFile), { recursive: true })
  writeFileSync(outFile, text, 'utf8')
  console.log(`model-catalog: 已写入 ${entries.length} 条 → ${outFile}`)
}
