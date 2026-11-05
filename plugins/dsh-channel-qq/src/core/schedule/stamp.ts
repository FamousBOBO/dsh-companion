/** 时间 → 文本：日志时间戳、会话日期键、时段判定。
 *
 * 这三件事原来散在两个文件里，而且**各有各的实现**：`scheduler.ts` 一份、
 * `adapters/log/logger.ts` 一份。两份都是"本地时间 + 显式偏移"，但写法不同——
 * 于是"日志时间戳"和"定时任务的日期键"是两个可以各自漂移的格式，
 * 而它们本该永远一致（后台就是拿日志行里去重定时任务的）。
 * P3 合成一份，并写了一个逐日期比对的测试证明合并前后逐字节相同。
 *
 * 纯函数：**参数必须传进来**，不读全局时钟。这是 `core/` 的硬规矩
 * （`check-layers` 的 R8）：时间、随机数都从外面注入，判据才可确定性重放。
 */

/**
 * 本地时间 + 显式偏移的 ISO 串。
 *
 * `toISOString()` 永远打 UTC，而本机（系统时钟 UTC、服务 `TZ=Asia/Shanghai`）
 * 每一行日志都比运维看到的墙上时钟差 8 小时——面板显示 16:29 而当地是 00:29。
 * 带上偏移后缀之后，值对人无歧义、对解析也仍然是标准 ISO。
 */
export function formatLocalStamp(d: Date): string {
  const pad = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, '0')
  const offsetMin = -d.getTimezoneOffset()          // minutes east of UTC
  const sign = offsetMin >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
    + `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`
}

/**
 * 本地的"今天"（`YYYY-MM-DD`）。
 *
 * `toISOString().slice(0, 10)` 是 **UTC** 日，在本机比运维的日历早 8 小时。这造成
 * 过两个真实缺陷：
 *
 *   - 当地 06:00 的那次运行拿到了**昨天**的 UTC 键，而"当地 06:00–11:59"这个窗口
 *     （= UTC 22:00–03:59）跨 UTC 午夜，于是"一天只做一次"的守卫键在窗口中途换了
 *     值，任务可能**做两遍**；
 *   - 用它拼出来的日记路径指向**前一天**的文件，于是 04:00 的知识抽取读的是一份
 *     04:00 的梦还没写进去的日记。
 *
 * 现在这个文件里每一处"今天是哪天"都走这里。
 */
export function localDayKey(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 时段：凌晨/清晨/上午/中午/下午/傍晚/晚上/深夜。 */
export interface TimeContext {
  /** 凌晨/清晨/上午/中午/下午/傍晚/晚上/深夜 */
  readonly period: string
  /** One flavor line for the model. */
  readonly flavor: string
}

/** 按本地小时给出当前时段。 */
export function timeContext(now: Date): TimeContext {
  const h = now.getHours()
  if (h >= 0 && h < 5) return { period: '深夜', flavor: '夜深了，群里没人说话很正常，说话声也要轻，别吵醒学弟' }
  if (h < 8) return { period: '清晨', flavor: '刚醒，可以赖床语气，也可以炫耀自己起得早（其实没起）' }
  if (h < 11) return { period: '上午', flavor: '上午精神好，技术活儿这时候最活跃' }
  if (h < 13) return { period: '中午', flavor: '饭点，聊聊吃了什么，别聊太重的话题' }
  if (h < 17) return { period: '下午', flavor: '下午容易困，摸鱼气氛可以带一带' }
  if (h < 19) return { period: '傍晚', flavor: '晚饭前后，人最多的时候' }
  if (h < 23) return { period: '晚上', flavor: '晚上是黄金档，开黑冲浪话题都行' }
  return { period: '深夜', flavor: '快半夜了，收着点音量' }
}
