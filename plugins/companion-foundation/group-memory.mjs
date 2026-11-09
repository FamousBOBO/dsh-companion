// 群记忆 / 成员记忆 / 话题状态（P1-A，实施计划 §5.1 §5.2）。
//
// 为什么**另开一个库**、而不是往 companion-memory 的 memories 表里加一维「群」，三条理由：
//
//   1. **memories 表里没有「群」这一维。** schema.sql 里 memories 的归属字段只有
//      user_id / persona_id / world_id，语义分别是「谁」「哪个人格」「哪个虚构世界」。
//      群不是这三者中的任何一个：同一个群里坐着很多人，同一个用户同时出现在多个群里，
//      群也不是「世界」。硬塞进去，等于把隔离寄望于调用方每次都记得传对参数。
//
//   2. **用 world_id 冒充群号会造成真实的跨场景泄露。** policy.mjs 的 scopeMatches 里有：
//
//          const rowWorld = row.worldId ?? '';
//          if (row.scope === 'roleplay_world' || rowWorld) {
//            return Boolean(viewerWorld) && rowWorld === viewerWorld;
//          }
//          return true;      // ← worldId 为空的行，对**任何** viewer 放行
//
//      私聊记忆的 worldId 是空串，于是它被判成「谁都能看」。把群记忆写进同一张表、再用
//      world_id 隔离，结果是**私聊记忆会出现在群召回里**——正好踩穿实施计划 §7.1 的硬门槛
//      （群聊不得看到私聊内容）。改这段语义要动 SCHEMA_VERSION 迁移，并波及 memories 的
//      validate / capture / wiki / exports（95KB 的 db.mjs 与若干 60KB 测试）。
//      所以：**新库，每张表都带 group_id 列，每个查询都强制带 group_id**——隔离由表结构
//      保证，而不是靠调用方自觉。
//
//   3. **两个库的生命周期本来就不同。** 私聊记忆要长期、要备份、要跨机迁移；群记忆只是
//      「这个群最近聊过什么」，丢了只影响接话的自然度，不该拖累记忆库的迁移与备份。
//      分库之后 forgetGroup(groupId)（退群/解散/用户要求清空）就是三条 DELETE，
//      不是一次跨表考古。
//
// 硬规则（写在这里就是评审判据，测试逐条钉住；改动前先读）：
//
//   1. **跨群不可见。** query 只返回 group_id **完全相等**的行；本文件里**不存在**「没带
//      groupId 就全查」的分支——缺 groupId 直接返回空结果 + reason 'no-group'。理由：一次
//      「忘记传参」的回归不该以「把 A 群的记忆喂给 B 群」的形式暴露，那是不可撤回的泄露。
//      同理 forgetGroup 缺 groupId 只回 { ok:false }，绝不删除任何行；写入口缺 groupId 直接拒。
//      成员维也只查**调用方点名的** memberIds；没给就退回空，绝不隐式扩大成全体成员。
//
//   2. **guess 不是事实。** kind='guess' 的条目带显式标记 speculative:true，并**排在结果最后**；
//      消费端（渲染层）据此拒绝用确定口吻表达。不丢弃——诊断时要看得见「她以为事情是这样的」，
//      但推测不许混进「事实」的顺序。排序键 = 确定性等级 → 话题相关 → 新近度 → 正文。
//      等级固定 explicit > observed > guess，写死在 GROUP_MEMORY_KINDS 的顺序里。
//
//   3. **写入必须留来源。** sourceMessageIds 为空/缺失 ⇒ 直接拒写（reason 'no-source'）。
//      没有来源的记忆不可追溯也不可撤销：用户问「你从哪知道的」答不出来时，只剩删库一条路。
//      正文 ≤200 字（GROUP_MEMORY_LIMITS.content），超了按**码点**截断并回 reason 'truncated'
//      ——不静默截断，否则写入方会以为库里存的是全文。
//
//   4. **同群去重、异群绝不合并。** 正文规范化（去空白/标点/符号、转小写）后相同即同一件事：
//      不新增行，改为合并 sourceMessageIds、confidence 取 max、kind 取更强的那个、刷新
//      updated_at。唯一约束是 **(group_id, dedupe_key)** 复合键（成员维再加 member_id），
//      不是 dedupe_key 单列：单列会让两个群里同一句「我周末去爬山」互相顶掉，A 群的事实被
//      写进 B 群那一行——正是规则 1 禁止的事，而且是**静默**的。
//
//   5. **话题有 TTL。** topic_state 过了 expires_at 就当没有（topicState 返回 null），但**不删行**
//      ——诊断时要能看见「最后一个话题是什么、什么时候过期的」。upsertTopic 的 ttlMs 默认
//      30 分钟、夹在 [60s, 6h]：太短等于没有话题，太长会让两天前的旧话题被当成「现在正在聊」，
//      模型接着两天前的梗说话是最明显的「不像人」。
//
//   6. **不做模型调用、不联网、不读别的插件、不写日志。** 本模块唯一的 IO 是那个 SQLite
//      文件（以及为它建目录）。它不认识 QQ、不认识 prompt、不认识 companion-memory：
//      往这里加任何一条依赖，都会让「群记忆坏了」和「聊天坏了」变成同一件事。
//
// 所有入口的共同约定：**绝不抛**。每个方法都包在 try/catch 里，失败返回 { ok:false, reason }
// 或空结果（空数组 / null）。群聊路径上一行 SQL 出错不能演变成「这个群不回话」。

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/**
 * 库文件相对**数据根**的位置。与 companion-memory 的 data/home/memory 并列而不共用目录：
 * 两套 schema 各自演化，放一起会让「备份哪一个」多出一次判断。
 */
export const GROUP_MEMORY_RELATIVE_FILE = path.join('home', 'group-memory', 'group-memory.db');

/** kind 三档。顺序即确定性等级（越靠前越硬），排序与合并都读这一份。 */
export const GROUP_MEMORY_KINDS = Object.freeze(['explicit', 'observed', 'guess']);

/** 各种上限。数字写在一处，实现与测试读同一份，改大改小不会两边打架。 */
export const GROUP_MEMORY_LIMITS = Object.freeze({
  /** 正文上限（码点）。超过 200 字就不是「一句话的事实」而是摘要，摘要是另一层的事。 */
  content: 200,
  /** 话题字符串上限（码点）。 */
  topic: 80,
  /** 一条事实最多挂多少个来源消息号：再长就不是证据，是聊天记录备份。 */
  sourceIds: 40,
  /** 一个话题最多记多少个参与者。 */
  participants: 32,
  /** query 一次最多问多少个成员（IN (...) 的规模也要有界）。 */
  memberIds: 20,
  /** query 的默认与最大返回条数（每个维度各自算）。 */
  limit: 12,
  maxLimit: 50,
  /** 单次候选行上限：先取这么多行再在内存里排序，避免「全表排序」随群历史增长而变慢。 */
  fetchCap: 500,
  /** 话题 TTL：默认值与夹取区间。 */
  topicTtlMs: 30 * 60 * 1000,
  topicTtlMinMs: 60 * 1000,
  topicTtlMaxMs: 6 * 60 * 60 * 1000,
  /** 忙等：与 companion-memory / companion-expression 同一个量级。 */
  busyTimeoutMs: 5000,
});

/**
 * DDL。每条都 IF NOT EXISTS、可安全重复执行：这个字符串在每次打开时跑一遍，
 * 就像 companion-memory 执行 schema.sql 那样——重开一个已有库绝不重塑、绝不丢行。
 *
 * 时间列一律 ISO 8601 字符串（与 memories 表同一种写法）：人直接读得懂，排查时不用换算。
 * 所有表都带 group_id 且 NOT NULL：隔离的最后一公里是列约束，不是调用方的自觉。
 * 用数组拼而不是模板字符串：本文件刻意不用模板字符串，读写 SQL 时不会被反引号干扰。
 */
export const GROUP_MEMORY_SCHEMA_SQL = [
  'CREATE TABLE IF NOT EXISTS group_facts (',
  '  id                 TEXT PRIMARY KEY,',
  '  group_id           TEXT NOT NULL,',
  '  content            TEXT NOT NULL,',
  '  kind               TEXT NOT NULL,',
  '  confidence         REAL NOT NULL DEFAULT 0.5,',
  "  topic              TEXT NOT NULL DEFAULT '',",
  "  source_message_ids TEXT NOT NULL DEFAULT '[]',",
  '  dedupe_key         TEXT NOT NULL,',
  '  created_at         TEXT NOT NULL,',
  '  updated_at         TEXT NOT NULL,',
  '  UNIQUE (group_id, dedupe_key)',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_group_facts_group ON group_facts(group_id, updated_at);',
  'CREATE INDEX IF NOT EXISTS idx_group_facts_topic ON group_facts(group_id, topic);',
  '',
  'CREATE TABLE IF NOT EXISTS member_facts (',
  '  id                 TEXT PRIMARY KEY,',
  '  group_id           TEXT NOT NULL,',
  '  member_id          TEXT NOT NULL,',
  '  content            TEXT NOT NULL,',
  '  kind               TEXT NOT NULL,',
  '  confidence         REAL NOT NULL DEFAULT 0.5,',
  "  source_message_ids TEXT NOT NULL DEFAULT '[]',",
  '  dedupe_key         TEXT NOT NULL,',
  '  created_at         TEXT NOT NULL,',
  '  updated_at         TEXT NOT NULL,',
  '  UNIQUE (group_id, member_id, dedupe_key)',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_member_facts_group ON member_facts(group_id, member_id, updated_at);',
  '',
  '-- 一个群一个话题：话题是**当下**的状态，不是历史。历史由 group_facts 按 created_at 自己长出来。',
  'CREATE TABLE IF NOT EXISTS topic_state (',
  // 裸 `TEXT PRIMARY KEY` 在 SQLite 里**允许 NULL**（rowid 表的怪癖），必须显式 NOT NULL，
  // 否则“没有群号的话题”也能落库，隔离的最后一公里就漏了。
  '  group_id        TEXT NOT NULL PRIMARY KEY,',
  '  topic           TEXT NOT NULL,',
  "  started_by      TEXT NOT NULL DEFAULT '',",
  "  participants    TEXT NOT NULL DEFAULT '[]',",
  '  last_advance_at TEXT NOT NULL,',
  '  expires_at      TEXT NOT NULL,',
  '  updated_at      TEXT NOT NULL',
  ');',
].join('\n');

/** kind → 确定性等级。写入口只接受 GROUP_MEMORY_KINDS，所以这里不需要兜底未知值。 */
const KIND_RANK = Object.freeze({ explicit: 0, observed: 1, guess: 2 });
const RANK_KIND = Object.freeze({ 0: 'explicit', 1: 'observed', 2: 'guess' });

/** 默认置信度：明确说过的话比「多次互动总结出来的」更硬，推测只配 0.3。 */
const DEFAULT_CONFIDENCE = Object.freeze({ explicit: 0.8, observed: 0.6, guess: 0.3 });

let sqliteModule = 'unset';

/**
 * 同步拿到 node:sqlite；拿不到返回 null（降级，而不是让插件行加载失败）。
 *
 * 为什么不用静态 import：静态 import 在缺少内置模块时会连整个插件行一起加载失败，而本模块的
 * 第一硬约定是「所有入口绝不抛」。为什么走 process.getBuiltinModule：它是同步的（写入口就在
 * 聊天回合里，等一个 await 边界什么也换不到），不产生 Promise，也不触发顶层 await。
 * companion-memory 的 db.mjs 用动态 import 解决同一个问题（它是 async 的），这里必须同步。
 */
function loadSqlite() {
  if (sqliteModule !== 'unset') return sqliteModule;
  try {
    const mod = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
    sqliteModule = mod && typeof mod.DatabaseSync === 'function' ? mod : null;
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

/**
 * 按数据根算库文件路径。数据根为空 ⇒ 空串（"没配置"），绝不退回当前目录：
 * 相对路径会随 cwd 漂移，而群记忆漂到哪都不该是隐式的。
 *
 * @param {string} [root] 陪伴数据根（dataRoot）
 * @returns {string} 绝对路径，或空串
 */
export function groupMemoryFile(root) {
  const base = String(root ?? '').trim();
  if (!base) return '';
  try {
    return path.join(path.resolve(base), GROUP_MEMORY_RELATIVE_FILE);
  } catch {
    return '';
  }
}

/**
 * 码点截断（不是 UTF-16 单元）。emoji 被劈成半个代理对会变成残字；上限本来就是为了
 * 「够用且不撑爆」，少一两个字符没有代价。与 group-persona.mjs 的 clampChars 同一实现。
 */
function clampChars(text, cap) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= cap) return chars.join('');
  return chars.slice(0, cap).join('');
}

/** 取字符串：非字符串（对象/数组/NaN）一律当空串，绝不让 [object Object] 进库。 */
function textOf(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * 去重键的规范化：去掉空白、标点、符号，统一小写。
 *
 * 为什么去标点：群里同一句话会被转述多次——「我周末去爬山」「我周末去爬山。」「我周末 去爬山」
 * 应当合并；只 trim 的话它们是三条几乎一样的记忆，反过来把真正的细节挤出 limit。
 * 中文没有大小写，toLowerCase 只为英文与昵称。
 * 极端情况：正文全是标点/emoji 时规范化结果是空串——那就退回「原文小写」当键，
 * 而不是让所有这类正文共用一个空键（那会把互不相干的两条合成一条）。
 */
function dedupeBase(text) {
  const raw = String(text ?? '').toLowerCase();
  const stripped = raw.replace(/[\s\p{P}\p{S}]+/gu, '');
  return stripped || raw.trim();
}

/** 话题比较用的规范化：只折叠空白与小写，**不**去标点——话题通常本身就是一个词。 */
function normalizeTopic(text) {
  return textOf(text).replace(/\s+/g, '').toLowerCase();
}

/** 时间：注入的时钟优先，坏值退回系统时钟。返回整数毫秒。 */
function clockOf(now) {
  return () => {
    try {
      const value = Number(typeof now === 'function' ? now() : Date.now());
      if (Number.isFinite(value) && value > 0) return Math.trunc(value);
    } catch { /* 注入的时钟自己坏了，用系统时钟 */ }
    return Date.now();
  };
}

const isoOf = ms => new Date(ms).toISOString();

const parseIso = text => {
  const value = Date.parse(String(text ?? ''));
  return Number.isFinite(value) ? value : NaN;
};

/** 置信度夹取；非数字用 kind 的默认值（推测天然比明确陈述低）。 */
function clampConfidence(value, kind) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_CONFIDENCE[kind] ?? 0.5;
  return Math.min(1, Math.max(0, number));
}

/** 来源消息号：只收非空字符串与有限数字；数字保持数字（QQ 消息号是数字，消费端要能直接比）。 */
function normalizeSourceIds(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    let id = null;
    if (typeof item === 'number' && Number.isFinite(item)) id = item;
    else if (typeof item === 'string' && item.trim()) id = item.trim();
    if (id == null) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
    if (out.length >= GROUP_MEMORY_LIMITS.sourceIds) break;
  }
  return out;
}

/** 参与者/成员号：去重、有界、保持给定顺序；空就是空——绝不隐式扩大成「全体」。 */
function normalizeIdList(value, cap) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const id = textOf(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= cap) break;
  }
  return out;
}

/** JSON 列解码：坏数据当空数组，绝不让一次手工改库把整个查询弄崩。 */
function decodeJsonArray(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** node:sqlite 拒绝 undefined，也不能直接绑 boolean：入口处统一转换（同 companion-expression 的写法）。 */
function bindParams(params) {
  const list = Array.isArray(params) ? params : params === undefined ? [] : [params];
  return list.map(value => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

/** 短哈希作 dedupe_key：规范化正文可能很长，哈希后定长、索引友好。 */
function sha256Hex(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex');
}

const clampLimit = value => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return GROUP_MEMORY_LIMITS.limit;
  return Math.min(GROUP_MEMORY_LIMITS.maxLimit, Math.max(1, Math.trunc(number)));
};

/**
 * TTL 夹取。未给/非法 ⇒ 默认 30 分钟；给了就夹进 [60s, 6h]。
 * 为什么夹：调用方传 0 会让「刚说的话题」立刻过期（等于没有话题），传一天会让两天前的
 * 话题被当成「现在正在聊」，模型接着旧梗说话——两种都是肉眼可见的不像人。
 */
const clampTtl = value => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return GROUP_MEMORY_LIMITS.topicTtlMs;
  return Math.min(GROUP_MEMORY_LIMITS.topicTtlMaxMs, Math.max(GROUP_MEMORY_LIMITS.topicTtlMinMs, Math.trunc(number)));
};

/** 来源消息号合并：保持顺序、去重、有界。新证据排在后面，最近一次「谁说过」在末尾便于对账。 */
function mergeSourceIds(existing, incoming) {
  const out = [];
  const seen = new Set();
  for (const item of [...existing, ...incoming]) {
    let id = null;
    if (typeof item === 'number' && Number.isFinite(item)) id = item;
    else if (typeof item === 'string' && item.trim()) id = item.trim();
    if (id == null) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
    if (out.length >= GROUP_MEMORY_LIMITS.sourceIds) break;
  }
  return out;
}

/**
 * 一行 → 内部证据条目。
 *
 * topicMatch 与 updatedAt 只在排序时用，不交给消费端：证据形状是跨插件契约，
 * 多一个字段就多一份要维护的兼容。speculative 反过来是**故意**交出去的（规则 2）：
 * 消费端不必各自再写一遍 kind === 'guess'，也就不存在「某个渲染器忘了判」的漏洞。
 */
function entryOf(row, scope, wantedTopic) {
  const kind = GROUP_MEMORY_KINDS.includes(String(row.kind)) ? String(row.kind) : 'observed';
  const evidence = {
    scope,
    groupId: String(row.group_id ?? ''),
    ...(scope === 'member' ? { memberId: String(row.member_id ?? '') } : {}),
    content: String(row.content ?? ''),
    kind,
    confidence: Number(row.confidence) || 0,
    sourceMessageIds: decodeJsonArray(row.source_message_ids),
    createdAt: String(row.created_at ?? ''),
    speculative: kind === 'guess',
  };
  const topicMatch = Boolean(wantedTopic) && normalizeTopic(row.topic) === wantedTopic;
  return { evidence, topicMatch, updatedAt: parseIso(row.updated_at) };
}

/**
 * 排序 + 裁剪。返回 { evidence, matched }，matched 是**过滤后、裁剪前**的条数（用于报 over-limit）。
 *
 * 排序键（规则 2）：确定性等级 → 话题相关 → 新近度 → 正文。
 * 为什么等级在最前：limit 是一把小剪刀，最先被剪掉的必须是**推测**；不能因为「推测写得更新」
 * 就把一条 explicit 事实挤出去。
 * 为什么话题相关排在时间之前：旧话题的事实对新话题没用，但**同话题**的旧事实正好是接着聊
 * 需要的那一条。
 */
function pickEvidence(entries, limit, needle) {
  const filtered = entries.filter(entry => {
    if (!needle) return true;
    // 用 includes 做本地大小写不敏感比较（中文没有大小写）；刻意不用 LIKE 通配，
    // 否则正文里的 % 与 _ 会变成通配符，召回结果取决于脏数据里恰好有什么字符。
    return entry.evidence.content.toLowerCase().includes(needle);
  });
  filtered.sort((a, b) => {
    const rankDiff = (KIND_RANK[a.evidence.kind] ?? 1) - (KIND_RANK[b.evidence.kind] ?? 1);
    if (rankDiff !== 0) return rankDiff;
    if (a.topicMatch !== b.topicMatch) return a.topicMatch ? -1 : 1;
    const timeA = Number.isFinite(a.updatedAt) ? a.updatedAt : 0;
    const timeB = Number.isFinite(b.updatedAt) ? b.updatedAt : 0;
    if (timeA !== timeB) return timeB - timeA;
    return String(a.evidence.content).localeCompare(String(b.evidence.content));
  });
  return { evidence: filtered.slice(0, limit).map(entry => entry.evidence), matched: filtered.length };
}

/** topic_state 行 → 对外状态。expires_at 解析不出来按「已过期」处理：少一句比说错一句好。 */
function stateOf(row, nowMs) {
  const expiresAt = parseIso(row.expires_at);
  const expired = !Number.isFinite(expiresAt) ? true : expiresAt <= nowMs;
  return {
    groupId: String(row.group_id ?? ''),
    topic: String(row.topic ?? ''),
    startedBy: String(row.started_by ?? ''),
    participants: decodeJsonArray(row.participants).map(item => String(item)),
    lastAdvanceAt: String(row.last_advance_at ?? ''),
    expiresAt: String(row.expires_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    expired,
  };
}

/**
 * 建 store。同步、绝不抛。
 *
 * @param {{file?: string, root?: string, now?: () => number, busyTimeoutMs?: number}} [options]
 *   file  显式库文件（测试与嵌入方用；':memory:' 也支持）
 *   root  数据根（没给 file 时按 GROUP_MEMORY_RELATIVE_FILE 拼路径）
 *   now   注入时钟（毫秒）。时间列与 TTL 都读它——测试要能把时间推过去。
 * @returns {{
 *   file: string,
 *   writeGroupFact: (input: object) => {ok: boolean, id?: string, reason?: string},
 *   writeMemberFact: (input: object) => {ok: boolean, id?: string, reason?: string},
 *   query: (input: object) => {group: object[], member: object[], topic: object|null, dropped: string[], reason: string},
 *   upsertTopic: (input: object) => {ok: boolean, topic?: object, reason?: string},
 *   topicState: (groupId: string, options?: {includeExpired?: boolean}) => object|null,
 *   clearTopic: (groupId: string) => {ok: boolean, removed?: number, reason?: string},
 *   forgetGroup: (groupId: string) => {ok: boolean, groupFacts?: number, memberFacts?: number, topics?: number, total?: number, reason?: string},
 *   status: () => {groups: number, facts: number, memberFacts: number, topics: number, file: string, degraded: boolean, reason: string},
 *   close: () => void,
 * }}
 */
export function createGroupMemoryStore({ file = '', root = '', now = undefined, busyTimeoutMs = GROUP_MEMORY_LIMITS.busyTimeoutMs } = {}) {
  const explicitFile = String(file ?? '').trim();
  /** 空串 = 没配路径 = 永久降级。绝不把「没配置」解释成「写到当前目录」。 */
  const dbFile = explicitFile || groupMemoryFile(root);
  const inMemory = dbFile === ':memory:';
  const resolvedFile = inMemory || !dbFile ? dbFile : path.resolve(dbFile);
  const clock = clockOf(now);
  const timeoutMs = Number.isFinite(Number(busyTimeoutMs))
    ? Math.min(60_000, Math.max(0, Math.trunc(Number(busyTimeoutMs))))
    : GROUP_MEMORY_LIMITS.busyTimeoutMs;

  /** @type {import('node:sqlite').DatabaseSync|null} */
  let handle = null;
  let closed = false;
  /** 最近一次失败的原因（机器可读，绝不含正文/绝对路径）；'' = 一直正常。 */
  let lastReason = '';
  /**
   * 永久降级标记：只有「这个库打不开」这类**不会自己好**的失败才置位。
   *
   * 为什么必须和 lastReason 分开：一次读/写异常（忙、罕见的 SQL 边界）只该影响那一次调用。
   * 如果它也置位，下一次 ensureDb 就直接放弃，于是「偶发一次失败」会被放大成
   * 「这个群的记忆永久失效」——而群聊里没人会去重启插件。
   */
  let blocked = false;
  const statements = new Map();

  const fail = (reason, { permanent = false } = {}) => {
    if (reason && !lastReason) lastReason = reason;
    if (permanent) blocked = true;
    return reason;
  };

  /**
   * 懒打开 + 幂等 DDL。
   *
   * 为什么懒：装了但没人用的群不该在磁盘上留下库文件与 -wal；「第一次用才建库」也让清理
   * 的语义变简单（删目录即可，没有必须存在的空库）。
   * 为什么失败后**记住**：群聊每轮都会调 query，反复重试一个坏路径只会把日志刷满。
   */
  const ensureDb = () => {
    if (handle) return handle;
    if (closed || blocked) return null;
    if (!resolvedFile) { fail('no-file', { permanent: true }); return null; }
    const sqlite = loadSqlite();
    if (!sqlite) { fail('no-sqlite', { permanent: true }); return null; }
    let opened = null;
    try {
      if (!inMemory) fs.mkdirSync(path.dirname(resolvedFile), { recursive: true });
      opened = new sqlite.DatabaseSync(resolvedFile);
      // WAL：群聊的写与 Studio 诊断的读同时进来时不互相阻塞。
      opened.exec('PRAGMA journal_mode = WAL');
      opened.exec('PRAGMA synchronous = NORMAL');
      opened.exec('PRAGMA busy_timeout = ' + timeoutMs);
      // 每条 DDL 都是 IF NOT EXISTS：重开已有库不改形状、不丢行。
      opened.exec(GROUP_MEMORY_SCHEMA_SQL);
      handle = opened;
      return handle;
    } catch {
      try { if (opened) opened.close(); } catch { /* 打开失败的那个句柄，关不掉也无所谓 */ }
      // 打不开是**永久**的：同一个路径下再试一次只会把日志刷满（每轮群聊都会调进来）。
      fail('open-failed', { permanent: true });
      return null;
    }
  };

  const prepared = (db, sql) => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };
  const all = (db, sql, params) => prepared(db, sql).all(...bindParams(params));
  const get = (db, sql, params) => {
    const row = prepared(db, sql).get(...bindParams(params));
    return row === undefined ? null : row;
  };
  const run = (db, sql, params) => prepared(db, sql).run(...bindParams(params));

  /**
   * 事务：BEGIN IMMEDIATE → fn → COMMIT，任一异常回滚。失败返回 null，由调用方翻成 { ok:false }。
   *
   * IMMEDIATE 而不是 DEFERRED：写入路径总是「先按 dedupe_key 查有没有同一件事、再写」，
   * DEFERRED 会在升级写锁时才失败，那时已经读完，等于白读一遍。
   */
  const tx = fn => {
    const db = ensureDb();
    if (!db) return null;
    let open = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      open = true;
      const value = fn(db);
      db.exec('COMMIT');
      open = false;
      return value;
    } catch {
      if (open) { try { db.exec('ROLLBACK'); } catch { /* 回滚失败也不能盖掉原因 */ } }
      fail('write-failed');
      return null;
    }
  };

  /** 读路径的统一兜底：一次 SQLite 异常只回空结果，绝不冒泡到聊天路径。 */
  const guarded = (fallback, fn) => {
    try {
      return fn();
    } catch {
      fail('read-failed');
      return typeof fallback === 'function' ? fallback() : fallback;
    }
  };

  /** 读话题行。过期判断在 JS 里做（在 SQL 里比字符串时间容易踩格式/时区坑）。 */
  const readTopic = (groupId, { includeExpired }) => {
    if (!groupId) return null;
    const db = ensureDb();
    if (!db) return null;
    const row = get(db, 'SELECT * FROM topic_state WHERE group_id = ?', [groupId]);
    if (!row) return null;
    const state = stateOf(row, clock());
    if (state.expired && !includeExpired) return null;
    return state;
  };

  /**
   * 写入口的公共校验 → 规范化结果，或 { ok:false, reason }。
   * kind 非法**拒绝**而不是猜一个：猜错会让一条推测被当成事实渲染出去。
   */
  const validateWrite = options => {
    const groupId = textOf(options.groupId);
    // 规则 1 的第一道闸：没有群号就没有任何一行可以被写进来（不存在「默认群」）。
    if (!groupId) return { ok: false, reason: 'no-group' };
    const rawContent = textOf(options.content);
    if (!rawContent) return { ok: false, reason: 'empty-content' };
    // 规则 3：来源是写入门槛，不是可选项。
    const sourceIds = normalizeSourceIds(options.sourceMessageIds);
    if (!sourceIds.length) return { ok: false, reason: 'no-source' };
    // kind 缺省（undefined / ''）按 observed —— 最保守的档位；但显式传了个**不是字符串**的值
    // （null、数字、对象）是调用方真的写错了，拒绝而不是猜：猜成 explicit 会让一条推测
    // 被当成事实说谎。
    const rawKind = options.kind;
    const kind = rawKind === undefined || rawKind === '' ? 'observed' : textOf(rawKind);
    if (!GROUP_MEMORY_KINDS.includes(kind)) return { ok: false, reason: 'invalid-kind' };
    const truncated = Array.from(rawContent).length > GROUP_MEMORY_LIMITS.content;
    return {
      ok: true,
      groupId,
      content: truncated ? clampChars(rawContent, GROUP_MEMORY_LIMITS.content) : rawContent,
      kind,
      confidence: clampConfidence(options.confidence, kind),
      sourceIds,
      truncated,
    };
  };

  /** 群维/成员维共用的一套「查同一条 → 合并或新增」。表名与多出来的 member_id 是唯一差别。 */
  const upsertFact = (table, scope) => input => {
    const options = input && typeof input === 'object' ? input : {};
    const checked = validateWrite(options);
    if (!checked.ok) return checked;
    const memberId = scope === 'member' ? textOf(options.memberId) : '';
    // 成员记忆没有成员号就是「不是谁的记忆」：拒绝，而不是静默退化成群事实。
    if (scope === 'member' && !memberId) return { ok: false, reason: 'no-member' };

    const nowMs = clock();
    const stamp = isoOf(nowMs);
    const topic = clampChars(textOf(options.topic), GROUP_MEMORY_LIMITS.topic);
    const dedupeKey = sha256Hex(dedupeBase(checked.content));

    const written = tx(db => {
      const keyWhere = scope === 'member'
        ? 'group_id = ? AND member_id = ? AND dedupe_key = ?'
        : 'group_id = ? AND dedupe_key = ?';
      const keyParams = scope === 'member'
        ? [checked.groupId, memberId, dedupeKey]
        : [checked.groupId, dedupeKey];
      const existing = get(db, 'SELECT * FROM ' + table + ' WHERE ' + keyWhere, keyParams);

      if (existing) {
        // 规则 4：同一件事再来一次 → 合并来源、取更强的 kind 与更高的置信度、刷新时间。
        // 不新增行，否则「她已经知道这件事」会随重复次数变成三条，把 limit 挤满。
        const mergedIds = mergeSourceIds(decodeJsonArray(existing.source_message_ids), checked.sourceIds);
        const strongerRank = Math.min(KIND_RANK[existing.kind] ?? 1, KIND_RANK[checked.kind]);
        const mergedKind = RANK_KIND[strongerRank] ?? checked.kind;
        const mergedConfidence = Math.max(Number(existing.confidence) || 0, checked.confidence);
        const mergedTopic = topic || textOf(existing.topic);
        run(db,
          'UPDATE ' + table + ' SET content = ?, kind = ?, confidence = ?, topic = ?, source_message_ids = ?, updated_at = ? WHERE id = ?',
          [checked.content, mergedKind, mergedConfidence, mergedTopic, JSON.stringify(mergedIds), stamp, String(existing.id)]);
        return { ok: true, id: String(existing.id), merged: true, truncated: checked.truncated };
      }

      const id = randomUUID();
      if (scope === 'member') {
        run(db,
          'INSERT INTO member_facts (id, group_id, member_id, content, kind, confidence, source_message_ids, dedupe_key, created_at, updated_at)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, checked.groupId, memberId, checked.content, checked.kind, checked.confidence,
            JSON.stringify(checked.sourceIds), dedupeKey, stamp, stamp]);
      } else {
        run(db,
          'INSERT INTO group_facts (id, group_id, content, kind, confidence, topic, source_message_ids, dedupe_key, created_at, updated_at)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, checked.groupId, checked.content, checked.kind, checked.confidence, topic,
            JSON.stringify(checked.sourceIds), dedupeKey, stamp, stamp]);
      }
      return { ok: true, id, merged: false, truncated: checked.truncated };
    });

    if (!written) return { ok: false, reason: lastReason || 'write-failed' };
    // reason 只在「这件事不寻常」时出现：截断让写入方知道库里不是全文，合并让它知道没新增行。
    if (written.truncated) return { ok: true, id: written.id, reason: 'truncated' };
    if (written.merged) return { ok: true, id: written.id, reason: 'merged' };
    return { ok: true, id: written.id };
  };

  const emptyQuery = (dropped, reason) => ({ group: [], member: [], topic: null, dropped, reason });

  /**
   * 查询失败时的空结果。dropped 里的原因要能让排查的人区分三种完全不同的情况：
   * 库根本不可用（degraded）、这一次读真的炸了（error）、还是调用方没给群号（no-group，由
   * query 自己先返回，不会走到这里）。
   */
  const failedQuery = () => emptyQuery(
    [['open-failed', 'no-file', 'no-sqlite'].includes(lastReason) ? 'degraded' : 'error'],
    lastReason || 'error',
  );

  const store = {
    /** 库文件（可能为空串 = 没配置；调用方据此如实说「群记忆没开」）。 */
    file: resolvedFile,

    /**
     * 写一条群维度的事实。
     * @param {{groupId: string, content: string, kind?: 'explicit'|'observed'|'guess',
     *          confidence?: number, topic?: string, sourceMessageIds?: (string|number)[]}} input
     * @returns {{ok: true, id: string, reason?: 'truncated'|'merged'} | {ok: false, reason: string}}
     */
    writeGroupFact: input => guarded({ ok: false, reason: 'error' }, () => upsertFact('group_facts', 'group')(input)),

    /**
     * 写一条成员维度的事实（「小王说过他周六搬家」）。必须带 memberId。
     * @param {{groupId: string, memberId: string, content: string, kind?: string,
     *          confidence?: number, sourceMessageIds?: (string|number)[]}} input
     * @returns {{ok: true, id: string, reason?: string} | {ok: false, reason: string}}
     */
    writeMemberFact: input => guarded({ ok: false, reason: 'error' }, () => upsertFact('member_facts', 'member')(input)),

    /**
     * 召回。**必须**带 groupId；只返回群号完全相等的行（规则 1）。
     *
     * @param {{groupId?: string, memberIds?: string[], topic?: string, query?: string, limit?: number}} [input]
     * @returns {{group: object[], member: object[], topic: object|null, dropped: string[], reason: string}}
     *   dropped 是机器可读的「为什么少了一些东西」，只放原因不放正文：
     *     'no-group'（没带群号，什么都查不到）、'degraded'（库不可用）、
     *     'no-members'（没点名成员，成员维一定是空）、'over-limit:N'（被 limit 裁掉 N 条）。
     *   reason 是同一件事的单个字符串版本（正常为 ''）。
     */
    query: input => guarded(failedQuery, () => {
      const options = input && typeof input === 'object' ? input : {};
      const groupId = textOf(options.groupId);
      // 规则 1 的读侧：缺群号 ⇒ 空结果。这里**没有**「查全部」的分支，永远不会有。
      if (!groupId) return emptyQuery(['no-group'], 'no-group');
      const db = ensureDb();
      if (!db) return emptyQuery(['degraded'], lastReason || 'degraded');

      const limit = clampLimit(options.limit);
      const needle = textOf(options.query).toLowerCase();
      const wantedTopic = normalizeTopic(clampChars(textOf(options.topic), GROUP_MEMORY_LIMITS.topic));
      const memberIds = normalizeIdList(options.memberIds, GROUP_MEMORY_LIMITS.memberIds);
      const dropped = [];
      if (!memberIds.length) dropped.push('no-members');

      const rows = all(db,
        'SELECT * FROM group_facts WHERE group_id = ? ORDER BY updated_at DESC, id ASC LIMIT ' + GROUP_MEMORY_LIMITS.fetchCap,
        [groupId]);
      const memberRows = memberIds.length
        ? all(db,
          'SELECT * FROM member_facts WHERE group_id = ? AND member_id IN ('
          + memberIds.map(() => '?').join(', ') + ') ORDER BY updated_at DESC, id ASC LIMIT ' + GROUP_MEMORY_LIMITS.fetchCap,
          [groupId, ...memberIds])
        : [];

      const picked = pickEvidence(rows.map(row => entryOf(row, 'group', wantedTopic)), limit, needle);
      const pickedMember = pickEvidence(memberRows.map(row => entryOf(row, 'member', wantedTopic)), limit, needle);
      const cut = Math.max(0, picked.matched - picked.evidence.length)
        + Math.max(0, pickedMember.matched - pickedMember.evidence.length);
      if (cut > 0) dropped.push('over-limit:' + cut);

      return {
        group: picked.evidence,
        member: pickedMember.evidence,
        topic: readTopic(groupId, { includeExpired: false }),
        dropped,
        reason: '',
      };
    }),

    /**
     * 覆盖式推进话题（一个群一个话题）。
     *
     * @param {{groupId: string, topic: string, startedBy?: string, participants?: string[], ttlMs?: number}} input
     * @returns {{ok: true, topic: object} | {ok: false, reason: string}}
     */
    upsertTopic: input => guarded({ ok: false, reason: 'error' }, () => {
      const options = input && typeof input === 'object' ? input : {};
      const groupId = textOf(options.groupId);
      if (!groupId) return { ok: false, reason: 'no-group' };
      const topic = clampChars(textOf(options.topic), GROUP_MEMORY_LIMITS.topic);
      if (!topic) return { ok: false, reason: 'empty-topic' };
      const startedBy = textOf(options.startedBy);
      const participants = normalizeIdList(options.participants, GROUP_MEMORY_LIMITS.participants);
      const ttl = clampTtl(options.ttlMs);
      const nowMs = clock();
      const stamp = isoOf(nowMs);

      const written = tx(db => {
        const existing = get(db, 'SELECT * FROM topic_state WHERE group_id = ?', [groupId]);
        const same = existing && normalizeTopic(existing.topic) === normalizeTopic(topic);
        if (same) {
          // 同一个话题继续往前推：参与者做并集、刷新时间与 TTL，**不换发起人**——否则
          // 「谁开的头」会随每一次有人接口而变成最后说话的那个人。
          const merged = normalizeIdList(
            [...decodeJsonArray(existing.participants), ...participants],
            GROUP_MEMORY_LIMITS.participants,
          );
          run(db,
            'UPDATE topic_state SET participants = ?, last_advance_at = ?, expires_at = ?, updated_at = ? WHERE group_id = ?',
            [JSON.stringify(merged), stamp, isoOf(nowMs + ttl), stamp, groupId]);
        } else {
          // 话题换了：参与者与发起人一起换。留着上一轮的人会把「现在是谁在聊」记错。
          run(db,
            'INSERT INTO topic_state (group_id, topic, started_by, participants, last_advance_at, expires_at, updated_at)'
            + ' VALUES (?, ?, ?, ?, ?, ?, ?)'
            + ' ON CONFLICT(group_id) DO UPDATE SET'
            + ' topic = excluded.topic, started_by = excluded.started_by, participants = excluded.participants,'
            + ' last_advance_at = excluded.last_advance_at, expires_at = excluded.expires_at, updated_at = excluded.updated_at',
            [groupId, topic, startedBy, JSON.stringify(participants), stamp, isoOf(nowMs + ttl), stamp]);
        }
        return true;
      });
      if (!written) return { ok: false, reason: lastReason || 'write-failed' };
      const state = readTopic(groupId, { includeExpired: true });
      return state ? { ok: true, topic: state } : { ok: false, reason: 'write-failed' };
    }),

    /**
     * 当前话题。过了 expires_at 一律返回 null（规则 5），但**不删行**。
     *
     * 唯一超出契约的扩展：{ includeExpired: true } 供诊断用（Studio 要能显示「最后一个话题
     * 是什么、什么时候过期的」）。默认行为就是契约里的 null。
     *
     * @param {string} groupId
     * @param {{includeExpired?: boolean}} [options]
     * @returns {object|null}
     */
    topicState: (groupId, options) => guarded(null, () => readTopic(
      textOf(groupId),
      { includeExpired: Boolean(options && options.includeExpired) },
    )),

    /** 清掉这个群的话题（话题结束/被打断）。只删这一行，不动任何事实。 */
    clearTopic: groupId => guarded({ ok: false, reason: 'error' }, () => {
      const group = textOf(groupId);
      if (!group) return { ok: false, reason: 'no-group' };
      const removed = tx(db => Number(run(db, 'DELETE FROM topic_state WHERE group_id = ?', [group]).changes) || 0);
      if (removed == null) return { ok: false, reason: lastReason || 'write-failed' };
      return { ok: true, removed };
    }),

    /**
     * 彻底遗忘一个群（退群、解散、用户要求清空）。
     *
     * 三张表一次事务删干净：留下哪一张都是「这个群还知道点什么」，而用户的要求是忘掉。
     * 缺 groupId 时**不删任何行**（规则 1）：把「忘记传参」解释成「清空所有群」是不可逆事故。
     *
     * @param {string} groupId
     * @returns {{ok: boolean, groupFacts: number, memberFacts: number, topics: number, total: number, reason?: string}}
     */
    forgetGroup: groupId => guarded(
      () => ({ ok: false, reason: 'error', groupFacts: 0, memberFacts: 0, topics: 0, total: 0 }),
      () => {
        const group = textOf(groupId);
        if (!group) return { ok: false, reason: 'no-group', groupFacts: 0, memberFacts: 0, topics: 0, total: 0 };
        const counts = tx(db => ({
          groupFacts: Number(run(db, 'DELETE FROM group_facts WHERE group_id = ?', [group]).changes) || 0,
          memberFacts: Number(run(db, 'DELETE FROM member_facts WHERE group_id = ?', [group]).changes) || 0,
          topics: Number(run(db, 'DELETE FROM topic_state WHERE group_id = ?', [group]).changes) || 0,
        }));
        if (!counts) {
          return { ok: false, reason: lastReason || 'write-failed', groupFacts: 0, memberFacts: 0, topics: 0, total: 0 };
        }
        return { ok: true, ...counts, total: counts.groupFacts + counts.memberFacts + counts.topics };
      },
    ),

    /**
     * 诊断快照（不含任何正文）。降级时也返回对象：degraded:true + reason 比 undefined 好查。
     *
     * @returns {{groups: number, facts: number, memberFacts: number, topics: number,
     *            file: string, degraded: boolean, reason: string}}
     */
    status: () => guarded(
      () => ({ groups: 0, facts: 0, memberFacts: 0, topics: 0, file: resolvedFile, degraded: true, reason: lastReason || 'error' }),
      () => {
        const db = ensureDb();
        if (!db) {
          return { groups: 0, facts: 0, memberFacts: 0, topics: 0, file: resolvedFile, degraded: true, reason: lastReason || 'degraded' };
        }
        const count = sql => Number(get(db, sql)?.total ?? 0) || 0;
        return {
          groups: count(
            'SELECT count(*) AS total FROM ('
            + 'SELECT group_id FROM group_facts UNION SELECT group_id FROM member_facts UNION SELECT group_id FROM topic_state)',
          ),
          facts: count('SELECT count(*) AS total FROM group_facts'),
          memberFacts: count('SELECT count(*) AS total FROM member_facts'),
          topics: count('SELECT count(*) AS total FROM topic_state'),
          file: resolvedFile,
          degraded: false,
          reason: '',
        };
      },
    ),

    /** 关库。幂等、不抛。关掉之后所有方法按降级处理，不会静默重新打开。 */
    close: () => {
      if (closed) return;
      closed = true;
      statements.clear();
      try { if (handle) handle.close(); } catch { /* 已经关了 */ }
      handle = null;
    },
  };

  return store;
}

export default {
  GROUP_MEMORY_RELATIVE_FILE,
  GROUP_MEMORY_KINDS,
  GROUP_MEMORY_LIMITS,
  GROUP_MEMORY_SCHEMA_SQL,
  createGroupMemoryStore,
  groupMemoryFile,
};
