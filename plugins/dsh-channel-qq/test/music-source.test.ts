/** 点歌音源解析：配置解析、按序尝试、失败原因、网易云回退。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { parseLxSources, resolveSongAudio, normalizeSongName } = await import('../src/features/music/source.js')

test('歌名归一化：去掉括号备注与标点（按歌名重试时判断同一首）', () => {
  assert.equal(normalizeSongName('焚爱 (《淮水竹亭》影视剧神火/片头曲)'), '焚爱')
  assert.equal(normalizeSongName('雨爱'), '雨爱')
  assert.equal(normalizeSongName('We Don\'t Talk Anymore'), 'wedonttalkanymore')
})

test('配置：对象与 URL 字符串都认；坏 JSON 给原因', () => {
  const objects = parseLxSources(JSON.stringify([
    { name: 'ikun', url: 'https://a.example/lx?key=1' },
    { url: 'https://b.example/lx', enabled: false },
    { name: 'dup', url: 'https://a.example/lx?key=1' },
  ]))
  assert.equal(objects.error, '')
  assert.equal(objects.sources.length, 2)
  assert.equal(objects.sources[0]?.name, 'ikun')
  assert.equal(objects.sources[1]?.enabled, false)
  assert.equal(objects.sources[1]?.name, 'b.example')

  const strings = parseLxSources('["https://c.example/lx"]')
  assert.equal(strings.sources[0]?.name, 'c.example')

  const bad = parseLxSources('{oops')
  assert.deepEqual(bad.sources, [])
  assert.match(bad.error, /JSON/)
})

test('解析：第一个音源失败后继续下一个，并带上来源', async () => {
  const logs: string[] = []
  const calls: string[] = []
  const got = await resolveSongAudio({ songId: '29713754', name: '匆匆那年' }, {
    sources: [
      { name: '坏源', url: 'https://bad.example/lx', enabled: true, quality: '' },
      { name: '好源', url: 'https://good.example/lx', enabled: true, quality: '128k' },
    ],
    defaultQuality: '320k',
    log: (line) => logs.push(line),
    loader: (async (url: string) => {
      calls.push(url)
      return {
        sources: {},
        resolveUrl: async (input: { quality: string }) => {
          if (url.includes('bad')) throw new Error('鉴权失败')
          assert.equal(input.quality, '128k')
          return 'https://cdn.example/song.mp3'
        },
      } as never
    }) as never,
    netease: (async () => ({ url: null, fee: 0, code: 0, br: 0, size: 0, vipRequired: false })) as never,
  })
  assert.equal(got.url, 'https://cdn.example/song.mp3')
  assert.equal(got.via, 'lx:好源')
  assert.equal(got.quality, '128k')
  assert.deepEqual(calls, ['https://bad.example/lx', 'https://good.example/lx'])
  assert.ok(logs.some((line) => line.includes('鉴权失败')))
})

test('解析：音源全失败时退回网易云直链', async () => {
  const got = await resolveSongAudio({ songId: '1' }, {
    sources: [{ name: 'x', url: 'https://x.example/lx', enabled: true, quality: '' }],
    defaultQuality: '320k',
    log: () => {},
    loader: (async () => ({ sources: {}, resolveUrl: async () => { throw new Error('boom') } })) as never,
    netease: (async () => ({ url: 'https://cdn.163/x.mp3', fee: 0, code: 200, br: 320000, size: 1, vipRequired: false })) as never,
  })
  assert.equal(got.via, 'netease')
})

test('解析：全都拿不到时把每个音源的失败原因带出来', async () => {
  await assert.rejects(() => resolveSongAudio({ songId: '1' }, {
    sources: [{ name: 'x', url: 'https://x.example/lx', enabled: true, quality: '' }],
    defaultQuality: '320k',
    log: () => {},
    loader: (async () => ({ sources: {}, resolveUrl: async () => { throw new Error('boom') } })) as never,
    netease: (async () => ({ url: null, fee: 1, code: 0, br: 0, size: 0, vipRequired: true })) as never,
  }), /VIP.*x: boom/)
})
