/**
 * 记忆评测的语料（P6e·e4；设计取向见 docs/memory.md）。
 *
 * 把**真实日记**切成记忆记录，供 `run.mjs` 跑 60 题基准。三件事值得说清楚：
 *
 *   1. **不调用模型**：这里不跑 e3 的抽取管线（那要抽取器 + 网络），而是把日记按
 *      段落直接切成记录。理由：这道基准考的是**检索**（recall@8 / 延迟 / 注入预算），
 *      不是抽取质量；抽取质量另有 `npm run eval` 的抽取用例与人工抽查。少一个变量，
 *      跑分才能在无网络的机器上复现。
 *   2. **语料不进 git**：日记里是真实聊天内容（`eval/memory/.cache/`，见 `.gitignore`）。
 *      仓库里只放题目与锚点。拉语料的办法见 README。
 *   3. **段落保留行号区间**：题目的 `evidence` 用「文件 + 行号」定位，命中判据是
 *      「检索出来的记录覆盖了那一行」。所以切段时**标题行并入紧随的段落**——
 *      出题时锚点通常就是标题行。
 *
 * 本文件 import 的是**编译产物**，不是源码：检索逻辑必须是系统里那一份，抄一份到
 * eval 就会与产品漂移。产物有两种落点——部署树里的 `lib/`，以及 `npm test` 编译
 * 出来的 `lib-test/src/`。这里按顺序找，找到哪个用哪个（干净检出没有 `lib/`，
 * 2026-10-18 CI 就是这么红的）。
 */

import { readdir, readFile } from 'node:fs/promises'
import * as path from 'node:path'

async function loadMemoryStore() {
  const candidates = [
    '../../build/lib/features/memory/store.js',
    '../../build/lib-test/src/features/memory/store.js',
  ]
  for (const candidate of candidates) {
    try {
      return await import(candidate)
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    }
  }
  throw new Error('找不到编译后的 MemoryStore：先跑 `npm run build`（或 `npm test` 会生成 lib-test）')
}

const { MemoryStore } = await loadMemoryStore()

/** 段落的长度门限：太短的段（碎句、表格残片）不值得当一条记忆。 */
export const MIN_SEGMENT_CHARS = 40
/** 单条记忆的长度上限（与 `core/memory/model.ts` 的 MAX_CONTENT_CHARS 同量级）。 */
export const MAX_SEGMENT_CHARS = 400

/**
 * @typedef {{ file: string, start: number, end: number }} SegmentSpan
 * 一段正文在原文里的位置（供命中判定）；行号 1 起、闭区间。
 */

/**
 * 把一份日记切成**句子级**的片段（纯函数，可单测）。
 *
 * 为什么是句子而不是段落：真实系统里的记录来自抽取器，形态是"一句话事实"
 * （`core/memory/model.ts` 的 `MAX_CONTENT_CHARS = 200`）。用 400 字的段落当记录
 * 会把相关性稀释掉——查询里十来个二元组，一段几百字的话只命中一两个，
 * `keywordRelevance` 直接掉到 0.05，排序于是被重要性与新近度接管。实测过：
 * 段落粒度下 recall@8 = 0.02，句子粒度才反映真实检索能力。
 *
 * 规则：
 *   - `##` 标题行**保留**（它常常就是结论本身，比如「10:10 学弟答复了：…」）；
 *   - 按 `。！？；` 与换行断句，太短的相邻句合并到 `MIN_SEGMENT_CHARS`；
 *   - 代码围栏与表格行跳过（那是证据不是记忆）；
 *   - 引用行（`> `）去掉前缀保留正文。
 */
export function splitDiary(text, file) {
  const lines = text.split('\n')
  const out = []
  let fence = false
  let pending = null

  const flush = () => {
    if (pending === null) return
    const content = clean(pending.text)
    if (content.length >= MIN_SEGMENT_CHARS) {
      out.push({ content: content.slice(0, MAX_SEGMENT_CHARS), span: { file, start: pending.line, end: pending.end } })
    }
    pending = null
  }

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? ''
    const at = i + 1
    if (raw.trimStart().startsWith('```')) {
      fence = !fence
      continue
    }
    if (fence) continue
    if (raw.trimStart().startsWith('|')) continue
    // 一级标题（`# 2026-10-16`）是文档名，不是记忆。
    if (raw.startsWith('# ')) continue
    const line = raw.startsWith('## ') ? raw.slice(3) : raw
    for (const piece of splitSentences(line)) {
      const pieceText = piece.trim()
      if (pieceText === '') continue
      if (pending === null) {
        pending = { text: pieceText, line: at, end: at }
        continue
      }
      if (pending.text.length >= MIN_SEGMENT_CHARS) {
        flush()
        pending = { text: pieceText, line: at, end: at }
        continue
      }
      pending.text = `${pending.text} ${pieceText}`
      pending.end = at
    }
    // 一行结束：够长的当场收尾，短的留到下一行继续攒。
    if (pending !== null && pending.text.length >= MIN_SEGMENT_CHARS) flush()
  }
  flush()
  return out
}

/** 按中文句读断句（保留标点）。 */
function splitSentences(line) {
  return line.split(/(?<=[。！？；!?;])/).filter((s) => s.trim() !== '')
}

/** 轻度清理：去引用前缀与粗体标记，压缩空白（检索用的是二元组，标记只会添噪）。 */
function clean(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/^>\s?/, '').replace(/\*\*/g, ''))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/**
 * 从语料目录建库。
 *
 * @param opts.dir 语料目录（里面是 `YYYY-MM-DD.md`；服务器上是工作区的 `memory/`）
 * @param opts.workDir 记录落盘目录（临时目录即可；跑分不关心记录文件）
 */
export async function buildCorpus(opts) {
  const log = opts.log ?? (() => {})
  const store = new MemoryStore({ workspacePath: opts.workDir, dshHome: opts.workDir, log })
  await store.load()
  const names = (await readdir(opts.dir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort()
  const spans = new Map()
  let segments = 0
  let clock = Date.parse('2026-10-14T00:00:00+08:00')
  for (const name of names) {
    const text = await readFile(path.join(opts.dir, name), 'utf-8')
    for (const { content, span } of splitDiary(text, name)) {
      segments += 1
      // 记录时间线按语料文件顺序推进：`recordedAt` 影响检索的新近度项，
      // 用"读到的顺序"代替真实写入时刻（评测关心排序稳定性，不关心绝对值）。
      clock += 60_000
      const record = await store.remember({
        kind: 'event',
        subject: { type: 'self' },
        content,
        source: { kind: 'diary', file: span.file, line: span.start },
        importance: 5,
      }, clock, () => 0.5)
      spans.set(record.id, span)
    }
    log(`corpus: ${name} → ${segments} 段累计`)
  }
  return { store, spans, files: names.length, segments }
}
