// 记忆档案 Studio · 只读接口。
//
// 所有函数签名统一为 (request, kernel) -> Response，由 server.mjs 的 guard
// 统一兜底。这里只做查询与脱敏，不写库、不写文件。
//
// 隐私规则（契约 §4.3 / 任务要求）：
//   mentionPolicy=avoid_unless_asked 只是"模型主动提及"的策略，不再影响管理界面可见性：
//   列表、预览、审核、时间线、详情一律返回可读正文（2026-10-31 用户明确要求全可见）。
//   旧的 reveal=1 参数仍然接受，但没有任何作用；meta.revealed 恒为 false。

import path from 'node:path';

import {
  REMOTE_MODELS_FILE, loadConfig, readRemoteModels,
} from '../../companion-memory/config.mjs';
import { KINDS, SCOPES, STATUSES } from '../../companion-memory/lib/policy.mjs';
import { formatMoment } from '../../companion-memory/lib/text.mjs';
import {
  ApiError, clampInt, correctionEvidence, isHiddenRecord, pickEnum, safePreview, textValue,
} from './api-kernel.mjs';

const RELATED_SORT = Object.freeze(['recent', 'importance', 'confidence']);
const MAX_LIST_LIMIT = 100;
// 列表/搜索一次最多取这么多行再在内存里过滤与分页；管理台数据量与 777 条
// 历史归档同量级，这个上限保证响应稳定，且不会被超大库拖死。
const SCAN_LIMIT = 5000;

const GENERATED_BEGIN = /<!--\s*generated:begin[\s\S]*?-->/;
const GENERATED_END = /<!--\s*generated:end\s*-->/;
const MANUAL_BEGIN = '<!-- manual:begin -->';
const MANUAL_END = '<!-- manual:end -->';

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stringOr(value, fallback = '') {
  return value == null ? fallback : String(value);
}

/**
 * 定位 Wiki 页面里的生成区与人工区。
 * 生成区取第一对合法标记；人工区只认生成区之外的一对标记，避免把记忆正文里
 * 伪造的 marker 当结构（与 lib/wiki.mjs 的保守策略一致：有歧义就不动文件）。
 * -> { generated: {start,end}|null, manual: {start,end,innerStart,innerEnd}|null }
 */
export function parseWikiLayout(markdown) {
  const text = String(markdown ?? '');
  const begin = GENERATED_BEGIN.exec(text);
  const end = GENERATED_END.exec(text);
  let generated = null;
  if (begin && end && begin.index < end.index) {
    generated = { start: begin.index, end: end.index + end[0].length };
  }
  const insideGenerated = (start, finish) => Boolean(generated)
    && start >= generated.start && finish <= generated.end;

  const manualBegins = [];
  const manualEnds = [];
  for (let index = text.indexOf(MANUAL_BEGIN); index >= 0; index = text.indexOf(MANUAL_BEGIN, index + 1)) {
    if (!insideGenerated(index, index + MANUAL_BEGIN.length)) manualBegins.push(index);
  }
  for (let index = text.indexOf(MANUAL_END); index >= 0; index = text.indexOf(MANUAL_END, index + 1)) {
    if (!insideGenerated(index, index + MANUAL_END.length)) manualEnds.push(index);
  }
  let manual = null;
  if (manualBegins.length === 1 && manualEnds.length === 1 && manualBegins[0] < manualEnds[0]) {
    manual = {
      start: manualBegins[0],
      end: manualEnds[0] + MANUAL_END.length,
      innerStart: manualBegins[0] + MANUAL_BEGIN.length,
      innerEnd: manualEnds[0],
    };
  }
  return { generated, manual };
}

/** 页面摘要：人工区文本 + 生成区字节数，供 GET wiki-page 使用。 */
export function summarizeWikiMarkdown(markdown) {
  const text = String(markdown ?? '');
  const layout = parseWikiLayout(text);
  const manualNotes = layout.manual
    ? text.slice(layout.manual.innerStart, layout.manual.innerEnd).trim()
    : '';
  const generatedBytes = layout.generated
    ? Buffer.byteLength(text.slice(layout.generated.start, layout.generated.end), 'utf8')
    : 0;
  return { manualNotes, generatedBytes, hasManualRegion: Boolean(layout.manual), layout };
}

/** 关联数量：db.mjs 目前没有全局计数，优先用将来可能新增的方法，否则只读兜底。 */
function countRelations(db) {
  try {
    if (typeof db.countRelations === 'function') {
      const value = Number(db.countRelations());
      if (Number.isFinite(value) && value >= 0) return Math.trunc(value);
    }
    const handle = db.handle;
    if (handle && typeof handle.prepare === 'function') {
      const row = handle.prepare('SELECT count(*) AS total FROM memory_relations').get();
      return numberOr(row?.total, 0);
    }
  } catch {
    // 关联表不可读时如实报 0，不让整个总览失败。
  }
  return 0;
}

function listItem(record) {
  return {
    id: record.id,
    kind: record.kind,
    scope: record.scope,
    status: record.status,
    policy: record.mentionPolicy,
    key: record.predicate || record.subject || '',
    preview: safePreview(record.value, 120),
    importance: numberOr(record.importance, 0),
    confidence: numberOr(record.confidence, 0),
    // 发生时间（记忆对应的时间点）与更新时间分开给，前端不再把「刚改过」当成「刚发生」。
    occurredAt: record.occurredAt ?? null,
    occurredAtText: formatMoment(record.occurredAt ?? ''),
    updatedAt: record.updatedAt,
    updatedAtText: formatMoment(record.updatedAt ?? ''),
    // 固定 false：管理界面不再有"隐藏正文"这一档，保留字段只为老前端兼容。
    hidden: false,
    // 仍在字段里保留表达策略，前端可以显示"模型不主动提及"，但它不代表用户看不到。
    mentionPolicy: record.mentionPolicy,
  };
}

/** 稳定的记录比较器；`recent` 以 updatedAt 倒序作为兜底。 */
function comparatorFor(sort) {
  const byUpdated = (left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''));
  if (sort === 'importance') {
    return (left, right) => numberOr(right.importance) - numberOr(left.importance) || byUpdated(left, right);
  }
  if (sort === 'confidence') {
    return (left, right) => numberOr(right.confidence) - numberOr(left.confidence) || byUpdated(left, right);
  }
  return byUpdated;
}

// ---------------------------------------------------------------------------
// 4.1 总览
// ---------------------------------------------------------------------------

export async function summary(request, kernel) {
  const internal = await kernel.internal();
  const db = kernel.requireDb(internal);
  const viewer = kernel.viewer(internal);
  const config = internal.config ?? {};
  const stats = (() => {
    try { return db.stats(); } catch { return {}; }
  })();

  const countStatus = status => {
    try {
      return numberOr(db.countMemories({
        userId: viewer.userId, personaId: viewer.personaId, worldId: viewer.worldId,
        status, includeExpired: true,
      }), 0);
    } catch {
      return 0;
    }
  };

  const scopeCounts = [];
  for (const scope of SCOPES) {
    let count = 0;
    try {
      count = numberOr(db.countMemories({
        userId: viewer.userId, personaId: viewer.personaId, worldId: viewer.worldId,
        scope, includeExpired: true,
      }), 0);
    } catch { count = 0; }
    if (count > 0) scopeCounts.push({ scope, count });
  }
  const kindCounts = [];
  for (const kind of KINDS) {
    let count = 0;
    try {
      count = numberOr(db.countMemories({
        userId: viewer.userId, personaId: viewer.personaId, worldId: viewer.worldId,
        kind, includeExpired: true,
      }), 0);
    } catch { count = 0; }
    if (count > 0) kindCounts.push({ kind, count });
  }

  let jobStats = { pending: 0, running: 0, failed: 0, done: 0 };
  try { jobStats = { ...jobStats, ...db.jobStats() }; } catch { /* 作业表不可读时保持零值 */ }
  let lastError = null;
  try {
    const failed = db.jobs({ state: 'failed', limit: 1 });
    lastError = failed.length ? safePreview(failed[0].lastError, 200) || null : null;
  } catch { lastError = null; }

  let pages = [];
  try { pages = db.listWikiPages().filter(page => page.scope !== 'system'); } catch { pages = []; }

  // 最近记忆：按「最近更新」倒序取（最新在前）。`listMemories` 是重要度优先，
  // 直接用它会把最古早的高重要度行顶到前面，所以这里走时间序的方法。
  let recentRows = [];
  try {
    const readRecent = typeof db.listMemoriesByTime === 'function'
      ? filter => db.listMemoriesByTime(filter)
      : filter => db.listMemories(filter);
    recentRows = readRecent({
      userId: viewer.userId, personaId: viewer.personaId, worldId: viewer.worldId,
      status: 'confirmed', includeExpired: false, limit: 8,
    }).sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
  } catch { recentRows = []; }

  const embeddingProvider = stringOr(config.embedding?.provider, 'off');
  const semanticEnabled = Boolean(config.retrieval?.semanticEnabled);
  const embeddingNote = !semanticEnabled
    ? '语义检索已在配置中关闭。'
    : embeddingProvider === 'off'
      ? '向量通道已关闭。'
      : embeddingProvider === 'local'
        ? '本地哈希向量，不联网。'
        : '远端向量服务，失败时自动降级。';

  const checkedAt = typeof db.integrityCheckedAt === 'string' && db.integrityCheckedAt
    ? db.integrityCheckedAt
    : null;

  const data = {
    version: stringOr(kernel.engine?.version, '0.0.0'),
    backend: stringOr(internal.backend ?? kernel.engine?.backend, 'legacy'),
    reason: kernel.engine?.reason ? String(kernel.engine.reason) : null,
    database: internal.databaseFile ? String(internal.databaseFile) : null,
    observedAt: kernel.meta().observedAt,
    counts: {
      memories: numberOr(stats.memories, 0),
      confirmed: numberOr(stats.confirmedMemories, countStatus('confirmed')),
      pending: numberOr(stats.pendingMemories, countStatus('pending')),
      superseded: countStatus('superseded'),
      archived: countStatus('archived'),
      events: numberOr(stats.events, 0),
      embeddings: numberOr(stats.embeddings, 0),
      wikiPages: numberOr(stats.wikiPages, 0),
      relations: countRelations(db),
    },
    scopeCounts,
    kindCounts,
    jobs: { ...jobStats, lastError },
    channels: {
      fts: 'ok',
      embedding: {
        provider: embeddingProvider,
        model: stringOr(config.embedding?.model, ''),
        note: embeddingNote,
      },
      extraction: {
        enabled: Boolean(config.extraction?.enabled),
        minMessages: numberOr(config.extraction?.minMessages, 0),
        model: stringOr(config.extraction?.model, '') || '未配置',
      },
      wiki: {
        enabled: Boolean(config.wiki?.enabled),
        pages: pages.length,
        dir: stringOr(internal.wikiDir, ''),
      },
    },
    config: {
      backend: stringOr(config.backend, 'legacy'),
      extractionEnabled: Boolean(config.extraction?.enabled),
      semanticEnabled,
      budgetChars: numberOr(config.injection?.budgetChars, 2400),
      topK: numberOr(config.retrieval?.topK, 8),
      coverageFloor: numberOr(config.retrieval?.coverageFloor, 0.15),
    },
    integrity: checkedAt
      ? { checkedAt, ok: true, mode: stringOr(db.integrityMode, '') }
      : null,
    recent: recentRows.slice(0, 8).map(record => ({
      id: record.id,
      kind: record.kind,
      scope: record.scope,
      status: record.status,
      policy: record.mentionPolicy,
      preview: safePreview(record.value, 120),
      occurredAt: record.occurredAt ?? null,
      occurredAtText: formatMoment(record.occurredAt ?? ''),
      updatedAt: record.updatedAt,
      hidden: false,
    })),
  };
  return kernel.ok(data);
}

// ---------------------------------------------------------------------------
// 4.2 记忆库列表 / 搜索
// ---------------------------------------------------------------------------

export async function memories(request, kernel) {
  const internal = await kernel.internal();
  const db = kernel.requireDb(internal);
  const viewer = kernel.viewer(internal);
  const query = kernel.query(request);

  const limit = clampInt(query.get('limit'), 1, MAX_LIST_LIMIT, 25);
  const offset = clampInt(query.get('offset'), 0, 1_000_000, 0);
  const scope = pickEnum(query.get('scope'), SCOPES, '');
  const kind = pickEnum(query.get('kind'), KINDS, '');
  const status = pickEnum(query.get('status'), STATUSES, '');
  const searchText = textValue(query.get('query'), 200);
  const hasSort = query.has('sort');
  const sort = pickEnum(query.get('sort'), RELATED_SORT, 'recent');

  const matches = record => {
    if (!record) return false;
    if (record.userId !== viewer.userId || record.personaId !== viewer.personaId) return false;
    if (scope && record.scope !== scope) return false;
    if (kind && record.kind !== kind) return false;
    if (status && record.status !== status) return false;
    return true;
  };

  let rows = [];
  let total = 0;
  if (searchText) {
    // 有查询词时先走 FTS，再按结构化条件精筛；FTS 结果本身已按 owner 过滤。
    let hits = [];
    try {
      hits = db.fullTextSearch({
        userId: viewer.userId,
        personaId: viewer.personaId,
        worldId: viewer.worldId,
        query: searchText,
        limit: SCAN_LIMIT,
        statuses: status ? [status] : [],
      });
    } catch {
      hits = [];
    }
    const filtered = [];
    for (const hit of Array.isArray(hits) ? hits : []) {
      let record = null;
      try { record = db.getMemory(hit.id); } catch { record = null; }
      if (!matches(record)) continue;
      filtered.push({ record, score: numberOr(hit.score, 0) });
    }
    total = filtered.length;
    if (hasSort) {
      const compare = comparatorFor(sort);
      filtered.sort((left, right) => compare(left.record, right.record));
    } else {
      // 默认按相关度（-bm25 越大越相关），并列时新的在前。
      filtered.sort((left, right) => right.score - left.score
        || String(right.record.updatedAt ?? '').localeCompare(String(left.record.updatedAt ?? '')));
    }
    rows = filtered.slice(offset, offset + limit).map(item => listItem(item.record));
  } else {
    const filter = {
      userId: viewer.userId,
      personaId: viewer.personaId,
      worldId: viewer.worldId,
      includeExpired: true,
      limit: SCAN_LIMIT,
    };
    if (scope) filter.scope = scope;
    if (kind) filter.kind = kind;
    if (status) filter.status = status;
    let all = [];
    try {
      // 管理界面一律按「最近更新」倒序取窗（最新在前），再按用户选择的排序重排。
      // `listMemories` 是重要度优先：直接用它会把最古早的高重要度行装进窗口，
      // 最新记录反而被 LIMIT 截掉。
      const readWindow = typeof db.listMemoriesByTime === 'function'
        ? value => db.listMemoriesByTime(value)
        : value => db.listMemories(value);
      all = readWindow(filter);
    } catch { all = []; }
    total = (() => {
      try {
        const countFilter = { ...filter };
        delete countFilter.limit;
        return numberOr(db.countMemories(countFilter), all.length);
      } catch {
        return all.length;
      }
    })();
    const sorted = [...all].sort(comparatorFor(sort));
    rows = sorted.slice(offset, offset + limit).map(listItem);
  }

  return kernel.ok({ items: rows, total, offset, limit, query: searchText });
}

// ---------------------------------------------------------------------------
// 4.3 单条记忆详情
// ---------------------------------------------------------------------------

export async function memoryDetail(request, kernel) {
  const internal = await kernel.internal();
  const db = kernel.requireDb(internal);
  const viewer = kernel.viewer(internal);
  const query = kernel.query(request);

  const id = textValue(query.get('id'), 80);
  if (!id) throw new ApiError('bad-request', '缺少记忆 id。', 400);

  const record = (() => {
    try { return db.getMemory(id); } catch { return null; }
  })();
  if (!record || record.userId !== viewer.userId || record.personaId !== viewer.personaId) {
    throw new ApiError('not-found', '没有找到这条记忆。', 404);
  }

  // 旧链接里的 reveal=1 仍然接受，但已经不需要：owner 自己查看自己的记忆一律给全文。
  const reveal = query.get('reveal') === '1';
  const bodyVisible = true;

  let evidence = [];
  try {
    evidence = db.evidenceFor(id).map(item => {
      let event = null;
      try { event = item.sourceId ? db.getEvent(item.sourceId) : null; } catch { event = null; }
      return {
        sourceId: item.sourceId,
        sessionId: stringOr(event?.sessionId, ''),
        seq: numberOr(event?.seq, 0),
        role: stringOr(item.role ?? event?.role, ''),
        occurredAt: item.occurredAt ?? event?.occurredAt ?? null,
        excerpt: bodyVisible ? safePreview(item.content, 160) : '',
      };
    })
      // 证据链也按最新在前，和列表、时间线保持一致。
      .sort((left, right) => String(right.occurredAt ?? '').localeCompare(String(left.occurredAt ?? '')));
  } catch { evidence = []; }

  let revisions = [];
  try {
    revisions = db.revisionsFor(id).map(item => ({
      id: item.revisionId,
      operation: item.operation,
      actor: item.actor,
      reason: item.reason,
      at: item.createdAt,
      oldId: item.oldId,
      newId: item.newId,
    }))
      // 修订链同样最新在前（顶部永远是当前值那一次操作）。
      .sort((left, right) => String(right.at ?? '').localeCompare(String(left.at ?? '')));
  } catch { revisions = []; }

  let related = [];
  try {
    related = db.relationsFor(id).map(item => ({
      relation: item.relation,
      targetRef: item.targetRef,
      confidence: numberOr(item.confidence, 0),
    }));
  } catch { related = []; }

  const data = {
    id: record.id,
    key: record.predicate || record.subject || '',
    value: bodyVisible ? record.value : '',
    kind: record.kind,
    scope: record.scope,
    status: record.status,
    policy: record.mentionPolicy,
    importance: numberOr(record.importance, 0),
    confidence: numberOr(record.confidence, 0),
    subject: record.subject,
    predicate: record.predicate,
    realityLevel: record.realityLevel,
    sourceKind: record.sourceKind,
    tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
    validFrom: record.validFrom ?? null,
    validTo: record.validTo ?? null,
    occurredAt: record.occurredAt ?? null,
    occurredAtText: formatMoment(record.occurredAt ?? ''),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    updatedAtText: formatMoment(record.updatedAt ?? ''),
    revision: numberOr(record.revision, 1),
    supersedesId: record.supersedesId || '',
    hidden: false,
    revealable: false,
    evidence,
    revisions,
    related,
  };
  return kernel.ok(data, reveal ? { revealed: true } : null);
}

// ---------------------------------------------------------------------------
// 4.5 / 4.6 Wiki
// ---------------------------------------------------------------------------

function topicOf(pageId) {
  return {
    'user-profile': '用户画像与稳定偏好',
    'user-preferences': '用户偏好',
    'relationship-march7': '三月七与用户的关系',
    'important-events': '重要共同事件与未完成承诺',
  }[pageId] ?? '';
}

export async function wikiIndex(request, kernel) {
  const internal = await kernel.internal();
  const db = kernel.requireDb(internal);
  kernel.viewer(internal);
  const wiki = await import('../../companion-memory/lib/wiki.mjs');

  let pages = [];
  try { pages = db.listWikiPages().filter(page => page.scope !== 'system'); } catch { pages = []; }
  return kernel.ok({
    pages: pages.map(page => ({
      pageId: page.pageId,
      topic: page.topic || topicOf(page.pageId),
      scope: page.scope,
      path: page.path,
      revision: numberOr(page.sourceRevision, 0),
      status: page.status,
      notes: page.notes || '',
    })),
    topics: wiki.WIKI_TOPICS.map(topic => ({ id: topic.id, topic: topic.topic, path: topic.path })),
    dir: stringOr(internal.wikiDir, ''),
  });
}

export async function wikiPage(request, kernel) {
  const internal = await kernel.internal();
  const db = kernel.requireDb(internal);
  kernel.viewer(internal);
  const wiki = await import('../../companion-memory/lib/wiki.mjs');
  const query = kernel.query(request);

  const pageId = textValue(query.get('page'), 120);
  if (!pageId) throw new ApiError('bad-request', '缺少页面标识。', 400);
  const topic = wiki.topicById(pageId);
  if (!topic) throw new ApiError('not-found', '没有这个 Wiki 主题。', 404);

  let page;
  try {
    page = wiki.readPage({ dir: String(internal.wikiDir ?? ''), topicId: topic.id });
  } catch {
    throw new ApiError('bad-request', 'Wiki 页面标识不合法。', 400);
  }
  let row = null;
  try { row = db.wikiPage(topic.id); } catch { row = null; }
  const summaryPage = summarizeWikiMarkdown(page.markdown);

  return kernel.ok({
    pageId: topic.id,
    topic: row?.topic || topic.topic,
    path: page.path,
    exists: Boolean(page.exists),
    content: page.markdown,
    compiledAt: row?.compiledAt || '',
    revision: numberOr(row?.sourceRevision, 0),
    notes: row?.notes || '',
    manualNotes: summaryPage.manualNotes,
    generatedBytes: summaryPage.generatedBytes,
  });
}

// ---------------------------------------------------------------------------
// 4.8 检索诊断（不写库）
// ---------------------------------------------------------------------------

const REASON_LABELS = new Set(['lexical', 'semantic', 'hybrid', 'recent']);

export async function preview(request, kernel) {
  const internal = await kernel.internal();
  const db = kernel.requireDb(internal);
  const viewer = kernel.viewer(internal);
  const query = kernel.query(request);

  const searchText = textValue(query.get('q'), 300);
  const limit = clampInt(query.get('limit'), 1, 20, 8);
  const config = internal.config ?? {};
  const budgetChars = clampInt(config.injection?.budgetChars, 400, 8000, 2400);

  const [retrieve, render] = await Promise.all([
    import('../../companion-memory/lib/retrieve.mjs'),
    import('../../companion-memory/lib/render.mjs'),
  ]);

  let result = { entries: [], explain: {} };
  try {
    result = await retrieve.recall({
      db,
      // Studio 没有会话，也不持有 embedder 工厂：预览只跑词法通道并如实透传
      // explain，用户在“检索诊断”里看到的仍是真实召回结果。
      embedder: null,
      viewer,
      query: searchText,
      config: { ...(config.retrieval ?? {}), topK: limit },
      now: Date.now(),
    });
  } catch {
    result = { entries: [], explain: { backend: 'none', filteredReasons: {} } };
  }

  const entries = (Array.isArray(result.entries) ? result.entries : []).slice(0, limit).map(entry => {
    const record = entry.record ?? {};
    const channels = Array.isArray(entry.channels) ? entry.channels.map(String) : [];
    const reason = channels.length > 1
      ? 'hybrid'
      : REASON_LABELS.has(channels[0]) ? channels[0] : (searchText ? 'lexical' : 'recent');
    return {
      id: String(record.id ?? ''),
      kind: String(record.kind ?? ''),
      scope: String(record.scope ?? ''),
      policy: String(record.mentionPolicy ?? ''),
      preview: safePreview(record.value, 160),
      score: numberOr(entry.score, 0),
      reason,
    };
  });

  let rendered = '';
  try {
    rendered = render.renderContext({ entries: result.entries ?? [], budget: budgetChars });
  } catch {
    rendered = '';
  }
  // 渲染器按预算装填；行数少于候选数就说明有内容被预算截断。
  const renderedLines = rendered ? rendered.split('\n').length - 1 : 0;
  const candidateCount = Array.isArray(result.entries) ? result.entries.length : 0;

  return kernel.ok({
    query: searchText,
    characters: rendered.length,
    budgetChars,
    truncated: renderedLines < candidateCount,
    entries,
    explain: result.explain ?? {},
    rendered,
  });
}

// ---------------------------------------------------------------------------
// 4.9 审核队列
// ---------------------------------------------------------------------------

export async function reviews(request, kernel) {
  const internal = await kernel.internal();
  const db = kernel.requireDb(internal);
  const viewer = kernel.viewer(internal);

  let pendingRows = [];
  try {
    const readPending = typeof db.listMemoriesByTime === 'function'
      ? filter => db.listMemoriesByTime(filter)
      : filter => db.listMemories(filter);
    // 审核队列同样最新在前：最近的候选才是要看的那批。
    pendingRows = readPending({
      userId: viewer.userId,
      personaId: viewer.personaId,
      worldId: viewer.worldId,
      status: 'pending',
      includeExpired: true,
      limit: 100,
    }).sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
  } catch { pendingRows = []; }

  let failedJobs = [];
  try {
    failedJobs = db.jobs({ state: 'failed', limit: 50 }).map(job => ({
      id: job.jobId,
      type: job.type,
      streamKey: job.streamKey,
      attempts: numberOr(job.attempts, 0),
      lastError: safePreview(job.lastError, 300),
      updatedAt: job.updatedAt,
    }))
      .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
  } catch { failedJobs = []; }

  return kernel.ok({
    pending: pendingRows.map(record => {
      return {
        id: record.id,
        kind: record.kind,
        scope: record.scope,
        policy: record.mentionPolicy,
        // 审核就是用来核对原话的：候选正文一律返回。
        value: record.value,
        confidence: numberOr(record.confidence, 0),
        updatedAt: record.updatedAt,
        reasons: (Array.isArray(record.tags) ? record.tags : [])
          .map(tag => String(tag))
          .filter(tag => tag.startsWith('reason:'))
          .map(tag => tag.slice(7)),
        hidden: false,
      };
    }),
    failedJobs,
  });
}

// ---------------------------------------------------------------------------
// 4.11 设置（只读）
// ---------------------------------------------------------------------------

export const EDITABLE_KEYS = Object.freeze([
  'backend', 'extractionEnabled', 'minMessages', 'semanticEnabled', 'budgetChars',
  'topK', 'rrfK', 'mmrLambda', 'coverageFloor',
  'embeddingProvider', 'embeddingBaseUrl', 'embeddingModel', 'embeddingDimensions',
  'rerankEnabled', 'rerankBaseUrl', 'rerankModel', 'rerankTimeoutMs', 'rerankTopN', 'rerankBlend',
  'wikiAutoCompile', 'wikiMaxEntriesPerTopic',
]);

/**
 * 设置页要显示「已保存、重启后生效」的值，而不是运行中的旧内存配置：
 * POST /settings 只写磁盘，读回内存的配置在重启前不会变，直接显示会让人以为没保存。
 * 磁盘不可读时退回内存配置，绝不抛错。
 */
function effectiveConfig(configPath, fallback) {
  if (configPath) {
    try {
      // configPath 固定是 `<root>/home/companion/memory.config.json`，所以 root 是上两级。
      const root = path.resolve(path.dirname(configPath), '../..');
      const loaded = loadConfig(root);
      if (loaded && loaded.config && typeof loaded.config === 'object') return loaded.config;
    } catch { /* 磁盘配置坏了：退回运行中的配置 */ }
  }
  return fallback && typeof fallback === 'object' ? fallback : {};
}

/** 把内存里的归一化配置投影成可编辑视图（与 POST 的白名单键一一对应）。 */
export function editableView(config = {}) {
  return {
    backend: stringOr(config.backend, 'legacy'),
    extractionEnabled: Boolean(config.extraction?.enabled),
    minMessages: numberOr(config.extraction?.minMessages, 6),
    semanticEnabled: Boolean(config.retrieval?.semanticEnabled),
    budgetChars: numberOr(config.injection?.budgetChars, 2400),
    topK: numberOr(config.retrieval?.topK, 8),
    rrfK: numberOr(config.retrieval?.rrfK, 60),
    mmrLambda: numberOr(config.retrieval?.mmrLambda, 0.72),
    coverageFloor: numberOr(config.retrieval?.coverageFloor, 0.15),
    embeddingProvider: stringOr(config.embedding?.provider, 'local'),
    embeddingBaseUrl: stringOr(config.embedding?.baseUrl, ''),
    embeddingModel: stringOr(config.embedding?.model, ''),
    embeddingDimensions: numberOr(config.embedding?.dimensions, 256),
    rerankEnabled: Boolean(config.rerank?.enabled),
    rerankBaseUrl: stringOr(config.rerank?.baseUrl, ''),
    rerankModel: stringOr(config.rerank?.model, ''),
    rerankTimeoutMs: numberOr(config.rerank?.timeoutMs, 4000),
    rerankTopN: numberOr(config.rerank?.topN, 0),
    rerankBlend: numberOr(config.rerank?.blend, 0.7),
    wikiAutoCompile: Boolean(config.wiki?.autoCompile),
    wikiMaxEntriesPerTopic: numberOr(config.wiki?.maxEntriesPerTopic, 40),
  };
}

/**
 * 密钥是否已配置（契约 §8.2）：只返回布尔，永不返回 key。
 * 同时看内存配置（启动时从密钥文件合并）与磁盘文件（保存后未重启也能显示正确）。
 */
function secretsFlag(configPath, config) {
  const fallback = { embedding: { apiKey: '' }, rerank: { apiKey: '' } };
  let secrets = fallback;
  if (configPath) {
    try {
      secrets = readRemoteModels(path.join(path.dirname(configPath), REMOTE_MODELS_FILE));
    } catch {
      secrets = fallback;
    }
  }
  return {
    embeddingKeySet: Boolean(String(config?.embedding?.apiKey ?? '').trim() || secrets.embedding.apiKey),
    rerankKeySet: Boolean(String(config?.rerank?.apiKey ?? '').trim() || secrets.rerank.apiKey),
  };
}

export async function settings(request, kernel) {
  const internal = await kernel.internal();
  kernel.requireDb(internal);
  const configPath = stringOr(internal.configPath, '');
  // editable 是磁盘上的「重启后生效」配置；backend 仍然报告正在运行的后端。
  const onDisk = effectiveConfig(configPath, internal.config);
  return kernel.ok({
    configPath,
    backend: stringOr(internal.config?.backend, 'legacy'),
    editable: editableView(onDisk),
    ...secretsFlag(configPath, onDisk),
    restartRequiredHint: true,
  });
}

// ---------------------------------------------------------------------------
// 4.13 时间线
// ---------------------------------------------------------------------------

export async function timeline(request, kernel) {
  const internal = await kernel.internal();
  const db = kernel.requireDb(internal);
  const viewer = kernel.viewer(internal);
  const query = kernel.query(request);

  const limit = clampInt(query.get('limit'), 1, 200, 50);
  const kind = textValue(query.get('kind'), 60);

  let rows = [];
  try {
    // 时间线一律最新在前。`eventsSince` 是正序游标（后台建批用），这里改走
    // `recentEvents` 的倒序查询；多取一些再按 kind 过滤，保证过滤后仍能凑够 limit。
    const size = Math.min(500, limit * 4);
    rows = typeof db.recentEvents === 'function'
      ? db.recentEvents({ userId: viewer.userId, personaId: viewer.personaId, limit: size })
      : db.eventsSince({ userId: viewer.userId, personaId: viewer.personaId, afterOccurredAt: '', limit: size }).reverse();
  } catch { rows = []; }

  const items = rows
    .filter(row => !kind || row.sourceKind === kind || row.role === kind)
    .slice(0, limit)
    .sort((left, right) => String(right.occurredAt ?? '').localeCompare(String(left.occurredAt ?? '')))
    .map(row => ({
      at: row.occurredAt,
      type: stringOr(row.sourceKind || row.role, ''),
      sessionId: row.sessionId,
      seq: numberOr(row.seq, 0),
      role: row.role,
      // 时间线只给短预览，正文永远不出接口。
      preview: safePreview(row.content, 160),
      hidden: false,
    }));

  return kernel.ok({ items });
}

// ---------------------------------------------------------------------------
// 待裁决的纠正（task-40）：只读列表。
//
// runtime 侧（`correctionReview()`）给的是 `{count, resolved, recent:[{recordId, candidates, at}]}`，
// 而 `candidates` 只是一串**记忆 id**（`mem_...`）——"旧记忆写了什么"必须由这边回读。
// 所以这个接口做两件事：向 runtime 要 id，向记忆库要正文（**只读**，`db.getMemory`）。
//
// 为什么正文要截断并标 `truncated`：裁决页只需要主人认出"是哪一条"，不需要把整段记忆铺在屏幕上；
// 但**必须**如实标出被截断，否则主人会以为那就是全文。
// ---------------------------------------------------------------------------

/** 候选正文的展示上限（字符）。超过就截断并把 `truncated` 置真。 */
const CORRECTION_TEXT_CHARS = 160;

export async function corrections(request, kernel, options = {}) {
  const internal = await kernel.internal();
  const viewer = kernel.viewer(internal);
  const operator = `u:${viewer.userId}`;
  const runtime = typeof options?.runtime === 'function' ? options.runtime() : null;
  if (!runtime || typeof runtime.correctionReview !== 'function') {
    // 运行库不在场：如实说"看不到"，而不是渲染一个空列表让人以为真的没有待办。
    return kernel.ok({
      available: false,
      reason: 'correction-review-unavailable',
      count: 0,
      resolved: 0,
      recent: [],
    });
  }
  const limit = clampInt(kernel.query(request).get('limit'), 1, 20, 5);
  let review;
  try {
    review = runtime.correctionReview({ limit });
  } catch {
    return kernel.ok({ available: false, reason: 'correction-review-failed', count: 0, resolved: 0, recent: [] });
  }
  if (!review || review.ok === false) {
    return kernel.ok({
      available: false,
      reason: String(review?.code ?? 'correction-review-failed'),
      count: 0, resolved: 0, recent: [],
    });
  }
  // 记忆库只用来回读正文；拿不到库时仍然把 id 与时间给出去（不能因为正文读不到就整块消失）。
  let db = null;
  try { db = kernel.requireDb(internal); } catch { db = null; }
  const recent = (Array.isArray(review.recent) ? review.recent : []).map(entry => {
    const ids = Array.isArray(entry?.candidates) ? entry.candidates : [];
    const candidates = ids.slice(0, 5).map(value => {
      // `candidates` 里可能是 id 字符串，也可能（将来）是对象；两种都吃。
      const id = typeof value === 'string' ? value : String(value?.recordId ?? value?.id ?? '');
      let record = null;
      if (db !== null && id !== '') {
        try { record = db.getMemory(id); } catch { record = null; }
      }
      const full = record === null ? '' : safePreview(record.value, 4000);
      return {
        recordId: id,
        text: full.slice(0, CORRECTION_TEXT_CHARS),
        truncated: full.length > CORRECTION_TEXT_CHARS,
        at: numberOr(record?.updatedAt === undefined ? record?.createdAt : record?.updatedAt, 0),
        kind: String(record?.kind ?? ''),
        // 记忆可能已经被别处删掉/换库：如实标出来，不假装有正文。
        missing: record === null,
      };
    });
    return { recordId: String(entry?.recordId ?? ''), at: numberOr(entry?.at, 0), candidates };
  });
  // 已裁决明细（runtime task-39 的 `listResolved({limit})`）：**只读**，只给审计字段，不回读正文。
  // 为什么不回读正文：已裁决说的是"当时作废了哪几条"，而那些记忆**本来就被作废了**——
  // 现在回读到的不是当时的字，容易让人以为"这条还在"。要正文请去记忆库看历史/事件书。
  const resolvedRecent = (() => {
    if (typeof runtime.listResolved !== 'function') return [];
    try {
      const listed = runtime.listResolved({ limit });
      if (!listed || listed.ok === false) return [];
      return (Array.isArray(listed.resolved) ? listed.resolved : []).slice(0, 20).map(item => ({
        recordId: String(item?.recordId ?? ''),
        supersededIds: (Array.isArray(item?.supersededIds) ? item.supersededIds : [])
          .map(value => String(value ?? '')).filter(Boolean).slice(0, 10),
        supersededCount: Array.isArray(item?.supersededIds) ? item.supersededIds.length : 0,
        operator: String(item?.operator ?? ''),
        at: numberOr(item?.at, 0),
        outcome: String(item?.outcome ?? ''),
      }));
    } catch { return []; }
  })();
  return kernel.ok({
    available: true,
    // 前端要把"将要记下的那句话"展示给主人确认；这里给出与提交时**同一套格式**的提示
    // （时间按读取时刻取；真正提交时服务端会按提交时刻重新生成并回传）。
    operator,
    evidenceHint: correctionEvidence(operator, Date.now()),
    // 运行库有没有 `listResolved`：没有时页面要说明"看不到明细"，而不是装作没有已裁决记录。
    resolvedListAvailable: typeof runtime.listResolved === 'function',
    count: numberOr(review.count, 0),
    resolved: numberOr(review.resolved, 0),
    pendingRetries: numberOr(review.pendingRetries, 0),
    recent,
    resolvedRecent,
  });
}
