#!/usr/bin/env node
/**
 * 记忆 60 题基准（P6e·e4；设计取向见 docs/memory.md）。
 *
 *   node eval/memory/run.mjs                    # 跑基准（语料默认取 eval/memory/.cache/memory）
 *   node eval/memory/run.mjs --corpus <目录>    # 指向别的语料（服务器上是工作区 memory/）
 *   node eval/memory/run.mjs --k 5              # 改召回口径（默认 8）
 *   node eval/memory/run.mjs --enforce          # 把 09 §9.2 的门槛当 FAIL（退出码 1）
 *   node eval/memory/run.mjs --json             # 机读输出
 *
 * **默认不 enforce**：第一次跑出来的一定是基线，门槛达标与否要看数字而不是让
 * `npm run eval` 变红。要看是否达标就加 `--enforce`。
 *
 * 它测的是**检索**（recall@8 / 延迟 / 注入预算），不测抽取质量（那要模型；见
 * corpus.mjs 的注记）。端到端准确率与幻觉率需要 LLM 裁判，未配置时报告里标 SKIP
 * ——**不假装测过**。
 */

import { parseArgs } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildCorpus } from './corpus.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
/** 编译产物的两种落点：build/lib（新布局）与 lib（旧布局）。 */
async function loadCore(rel) {
  for (const base of ['../../build/lib', '../../lib']) {
    try {
      return await import(`${base}/${rel}`)
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    }
  }
  throw new Error(`找不到编译产物 ${rel}：先跑 npm run build`)
}

const { keywordRelevance, queryTerms, rankCandidates } = await loadCore('core/memory/score.js')
const { selectForInjection } = await loadCore('core/memory/select.js')

/** 09 §9.2 的门槛。 */
export const THRESHOLDS = {
  recallAtK: 0.85,
  accuracy: 0.80,
  hallucination: 0.05,
  p95Ms: 300,
  injectChars: 600,
  activeRecords: 20_000,
}

/** 评测的"现在"：取语料最后一天之后，保证新近度项对所有记录都是过去。 */
/** 评测只看相关性：语料里的 importance/recency 是切分时合成的。 */
const REL_ONLY = { relevance: 1, importance: 0, recency: 0 }

const NOW = Date.parse('2026-10-18T00:00:00+08:00')

function parseCli() {
  const { values } = parseArgs({
    options: {
      corpus: { type: 'string' },
      k: { type: 'string' },
      threshold: { type: 'string' },
      enforce: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      /** 本机 embed 服务地址（如 http://127.0.0.1:8801/v1）；给了就跑向量+关键词混合。 */
      vectors: { type: 'string' },
      /** 用"原文分块"当语料（600 字块），而不是句子级记录。 */
      chunks: { type: 'boolean', default: false },
    },
  })
  return {
    corpus: values.corpus ?? path.join(HERE, '.cache', 'memory'),
    k: Number(values.k ?? 8),
    threshold: Number(values.threshold ?? 0.35),
    enforce: values.enforce === true,
    json: values.json === true,
    vectors: values.vectors ?? null,
    chunks: values.chunks === true,
  }
}

/** 命中：检索出来的记录里，有一条的原文区间覆盖了题目的锚点。 */
function hitsEvidence(span, evidence) {
  if (span === undefined || evidence === null) return false
  return span.file === evidence.file && evidence.line >= span.start && evidence.line <= span.end
}

/** 跑一题，返回它的检索结果与耗时（毫秒）。`retriever` 非空时走向量+关键词混合。 */
async function retrieveOne(store, spans, question, opts) {
  const started = process.hrtime.bigint()
  let picked
  if (opts.retriever !== null && opts.retriever !== undefined) {
    const got = await opts.retriever.retrieve({
      text: question,
      room: '',
      now: NOW,
      // 语料记录全是同一个 subject+kind，默认的"同主题最多 2 条"会把候选压到 2 条
      // ——那测的是多样性策略，不是检索能力。基准里放开它。
      budget: { threshold: opts.threshold, maxRecords: opts.k, maxChars: THRESHOLDS.injectChars, maxPerTopic: opts.k },
      // 只看相关性：语料里的 importance/recency 是切分时合成的，不参与判断检索能力。
      weights: REL_ONLY,
    })
    picked = got.picked.map((record) => ({ record }))
  } else {
    const terms = store.keepKnown(queryTerms(question))
    const candidates = store
      .candidatesByTerms(terms)
      .filter((r) => r.status === 'active')
      .map((record) => ({ record, relevance: keywordRelevance(terms, record, (t) => store.idfOf(t)) }))
    const ranked = rankCandidates(candidates, NOW, REL_ONLY)
    picked = selectForInjection(ranked, {
      threshold: opts.threshold,
      maxRecords: opts.k,
      maxChars: THRESHOLDS.injectChars,
      maxPerTopic: opts.k,
    })
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  return { picked, ms, spans }
}

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}

async function main() {
  const cli = parseCli()
  let questions
  try {
    questions = JSON.parse(await readFile(path.join(HERE, 'questions.json'), 'utf-8'))
  } catch (error) {
    console.error(`读不到题目：${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
  const workDir = await mkdtemp(path.join(tmpdir(), 'qq-mem-eval-'))
  try {
    let corpus
    if (cli.chunks) {
      const { MemoryStore } = await loadCore('features/memory/store.js')
      const { indexWorkspaceChunks } = await loadCore('features/memory/chunks.js')
      const store = new MemoryStore({ workspacePath: cli.corpus, dshHome: workDir, log: () => {} })
      await store.load()
      let n = 0
      const built = await indexWorkspaceChunks(store, {
        workspace: cli.corpus, now: NOW, roll: () => ((n++ % 997) / 997), log: (m) => console.error(m),
      })
      const spans = new Map()
      for (const record of store.all()) {
        const file = record.source.file
        if (typeof file !== 'string' || typeof record.source.line !== 'number') continue
        const lines = record.content.split('\n').length
        spans.set(record.id, { file, start: record.source.line, end: record.source.line + lines - 1 })
      }
      corpus = { store, spans, files: built.files, segments: built.chunks }
    } else {
      corpus = await buildCorpus({ dir: cli.corpus, workDir }).catch((error) => {
        console.error(`语料读不了（${cli.corpus}）：${error instanceof Error ? error.message : String(error)}`)
        console.error('语料不进仓库；拉取办法见 eval/memory/README.md')
        process.exit(2)
      })
    }

    // 向量路径（`--vectors`）：给全部语料建一份内存索引，再让真实的 Retriever 跑。
    let retriever = null
    if (cli.vectors !== null) {
      const { createEmbedAdapter } = await loadCore('adapters/providers/embed.js')
      const { MemoryRetriever } = await loadCore('features/memory/retriever.js')
      const embed = createEmbedAdapter({ baseUrl: cli.vectors, dim: 512, log: (line) => console.error(line) })
      const records = corpus.store.all()
      const vecs = new Map()
      const BATCH = 16
      const started = Date.now()
      for (let i = 0; i < records.length; i += BATCH) {
        const batch = records.slice(i, i + BATCH)
        const got = await embed.embed(batch.map((r) => r.content))
        if (got === null) {
          console.error(`向量服务不可用（${cli.vectors}）——先起 deploy/embed-server，或去掉 --vectors`)
          process.exit(2)
        }
        batch.forEach((r, j) => vecs.set(r.id, got[j]))
        if ((i / BATCH) % 20 === 0) console.error(`  已嵌 ${Math.min(i + BATCH, records.length)}/${records.length}`)
      }
      console.error(`向量索引：${vecs.size} 条（${((Date.now() - started) / 1000).toFixed(1)}s）`)
      const vectors = {
        weight: 1,
        embedQuery: async (text) => {
          const got = await embed.embed([text])
          return got === null ? null : got[0]
        },
        vectorOf: (id) => vecs.get(id) ?? null,
        all: () => [...vecs.entries()],
      }
      retriever = new MemoryRetriever({
        store: corpus.store,
        log: () => {},
        renderTime: () => '',
        clock: { now: () => NOW },
        vectors,
      })
    }
    cli.retriever = retriever

    const scored = []
    const latencies = []
    let injectCharsTotal = 0
    let injectCharsMax = 0
    for (const item of questions.questions) {
      const { picked, ms } = await retrieveOne(corpus.store, corpus.spans, item.question, cli)
      latencies.push(ms)
      const chars = picked.reduce((sum, c) => sum + c.record.content.length, 0)
      injectCharsTotal += chars
      injectCharsMax = Math.max(injectCharsMax, chars)
      const hit = item.evidence === null
        ? picked.length === 0
        : picked.some((c) => hitsEvidence(corpus.spans.get(c.record.id), item.evidence))
      scored.push({ id: item.id, ability: item.ability, hit, picked: picked.length, chars, ms })
    }

    const withEvidence = scored.filter((s) => questions.questions.find((q) => q.id === s.id).evidence !== null)
    const refusals = scored.filter((s) => questions.questions.find((q) => q.id === s.id).evidence === null)
    const recall = withEvidence.length === 0 ? 0 : withEvidence.filter((s) => s.hit).length / withEvidence.length
    const refusalOk = refusals.filter((s) => s.hit).length
    const byAbility = {}
    for (const s of scored) {
      byAbility[s.ability] = byAbility[s.ability] ?? { total: 0, hit: 0 }
      byAbility[s.ability].total += 1
      if (s.hit) byAbility[s.ability].hit += 1
    }
    const report = {
      mode: 'memory-bench',
      corpus: { dir: cli.corpus, files: corpus.files, segments: corpus.segments },
      k: cli.k,
      threshold: cli.threshold,
      recallAtK: Number(recall.toFixed(4)),
      recallSample: withEvidence.length,
      refusal: { ok: refusalOk, total: refusals.length },
      byAbility,
      latency: { p50: Number(percentile(latencies, 50).toFixed(2)), p95: Number(percentile(latencies, 95).toFixed(2)) },
      injectChars: {
        average: Math.round(injectCharsTotal / Math.max(1, scored.length)),
        max: injectCharsMax,
      },
      activeRecords: corpus.store.size(),
      thresholds: THRESHOLDS,
      gaps: {
        accuracy: 'SKIP：端到端答题准确率要 LLM 裁判（未配置）',
        hallucination: 'SKIP：同上传，且拒绝题只能用"检索为空"当代理指标',
      },
      missed: scored.filter((s) => !s.hit).map((s) => s.id),
    }

    const failed = []
    if (cli.enforce) {
      if (report.recallAtK < THRESHOLDS.recallAtK) failed.push(`recall@${cli.k} ${report.recallAtK} < ${THRESHOLDS.recallAtK}`)
      if (report.latency.p95 > THRESHOLDS.p95Ms) failed.push(`p95 ${report.latency.p95}ms > ${THRESHOLDS.p95Ms}ms`)
      if (report.injectChars.max > THRESHOLDS.injectChars) failed.push(`注入 ${report.injectChars.max} 字 > ${THRESHOLDS.injectChars}`)
    }
    report.failed = failed
    await writeFile(path.join(HERE, 'last-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8')

    if (cli.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    } else {
      console.log('记忆 60 题基准（P6e·e4）')
      console.log(`  语料：${report.corpus.files} 个文件 / ${report.corpus.segments} 段 → ${report.activeRecords} 条记录`)
      console.log(`  recall@${cli.k}：${report.recallAtK}（样本 ${report.recallSample} 题，门槛 ≥ ${THRESHOLDS.recallAtK}）`)
      console.log(`  拒答题代理（检索为空）：${refusalOk}/${refusals.length}`)
      for (const [name, stat] of Object.entries(byAbility)) console.log(`    ${name}: ${stat.hit}/${stat.total}`)
      console.log(`  延迟：p50 ${report.latency.p50}ms · p95 ${report.latency.p95}ms（门槛 ≤ ${THRESHOLDS.p95Ms}ms）`)
      console.log(`  注入：平均 ${report.injectChars.average} 字 · 最大 ${report.injectChars.max} 字（门槛 ≤ ${THRESHOLDS.injectChars}）`)
      console.log(`  准确率/幻觉率：${report.gaps.accuracy}`)
      if (failed.length > 0) console.log(`  未达标：${failed.join('；')}`)
      else if (cli.enforce) console.log('  达标：全部门槛通过')
      console.log('  报告：eval/memory/last-report.json')
    }
    process.exit(failed.length > 0 ? 1 : 0)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

await main()
