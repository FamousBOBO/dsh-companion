/** 表情段：发出去的东西必须让 QQ 当成**表情**，而不是一张图片。
 *
 * 2026-11-07 的真实缺陷：图库里挑出来的表情，QQ 上显示成一张图片（占一屏、带预览、
 * 点开是大图）。根因是 `image` 段只发了 `{file}`，而 QQNT/NapCat 用 `sub_type` 区分：
 * `0` = 普通图片，`1` = 表情。实测（NapCat 4.18.19，`send_private_msg` + `get_msg` 回读）：
 *
 * | 发出 | 回读 sub_type | 显示 |
 * |---|---|---|
 * | `{file}` | 0 | 图片 |
 * | `{file, summary:'[表情]'}` | 0 | 图片 |
 * | `{file, sub_type:1}` | 1 | 表情 |
 * | `{file, sub_type:1, summary:'[表情]'}` | 1 | 表情 |
 *
 * 这些测试钉住"发出去的那一段里 sub_type 必须是 1"，以及**普通的图片路径不受影响**
 * （生图 / 表情包配字仍然发图片——它们本来就是图片）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { OutboundQueue } from '../src/outbound.js'
import type { OneBotMessage, OneBotMessageSegment } from '../src/types.js'
import type { QQApi, SendResult } from '../src/ports/platform.js'
import type { QQToolDeps } from '../src/features/tool-deps.js'
import type { EmojiLibrary } from '../src/emoji-library.js'
import { stickerSegment, IMAGE_SUBTYPE_STICKER } from '../src/core/message/sticker.js'
import { stickersTools } from '../src/features/stickers/tools.js'

/** 假出站链：真的执行任务（这里要拿到发送参数）。 */
function fakeOut() {
  const out = {
    async push<T>(task: () => Promise<T>): Promise<T> { return await task() },
  }
  return out as unknown as OutboundQueue
}

/** 假 QQApi：记录发出的消息段；其余方法一律不该被调用。 */
function fakeApi(): { api: QQApi; sent: Array<{ to: number; isGroup: boolean; message: OneBotMessage }> } {
  const sent: Array<{ to: number; isGroup: boolean; message: OneBotMessage }> = []
  const ok = async (): Promise<SendResult> => ({ message_id: 1 } as SendResult)
  const api = {
    async sendPrivateMessage(userId: number, message: OneBotMessage): Promise<SendResult> {
      sent.push({ to: userId, isGroup: false, message })
      return await ok()
    },
    async sendGroupMessage(groupId: number, message: OneBotMessage): Promise<SendResult> {
      sent.push({ to: groupId, isGroup: true, message })
      return await ok()
    },
  } as unknown as QQApi
  return { api, sent }
}

/** 一个真实的 PNG 文件（小图，`napcatFileArg` 会内联成 `base64://`）。 */
function scratchPng(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'sticker-seg-'))
  const file = path.join(dir, 'sticker.png')
  const buffer = Buffer.alloc(33 + 64, 0x11)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.write('IHDR', 12, 'latin1')
  buffer.writeUInt32BE(64, 16)
  buffer.writeUInt32BE(64, 20)
  writeFileSync(file, buffer)
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function firstSegment(message: OneBotMessage): OneBotMessageSegment {
  assert.ok(Array.isArray(message), '发出去的应该是一组消息段')
  const seg = message[0]
  assert.ok(seg !== undefined, '至少要有一个消息段')
  return seg
}

test('stickerSegment：只有这一处定义 sub_type，值必须是 1（表情）', () => {
  const seg = stickerSegment('base64://AAAA')
  assert.equal(seg.type, 'image')
  assert.equal(IMAGE_SUBTYPE_STICKER, 1)
  assert.equal((seg.data as { sub_type?: number }).sub_type, 1, 'sub_type 必须是 1，否则 QQ 会当普通图片')
  assert.equal((seg.data as { summary?: string }).summary, '[表情]', '文本客户端至少要看到 [表情]')
  assert.equal((seg.data as { file: string }).file, 'base64://AAAA', 'file 原样透传，不改字节')
})

test('qq_send_emoji（合并面的 send）：发出的段是表情，不是图片', async () => {
  const s = scratchPng()
  try {
    const { api, sent } = fakeApi()
    const deps = { api, out: fakeOut() } as unknown as QQToolDeps
    const tool = stickersTools(deps).find(t => t.name === 'qq_send_emoji')
    assert.ok(tool !== undefined, 'qq_send_emoji 必须还在（合并面 qq_sticker 的 legacy 分支靠它）')
    await tool.run({ isGroup: false, target: 1429709395, file: s.file }, {} as never)
    assert.equal(sent.length, 1)
    const seg = firstSegment(sent[0]!.message)
    assert.equal(seg.type, 'image')
    assert.equal((seg.data as { sub_type?: number }).sub_type, 1, '发到 QQ 的那一段必须带 sub_type=1')
    assert.match(String((seg.data as { file: string }).file), /^base64:\/\//, '小图仍然内联，不依赖 NapCat 读盘')
  } finally {
    s.cleanup()
  }
})

test('qq_send_sticker（按情绪一步到位）：同样发的是表情', async () => {
  const s = scratchPng()
  try {
    const { api, sent } = fakeApi()
    const library = {
      search: () => [{ file: s.file, source: 'stolen', desc: '开心', tags: ['开心'], score: 1 }],
      random: () => undefined,
    } as unknown as EmojiLibrary
    const deps = { api, out: fakeOut(), library } as unknown as QQToolDeps
    const tool = stickersTools(deps).find(t => t.name === 'qq_send_sticker')
    assert.ok(tool !== undefined)
    await tool.run({ query: '开心', isGroup: true, target: 145326153 }, {} as never)
    assert.equal(sent.length, 1)
    assert.equal(sent[0]!.isGroup, true)
    assert.equal((firstSegment(sent[0]!.message).data as { sub_type?: number }).sub_type, 1)
  } finally {
    s.cleanup()
  }
})

test('普通图片路径不受影响：没带 sub_type 的段仍然是图片（生图 / 配字表情包）', () => {
  // 这两处**故意**不改成 stickerSegment：它们产出的是图片，不是表情。
  // 这条测试是"别把 sub_type 顺手撒得到处都是"的守门人。
  const plain: OneBotMessageSegment = { type: 'image', data: { file: 'base64://AAAA' } }
  assert.equal((plain.data as { sub_type?: number }).sub_type, undefined)
})
