/** 表情打标：视觉消息必须是宿主的 `{type:'image', attachment}`，且"没看到图"不能落库。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { EmojiLibrary } = await import('../src/emoji-library.js')
const { sniffImageMediaType } = await import('../src/emoji-tagging.js')

function entry(overrides: Record<string, unknown> = {}) {
  return {
    file: '/tmp/x.png', source: 'stolen', md5: 'md5-x', desc: '', tags: [] as string[], addedAt: 1,
    ...overrides,
  }
}

function harness(reply: string) {
  const calls: Array<Record<string, unknown>> = []
  const saved: Array<Record<string, unknown>> = []
  const ctx = {
    llm: {
      stream: (options: Record<string, unknown>) => {
        calls.push(options)
        return (async function* () { yield { text: reply } })()
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    attachments: {
      saveImage: async (input: Record<string, unknown>) => {
        saved.push(input)
        return { id: 'att-1' }
      },
    },
  }
  return { ctx, calls, saved }
}

test('打标：图片走附件，content block 是宿主形状', async () => {
  const h = harness('{"desc":"猫猫大笑","tags":["大笑","开心"]}')
  const logs: string[] = []
  const library = new EmojiLibrary({} as never, (line) => logs.push(line))
  const target = entry()
  await library.tagEntry(h.ctx as never, target as never, Buffer.from('image'), 'image/png')

  assert.equal(h.saved.length, 1)
  assert.equal(h.saved[0]?.mediaType, 'image/png')
  const content = (h.calls[0]?.messages as Array<{ content: unknown[] }>)[0]?.content ?? []
  assert.deepEqual(content[0], { type: 'image', attachment: { id: 'att-1' } })
  assert.equal((content[1] as { type: string }).type, 'text')
  assert.deepEqual(target.tags, ['大笑', '开心'])
  assert.equal(target.desc, '猫猫大笑')
  assert.ok(logs.some((line) => line.includes('emoji tagged')))
})

test('打标：模型回"没收到图片"时不落库（旧 bug 的防回归）', async () => {
  const h = harness('{"desc":"未收到图片，无法识别","tags":["疑问","无语"]}')
  const library = new EmojiLibrary({} as never, () => {})
  const target = entry({ md5: 'md5-y' })
  await library.tagEntry(h.ctx as never, target as never, Buffer.from('image'), 'image/png')
  assert.deepEqual(target.tags, [])
  assert.equal(target.desc, '')
})

test('打标：容忍 JSON 前后多余文字', async () => {
  const h = harness('好的，结果是：{"desc":"吃瓜","tags":["吃瓜","摸鱼"]} 完成。')
  const library = new EmojiLibrary({} as never, () => {})
  const target = entry({ md5: 'md5-z' })
  await library.tagEntry(h.ctx as never, target as never, Buffer.from('image'), 'image/png')
  assert.deepEqual(target.tags, ['吃瓜', '摸鱼'])
  assert.equal(target.desc, '吃瓜')
})

test('打标：宿主没有 attachments 时明确跳过', async () => {
  const logs: string[] = []
  const library = new EmojiLibrary({} as never, (line) => logs.push(line))
  const target = entry({ md5: 'md5-w' })
  await library.tagEntry({
    llm: { stream: () => (async function* () { yield { text: '{}' } })() },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  } as never, target as never, Buffer.from('image'), 'image/png')
  assert.deepEqual(target.tags, [])
  assert.ok(logs.some((line) => line.includes('attachments')))
})

test('打标：第一次输出思考过程时，第二次用短提示逼回 JSON', async () => {
  const replies = ['这张图看起来是一个表情包，用户想要 JSON……', '{"desc":"吃瓜","tags":["吃瓜"]}']
  const calls: Array<Record<string, unknown>> = []
  const ctx = {
    llm: {
      stream: (options: Record<string, unknown>) => {
        calls.push(options)
        const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? ''
        return (async function* () { yield { text: reply } })()
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    attachments: { saveImage: async () => ({ id: 'att' }) },
  }
  const library = new EmojiLibrary({} as never, () => {})
  const target = entry({ md5: 'md5-r' })
  await library.tagEntry(ctx as never, target as never, Buffer.from('image'), 'image/png')
  assert.equal(calls.length, 2)
  assert.deepEqual(target.tags, ['吃瓜'])
})

test('打标：两轮都不是 JSON 时从散文里抠描述与情绪词', async () => {
  const replies = [
    '用户希望输出 JSON。图片是白鸭张嘴，看起来很开心。',
    '我们需要回答。图片是白鸭张嘴大笑，看起来很开心的样子。',
  ]
  let calls = 0
  const ctx = {
    llm: {
      stream: () => {
        const reply = replies[Math.min(calls, replies.length - 1)] ?? ''
        calls += 1
        return (async function* () { yield { text: reply } })()
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    attachments: { saveImage: async () => ({ id: 'att' }) },
  }
  const library = new EmojiLibrary({} as never, () => {})
  const target = entry({ md5: 'md5-p' })
  await library.tagEntry(ctx as never, target as never, Buffer.from('image'), 'image/png')
  assert.equal(calls, 2)
  assert.match(target.desc, /白鸭张嘴大笑/)
  assert.ok(target.tags.includes('大笑'))
  assert.ok(target.tags.includes('开心'))
})

test('打标：散文里说没看到图时不落库', async () => {
  const ctx = {
    llm: { stream: () => (async function* () { yield { text: 'We need JSON. The image is missing; 无法识别这张图片。' } })() },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    attachments: { saveImage: async () => ({}) },
  }
  const library = new EmojiLibrary({} as never, () => {})
  const target = entry({ md5: 'md5-n' })
  await library.tagEntry(ctx as never, target as never, Buffer.from('image'), 'image/png')
  assert.deepEqual(target.tags, [])
  assert.equal(target.desc, '')
})

test('媒体类型：按文件头判断，不信扩展名/HTTP 头', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])
  const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  assert.equal(sniffImageMediaType(png), 'image/png')
  assert.equal(sniffImageMediaType(gif), 'image/gif')
  assert.equal(sniffImageMediaType(jpeg), 'image/jpeg')
  assert.equal(sniffImageMediaType(webp), 'image/webp')
  assert.equal(sniffImageMediaType(Uint8Array.from([1, 2, 3])), null)
})

test('打标：声明 png 但字节是 gif 时，按 gif 上报附件', async () => {
  const saved: Array<Record<string, unknown>> = []
  const ctx = {
    llm: { stream: () => (async function* () { yield { text: '{"desc":"x","tags":["开心"]}' } })() },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    attachments: { saveImage: async (input: Record<string, unknown>) => { saved.push(input); return {} } },
  }
  const library = new EmojiLibrary({} as never, () => {})
  const gif = Buffer.from('GIF89a...')
  await library.tagEntry(ctx as never, entry({ md5: 'md5-g' }) as never, gif, 'image/png')
  assert.equal(saved[0]?.mediaType, 'image/gif')
})
