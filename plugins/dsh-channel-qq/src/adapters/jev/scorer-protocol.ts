/** 打分器的**线协议**：请求/回复的形状、argv、以及把一行回复解析成结果。
 *
 * 为什么单独一个文件：这些都是**纯函数**（给字符串给数字，不碰进程、不碰文件、不碰时钟），
 * 于是可以在没有显卡、没有权重、没有子进程的环境里逐条断言。
 * 进程生命周期那部分在 `scorer-client.ts`。
 *
 * 协议形状（第一手实测，见 `docs/groups/p10-jev-judge.md`）：
 *   请求 `{"prefix":[ids], "questions":[{"ids":[...], "slots":[绝对位置...], "rows":[tokenId...]}],
 *           "share_prefix":true, "keep_prefix":true}`
 *   回复 `{"results":[{"scores":[[每槽每行的 logit...]]}], "timing":{...}, "prefix_reused":bool}`
 * 打分器只返回**指定行**（这里永远是 `yes` / `no` 两个 token）的 logit，概率由客户端算。
 */

/** 一次打分请求里的一道问句。 */
export interface ScoreQuestion {
  /** `prefix + question` 的完整 token 序列。 */
  readonly ids: readonly number[]
  /** 要读 logit 的绝对位置（必须落在 question 部分）。 */
  readonly slots: readonly number[]
  /** 每个槽位要读哪几个 token 的 logit（`yes` / `no`）。 */
  readonly rows: readonly number[]
}

/** 打分器的启动参数（全部来自 `judge.*` 配置）。 */
export interface ScorerOptions {
  readonly binaryPath: string
  readonly modelPath: string
  readonly contextSize: number
  readonly ubatch: number
  readonly seqMax: number
  readonly outputsMax: number
  readonly nGpuLayers: number
  readonly threads: number
}

/** 打分器的就绪信息（`ready` 行）。 */
export interface ScorerInfo {
  readonly desc: string
  readonly nCtx: number
  readonly nSeqMax: number
  readonly nUbatch: number
  readonly loadMs: number
  /**
   * `system_info` 原文（llama.cpp 打印的编译期特性清单）。
   *
   * **不要从它推断"走没走 GPU"**：本机实测这一行只有 CPU 特性
   * （`CPU : SSE3 = 1 | AVX2 = 1 | …`），哪怕 `--ngl 99` 确实把层全卸载到了 Vulkan 上。
   * 所以这里只留原文供人看；"到底快不快"要看实测延迟（GPU 0.24 s / CPU 1.55 s）。
   * 上游 Python 包装器那个 `gpu_offload` 字段是自己算的，`ready` 行里没有。
   */
  readonly systemInfo: string
}

/** 一次打分的可判别结果（绝不抛）。 */
export type ScoreOutcome =
  | {
    readonly kind: 'scores'
    /** 每个问题、每个槽位一行 logit（顺序与请求一致）。 */
    readonly results: ReadonlyArray<ReadonlyArray<readonly number[]>>
    readonly totalMs: number
  }
  | { readonly kind: 'no-route'; readonly detail: string }
  | { readonly kind: 'failed'; readonly detail: string }
  | { readonly kind: 'timeout'; readonly detail: string }

/** 启动参数（argv 直传，不经 shell，所以路径里有空格也不用引号）。 */
export function argsOf(options: ScorerOptions): string[] {
  return [
    '--model', options.modelPath,
    '--n-ctx', String(options.contextSize),
    '--n-ubatch', String(options.ubatch),
    '--ngl', String(options.nGpuLayers),
    '--threads', String(options.threads),
    '--n-seq-max', String(options.seqMax),
    '--n-outputs-max', String(options.outputsMax),
  ]
}

/** 一行请求的 JSON。 */
export function requestOf(
  prefix: readonly number[],
  questions: readonly ScoreQuestion[],
): string {
  return JSON.stringify({
    prefix: [...prefix],
    questions: questions.map((question) => ({
      ids: [...question.ids], slots: [...question.slots], rows: [...question.rows],
    })),
    share_prefix: true,
    keep_prefix: true,
  })
}

/** 解析一行 JSON（空行、非对象、坏 JSON 都返回 `null`）。 */
export function parseLine(line: string): Record<string, unknown> | null {
  const text = line.trim()
  if (text === '') return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** 从 `ready` 行里读就绪信息（字段名与打分器一致，缺的给保守默认）。 */
export function infoOf(ready: Record<string, unknown>): ScorerInfo {
  const pick = (key: string): number => {
    const value = ready[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
  return {
    desc: typeof ready['desc'] === 'string' ? ready['desc'] : '',
    nCtx: pick('n_ctx'),
    nSeqMax: pick('n_seq_max'),
    nUbatch: pick('n_ubatch'),
    loadMs: pick('load_ms'),
    systemInfo: typeof ready['system_info'] === 'string' ? ready['system_info'] : '',
  }
}

/** `results` 数组的形状检查结果。 */
export type ResultsCheck =
  | { readonly ok: true; readonly results: ReadonlyArray<ReadonlyArray<readonly number[]>> }
  | { readonly ok: false; readonly detail: string }

/**
 * 校验收到的 `results`。
 *
 * 形状要求：`results[i].scores[j]` 是"第 i 个问题第 j 个槽位要读的那几行 logit"。
 * 任何一处不是有限数就整体判失败——把 NaN 传下去会让 softmax 输出一个**看起来正常**
 * 的分布（NaN 参与比较时 `argMax` 会挑第一个），那比报错难查得多。
 */
export function resultsOf(raw: unknown): ResultsCheck {
  if (!Array.isArray(raw)) return { ok: false, detail: '回复缺 results 数组' }
  const results: Array<ReadonlyArray<readonly number[]>> = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') return { ok: false, detail: 'results 项不是对象' }
    const scores = (item as Record<string, unknown>)['scores']
    if (!Array.isArray(scores)) return { ok: false, detail: 'results 项缺 scores' }
    const slots: Array<readonly number[]> = []
    for (const slot of scores) {
      if (!Array.isArray(slot)) return { ok: false, detail: 'scores 项不是数组' }
      const rows: number[] = []
      for (const value of slot) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return { ok: false, detail: 'scores 里有非有限数' }
        }
        rows.push(value)
      }
      slots.push(rows)
    }
    results.push(slots)
  }
  return { ok: true, results }
}

/** `total_ms`（拿不到就用实测耗时）。 */
export function totalMsOf(parsed: Record<string, unknown>, fallbackMs: number): number {
  const timing = parsed['timing']
  if (timing === null || typeof timing !== 'object') return fallbackMs
  const value = (timing as Record<string, unknown>)['total_ms']
  return typeof value === 'number' && Number.isFinite(value) ? value : fallbackMs
}

/** 异常只留一句话（不打堆栈进配置面日志）。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200)
  return String(error).slice(0, 200)
}
