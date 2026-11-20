/** 判断模型段（`judge`）：群聊"该不该说话"由**本地 Jev typed 模型**判，还是走宿主默认模型。
 *
 * 这一段的由来：`presence` 原来只认一个后端——宿主默认模型（`hostSelection()` 拿到的那个）。
 * 那条路的实测代价是超时上限 25 秒、输出是自由文本（要靠宽松解析才敢用），而且每判断一次
 * 就花一次 provider 的钱。本地 Jev-Style-0.8B 把同一件事变成"九个是/否 + 一次短语选择"，
 * 本机实测 236 ms、零费用、零网络。
 *
 * **三条刻意的默认值**：
 *   1. `backend` 默认 `'host'`：装上插件不等于判断路径换了。换后端是操作者的显式决定，
 *      而且换完必须先在 `shadow` 模式跑一段（见 `docs/groups/p10-jev-judge.md`）。
 *   2. 三个路径默认**空串**：空 = 未配置 = 这一路不启用。仓库里写死某台机器的绝对路径，
 *      换台机器就是一句静默的 ENOENT；空值会让后台明确显示"未配置"。
 *   3. `contextSize` 默认 2048 而不是上游 wrapper 的 32768：判断一次只用约 300 token，
 *      本机实测把 ctx 从 32768 压到 2048 省 786 MB 显存，判决与延迟都不变。
 *
 * 热生效一律 `live`：适配器每次判断前现取这一段（与 `presence` 同口径）。
 */

import { e, n, s, type FieldGroup } from '../dsl.js'

/** `judge` 段的形状；字段定义与默认值见下面 `JUDGE_GROUPS`（唯一来源）。 */
export interface JudgeConfig {
  /**
   * 判断后端。
   *
   * - `'host'`（默认）：今日行为——组一段提示词交给宿主默认模型，输出自由文本再宽松解析。
   * - `'jev-opencode'`：opencode 云端 `/systemone` 端点（九门事实 + 确定性决策表）。
   * - `'jev-local'`：本机 Jev-Style typed 判断（spawn `jev-score`，同一套九门与决策表）。
   *
   * 三条路径的**判断口径完全一致**（同一张决策表、同一份短语库、同一个折判函数），
   * 差别只在"谁打分"。所以换后端不改行为契约，也不改发送闸门。
   *
   * 云端实测（100 轮真实私聊语料）：p50 656 ms、每轮约 932 input token、$0.000039/轮；
   * 本机是 388 ms / 零费用。两者判决的安全门几乎一致（`privacy` 100/100），
   * 分歧集中在"愿不愿意开口"（见 `docs/groups/jev-local-vs-hosted-real.md`）。
   */
  readonly backend: string
  /** `jev-opencode` 的**完整端点**（含路径）：拼法与 base+path 两种写法不能混，否则症状是 404。 */
  readonly remoteBaseUrl: string
  /** `jev-opencode` 的模型 id：付费 `jev-1.13` / 免费 `jev-1.13-free`（后者每天约 58K input token）。 */
  readonly remoteModel: string
  /** 凭据库里的**引用名**（不是密钥）：每次判断前现取，值不进配置、日志、后台响应。 */
  readonly remoteApiKeyRef: string
  /** 单次云端判断的超时（毫秒）。超时按"这一轮不判断"处理，不累积失败计数。 */
  readonly remoteTimeoutMs: number
  /** 云端请求的 `User-Agent`；**留空会被 Cloudflare 挡成 403 `error code: 1010`**。 */
  readonly remoteUserAgent: string
  /** `jev-score` 可执行文件路径；空 = 未配置，`jev-local` 后端直接报"未配置"而不是猜一个路径。 */
  readonly scorerPath: string
  /** Jev GGUF 权重路径；空 = 未配置。 */
  readonly modelPath: string
  /** `tokenizer/tokenizer.json` 路径；空 = 未配置（渲染器要靠它把文本切成打分器认的 token）。 */
  readonly tokenizerPath: string
  /**
   * 打分上下文的 token 窗口。
   *
   * 不是"越大越好"：一次判断（15 条旁听 + 九门问句）实测约 300 token，而打分器会按这个值
   * 预分配 KV。本机实测 32768 → 2048 省 786 MB 显存，判决与延迟都不变。
   */
  readonly contextSize: number
  /** 单次解码的 token 批量上限（影响显存与解码效率）。 */
  readonly ubatch: number
  /** 一批问句同时占用的序列数（九门分三组送进解码，实测 4 足够）。 */
  readonly seqMax: number
  /** 单次解码允许的 logits 输出上限（每个槽位一项）。 */
  readonly outputsMax: number
  /** 卸载到 GPU 的层数：99 = 全量。实测 GPU 比 CPU **更省物理内存**（100 MB vs 208 MB）且快 5 倍。 */
  readonly nGpuLayers: number
  /** 打分器的 CPU 线程数（只在有层留在 CPU 上时才影响耗时）。 */
  readonly threads: number
  /**
   * 启动前要求的最小空闲显存（MB）。
   *
   * 这是唯一的保护闸：显存不够时**不降级到 CPU**（CPU 又慢又费内存），直接按"这一路不可用"
   * 处理，每轮记一次 no-route，群里什么都不发。调低于 512 会和其他显卡用户抢到卡顿。
   */
  readonly minFreeVramMb: number
  /** 单次判断的超时（毫秒）。本机实测 236 ms，默认 3 秒是 12 倍余量。 */
  readonly timeoutMs: number
  /**
   * 短语选择的置信度门槛（0–1）。
   *
   * 低于它就按"这轮不说"处理——宁可少说一句，也不要在没把握的时候开口。实测 top_p 落在
   * 0.28–0.78，**这不是校准过的置信度**，0.30 只是起点，必须用 shadow 日志重标。
   */
  readonly phraseMinProbability: number
  /**
   * 启用的门（逗号分隔）。
   *
   * 九门全开时一次判断约 236 ms；关掉几门能再快一点，但会改变决策表的输入，
   * 关之前先看 `docs/groups/p10-jev-judge.md` 里"哪门管什么"。
   */
  readonly gatesEnabled: string
}

/** 九门的 id（顺序 = 送进模型的问句顺序 = 决策表的输入顺序）。 */
export const GATE_IDS = [
  'tech_issue',
  'help_open',
  'one_to_one',
  'conflict',
  'privacy',
  'inject',
  'closed',
  'casual',
  'share',
] as const

/** 九门全开时的 `gatesEnabled` 默认值（与 {@link GATE_IDS} 同一份顺序）。 */
export const ALL_GATES = GATE_IDS.join(',')

export const JUDGE_GROUPS: FieldGroup[] = [
  {
    id: 'judge',
    label: '判断模型',
    page: 'groups',
    help: '群聊「该不该说话」由谁来判。默认沿用宿主默认模型；换成本地 Jev 后判断从'
      + '"一次生成"变成"九个是/否 + 一次短语选择"，本机实测 236 毫秒、零费用、零网络。'
      + '换完先在 shadow 模式跑一段再开 live。',
    fields: {
      backend: e('判断后端', 'host', [
        ['host', '宿主默认模型（今日行为）'],
        ['jev-opencode', 'opencode 云端 Jev（systemone 端点）'],
        ['jev-local', '本地 Jev-Style typed 判断'],
      ], {
        hot: 'live',
        page: 'groups',
        help: 'host = 组一段提示词交给宿主默认模型（自由文本，宽松解析）；'
          + 'jev-opencode = opencode 的 systemone 端点（九门事实 + 确定性决策表，'
          + '每轮约 932 input token，按 $0.042/1M 计费）；'
          + 'jev-local = 本机 Jev 打分器（同一套九门，要配下面三个路径）。'
          + '后两者共用同一张决策表与短语库，换的只是"谁打分"。',
      }),
      remoteBaseUrl: s('云端端点', 'https://opencode.ai/inference/systemone/v1/systemone', {
        hot: 'live',
        page: 'groups',
        placeholder: 'https://opencode.ai/inference/systemone/v1/systemone',
        help: '`jev-opencode` 用的**完整端点**（含路径）。填完整 URL 而不是 base+path：'
          + '两边拼法一旦漂移，症状是 404，而不是"判断变差"。'
          + '注意 Jev 只走 systemone 协议——它**不是**聊天模型，'
          + '塞进 `chat/completions` 或 `messages` 会被 400 ModelProtocolUnsupported 挡回。',
      }),
      remoteModel: s('云端模型 id', 'jev-1.13', {
        hot: 'live',
        page: 'groups',
        placeholder: 'jev-1.13',
        help: '`jev-1.13` = 付费（$0.042/1M input，output 免费，无硬额度）；'
          + '`jev-1.13-free` = 同一模型的免费入口，但每天只有约 58K input token'
          + '（≈77 轮判断），用完 429 且要等次日 UTC 00:05 重置——群聊常驻撑不住，'
          + '只适合做实验。',
      }),
      remoteApiKeyRef: s('凭据引用名', 'OPENCODE_API_KEY', {
        hot: 'live',
        page: 'groups',
        placeholder: 'OPENCODE_API_KEY',
        help: 'DSH 凭据库里的**引用名**（不是密钥本身）。每次判断前现取，'
          + '所以换了 key 下一轮就生效；密钥值不会进配置、日志或后台响应。'
          + '注意 systemone 只认 Console/PAYG 那把 key，`OPENCODE_GO_API_KEY` 会 401。',
      }),
      remoteTimeoutMs: n('云端超时', 8000, {
        hot: 'live',
        page: 'groups',
        min: 1000,
        max: 30_000,
        step: 500,
        unit: 'ms',
        help: '单次云端判断的超时。实测 p50 656 ms / p90 962 ms / max 1384 ms，'
          + '8 秒是 12 倍余量。超时按"这一轮不判断"处理，不累积失败计数。',
      }),
      remoteUserAgent: s('云端 User-Agent', 'dsh-companion/jev-opencode', {
        hot: 'live',
        page: 'groups',
        placeholder: 'dsh-companion/jev-opencode',
        help: '**不要留空**：不带自定义 UA 的请求会被 Cloudflare 挡成 403 `error code: 1010`，'
          + '而那个错误体里没有任何提示。把 UA 写成自己的客户端名，'
          + '顺便也让对端能区分流量来源。',
      }),
      scorerPath: s('打分器路径', '', {
        hot: 'live',
        page: 'groups',
        placeholder: 'D:\\jev\\jev-score.exe',
        help: '`jev-score` 可执行文件。空 = 未配置：jev-local 后端会直接报"未配置"，'
          + '不会去猜一个路径。',
      }),
      modelPath: s('权重路径', '', {
        hot: 'live',
        page: 'groups',
        placeholder: 'D:\\jev\\Jev-Style-0.8B-Decision-v3-Q4_K_M.gguf',
        help: 'Jev-Style GGUF 权重。空 = 未配置。量化优先 Q4_K_M：本机实测判决与 Q8 一致，'
          + '显存只要一半。',
      }),
      tokenizerPath: s('分词器路径', '', {
        hot: 'live',
        page: 'groups',
        placeholder: 'D:\\jev\\tokenizer\\tokenizer.json',
        help: '`tokenizer.json`（与权重同一次发布）。空 = 未配置：渲染器没法把中文切成'
          + '打分器认的 token，这一路会直接报"未配置"。',
      }),
      contextSize: n('上下文窗口', 2048, {
        hot: 'live',
        page: 'groups',
        min: 512,
        max: 32_768,
        step: 512,
        unit: 'token',
        help: '打分器预分配的 KV 长度。一次判断（15 条旁听 + 九门问句）约 300 token，'
          + '默认 2048 够用；本机实测从 32768 压到 2048 省 786 MB 显存，判决不变。'
          + '改大之前先确认 `presence.judgeMaxEntries` 也一起放大了。',
      }),
      ubatch: n('解码批量', 256, {
        hot: 'live',
        page: 'groups',
        min: 64,
        max: 2048,
        step: 64,
        unit: 'token',
        help: '单次解码的 token 批量上限。默认 256：本机实测再调大只多占显存，不更快。',
      }),
      seqMax: n('并行序列数', 4, {
        hot: 'live',
        page: 'groups',
        min: 2,
        max: 17,
        step: 1,
        unit: '条',
        help: '一批问句同时占用的序列数。九门分三组送进解码，默认 4 足够；'
          + '调到 2 再省约 40 MB 显存，但每组只能并两问，耗时会涨。',
      }),
      outputsMax: n('logits 输出上限', 64, {
        hot: 'live',
        page: 'groups',
        min: 16,
        max: 256,
        step: 16,
        unit: '个',
        help: '单次解码允许读出多少个槽位的 logits。九门 + 一次五选一最多要 14 个，'
          + '默认 64 有余量；调小能省一点显存。',
      }),
      nGpuLayers: n('GPU 卸载层数', 99, {
        hot: 'live',
        page: 'groups',
        min: 0,
        max: 99,
        step: 1,
        unit: '层',
        help: '99 = 全量卸载。**不要为了省内存改成 0**：本机实测 GPU 路线私有内存 100 MB、'
          + 'CPU 路线 208 MB，延迟 0.24 秒 vs 1.55 秒——CPU 又慢又费内存。'
          + '显存不够时这条链路应当整条不可用（见下面的最小空闲显存）。',
      }),
      threads: n('CPU 线程数', 6, {
        hot: 'live',
        page: 'groups',
        min: 1,
        max: 32,
        step: 1,
        unit: '线程',
        help: '打分器的 CPU 线程数，只在有层留在 CPU 上时才影响耗时。默认 6（本机 6 核 12 线程的物理核数）。',
      }),
      minFreeVramMb: n('最小空闲显存', 512, {
        hot: 'live',
        page: 'groups',
        min: 0,
        max: 8192,
        step: 128,
        unit: 'MB',
        help: '启动打分器前要求的最小空闲专用显存。不够就**不启动、不降级 CPU**，'
          + '这一路按不可用处理（每轮记一次 no-route，群里不说话）。'
          + '0 = 不检查（不建议：会和别的显卡用户抢到卡顿）。',
      }),
      timeoutMs: n('判断超时', 3000, {
        hot: 'live',
        page: 'groups',
        min: 500,
        max: 60_000,
        step: 500,
        unit: 'ms',
        help: '单次判断的超时（毫秒）。本机实测 236 毫秒，默认 3 秒是 12 倍余量；'
          + '超时按"这一轮不判断"处理，不是失败。',
      }),
      phraseMinProbability: n('短语置信度门槛', 0.3, {
        hot: 'live',
        page: 'groups',
        min: 0,
        max: 1,
        step: 0.05,
        unit: '',
        help: '短语选择的最优概率低于它就按"这轮不说"处理——没把握时宁可少说一句。'
          + '实测 top_p 落在 0.28–0.78，**这不是校准过的置信度**，0.30 只是起点，'
          + '必须用 shadow 日志重标。',
      }),
      gatesEnabled: s('启用的门', ALL_GATES, {
        hot: 'live',
        page: 'groups',
        help: '逗号分隔的事实门 id。九门全开是默认；关掉某一门等于让决策表看不见那条事实，'
          + '会直接改变"该不该说话"的判断。可选项：' + ALL_GATES + '。',
      }),
    },
  },
]
