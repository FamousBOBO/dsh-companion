/** 分离上下文（分块/重叠/精度/设备）的**纯词汇**：解析、校验、键标识。
 *
 * 为什么单独一个文件：这组值同时被三处看见——后台配置（`sections/song.ts` 的定义）、
 * 翻唱适配器（要拼 `make_cover.py` 的命令行）、同歌缓存（要把它进键）。三处各写一遍
 * 校验或各写一遍拼串，就必然漂成三套口径（"配置里是 0、命令行没传、缓存键当默认"）。
 *
 * 三条刻意的取舍：
 *   1. **默认 = 不改行为**。`-1` / `'auto'` / `'auto'` 表示"交给下层模块自己的默认"
 *      （DirectML 22050/5512、CPU 352800/<模型 yaml>）。所以把这些字段原样留着，
 *      `make_cover.py` 一个调优参数都不会多收，与加这些字段之前逐字一致。
 *   2. **校验比报错早**。块长 ≤ 0、重叠 ≥ 块长、精度不在白名单，都在这里被拒；
 *      下游 `pymss` 也会拒，但它要到加载完 900 MB 权重之后才发现——那时候一次
 *      点歌已经白等半分钟。
 *   3. **进键的是"声称的值"而不是"后端采用的值"**。缓存键必须能在**跑之前**算出来，
 *      所以它只能记请求；后端最终采用的参数另有出处（`separation-report.json` 与
 *      `summary.json` 的 `separation.effective`），那是诊断用的、不参与键。
 */

/** 一次翻唱的分离上下文（都允许"用下层默认"）。 */
export interface SeparationSettings {
  /** 分块采样点；`null` = 下层默认。 */
  readonly chunkSize: number | null
  /** 重叠采样点；`null` = 下层默认。 */
  readonly overlapSize: number | null
  /** 模型精度；`auto` = 下层默认（DirectML 上是 fp16→fp32 回退）。 */
  readonly dtype: 'auto' | 'float16' | 'float32'
  /** `auto` = 跟随 RVC 的自动设备选择；`cpu` = 强制 CPU（诊断参照）。 */
  readonly device: 'auto' | 'cpu'
}

/** 一切"用下层默认"的那一组：也是没配任何新字段时的结果。 */
export const DEFAULT_SEPARATION: SeparationSettings = {
  chunkSize: null, overlapSize: null, dtype: 'auto', device: 'auto',
}

/** `auto` / `float16` / `float32`（含常见别名；与 `pymss` 的归一化同一套词）。 */
const DTYPE_ALIASES: Readonly<Record<string, SeparationSettings['dtype']>> = {
  auto: 'auto', '': 'auto',
  fp16: 'float16', half: 'float16', float16: 'float16',
  fp32: 'float32', float: 'float32', float32: 'float32',
}

/** 配置里"用默认"的哨兵：`-1`。0 是一个有意义的重叠量（不分块重叠），不能当哨兵。 */
export const UNSET_SAMPLE_VALUE = -1

/** 配置的原始形状（后台存的是数/字符串）。字段可缺省：缺省一律当"用默认"。 */
export interface SeparationConfigFields {
  readonly separatorChunk?: number
  readonly separatorOverlap?: number
  readonly separatorDtype?: string
  readonly separatorDevice?: string
}

/** 校验失败：消息给人看（后台字段名 + 实际值 + 合法范围）。 */
export class SeparationConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeparationConfigError'
  }
}

/**
 * 配置字段 → 设置。任何非法值**抛**（不静默退回默认）：一个坏配置悄悄变成
 * "照旧跑默认参数"会让人以为改动生效了，那比直接失败更难查。
 */
export function separationFromConfig(fields: SeparationConfigFields): SeparationSettings {
  const chunkRaw = fields.separatorChunk ?? UNSET_SAMPLE_VALUE
  const overlapRaw = fields.separatorOverlap ?? UNSET_SAMPLE_VALUE
  if (!Number.isFinite(chunkRaw) || (chunkRaw !== UNSET_SAMPLE_VALUE && chunkRaw <= 0)) {
    throw new SeparationConfigError(
      `separatorChunk 不合法：${String(chunkRaw)}（-1 = 用默认，或 > 0 的采样点数）`,
    )
  }
  if (!Number.isFinite(overlapRaw) || overlapRaw < UNSET_SAMPLE_VALUE) {
    throw new SeparationConfigError(
      `separatorOverlap 不合法：${String(overlapRaw)}（-1 = 用默认，或 >= 0 的采样点数）`,
    )
  }
  const chunkSize = chunkRaw === UNSET_SAMPLE_VALUE ? null : Math.floor(chunkRaw)
  const overlapSize = overlapRaw === UNSET_SAMPLE_VALUE ? null : Math.floor(overlapRaw)
  if (chunkSize !== null && overlapSize !== null && overlapSize >= chunkSize) {
    throw new SeparationConfigError(
      `separatorOverlap 必须 < separatorChunk（重叠 ${String(overlapSize)} ≥ 分块 ${String(chunkSize)}）`,
    )
  }
  const dtypeKey = String(fields.separatorDtype ?? '').trim().toLowerCase()
  const dtype = DTYPE_ALIASES[dtypeKey]
  if (dtype === undefined) {
    throw new SeparationConfigError(
      `separatorDtype 不合法：${String(fields.separatorDtype)}（auto / float16 / float32）`,
    )
  }
  // 空串 = "没写"（老配置/老测试里就没有这几个字段）：与 `auto` 同义，不是非法值。
  const deviceKey = String(fields.separatorDevice ?? '').trim().toLowerCase()
  const device = deviceKey === '' ? 'auto' : deviceKey
  if (device !== 'auto' && device !== 'cpu') {
    throw new SeparationConfigError(
      `separatorDevice 不合法：${String(fields.separatorDevice)}（auto / cpu）`,
    )
  }
  return { chunkSize, overlapSize, dtype, device }
}

/** 算不出来（配置坏）时的安全取值：默认设置。日志由调用方写，这里不抛也不记。 */
export function separationOr(fields: SeparationConfigFields): SeparationSettings {
  try {
    return separationFromConfig(fields)
  } catch {
    return DEFAULT_SEPARATION
  }
}

/**
 * 进缓存键的那一段。**全默认时是固定常量 `sep-default`**，所以没配新字段的部署
 * 键形状只多这一节、不带任何数值——旧键因此不会被"看起来一样"的新键误命中。
 *
 * 有值时逐项写出来：分块、重叠、精度、设备。设备进键是因为 CPU 与 DirectML
 * 的分块默认不同（352800 vs 22050），同一组请求值在两种设备上不是同一段音频。
 */
export function separationKeyMark(settings: SeparationSettings): string {
  const chunk = settings.chunkSize === null ? 'd' : `c${String(settings.chunkSize)}`
  const overlap = settings.overlapSize === null ? 'd' : `o${String(settings.overlapSize)}`
  const dtype = settings.dtype === 'auto' ? 'd' : settings.dtype
  const device = settings.device === 'auto' ? 'd' : settings.device
  if (chunk === 'd' && overlap === 'd' && dtype === 'd' && device === 'd') return 'sep-default'
  return ['sep', chunk, overlap, dtype, device].join('-')
}

/**
 * 设置 → `make_cover.py` 的分离参数（**只在显式给过值时才出现**）。
 *
 * 为什么不总是传：`--separator-chunk -1` 这类"默认哨兵"会把脚本的分支复杂化，而且
 * 一旦脚本参数校验变化，默认路径就会跟着变。空数组 = 命令行与加这些字段之前一字不差。
 */
export function separationFlags(settings: SeparationSettings): string[] {
  const flags: string[] = []
  if (settings.chunkSize !== null) flags.push('--separator-chunk', String(settings.chunkSize))
  if (settings.overlapSize !== null) flags.push('--separator-overlap', String(settings.overlapSize))
  if (settings.dtype !== 'auto') flags.push('--separator-dtype', settings.dtype)
  if (settings.device !== 'auto') flags.push('--separator-device', settings.device)
  return flags
}

/** 给人看的一行（日志用；不出现路径）。 */
export function describeSeparation(settings: SeparationSettings): string {
  return `分块 ${settings.chunkSize === null ? '默认' : String(settings.chunkSize)}`
    + `、重叠 ${settings.overlapSize === null ? '默认' : String(settings.overlapSize)}`
    + `、精度 ${settings.dtype}、设备 ${settings.device}`
}
