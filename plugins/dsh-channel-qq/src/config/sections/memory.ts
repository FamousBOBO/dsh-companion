/** 记忆段：新记忆系统（P6e）的开关、提示注入预算与向量检索参数（page: memory）。
 *
 * `memory.v2` 是总开关；v2 打开后 `vectorEnabled` 决定检索用不用本机 embed 服务
 * （P6e·e2）。**向量默认关**：关着时检索走 e1 的关键词路径，输出与从前逐字节一致；
 * 打开但服务不可用时也会自动退回关键词。
 *
 * 读法：v2 与预算四项由记忆子插件 `watches`（改完即重载）；向量五项是装配期值，
 * 同样申报了 watch——"面板上能改的东西必须真的被读到"。
 */

import { b, n, s, type FieldGroup } from '../dsl.js'

/**
 * 向量检索段（P6e·e2）的类型本体。
 *
 * 为什么不在 `config.ts` 的 `MemoryConfig` 里内联这五个字段：那份文件是"类型的视图"，
 * 但**吃 400 行硬上限**（scripts/check-size.mjs），e2 加字段时它已贴着上限——所以
 * 字段说明放这里（本段的字段定义也在这），config.ts 的 `MemoryConfig extends MemoryVectorConfig`。
 *
 * 语义：**默认关**——关着时检索走 e1 的关键词路径、输出逐字节一致；打开后用本机
 * embed 服务（起法与回退见 docs/deployment.md §13），服务不可用时自动退回关键词。
 */
export interface MemoryVectorConfig {
  /** 开关。改它由记忆子插件的 watches 触发重载（hot: reload）。 */
  vectorEnabled: boolean
  /** OpenAI 兼容 `/v1/embeddings` 的基地址（默认即本机 8801；只接受运维在配置里填的地址）。 */
  vectorUrl: string
  /** 向量维度（bge-small-zh-v1.5 = 512）。响应/索引文件不符即整份拒绝，绝不错位读。 */
  vectorDim: number
  /** 单次 embed 调用超时（毫秒）；09 §5.4 的 800ms 是"不拖住一回合"的上限。 */
  vectorTimeoutMs: number
  /** 余弦相对关键词的权重（0..1）；1 = 纯余弦（09 §5.2 的默认语义，e4 调参用）。 */
  vectorWeight: number
}

/**
 * 知识抽取器的接入参数（原来只有环境变量，后台看不到也改不了）。
 *
 * 三个字段都留空 = 完全沿用环境变量（`CHANNEL_QQ_EXTRACTOR_BASE_URL` /
 * `_MODEL` / `_API_KEY`，后者回退 `DSH_LLM_API_KEY`）。填了就以配置为准——
 * 这样"抽取器到底配没配"在后台一眼可见，不必登服务器查 env。
 */
export interface MemoryExtractorConfig {
  /** OpenAI 兼容基地址（如 `https://gateway.example/v1`）；空 = 用环境变量。 */
  extractorUrl: string
  /** 模型名；空 = 用环境变量。 */
  extractorModel: string
  /** API Key；空 = 用环境变量或 DSH_LLM_API_KEY。 */
  extractorApiKey: string
}

/** 三层注入与即时抽取（P0/P2/P3，调研 20261024 §6）的配置本体。字段说明在 FieldGroup 里。 */
export interface MemoryInjectV3Config {
  pinnedEnabled: boolean
  wanderPercent: number
  occasionsEnabled: boolean
  captureEnabled: boolean
  captureDailyCap: number
}

/** 人物档：按房间记录认人线索（手动笔记，默认关）。 */
export interface PeopleConfig {
  enabled: boolean
  /** Storage directory; null = <workspace>/people. */
  dir: string | null
}

export const MEMORY_GROUPS: FieldGroup[] = [
  {
    id: 'memory',
    label: '记忆',
    page: 'memory',
    fields: {
      v2: b('启用新记忆系统（memory.v2）', false, {
        hot: 'live',
        help: '关着时走旧的关键词知识库（entries.json）；打开后每回合注入 3–8 条结构化记忆证据。',
      }),
      threshold: n('检索分数阈值', 0.35, { min: 0, max: 1, step: 0.05, hot: 'live' }),
      maxRecords: n('每回合最多注入几条', 8, { min: 1, max: 20, hot: 'live' }),
      maxChars: n('每回合最多注入多少字', 600, { min: 100, max: 2000, hot: 'live' }),
      // ── 三层注入（P2，调研 20261024 §6-P2）──────────────────────────────
      // 常驻层准入极严（core 标记 + importance≥8 + confidence≥0.8），无标记记录
      // 的库开着也是零输出，所以默认开；走神 8% 才带一条深记忆回来。
      pinnedEnabled: b('启用常驻记忆层', true, {
        hot: 'live',
        help: '「一直记得的事」：带 core 标记且高重要高置信的记录每回合都在场（最多 2 条，占注入预算）。',
      }),
      wanderPercent: n('走神概率 %', 8, {
        min: 0, max: 50, step: 1, hot: 'live',
        help: '每回合按此概率从「被记得够深 + 七天没想起」的记忆里随机带一条回来（0 = 关）。feiyu 的洞察：偶尔"突然想起来"才像真人。',
      }),
      occasionsEnabled: b('注入今天的日子', true, {
        hot: 'live',
        help: '生日/纪念日（tags 含 birthday / anniversary 的记录）到期时在证据前加一行提示。',
      }),
      // ── 即时抽取（P0，feiyu 式 turn-end 沉淀）────────────────────────────
      captureEnabled: b('启用回合结束即时抽取', false, {
        hot: 'live',
        help: '回合结束时按规则判据（被纠正/要求记住/自述/情绪上头）走带外抽取沉淀短事实。默认关：抽取要调模型，想清楚再开。',
      }),
      captureDailyCap: n('即时抽取每日上限', 12, { min: 1, max: 60, hot: 'live' }),
      profiles: b('注入当前发言人侧写', false, {
        hot: 'live',
        help: '默认关。打开后每回合在证据前加一段「关于这个人」的 3–5 行侧写（5 分钟缓存）。',
      }),
      // ── 知识抽取器（原先只有环境变量）────────────────────────────────────────
      // 读法：装配记忆模块时取值；改完由 watches 触发重载。留空 = 沿用环境变量。
      extractorUrl: s('抽取器地址', '', {
        hot: 'reload', advanced: true,
        help: 'OpenAI 兼容接口的基地址（例：https://gateway.example/v1）。留空则读环境变量 CHANNEL_QQ_EXTRACTOR_BASE_URL；'
          + '地址或模型为空时抽取整体跳过（日志里会说"extractor not configured"）。',
      }),
      extractorModel: s('抽取器模型', '', {
        hot: 'reload', advanced: true,
        help: '留空则读环境变量 CHANNEL_QQ_EXTRACTOR_MODEL。',
      }),
      extractorApiKey: s('抽取器 API Key', '', {
        hot: 'reload', advanced: true, secret: true,
        help: '留空则读环境变量 CHANNEL_QQ_EXTRACTOR_API_KEY，再回退 DSH_LLM_API_KEY。',
      }),
      // ── 向量检索（P6e·e2）──────────────────────────────────────────────────
      // 读法：装配记忆模块时取值，据此建 embed 客户端与向量索引；改完由 watches
      // 触发重载（reload）。默认关 = 与 e1 关键词路径逐字节一致。
      vectorEnabled: b('启用向量检索', false, {
        hot: 'reload',
        help: '需要先由运维在本机起 embed 服务（见 docs/deployment.md「可选：本机 embed 服务」）。'
          + '关着时检索完全走关键词，与从前逐字节一致；打开但服务不可用时自动退回关键词。',
      }),
      vectorUrl: s('embed 服务地址', 'http://127.0.0.1:8801', {
        hot: 'reload', advanced: true,
        help: 'OpenAI 兼容 /v1/embeddings 的基地址。会补 /v1/embeddings 后缀；已以 /embeddings 结尾则原样使用。',
      }),
      vectorDim: n('向量维度', 512, {
        min: 64, max: 4096, hot: 'reload', advanced: true,
        help: 'bge-small-zh-v1.5 是 512。响应或索引文件的维度与此不符时整份拒绝（防止维度错位读出错数据）。',
      }),
      vectorTimeoutMs: n('embed 超时', 800, {
        min: 50, max: 10_000, step: 50, hot: 'reload', advanced: true, unit: 'ms',
        help: '09 §5.4 定的 800ms：拿不到向量就放弃这一路，不拖住一回合的组包。',
      }),
      vectorWeight: n('余弦权重', 1, {
        min: 0, max: 1, step: 0.05, hot: 'reload', advanced: true,
        help: '有向量时相关性 = 权重×余弦 + (1−权重)×关键词；1 = 纯余弦（默认，09 §5.2）。',
      }),
    },
  },
  {
    id: 'people',
    label: '人物档',
    page: 'memory',
    fields: {
      // 读法：people 子插件挂载时注册工具；改配置会重挂（watches people）。
      enabled: b('启用', false, {
        hot: 'live',
        help: '默认关。打开后注册 qq_person_note：按房间记「谁爱用什么说法、忌讳什么」，只用于认人接话，不当证据引用。',
      }),
      dir: s('存储目录', null, { help: '留空 = <工作区>/people。', hot: 'restart' }),
    },
  },
]
