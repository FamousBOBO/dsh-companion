/** Stage-2 knowledge pipeline: auto-extract from diaries/group chats into
 * structured entries, keyword+weight retrieval, persists to workspace/knowledge/.
 * Extractor: any OpenAI-compatible chat-completions route (see
 * `resolveExtractorRoute`).
 * Retrieval: keyword overlap + recency + weight scoring (vector upgrade later).
 */

import * as path from 'node:path'
import { JsonStore } from './adapters/fs-store/json-store.js'
import { systemHttp } from './adapters/http/client.js'

export interface KnowledgeEntry {
  id: string
  type: 'skill' | 'fact' | 'preference' | 'event' | 'person'
  content: string
  tags: string[]
  source: string
  created: number
  weight: number
  hits: number
}

// P0（调研 20261024 §6）："一句话事实"是召回的地基——存进去的是日记原文句子，
// recall@8 只有 0.14；改成"主语+谓语+要点的短句"后，600 字注入预算才装得下证据。
// 入库后还有一道 distillFact 兜底（去口语壳、截 80 字），但模型直接产出短句省得多改一刀。
const EXTRACT_SYSTEM = `你是知识提取器。从聊天/日记片段中提取值得长期记住的知识条目，JSON 数组输出，每条：
{"type":"skill|fact|preference|event|person","content":"一句话知识","tags":["标签"],"source":"来源简述"}
content 的硬要求：一句话事实，主语+谓语+要点，≤60 字，不带语气词和口语壳（"我觉得/好像/其实"都去掉）。
好例："学弟不吃香菜，点菜要备注"；坏例："我觉得学弟好像说他不吃那个香菜的样子"。
只提取有长期价值的：技能、事实、偏好、重要事件、人物关系；同一件事只留一条最完整的。
日常寒暄不要。只输出 JSON。`

export class KnowledgeStore {
  readonly file: string
  private readonly store: JsonStore<unknown>
  entries: KnowledgeEntry[] = []

  constructor(dshHome: string, private readonly workspace: string | null, private readonly log: (line: string) => void) {
    this.file = path.join(workspace ?? path.join(dshHome, 'channel-qq'), 'knowledge', 'entries.json')
    this.store = new JsonStore<unknown>(this.file, { log })
  }

  async load(): Promise<void> {
    const raw = await this.store.load(null)
    // 历史文件是裸数组；形状不对当空库（和旧行为一致，不因此重建文件）。
    this.entries = Array.isArray(raw) ? (raw as KnowledgeEntry[]) : []
    // 文件不存在/读不出来才补一份空库出来，下次启动就不算"缺文件"。
    if (raw === null) await this.save()
  }

  async save(): Promise<void> {
    await this.store.save(this.entries)
  }

  async addMany(items: Array<Omit<KnowledgeEntry, 'id' | 'created' | 'weight' | 'hits'>>): Promise<number> {
    let added = 0
    for (const item of items) {
      const content = String(item.content ?? '').trim()
      if (content.length < 4) continue
      if (this.entries.some(e => e.content === content)) continue // dedup
      this.entries.push({
        id: `k_${Date.now()}_${this.entries.length}`,
        type: (item.type as KnowledgeEntry['type']) || 'fact',
        content,
        tags: Array.isArray(item.tags) ? item.tags : [],
        source: String(item.source ?? ''),
        created: Date.now(),
        weight: 1,
        hits: 0,
      })
      added++
    }
    if (added > 0) await this.save()
    return added
  }

  /** Keyword-overlap retrieval with weight & recency boost. */
  search(query: string, top = 5): KnowledgeEntry[] {
    const tokens = query.split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 2)
    const scored = this.entries.map(e => {
      let score = e.weight
      for (const t of tokens) {
        if (e.content.includes(t)) score += 2
        if (e.tags.some(tag => tag.includes(t))) score += 1
      }
      const ageDays = (Date.now() - e.created) / 86400_000
      score += Math.max(0, 1 - ageDays / 30) // recency boost, decays over a month
      return { e, score }
    })
    return scored
      .filter(s => s.score > 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, top)
      .map(s => s.e)
  }

  /** Called when a retrieved entry proved useful (reinforcement loop). */
  async reinforce(id: string): Promise<void> {
    const e = this.entries.find(x => x.id === id)
    if (e) { e.weight += 0.1; e.hits++; await this.save() }
  }

  /** Drop one entry by id (admin panel deletion). */
  async remove(id: string): Promise<boolean> {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.id !== id)
    if (this.entries.length === before) return false
    await this.save()
    return true
  }

  /** Manual insert (admin panel / model-directed memorize). */
  async addManual(input: { type?: string; content: string; tags?: string[]; source?: string }): Promise<number> {
    return this.addMany([{
      type: (input.type ?? 'fact') as KnowledgeEntry['type'],
      content: String(input.content ?? ''),
      tags: Array.isArray(input.tags) ? input.tags.map((t) => String(t)) : [],
      source: String(input.source ?? 'admin'),
    }])
  }
}

/** An OpenAI-compatible chat-completions route for the extractor. */
export interface ExtractorRoute {
  /** Base URL *without* the trailing `/chat/completions`. */
  baseUrl: string
  apiKey: string
  model: string
}

/**
 * Where the extractor sends its requests.
 *
 * This used to be hardcoded to `https://api.taotoken.net/coding/v1/...` with
 * model `glm-5.3-flash` and `TAOTOKEN_API_KEY`, i.e. one particular host's
 * private infrastructure. On any other deployment that is either a loud failure
 * (`extractor HTTP 400`, observed here) or an outbound call to a third party
 * nobody agreed to. The route is environment configuration now, and an
 * unconfigured deployment skips extraction with a log line rather than failing
 * once a day forever.
 *
 * `CHANNEL_QQ_EXTRACTOR_API_KEY` falls back to `DSH_LLM_API_KEY`, which is the
 * key the harness itself already holds — so reusing the same gateway needs one
 * variable (the model), not two.
 */
/** 配置层（后台「记忆」页）覆盖：非空的项优先于环境变量，空串继续回退。 */
export interface ExtractorRouteOverride {
  readonly baseUrl?: string
  readonly model?: string
  readonly apiKey?: string
}

export function resolveExtractorRoute(
  override: ExtractorRouteOverride = {},
  env: NodeJS.ProcessEnv = process.env,
): ExtractorRoute | null {
  const pick = (value: string | undefined, fallback: string | undefined): string => (value ?? '').trim() || (fallback ?? '').trim()
  const baseUrl = pick(override.baseUrl, env.CHANNEL_QQ_EXTRACTOR_BASE_URL)
  const model = pick(override.model, env.CHANNEL_QQ_EXTRACTOR_MODEL)
  if (baseUrl === '' || model === '') return null
  const apiKey = pick(override.apiKey, env.CHANNEL_QQ_EXTRACTOR_API_KEY ?? env.DSH_LLM_API_KEY)
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model }
}

/**
 * Per-request input ceiling.
 *
 * Measured against this deployment's gateway (cline-pass, model
 * deepseek-v4.1-flash) on 2026-10-15, using the extractor's own prompt:
 *
 *   input  1200 chars -> 200 OK, 10 entries,  9.6s
 *   input  2000 chars -> 200 OK,  0 entries, 14.9s
 *   input  3000 chars -> 502 `empty response content` (upstream_error), 15.6s
 *   input  4000 chars -> 502, 16.4s
 *   input 12000 chars -> 502 — what this module used to send, so extraction had
 *                       never once succeeded here
 *
 * The real limit is *time*, not size: generation wall-time grows with the input,
 * the upstream gives up around 15s, and the gateway turns the resulting empty
 * completion into a 502. 1500 sits inside the measured-safe band with headroom.
 */
export const EXTRACT_CHUNK_CHARS = 1500

/** Chunks per run — bounds what one long diary can cost. */
export const EXTRACT_MAX_CHUNKS = 12

/** Below this a halving retry is pointless: the gateway is failing for another reason. */
const EXTRACT_MIN_RETRY_CHARS = 400
const EXTRACT_MAX_TOKENS = 2000

/** Split text into pieces of at most `size` chars, preferring newline boundaries. */
function splitChunks(text: string, size: number, max: number): string[] {
  const out: string[] = []
  let current = ''
  const hardSplit = new RegExp(`[\\s\\S]{1,${size}}`, 'g')
  for (const line of text.split('\n')) {
    for (const piece of line.length <= size ? [line] : (line.match(hardSplit) ?? [])) {
      if (current !== '' && current.length + piece.length + 1 > size) {
        out.push(current)
        current = ''
        if (out.length >= max) return out
      }
      current = current === '' ? piece : `${current}\n${piece}`
    }
  }
  if (current !== '' && out.length < max) out.push(current)
  return out
}

/**
 * One extraction request. Throws on a non-2xx, and the message carries the
 * gateway's own error text — "extractor HTTP 502" alone said nothing about the
 * empty completion that caused it.
 */
async function extractChunk(
  route: ExtractorRoute,
  source: string,
  text: string,
  log: (line: string) => void,
): Promise<Array<Omit<KnowledgeEntry, 'id' | 'created' | 'weight' | 'hits'>>> {
  const body = JSON.stringify({
    model: route.model,
    max_tokens: EXTRACT_MAX_TOKENS,
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: `来源：${source}\n内容：\n${text}` },
    ],
  })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (route.apiKey !== '') headers.Authorization = `Bearer ${route.apiKey}`
  // `route.baseUrl` 是运维配的提取器端点（可以是本机的 OpenAI 兼容服务）。
  const res = await systemHttp.request(`${route.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body,
    timeoutMs: 180_000,
    limit: 1024 * 1024,
    allowPrivateHosts: true,
  })
  if (!res.ok) {
    const detail = res.text().replace(/\s+/g, ' ').trim().slice(0, 160)
    throw new Error(`extractor HTTP ${res.status}${detail === '' ? '' : ` — ${detail}`}`)
  }
  const d = res.json<{ choices?: Array<{ message?: { content?: string } }> }>()
  const raw = (d.choices?.[0]?.message?.content ?? '').trim()
  const m = raw.match(/\[[\s\S]*\]/)
  if (!m) return []
  try {
    const arr = JSON.parse(m[0]) as Array<Record<string, unknown>>
    return arr.map(x => ({
      type: (String(x.type || 'fact')) as 'fact',
      content: String(x.content ?? ''),
      tags: Array.isArray(x.tags) ? x.tags.map(String) : [],
      source,
    })).filter(x => x.content.length >= 4)
  } catch {
    log(`extractor JSON parse failed for ${source}`)
    return []
  }
}

/**
 * Extract knowledge entries from a diary/group-chat text via the configured route.
 *
 * The text is chunked rather than clipped: a 45 KB diary clipped to 12 KB both
 * lost most of the day *and* tripped the gateway's timeout on every attempt. A
 * chunk that still fails is retried once at half size before being written off,
 * and one dead chunk no longer costs the whole run.
 */
export async function extractFromText(
  route: ExtractorRoute,
  source: string,
  text: string,
  log: (line: string) => void,
): Promise<Array<Omit<KnowledgeEntry, 'id' | 'created' | 'weight' | 'hits'>>> {
  const chunks = splitChunks(text, EXTRACT_CHUNK_CHARS, EXTRACT_MAX_CHUNKS)
  if (chunks.length === 0) return []
  const truncated = chunks.length >= EXTRACT_MAX_CHUNKS
  const out: Array<Omit<KnowledgeEntry, 'id' | 'created' | 'weight' | 'hits'>> = []
  let failed = 0
  for (let i = 0; i < chunks.length; i++) {
    const label = `${source} 第${i + 1}/${chunks.length}段`
    try {
      out.push(...await extractChunk(route, label, chunks[i]!, log))
      continue
    } catch (error) {
      const half = chunks[i]!.slice(0, Math.floor(chunks[i]!.length / 2))
      if (half.length >= EXTRACT_MIN_RETRY_CHARS) {
        try {
          out.push(...await extractChunk(route, `${label} 半段重试`, half, log))
          continue
        } catch { /* fall through to the failure log */ }
      }
      failed += 1
      log(`extractor chunk ${i + 1}/${chunks.length} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failed > 0) log(`extractor: ${failed}/${chunks.length} chunk(s) failed for ${source}`)
  if (truncated) log(`extractor: input capped at ${EXTRACT_MAX_CHUNKS} chunks for ${source}`)
  return out
}
