/** 合并面（一）：消息 / 查询 / 群管 / 群文件 / 私聊文件（05 §6.1 的前五行）。
 *
 * 每个分支的 required/optional 逐字对照旧 spec 的 parameters——对照测试
 * （test/tools-v2.test.ts）会把两边逐条比一遍，写歪一条就红。
 */

import type { Face } from './types.js'

export const MESSAGE_FACE: Face = {
  name: 'qq_message',
  description: '发消息与消息操作：发送文本（send）、引用回复（reply）、撤回（recall）、戳一戳（poke）、给好友点赞（like），以及把代码私信发给主人审核（code_review）——群里禁止贴代码，要发代码只能走 code_review。要发言用 send 或 reply；回复某条#编号必须用 reply 引用那条，别只写正文。',
  branches: [
    { action: 'send', legacy: 'qq_send_text', required: ['isGroup', 'target', 'text'], optional: ['phase'] },
    { action: 'reply', legacy: 'qq_reply_quote', required: ['isGroup', 'target', 'messageId', 'text'], optional: ['phase'] },
    { action: 'recall', legacy: 'qq_delete_msg', required: ['messageId'] },
    { action: 'poke', legacy: 'qq_send_poke', required: ['groupId', 'userId'] },
    { action: 'like', legacy: 'qq_send_like', required: ['userId'], optional: ['times'] },
    { action: 'code_review', legacy: 'qq_send_code_review', required: ['code'], optional: ['note'] },
  ],
}

export const LOOKUP_FACE: Face = {
  name: 'qq_lookup',
  description: '查询 QQ 侧的资料与历史：单条消息（message）、群成员（member）、群资料（group）、群列表（groups）、好友列表（friends）、群精华（essence）、聊天记录（history，可按关键词/发送者/日期过滤）。回答"上次那个/翻翻记录/查查这个人"之前先用它。',
  branches: [
    { action: 'message', legacy: 'qq_get_msg', required: ['messageId'] },
    { action: 'member', legacy: 'qq_get_group_member_info', required: ['groupId', 'userId'] },
    { action: 'group', legacy: 'qq_get_group_info', required: ['groupId'] },
    { action: 'groups', legacy: 'qq_get_group_list', required: [] },
    { action: 'friends', legacy: 'qq_get_friend_list', required: [] },
    { action: 'essence', legacy: 'qq_get_essence_list', required: ['groupId'] },
    { action: 'history', legacy: 'qq_search_history', required: [], optional: ['isGroup', 'target', 'keyword', 'senderId', 'sinceDate', 'untilDate', 'limit'] },
  ],
}

export const GROUP_ADMIN_FACE: Face = {
  name: 'qq_group_admin',
  description: '群管理动作：禁言（ban，60-300 秒）、踢人（kick）、全员禁言（whole_ban）、设/撤管理员（set_admin）、改群名片（set_card）、设精华（set_essence）、撤精华（unset_essence）、手动禁言刷屏者（mute_flooder）。这些动作会真的影响到群成员：只有主人发起的回合能执行，其余回合会被策略拦下。',
  branches: [
    { action: 'ban', legacy: 'qq_group_ban', required: ['groupId', 'userId'], optional: ['duration'] },
    { action: 'kick', legacy: 'qq_group_kick', required: ['groupId', 'userId'], optional: ['rejectAddRequest'] },
    { action: 'whole_ban', legacy: 'qq_group_whole_ban', required: ['groupId', 'enable'] },
    { action: 'set_admin', legacy: 'qq_set_group_admin', required: ['groupId', 'userId', 'enable'] },
    { action: 'set_card', legacy: 'qq_set_group_card', required: ['groupId', 'userId', 'card'] },
    { action: 'set_essence', legacy: 'qq_set_essence', required: ['messageId'] },
    { action: 'unset_essence', legacy: 'qq_delete_essence', required: ['messageId'] },
    { action: 'mute_flooder', legacy: 'qq_group_mute_user', required: ['groupId', 'userId', 'seconds'] },
  ],
}

export const GROUP_FILE_FACE: Face = {
  name: 'qq_group_file',
  description: '群文件管理：列出（list）、上传（upload）、下载到工作区（download）、新建文件夹（mkdir）、移动（move）、重命名（rename）、删除（delete）。写操作（上传/建夹/移动/改名/删除）只有主人的回合能执行。',
  branches: [
    { action: 'list', legacy: 'qq_list_group_files', required: ['groupId'], optional: ['folderId'] },
    { action: 'upload', legacy: 'qq_upload_group_file', required: ['groupId', 'file'], optional: ['name', 'folderId'] },
    { action: 'download', legacy: 'qq_download_group_file', required: ['groupId', 'fileId'], optional: ['saveAs'] },
    { action: 'mkdir', legacy: 'qq_create_file_folder', required: ['groupId', 'folderName'], optional: ['parentId'] },
    { action: 'move', legacy: 'qq_move_group_file', required: ['groupId', 'fileId', 'currentParentDirectory', 'targetParentDirectory'] },
    { action: 'rename', legacy: 'qq_rename_group_file', required: ['groupId', 'fileId', 'currentParentDirectory', 'newName'] },
    { action: 'delete', legacy: 'qq_delete_group_file', required: ['groupId', 'fileId'] },
  ],
}

export const FILE_FACE: Face = {
  name: 'qq_file',
  description: '私聊文件：给好友发本地文件（send_private）、把收到的私聊文件存到工作区（save_private）、拿文件下载链接（url）。',
  branches: [
    { action: 'send_private', legacy: 'qq_send_private_file', required: ['userId', 'file'], optional: ['name'] },
    { action: 'save_private', legacy: 'qq_save_private_file', required: ['fileId'], optional: ['saveAs'] },
    { action: 'url', legacy: 'qq_get_file_url', required: ['fileId'] },
  ],
}

export const CORE_FACES: readonly Face[] = [MESSAGE_FACE, LOOKUP_FACE, GROUP_ADMIN_FACE, GROUP_FILE_FACE, FILE_FACE]
