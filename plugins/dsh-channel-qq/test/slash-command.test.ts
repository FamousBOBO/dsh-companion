/** 群聊斜杠命令的关闭（2026-11-01 使用者要求）。
 *
 * 两层：
 *   1. **判定**：`core/commands.ts` 的 `isSlashCommandText` 是纯函数，这里逐项钉住口径；
 *   2. **闸门**：通道里原有的两条命令入口（`/换血`、访问门控审批）本来就只认私聊，
 *      这里也断言一遍——群消息不论内容如何都进不去。
 *
 * 分发层（`features/inbound/index.ts`）把 `isSlashCommandText(rawText(event))` 放在
 * 观察者/聊天记录/流水线**之前**，所以群里以 `/` 开头的消息既不执行、也不进旁听、也不进模型。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { isSlashCommandText } = await import('../src/core/commands.js')
const { maybeHandleResetCommand } = await import('../src/features/inbound/reset-command.js')
const { maybeHandleAccessCommand } = await import('../src/features/access/commands.js')

test('斜杠命令判定：半角与全角、前导空白都算', () => {
  assert.equal(isSlashCommandText('/换血'), true)
  assert.equal(isSlashCommandText('  /help'), true)
  assert.equal(isSlashCommandText('\t/ping'), true)
  assert.equal(isSlashCommandText('／帮助'), true, '全角斜杠也是命令写法')
  assert.equal(isSlashCommandText('   ／x'), true)
})

test('斜杠命令判定：普通聊天、空正文、只含斜杠在中间都不算', () => {
  assert.equal(isSlashCommandText('今天中午吃啥'), false)
  assert.equal(isSlashCommandText(''), false)
  assert.equal(isSlashCommandText('   '), false)
  assert.equal(isSlashCommandText('路径是 C:/Users'), false, '斜杠在中间不算命令')
  assert.equal(isSlashCommandText('1/2 的人这么想'), false)
  assert.equal(isSlashCommandText('http://example.com'), false)
})

/** 只要 private 检查在前，这些函数就不会碰 host 的其它字段。 */
const hostStub = { config: { admins: [42] }, get: () => undefined, log: () => {} }

function groupEvent(text: string) {
  return {
    time: 0,
    self_id: 1,
    post_type: 'message',
    message_type: 'group',
    group_id: 145_326_153,
    user_id: 42,
    message_id: 1,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
  } as never
}

test('群聊里的 `/换血` 不会执行（管理员本人发也一样）', () => {
  assert.equal(maybeHandleResetCommand(hostStub as never, {} as never, groupEvent('/换血')), false)
})

test('群聊里的审批命令不会执行', async () => {
  assert.equal(await maybeHandleAccessCommand(hostStub as never, groupEvent('/待批')), false)
  assert.equal(await maybeHandleAccessCommand(hostStub as never, groupEvent('/放行群 123')), false)
})
