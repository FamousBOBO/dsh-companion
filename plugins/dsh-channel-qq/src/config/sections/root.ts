/** 顶层字段与"段"入口：**顺序即线上配置文件的键顺序**。
 *
 * `test/golden/config/resolved.txt` 逐字节比对 `resolveConfig` 的产物，而键顺序
 * 由这里决定（`Object.fromEntries` 保持插入顺序）。**往中间插一个键会让快照全红**
 * ——要加字段就加在原有字段旁边、并按需更新快照（在提交说明里逐条讲清楚）。
 */

import { b, json, list, n, NO_DEFAULT, s, section, type FieldSpec, type SectionFieldSpec } from '../dsl.js'

export const ROOT_ENTRIES: ReadonlyArray<readonly [string, FieldSpec | SectionFieldSpec]> = [
  // ── 连接 ────────────────────────────────────────────────────────────────
  ['connection', section('连接', 'connection')],
  ['selfId', n('机器人 QQ 号', 0, {
    help: '0 = 未知：NapCat 的连接生命周期事件里会带上真实值，这里是兜底。'
      + '只有拿不到生命周期事件（老版本协议端）时才需要手填。',
    hot: 'live', page: 'connection',
  })],
  ['admins', list('管理员 QQ 号', [], {
    help: '能用管理类工具的人；群风控里也永远豁免。',
    hot: 'live', page: 'connection', itemsKind: 'number',
  })],
  // 类型必须是 number：消费方全是 `chatId === primaryGroup` 这类严格比较，
  // 存成字符串会让它们**恒假**（2026-10-19 排查：线上实际值就是 "1000000004"）。
  ['primaryGroup', n('主群号', null, {
    help: '偷表情包 / 自动出卡 / 好感度都以它为准。',
    hot: 'live', page: 'groups',
  })],
  ['groupEnabled', b('处理群消息', true, {
    help: '总开关；关掉只影响群聊，私聊照常。',
    hot: 'live', page: 'groups',
  })],
  ['affectionPort', n('好感度面板端口', 8789, {
    help: '只听本机；0 关闭。', min: 0, max: 65_535,
    hot: 'reload', page: 'security', advanced: true,
  })],
  ['requireMention', b('群里必须 @ 才理', true, { hot: 'live', page: 'groups' })],
  ['talkValue', n('群聊回复概率', 0.6, { min: 0, max: 1, step: 0.05, hot: 'live', page: 'groups' })],
  ['primaryTalkValue', n('主群回复概率', NO_DEFAULT, {
    help: '留空表示与上面的概率相同。', min: 0, max: 1, step: 0.05,
    hot: 'live', page: 'groups',
  })],
  ['rooms', json('按群覆盖', NO_DEFAULT, {
    help: '数组：[{ id: 群号, enabled?, requireMention?, talkValue? }]，只写要覆盖的字段。'
      + '后台「群聊与房间」页可以搜索群号加入管理列表。注意它只是覆盖，不是白名单；'
      + '要限制哪些群能触发，用「安全 → 访问门控」的 allowGroups 或配对审批。',
    hot: 'live', page: 'groups',
  })],
  ['rateLimitMs', n('发送间隔', 300, {
    help: '两条消息之间至少等这么久（毫秒）。', min: 0, max: 10_000,
    hot: 'live', page: 'messages', unit: 'ms',
  })],
  // 读法：全仓没有消费者（B5：硬切分算法保留在 outbound.ts，但 length 守卫未接线）。
  // 照常可编辑并标 dormant，不谎称"立即生效"。
  ['maxMessageLength', n('单条消息上限', 4000, {
    help: '当前无消费者（等长切分未接线，见 D9）；接线后生效。', min: 100, max: 20_000,
    hot: 'live', page: 'messages', dormant: true,
  })],
  // ── 消息与群聊行为（段） ────────────────────────────────────────────────
  ['channelHealth', section('渠道健康告警', 'channelHealth')],
  ['segmentation', section('分段发送', 'segmentation')],
  ['batching', section('攒批', 'batching')],
  ['injectMode', section('实时注入', 'injectMode')],
  ['imageRecognition', section('看图', 'imageRecognition')],
  ['poke', section('戳一戳', 'poke')],
  ['interaction', section('交互提示', 'interaction')],
  ['forward', section('合并转发', 'forward')],
  ['metrics', section('指标采集', 'metrics')],
  ['history', section('服务端历史', 'history')],
  ['reliability', section('回合告知', 'reliability')],
  ['dailyReport', section('群日报', 'dailyReport')],
  ['access', section('访问门控', 'access')],
  ['stt', section('语音转文字', 'stt')],
  ['groupModel', section('群聊模型', 'groupModel')],
  ['keywordTriggers', list('唤醒关键词', [], {
    help: '除 @ 之外，命中这些词也会理。', hot: 'live', page: 'groups', itemsKind: 'string',
  })],
  // ── 定时与内容 ──────────────────────────────────────────────────────────
  ['morningReport', section('每日早报', 'morningReport')],
  // 读法：Scheduler 在 start() 里一次性排期（config.cruises 的增删/间隔改动要重启才重新排）。
  ['cruises', json('巡航任务', [], {
    help: '定时跑工作区里的脚本并把结果报回来。**后台默认禁止修改**——它等于远程执行代码。',
    hot: 'restart', page: 'proactive', idKey: 'id',
    itemFields: [
      { key: 'id', label: '任务 id', kind: 'string', placeholder: 'heartbeat' },
      { key: 'script', label: '脚本', kind: 'string', placeholder: 'node scripts/a.mjs', help: '脚本必须放在 workspace/scripts/ 下；以 argv 直 exec，不经 shell' },
      { key: 'intervalMin', label: '间隔（分钟）', kind: 'number' },
      { key: 'enabled', label: '启用', kind: 'boolean' },
    ],
  })],
  ['keywordReactions', json('关键词反应', [], {
    help: '命中关键词时直接回一句固定的话（不经过模型）。', hot: 'live', page: 'groups',
    itemFields: [
      { key: 'keywords', label: '关键词', kind: 'list', help: '逗号分隔，命中其中一个即触发' },
      { key: 'reaction', label: '反应', kind: 'string', placeholder: '先安抚再问细节' },
    ],
  })],
  ['workspacePath', s('工作区路径', null, {
    help: '机器人读写文件、跑巡航脚本的根目录。改动决定已有会话的归属，需重启插件。',
    hot: 'restart', page: 'connection',
  })],
  ['agentPreset', s('人格预设', 'standard', { hot: 'live', page: 'persona' })],
  ['permissionPreset', s('权限预设', 'workspace-write', { hot: 'live', page: 'persona' })],
  ['accessToken', s('访问令牌', NO_DEFAULT, {
    help: '连 NapCat 的 Bearer token；空表示不鉴权。', secret: true, hot: 'reload', page: 'connection',
  })],
  // ── 各功能段 ────────────────────────────────────────────────────────────
  ['emoji', section('表情包', 'emoji')],
  ['admin', section('管理后台', 'admin')],
  ['linkResolve', section('链接卡片', 'linkResolve')],
  ['meme', section('表情包制作', 'meme')],
  ['quotes', section('群语录', 'quotes')],
  ['chatlog', section('原话簿', 'chatlog')],
  ['tts', section('语音合成', 'tts')],
  ['reminders', section('提醒', 'reminders')],
  ['rss', section('RSS', 'rss')],
  ['flood', section('刷屏风控', 'flood')],
  ['imageGen', section('生图', 'imageGen')],
  ['learn', section('口癖学习', 'learn')],
  ['memory', section('记忆', 'memory')],
  ['people', section('人物档', 'people')],
  ['music', section('音乐', 'music')],
  ['skills', section('技能', 'skills')],
  ['kb', section('知识库', 'kb')],
  ['eventMonitor', section('群事件', 'eventMonitor')],
  ['context', section('上下文', 'context')],
  ['turn', section('回合', 'turn')],
  ['sessionReset', section('会话换血', 'sessionReset')],
  ['planner', section('群聊准入（要不要说话）', 'planner')],
  ['contextBudget', section('上下文预算', 'contextBudget')],
  ['groupAdmin', section('高危群管', 'groupAdmin')],
  ['policy', section('策略与信任', 'policy')],
  ['tools', section('工具面', 'tools')],
  ['proactive', section('主动行为（事件书）', 'proactive')],
  // A2 主动消息：门控阈值与两道发送授权（默认全关）。**追加在末尾**——键顺序就是
  // 线上配置键顺序，往中间插一行会让 golden 快照的 diff 面从"尾部多一段"变成"整份重排"。
  ['contact', section('主动消息', 'contact')],
  ['debug', b('调试日志', false, { hot: 'live', page: 'logs' })],
  // Group sessions may use a separate capability surface and workspace.
  ['groupAgentPreset', s('群聊人格预设', null, { hot: 'restart', page: 'persona' })],
  ['groupPermissionPreset', s('群聊权限预设', null, { hot: 'restart', page: 'persona' })],
  ['groupWorkspacePath', s('群聊工作区', null, { hot: 'restart', page: 'connection' })],
  // 点歌翻唱（B站 → RVC 音色 → 语音条）：插在 `presence` **之前**——`presence` 的测试钉着
  // "它必须是最后一个段"（那条不变式的意思是"新段追加在它之后会打乱它自己的键位记录"）。
  // 放在它前面，尾部仍然只有"多一段"这一处 diff，不重排既有键。
  ['song', section('点歌翻唱', 'song')],
  // 群聊旁听与自主接话：**追加在末尾**——键顺序就是线上配置键顺序，往中间插一行
  // 会让 golden 快照的 diff 面从"尾部多一段"变成"整份重排"。
  ['presence', section('群聊旁听与接话', 'presence')],
]
