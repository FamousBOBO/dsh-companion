/** OneBot v11 动作门面的**实现**（类型在 `ports/platform.ts`）。
 *
 * 为什么要有这一层：全仓原来有 **75 处** `client.call('字符串动作名', { 松散参数 })`，
 * 返回值靠 `as { file?: string }` 这类断言猜。代价有三个：
 *
 *   1. **换协议不可能评估**。`R8` 里讨论过换 NapCat 版本或换 SnowLuma——
 *      要判断能不能换，第一个问题就是"我们到底用了哪些动作、各自的参数与返回
 *      是什么形状"。散在 12 个文件里的字符串回答不了这个问题，一张方法表可以。
 *   2. **拼错动作名只会在运行时暴露**，而且是在群里发消息的那条路径上。
 *   3. **没法造假件测**。有门面之后，测试只要实现这个接口，就能在没有 QQ、
 *      没有 WebSocket 的情况下跑完整条业务路径。
 *
 * 设计取舍：
 *   - 门面**只做形状**，不做策略（不做重试、限速、窗口校验——那些在出站层与守卫里）；
 *   - 参数与返回值都按 OneBot v11 的名义类型声明，**不吞失败**：`call()` 本来就
 *     在 `status !== 'ok'` 时抛错，门面沿用这个语义；
 *   - 返回类型尽量窄（`{ file?: string; url?: string }` 这种），把 `as` 断言
 *     收进 `ports/platform.ts` 那一个文件——05 §6
 *     的迁移判据是"adapters 之外零字符串动作名"；
 *   - 类型描述的是**各动作的 `data` 形状**，不是 OneBot 的应答信封：
 *     `OneBotClient.call()` 成功时解析 `payload.data`、失败时 reject
 *     （`onebot.ts` 的 `handleFrame`）。这一点写错过，代价见 B13——读
 *     `result.data.message_id` 多读了一层，于是 sent-log 里 50 条记录的
 *     `messageId` 全是 null。
 *
 * 覆盖范围：当前用到的 34 个动作。宿主自带的动作（如 `get_status`）不走这里。
 */

import type { OneBotClient } from '../../onebot.js'
import type {
  ActionAck, EssenceEntry, FileEntry, FileUrl, FetchedMessage, ForwardNode, FriendInfo,
  ForwardMsgBody, GroupHonorInfo, GroupInfo, GroupMemberInfo, ImageFile, LoginInfo, QQApi, RecordFile, SendResult, StrangerInfo,
} from '../../ports/platform.js'

// 类型从端口转发出来，调用方既可以 import 端口，也可以继续从这里拿。
export type {
  ActionAck, EssenceEntry, FileEntry, FileUrl, FetchedMessage, ForwardNode, FriendInfo,
  GroupInfo, GroupMemberInfo, ImageFile, LoginInfo, QQApi, RecordFile, SendResult,
}

/** 把字符串动作名与松散参数收敛到一个地方。 */

/** 统一转发的签名；超时与错误语义与 `OneBotClient.call` 一致。 */
type Call = <T>(action: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>

type MessageSlice = Pick<
  QQApi,
  | 'sendGroupMessage' | 'sendPrivateMessage' | 'sendTo' | 'getMessage' | 'deleteMessage'
  | 'getImage' | 'getRecord' | 'getFile' | 'getForwardMsg' | 'getStrangerInfo'
  | 'setOnlineStatus' | 'setDiyOnlineStatus' | 'setGroupReaction'
  | 'fetchCustomFace' | 'sendCustomFace'
  | 'getGroupHonorInfo' | 'getGroupAtAllRemain'
  | 'setFriendAddRequest' | 'setGroupAddRequest' | 'getUnidirectionalFriendList'
  | 'checkUrlSafely' | 'sendLike' | 'getStatus'
>

type GroupSlice = Pick<
  QQApi,
  | 'getGroupList' | 'getGroupInfo' | 'getGroupMemberInfo' | 'getFriendList' | 'groupPoke' | 'setGroupCard'
  | 'setGroupBan' | 'setGroupKick' | 'setGroupWholeBan' | 'setGroupAdmin'
  | 'setEssence' | 'deleteEssence' | 'getEssenceList'
>

type FileSlice = Pick<
  QQApi,
  | 'getGroupRootFiles' | 'getGroupFilesByFolder' | 'getGroupFileUrl' | 'uploadGroupFile'
  | 'createGroupFileFolder' | 'moveGroupFile' | 'renameGroupFile' | 'deleteGroupFile'
  | 'getPrivateFileUrl' | 'uploadPrivateFile'
>

type VoiceSlice = Pick<QQApi, 'canSendRecord' | 'getAiRecord' | 'sendGroupAiRecord'>

/** 交互提示：输入状态与消息表情回应（A1）。 */
type InteractionSlice = Pick<
  QQApi,
  | 'setInputStatus' | 'setMessageEmojiLike' | 'getLoginInfo' | 'sendGroupForward' | 'sendPrivateForward'
  | 'getGroupMsgHistory' | 'getFriendMsgHistory' | 'getVoiceText' | 'ocrImage'
>

/** 消息收发与"取一个东西"。 */
function messageActions(call: Call): MessageSlice {
  return {
    sendGroupMessage: (groupId, message) => call<SendResult>('send_group_msg', { group_id: groupId, message }),
    sendPrivateMessage: (userId, message) => call<SendResult>('send_private_msg', { user_id: userId, message }),
    sendTo: (isGroup, target, message) => (isGroup
      ? call<SendResult>('send_group_msg', { group_id: target, message })
      : call<SendResult>('send_private_msg', { user_id: target, message })),
    getMessage: (messageId) => call<FetchedMessage>('get_msg', { message_id: messageId }, 8_000),
    deleteMessage: (messageId) => call<ActionAck>('delete_msg', { message_id: messageId }),
    getImage: (file) => call<ImageFile>('get_image', { file }, 15_000),
    getRecord: (messageId, outFormat) => call<RecordFile>(
      'get_record',
      { message_id: messageId, ...(outFormat === undefined ? {} : { out_format: outFormat }) },
      30_000,
    ),
    getFile: (fileId) => call<RecordFile>('get_file', { file_id: fileId }, 20_000),
    // ── 合并转发 / 社交 / 人格化 / 群运营 / 安检（2026-10-25 能力审计后接入）──
    getForwardMsg: (forwardId) => call<ForwardMsgBody>('get_forward_msg', { message_id: forwardId }, 15_000),
    getStrangerInfo: (userId) => call<StrangerInfo>('get_stranger_info', { user_id: userId }, 10_000),
    setOnlineStatus: (status) => call<ActionAck>('set_online_status', { status }),
    setDiyOnlineStatus: (faceId, content) => call<ActionAck>('set_diy_online_status', { face_id: faceId, content }),
    setGroupReaction: (groupId, messageId, emojiId, remove) => call<ActionAck>(
      'set_group_reaction',
      { group_id: groupId, message_id: messageId, emoji_id: emojiId, ...(remove === undefined ? {} : { set: !remove }) },
    ),
    fetchCustomFace: (count) => call<{ faces?: Array<{ emoji_id?: string; emoji_name?: string; url?: string }> }>(
      'fetch_custom_face', ...(count === undefined ? [{}] : [{ count }]),
    ),
    sendCustomFace: (fileId, isGroup, target) => call<ActionAck>(isGroup
      ? 'send_custom_face'
      : 'send_custom_face', isGroup ? { group_id: target, file: fileId } : { user_id: target, file: fileId }),
    getGroupHonorInfo: (groupId, type) => call<GroupHonorInfo>(
      'get_group_honor_info', { group_id: groupId, ...(type === undefined ? {} : { type }) },
    ),
    getGroupAtAllRemain: (groupId) => call<{ can_at_all?: boolean; remain_at_all_count_for_group?: number; remain_at_all_count_for_uin?: number }>(
      'get_group_at_all_remain', { group_id: groupId },
    ),
    setFriendAddRequest: (flag, approve, remark) => call<ActionAck>(
      'set_friend_add_request', { flag, approve, ...(remark === undefined ? {} : { remark }) },
    ),
    setGroupAddRequest: (flag, approve, reason) => call<ActionAck>(
      'set_group_add_request', { flag, approve, ...(reason === undefined ? {} : { reason }) },
    ),
    getUnidirectionalFriendList: () => call<{ list?: Array<{ user_id?: number; nickname?: string; source?: string }> }>(
      'get_unidirectional_friend_list', {},
    ),
    checkUrlSafely: (url) => call<{ level?: number | string; message?: string }>('check_url_safely', { url }),
    // 不钳制上限：clamp 到 10 是 tools.ts 的业务规则，门面只做转发。
    sendLike: (userId, times) => call<ActionAck>('send_like', { user_id: userId, times: times ?? 1 }),
    // 健康探针专用：短超时——探针本身就是"现在还能不能通"，卡 30 秒没有意义。
    getStatus: () => call<{ online?: boolean; good?: boolean }>('get_status', {}, 5_000),
  }
}

/** 群/好友信息、群管理、群精华。 */
function groupActions(call: Call): GroupSlice {
  return {
    getGroupList: () => call<GroupInfo[]>('get_group_list', {}, 8_000),
    getGroupInfo: (groupId) => call<GroupInfo>('get_group_info', { group_id: groupId, no_cache: false }, 8_000),
    getGroupMemberInfo: (groupId, userId) =>
      call<GroupMemberInfo>('get_group_member_info', { group_id: groupId, user_id: userId, no_cache: false }),
    getFriendList: () => call<FriendInfo[]>('get_friend_list', {}, 8_000),
    groupPoke: (groupId, userId) => call<ActionAck>('group_poke', { group_id: groupId, user_id: userId }),
    setGroupCard: (groupId, userId, card) =>
      call<ActionAck>('set_group_card', { group_id: groupId, user_id: userId, card }),

    setGroupBan: (groupId, userId, durationSeconds) =>
      call<ActionAck>('set_group_ban', { group_id: groupId, user_id: userId, duration: durationSeconds }),
    setGroupKick: (groupId, userId, rejectAddRequest) => call<ActionAck>('set_group_kick', {
      group_id: groupId, user_id: userId, reject_add_request: rejectAddRequest === true,
    }),
    setGroupWholeBan: (groupId, enable) =>
      call<ActionAck>('set_group_whole_ban', { group_id: groupId, enable }),
    setGroupAdmin: (groupId, userId, enable) =>
      call<ActionAck>('set_group_admin', { group_id: groupId, user_id: userId, enable }),

    setEssence: (messageId) => call<ActionAck>('set_essence_msg', { message_id: messageId }),
    deleteEssence: (messageId) => call<ActionAck>('delete_essence_msg', { message_id: messageId }),
    getEssenceList: (groupId) => call<EssenceEntry[]>('get_essence_msg_list', { group_id: groupId }),
  }
}

/**
 * 群文件与私聊文件。
 *
 * 这一组是**最容易写错的一组**：`folder_id` 不叫 `folder`、建文件夹的键是
 * `folder_name`、移动/重命名要带"当前目录"、好几个 id 线上传的是字符串。
 * 下面每一行都是照线上既有调用抄的，`test/qq-api.test.ts` 逐条钉住。
 */
function fileActions(call: Call): FileSlice {
  return {
    getGroupRootFiles: (groupId) =>
      call<{ files?: FileEntry[]; folders?: FileEntry[] }>('get_group_root_files', { group_id: groupId }),
    getGroupFilesByFolder: (groupId, folderId) =>
      call<{ files?: FileEntry[]; folders?: FileEntry[] }>(
        'get_group_files_by_folder', { group_id: groupId, folder_id: folderId },
      ),
    getGroupFileUrl: (groupId, fileId, busid) => call<FileUrl>(
      'get_group_file_url', { group_id: groupId, file_id: fileId, ...(busid === undefined ? {} : { busid }) },
    ),
    uploadGroupFile: (groupId, file, name, folderId) => call<ActionAck>(
      'upload_group_file',
      { group_id: groupId, file, name, ...(folderId === undefined ? {} : { folder_id: folderId }) },
      120_000,
    ),
    createGroupFileFolder: (groupId, folderName, parentId) => call<ActionAck>(
      'create_group_file_folder',
      { group_id: groupId, folder_name: folderName, parent_id: parentId ?? '/' },
    ),
    moveGroupFile: (groupId, fileId, currentParentDirectory, targetParentDirectory) => call<ActionAck>(
      'move_group_file',
      {
        group_id: String(groupId),
        file_id: String(fileId),
        current_parent_directory: currentParentDirectory,
        target_parent_directory: targetParentDirectory,
      },
    ),
    renameGroupFile: (groupId, fileId, currentParentDirectory, newName) => call<ActionAck>(
      'rename_group_file',
      {
        group_id: String(groupId),
        file_id: String(fileId),
        current_parent_directory: currentParentDirectory,
        new_name: newName,
      },
    ),
    deleteGroupFile: (groupId, fileId) =>
      call<ActionAck>('delete_group_file', { group_id: groupId, file_id: String(fileId) }),

    getPrivateFileUrl: (fileId) => call<FileUrl>('get_private_file_url', { file_id: String(fileId) }),
    uploadPrivateFile: (userId, file, name) =>
      call<ActionAck>('upload_private_file', { user_id: userId, file, name }, 120_000),
  }
}

/** AI 语音（NapCat 扩展）。 */
function voiceActions(call: Call): VoiceSlice {
  const aiRecord = (groupId: number, character: string, text: string): Record<string, unknown> =>
    ({ character: String(character), group_id: String(groupId), text: String(text) })
  return {
    canSendRecord: () => call<{ yes?: boolean }>('can_send_record', {}),
    getAiRecord: (groupId, character, text) => call<RecordFile>('get_ai_record', aiRecord(groupId, character, text), 60_000),
    sendGroupAiRecord: (groupId, character, text) =>
      call<SendResult>('send_group_ai_record', aiRecord(groupId, character, text), 60_000),
  }
}

/** 交互提示：输入状态与消息表情回应（A1）。 */
function interactionActions(call: Call): InteractionSlice {
  return {
    // SnowLuma v2.1.0 `set_input_status`：event_type 1 = 正在输入、0 = 取消。
    setInputStatus: (userId, eventType) =>
      call<ActionAck>('set_input_status', { user_id: userId, event_type: eventType }),
    // SnowLuma v2.1.0 `set_msg_emoji_like`：emoji_id 是字符串，set=false 撤销。
    setMessageEmojiLike: (messageId, emojiId, enable) =>
      call<ActionAck>('set_msg_emoji_like', { message_id: messageId, emoji_id: emojiId, set: enable }),
    getLoginInfo: () => call<LoginInfo>('get_login_info', {}, 8_000),
    // SnowLuma v2.1.0：messages 是 node 段数组；节点里的 content 是普通消息段。
    sendGroupForward: (groupId, nodes) =>
      call<SendResult>('send_group_forward_msg', { group_id: groupId, messages: nodes }, 30_000),
    sendPrivateForward: (userId, nodes) =>
      call<SendResult>('send_private_forward_msg', { user_id: userId, messages: nodes }, 30_000),
    getGroupMsgHistory: (groupId, count, messageId, reverseOrder) => call<{ messages?: FetchedMessage[] }>(
      'get_group_msg_history',
      {
        group_id: groupId,
        count,
        ...(messageId === undefined ? {} : { message_id: messageId }),
        ...(reverseOrder === undefined ? {} : { reverse_order: reverseOrder }),
      },
      20_000,
    ),
    getFriendMsgHistory: (userId, count, messageId, reverseOrder) => call<{ messages?: FetchedMessage[] }>(
      'get_friend_msg_history',
      {
        user_id: userId,
        count,
        ...(messageId === undefined ? {} : { message_id: messageId }),
        ...(reverseOrder === undefined ? {} : { reverse_order: reverseOrder }),
      },
      20_000,
    ),
    // SnowLuma：fetch_ptt_text（NapCat 同名），返回 { text }。
    getVoiceText: (messageId) => call<{ text?: string }>('fetch_ptt_text', { message_id: messageId }, 15_000),
    ocrImage: (image) => call<{ texts?: Array<{ text?: string }>; language?: string }>('ocr_image', { image }, 20_000),
  }
}

export function createQQApi(client: OneBotClient): QQApi {
  const call: Call = (action, params = {}, timeoutMs) => client.call(action, params, timeoutMs) as never
  return {
    ...messageActions(call),
    ...groupActions(call),
    ...fileActions(call),
    ...voiceActions(call),
    ...interactionActions(call),
  }
}
