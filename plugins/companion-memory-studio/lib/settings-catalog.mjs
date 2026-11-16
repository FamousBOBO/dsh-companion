// 陪伴空间 · 设置字段目录（W1 的单一字段注册表）。
//
// 计划 §3 W1-2 要求「生成唯一字段注册目录，字段元信息至少包括
// id/label/keywords/description/category/source/owner/permission/hotLevel/available/status」，
// 并且「元数据从现有 QQ schema、Studio descriptor 与宿主 API 导出，避免手工维护第二份字段目录」。
//
// 这个模块**不存任何字段清单**：它只做两件事——
//   1. 把两个**已有**权威来源（QQ 的 `fieldRefs()`、Studio 的 `SETTINGS_SPEC`/`SECRET_SPEC`）
//      投影成同一套元信息形状；
//   2. 提供一个确定性、可单测的搜索函数。
// 所以「目录」永远是源码的投影，不会成为第四份需要人工同步的清单。
//
// 写入口的归属（owner）跟着来源走：QQ 字段的写入口是 QQ 插件的 `applyConfigPatch()`
// （经 `studio-bridge` 或 8790 后台），Studio 字段的写入口是本包 `POST /settings`。
// 目录只描述「谁拥有这个字段」，不复制校验规则。

/** 计划 W1-2 要求的元信息键，顺序固定，方便前端直接按列渲染。 */
export const CATALOG_META_KEYS = Object.freeze([
  'id', 'label', 'keywords', 'description', 'category', 'source',
  'owner', 'permission', 'hotLevel', 'available', 'status',
]);

/** 热生效等级的固定词汇（与 QQ schema 的 `live|reload|restart` 同一套，不自创第四种）。 */
export const HOT_LEVELS = Object.freeze(['live', 'reload', 'restart']);

/** 字段状态：只表达目录**能证明**的事，不猜运行态。 */
export const STATUSES = Object.freeze([
  'default',      // 只有默认值，没有任何上层覆盖
  'configured',   // 上层（patch / override）里存在这个键
  'secret-set',   // 只写密钥：值存在于密钥文件，目录不读明文
  'secret-unset', // 只写密钥：未配置
  'unknown',      // 拿不到层信息（例如没有活桥接时的 QQ 字段）
  'unavailable',  // 所属模块当前未装载
]);

/** 权限口径：与 docs/25-g0 §3.5.1 的实测一致——有 viewer 判定的路由才是 owner。 */
export const PERMISSIONS = Object.freeze(['owner', 'host', 'client']);

const PAGE_LABELS = Object.freeze({
  connection: '连接与账号', groups: '群聊与房间', messages: '消息与回复', media: '图片与语音',
  stickers: '表情包', links: '链接与生图', music: '音乐', quotes: '语录', learn: '学习与口癖',
  reminders: '提醒', rss: '订阅', flood: '风控', events: '群事件', proactive: '主动行为',
  memory: '记忆', persona: '人格', tools: '工具与策略', skills: '技能', kb: '知识库',
  logs: '日志', metrics: '指标', audit: '审计', backup: '备份与恢复', security: '安全',
  runtime: '运行信息', debug: '调试', providers: '模型供应商', overview: '概览',
});

/** Studio 设置页的分区中文名（`pages-settings.js` 的 section id）。 */
const STUDIO_SECTION_LABELS = Object.freeze({
  extract: '自动提炼', retrieval: '检索与融合', wiki: 'Wiki 编译',
  embedding: '向量通道', rerank: '重排序', storage: '存储', theme: '外观',
});

/**
 * 人工别名表：只在「同一个概念有多个常用说法」时补一条。
 *
 * 这是本模块里唯一的常量表，而且**只影响搜索命中，不影响任何写入或校验**——
 * 漏一条的后果是「按这个说法搜不到」，不是「写错了地方」。所以它可以慢慢长，
 * 不需要与 schema 同步。
 */
const ALIASES = Object.freeze({
  talkValue: ['回复概率', '接话概率', '理人概率'],
  requireMention: ['必须at', '艾特', '叫我才理'],
  primaryGroup: ['主群'],
  admins: ['管理员', '主人号'],
  accessToken: ['令牌', 'token', '鉴权'],
  'segmentation.enabled': ['分段', '拆条', '分条回复'],
  'segmentation.maxSegments': ['最多几条', '条数上限'],
  'batching.dmEnabled': ['攒批', '合并回复', '等待窗口'],
  'flood.enabled': ['刷屏', '防刷', '风控'],
  'flood.maxMessages': ['刷屏阈值'],
  'memory.v2': ['记忆注入', '结构化记忆'],
  'memory.maxRecords': ['注入条数'],
  'stt.enabled': ['语音转文字', 'asr'],
  'tts.enabled': ['念出来', '语音回复', '配音'],
  'imageGen.enabled': ['生图', '画图'],
  'linkResolve.enabled': ['链接卡片', '解析链接'],
  'reminders.enabled': ['提醒', '叫我'],
  'rss.enabled': ['订阅', 'rss'],
  'presence.enabled': ['旁听', '自主接话'],
  'contact.enabled': ['主动消息', '主动联系'],
  topK: ['召回条数', '召回数量', '检索条数'],
  budgetChars: ['注入预算', '字符预算'],
  rrfK: ['rrf', '融合常数'],
  mmrLambda: ['mmr', '多样性'],
  coverageFloor: ['覆盖度', '召回门槛'],
  semanticEnabled: ['语义检索', '向量检索'],
  embeddingProvider: ['向量提供器', 'embedding'],
  embeddingBaseUrl: ['向量地址', 'embedding url'],
  embeddingModel: ['向量模型'],
  embeddingDimensions: ['向量维度'],
  rerankEnabled: ['重排', '重排序'],
  rerankBaseUrl: ['重排地址'],
  rerankModel: ['重排模型'],
  rerankTimeoutMs: ['重排超时'],
  rerankTopN: ['重排候选'],
  rerankBlend: ['重排权重', 'blend'],
  wikiAutoCompile: ['wiki 编译', '自动编译'],
  wikiMaxEntriesPerTopic: ['wiki 条数'],
  backend: ['存储后端', 'sqlite', 'legacy'],
  embeddingApiKey: ['向量 key', 'embedding key'],
  rerankApiKey: ['重排 key'],
});

/** 把任意文本压成可比较的检索键：小写、去空白与常见分隔符。 */
export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s_\-.:/·、，,（）()【】[\]]+/g, '')
    .trim();
}

/**
 * 关键词生成：路径分段 + 标签 + 别名 + 分区名。
 * 只产出**去重后的字符串数组**，不产出权重（权重在评分时按来源分层）。
 */
export function keywordsOf({ id, label, path, section, aliases = [], extra = [] }) {
  const out = new Set();
  const push = (value) => {
    const text = String(value ?? '').trim();
    if (text) out.add(text);
  };
  push(label);
  for (const part of String(path ?? '').split('.')) push(part);
  if (section) push(section);
  for (const alias of aliases) push(alias);
  for (const item of extra) push(item);
  return [...out];
}

/** help 文本里太长，只取第一句当检索词（整段拼进关键词会让搜索噪声过大）。 */
function helpKeywords(help) {
  const text = String(help ?? '').replace(/\*\*|`/g, '').trim();
  const firstClause = text.split(/[。；;]/)[0];
  return firstClause.length > 40 ? firstClause.slice(0, 40) : firstClause;
}

/**
 * 从 QQ `fieldRefs()` 投影成目录条目。
 *
 * @param refs      `fieldRefs()` 的返回（每项 `{path, section, page, spec}`）
 * @param options   `{ overridePaths, patchPaths, moduleAvailable }`——
 *                  `overridePaths/patchPaths` 是 dot-path 集合，用来判 `status`；
 *                  拿不到就写 `unknown`（不猜）。
 */
export function catalogFromQQ(refs, options = {}) {
  const overridePaths = options.overridePaths ?? null;
  const patchPaths = options.patchPaths ?? null;
  const available = options.moduleAvailable !== false;
  const entries = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    const spec = ref.spec ?? {};
    const secret = spec.secret === true;
    const dormant = spec.dormant === true;
    const hotLevel = HOT_LEVELS.includes(spec.hot) ? spec.hot : 'restart';
    let status = 'unknown';
    if (!available) status = 'unavailable';
    else if (secret) status = 'secret-unset';
    else if (overridePaths || patchPaths) {
      const inOverride = overridePaths ? overridePaths.has(ref.path) : false;
      const inPatch = patchPaths ? patchPaths.has(ref.path) : false;
      status = inOverride || inPatch ? 'configured' : 'default';
    }
    entries.push({
      id: `qq:${ref.path}`,
      label: String(spec.label ?? ref.path),
      keywords: keywordsOf({
        id: ref.path, label: spec.label, path: ref.path, section: ref.section,
        aliases: ALIASES[ref.path] ?? [],
        extra: [PAGE_LABELS[ref.page] ?? '', helpKeywords(spec.help)].filter(Boolean),
      }),
      description: String(spec.help ?? '').replace(/\*\*|`/g, '').trim(),
      category: PAGE_LABELS[ref.page] ?? (ref.section ?? '其他'),
      source: 'qq-schema',
      owner: 'dsh-channel-qq',
      permission: 'owner',
      hotLevel,
      available,
      status,
      // 目录之外的定位信息：深链与渲染都需要，但不算「元信息键」。
      page: ref.page ?? null,
      section: ref.section ?? null,
      path: ref.path,
      kind: String(spec.kind ?? ''),
      secret,
      dormant,
      deepLink: ref.page ? `qq:${ref.page}` : null,
    });
  }
  return entries;
}

/**
 * 从 Studio 的 `SETTINGS_SPEC` / `SECRET_SPEC` 投影成目录条目。
 *
 * @param spec        `SETTINGS_SPEC`（`{ [key]: { section, key, check } }`）
 * @param secretSpec  `SECRET_SPEC`（`{ [key]: section }`）
 * @param clientFields 客户端 `FIELDS` 的元数据（`{ [key]: { section, label, control, path, hint, min, max } }`）。
 *                     目录用它补 label/hint/范围——这与「唯一 owner」不冲突：客户端本来
 *                     就是渲染元数据的所有者，目录只是读它，不复制写入口。
 * @param options     `{ overridePaths, secretSet, secretLabels, moduleAvailable }`
 */
export function catalogFromStudio(spec, secretSpec, clientFields, options = {}) {
  const fields = clientFields ?? {};
  const overridePaths = options.overridePaths ?? null;
  const secretSet = options.secretSet ?? {};
  const secretLabels = options.secretLabels ?? {};
  const available = options.moduleAvailable !== false;
  const entries = [];

  for (const [key, entry] of Object.entries(spec ?? {})) {
    const meta = fields[key] ?? {};
    const dotPath = String(meta.path ?? entry?.key ?? key);
    const section = entry?.section ?? meta.section ?? null;
    const label = String(meta.label ?? key);
    entries.push({
      id: `studio:${key}`,
      label,
      keywords: keywordsOf({
        id: key, label, path: dotPath, section,
        aliases: ALIASES[key] ?? [],
        extra: [STUDIO_SECTION_LABELS[section] ?? '', meta.hint ?? ''].filter(Boolean),
      }),
      description: String(meta.hint ?? '').trim(),
      category: STUDIO_SECTION_LABELS[section] ?? String(section ?? '其他'),
      source: 'studio-spec',
      owner: 'companion-memory-studio',
      // Studio 设置路由**没有** viewer 判定（见 docs/25 §3.5.1），所以这里如实标 host，
      // 不跟着「记忆路由是 owner-only」的习惯写法把它写成 owner。
      permission: 'host',
      hotLevel: 'restart',
      available,
      status: !available ? 'unavailable' : (overridePaths ? (overridePaths.has(dotPath) ? 'configured' : 'default') : 'unknown'),
      page: 'settings',
      section,
      path: dotPath,
      kind: String(meta.control ?? ''),
      secret: false,
      dormant: false,
      deepLink: 'studio:settings',
    });
  }

  for (const [key, section] of Object.entries(secretSpec ?? {})) {
    const label = String(secretLabels[key] ?? key);
    const dotPath = `secrets.${key}`;
    entries.push({
      id: `studio:${key}`,
      label,
      keywords: keywordsOf({
        id: key, label, path: key, section,
        aliases: ALIASES[key] ?? [],
        extra: [STUDIO_SECTION_LABELS[section] ?? ''].filter(Boolean),
      }),
      description: '只写字段：保存后不回显明文。',
      category: STUDIO_SECTION_LABELS[section] ?? String(section ?? '其他'),
      source: 'studio-spec',
      owner: 'companion-memory-studio',
      permission: 'host',
      hotLevel: 'restart',
      available,
      status: !available ? 'unavailable' : (secretSet[key] ? 'secret-set' : 'secret-unset'),
      page: 'settings',
      section,
      path: dotPath,
      kind: 'secret',
      secret: true,
      dormant: false,
      deepLink: 'studio:settings',
    });
  }

  return entries;
}

/** 把目录条目投影成计划要求的固定元信息形状（不含定位扩展字段）。 */
export function toMetaView(entry) {
  const out = {};
  for (const key of CATALOG_META_KEYS) out[key] = entry[key];
  return out;
}

/**
 * 目录条目的对外形状：固定元信息 + 深链定位。
 *
 * 空查询与命中查询**必须**回同一套键——否则前端在「打开面板」与「输入搜索词」两种状态下
 * 拿到的条目字段不同，聚焦逻辑会一半能跑一半 undefined（实测踩过）。
 */
function publicMatch(entry, score) {
  return {
    ...toMetaView(entry),
    score,
    page: entry.page,
    section: entry.section,
    path: entry.path,
    kind: entry.kind,
    secret: entry.secret,
    deepLink: entry.deepLink,
  };
}

/**
 * 搜索。命中分层（分数只用来排序，不对外暴露具体权重）：
 *   3 标签完全相等 · 2 标签包含 · 2 关键词完全相等 · 1 关键词包含
 *   1 路径包含 · 0.5 描述包含
 * 中文按字匹配即可（不做分词：目录总量 < 400，分词只会引入不稳定行为）。
 */
export function searchCatalog(entries, query, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 40;
  const raw = String(query ?? '').trim();
  const normalized = normalizeText(raw);

  if (!normalized) {
    // 空查询不是错误：回稳定列表，便于打开搜索面板时先看到东西。
    const base = entries.filter((entry) => entry.status !== 'unavailable');
    return {
      query: raw,
      total: base.length,
      returned: Math.min(limit, base.length),
      matches: base.slice(0, limit).map((entry) => publicMatch(entry, 0)),
    };
  }

  const scored = [];
  for (const entry of entries) {
    const label = normalizeText(entry.label);
    const path = normalizeText(entry.path);
    const description = normalizeText(entry.description);
    let score = 0;
    if (label === normalized) score = 3;
    else if (label.includes(normalized)) score = 2;
    if (score === 0) {
      for (const keyword of entry.keywords) {
        const norm = normalizeText(keyword);
        if (!norm) continue;
        if (norm === normalized) { score = Math.max(score, 2); break; }
        if (norm.includes(normalized)) score = Math.max(score, 1);
      }
    }
    if (score === 0 && path && path.includes(normalized)) score = 1;
    if (score === 0 && description && description.includes(normalized)) score = 0.5;
    if (score === 0) continue;
    scored.push({ entry, score });
  }

  // 稳定排序：分数降序 → 可用优先 → 标签长度（越短越像用户想找的）→ id 字典序。
  scored.sort((left, right) => (
    right.score - left.score
    || Number(right.entry.available) - Number(left.entry.available)
    || left.entry.label.length - right.entry.label.length
    || left.entry.id.localeCompare(right.entry.id)
  ));

  const matches = scored.slice(0, limit).map(({ entry, score }) => publicMatch(entry, score));

  return { query: raw, total: scored.length, returned: matches.length, matches };
}
