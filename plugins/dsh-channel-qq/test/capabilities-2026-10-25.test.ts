/** 能力接入批次的测试（2026-10-25，SnowLuma 审计落地）：
 *
 *   1. 合并转发/JSON 卡片解析（缺口 1：此前群里发合并转发整条被丢）；
 *   2. URL 安检护栏（D：缓存 + 预热两段，pre-execute 同步查缓存）；
 *   3. 社交指令（缺口 2：同意好友/邀请的管理员私聊指令）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { parseInbound } = await import('../src/core/message/parse.js')
const { UrlSafetyGuard } = await import('../src/core/guards/url-safety.js')
const { handleSocialCommand } = await import('../src/features/social/commands.js')
const { SocialStore } = await import('../src/features/social/store.js')

const NOW = new Date(2026, 9, 25, 12, 0).getTime()

// ── 1. 合并转发 / JSON 卡片 ──────────────────────────────────────────────────

test('解析：forward 段留容器 id，渲染占位；json 卡片提取标题与摘要', () => {
  const got = parseInbound({
    message: [
      { type: 'text', data: { text: '看看这个' } },
      { type: 'forward', data: { id: '/fwd-123' } },
      { type: 'json', data: { data: JSON.stringify({ meta: { news: { title: 'B 站视频标题', desc: '一段简介' } } }) } },
    ],
  } as never)
  assert.deepEqual(got.forwards, [{ id: '/fwd-123' }], '容器 id 留给 pipeline 展开')
  assert.ok(got.text.includes('[合并转发]'))
  assert.deepEqual(got.cards, [{ title: 'B 站视频标题', text: '一段简介' }])
  assert.ok(got.text.includes('[卡片]B 站视频标题'), '卡片标题进显示行')
})

test('解析：坏 JSON 卡片不炸（兜底前 80 字）；ark 段同走卡片路径', () => {
  const got = parseInbound({
    message: [
      { type: 'json', data: { data: '这不是 JSON{{{' } },
      { type: 'ark', data: { data: JSON.stringify({ prompt: '分享卡片' }) } },
    ],
  } as never)
  assert.equal(got.cards.length, 2)
  assert.equal(got.cards[0]!.title, '')
  assert.equal(got.cards[1]!.title, '分享卡片')
  assert.ok(got.text.includes('[卡片]分享卡片'))
})

// ── 2. URL 安检护栏 ──────────────────────────────────────────────────────────

test('URL 安检：同步查缓存拦危险链接；预热填充缓存；过期失效', async () => {
  const guard = new UrlSafetyGuard(async () => ({ level: 3 }), 30 * 60_000)
  const url = 'https://evil.example/payload'
  // 第一次：缓存空 → 放行（渐进式的明确局限），预热后第二次拦。
  assert.equal(guard.cachedBlock(`看这个 ${url}`, NOW), null)
  await guard.warm(`看这个 ${url}`, NOW)
  assert.equal(guard.cachedBlock(`再看一次 ${url}`, NOW + 1000), url, '预热后同一链接被拦')
  // 过期：TTL 外重新放行（等待下次预热）。
  assert.equal(guard.cachedBlock(`过期之后 ${url}`, NOW + 31 * 60_000), null)
})

test('URL 安检：安全链接不拦；提取器只认 http(s) 且去重', () => {
  const guard = new UrlSafetyGuard(async () => ({ level: 1 }))
  guard.seed('https://safe.example/a', 1, NOW)
  guard.seed('https://bad.example/b', 3, NOW)
  const text = '安全 https://safe.example/a 和危险 https://bad.example/b 以及 https://bad.example/b 重复'
  assert.equal(guard.cachedBlock(text, NOW + 1000), 'https://bad.example/b', '只拦危险的')
  const urls = UrlSafetyGuard.urlsOf('两个 https://a.example/x https://a.example/x 和一个 ftp://b.example/y')
  assert.deepEqual(urls, ['https://a.example/x'], '去重且不认 ftp')
})

// ── 3. 社交指令 ──────────────────────────────────────────────────────────────

function socialHarness() {
  const dir = mkdtempSync(path.join(tmpdir(), 'qq-social-'))
  const store = new SocialStore(dir, () => {})
  const sent: string[] = []
  const api = {
    setFriendAddRequest: async (flag: string, approve: boolean) => {
      sent.push(`friend:${flag}:${approve}`)
      return {}
    },
    setGroupAddRequest: async (flag: string, approve: boolean) => {
      sent.push(`group:${flag}:${approve}`)
      return {}
    },
  }
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true })
  return { store, sent, api, cleanup }
}

test('社交指令：同意/拒绝好友按存下的 flag 处理；群里不处理；非管理员拒绝', async () => {
  const h = socialHarness()
  try {
    await h.store.put({ kind: 'friend', id: 123, fromId: 123, name: '路人', comment: '有事', flag: 'FLAG-ABC', at: NOW, status: 'pending' })
    const api = h.api as never
    const ok = await handleSocialCommand('同意好友 123', 999, { isGroup: false, admins: [999], api, store: h.store })
    assert.ok(ok.handled && ok.reply.includes('已同意'))
    assert.deepEqual(h.sent, ['friend:FLAG-ABC:true'], 'flag 原样回传')
    assert.equal(h.store.listPending().length, 0, '处理后不再挂起')

    const group = await handleSocialCommand('同意好友 456', 999, { isGroup: true, admins: [999], api, store: h.store })
    assert.equal(group.handled, false, '群里完全静默')

    const stranger = await handleSocialCommand('同意好友 456', 111, { isGroup: false, admins: [999], api, store: h.store })
    assert.ok(stranger.handled && stranger.reply.includes('无权'), '非管理员拒绝')
  } finally { h.cleanup() }
})

test('社交指令：群邀请走 set_group_add_request；没有待处理时给出说明', async () => {
  const h = socialHarness()
  try {
    await h.store.put({ kind: 'group-invite', id: 777, fromId: 123, name: '某群', comment: '', flag: 'FLAG-GRP', at: NOW, status: 'pending' })
    const api = h.api as never
    const ok = await handleSocialCommand('拒绝邀请 777', 999, { isGroup: false, admins: [999], api, store: h.store })
    assert.ok(ok.handled && ok.reply.includes('已拒绝'))
    assert.deepEqual(h.sent, ['group:FLAG-GRP:false'])
    const none = await handleSocialCommand('好友请求', 999, { isGroup: false, admins: [999], api, store: h.store })
    assert.ok(none.handled && none.reply.includes('没有待处理'))
  } finally { h.cleanup() }
})
