/** 平台端口：QQ 动作门面与连接状态。
 *
 * **这个文件只有类型，没有实现**（06 §P2.1）。
 * 实现有两处，都在 `adapters/onebot/`：
 *   - `qq-api.ts` 的 `createQQApi()` —— 把字符串动作名与松散参数收敛成方法；
 *   - `platform.ts` 的 `platformOf()` —— 把一个 `OneBotClient` 包成 `ChatPlatform`。
 *
 * 为什么要这一层：业务代码原来拿着 `OneBotClient`——那是一个**传输对象**
 * （WebSocket、心跳、重连、echo 关联）。它出现在语录、表情包、提醒、生图的
 * 构造函数里，意味着"换掉 OneBot 协议"要改 12 个业务文件。有了端口之后，
 * 业务只认识 `QQApi` 的 34 个方法与 `isConnected()`；换协议只改适配器。
 *
 * 返回类型描述的是**各动作的 `data` 形状**，不是 OneBot 的应答信封：
 * `OneBotClient.call()` 成功时解析 `payload.data`、失败时 reject
 * （见 `onebot.ts` 的 `handleFrame`）。这一点写错过，代价见 B13——读
 * `result.data.message_id` 多读了一层，于是 sent-log 里 50 条记录的
 * `messageId` 全是 null。
 *
 * 过渡期的诚实说明：下面用了 `OneBotMessage`（`src/types.ts` 的线上消息段）
 * 作为消息参数类型。这是 P2 阶段"不改行为"的妥协——领域消息模型（OutSegment）
 * 要到 P3 才抽出来。端口里出现协议类型不理想，但它比"业务直接 import
 * OneBotClient"已经好了很多，而且换协议时这个文件是必须改的那一个。
 */

import type { OneBotMessage } from '../types.js'

/** 一次「不需要返回体」的动作（禁言、撤回、设名片……）。 */
export type ActionAck = unknown

/** 发送类动作的 `data`：`message_id` 用于后续引用/撤回。 */
export interface SendResult {
  message_id?: number
}

/** `get_msg` 关心的字段。 */
export interface FetchedMessage {
  message_id?: number
  message?: OneBotMessage
  raw_message?: string
  user_id?: number
  group_id?: number
  sender?: { user_id?: number; nickname?: string; card?: string }
}

/** `get_group_list` / `get_group_info` 的窄返回。 */
export interface GroupInfo {
  group_id?: number
  group_name?: string
  member_count?: number
  max_member_count?: number
}

export interface GroupMemberInfo {
  user_id?: number
  nickname?: string
  card?: string
  role?: string
  title?: string
  level?: string
  join_time?: number
  last_sent_time?: number
}

export interface FriendInfo {
  user_id?: number
  nickname?: string
  remark?: string
}

/** `get_login_info` 的窄返回（合并转发节点要机器人自己的昵称）。 */
export interface LoginInfo {
  user_id?: number
  nickname?: string
}

/** 合并转发的一个节点（SnowLuma / OneBot v11 的 `node` 段）。 */
export interface ForwardNode {
  type: 'node'
  data: {
    user_id?: number
    nickname?: string
    content: OneBotMessage
  }
}

/** 一条群/好友文件记录。 */
export interface FileEntry {
  file_id?: string
  file_name?: string
  file_size?: number
  busid?: number
  folder_id?: string
  file_url?: string
  upload_time?: number
}

export interface FileUrl {
  url?: string
}

export interface EssenceEntry {
  message_id?: number
  sender_id?: number
  sender_nick?: string
  operator_id?: number
  operator_nick?: string
  message_time?: number
}

/** 语音合成 / 获取的返回。 */
export interface RecordFile {
  file?: string
  url?: string
}

/** 合并转发展开后的一条。 */
export interface ForwardMsgItem {
  readonly content?: unknown
  readonly sender?: { readonly user_id?: number; readonly nickname?: string; readonly card?: string }
  readonly time?: number
}

export interface ForwardMsgBody {
  readonly messages?: readonly ForwardMsgItem[]
}

export interface StrangerInfo {
  readonly user_id?: number
  readonly nickname?: string
  readonly sex?: string
  readonly age?: number
  readonly long_nick?: string
  readonly qq_level?: number
  readonly level?: number
}

export interface GroupHonorInfo {
  readonly group_id?: number
  readonly current_talkative?: { readonly user_id?: number; readonly nickname?: string; readonly avatar?: string; readonly day_count?: number } | null
  readonly talkative_list?: readonly { readonly user_id?: number; readonly nickname?: string; readonly day_count?: number }[]
  readonly performer_list?: readonly { readonly user_id?: number; readonly nickname?: string }[]
  readonly legend_list?: readonly { readonly user_id?: number; readonly nickname?: string }[]
  readonly strong_newbie_list?: readonly { readonly user_id?: number; readonly nickname?: string }[]
  readonly emotion_list?: readonly { readonly user_id?: number; readonly nickname?: string }[]
}

export interface ImageFile {
  file?: string
  url?: string
  file_size?: string | number
}

/**
 * OneBot v11 动作门面。
 *
 * 每个方法的返回值都按 OneBot v11 的 `data` 形状声明；实现只做转发，
 * 参数与返回之间没有业务逻辑（不重试、不限速、不钳制取值范围——
 * 那些是出站层与守卫的事）。
 */
export interface QQApi {
  // ── 消息 ──────────────────────────────────────────────────────────────
  sendGroupMessage(groupId: number, message: OneBotMessage): Promise<SendResult>
  sendPrivateMessage(userId: number, message: OneBotMessage): Promise<SendResult>
  /**
   * 按 `isGroup` 二选一。
   *
   * 出站路径上到处都是同一个三元（语录、表情包、刷屏简报……），而且每写一遍
   * 就多一个把群号发进私聊的机会。收进一个方法，判断只出现在这里。
   */
  sendTo(isGroup: boolean, target: number, message: OneBotMessage): Promise<SendResult>
  getMessage(messageId: number): Promise<FetchedMessage>
  deleteMessage(messageId: number): Promise<ActionAck>
  /** 取图片的本地路径 / URL（NapCat 返回 `file`；部分实现返回 `url`）。 */
  getImage(file: string): Promise<ImageFile>
  /** 取语音文件；`outFormat` 决定转码格式（NapCat 的 `out_format`）。 */
  getRecord(messageId: number, outFormat?: string): Promise<RecordFile>
  /** 取任意文件（`file_id` 来自消息段）。 */
  getFile(fileId: string): Promise<RecordFile>
  /** 展开合并转发（消息段的 `forward` 只给容器 id）。 */
  getForwardMsg(forwardId: string): Promise<ForwardMsgBody>
  /** 陌生人资料（昵称/性别/等级/长签名）——门控通知与关系记忆用。 */
  getStrangerInfo(userId: number): Promise<StrangerInfo>
  /** 在线状态：标准档（1 在线 2 离开 …，协议端语义）与自定义文案。 */
  setOnlineStatus(status: number): Promise<ActionAck>
  setDiyOnlineStatus(faceId: number, content: string): Promise<ActionAck>
  /** 对群消息贴/撤一个表情回应。 */
  setGroupReaction(groupId: number, messageId: number, emojiId: string, remove?: boolean): Promise<ActionAck>
  /** 自定义表情：列表与发送（SnowLuma 无"上传自定义表情"接口）。 */
  fetchCustomFace(count?: number): Promise<{ faces?: Array<{ emoji_id?: string; emoji_name?: string; url?: string }> }>
  sendCustomFace(fileId: string, isGroup: boolean, target: number): Promise<ActionAck>
  /** 群荣誉（龙王/群聊之火/活跃新秀…）与 @ 全体剩余额度。 */
  getGroupHonorInfo(groupId: number, type?: string): Promise<GroupHonorInfo>
  getGroupAtAllRemain(groupId: number): Promise<{ can_at_all?: boolean; remain_at_all_count_for_group?: number; remain_at_all_count_for_uin?: number }>
  /** 好友请求 / 群邀请的批准与拒绝（`flag` 来自 request 事件）。 */
  setFriendAddRequest(flag: string, approve: boolean, remark?: string): Promise<ActionAck>
  setGroupAddRequest(flag: string, approve: boolean, reason?: string): Promise<ActionAck>
  /** 单向好友（对方列表里没有我）。 */
  getUnidirectionalFriendList(): Promise<{ list?: Array<{ user_id?: number; nickname?: string; source?: string }> }>
  /** URL 安全检查（出站链接安检）。 */
  checkUrlSafely(url: string): Promise<{ level?: number | string; message?: string }>
  /** 给某人点赞。 */
  sendLike(userId: number, times?: number): Promise<ActionAck>
  /**
   * OneBot `get_status`：一次**不产生消息**的往返，返回实现侧的健康标志。
   *
   * 为什么健康探针用它：端口探活只能证明"有东西在监听"，证明不了"消息发得出去"
   * （2026-10-19 事故：端口通了六个多小时，一条消息都发不出去）。`get_status`
   * 走的是同一条协议链路，能落在地上就说明这条链路还活着。
   */
  getStatus(): Promise<{ online?: boolean; good?: boolean }>

  // ── 交互提示（A1）────────────────────────────────────────────────────
  /**
   * 私聊「正在输入」。`eventType` 用 SnowLuma/NapCat 的约定：`1` 开始、`0` 取消。
   *
   * 这是**感知延迟**，不是消息：失败只在日志里留一行，绝不影响回合。
   */
  setInputStatus(userId: number, eventType: 0 | 1): Promise<ActionAck>
  /** 给一条消息贴/撤表情回应（`set_msg_emoji_like`；`emojiId` 是 QQ 表情 id 的字符串）。 */
  setMessageEmojiLike(messageId: number, emojiId: string, enable: boolean): Promise<ActionAck>
  /** 机器人自己的登录信息（合并转发节点要用昵称）。 */
  getLoginInfo(): Promise<LoginInfo>
  /** 合并转发（群/私聊各一个动作；节点内容在 `send` 之前由调用方拼好）。 */
  sendGroupForward(groupId: number, nodes: readonly ForwardNode[]): Promise<SendResult>
  sendPrivateForward(userId: number, nodes: readonly ForwardNode[]): Promise<SendResult>
  /**
   * 服务端消息历史（A4）。
   *
   * `messageId` 省略或 0 = 取最新；`reverseOrder` 只在有锚点时生效。
   * 返回的是 OneBot 消息事件对象数组，字段不固定（SnowLuma 原样透传）。
   */
  getGroupMsgHistory(groupId: number, count: number, messageId?: number, reverseOrder?: boolean): Promise<{ messages?: FetchedMessage[] }>
  getFriendMsgHistory(userId: number, count: number, messageId?: number, reverseOrder?: boolean): Promise<{ messages?: FetchedMessage[] }>
  /** 协议端语音转文字（SnowLuma `fetch_ptt_text`）；本地 STT 不可用时的兜底。 */
  getVoiceText(messageId: number): Promise<{ text?: string }>
  /** 服务端 OCR（SnowLuma `ocr_image`）：image 是 http(s) URL 或已缓存的图片 file_id。 */
  ocrImage(image: string): Promise<{ texts?: Array<{ text?: string }>; language?: string }>

  // ── 群信息 ────────────────────────────────────────────────────────────
  getGroupList(): Promise<GroupInfo[]>
  getGroupInfo(groupId: number): Promise<GroupInfo>
  getGroupMemberInfo(groupId: number, userId: number): Promise<GroupMemberInfo>
  getFriendList(): Promise<FriendInfo[]>

  // ── 群管理 ────────────────────────────────────────────────────────────
  setGroupBan(groupId: number, userId: number, durationSeconds: number): Promise<ActionAck>
  setGroupKick(groupId: number, userId: number, rejectAddRequest?: boolean): Promise<ActionAck>
  setGroupWholeBan(groupId: number, enable: boolean): Promise<ActionAck>
  setGroupAdmin(groupId: number, userId: number, enable: boolean): Promise<ActionAck>
  setGroupCard(groupId: number, userId: number, card: string): Promise<ActionAck>
  /** 戳一戳。 */
  groupPoke(groupId: number, userId: number): Promise<ActionAck>

  // ── 群精华 ────────────────────────────────────────────────────────────
  setEssence(messageId: number): Promise<ActionAck>
  deleteEssence(messageId: number): Promise<ActionAck>
  getEssenceList(groupId: number): Promise<EssenceEntry[]>

  // ── 群文件 ────────────────────────────────────────────────────────────
  getGroupRootFiles(groupId: number): Promise<{ files?: FileEntry[]; folders?: FileEntry[] }>
  getGroupFilesByFolder(groupId: number, folderId: string): Promise<{ files?: FileEntry[]; folders?: FileEntry[] }>
  getGroupFileUrl(groupId: number, fileId: string, busid?: number): Promise<FileUrl>
  uploadGroupFile(groupId: number, file: string, name: string, folderId?: string): Promise<ActionAck>
  /** `parentId` 省略即根目录（线上传的是字符串 `/`）。 */
  createGroupFileFolder(groupId: number, folderName: string, parentId?: string): Promise<ActionAck>
  /** 移动群文件：NapCat 要**当前**与**目标**两个目录，只给目标是不够的。 */
  moveGroupFile(
    groupId: number, fileId: string, currentParentDirectory: string, targetParentDirectory: string,
  ): Promise<ActionAck>
  /** 重命名同样要带当前目录。 */
  renameGroupFile(
    groupId: number, fileId: string, currentParentDirectory: string, newName: string,
  ): Promise<ActionAck>
  deleteGroupFile(groupId: number, fileId: string): Promise<ActionAck>

  // ── 私聊文件 ──────────────────────────────────────────────────────────
  getPrivateFileUrl(fileId: string): Promise<FileUrl>
  uploadPrivateFile(userId: number, file: string, name: string): Promise<ActionAck>

  // ── AI 语音（NapCat 扩展）────────────────────────────────────────────
  canSendRecord(): Promise<{ yes?: boolean }>
  /** 文字转语音（NapCat 扩展）；`groupId` 决定用哪个群的音色，返回可直接发送的 `file`。 */
  getAiRecord(groupId: number, character: string, text: string): Promise<RecordFile>
  sendGroupAiRecord(groupId: number, character: string, text: string): Promise<SendResult>
}

/**
 * 一个聊天平台。业务代码要的全部就是"能发消息"和"连上没有"。
 *
 * 刻意**不含** `reconnect` / `onEvent`：那两件事只有组合根（`index.ts`）
 * 与入站管线需要，把它们留给业务就是把传输细节又放回来了。
 */
export interface ChatPlatform {
  readonly api: QQApi
  /** 机器人自己的 QQ 号；未连上时为 null。 */
  readonly selfId: number | null
  isConnected(): boolean
}
