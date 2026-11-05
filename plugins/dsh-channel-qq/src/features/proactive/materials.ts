/** 早报素材（P6f）：从 `events.ts` 的私有方法**原样搬出**——旧调度器与事件书
 * v2 的 prompt 事件（`materials: [...]`）共用同一份实现，行为一字未改。
 *
 * 素材全可缺省（没有课表、没有城市、没有主群都不挡早报）；每一项的来源与格式
 * 与从前一致：课表=工作区里的相对文件（截 500 字）、天气=wttr.in 当前实况
 * （查不到写"查询失败"）、昨天活跃=数 `channel-qq.log` 里的 turn 行。
 */

import * as path from 'node:path'
import type { MorningReportConfig } from '../../config.js'
import { systemHttp } from '../../adapters/http/client.js'
import type { MaterialName } from '../../core/schedule/event-book.js'

export interface MaterialInput {
  readonly now: Date
  readonly today: string
  readonly settings: MorningReportConfig
  /** 工作区根；null / '' 与旧实现的 `opts.workspace ?? ''` 同义（课表按它解析）。 */
  readonly workspace: string | null
  readonly dshHome: string
  readonly primaryGroup: number | null
}

export interface MorningMaterial {
  /** 组装好的素材正文（旧格式：日期 / 课表 / 天气 / 昨天活跃，缺的整行省略）。 */
  readonly material: string
  /** 天气原文（空串 = 没配/没查到值）；早报日志用。 */
  readonly weather: string
  /** 课表原文（空串 = 没配/没读到）；早报日志用。 */
  readonly schedule: string
}

interface MaterialPieces {
  date: string
  weather: string
  schedule: string
  activity: string | null
}

/**
 * "昨天群里多热闹" —— 从 `channel-qq.log` 数 `turn done for group-<id>` 行。
 *
 * 日志本来就为每个 agent 回合记一行，复用它给早报一个真实信号，不引入第二份
 * 可能与事实漂移的状态。文件不在/读不了返回 null（早报里整行省略）。
 */
export async function yesterdayActivity(today: string, dshHome: string, primaryGroup: number | null): Promise<string | null> {
  const group = primaryGroup
  if (group === null) return null
  try {
    const fsMod = await import('node:fs/promises')
    const raw = await fsMod.readFile(path.join(dshHome, 'channel-qq.log'), 'utf-8')
    // Log stamps come in two shapes: the original `...Z` (UTC, from
    // `toISOString`) and the current `...+08:00` (local, from `localStamp`).
    // `line.slice(0, 24)` cut the offset off, so every legacy line was parsed
    // as *local* and landed 8 hours off — the window below then counted the
    // wrong day. Parse the whole stamp, offset included.
    const STAMP = /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))/
    const from = new Date(`${today}T00:00:00`).getTime() - 86_400_000
    const until = from + 86_400_000
    let turns = 0
    for (const line of raw.split('\n')) {
      if (!line.includes(`turn done for group-${group}`)) continue
      const match = STAMP.exec(line)
      if (match === null) continue
      // 捕获组一定参与匹配（`match[1]` 实际总是有值）；这里只是把类型收窄，
      // 不改行为——noUncheckedIndexedAccess 下数组下标一律是 `T | undefined`。
      const stampText = match[1]
      if (stampText === undefined) continue
      const stamp = Date.parse(stampText)
      if (Number.isNaN(stamp)) continue
      if (stamp >= from && stamp < until) turns += 1
    }
    return turns === 0
      ? '昨天主群很安静（机器人一轮都没被叫起来）'
      : `昨天主群挺热闹：机器人参与了约 ${turns} 轮`
  } catch {
    return null
  }
}

async function readSchedule(settings: MorningReportConfig, workspace: string | null): Promise<string> {
  if (settings.scheduleFile === null) return ''
  try {
    const fsMod = await import('node:fs/promises')
    return (await fsMod.readFile(path.join(workspace ?? '', settings.scheduleFile), 'utf-8')).trim()
  } catch {
    return ''
  }
}

async function fetchWeather(settings: MorningReportConfig): Promise<string> {
  if (settings.weatherLocation === null) return ''
  try {
    const url = `https://wttr.in/${encodeURIComponent(settings.weatherLocation)}?format=j1`
    const res = await systemHttp.request(url, { timeoutMs: 10_000 })
    const j = res.json<{ current_condition?: Array<{ temp_C?: string; weatherDesc?: Array<{ value?: string }>; hourly?: Array<{ chanceofrain?: string }> }> }>()
    const cur = j.current_condition?.[0]
    if (cur) {
      const rain = cur.hourly?.[0]?.chanceofrain ?? '0'
      return `${cur.temp_C}°C ${cur.weatherDesc?.[0]?.value ?? ''}，降雨概率 ${rain}%`
    }
    return ''
  } catch {
    return '查询失败'
  }
}

/** 只取被点名的素材（没点名的不读文件、不发 HTTP）。 */
async function collectPieces(input: MaterialInput, names: readonly MaterialName[]): Promise<MaterialPieces> {
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const dayName = days[input.now.getDay()] ?? ''
  const schedule = names.includes('schedule') ? await readSchedule(input.settings, input.workspace) : ''
  const weather = names.includes('weather') ? await fetchWeather(input.settings) : ''
  const activity = names.includes('yesterday-activity')
    ? await yesterdayActivity(input.today, input.dshHome, input.primaryGroup)
    : null
  return { date: `日期：${input.today} ${dayName}`, weather, schedule, activity }
}

/** 素材行；空内容返回 null（整行省略，与旧实现里 `.filter(...)` 的效果一致）。 */
function materialLine(name: MaterialName, pieces: MaterialPieces): string | null {
  if (name === 'date') return pieces.date
  if (name === 'schedule') return pieces.schedule !== '' ? `今日课表/安排：\n${pieces.schedule.slice(0, 500)}` : null
  if (name === 'weather') return pieces.weather !== '' ? `今日天气：${pieces.weather}` : null
  return pieces.activity
}

/** 按书里给的顺序组装素材正文（缺的整行省略）。 */
export async function collectMaterials(names: readonly MaterialName[], input: MaterialInput): Promise<string> {
  const pieces = await collectPieces(input, names)
  return names
    .map((name) => materialLine(name, pieces))
    .filter((line): line is string => line !== null)
    .join('\n')
}

/** 旧调度器的入口（事件书默认书里的 materials 顺序与之逐字对齐）。 */
export async function collectMorningMaterial(input: MaterialInput): Promise<MorningMaterial> {
  const names: readonly MaterialName[] = ['date', 'schedule', 'weather', 'yesterday-activity']
  const pieces = await collectPieces(input, names)
  return {
    material: names
      .map((name) => materialLine(name, pieces))
      .filter((line): line is string => line !== null)
      .join('\n'),
    weather: pieces.weather,
    schedule: pieces.schedule,
  }
}
