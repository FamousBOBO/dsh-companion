// 短句查询构造（计划 §5 A.2/A.3）：把「用户这一句」变成「值得去检索的主题」，
// 并把来源写在返回结构里，方便日志、测试与接线各自核对，而不是靠调用方猜。
//
// 设计约束（与 lib/retrieve.mjs 的注释同效力）：
//
//   * 纯函数。没有 I/O、没有时钟副作用、没有模块级可变状态；同样的输入给同样的输出。
//   * 绝不推断未确认事实。问候语只允许「空主题」：它不能变成「刚睡醒」「刚起床」
//     之类的猜测，也不能替用户编一个事件。没有确认的锚点就不做承接。
//   * 承接来源只认**用户自己说过的**内容。助手自己的话、抽取出的推断、
//     旧库摘要、机器人行为、剧情设定都不是用户确认的事实，只能被丢弃并计数
//     （`dropped` 里的固定 code）。
//   * 输出只含计数、固定 code 与短词元，不含正文句子。实体词元取自用户原话里
//     真实出现的二元组，因此日志里复制这些词元不会变成一份聊天记录副本。
//   * 关闭开关（`enabled: false`）时返回 `source: 'raw'`，`topicText` 就是原句，
//     行为与旧版逐字一致。

import { hanRuns, normalizeText, terms } from './text.mjs';

export const QUERY_PLAN_VERSION = 1;

/**
 * 弱意图闭类词：问候、附和、应答、感谢、告别。
 * 只有在「整句去掉这些词之后什么都不剩」时才算弱意图，所以「咖啡」「北京烤鸭」
 * 这类真实主题永远不会被当成问候，召回资格不受影响。
 */
const WEAK_INTENT_TOKENS = Object.freeze([
  '早安', '早上好', '早啊', '早', '上午好', '午安', '中午好', '下午好', '晚上好',
  '晚安', '在吗', '在么', '在不在', '你好', '您好', '哈喽', '嗨',
  '嗯', '嗯嗯', '哦', '哦哦', '噢', '好', '好的', '好啊', '好呀', '行', '行的',
  '收到', '明白', '知道了', '懂了', '谢谢', '谢啦', '多谢', '感谢',
  '哈哈', '哈哈哈', '嘿嘿', '呵', '笑死', '确实', '是呀', '是啊', '对', '对的',
  '拜拜', '再见', '我去睡了', '睡啦', '睡了',
]);

/** 元记忆标记：用户不是在给主题，而是在问「你还记得吗 / 上次说过什么」。 */
const HISTORY_MARKERS = Object.freeze([
  '上次', '上回', '上一次', '前几天', '之前', '以前', '刚才', '刚刚',
  '我说过', '我说过什么', '说过什么', '聊过什么', '提过什么', '讲过什么',
  '你还记得', '还记得', '记得吗', '想起', '回忆一下', '回忆',
]);

/**
 * 元记忆问句里的填充语：判定「主题是否为空」时一并剥掉。
 *
 * 这些词只在**已经命中元记忆标记之后**才用于计算残留，所以「你还记得我平时喜欢
 * 喝什么吗」这类带真实主题的问句不会被吞掉（剥完仍剩「平时喜欢喝」）。
 */
const HISTORY_FILLERS = Object.freeze([
  '提过什么', '说过什么', '聊过什么', '讲过什么', '问过什么',
  '提过', '说过', '聊过', '讲过', '问过', '来着', '那些事', '那些',
  '什么', '事情', '事情呢', '来着吗',
]);

/** 承接用代词（闭类）：出现即说明这句话的主题只能从上下文补。 */
const ANAPHORA_TOKENS = Object.freeze(['他', '她', '它', 'ta', '对方', '那人', '这个人', '那个人', '其']);

/**
 * 含代词的复合词。判定承接之前先剥掉它们，否则「其实」「尤其」「其他」会被当成
 * 指代，让一句本来完整的话白跑一趟上下文补充。
 */
const ANAPHORA_FALSE_FRIENDS = Object.freeze([
  '其实', '其他', '其它', '其中', '尤其', '与其', '极其', '及其', '其余',
  '他人', '对方说',
]);

const MAX_ENTITIES = 6;
const MAX_EVENTS = 3;
const MAX_DROPPED_KEY = 40;

/** 现实作用域：只有这些作用域里的用户原话才能当承接锚点。 */
const REAL_SCOPES = new Set(['user_global', 'user_persona', 'session_recent']);
/** 只有这些现实级别是「用户确认过的」。 */
const CONFIRMED_REALITY = new Set(['explicit_user_statement', 'imported_fact']);

function presence(text, list) {
  const normalized = normalizeText(text);
  let hit = false;
  for (const token of list) {
    if (token && normalized.includes(normalizeText(token))) hit = true;
  }
  return hit;
}

function stripTokens(text, list) {
  let result = normalizeText(text);
  for (const token of list) {
    if (!token) continue;
    result = result.split(normalizeText(token)).join(' ');
  }
  return result;
}

/** 去掉标点与空白，只留可检索的字符，用于判断「还剩下什么」。 */
function residueTerms(text) {
  const cleaned = normalizeText(text).replace(/[^\p{Script=Han}a-z0-9]+/gu, ' ');
  return terms(cleaned);
}

function uniqueTerms(list, max = MAX_ENTITIES) {
  const out = [];
  const seen = new Set();
  for (const value of list) {
    const token = normalizeText(value).trim();
    if (!token || token.length > 12) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= max) break;
  }
  return out;
}

function countDropped(map, code) {
  if (!code) return;
  const key = String(code).slice(0, MAX_DROPPED_KEY);
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * 一条候选锚点的资格判定。返回 '' 表示可用，否则是理由码。
 * `assistant` 与「不是用户确认的事实」都必须在这里被拒，而不是在召回阶段补救。
 */
export function anchorRejection(anchor, now = Date.now(), windowMs = 0) {
  if (!anchor || typeof anchor !== 'object') return 'no-anchor';
  const role = String(anchor.role ?? '').toLowerCase();
  if (role === 'assistant' || role === 'bot' || role === 'model') return 'assistant-utterance';
  if (role && role !== 'user' && role !== 'memory') return 'no-anchor';

  const reality = String(anchor.realityLevel ?? '');
  if (anchor.role === 'memory' || reality) {
    if (reality === 'bot_action') return 'bot-action';
    if (reality === 'inferred') return 'inferred-reality';
    if (reality === 'imported_summary') return 'imported-summary';
    if (reality === 'roleplay_fiction') return 'roleplay-fiction';
    if (reality === 'user_utterance_not_verified_fact') return 'unverified-utterance';
    if (reality && !CONFIRMED_REALITY.has(reality)) return 'unverified-utterance';
  }
  const scope = String(anchor.scope ?? '');
  if (scope && !REAL_SCOPES.has(scope)) return 'scope-not-real';
  const text = String(anchor.text ?? '').trim();
  if (!text) return 'no-anchor';

  const at = Number(anchor.at ?? anchor.occurredAt ?? 0) || Date.parse(String(anchor.occurredAt ?? '')) || 0;
  if (windowMs > 0 && at > 0 && now - at > windowMs) return 'stale-anchor';
  return '';
}

/**
 * 构造一次查询计划。
 *
 * @param {object} input
 * @param {string} input.query            本轮用户原句（可空）
 * @param {Array}  input.anchors          候选承接锚点，每个 `{ role, text, scope, realityLevel, occurredAt, at, ref }`
 * @param {boolean} input.enabled         false 时退化为 `source:'raw'`（默认 true）
 * @param {boolean} input.continuationEnabled  关闭后不再做承接（默认 true）
 * @param {boolean} input.historyFallbackEnabled 关闭后纯元记忆查询不给兜底（默认 true）
 * @param {number} input.anchorWindowMs   锚点最大时差（0 = 不限）
 * @param {number} input.anchorLimit      最多采纳几个锚点（默认 3）
 * @param {number} input.now              时钟（毫秒）
 * @returns {{version:number, source:string, topicText:string, matchText:string,
 *           entities:string[], events:Array<{ref:string,terms:string[]}>,
 *           dropped:Object<string,number>, weakIntent:boolean, anaphora:boolean,
 *           explicitHistory:boolean, anchorCount:number, historyFallback:boolean}}
 */
export function buildQueryPlan(input = {}) {
  const query = String(input.query ?? '');
  const enabled = input.enabled !== false;
  const continuationEnabled = input.continuationEnabled !== false;
  const historyFallbackEnabled = input.historyFallbackEnabled !== false;
  const anchorWindowMs = Math.max(0, Number(input.anchorWindowMs) || 0);
  const anchorLimit = Math.min(MAX_EVENTS, Math.max(1, Math.trunc(Number(input.anchorLimit) || 3)));
  const now = Number(input.now) || Date.now();

  const dropped = {};
  const plan = {
    version: QUERY_PLAN_VERSION,
    source: 'raw',
    topicText: query,
    matchText: '',
    entities: [],
    events: [],
    dropped,
    weakIntent: false,
    anaphora: false,
    explicitHistory: false,
    anchorCount: 0,
    historyFallback: false,
  };

  if (!enabled) {
    plan.topicText = query;
    return plan;
  }

  const normalized = normalizeText(query);
  if (!normalized) {
    // 真·空查询（缺失或纯空白）：保持既有「最近重要记忆」路径，不在这里改语义。
    plan.source = 'raw';
    plan.topicText = '';
    return plan;
  }

  // --- 1. 弱意图：整句只有问候/附和闭类词 ------------------------------------
  const afterWeak = stripTokens(normalized, WEAK_INTENT_TOKENS);
  const weakResidue = residueTerms(afterWeak);
  const weakHit = presence(normalized, WEAK_INTENT_TOKENS) && weakResidue.length === 0;
  if (weakHit) {
    plan.source = 'weak-intent';
    plan.weakIntent = true;
    // 主题必须为空：问候不允许被扩写成任何未确认的事实（不推「刚睡醒」「刚起床」）。
    plan.topicText = '';
    plan.matchText = '';
    plan.entities = [];
    countDropped(dropped, 'weak-intent-empty-topic');
    return plan;
  }

  // --- 2. 元记忆查询：用户问的是「上次说过什么」------------------------------
  const afterHistory = stripTokens(normalized, [...HISTORY_MARKERS, ...HISTORY_FILLERS]);
  const historyResidue = residueTerms(afterHistory);
  const historyHit = presence(normalized, HISTORY_MARKERS) && historyResidue.length === 0;
  if (historyHit) {
    plan.source = 'explicit-history';
    plan.explicitHistory = true;
    plan.topicText = '';
    plan.historyFallback = historyFallbackEnabled;
    if (!historyFallbackEnabled) countDropped(dropped, 'history-fallback-disabled');
    return plan;
  }

  // --- 3. 承接：出现代词，主题只能来自用户自己确认过的上一句 -----------------
  const anaphora = presence(stripTokens(normalized, ANAPHORA_FALSE_FRIENDS), ANAPHORA_TOKENS);
  plan.anaphora = anaphora;
  if (anaphora && continuationEnabled) {
    const accepted = [];
    for (const anchor of Array.isArray(input.anchors) ? input.anchors : []) {
      const reason = anchorRejection(anchor, now, anchorWindowMs);
      if (reason) {
        countDropped(dropped, reason);
        continue;
      }
      accepted.push(anchor);
      if (accepted.length >= anchorLimit) break;
    }
    plan.anchorCount = accepted.length;
    if (accepted.length) {
      const anchorTerms = [];
      const events = [];
      for (const anchor of accepted) {
        const text = String(anchor.text ?? '').trim();
        const anchorTokens = terms(text);
        for (const token of anchorTokens) anchorTerms.push(token);
        events.push({
          ref: String(anchor.ref ?? anchor.sourceId ?? anchor.id ?? ''),
          terms: uniqueTerms(anchorTokens, 4),
        });
      }
      plan.source = 'continuation';
      // 第一轮仍然用原句（「他太顽固」自己也可能命中）；第二轮用锚点补上下文。
      plan.topicText = query;
      plan.matchText = uniqueTerms(anchorTerms, 12).join(' ');
      plan.entities = uniqueTerms(anchorTerms, MAX_ENTITIES);
      plan.events = events.slice(0, MAX_EVENTS);
      if (!plan.matchText) countDropped(dropped, 'no-anchor');
      return plan;
    }
    // 没有可用锚点：承接不成立，退回原句检索，并如实记录为什么没承接。
    countDropped(dropped, accepted.length ? 'no-anchor' : 'no-confirmed-anchor');
    plan.source = 'raw';
    plan.topicText = query;
    return plan;
  }

  if (anaphora && !continuationEnabled) countDropped(dropped, 'continuation-disabled');

  plan.source = 'raw';
  plan.topicText = query;
  return plan;
}

export const QUERY_PLAN_CONSTANTS = Object.freeze({
  WEAK_INTENT_TOKENS,
  HISTORY_MARKERS,
  ANAPHORA_TOKENS,
  MAX_ENTITIES,
  MAX_EVENTS,
  REAL_SCOPES: [...REAL_SCOPES],
  CONFIRMED_REALITY: [...CONFIRMED_REALITY],
});

/**
 * 对外暴露的构造溯源：`{ source, entities, events, dropped }` 加几个布尔/计数。
 *
 * **不带 `topicText` / `matchText`**：那两段是「原句的回声」，把它塞进 recall 的
 * 返回值等于让每个调用方都拿到用户这句话的副本，也会让「某段旧正文是否还在召回
 * 结果里」这类判断永远为真。溯源只需要回答「是怎么构造的」，不需要复述被构造的东西。
 */
export function summarizeQueryPlan(plan) {
  const source = plan && typeof plan === 'object' ? plan : {};
  return {
    version: Number(source.version) || QUERY_PLAN_VERSION,
    source: String(source.source ?? 'raw'),
    entities: Array.isArray(source.entities) ? source.entities.slice(0, MAX_ENTITIES) : [],
    events: Array.isArray(source.events)
      ? source.events.slice(0, MAX_EVENTS).map(event => ({
        ref: String(event?.ref ?? '').slice(0, 64),
        terms: Array.isArray(event?.terms) ? event.terms.slice(0, 4) : [],
      }))
      : [],
    dropped: source.dropped && typeof source.dropped === 'object' ? { ...source.dropped } : {},
    weakIntent: source.weakIntent === true,
    anaphora: source.anaphora === true,
    explicitHistory: source.explicitHistory === true,
    anchorCount: Math.max(0, Math.trunc(Number(source.anchorCount) || 0)),
    historyFallback: source.historyFallback === true,
  };
}
