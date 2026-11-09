/**
 * `core/schedule/wall-clock.ts` 的时区显式性测试：提醒的墙上时间只属于
 * `REMINDER_ZONE`（Asia/Shanghai），**与宿主进程的 `TZ` 无关**。
 *
 * 为什么需要这份测试：事故那条提醒是 QQ 上定的 `2026-11-09 23:40`。那天宿主恰好
 * 也在 +08:00，所以旧实现（`new Date(y, m, d, h, min)` 读隐式本地时区）没暴露问题——
 * 换一台 `TZ=UTC` 的机器，同一条提醒会落到 07:40（上海时间）的早上。本文件钉住的
 * 就是"这件事不可能再发生"。
 *
 * ## 宿主时区独立性怎么测（以及为什么这么测）
 *
 * 要求是"在模块被 import **之前**把 `process.env.TZ` 设成别的时区，断言仍成立"。
 * 这里用**子进程**（`node --input-type=module -e ...`，`env.TZ` 指定时区，模块在子
 * 进程里才第一次被 import）而不是在本进程里改 `process.env.TZ` + 查询串破缓存，原因：
 *
 *   1. 本进程里改 `TZ` 是**全局副作用**：`node --test` 可能把多个测试文件放进同一个
 *      进程，改完之后别的文件（尤其 `golden.test.ts`，它自己也设 `TZ`）会受影响；
 *   2. V8/ICU 对时区有内部缓存，本进程里"先 import 再改 TZ"得到的结论只对这一段代码
 *      成立，而子进程的 `env.TZ` 是**进程启动时**就生效的，与线上换机器等价；
 *   3. 子进程天然隔离：一个断言挂了不会污染其它用例。
 *
 * 代价是每次要起一个 node 进程（几十毫秒）。为了让"子进程真的换了时区"可证伪，
 * 子进程里同时输出 `new Date(2026, 10, 9, 23, 40).getTime()`（旧的隐式本地写法）与
 * `getTimezoneOffset()`：前者在非 +08:00 的时区**必须**与事故瞬间不同，否则说明
 * 这个测试什么也没测到。
 *
 * ## `qq_remind_at` 的工具层覆盖
 *
 * `parseAt()` 不是导出函数，但工具面的脚架足够便宜（内存里的 `ReminderStore` +
 * 假 `ctx.tools.register`，落在 `os.tmpdir()` 下的临时目录），所以这里**真的**走
 * `registerReminderTools` → `qq_remind_at`，而不是只测 `parseAt` 的等价物：
 *   - 墙上时间写法按 `REMINDER_ZONE` 解释（含"宿主 TZ 变了也不变"）；
 *   - 10 位 epoch 当秒、13 位当毫秒；
 *   - 认不出的写法回 `ok:false`（不是抛错、也不是瞎猜一个时间）。
 *
 * 纪律：node:test + assert/strict；不连网、不碰真 QQ、不写 `os.tmpdir()` 以外的地方。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import {
  REMINDER_ZONE, epochToWallClock, legacyDateYear, offsetMsAt, shiftWallDays, wallClockToEpoch, wallDayIndex,
  type WallClock,
} from '../src/core/schedule/wall-clock.js'
import { parseWhen } from '../src/features/reminders/parse-when.js'
import { ReminderStore } from '../src/features/reminders/store.js'
import { registerReminderTools } from '../src/features/reminders/tools.js'
import { configureAgendaPort } from '../src/features/reminders/agenda-seam.js'

/** 事故那条提醒的瞬间：`2026-11-09 23:40`（+08:00）= `2026-11-09T15:40Z`。 */
const INCIDENT_AT = 1794238800000
/** 用例里当作"现在"的瞬间：`2026-11-09 20:00`（+08:00）。 */
const NOW_AT = 1794225600000

const SHANGHAI = 'Asia/Shanghai'

/** 四个时区：无夏令时的提醒时区、UTC、有夏令时的北美与欧洲。 */
const ZONES = [SHANGHAI, 'UTC', 'America/New_York', 'Europe/Berlin'] as const

/** 一个墙上时间的紧凑写法，断言失败时读得懂（`2026-11-09 23:40:00 周一`）。 */
const label = (wall: WallClock | null): string => wall === null ? 'null'
  : `${String(wall.year)}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')} `
    + `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}:${String(wall.second).padStart(2, '0')} `
    + `周${'日一二三四五六'[wall.weekday]}`

// ── 1. 事故瞬间本身 ─────────────────────────────────────────────────────────

test('事故瞬间：wallClockToEpoch(2026-11-09 23:40, Asia/Shanghai) = 1794238800000', () => {
  assert.equal(REMINDER_ZONE, SHANGHAI, '提醒时区必须显式写死为 Asia/Shanghai')
  assert.equal(
    wallClockToEpoch({ year: 2026, month: 11, day: 9, hour: 23, minute: 40 }, SHANGHAI),
    INCIDENT_AT,
  )
  // `second` 省略时按 0；显式给 0 结果相同。
  assert.equal(
    wallClockToEpoch({ year: 2026, month: 11, day: 9, hour: 23, minute: 40, second: 0 }, SHANGHAI),
    INCIDENT_AT,
  )
})

test('逆变换：epochToWallClock(1794238800000, Asia/Shanghai) 回到 23:40 周一', () => {
  assert.deepEqual(epochToWallClock(INCIDENT_AT, SHANGHAI), {
    year: 2026, month: 11, day: 9, hour: 23, minute: 40, second: 0, weekday: 1,
  })
})

test('offsetMsAt：东八区 +8h、UTC 0、北美/欧洲按各自夏令时', () => {
  assert.equal(offsetMsAt(INCIDENT_AT, SHANGHAI), 8 * 3_600_000)
  assert.equal(offsetMsAt(INCIDENT_AT, 'UTC'), 0)
  assert.equal(offsetMsAt(INCIDENT_AT, 'America/New_York'), -5 * 3_600_000)
  assert.equal(offsetMsAt(Date.parse('2026-07-01T12:00:00Z'), 'America/New_York'), -4 * 3_600_000)
  assert.equal(offsetMsAt(Date.parse('2026-01-15T12:00:00Z'), 'Europe/Berlin'), 1 * 3_600_000)
  assert.equal(offsetMsAt(Date.parse('2026-07-01T12:00:00Z'), 'Europe/Berlin'), 2 * 3_600_000)
})

// ── 2. 往返：跨年、00:00、23:59、2028-02-29 ─────────────────────────────────

/** 一批"容易算错"的瞬间：跨年两侧、日界两侧、闰日、夏令时切换附近。 */
const SPREAD: ReadonlyArray<{ at: number; why: string }> = [
  { at: INCIDENT_AT, why: '事故瞬间' },
  { at: Date.parse('2026-12-31T15:59:00Z'), why: '上海 2026-12-31 23:59' },
  { at: Date.parse('2026-12-31T16:00:00Z'), why: '上海 2027-01-01 00:00（跨年）' },
  { at: Date.parse('2026-12-31T23:59:00Z'), why: 'UTC 年末最后一分钟' },
  { at: Date.parse('2027-01-01T00:00:00Z'), why: 'UTC 新年第一分钟' },
  { at: Date.parse('2028-02-28T16:00:00Z'), why: '上海 2028-02-29 00:00（闰日）' },
  { at: Date.parse('2026-03-08T07:00:00Z'), why: '纽约夏令时开跳后' },
  { at: Date.parse('2026-11-01T05:30:00Z'), why: '纽约夏令时回拨（重复的一小时）' },
  { at: 0, why: 'epoch 原点' },
]

test('往返：四个时区 × 一批边界瞬间，wall→epoch→wall 与 epoch→wall→epoch 都回到原地', () => {
  for (const zone of ZONES) {
    for (const { at, why } of SPREAD) {
      const wall = epochToWallClock(at, zone)
      assert.notEqual(wall, null, `${zone} / ${why}：应当能算出墙上时间`)
      const back = wallClockToEpoch({ ...wall! }, zone)
      assert.equal(back, at, `${zone} / ${why}：wall→epoch 没回到原瞬间（${label(wall)}）`)
      const again = epochToWallClock(back!, zone)
      assert.deepEqual(again, wall, `${zone} / ${why}：epoch→wall 不稳定`)
    }
  }
})

test('闰日与日界：2028-02-29 是周二，2026-11-09 23:59 与 11-10 00:00 差一分钟', () => {
  assert.equal(wallClockToEpoch({ year: 2028, month: 2, day: 29, hour: 0, minute: 0 }, SHANGHAI), 1835366400000)
  assert.equal(epochToWallClock(1835366400000, SHANGHAI)?.weekday, 2, '2028-02-29 是周二')
  const lastMinute = wallClockToEpoch({ year: 2026, month: 11, day: 9, hour: 23, minute: 59 }, SHANGHAI)
  const midnight = wallClockToEpoch({ year: 2026, month: 11, day: 10, hour: 0, minute: 0 }, SHANGHAI)
  assert.equal(midnight! - lastMinute!, 60_000)
})

test('wallDayIndex 只用于"差几天"：相邻两天正好差 1', () => {
  assert.equal(wallDayIndex({ year: 2026, month: 11, day: 10 }) - wallDayIndex({ year: 2026, month: 11, day: 9 }), 1)
  assert.equal(wallDayIndex({ year: 2027, month: 1, day: 1 }) - wallDayIndex({ year: 2026, month: 12, day: 31 }), 1)
})

test('shiftWallDays：沿墙上日历推一天，跨夏令时那天不漂小时', () => {
  // 上海：+1 天正好 +24h（无夏令时）。
  assert.equal(shiftWallDays(INCIDENT_AT, 1, SHANGHAI), INCIDENT_AT + 86_400_000)
  assert.equal(epochToWallClock(shiftWallDays(INCIDENT_AT, 1, SHANGHAI)!, SHANGHAI)?.hour, 23)
  // 纽约：2026-03-07 09:00 → 03-08 09:00 那天只有 23 小时，但**墙上小时不变**。
  const nyBefore = wallClockToEpoch({ year: 2026, month: 3, day: 7, hour: 9, minute: 0 }, 'America/New_York')!
  const nyAfter = shiftWallDays(nyBefore, 1, 'America/New_York')!
  assert.equal(epochToWallClock(nyAfter, 'America/New_York')?.hour, 9, '墙上 9 点必须还是 9 点')
  assert.equal(epochToWallClock(nyAfter, 'America/New_York')?.day, 8)
  assert.equal(nyAfter - nyBefore, 23 * 3_600_000, '这一天只有 23 小时')
  // 推到夏令时空洞里 ⇒ null（不就近取）：纽约 03-07 02:30 +1 天 = 03-08 02:30（不存在）。
  const nyGapSource = wallClockToEpoch({ year: 2026, month: 3, day: 7, hour: 2, minute: 30 }, 'America/New_York')!
  assert.equal(shiftWallDays(nyGapSource, 1, 'America/New_York'), null)
  assert.equal(shiftWallDays(nyGapSource, 0, 'America/New_York'), nyGapSource, '推 0 天就是原地')
})

// ── 3. 算不出来就返回 null，绝不换一个瞬间 ──────────────────────────────────

test('未知时区 ⇒ null（不抛错、不退回宿主时区）', () => {
  assert.equal(wallClockToEpoch({ year: 2026, month: 11, day: 9, hour: 23, minute: 40 }, 'Not/AZone'), null)
  assert.equal(epochToWallClock(INCIDENT_AT, 'Not/AZone'), null)
  assert.equal(offsetMsAt(INCIDENT_AT, 'Not/AZone'), null)
})

test('非法分量 / 非法瞬间 ⇒ null', () => {
  assert.equal(wallClockToEpoch({ year: Number.NaN, month: 11, day: 9, hour: 23, minute: 40 }, SHANGHAI), null)
  assert.equal(wallClockToEpoch({ year: 2026, month: 11, day: 9, hour: Number.POSITIVE_INFINITY, minute: 40 }, SHANGHAI), null)
  assert.equal(epochToWallClock(Number.NaN, SHANGHAI), null)
  assert.equal(epochToWallClock(9e15, SHANGHAI), null, '超出 Date 可表示范围的瞬间没有墙上时间')
})

test('夏令时跳变：墙上不存在的那一小时 ⇒ null（纽约 2026-03-08 02:30、柏林 2026-03-29 02:30）', () => {
  assert.equal(wallClockToEpoch({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York'), null)
  assert.equal(wallClockToEpoch({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, 'Europe/Berlin'), null)
  // 跳变前一分钟与后一分钟都在，且正好相差一分钟的墙上时间（不是一小时）。
  const before = wallClockToEpoch({ year: 2026, month: 3, day: 8, hour: 1, minute: 59 }, 'America/New_York')
  const after = wallClockToEpoch({ year: 2026, month: 3, day: 8, hour: 3, minute: 0 }, 'America/New_York')
  assert.equal(before, Date.parse('2026-03-08T06:59:00Z'))
  assert.equal(after, Date.parse('2026-03-08T07:00:00Z'))
})

test('夏令时回拨：重复的那一小时取较早一次（有文档、不是随机选）', () => {
  // 2026-11-01 01:30 在纽约出现两次：05:30Z（EDT）与 06:30Z（EST）。
  assert.equal(
    wallClockToEpoch({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York'),
    Date.parse('2026-11-01T05:30:00Z'),
  )
})

test('分量越界按 Date 的进位归一化（**故意**与旧实现 bug 兼容）', () => {
  // 旧写法 `new Date(2027, 1, 30, 9, 0)` 在 +08:00 上得到 2027-03-02 09:00。
  const normalized = wallClockToEpoch({ year: 2027, month: 2, day: 30, hour: 9, minute: 0 }, SHANGHAI)
  assert.deepEqual(epochToWallClock(normalized!, SHANGHAI)?.month, 3)
  assert.deepEqual(epochToWallClock(normalized!, SHANGHAI)?.day, 2)
  // `24:00` = 次日 00:00（parse-when 的"晚上24点"退化成 12 点后不会再走到这里，
  // 但 `qq_remind_at` 的裸正则可以）。
  assert.equal(
    wallClockToEpoch({ year: 2026, month: 11, day: 9, hour: 24, minute: 0 }, SHANGHAI),
    wallClockToEpoch({ year: 2026, month: 11, day: 10, hour: 0, minute: 0 }, SHANGHAI),
  )
})

test('两位年份：换算器不收编 `new Date` 的 1900+y 规则，由调用方套 legacyDateYear()', () => {
  // 换算器本身：公元 50 年就是公元 50 年。
  assert.equal(epochToWallClock(wallClockToEpoch({ year: 50, month: 6, day: 15, hour: 8, minute: 0 }, SHANGHAI)!, SHANGHAI)?.year, 50)
  // 旧实现的隐式规则（`new Date(50, 5, 15, 8, 0)` = 1950）由这个助手显式给出。
  assert.equal(legacyDateYear(50), 1950)
  assert.equal(legacyDateYear(0), 1900)
  assert.equal(legacyDateYear(99), 1999)
  assert.equal(legacyDateYear(100), 100, '三位以上年份原样返回')
  assert.equal(legacyDateYear(2026), 2026)
  // 提醒解析器**保持旧行为**：`0050-06-15 08:00` 仍然落在 1950-06-15 08:00（+08:00）。
  assert.deepEqual(parseWhen('0050-06-15 08:00', new Date(NOW_AT))?.at, Date.parse('1950-06-15T08:00:00+08:00'))
})

// ── 4. 宿主 TZ 独立性（子进程）───────────────────────────────────────────────
/** 子进程要 import 的四个模块（绝对 file URL：子进程的 cwd 与这里无关）。 */
const WALL_CLOCK_URL = new URL('../src/core/schedule/wall-clock.js', import.meta.url).href
const PARSE_WHEN_URL = new URL('../src/features/reminders/parse-when.js', import.meta.url).href
const TOOLS_URL = new URL('../src/features/reminders/tools.js', import.meta.url).href
const STORE_URL = new URL('../src/features/reminders/store.js', import.meta.url).href
/** `qq_remind_at` 在 `2030-06-15 09:30`（Asia/Shanghai）上落到的瞬间。 */
const TOOL_AT = 1907717400000

/**
 * 子进程里跑的一段探针：`process.env.TZ` 由 `spawnSync` 的 `env` 在**进程启动时**
 * 给定，模块因此是"在宿主时区已经是那个值之后"才被 import 的。
 *
 * 顺带把**工具层**也放进来：`qq_remind_at` 的 `"YYYY-MM-DD HH:mm"` 在子进程里也走
 * 一遍（临时目录 + 内存 store，约 50ms），这样"工具层不依赖宿主 TZ"也是被证明的，
 * 而不只是"纯函数不依赖"。
 */
const CHILD_SOURCE = `
const { mkdtempSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const path = await import('node:path')
const wc = await import(${JSON.stringify(WALL_CLOCK_URL)})
const pw = await import(${JSON.stringify(PARSE_WHEN_URL)})
const { registerReminderTools } = await import(${JSON.stringify(TOOLS_URL)})
const { ReminderStore } = await import(${JSON.stringify(STORE_URL)})
const now = new Date(${String(NOW_AT)})
const wall = (parts) => wc.wallClockToEpoch(parts, wc.REMINDER_ZONE)

const dir = mkdtempSync(path.join(tmpdir(), 'tz-wallclock-child-'))
let toolAt = null
try {
  const config = { primaryGroup: 1, reminders: { enabled: true, dryRun: false, file: null } }
  const store = new ReminderStore(config.reminders, { workspacePath: dir, dshHome: dir, log: () => {} })
  await store.load()
  const specs = []
  registerReminderTools({ tools: { register: (d) => { specs.push(d); return () => {} } } }, config, {}, {}, () => {}, store)
  const spec = specs.find((s) => s.name === 'qq_remind_at')
  const result = await spec.execute({ at: '2030-06-15 09:30', text: 'x', isGroup: false, target: 10001 })
  toolAt = result.ok === true && result.reminder ? result.reminder.at : { failed: result }
  await store.close()
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(JSON.stringify({
  tz: process.env.TZ ?? '',
  hostOffsetMin: new Date(${String(INCIDENT_AT)}).getTimezoneOffset(),
  incident: wall({ year: 2026, month: 11, day: 9, hour: 23, minute: 40 }),
  incidentWall: wc.epochToWallClock(${String(INCIDENT_AT)}, wc.REMINDER_ZONE),
  absolute: pw.parseWhen('2026-11-09 23:40', now),
  tomorrow: pw.parseWhen('明天9点', now),
  relative: pw.parseWhen('5分钟后', now),
  toolAt,
  naive: new Date(2026, 10, 9, 23, 40).getTime(),
}))
`

interface ChildReport {
  readonly tz: string
  readonly hostOffsetMin: number
  readonly incident: number | null
  readonly incidentWall: WallClock | null
  readonly absolute: unknown
  readonly tomorrow: unknown
  readonly relative: unknown
  readonly toolAt: unknown
  readonly naive: number
}

/** 在 `zone` 这个宿主时区下跑探针（模块在子进程里第一次被 import）。 */
function probeUnderHostZone(zone: string): ChildReport {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD_SOURCE], {
    cwd: process.cwd(),
    env: { ...process.env, TZ: zone },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `子进程（TZ=${zone}）失败：${(result.stderr ?? '').slice(0, 800)}`)
  const parsed = JSON.parse(String(result.stdout).trim()) as ChildReport
  assert.equal(parsed.tz, zone, `子进程没有拿到 TZ=${zone}`)
  return parsed
}

test('宿主 TZ 独立性：TZ=UTC / America/New_York / Pacific/Kiritimati 下结论与 Asia/Shanghai 逐个相同', () => {
  const baseline = probeUnderHostZone(SHANGHAI)
  assert.equal(baseline.hostOffsetMin, -480, '基准子进程应当就是 +08:00')
  assert.equal(baseline.incident, INCIDENT_AT)
  assert.equal(baseline.toolAt, TOOL_AT, `基准子进程里 qq_remind_at 应当给出 ${String(TOOL_AT)}`)
  assert.equal(baseline.naive, INCIDENT_AT, '在 +08:00 上，旧写法恰好也对——这正是当初没暴露的原因')

  for (const zone of ['UTC', 'America/New_York', 'Pacific/Kiritimati']) {
    const report = probeUnderHostZone(zone)
    // 先证明这个子进程**真的**换了时区：旧写法（隐式本地时区）会漂到别的瞬间。
    assert.notEqual(report.hostOffsetMin, baseline.hostOffsetMin, `TZ=${zone} 没有生效`)
    assert.notEqual(report.naive, INCIDENT_AT, `TZ=${zone} 下旧写法应当漂移（否则这条测试没测到东西）`)

    assert.equal(report.incident, INCIDENT_AT, `TZ=${zone}：墙上时间被宿主时区带偏了`)
    assert.deepEqual(report.incidentWall, baseline.incidentWall, `TZ=${zone}：逆变换被宿主时区带偏`)
    assert.deepEqual(report.absolute, baseline.absolute, `TZ=${zone}：parseWhen 绝对时间被宿主时区带偏`)
    assert.deepEqual(report.tomorrow, baseline.tomorrow, `TZ=${zone}：parseWhen "明天9点" 被宿主时区带偏`)
    assert.deepEqual(report.relative, baseline.relative, `TZ=${zone}：parseWhen 相对时间被宿主时区带偏`)
    assert.equal(report.toolAt, TOOL_AT, `TZ=${zone}：qq_remind_at 的墙上时间被宿主时区带偏（${JSON.stringify(report.toolAt)}）`)
  }
})

test('parseWhen：绝对时间与相对时间都钉在 Asia/Shanghai 的墙上日历上', () => {
  const absolute = parseWhen('2026-11-09 23:40', new Date(NOW_AT))
  assert.deepEqual(absolute, { at: INCIDENT_AT, repeat: 'none', note: '已定在 今天 23:40' })
  const tomorrow = parseWhen('明天9点', new Date(NOW_AT))
  assert.deepEqual(tomorrow, { at: 1794272400000, repeat: 'none', note: '已定在 明天 09:00' })
  // 相对时间是"自现在起 +N"，与墙上时区无关，但仍然要确认没被顺手改坏。
  assert.equal(parseWhen('5分钟后', new Date(NOW_AT))?.at, NOW_AT + 5 * 60_000)
})

// ── 5. 工具层：qq_remind_at 的 "YYYY-MM-DD HH:mm" 与秒/毫秒守卫 ───────────────

interface ToolRig {
  readonly store: ReminderStore
  readonly call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  readonly close: () => Promise<void>
}

/** 便宜的工具面脚架：临时目录 + 真 `ReminderStore` + 假 `ctx.tools.register`。 */
async function toolRig(): Promise<ToolRig> {
  const dir = mkdtempSync(path.join(tmpdir(), 'tz-wallclock-'))
  const config = {
    primaryGroup: 1000000003,
    reminders: { enabled: true, dryRun: false, file: null },
  } as unknown as QQChannelConfig
  const store = new ReminderStore(config.reminders, { workspacePath: dir, dshHome: dir, log: (): void => {} })
  await store.load()
  const specs: Array<{ name: string; execute(args: unknown): Promise<unknown> }> = []
  registerReminderTools(
    {
      tools: {
        register: (definition: unknown): (() => void) => {
          specs.push(definition as { name: string; execute(args: unknown): Promise<unknown> })
          return (): void => {}
        },
      },
    },
    config,
    {} as never,
    {} as never,
    (): void => {},
    store,
  )
  return {
    store,
    call: async (name, args) => {
      const spec = specs.find((item) => item.name === name)
      assert.notEqual(spec, undefined, `没注册工具 ${name}（已注册：${specs.map((s) => s.name).join(',')}）`)
      return await spec!.execute(args) as Record<string, unknown>
    },
    close: async () => {
      configureAgendaPort(null)
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('qq_remind_at：墙上时间按 Asia/Shanghai 解释，落盘的 at 就是这个瞬间', async () => {
  const rig = await toolRig()
  try {
    // 取"现在 +2 小时"在上海的墙上时间，再写成 `YYYY-MM-DD HH:mm`——
    // 这样断言与真实时钟无关，也不受宿主时区影响。
    const target = Date.now() + 2 * 3_600_000
    const wall = epochToWallClock(target, REMINDER_ZONE)
    assert.notEqual(wall, null)
    const text = `${String(wall!.year)}-${String(wall!.month).padStart(2, '0')}-${String(wall!.day).padStart(2, '0')} `
      + `${String(wall!.hour).padStart(2, '0')}:${String(wall!.minute).padStart(2, '0')}`
    const expected = wallClockToEpoch({ ...wall!, second: 0 }, REMINDER_ZONE)

    const result = await rig.call('qq_remind_at', { at: text, text: '墙上时间', isGroup: false, target: 10001 })
    assert.equal(result.ok, true, `工具应当接受 "${text}"：${JSON.stringify(result)}`)
    const rows = rig.store.list(10)
    const stored = rows.find((row) => row.text === '墙上时间')
    assert.notEqual(stored, undefined)
    assert.equal(stored!.at, expected, `"${text}" 应当解释成 ${String(expected)}`)
    // 反证：如果按 UTC 解释就会差 8 小时——这一条让断言不是"恒真"。
    assert.notEqual(stored!.at, Date.parse(text.replace(' ', 'T') + ':00Z'))
  } finally {
    await rig.close()
  }
})

test('qq_remind_at：10 位 epoch 当秒、13 位当毫秒（守卫没被顺手改掉）', async () => {
  const rig = await toolRig()
  try {
    const seconds = Math.floor((Date.now() + 3 * 3_600_000) / 1000)
    assert.equal(String(seconds).length, 10, '用例前提：10 位')
    const bySeconds = await rig.call('qq_remind_at', { at: String(seconds), text: '秒', isGroup: false, target: 10001 })
    assert.equal(bySeconds.ok, true, JSON.stringify(bySeconds))

    const millis = Date.now() + 4 * 3_600_000
    assert.equal(String(millis).length, 13, '用例前提：13 位')
    const byMillis = await rig.call('qq_remind_at', { at: String(millis), text: '毫秒', isGroup: false, target: 10001 })
    assert.equal(byMillis.ok, true, JSON.stringify(byMillis))

    const rows = rig.store.list(10)
    assert.equal(rows.find((row) => row.text === '秒')?.at, seconds * 1000)
    assert.equal(rows.find((row) => row.text === '毫秒')?.at, millis)
  } finally {
    await rig.close()
  }
})

test('qq_remind_at：认不出的写法回 ok:false（不抛错、不猜时间）', async () => {
  const rig = await toolRig()
  try {
    const result = await rig.call('qq_remind_at', { at: '下周三下午', text: '认不出', isGroup: false, target: 10001 })
    assert.equal(result.ok, false)
    assert.match(String(result.note), /没认出时间/)
    assert.equal(rig.store.list(10).length, 0, '认不出就一条都不该落盘')
  } finally {
    await rig.close()
  }
})
