// 记忆档案 Studio · 写入接口。
//
// 原则（任务要求）：
//   1. 写入一律复用 db.mjs 的既有方法（updateMemory / setStatus / requeueJob /
//      upsertWikiPage），不手写 SQL，也不改 lib/db.mjs。
//   2. reason 只写白名单 code，绝不把自由文本写进库或日志。
//   3. 设置只改 memory.config.json 的磁盘内容，不热改运行中的配置。

import fs from 'node:fs';
import path from 'node:path';

import {
  REMOTE_MODELS_FILE, loadConfig, readRemoteModels, writeRemoteModels,
} from '../../companion-memory/config.mjs';
import { resolveEmbeddingsUrl } from '../../companion-memory/lib/embed.mjs';
import { MENTION_POLICIES } from '../../companion-memory/lib/policy.mjs';
import { createReranker } from '../../companion-memory/lib/rerank.mjs';
import { redactSecrets } from '../../companion-memory/lib/text.mjs';
import {
  ApiError, clampInt, clampNumber, pickEnum, textValue, correctionEvidence,
} from './api-kernel.mjs';
import { parseWikiLayout } from './read.mjs';

const MEMORY_ACTIONS = Object.freeze(['revise', 'policy', 'archive', 'restore', 'delete']);
const STATUS_BY_ACTION = Object.freeze({
  archive: 'archived',
  restore: 'confirmed',
  delete: 'retracted',
});
// 契约 §4.4：reason 缺省固定为 'studio-ui'，另允许这些白名单动作码。
const REASON_CODES = new Set([
  'studio-ui', 'studio-revise', 'studio-policy', 'studio-archive', 'studio-restore',
  'studio-delete', 'user-request',
]);
const DEFAULT_REASON = 'studio-ui';

const MANUAL_BEGIN = '<!-- manual:begin -->';
const MANUAL_END = '<!-- manual:end -->';
const MAX_NOTES_CHARS = 4000;

/**
 * 设置白名单（契约 §4.12）。每项声明写入路径、类型与范围；
 * 未在此表里的键一律 bad-request，绝不落盘。
 */
const SETTINGS_SPEC = Object.freeze({
  backend: { section: null, key: 'backend', check: value => ['legacy', 'sqlite'].includes(value) },
  extractionEnabled: { section: 'extraction', key: 'enabled', check: value => typeof value === 'boolean' },
  minMessages: { section: 'extraction', key: 'minMessages', check: value => Number.isInteger(value) && value >= 2 && value <= 50 },
  semanticEnabled: { section: 'retrieval', key: 'semanticEnabled', check: value => typeof value === 'boolean' },
  budgetChars: { section: 'injection', key: 'budgetChars', check: value => Number.isInteger(value) && value >= 400 && value <= 8000 },
  topK: { section: 'retrieval', key: 'topK', check: value => Number.isInteger(value) && value >= 1 && value <= 20 },
  rrfK: { section: 'retrieval', key: 'rrfK', check: value => Number.isInteger(value) && value >= 1 && value <= 120 },
  mmrLambda: { section: 'retrieval', key: 'mmrLambda', check: value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 },
  coverageFloor: { section: 'retrieval', key: 'coverageFloor', check: value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 },
  embeddingProvider: { section: 'embedding', key: 'provider', check: value => ['local', 'remote', 'off'].includes(value) },
  // 契约 §8.3：远端向量 / 重排序的可编辑字段（全部写回嵌套路径）。
  embeddingBaseUrl: { section: 'embedding', key: 'baseUrl', check: httpUrlOrEmpty },
  embeddingModel: { section: 'embedding', key: 'model', check: value => typeof value === 'string' && value.length <= 200 },
  embeddingDimensions: { section: 'embedding', key: 'dimensions', check: value => Number.isInteger(value) && value >= 64 && value <= 4096 },
  rerankEnabled: { section: 'rerank', key: 'enabled', check: value => typeof value === 'boolean' },
  rerankBaseUrl: { section: 'rerank', key: 'baseUrl', check: httpUrlOrEmpty },
  rerankModel: { section: 'rerank', key: 'model', check: value => typeof value === 'string' && value.length <= 200 },
  rerankTimeoutMs: { section: 'rerank', key: 'timeoutMs', check: value => Number.isInteger(value) && value >= 500 && value <= 30000 },
  rerankTopN: { section: 'rerank', key: 'topN', check: value => Number.isInteger(value) && value >= 0 && value <= 50 },
  rerankBlend: { section: 'rerank', key: 'blend', check: value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 },
  wikiAutoCompile: { section: 'wiki', key: 'autoCompile', check: value => typeof value === 'boolean' },
  wikiMaxEntriesPerTopic: { section: 'wiki', key: 'maxEntriesPerTopic', check: value => Number.isInteger(value) && value >= 1 && value <= 2000 },
});

// 只写字段（契约 §8.3）：POST 接受、GET 永不返回；'' = 不改，null = 清除。
const SECRET_SPEC = Object.freeze({
  embeddingApiKey: 'embedding',
  rerankApiKey: 'rerank',
});
const API_KEY_MIN = 8;
const API_KEY_MAX = 512;

function httpUrlOrEmpty(value) {
  if (typeof value !== 'string' || value.length > 500) return false;
  if (value === '') return true;
  return /^https?:\/\/\S+$/i.test(value.trim());
}

/** 校验只写 key：null=清除，''=不改，其余必须是 8–512 且不含空白。 */
function normalizeApiKey(value, field) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new ApiError('bad-request', `${field} 必须是字符串或 null。`, 400);
  if (value === '') return '';
  if (/\s/.test(value)) throw new ApiError('bad-request', `${field} 不能包含空白字符。`, 400);
  if (value.length < API_KEY_MIN || value.length > API_KEY_MAX) {
    throw new ApiError('bad-request', `${field} 长度必须在 ${API_KEY_MIN}–${API_KEY_MAX} 之间。`, 400);
  }
  return value;
}

/** 跨字段校验：remote 向量 / 启用重排序时必须填齐地址与模型。 */
function assertGroupConsistency(raw, touchedSections) {
  if (touchedSections.has('embedding')) {
    const section = raw.embedding && typeof raw.embedding === 'object' ? raw.embedding : {};
    if (section.provider === 'remote') {
      const baseUrl = typeof section.baseUrl === 'string' ? section.baseUrl.trim() : '';
      if (!baseUrl) throw new ApiError('bad-request', '远端向量需要填写 API 地址。', 400);
      if (!/^https?:\/\//i.test(baseUrl)) throw new ApiError('bad-request', '向量 API 地址必须以 http(s):// 开头。', 400);
      if (!String(section.model ?? '').trim()) throw new ApiError('bad-request', '远端向量需要填写模型名。', 400);
    }
  }
  if (touchedSections.has('rerank')) {
    const section = raw.rerank && typeof raw.rerank === 'object' ? raw.rerank : {};
    if (section.enabled === true) {
      const baseUrl = typeof section.baseUrl === 'string' ? section.baseUrl.trim() : '';
      if (!baseUrl) throw new ApiError('bad-request', '启用重排序需要填写 API 地址。', 400);
      if (!/^https?:\/\//i.test(baseUrl)) throw new ApiError('bad-request', '重排序 API 地址必须以 http(s):// 开头。', 400);
      if (!String(section.model ?? '').trim()) throw new ApiError('bad-request', '启用重排序需要填写模型名。', 400);
    }
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** reason 只接受白名单 code；其余（含自由文本）回退到契约默认的 'studio-ui'。 */
function normalizeReason(value) {
  const code = String(value ?? '').trim();
  return REASON_CODES.has(code) ? code : DEFAULT_REASON;
}

/** 任何写库后的 wiki 重编译都是尽力而为；失败不影响写操作的结果。 */
async function compileWikiQuietly(internal, kernel) {
  try {
    if (typeof internal?.compileWiki === 'function') await internal.compileWiki({ force: true });
  } catch {
    kernel.log('wiki-compile-failed', { code: 'wiki-compile' });
  }
}

function readDbRecord(db, id, viewer) {
  let record = null;
  try { record = db.getMemory(id); } catch { record = null; }
  // 只允许操作 owner 自己的记录；别人的 id 一律当作不存在。
  if (!record || record.userId !== viewer.userId || record.personaId !== viewer.personaId) {
    throw new ApiError('not-found', '没有找到这条记忆。', 404);
  }
  return record;
}

// ---------------------------------------------------------------------------
// 4.4 单条记忆写入
// ---------------------------------------------------------------------------

export async function memoryWrite(request, kernel) {
  const internal = await kernel.internal();
  const db = kernel.requireDb(internal);
  const viewer = kernel.viewer(internal);
  const body = await kernel.body(request);

  const id = textValue(body.id, 80);
  if (!id) throw new ApiError('bad-request', '缺少记忆 id。', 400);
  const action = pickEnum(body.action, MEMORY_ACTIONS, '');
  if (!action) throw new ApiError('bad-request', '不支持的操作。', 400);

  readDbRecord(db, id, viewer);
  const reason = normalizeReason(body.reason);

  if (action === 'revise') {
    const value = String(body.value ?? '').trim();
    if (!value) throw new ApiError('bad-request', '修改后的内容不能为空。', 400);
    const maxChars = clampInt(internal.config?.limits?.factValueChars, 100, 4000, 2000);
    if (value.length > maxChars) throw new ApiError('bad-request', `修改后的内容不能超过 ${maxChars} 字。`, 400);
    // 与引擎的 remember() 一致：疑似密钥/密码的内容不落库。
    if (redactSecrets(value) !== value) {
      throw new ApiError('bad-request', '内容疑似包含密钥或密码，已拒绝保存。', 400);
    }
    const updated = db.updateMemory(id, { value }, { reason, actor: 'user' });
    await compileWikiQuietly(internal, kernel);
    return kernel.ok({ ok: true, id, status: updated.status, revision: updated.revision });
  }

  if (action === 'policy') {
    const policy = pickEnum(body.policy, MENTION_POLICIES, '');
    if (!policy) throw new ApiError('bad-request', '表达策略不合法。', 400);
    const updated = db.updateMemory(id, { mentionPolicy: policy }, { reason, actor: 'user' });
    return kernel.ok({ ok: true, id, status: updated.status, revision: updated.revision });
  }

  const updated = db.setStatus(id, STATUS_BY_ACTION[action], { reason, actor: 'user' });
  await compileWikiQuietly(internal, kernel);
  return kernel.ok({ ok: true, id, status: updated.status, revision: updated.revision });
}

// ---------------------------------------------------------------------------
// 4.7 Wiki 人工注释区
// ---------------------------------------------------------------------------

/** 去掉用户输入里的控制标记，避免伪造生成区/人工区结构。 */
function sanitizeManualNotes(notes) {
  return String(notes ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/<!--\s*(?:generated|manual|compiled):[\s\S]*?-->/g, '')
    .replace(/\u0000/g, '')
    .trim();
}

function writeFileAtomic(file, content) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, file);
  } catch {
    throw new ApiError('internal', 'Wiki 页面写入失败。', 500);
  }
}

export async function wikiPageWrite(request, kernel) {
  const internal = await kernel.internal();
  const db = kernel.requireDb(internal);
  kernel.viewer(internal);
  const wiki = await import('../../companion-memory/lib/wiki.mjs');
  const body = await kernel.body(request);

  const pageId = textValue(body.pageId, 120);
  if (!pageId) throw new ApiError('bad-request', '缺少页面标识。', 400);
  const topic = wiki.topicById(pageId);
  if (!topic) throw new ApiError('not-found', '没有这个 Wiki 主题。', 404);

  const rawNotes = String(body.notes ?? '');
  if (rawNotes.length > MAX_NOTES_CHARS) {
    throw new ApiError('bad-request', `注释不能超过 ${MAX_NOTES_CHARS} 字。`, 400);
  }
  const notes = sanitizeManualNotes(rawNotes);

  const dir = String(internal.wikiDir ?? '');
  let page;
  try {
    page = wiki.readPage({ dir, topicId: topic.id });
  } catch {
    throw new ApiError('bad-request', 'Wiki 页面标识不合法。', 400);
  }
  if (!page.exists) throw new ApiError('not-found', 'Wiki 页面尚未生成。', 404);

  const layout = parseWikiLayout(page.markdown);
  if (!layout.generated) {
    // 没有生成区说明这不是编译产物；保守拒绝，绝不整页覆盖。
    throw new ApiError('bad-request', '页面缺少自动生成区，已拒绝改写。', 400);
  }

  const block = notes ? `${MANUAL_BEGIN}\n${notes}\n${MANUAL_END}` : `${MANUAL_BEGIN}\n${MANUAL_END}`;
  const next = layout.manual
    ? page.markdown.slice(0, layout.manual.start) + block + page.markdown.slice(layout.manual.end)
    : `${page.markdown.trimEnd()}\n\n${block}\n`;

  const file = path.join(dir, ...page.path.split('/'));
  writeFileAtomic(file, next);

  // 登记表里的 notes 同步一份，供 Wiki 列表展示；compiledAt 由 upsert 刷新。
  let row = null;
  try { row = db.wikiPage(topic.id); } catch { row = null; }
  try {
    db.upsertWikiPage({
      pageId: topic.id,
      scope: row?.scope ?? topic.scope,
      topic: row?.topic ?? topic.topic,
      path: row?.path ?? topic.path,
      sourceRevision: row?.sourceRevision ?? 0,
      contentHash: row?.contentHash ?? '',
      status: row?.status ?? 'compiled',
      notes,
    });
  } catch {
    // 登记表写失败不影响页面文件本身；下次编译会重建。
    kernel.log('wiki-notes-registry-failed', { code: 'wiki-notes' });
  }

  return kernel.ok({ ok: true, pageId: topic.id, notes });
}

// ---------------------------------------------------------------------------
// 4.10 审核：失败作业重排
// ---------------------------------------------------------------------------

export async function reviewAction(request, kernel) {
  const internal = await kernel.internal();
  const db = kernel.requireDb(internal);
  kernel.viewer(internal);
  const body = await kernel.body(request);

  const action = pickEnum(body.action, ['requeue'], '');
  if (!action) throw new ApiError('bad-request', '不支持的审核操作。', 400);
  const jobId = textValue(body.jobId, 80);
  if (!jobId) throw new ApiError('bad-request', '缺少作业 id。', 400);

  const result = db.requeueJob(jobId, { resetAttempts: true });
  if (!result?.ok) {
    if (result?.reason === 'job-not-found') throw new ApiError('not-found', '没有找到这个作业。', 404);
    throw new ApiError('bad-request', '这个作业当前不能重排。', 400);
  }
  return kernel.ok({ ok: true, jobId, state: result.job?.state ?? 'pending' });
}

// ---------------------------------------------------------------------------
// H5 计划控制：锁定 / 跳过某个未来槽
//
// 写入必须走运行库的事件路径（`autonomy/plan-slot`），所以这里只做两件事：把请求
// 交给宿主注入的运行库，并把它的回答（含拒绝）原样翻译成 API 信封。运行库不在场时
// 明确回答 `plan-slot-unavailable`——不假装成功，也不自己改数据库。
// ---------------------------------------------------------------------------

const PLAN_SLOT_ACTIONS = Object.freeze(['lock', 'unlock', 'skip']);

export async function planSlotAction(request, kernel, options = {}) {
  const viewer = kernel.viewer(await kernel.internal());
  const body = await kernel.body(request);

  const action = pickEnum(body.action, PLAN_SLOT_ACTIONS, '');
  if (!action) throw new ApiError('bad-request', '只支持 lock / unlock / skip 三种操作。', 400);
  const slotId = textValue(body.slotId, 80);
  if (!slotId) throw new ApiError('bad-request', '缺少 slotId。', 400);
  const reason = textValue(body.reason, 200);

  // 这套 API 的错误词表是固定的（bad-request / not-found / db-unavailable / denied /
  // internal），所以运行库自己的 code 放进 meta 原样带回，页面照实显示，不另编理由。
  const runtime = typeof options.runtime === 'function' ? options.runtime() : null;
  if (!runtime || typeof runtime.lockPlanSlot !== 'function' || typeof runtime.skipPlanSlot !== 'function') {
    throw new ApiError('db-unavailable', '运行库没有提供计划控制接口，这一段暂时不能被锁定或跳过。', 500);
  }

  const bound = { userId: viewer.userId, personaId: viewer.personaId };
  let result;
  try {
    result = action === 'skip'
      ? await runtime.skipPlanSlot({ bound, slotId, reason })
      : await runtime.lockPlanSlot({ bound, slotId, locked: action === 'lock' });
  } catch (error) {
    const runtimeCode = textValue(error?.code, 60) || 'plan-slot-failed';
    const message = textValue(error?.message, 200) || '运行库拒绝了这个计划操作。';
    if (runtimeCode === 'unknown-slot' || runtimeCode === 'slot-not-found') {
      throw new ApiError('not-found', `没有找到这个计划槽（${runtimeCode}）。`, 404);
    }
    if (runtimeCode === 'scope-mismatch' || runtimeCode === 'denied') {
      // 别人的槽：这是权限问题，不是路由错误。
      throw new ApiError('denied', `这个计划槽不属于当前用户（${runtimeCode}）。`, 200);
    }
    throw new ApiError('bad-request', `${message}（${runtimeCode}）`, 400);
  }
  return kernel.ok({ ok: true, slotId, action, slot: result?.slot ?? null, status: result?.status ?? null });
}
// ---------------------------------------------------------------------------
// 4.12 设置写回（只改磁盘，不热更新）
// ---------------------------------------------------------------------------

function readRawConfig(configPath) {
  let text = '';
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new ApiError('internal', '配置文件无法读取。', 500);
  }
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    throw new ApiError('internal', '配置文件不是合法 JSON，已拒绝覆盖。', 500);
  }
}

function writeJsonAtomic(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  } catch {
    throw new ApiError('internal', '配置写入失败。', 500);
  }
}

function sectionOf(raw, section) {
  if (!section) return raw;
  if (!isPlainObject(raw[section])) raw[section] = {};
  return raw[section];
}

export async function settingsWrite(request, kernel) {
  const internal = await kernel.internal();
  kernel.requireDb(internal);
  const body = await kernel.body(request);

  const patch = body.patch;
  if (!isPlainObject(patch) || Object.keys(patch).length === 0) {
    throw new ApiError('bad-request', '缺少要修改的设置项。', 400);
  }

  const configPath = String(internal.configPath ?? '');
  if (!configPath) throw new ApiError('internal', '配置路径不可用。', 500);
  const secretsPath = path.join(path.dirname(configPath), REMOTE_MODELS_FILE);
  const raw = readRawConfig(configPath);
  const secrets = readRemoteModels(secretsPath);

  // 先在一份副本上完成全部校验与变更：任何一步失败都不落盘（契约要求）。
  const next = structuredClone(raw);
  const nextSecrets = {
    schemaVersion: 1,
    embedding: { apiKey: secrets.embedding.apiKey },
    rerank: { apiKey: secrets.rerank.apiKey },
  };
  const changed = [];
  const touchedSections = new Set();
  const keyOps = [];

  for (const [key, value] of Object.entries(patch)) {
    if (Object.hasOwn(SECRET_SPEC, key)) {
      keyOps.push({ key, target: SECRET_SPEC[key], value: normalizeApiKey(value, key) });
      continue;
    }
    const spec = SETTINGS_SPEC[key];
    if (!spec) throw new ApiError('bad-request', `不支持的设置项：${key}`, 400);
    if (!spec.check(value)) throw new ApiError('bad-request', `设置值不合法：${key}`, 400);
    const section = sectionOf(next, spec.section);
    const before = JSON.stringify(section[spec.key]);
    section[spec.key] = value;
    if (spec.section) touchedSections.add(spec.section);
    if (JSON.stringify(section[spec.key]) !== before) changed.push(key);
  }
  assertGroupConsistency(next, touchedSections);

  // memory.config.json 里永远不出现密钥字段（§8.2）：顺手清掉历史遗留的 apiKey。
  delete next.embeddingApiKey;
  delete next.rerankApiKey;
  if (isPlainObject(next.embedding)) delete next.embedding.apiKey;
  if (isPlainObject(next.rerank)) delete next.rerank.apiKey;

  let secretsChanged = false;
  for (const op of keyOps) {
    if (op.value === '') continue; // 空字符串 = 不改动
    const targetValue = op.value === null ? '' : op.value;
    if (nextSecrets[op.target].apiKey !== targetValue) {
      nextSecrets[op.target].apiKey = targetValue;
      secretsChanged = true;
      changed.push(op.key);
    }
  }

  const configTouched = changed.some(key => Object.hasOwn(SETTINGS_SPEC, key));
  // 两个文件各自原子写；校验已全部通过，密钥先落盘、配置后落盘。
  if (secretsChanged) {
    try {
      writeRemoteModels(secretsPath, nextSecrets);
    } catch {
      throw new ApiError('internal', '密钥文件写入失败。', 500);
    }
  }
  if (configTouched) writeJsonAtomic(configPath, next);
  return kernel.ok({ ok: true, changed, restartRequired: true });
}

// ---------------------------------------------------------------------------
// 4.15 设置探测（POST /settings/test）
// ---------------------------------------------------------------------------

/** key 直填优先，其次 apiKeyEnv；任何 API 都不返回 key 本身。 */
function apiKeyFor(settings) {
  const direct = typeof settings?.apiKey === 'string' ? settings.apiKey.trim() : '';
  if (direct) return direct;
  const envName = typeof settings?.apiKeyEnv === 'string' ? settings.apiKeyEnv.trim() : '';
  if (!envName) return '';
  const fromEnv = process.env?.[envName];
  return typeof fromEnv === 'string' ? fromEnv.trim() : '';
}

/**
 * 探测用的有效配置：优先读磁盘。POST /settings 只写文件、不热改内存配置，
 * 所以「刚填好地址/模型/密钥就点测试」必须能立刻探测到，而不是等重启。
 */
function probeConfig(internal) {
  const configPath = String(internal?.configPath ?? '');
  if (configPath) {
    try {
      // configPath 固定是 `<root>/home/companion/memory.config.json`，所以 root 是上两级。
      const root = path.resolve(path.dirname(configPath), '../..');
      const loaded = loadConfig(root);
      if (loaded && loaded.config && typeof loaded.config === 'object') return loaded.config;
    } catch { /* 磁盘配置坏了：退回运行中的内存配置 */ }
  }
  const config = internal?.config;
  return config && typeof config === 'object' ? config : {};
}

/**
 * 允许拿「还没保存的草稿」探测：用户可以先测通再保存。
 * 草稿只覆盖白名单字段；apiKey 同样只进内存，不落盘、不回显、不进日志。
 */
function applyProbeDraft(config, target, draft) {
  const base = config && typeof config === 'object' ? config : {};
  if (!isPlainObject(draft)) return base;
  const next = structuredClone(base);
  const sectionName = target === 'embedding' ? 'embedding' : 'rerank';
  if (!isPlainObject(next[sectionName])) next[sectionName] = {};
  const section = next[sectionName];
  const trimmed = (value, max = 500) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

  if (target === 'embedding') {
    if (['local', 'remote', 'off'].includes(draft.provider)) section.provider = draft.provider;
    if (typeof draft.baseUrl === 'string') section.baseUrl = trimmed(draft.baseUrl);
    if (typeof draft.model === 'string') section.model = trimmed(draft.model, 200);
    if (draft.dimensions != null) {
      section.dimensions = clampInt(draft.dimensions, 64, 4096, clampInt(section.dimensions, 64, 4096, 256));
    }
  } else {
    if (['remote', 'off'].includes(draft.provider)) section.provider = draft.provider;
    if (typeof draft.baseUrl === 'string') section.baseUrl = trimmed(draft.baseUrl);
    if (typeof draft.model === 'string') section.model = trimmed(draft.model, 200);
    if (draft.timeoutMs != null) {
      section.timeoutMs = clampInt(draft.timeoutMs, 500, 30000, clampInt(section.timeoutMs, 500, 30000, 4000));
    }
    if (draft.topN != null) section.topN = clampInt(draft.topN, 0, 50, clampInt(section.topN, 0, 50, 0));
    if (draft.blend != null) section.blend = clampNumber(draft.blend, 0, 1, clampNumber(section.blend, 0, 1, 0.7));
  }
  const key = typeof draft.apiKey === 'string' ? draft.apiKey.trim() : '';
  if (key) section.apiKey = key.slice(0, API_KEY_MAX);
  return next;
}

function probeError(target, error, extra = null) {
  return { target, ok: false, error, ...(extra ?? {}) };
}

/** HTTP 状态码 → 固定 code；不带状态码文本，避免把服务端回显带出去。 */
function httpErrorCode(status) {
  const code = Number(status) || 0;
  if (code === 401) return 'http-401';
  if (code === 403) return 'http-403';
  if (code === 404) return 'http-404';
  if (code >= 400 && code < 500) return 'http-4xx';
  if (code >= 500) return 'http-5xx';
  return 'network';
}

/** 探测向量端点：1 条 'ping'，校验返回维度与配置一致；不写库、不写向量。 */
async function probeEmbedding({ config, fetchImpl, now }) {
  const settings = config?.embedding ?? {};
  const provider = String(settings.provider ?? 'local');
  const baseUrl = String(settings.baseUrl ?? '').trim();
  const model = String(settings.model ?? '').trim();
  // 本地哈希向量不产生网络请求，没有可探测的端点。
  if (provider !== 'remote') return probeError('embedding', 'not-configured');
  if (!baseUrl || !model) return probeError('embedding', 'not-configured');
  const key = apiKeyFor(settings);
  if (!key) return probeError('embedding', 'no-key');
  const url = resolveEmbeddingsUrl(baseUrl);
  if (!url) return probeError('embedding', 'not-configured');

  const timeoutMs = clampInt(settings.timeoutMs, 500, 30000, 4000);
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer?.unref === 'function') timer.unref();

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: ['ping'] }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    return probeError('embedding', error?.name === 'AbortError' ? 'timeout' : 'network');
  }
  clearTimeout(timer);
  if (!response || typeof response !== 'object') return probeError('embedding', 'network');
  if (!response.ok) return probeError('embedding', httpErrorCode(response.status));

  let payload;
  try {
    payload = typeof response.json === 'function' ? await response.json() : JSON.parse(await response.text());
  } catch {
    return probeError('embedding', 'bad-shape');
  }
  const vector = Array.isArray(payload?.data?.[0]?.embedding)
    ? payload.data[0].embedding
    : (Array.isArray(payload?.embeddings?.[0]) ? payload.embeddings[0] : null);
  if (!Array.isArray(vector)) return probeError('embedding', 'bad-shape');
  if (vector.length === 0) return probeError('embedding', 'empty-vectors');
  const expected = clampInt(settings.dimensions, 64, 4096, 256);
  if (vector.length !== expected) {
    // 带上实际维度：UI 据此提示「把维度改成 1024」。
    return probeError('embedding', 'dimension-mismatch', { dimensions: vector.length, expected });
  }
  return {
    target: 'embedding',
    ok: true,
    latencyMs: Math.max(0, now() - started),
    model: String(payload?.model || model),
    dimensions: vector.length,
  };
}

/** rerank 错误码 -> 契约固定 code。 */
function probeRerankError(code) {
  switch (code) {
    case 'rerank-timeout': return 'timeout';
    case 'rerank-no-key': return 'no-key';
    case 'rerank-empty': return 'empty-vectors';
    case 'rerank-http-401': return 'http-401';
    case 'rerank-http-403': return 'http-403';
    case 'rerank-http-404':
    case 'rerank-http-405':
    case 'rerank-http-4xx': return 'http-4xx';
    case 'rerank-http-5xx': return 'http-5xx';
    case 'rerank-bad-shape': return 'bad-shape';
    default: return 'network';
  }
}

/** 探测重排序端点：query 'ping' + 2 条短文档；绝不写库、不写向量。 */
async function probeRerank({ config, fetchImpl, now }) {
  const settings = config?.rerank ?? {};
  const provider = String(settings.provider ?? 'remote');
  if (provider === 'off') return probeError('rerank', 'not-configured');
  const key = apiKeyFor(settings);
  if (!key) return probeError('rerank', 'no-key');
  if (!String(settings.baseUrl ?? '').trim() || !String(settings.model ?? '').trim()) {
    return probeError('rerank', 'not-configured');
  }

  // 探测时不看 enabled：用户通常先填地址再打开开关。
  const reranker = createReranker({
    settings: { ...settings, enabled: true, apiKey: key },
    fetchImpl,
    now,
  });
  try {
    const outcome = await reranker.rerank({
      query: 'ping',
      candidates: ['ping 记忆连通性测试一', 'ping 记忆连通性测试二'],
    });
    return {
      target: 'rerank',
      ok: true,
      latencyMs: clampInt(outcome?.latencyMs, 0, 60000, 0),
      model: String(outcome?.model ?? ''),
    };
  } catch (error) {
    return probeError('rerank', probeRerankError(error?.code));
  }
}

export async function settingsProbe(request, kernel, deps = {}) {
  const internal = await kernel.internal();
  const body = await kernel.body(request);
  const target = pickEnum(body.target, ['embedding', 'rerank'], '');
  if (!target) throw new ApiError('bad-request', '探测目标不合法。', 400);

  // 磁盘配置（含密钥文件）+ 未保存草稿 → 一次真实的最小请求。
  const config = applyProbeDraft(probeConfig(internal), target, body.draft);
  const fetchImpl = typeof deps?.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch;
  const now = typeof deps?.now === 'function' ? deps.now : Date.now;
  const data = target === 'embedding'
    ? await probeEmbedding({ config, fetchImpl, now })
    : await probeRerank({ config, fetchImpl, now });
  return kernel.ok(data);
}

// ---------------------------------------------------------------------------
// 4.14 维护
// ---------------------------------------------------------------------------

const MAINTENANCE_ACTIONS = Object.freeze(['rebuild', 'compile-wiki', 'extract', 'integrity']);

export async function maintenance(request, kernel) {
  const internal = await kernel.internal();
  const db = kernel.requireDb(internal);
  kernel.viewer(internal);
  const body = await kernel.body(request);

  const action = pickEnum(body.action, MAINTENANCE_ACTIONS, '');
  if (!action) throw new ApiError('bad-request', '不支持的维护动作。', 400);

  if (action === 'extract') {
    // Studio 没有会话上下文，提炼只能从对话入口触发。
    throw new ApiError('bad-request', '提炼需要从对话里触发。', 400);
  }

  if (action === 'integrity') {
    let result;
    try {
      result = db.integrityCheck({ quick: true });
    } catch {
      throw new ApiError('internal', '完整性检查失败。', 500);
    }
    return kernel.ok({ ok: true, action, result });
  }

  if (action === 'compile-wiki') {
    let result = { compiled: false };
    try { result = await internal.compileWiki({ force: true }); } catch { result = { compiled: false }; }
    return kernel.ok({ ok: true, action, result });
  }

  let search = { memories: 0 };
  try { search = db.rebuildSearchIndex(); } catch { search = { memories: 0 }; }
  let embeddings = { embedded: 0 };
  try {
    if (typeof internal.ensureEmbeddings === 'function') embeddings = await internal.ensureEmbeddings();
  } catch { embeddings = { embedded: 0 }; }
  let wiki = { compiled: false };
  try {
    if (typeof internal.compileWiki === 'function') wiki = await internal.compileWiki({ force: true });
  } catch { wiki = { compiled: false }; }
  return kernel.ok({ ok: true, action, result: { search, embeddings, wiki } });
}

// ---------------------------------------------------------------------------
// 纠正裁决（task-40）：唯一一个"主人手动决定旧记忆要不要被替换"的写入口。
//
// 三条铁律：
//   1. **operator 只能来自宿主身份**（`kernel.viewer()`），绝不读请求体里的名字——
//      让前端自报"我是谁"等于没有审计；
//   2. **evidence 由服务端生成**并原样回传（前端只能展示，不能改写）；
//      前端展示的那句话由 `GET /corrections` 的 `evidenceHint` 给出，两边同一套格式；
//   3. **不直写任何表**：只调 runtime 的 `resolveAmbiguousCorrection()`，它自己带租约与审计；
//      失败理由（`not-a-candidate` / `operator-required` / `not-queued` / `already-resolved`）
//      原样回给前端，不翻译、不吞掉。
// ---------------------------------------------------------------------------

/** 裁决证据的固定格式由 `api-kernel.mjs` 统一提供（读/写两侧必须是同一句话）。 */
export { correctionEvidence }

export async function correctionResolve(request, kernel, options = {}) {
  const internal = await kernel.internal();
  // 身份先取：没有绑定就是 denied，连参数都不用看。
  const viewer = kernel.viewer(internal);
  const operator = `u:${viewer.userId}`;
  const body = await kernel.body(request);
  const recordId = textValue(body.recordId, 120);
  if (!recordId) throw new ApiError('bad-request', '缺少 recordId。', 400);
  if (!Array.isArray(body.supersedeIds)) {
    throw new ApiError('bad-request', 'supersedeIds 必须是数组（允许空数组 = 新说法是补充不是替换）。', 400);
  }
  // 只收当前这条记录候选里的 id；其余由 runtime 判 `not-a-candidate`，这里不做二次裁剪（保留它的原话）。
  const supersedeIds = [...new Set(body.supersedeIds.map(value => textValue(value, 120)).filter(Boolean))];
  const runtime = typeof options?.runtime === 'function' ? options.runtime() : null;
  if (!runtime || typeof runtime.resolveAmbiguousCorrection !== 'function') {
    return kernel.ok({ ok: false, code: 'correction-unavailable', recordId });
  }
  const evidence = correctionEvidence(operator, Date.now());
  let result;
  try {
    result = await runtime.resolveAmbiguousCorrection({
      recordId,
      supersedeIds,
      operator,
      evidence,
      sessionId: textValue(body.sessionId, 120),
    });
  } catch (error) {
    // runtime 抛错不冒充业务码：内部错误就是内部错误。
    return kernel.ok({ ok: false, code: 'internal', recordId, error: String(error?.message ?? error).slice(0, 200) });
  }
  if (!result || result.ok !== true) {
    // **原样**把 runtime 的 code 交给前端（`not-a-candidate` / `already-resolved` / …）。
    return kernel.ok({
      ok: false,
      code: String(result?.code ?? 'correction-failed'),
      recordId,
      error: String(result?.error ?? '').slice(0, 200),
      resolution: result?.resolution ?? null,
      supersedeIds,
      evidence,
      operator,
    });
  }
  return kernel.ok({
    ok: true,
    recordId,
    supersedeIds,
    operator,
    evidence,
    resolution: result.resolution ?? null,
    code: String(result.code ?? ''),
  });
}
