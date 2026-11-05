/** 前端纯函数模型（`src/admin/ui/model/*.js`）：node:test 直接 import 源文件。
 *
 * 表单渲染的"算得对不对"（diff、校验、列表解析、隐显联动）出错时页面看起来
 * 只是"行为怪"——没有异常、没有红字。这里把那些规则钉进单测，布局探针只证
 * 明"渲染出来了"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

/* 编译产物在 lib-test/test/ 下，动态 import 指回仓库里的源文件（`.js` 是原生 ESM）。 */
async function model(): Promise<any> {
  return await import(new URL('../../../src/admin/ui/model/form-model.js', import.meta.url).href)
}

async function table(): Promise<any> {
  return await import(new URL('../../../src/admin/ui/model/table-model.js', import.meta.url).href)
}

test('列表文本解析：逗号/中文逗号/空白都算分隔；number 模式过滤非数字', async () => {
  const m = await model()
  assert.deepEqual(m.parseListText('a, b，c  d', 'string'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(m.parseListText('1, 2, x', 'number'), [1, 2])
  assert.deepEqual(m.parseListText('', 'string'), [])
})

test('parseScalar：空数字 → null；数字字符串转数字；字符串原样', async () => {
  const m = await model()
  assert.equal(m.parseScalar({ kind: 'number' }, '  '), null)
  assert.equal(m.parseScalar({ kind: 'number' }, '1.5'), 1.5)
  assert.equal(m.parseScalar({ kind: 'number' }, 'nope'), null)
  assert.equal(m.parseScalar({ kind: 'string' }, 'x'), 'x')
})

test('localValidate：可选数字的 null 放行；越界/enum 拒绝', async () => {
  const m = await model()
  assert.equal(m.localValidate({ kind: 'number', allowNull: true }, null), null)
  assert.equal(m.localValidate({ kind: 'number' }, null), '不能为空')
  assert.equal(m.localValidate({ kind: 'number', min: 0, max: 1 }, 2), '不能大于 1')
  assert.equal(m.localValidate({ kind: 'enum', choices: [{ value: 'a', label: 'A' }] }, 'b'), '只能是：a')
  assert.equal(m.localValidate({ kind: 'boolean' }, true), null)
})

test('buildChanges：跳过没变的叶子；敏感字段不带明文；hot 缺省按 restart', async () => {
  const m = await model()
  const schema = { fields: [
    { path: 'talkValue', label: '概率', hot: 'live' },
    { path: 'admin.password', label: '口令', secret: true, hot: 'live' },
    { path: 'tts.voice', label: '音色' }, // 没有 hot → restart（保守）
  ] }
  const config = { talkValue: 0.6, admin: { password: '' }, tts: { voice: 'v1' } }
  assert.deepEqual(m.buildChanges(schema, config, { talkValue: 0.6 }), [])

  const changes = m.buildChanges(
    schema, config,
    { talkValue: 0.8, admin: { password: 'plaintext-secret' }, tts: { voice: 'v2' } },
    { 'admin.password': true },
  )
  assert.equal(changes.length, 3)
  const talk = changes.find((c: any) => c.path === 'talkValue')
  assert.equal(talk.label, '概率')
  assert.equal(talk.hot, 'live')
  const pw = changes.find((c: any) => c.path === 'admin.password')
  assert.equal(pw.old, '（已设置）')
  assert.equal(pw.new, '（新值）')
  assert.ok(!JSON.stringify([pw.old, pw.new]).includes('plaintext-secret'))
  const voice = changes.find((c: any) => c.path === 'tts.voice')
  assert.equal(voice.hot, 'restart')
  const stats = m.summarizeChanges(changes)
  assert.equal(stats.total, 3)
  assert.equal(stats.restart, 1)
  assert.equal(stats.reload, 0)
})

test('hiddenIf：equals 命中即隐藏、notEquals 反向', async () => {
  const m = await model()
  assert.equal(m.isHidden({ hiddenIf: { field: 'connection.mode', equals: 'ws' } }, { connection: { mode: 'ws' } }), true)
  assert.equal(m.isHidden({ hiddenIf: { field: 'connection.mode', equals: 'ws' } }, { connection: { mode: 'http' } }), false)
  assert.equal(m.isHidden({ hiddenIf: { field: 'a', notEquals: true } }, { a: false }), true)
  assert.equal(m.isHidden({}, {}), false)
})

test('fieldsOfPage：顶层字段与段分组各归其位', async () => {
  const m = await model()
  const schema = {
    fields: [
      { path: 'selfId', section: null, page: 'connection' },
      { path: 'connection.mode', section: 'connection', page: 'connection' },
      { path: 'connection.url', section: 'connection', page: 'connection' },
      { path: 'talkValue', section: null, page: 'groups' },
    ],
    sections: [
      { id: 'connection', label: '连接', page: 'connection' },
      { id: 'elsewhere', label: '别的页', page: 'zzz' },
    ],
  }
  const conn = m.fieldsOfPage(schema, 'connection')
  assert.equal(conn.rootFields.length, 1)
  assert.equal(conn.rootFields[0].path, 'selfId')
  assert.equal(conn.groups.length, 1)
  assert.equal(conn.groups[0].label, '连接')
  assert.equal(conn.groups[0].fields.length, 2)
  assert.equal(m.fieldsOfPage(schema, 'groups').groups.length, 0)
})

test('serializeValue：列表折叠成逗号串、JSON 美化、空值空串', async () => {
  const m = await model()
  assert.equal(m.serializeValue({ kind: 'list' }, ['a', 'b']), 'a, b')
  assert.equal(m.serializeValue({ kind: 'json' }, { a: 1 }), JSON.stringify({ a: 1 }, null, 1))
  assert.equal(m.serializeValue({ kind: 'string' }, null), '')
  assert.equal(m.serializeValue({ kind: 'number' }, 3), '3')
})

test('行编辑器：新 id 带前缀、setItemValue 空值即删键', async () => {
  const m = await model()
  assert.match(m.newRowId('rss'), /^rss_[a-z0-9]+$/)
  const row = m.setItemValue({ id: 'x', note: 'y' }, 'note', '')
  assert.equal('note' in row, false)
  assert.equal(m.setItemValue({}, 'k', 1).k, 1)
  assert.equal(m.itemValue(undefined, { key: 'n', kind: 'number' }), null)
  assert.equal(m.itemValue({}, { key: 'b', kind: 'boolean' }), false)
  assert.equal(m.itemValue(undefined, { key: 'l', kind: 'list' }).length, 0)
})

test('表格模型：rowsOf 取第一个数组、rowId 优先 id、过滤与分页', async () => {
  const t = await table()
  assert.deepEqual(t.rowsOf({ count: 2, quotes: [{ id: 'q1' }, { id: 'q2' }] }), [{ id: 'q1' }, { id: 'q2' }])
  assert.deepEqual(t.rowsOf([1, 2]), [1, 2])
  assert.deepEqual(t.rowsOf({ a: 1 }), [{ a: 1 }])
  assert.equal(t.rowId({ id: 'x' }), 'x')
  assert.equal(t.rowId({ md5: 'm' }), 'm')
  const rows = [{ text: 'abc' }, { text: 'xyz' }]
  assert.deepEqual(t.filterRows(rows, 'ab'), [{ text: 'abc' }])
  assert.deepEqual(t.filterRows(rows, ''), rows)
})
