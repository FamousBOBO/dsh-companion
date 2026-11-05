/** 内容段：语录 / 口癖 / 提醒 / 订阅（page: quotes / learn / reminders / rss）。 */

import { b, json, n, s, type FieldGroup } from '../dsl.js'

/** 原话簿：按群按日保留原始消息流水（默认关）。 */
export interface ChatLogConfig {
  enabled: boolean
  /** Storage directory; null = <workspace>/chatlog. */
  dir: string | null
  /** 单条最多留多少字，超了截断并标注；0 表示不截。 */
  maxChars: number
  /** 保留天数；0 = 不清理。 */
  keepDays: number
}

export const CONTENT_GROUPS: FieldGroup[] = [
  {
    id: 'quotes',
    label: '群语录',
    page: 'quotes',
    fields: {
      enabled: b('启用', true, { hot: 'live' }),
      // 读法：QuoteStore 构造时把 <dir>/quotes.json 解析成固定路径 → 改目录要重启
      // （旧面板曾把这里标成"立即生效"，实际不会——这次如实标注）。
      dir: s('存储目录', null, { help: '留空 = <工作区>/quotes。改它需重启插件才换存储位置。', hot: 'restart' }),
      autoCapture: b('自动收录', false, { hot: 'live' }),
    },
  },
  {
    id: 'chatlog',
    label: '原话簿',
    page: 'quotes',
    fields: {
      // 读法：每条消息现取（live）；开启/关闭由 watches chatlog 重挂。
      enabled: b('启用', false, {
        hot: 'live',
        help: '默认关。打开后群聊与私聊的文本消息会原样追加到原话簿（按群按日），并注册 qq_group_digest 工具。',
      }),
      dir: s('存储目录', null, { help: '留空 = <工作区>/chatlog（刻意不在 memory/ 下，避免被切进记忆库）。', hot: 'live' }),
      maxChars: n('单条上限字数', 800, { min: 0, max: 10_000, hot: 'live', help: '超过截断并标注；0 表示不截。' }),
      keepDays: n('保留天数', 14, { min: 0, max: 365, hot: 'live', unit: '天', help: '0 = 不清理；跨天时执行一次清理。' }),
    },
  },
  {
    id: 'learn',
    label: '口癖学习',
    page: 'learn',
    fields: {
      enabled: b('启用', true, { hot: 'live' }),
      // 读法：LearnStore 构造时解析存储文件（restart）。
      file: s('存储文件', null, { help: '留空 = <工作区>/learned-phrases.json。改它需重启插件才换存储位置。', hot: 'restart' }),
      autoCapture: b('被动收集', true, { hot: 'live' }),
      slang: b('黑话词典工具', false, {
        hot: 'reload',
        help: '默认关。打开后多两个工具：qq_learn_word（记词条+释义）、qq_slang（查词条）。',
      }),
      minOccurrences: n('出现几次才推荐给模型', 3, { min: 1, max: 50, hot: 'live' }),
    },
  },
  {
    id: 'reminders',
    label: '提醒',
    page: 'reminders',
    fields: {
      enabled: b('启用', true, { hot: 'live' }),
      // 读法：ReminderStore 构造时解析存储文件（restart）。
      file: s('存储文件', null, { help: '留空 = <工作区>/reminders.json。改它需重启插件才换存储位置。', hot: 'restart' }),
      // P2.5-3A-3：灰度开关，默认 true（先跑通闸门与账本，再放开真发）。
      dryRun: b('演练模式（不真发）', true, {
        help: '打开时提醒照常到点、照常过闸门，但**不会真的发出去**（也不记账、不写 dispatched）。'
          + '默认打开 = 灰度起步；确认投递链路正常后再关掉。',
        hot: 'live',
      }),
    },
  },
  {
    id: 'rss',
    label: 'RSS',
    page: 'rss',
    fields: {
      // 读法：轮询器每 tick 现取 config.rss（含 pollIntervalMin，注释里写明"可热改"）；feeds 数组原地更新（live）。
      enabled: b('启用', true, { hot: 'live' }),
      pollIntervalMin: n('轮询间隔（分钟）', 15, { min: 1, max: 1440, hot: 'live' }),
      maxPerPoll: n('每轮每条最多推几条', 3, { min: 1, max: 20, hot: 'live' }),
      feeds: json('订阅列表', [], {
        help: '每条包含 id / url / room / target 等字段。', hot: 'live', idKey: 'id',
        itemFields: [
          { key: 'url', label: '地址', kind: 'string', placeholder: 'https://example.com/feed.xml' },
          { key: 'room', label: '去处', kind: 'enum', choices: [{ value: 'group', label: '群聊' }, { value: 'dm', label: '私聊' }] },
          { key: 'target', label: '目标', kind: 'number', help: '群号或好友 QQ 号' },
          { key: 'enabled', label: '启用', kind: 'boolean' },
          { key: 'title', label: '显示名', kind: 'string' },
        ],
      }),
    },
  },
]
