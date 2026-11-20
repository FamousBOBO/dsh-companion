/** 显存闸门：**启动打分器之前**问一句"现在还剩多少专用显存"。
 *
 * 为什么要有这一层而不是"起了再说"：`jev-score` 会按 `--n-ctx` 预分配 KV，
 * 显存不够时它不会优雅失败——它会在别的显卡用户（游戏、另一份推理服务）已经被挤到
 * 卡顿时才开始慢，而慢的表现是"这一轮判断超时"，群里什么都不说，日志里只有一句 timeout。
 * 所以判据前置：**不够就不起**，这一路按不可用处理（每轮记一次 no-route，群里不说话）。
 *
 * 为什么**不降级到 CPU**：本机实测 CPU 路线私有内存 208 MB、延迟 1.55 秒；GPU 路线
 * 100 MB、0.24 秒。CPU 又慢又费内存——在"内存紧张、尽量只用显存"的前提下，
 * 降级等于把两个问题一起恶化。
 *
 * 实现用 Windows 的性能计数器（`GPU Engine` / `GPU Adapter Memory`）：
 *   - `Dedicated Usage` 给出"这个进程/这块卡已经用了多少专用显存"，
 *   - 总量从 `HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-…}\0000` 的
 *     `HardwareInformation.qwMemorySize` 读（vram 总量的唯一可靠来源）。
 * 任何一步读不到就返回 `null`（**未知**）——未知时按"够"处理吗？不。
 * `minFreeVramMb` 为 0 时才放行；否则未知会被当成"不启用"，因为静默的卡顿
 * 比"这一路没开"难查得多。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 一块显卡的显存读数。 */
export interface VramReading {
  /** 专用显存总量（MB）；读不到 = `null`。 */
  readonly totalMb: number | null
  /** 已用专用显存（MB）；读不到 = `null`。 */
  readonly usedMb: number | null
}

/**
 * 读当前的空闲专用显存（MB）。
 *
 * 返回 `null` = 读不到（非 Windows、计数器被禁用、驱动没注册性能计数器）。
 * **不抛**：这条路径上"读不到"必须是"这一路不可用"，不是异常。
 */
export async function freeVramMb(): Promise<number | null> {
  if (process.platform !== 'win32') return null
  try {
    const total = await totalVramMb()
    const used = await usedVramMb()
    if (total === null || used === null) return null
    return Math.max(0, Math.round(total - used))
  } catch {
    return null
  }
}

/** 显存够不够（`minFreeMb <= 0` = 不检查）。 */
export function vramIsEnough(freeMb: number | null, minFreeMb: number): boolean {
  const min = Number.isFinite(minFreeMb) ? Math.trunc(minFreeMb) : 0
  if (min <= 0) return true
  if (freeMb === null) return false
  return freeMb >= min
}

/**
 * 跑一段 PowerShell 并取一行数字（失败给 `null`）。
 *
 * 为什么要起 `powershell.exe` 而不是用 Node 的 `os` / WMI 包：
 * 显存是**驱动**的事实，Windows 上只有性能计数器（`GPU Adapter Memory`）与注册表
 * 这两个来源能拿到；`os.mem` 那套 API 里没有"专用显存"的概念。
 * 加一个原生依赖去读它，代价（编译、平台矩阵）比这两条只读命令大得多。
 */
async function powershellNumber(script: string): Promise<number | null> {
  try {
    const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 4_000, windowsHide: true })
    const text = stdout.trim()
    if (text === '') return null
    const value = Number(text)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

/** 总量：注册表里的 `qwMemorySize`（QWORD，字节）。 */
async function totalVramMb(): Promise<number | null> {
  const key = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0000'
  const mb = await powershellNumber(
    `$v = (Get-ItemProperty -Path '${key}' -Name 'HardwareInformation.qwMemorySize' -ErrorAction Stop)`
    + ".'HardwareInformation.qwMemorySize'; [math]::Round([uint64]$v / 1MB)",
  )
  return mb !== null && mb > 0 ? Math.round(mb) : null
}

/**
 * 已用：性能计数器里"专用显存"那一项的合计。
 *
 * 用 `(Get-Counter …).CounterSamples` 而不是 `wmic`：后者在新系统上已经不可靠。
 * 取样失败（第一次计数器建立需要一瞬间）就返回 `null`，由调用方按"未知"处理。
 */
async function usedVramMb(): Promise<number | null> {
  const mb = await powershellNumber(
    '$s = (Get-Counter -Counter "\\GPU Adapter Memory(*)\\Dedicated Usage" -ErrorAction Stop).CounterSamples;'
    + ' [math]::Round(($s | Measure-Object -Property CookedValue -Sum).Sum / 1MB)',
  )
  return mb !== null && mb >= 0 ? Math.round(mb) : null
}
