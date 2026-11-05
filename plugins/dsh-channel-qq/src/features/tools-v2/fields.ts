/** 工具面 v2 的字段字典：字段名 → JSON 类型与面向模型的说明。
 *
 * 新面的参数名**逐字沿用旧 spec**（"合并前后行为一致"靠这一点可证），所以这张
 * 表里的每个键都对应一个真实存在的旧字段；写错的键名会在类型检查（`FieldName`
 * 是这张表的键的联合）与对照测试里被抓住。说明文字只写"这个字段是什么"——
 * 人格称呼不在这里（工具描述人格中立的落点）。
 */

export interface FieldInfo {
  readonly type: 'string' | 'number' | 'boolean' | 'array'
  readonly description: string
  readonly items?: { readonly type: 'string' }
  readonly enum?: readonly string[]
}

export const FIELD = {
  // 提醒工具的建日程绑定用：宿主注入的当前会话 id（只在与本条提醒的房间一致时采信）。
  sessionId: { type: 'string', description: '可选：当前会话 id（宿主注入）。只在与本条提醒的房间一致时才用于建日程绑定，否则忽略。' },
  isGroup: { type: 'boolean', description: '是否发到群聊（false=私聊）；当前会话的归属见系统包里的【本会话是QQ群/私聊】标注，发错窗口是大事故' },
  target: { type: 'number', description: '群号或好友QQ号' },
  text: { type: 'string', description: '消息/回复正文' },
  phase: { type: 'string', enum: ['progress', 'final'], description: 'progress=慢任务前的一次等待提示，发送后继续执行工具；final=最终答复，省略时默认final' },
  messageId: { type: 'number', description: '消息#编号（来自上下文包或会话记录）' },
  code: { type: 'string', description: '完整代码内容' },
  note: { type: 'string', description: '一句话说明（视动作：代码用途 / 情景备注）' },
  groupId: { type: 'number', description: '群号' },
  userId: { type: 'number', description: '目标QQ号' },
  card: { type: 'string', description: '新群名片，空字符串删除名片' },
  duration: { type: 'number', description: '禁言秒数（60-300）' },
  enable: { type: 'boolean', description: 'true=开启/设为，false=关闭/取消' },
  rejectAddRequest: { type: 'boolean', description: '是否拒绝此人再次加群' },
  seconds: { type: 'number', description: '禁言秒数（60–2592000，越界会被夹住）' },
  folderId: { type: 'string', description: '文件夹ID，不填=根目录' },
  file: { type: 'string', description: '本地文件绝对路径' },
  name: { type: 'string', description: '显示名（文件名 / 歌名）' },
  artists: { type: 'string', description: '歌手（歌单 add 时可选）' },
  saveAs: { type: 'string', description: '保存的文件名，存到工作区 downloads/ 下' },
  folderName: { type: 'string', description: '文件夹名' },
  parentId: { type: 'string', description: '父文件夹ID，不填=根目录' },
  fileId: { type: 'string', description: '文件ID（来自文件列表或文件消息）' },
  currentParentDirectory: { type: 'string', description: '当前父目录ID（来自文件列表）' },
  targetParentDirectory: { type: 'string', description: '目标父目录ID' },
  newName: { type: 'string', description: '新文件名' },
  query: { type: 'string', description: '关键词（情绪/语义/文本）' },
  keyword: { type: 'string', description: '歌名或歌手' },
  key: { type: 'string', description: '扫码登录轮询时传 start 返回的 key' },
  limit: { type: 'number', description: '返回条数' },
  asOf: { type: 'string', description: '时间旅行（可选）：只要某天（YYYY-MM-DD）之前已知道的记忆' },
  senderId: { type: 'number', description: '按发送者QQ号过滤' },
  sinceDate: { type: 'string', description: '起始日期 YYYY-MM-DD（含）' },
  untilDate: { type: 'string', description: '结束日期 YYYY-MM-DD（含）' },
  times: { type: 'number', description: '点赞次数（≤10）' },
  url: { type: 'string', description: '链接/地址' },
  prompt: { type: 'string', description: '绘图提示词（建议英文，写清主体/风格/氛围）' },
  html: { type: 'string', description: '完整的HTML文档（会替换整个悬浮窗页面）' },
  delta: { type: 'number', description: '好感度变化值（-30~30）' },
  reason: { type: 'string', description: '原因一句话' },
  stage: { type: 'string', description: '目标阶段名（必须是阶梯里的名字）' },
  event: { type: 'string', description: '触发晋升的特殊事件描述（原文+时间）' },
  speaker: { type: 'string', description: '说话人昵称' },
  speakerId: { type: 'number', description: '说话人QQ号' },
  tags: { type: 'array', items: { type: 'string' }, description: '标签数组，便于以后检索' },
  tag: { type: 'string', description: '按标签过滤' },
  send: { type: 'boolean', description: 'false = 只返回不发送（默认 true）' },
  id: { type: 'string', description: '记录 id（从对应的 list / search 拿）' },
  when: { type: 'string', description: '什么时候提醒，如"明天9点"、"5分钟后"、"每天下午3点"' },
  at: { type: 'string', description: 'Unix 毫秒时间戳或 "YYYY-MM-DD HH:mm"' },
  repeat: { type: 'string', enum: ['none', 'daily', 'weekly'], description: '重复方式，默认 none' },
  createdBy: { type: 'number', description: '发起人QQ号' },
  content: { type: 'string', description: '一句话知识，写清楚人和事' },
  type: { type: 'string', description: '记忆类型：skill / fact / preference / event / person' },
  source: { type: 'string', description: '来源简述，如"群聊 2026-10-14"' },
  reinforce: { type: 'boolean', description: '是否强化命中条目（默认 true）' },
  remove: { type: 'boolean', description: 'true = 移出豁免名单，不传/false = 加入' },
  songId: { type: 'string', description: '网易云歌曲ID' },
  hash: { type: 'string', description: '歌曲hash（来自酷狗搜索）' },
  quality: { type: 'string', description: '音质（默认 auto）' },
  private: { type: 'boolean', description: 'true=私聊发送（默认群聊）' },
  voice: { type: 'string', description: '音色名（见 voices 动作）；不填用配置默认' },
  rate: { type: 'string', description: '语速，如 +10%' },
  pitch: { type: 'string', description: '音调，如 +20Hz' },
  volume: { type: 'string', description: '音量，如 +20%' },
  character: { type: 'string', description: 'QQ音色ID，如 ai_char_1' },
  image: { type: 'string', description: '本地图片绝对路径（png/jpg/gif/webp/bmp）' },
  top: { type: 'string', description: '上句文字，可空' },
  bottom: { type: 'string', description: '下句文字，可空' },
  fallbackRandom: { type: 'boolean', description: '搜不到时随机发一张（默认 false）' },
  op: { type: 'string', enum: ['add', 'remove', 'list', 'clear'], description: '歌单子动作：add / remove / list / clear（add 需要 songId 和 name）' },
} as const satisfies Record<string, FieldInfo>

export type FieldName = keyof typeof FIELD
