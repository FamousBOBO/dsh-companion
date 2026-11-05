/** 知识库增强（B6）：二阶重排权重与 URL 入库。
 *
 * 防的是"开着更差"：重排权重 0 必须与旧排序完全一致；URL 入库只写工作区文件，
 * 抓取失败/空正文不能留下半份文档。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { rerankScore } = await import('../src/core/kb/score.js')
const { ingestUrl } = await import('../src/features/kb/url-ingest.js')

test('重排：权重 0 原样返回；权重把余弦与标题覆盖混进来', () => {
  assert.equal(rerankScore(0.4, 0.9, 0.9, 0), 0.4)
  const mixed = rerankScore(0.4, 1, 0, 1)
  assert.equal(Math.round(mixed * 100) / 100, 0.7)
  assert.ok(rerankScore(0.4, 0, 0, 1) < 0.4)
})

test('URL 入库：抓取 HTML → Markdown 落盘并触发扫描', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kburl-'))
  try {
    let scans = 0
    const result = await ingestUrl({
      workspacePath: dir,
      maxBytes: 1024 * 1024,
      log: () => {},
      scan: async () => { scans += 1 },
      http: {
        request: async () => ({
          ok: true,
          status: 200,
          bytes: Buffer.from('<html><head><title>测试页</title></head><body><h1>标题</h1><p>正文内容</p></body></html>'),
        }),
      },
    }, 'https://example.com/a')
    assert.equal(result.title, '测试页')
    assert.equal(scans, 1)
    const body = readFileSync(result.path, 'utf8')
    assert.match(body, /# 测试页/)
    assert.match(body, /来源：https:\/\/example\.com\/a/)
    assert.match(body, /正文内容/)
    assert.match(result.path.split(path.sep).join('/'), /kb\/raw\/web\//)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('URL 入库：不是 http(s) / 空正文 → 报错且不落盘', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kburl-'))
  try {
    await assert.rejects(() => ingestUrl({
      workspacePath: dir, maxBytes: 1000, log: () => {}, scan: async () => {},
    }, 'file:///etc/passwd'), /http\(s\)/)
    await assert.rejects(() => ingestUrl({
      workspacePath: dir, maxBytes: 1000, log: () => {}, scan: async () => {},
      http: { request: async () => ({ ok: true, status: 200, bytes: Buffer.from('<html><script>x</script></html>') }) },
    }, 'https://example.com/empty'), /没有可读正文/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
