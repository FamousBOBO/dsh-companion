#!/usr/bin/env node
/**
 * 知识库检索基准（合成 16 题）。
 *
 *   node eval/kb/run.mjs            # 跑基准，打印 hit@1 / hit@5 / MRR / 延迟
 *   node eval/kb/run.mjs --json     # 机读输出
 *   node eval/kb/run.mjs --enforce  # 把门槛当 FAIL（命中率不足时退出码 1）
 *
 * 先跑 `npm run build`：这里直接用编译产物，测的是线上同一套代码（摄取 → 分块 →
 * 关键词检索），不另写一份"评测专用"的实现。
 *
 * 默认不 enforce：门槛是回归线，不是第一次就要过的考试；看数字比让脚本变红重要。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { parseArgs } from 'node:util'

import { DOCS, QUESTIONS } from './corpus.mjs'

/** 回归门槛（关键词路径；接上向量后应当更好）。 */
export const THRESHOLDS = { hitAt1: 0.7, hitAt5: 0.9, mrr: 0.75, p95Ms: 200 }

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

const { KbStore } = await loadCore('features/kb/store.js')
const { KbIngestor } = await loadCore('features/kb/ingest.js')
const { KbRetriever } = await loadCore('features/kb/retriever.js')

function parseCli() {
  const { values } = parseArgs({
    options: {
      k: { type: 'string' },
      enforce: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  })
  return {
    k: Math.max(1, Number(values.k ?? 5)),
    enforce: values.enforce === true,
    json: values.json === true,
  }
}

async function buildIndex() {
  const root = await mkdtemp(path.join(tmpdir(), 'kb-eval-'))
  await mkdir(path.join(root, 'inbox'), { recursive: true })
  for (const doc of DOCS) await writeFile(path.join(root, doc.path), doc.text, 'utf8')
  const store = new KbStore({ root, log: () => {} })
  await store.load()
  const ingestor = new KbIngestor({
    store, workspace: root, dirs: 'inbox', maxBytes: 8 * 1024 * 1024, doclingUrl: '', log: () => {},
  })
  const progress = await ingestor.run()
  return { root, store, progress }
}

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
}

async function main() {
  const cli = parseCli()
  const { root, store, progress } = await buildIndex()
  try {
    const retriever = new KbRetriever({
      store, vectors: null, embed: null, log: () => {},
      vectorWeight: () => 0, scopes: () => ({}),
    })
    const rows = []
    for (const question of QUESTIONS) {
      const started = performance.now()
      const hits = await retriever.retrieve({ text: question.q, room: null, limit: cli.k })
      const ms = performance.now() - started
      const paths = hits.map((hit) => hit.document.path)
      const rank = paths.indexOf(question.path)
      rows.push({
        question: question.q,
        expected: question.path,
        top: paths[0] ?? '',
        rank: rank < 0 ? 0 : rank + 1,
        ms: Number(ms.toFixed(2)),
      })
    }
    const hit1 = rows.filter((row) => row.rank === 1).length / rows.length
    const hitK = rows.filter((row) => row.rank > 0).length / rows.length
    const mrr = rows.reduce((sum, row) => sum + (row.rank > 0 ? 1 / row.rank : 0), 0) / rows.length
    const p95 = percentile(rows.map((row) => row.ms), 95)
    const report = {
      docs: progress.added,
      chunks: store.stats().activeChunks,
      questions: rows.length,
      hitAt1: Number(hit1.toFixed(3)),
      [`hitAt${cli.k}`]: Number(hitK.toFixed(3)),
      mrr: Number(mrr.toFixed(3)),
      p95Ms: Number(p95.toFixed(2)),
      misses: rows.filter((row) => row.rank !== 1),
    }
    if (cli.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    } else {
      console.log(`知识库检索基准：${report.docs} 份文档 / ${report.chunks} 块 / ${report.questions} 题`)
      console.log(`hit@1 ${report.hitAt1} · hit@${cli.k} ${report[`hitAt${cli.k}`]} · MRR ${report.mrr} · p95 ${report.p95Ms}ms`)
      for (const miss of report.misses) {
        console.log(`  MISS rank=${miss.rank || '-'} "${miss.question}" → ${miss.top || '(无命中)'}（期望 ${miss.expected}）`)
      }
    }
    if (cli.enforce) {
      const failed = []
      if (hit1 < THRESHOLDS.hitAt1) failed.push(`hit@1 ${hit1} < ${THRESHOLDS.hitAt1}`)
      if (hitK < THRESHOLDS.hitAt5) failed.push(`hit@${cli.k} ${hitK} < ${THRESHOLDS.hitAt5}`)
      if (mrr < THRESHOLDS.mrr) failed.push(`MRR ${mrr} < ${THRESHOLDS.mrr}`)
      if (p95 > THRESHOLDS.p95Ms) failed.push(`p95 ${p95}ms > ${THRESHOLDS.p95Ms}ms`)
      if (failed.length > 0) {
        console.error(`kb-eval: 未达标 —— ${failed.join('；')}`)
        process.exitCode = 1
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
