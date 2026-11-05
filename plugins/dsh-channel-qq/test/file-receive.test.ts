/** 文件接收链路的测试（2026-10-25 修复：SnowLuma 新版 get_file 不再解析文件 id）。
 *
 * 三条不能少的性质：
 *   1. **群文件走 `get_group_file_url`、私聊走 `get_private_file_url`**——
 *      SnowLuma 明确说 get_file 只认图片/语音缓存（NapCat 同语义）；
 *   2. **专用接口失败回退 get_file**：不让一个坏接口把文件弄丢；
 *   3. **CQ 码来源的文件段字段名是 `id`**（JSON 段是 file_id），两个都认。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { receiveFiles } = await import('../src/app/inbound/attachments.js')
const { parseInbound } = await import('../src/core/message/parse.js')

/** 最小 AttachmentDeps 替身：只实现 receiveFiles 触碰到的面。 */
function fakeDeps(opts: {
  groupUrl?: { url?: string } | Error
  privateUrl?: { url?: string } | Error
  getFile?: { file?: string; url?: string } | Error
  bytes?: Uint8Array
  failHttpRequest?: boolean
} = {}) {
  const calls: string[] = []
  const bytes = opts.bytes ?? new Uint8Array([1, 2, 3])
  const deps = {
    api: {
      getFile: async () => {
        calls.push('get_file')
        if (opts.getFile instanceof Error) throw opts.getFile
        return opts.getFile ?? {}
      },
      getGroupFileUrl: async () => {
        calls.push('get_group_file_url')
        if (opts.groupUrl instanceof Error) throw opts.groupUrl
        return opts.groupUrl ?? {}
      },
      getPrivateFileUrl: async () => {
        calls.push('get_private_file_url')
        if (opts.privateUrl instanceof Error) throw opts.privateUrl
        return opts.privateUrl ?? {}
      },
    },
    http: {
      request: async () => {
        calls.push('http')
        if (opts.failHttpRequest === true) throw new Error('network down')
        return { ok: true, bytes, text: () => '', json: () => ({}) }
      },
    },
    gateway: {},
    blobs: {
      writeInbox: async (input: { name: string }) => {
        calls.push(`inbox:${input.name}`)
        return `inbox/${input.name}`
      },
      readLocal: async () => Buffer.from(bytes),
    },
    config: () => ({ imageRecognition: { enabled: false, maxPerMessage: 4 } }),
    log: () => {},
  }
  return { deps: deps as never, calls }
}

const FILE = { name: 'demo-1.0.0.apk', url: '', fileId: '/deadbeef-0000-4000-8000-000000000001' }
const GROUP = 2000000005

test('群文件：专用 URL 接口命中后下载落收件箱（修复主路径）', async () => {
  const h = fakeDeps({ groupUrl: { url: 'https://njc-download.ftn.qq.com/ftn_handler/xxx/' } })
  const saved = await receiveFiles(h.deps, { files: [FILE] } as never, 0, { groupId: GROUP })
  assert.deepEqual(saved, [`inbox/${FILE.name}`])
  assert.ok(h.calls.includes('get_group_file_url'), '走群文件 URL 接口')
  assert.ok(!h.calls.includes('get_file'), '主路径命中就不再兜底')
})

test('私聊文件：走 get_private_file_url', async () => {
  const h = fakeDeps({ privateUrl: { url: 'https://ftn.qq.com/x' } })
  const saved = await receiveFiles(h.deps, { files: [FILE] } as never, 0, {})
  assert.equal(saved.length, 1)
  assert.ok(h.calls.includes('get_private_file_url'))
  assert.ok(!h.calls.includes('get_group_file_url'), '私聊不调群接口')
})

test('专用接口失败回退 get_file（兼容还认文件 id 的旧实现）', async () => {
  const h = fakeDeps({ groupUrl: new Error('接口坏了'), getFile: { file: '/tmp/cached.apk' } })
  const saved = await receiveFiles(h.deps, { files: [FILE] } as never, 0, { groupId: GROUP })
  assert.equal(saved.length, 1, '兜底接住了')
  assert.ok(h.calls.includes('get_group_file_url') && h.calls.includes('get_file'))
})

test('两条路都失败：记一条下载失败，不抛穿（其他文件/消息不受影响）', async () => {
  const h = fakeDeps({ groupUrl: new Error('x'), getFile: new Error('y') })
  const saved = await receiveFiles(h.deps, { files: [FILE] } as never, 0, { groupId: GROUP })
  assert.deepEqual(saved, [])
})

test('解析：CQ 码来源的字段名是 id，JSON 段是 file_id，两个都认', () => {
  const cq = parseInbound({
    message: [
      { type: 'file', data: { file: 'a.zip', id: '/aaa-bbb' } },
    ],
  } as never)
  assert.equal(cq.files[0]!.fileId, '/aaa-bbb', 'CQ 字段名 id')
  assert.equal(cq.files[0]!.name, 'a.zip')

  const json = parseInbound({
    message: [
      { type: 'file', data: { file: 'b.zip', file_id: '/ccc-ddd' } },
    ],
  } as never)
  assert.equal(json.files[0]!.fileId, '/ccc-ddd', 'JSON 字段名 file_id')
})
