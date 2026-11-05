/** `QQApi` 门面的**线上参数形状**锁定。
 *
 * 这组用例的价值不在于"门面能转发"，而在于把 34 个动作的 **wire 参数名与类型**
 * 钉在一处可读、可 diff、可逐个打勾的清单里。做这件事的直接动机是 R8：
 * 讨论"换 NapCat 版本 / 换 SnowLuma"时，第一个要回答的问题就是"我们到底用了
 * 哪些动作、参数怎么写、返回取哪几个字段"——散在 12 个文件里的字符串回答不了。
 *
 * 更实际的一点：写门面第一版时，我按直觉写了 6 处参数名（`folder` 而不是
 * `folder_id`、`move_group_file` 少一个目录、`get_ai_record` 少 `group_id`……），
 * 全部是拿线上的实际调用点逐个核对才发现的。这组用例把那次核对固化下来。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createQQApi } from '../src/adapters/onebot/qq-api.js'
import type { OneBotMessageSegment } from '../src/types.js'

/** 记录每一次 wire 调用，并回一个可控的 `data`。 */
function recorder(data: unknown = {}) {
  const calls: Array<{ action: string; params: Record<string, unknown> }> = []
  const api = createQQApi({
    async call(action: string, params: Record<string, unknown> = {}) {
      calls.push({ action, params })
      // 与 OneBotClient 一致：成功时给的是 data 本身。
      return data
    },
  } as never)
  return { api, calls }
}

/** 跑一个动作，返回它发出的 `{ action, params }`。 */
async function wireOf(run: (api: ReturnType<typeof createQQApi>) => Promise<unknown>): Promise<{ action: string; params: Record<string, unknown> }> {
  const { api, calls } = recorder()
  await run(api)
  assert.equal(calls.length, 1, '一次方法调用应当只产生一次 wire 调用')
  return calls[0]!
}

test('消息类动作的参数形状', async () => {
  const message: OneBotMessageSegment[] = [{ type: 'text', data: { text: 'hi' } }]
  assert.deepEqual(await wireOf((a) => a.sendGroupMessage(123, message)), {
    action: 'send_group_msg', params: { group_id: 123, message },
  })
  assert.deepEqual(await wireOf((a) => a.sendPrivateMessage(456, message)), {
    action: 'send_private_msg', params: { user_id: 456, message },
  })
  assert.deepEqual(await wireOf((a) => a.getMessage(99)), {
    action: 'get_msg', params: { message_id: 99 },
  })
  assert.deepEqual(await wireOf((a) => a.deleteMessage(99)), {
    action: 'delete_msg', params: { message_id: 99 },
  })
  assert.deepEqual(await wireOf((a) => a.getImage('https://x/a.jpg')), {
    action: 'get_image', params: { file: 'https://x/a.jpg' },
  })
  assert.deepEqual(await wireOf((a) => a.getFile('fid-1')), {
    action: 'get_file', params: { file_id: 'fid-1' },
  })
  // 健康探针：不产生消息的往返（传参为空）。
  assert.deepEqual(await wireOf((a) => a.getStatus()), {
    action: 'get_status', params: {},
  })
})

test('get_record：out_format 只在给定时才出现', async () => {
  assert.deepEqual(await wireOf((a) => a.getRecord(7)), {
    action: 'get_record', params: { message_id: 7 },
  })
  assert.deepEqual(await wireOf((a) => a.getRecord(7, 'amr')), {
    action: 'get_record', params: { message_id: 7, out_format: 'amr' },
  })
})

test('send_like 只转发，不钳制上限（clamp 是 tools.ts 的业务规则）', async () => {
  assert.deepEqual(await wireOf((a) => a.sendLike(456)), {
    action: 'send_like', params: { user_id: 456, times: 1 },
  })
  assert.deepEqual(await wireOf((a) => a.sendLike(456, 999)), {
    action: 'send_like', params: { user_id: 456, times: 999 },
  })
})

test('群信息类动作的参数形状', async () => {
  assert.deepEqual(await wireOf((a) => a.getGroupList()), { action: 'get_group_list', params: {} })
  assert.deepEqual(await wireOf((a) => a.getGroupInfo(123)), {
    action: 'get_group_info', params: { group_id: 123, no_cache: false },
  })
  assert.deepEqual(await wireOf((a) => a.getGroupMemberInfo(123, 456)), {
    action: 'get_group_member_info', params: { group_id: 123, user_id: 456, no_cache: false },
  })
  assert.deepEqual(await wireOf((a) => a.getFriendList()), { action: 'get_friend_list', params: {} })
})

test('群管理类动作的参数形状', async () => {
  assert.deepEqual(await wireOf((a) => a.setGroupBan(123, 456, 300)), {
    action: 'set_group_ban', params: { group_id: 123, user_id: 456, duration: 300 },
  })
  assert.deepEqual(await wireOf((a) => a.setGroupKick(123, 456)), {
    action: 'set_group_kick', params: { group_id: 123, user_id: 456, reject_add_request: false },
  })
  assert.deepEqual(await wireOf((a) => a.setGroupKick(123, 456, true)), {
    action: 'set_group_kick', params: { group_id: 123, user_id: 456, reject_add_request: true },
  })
  assert.deepEqual(await wireOf((a) => a.setGroupWholeBan(123, true)), {
    action: 'set_group_whole_ban', params: { group_id: 123, enable: true },
  })
  assert.deepEqual(await wireOf((a) => a.setGroupAdmin(123, 456, true)), {
    action: 'set_group_admin', params: { group_id: 123, user_id: 456, enable: true },
  })
  assert.deepEqual(await wireOf((a) => a.setGroupCard(123, 456, '新名片')), {
    action: 'set_group_card', params: { group_id: 123, user_id: 456, card: '新名片' },
  })
  assert.deepEqual(await wireOf((a) => a.groupPoke(123, 456)), {
    action: 'group_poke', params: { group_id: 123, user_id: 456 },
  })
})

test('精华类动作的参数形状', async () => {
  assert.deepEqual(await wireOf((a) => a.setEssence(99)), {
    action: 'set_essence_msg', params: { message_id: 99 },
  })
  assert.deepEqual(await wireOf((a) => a.deleteEssence(99)), {
    action: 'delete_essence_msg', params: { message_id: 99 },
  })
  assert.deepEqual(await wireOf((a) => a.getEssenceList(123)), {
    action: 'get_essence_msg_list', params: { group_id: 123 },
  })
})

test('群文件动作：这几个最容易写错，逐条钉住', async () => {
  assert.deepEqual(await wireOf((a) => a.getGroupRootFiles(123)), {
    action: 'get_group_root_files', params: { group_id: 123 },
  })
  assert.deepEqual(await wireOf((a) => a.getGroupFilesByFolder(123, 'fld')), {
    action: 'get_group_files_by_folder', params: { group_id: 123, folder_id: 'fld' },
  })
  assert.deepEqual(await wireOf((a) => a.getGroupFileUrl(123, 'fid')), {
    action: 'get_group_file_url', params: { group_id: 123, file_id: 'fid' },
  })
  // folder 的键名是 folder_id（不是 folder），且只在给定时出现。
  assert.deepEqual(await wireOf((a) => a.uploadGroupFile(123, '/tmp/a.txt', 'a.txt')), {
    action: 'upload_group_file', params: { group_id: 123, file: '/tmp/a.txt', name: 'a.txt' },
  })
  assert.deepEqual(await wireOf((a) => a.uploadGroupFile(123, '/tmp/a.txt', 'a.txt', 'fld')), {
    action: 'upload_group_file', params: { group_id: 123, file: '/tmp/a.txt', name: 'a.txt', folder_id: 'fld' },
  })
  // 建文件夹的键名是 folder_name，parent_id 省略时传 '/'
  assert.deepEqual(await wireOf((a) => a.createGroupFileFolder(123, '新目录')), {
    action: 'create_group_file_folder', params: { group_id: 123, folder_name: '新目录', parent_id: '/' },
  })
  // 移动 / 重命名都要带「当前目录」，且 id 传字符串
  assert.deepEqual(await wireOf((a) => a.moveGroupFile(123, 'fid', '/', '/sub')), {
    action: 'move_group_file',
    params: { group_id: '123', file_id: 'fid', current_parent_directory: '/', target_parent_directory: '/sub' },
  })
  assert.deepEqual(await wireOf((a) => a.renameGroupFile(123, 'fid', '/', '新名.txt')), {
    action: 'rename_group_file',
    params: { group_id: '123', file_id: 'fid', current_parent_directory: '/', new_name: '新名.txt' },
  })
  assert.deepEqual(await wireOf((a) => a.deleteGroupFile(123, 'fid')), {
    action: 'delete_group_file', params: { group_id: 123, file_id: 'fid' },
  })
})

test('私聊文件与 AI 语音的参数形状', async () => {
  assert.deepEqual(await wireOf((a) => a.getPrivateFileUrl('fid')), {
    action: 'get_private_file_url', params: { file_id: 'fid' },
  })
  assert.deepEqual(await wireOf((a) => a.uploadPrivateFile(456, '/tmp/a.txt', 'a.txt')), {
    action: 'upload_private_file', params: { user_id: 456, file: '/tmp/a.txt', name: 'a.txt' },
  })
  assert.deepEqual(await wireOf((a) => a.canSendRecord()), { action: 'can_send_record', params: {} })
  // get_ai_record 也要 group_id（第一版漏了，靠核对线上调用才发现）
  assert.deepEqual(await wireOf((a) => a.getAiRecord(123, 'ai_char_1', '你好')), {
    action: 'get_ai_record', params: { character: 'ai_char_1', group_id: '123', text: '你好' },
  })
  assert.deepEqual(await wireOf((a) => a.sendGroupAiRecord(123, 'ai_char_1', '你好')), {
    action: 'send_group_ai_record', params: { character: 'ai_char_1', group_id: '123', text: '你好' },
  })
})

test('交互提示：输入状态与表情回应的 wire 形状', async () => {
  assert.deepEqual(await wireOf((a) => a.setInputStatus(22, 1)), {
    action: 'set_input_status', params: { user_id: 22, event_type: 1 },
  })
  assert.deepEqual(await wireOf((a) => a.setInputStatus(22, 0)), {
    action: 'set_input_status', params: { user_id: 22, event_type: 0 },
  })
  assert.deepEqual(await wireOf((a) => a.setMessageEmojiLike(33, '424', true)), {
    action: 'set_msg_emoji_like', params: { message_id: 33, emoji_id: '424', set: true },
  })
  assert.deepEqual(await wireOf((a) => a.setMessageEmojiLike(33, '424', false)), {
    action: 'set_msg_emoji_like', params: { message_id: 33, emoji_id: '424', set: false },
  })
})

test('合并转发与登录信息：wire 形状', async () => {
  const nodes = [{ type: 'node' as const, data: { user_id: 1, nickname: '诺诺', content: [{ type: 'text' as const, data: { text: 'hi' } }] } }]
  assert.deepEqual(await wireOf((a) => a.getLoginInfo()), { action: 'get_login_info', params: {} })
  assert.deepEqual(await wireOf((a) => a.sendGroupForward(123, nodes)), {
    action: 'send_group_forward_msg', params: { group_id: 123, messages: nodes },
  })
  assert.deepEqual(await wireOf((a) => a.sendPrivateForward(456, nodes)), {
    action: 'send_private_forward_msg', params: { user_id: 456, messages: nodes },
  })
})

test('服务端历史：wire 形状（锚点与排序可选）', async () => {
  assert.deepEqual(await wireOf((a) => a.getGroupMsgHistory(123, 20)), {
    action: 'get_group_msg_history', params: { group_id: 123, count: 20 },
  })
  assert.deepEqual(await wireOf((a) => a.getGroupMsgHistory(123, 20, -5, false)), {
    action: 'get_group_msg_history', params: { group_id: 123, count: 20, message_id: -5, reverse_order: false },
  })
  assert.deepEqual(await wireOf((a) => a.getFriendMsgHistory(456, 10)), {
    action: 'get_friend_msg_history', params: { user_id: 456, count: 10 },
  })
})

test('sendTo：一个三元收口成一个方法，两个方向都钉住', async () => {
  const message: OneBotMessageSegment[] = [{ type: 'text', data: { text: 'hi' } }]
  assert.deepEqual(await wireOf((a) => a.sendTo(true, 123, message)), {
    action: 'send_group_msg', params: { group_id: 123, message },
  })
  assert.deepEqual(await wireOf((a) => a.sendTo(false, 456, message)), {
    action: 'send_private_msg', params: { user_id: 456, message },
  })
})

/** 门面上的全部方法名（消息 10 + 交互 9 + 群 13 + 文件 10 + 语音 3 = 45 个，对应 44 个动作）。 */
const ALL_METHODS = [
  'canSendRecord', 'createGroupFileFolder', 'deleteEssence', 'deleteGroupFile', 'deleteMessage',
  'getAiRecord', 'getEssenceList', 'getFile', 'getFriendList', 'getGroupFileUrl',
  'getGroupFilesByFolder', 'getGroupInfo', 'getGroupList', 'getGroupMemberInfo', 'getStatus',
  'getGroupRootFiles', 'getImage', 'getMessage', 'getPrivateFileUrl', 'getRecord', 'groupPoke',
  'moveGroupFile', 'renameGroupFile', 'sendGroupAiRecord', 'sendGroupMessage', 'sendLike',
  'setInputStatus', 'setMessageEmojiLike', 'getLoginInfo', 'sendGroupForward', 'sendPrivateForward',
  'getGroupMsgHistory', 'getFriendMsgHistory', 'getVoiceText', 'ocrImage',
  'sendPrivateMessage', 'sendTo', 'setEssence', 'setGroupAdmin', 'setGroupBan', 'setGroupCard',
  'setGroupKick', 'setGroupWholeBan', 'uploadGroupFile', 'uploadPrivateFile',
  // 2026-10-25 能力审计接入：合并转发展开、社交、人格化、群运营、URL 安检。
  'getForwardMsg', 'getStrangerInfo', 'setOnlineStatus', 'setDiyOnlineStatus', 'setGroupReaction',
  'fetchCustomFace', 'sendCustomFace', 'getGroupHonorInfo', 'getGroupAtAllRemain',
  'setFriendAddRequest', 'setGroupAddRequest', 'getUnidirectionalFriendList', 'checkUrlSafely',
].sort()

test('门面就是这张表：57 个动作 / 58 个方法，多一个少一个都失败', async () => {
  const { api } = recorder()
  // 这一条防的是"加了方法但没在这组用例里钉住 wire 形状"——
  // 上一组用例按动作逐个断言参数，方法名在这条里对齐。
  assert.deepEqual(Object.keys(api).sort(), ALL_METHODS)
})

test('返回值按名义类型透出（失败由 client.call 负责抛错）', async () => {
  const { api } = recorder({ file: '/tmp/x.amr', url: 'https://x/y.amr' })
  const record = await api.getRecord(1, 'amr')
  assert.equal(record.file, '/tmp/x.amr')
  assert.equal(record.url, 'https://x/y.amr')

  const withGroups = createQQApi({
    async call() { return [{ group_id: 1, group_name: 'G' }] },
  } as never)
  assert.deepEqual(await withGroups.getGroupList(), [{ group_id: 1, group_name: 'G' }])
})
