/** 管理后台的页面清单（信息架构的单一事实来源）。
 *
 * 侧边栏、hash 路由、`⌘K` 面板、以及"每个配置项落在哪一页"都从这里出发——
 * schema（`config/schema.ts`）只描述字段长什么样，页面归属由本文件与各字段的
 * `page` 元数据共同决定（见 内部文档 §4）。
 *
 * 为什么单独一个文件而不是写在前端：前端是**投影**，不是事实。新增一页 = 这里
 * 加一条 + 前端注册一个渲染器；服务端 `/api/schema` 直接从这份清单生成导航，
 * 于是"接口里有、导航里没有"这类不一致不会发生。
 *
 * `icon` 是前端 `dom.js` 里图标表的键名，不是 emoji——emoji 的宽度随平台漂移，
 * 会让布局探针的断言变得不可靠。
 */

export type PageKind = 'overview' | 'module' | 'system'

export interface AdminPage {
  /** hash 路由键：`#/module/<key>`、`#/system/<key>`、概览是 `#/overview`。 */
  key: string
  kind: PageKind
  title: string
  /** `src/admin/ui/dom.js` 的 ICONS 键名。 */
  icon: string
  /** 导航分组（同一组在侧栏里连续排列）。 */
  group?: string
  /** 一句话说明，显示在页头与导航的 title。 */
  blurb: string
}

export const ADMIN_PAGES: readonly AdminPage[] = [
  { key: 'overview', kind: 'overview', title: '概览', icon: 'grid', blurb: '状态总览 · 关键指标 · 快捷操作 · 最近错误' },

  // ── 模块（18 个）────────────────────────────────────────────────────────
  { key: 'connection', kind: 'module', group: '接入与消息', title: '连接与账号', icon: 'plug', blurb: 'OneBot 连接 · 机器人身份 · 工作区 · 访问令牌' },
  { key: 'groups', kind: 'module', group: '接入与消息', title: '群聊与房间', icon: 'chat', blurb: '群总开关 · @才回 / 概率 / 唤醒词 / 群聊模型' },
  { key: 'messages', kind: 'module', group: '接入与消息', title: '消息与回复', icon: 'mail', blurb: '分段与长度 · 攒批窗口 · 实时注入 · 上下文预算' },
  { key: 'media', kind: 'module', group: '接入与消息', title: '图片与语音', icon: 'image', blurb: '看图 · 语音识别 · TTS 音色与后端' },
  { key: 'stickers', kind: 'module', group: '接入与消息', title: '表情包', icon: 'smiley', blurb: '表情库（搜索/删除）· 偷取 · 配字制作' },
  { key: 'links', kind: 'module', group: '接入与消息', title: '链接与生图', icon: 'link', blurb: '链接解析（B站/网易云/GitHub/通用）· 生图后端' },
  { key: 'music', kind: 'module', group: '接入与消息', title: '音乐', icon: 'music', blurb: '点歌与歌单' },
  { key: 'quotes', kind: 'module', group: '接入与消息', title: '语录', icon: 'quote', blurb: '语录库 · 自动收录' },
  { key: 'learn', kind: 'module', group: '行为与记忆', title: '学习与口癖', icon: 'book', blurb: '口癖库 · 被动收集 · 统计' },
  { key: 'reminders', kind: 'module', group: '行为与记忆', title: '提醒', icon: 'bell', blurb: '待触发列表 · 历史' },
  { key: 'rss', kind: 'module', group: '行为与记忆', title: '订阅', icon: 'rss', blurb: 'RSS 源列表 · 轮询设置' },
  { key: 'flood', kind: 'module', group: '行为与记忆', title: '风控', icon: 'shield', blurb: '窗口与阈值 · 处置方式 · 豁免名单' },
  { key: 'events', kind: 'module', group: '行为与记忆', title: '群事件', icon: 'people', blurb: '监听类型 · 合并窗口 · 戳一戳' },
  { key: 'proactive', kind: 'module', group: '行为与记忆', title: '主动行为', icon: 'sunrise', blurb: '早报 · 巡航任务（工作区脚本）' },
  { key: 'memory', kind: 'module', group: '行为与记忆', title: '记忆', icon: 'brain', blurb: '记忆库 · 知识条目 · 日记' },
  { key: 'persona', kind: 'module', group: '智能体', title: '人格', icon: 'mask', blurb: '人格文件（AGENTS.md/MEMORY.md）· 预设 · 会话重建' },
  { key: 'tools', kind: 'module', group: '智能体', title: '工具与策略', icon: 'toolbox', blurb: '工具清单 · 高危群管开关 · 指令注入' },
  { key: 'skills', kind: 'module', group: '智能体', title: '技能', icon: 'book', blurb: '技能库 · 可见范围 · 导入与待审' },
  { key: 'kb', kind: 'module', group: '智能体', title: '知识库', icon: 'db', blurb: '用户资料摄取 · 集合与可见范围 · 带出处检索' },

  // ── 系统（7 个）────────────────────────────────────────────────────────
  { key: 'logs', kind: 'system', group: '系统', title: '日志', icon: 'filetext', blurb: '实时跟随 · 级别与模块过滤 · 错误聚合' },
  { key: 'metrics', kind: 'system', group: '系统', title: '指标', icon: 'chart', blurb: '耗时 · token · 工具失败率（采集在 P6）' },
  { key: 'audit', kind: 'system', group: '系统', title: '审计', icon: 'shieldcheck', blurb: '所有写操作（谁、何时、改了什么、结果）' },
  { key: 'backup', kind: 'system', group: '系统', title: '备份与恢复', icon: 'disk', blurb: '配置覆盖层 · 变更历史与回滚' },
  { key: 'security', kind: 'system', group: '系统', title: '安全', icon: 'lock', blurb: '密码与会话 · 危险能力 · 监听地址' },
  { key: 'runtime', kind: 'system', group: '系统', title: '运行信息', icon: 'gear', blurb: '版本 · 插件树 · 宿主信息' },
  { key: 'debug', kind: 'system', group: '系统', title: '调试', icon: 'flask', blurb: '原始快照 · 配置 diff · 强制重连' },
  { key: 'providers', kind: 'system', group: '系统', title: '模型供应商', icon: 'plug', blurb: '供应商列表 · 五档实测（含大请求）· 一键切换默认' },
]

const BY_KEY = new Map(ADMIN_PAGES.map((page) => [page.key, page]))

/** 全部页面键（路由合法性的判据）。 */
export function pageKeys(): string[] {
  return ADMIN_PAGES.map((page) => page.key)
}
