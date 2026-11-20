<#
探测显存并给出建议配置。

为什么要有这一步：`jev-score` 会按 `--n-ctx` **预分配 KV**，显存不够时它不会优雅失败——
它会让整块卡开始卡顿，而卡顿在插件里表现为"这一轮判断超时"，日志里只有一句 timeout。
所以调参的第一步永远是"量出现在还剩多少"，而不是"改一个数字试试"。

本机实测（11.47 GB 卡，空闲约 2.4 GB 时）：
  参数                        专用显存   私有工作集   冷启动   p50 延迟
  ctx32768 seq17 out256        1479 MB    117 MB       0.9 s    0.24 s   ← 上游默认
  ctx2048  seq4  out64          693 MB    117 MB       0.9 s    0.24 s   ← 本插件默认
  ctx2048  seq2  out64          650 MB    117 MB       0.9 s    0.39 s   ← 再省 43 MB，慢 60%
结论：判一次只用约 300 token，ctx 压到 2048 省 786 MB 且**判决与延迟都不变**。

用法：
  .\probe-vram.ps1
  .\probe-vram.ps1 -Free 480     # 按"预计还剩 480 MB"反推安全参数
#>

[CmdletBinding()]
param(
  # 手工指定可用显存（MB）；缺省实时读。
  [int] $Free = -1,
  # 要预留给系统/浏览器的余量（MB）。
  [int] $Headroom = 384
)

$ErrorActionPreference = 'Stop'

# ── 1. 显存总量：注册表里的 qwMemorySize（唯一可靠的来源） ──────────────────
$key = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0000'
$totalMb = $null
try {
  $bytes = (Get-ItemProperty -Path $key -Name 'HardwareInformation.qwMemorySize' -ErrorAction Stop).
    'HardwareInformation.qwMemorySize'
  $totalMb = [math]::Round([uint64]$bytes / 1MB)
} catch {
  Write-Warning "读不到显存总量（$($_.Exception.Message)）：后面按你给的数字算"
}

# ── 2. 已用：性能计数器的专用显存合计 ──────────────────────────────────────
$usedMb = $null
try {
  $samples = (Get-Counter -Counter '\GPU Adapter Memory(*)\Dedicated Usage' -ErrorAction Stop).CounterSamples
  $usedMb = [math]::Round(($samples | Measure-Object -Property CookedValue -Sum).Sum / 1MB)
} catch {
  Write-Warning "读不到显存占用（$($_.Exception.Message)）"
}

if ($Free -ge 0) { $freeMb = $Free }
elseif ($null -ne $totalMb -and $null -ne $usedMb) { $freeMb = $totalMb - $usedMb }
else { throw '缺少显存数字：请用 -Free 手工指定' }

Write-Host ''
Write-Host ("卡上显存 {0} MB，已用 {1} MB，空闲 {2} MB（预留 {3} MB 给系统）" -f `
  $(if ($null -ne $totalMb) { $totalMb } else { '?' }),
  $(if ($null -ne $usedMb) { $usedMb } else { '?' }), $freeMb, $Headroom) -ForegroundColor Cyan
Write-Host ''

# ── 3. 反推安全参数（按实测的每参数开销） ─────────────────────────────────
# 693 MB @ ctx2048/seq4/out64；650 MB @ ctx2048/seq2/out64 → 每多一条序列约 21 MB；
# 1479 MB @ ctx32768 → ctx 每翻一倍约 +32 MB（KV 线性增长，权重部分固定约 400 MB）。
$budget = $freeMb - $Headroom
if ($budget -lt 600) {
  Write-Warning ("可用 {0} MB 低于单序列最低需求（约 600 MB）：本机实测 CPU 路线私有内存 208 MB、延迟 1.55 秒，" -f $budget)
  Write-Warning '而 GPU 路线 100 MB、0.24 秒——CPU 又慢又费内存，所以不建议降级。'
  Write-Warning '建议：关掉别的显存占用，或把 judge.minFreeVramMb 调成 0 并接受"这一路不可用"。'
  exit 1
}

$seq = if ($budget -ge 900) { 4 } elseif ($budget -ge 700) { 3 } else { 2 }
$ctx = if ($budget -ge 1200) { 4096 } elseif ($budget -ge 800) { 2048 } else { 1024 }
$ubatch = if ($budget -ge 900) { 256 } else { 128 }

Write-Host '建议写进后台「判断模型」页的值：' -ForegroundColor Green
Write-Host ("  contextSize     = {0}" -f $ctx)
Write-Host ("  ubatch          = {0}" -f $ubatch)
Write-Host ("  seqMax          = {0}" -f $seq)
Write-Host ("  outputsMax      = 64")
Write-Host ("  nGpuLayers      = 99   （不要为了省内存改成 0：GPU 反而更省物理内存）")
Write-Host ("  threads         = {0}   （物理核数）" -f [Environment]::ProcessorCount / 2)
Write-Host ("  minFreeVramMb   = {0}" -f [math]::Max(256, $Headroom))
Write-Host ''
Write-Host '改完之后：先在 shadow 模式跑一段（判断照跑但不发），再看 logs/presence-judge-shadow.jsonl。' -ForegroundColor Cyan
