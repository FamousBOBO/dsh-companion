// P2 分享链的**只读**诊断面（CONTRACT §13.11.4 的缺口：过期 = 静默丢弃，无计数无原因）。
//
// 为什么在这里：`p2_share_candidates` 的唯一写入者是 runtime（`lib/p2.mjs`）。runtime 的
// `lib/observability.mjs` 已经有 `expired` 的**计数**，但没有"最后一次过期是什么时候"和
// "按原因分布"，而 `p2.status().share` 只有 `{enabled,pending,owner,port}` 四个字段。
// 这一层不改 runtime、不加表、不加迁移，只**只读**打开同一个 SQLite 把三件事实读出来：
//
//   1. 过期了几条、最后一条过期在哪一刻、按什么原因过期；
//   2. 丢弃（gate 终态 / 撤回 / 被拒）几条、最后一条何时、按原因分布；
//   3. 有多少条还 pending、最老的一条等了多久（"卡住"与"在等"是两件事）。
//
// 三条硬口径（写进返回值，不是注释里的君子协定）：
//   * **不发**：这里一行写语句都没有，`readOnly` 连接，只 SELECT。打开发送是 contact 的事。
//   * **不冒充已发送**：`sent` 永远是 `null + honest:'not-wired'`，不是 0。runtime 库里根本
//     没有"对方收到了"这个事实；contact 侧自己那本账才是唯一来源。
//   * **不把"不知道"说成"没有"**：库不存在 / 表不存在 / 查询失败 → `ok:false` + 具体 code，
//     绝不回一堆 0 让调用方误以为"一切正常"。
//
// 还有一条**必须诚实说出口的未知**：一条候选在 runtime 里变成 `queued` 之后，runtime 再也
// 不看它；contact 侧的 6 小时 TTL 到期后 contact 会把它标 `expired`（`transitions.ts`
// 的 `expireStale` / `gate.ts` 的 `checkWindow`），**而 runtime 那行仍然停在 `queued`**。
// 所以 `queued` 只证明"进过 contact 的账本"，不证明"还在里面"，更不证明"发出去了"。
// 本模块把这件事写成 `contactAckAfterQueued:'unknown'`，不猜。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 候选状态（`p2_share_candidates.status` 的全部合法取值，见 `lib/p2.mjs`）。 */
export const SHARE_STATES = Object.freeze(['pending', 'queued', 'gated', 'rejected', 'submitted', 'expired', 'withdrawn']);

/** 终态里"这条分享没出去"的那几个；`queued` 不在其中（它表示"已进 contact 账本"）。 */
export const DROP_STATES = Object.freeze(['gated', 'rejected', 'withdrawn', 'expired']);

/** 默认的值文件位置与 runtime 的 `databaseFile()` 同一条规则（不另造第二套路径）。 */
const DEFAULT_DB_RELATIVE = 'home/companion/companion-runtime.db';

/** 原因的 id 只留前缀：诊断里不该出现能把一条候选反查回正文的东西。 */
function reasonOf(value) {
  return String(value ?? '').trim().slice(0, 60) || '(none)';
}

/** `expired:<gate-reason>` 的前缀是 runtime 在"重试用尽"时拼的（`lib/p2.mjs` 的 `finalReason`）。 */
function expireCauseOf(reason) {
  const text = reasonOf(reason);
  return text.startsWith('expired:') ? text.slice('expired:'.length) : text;
}

function histogram(rows, { totalLimit = 12 } = {}) {
  const buckets = new Map();
  for (const row of rows) {
    const key = reasonOf(row.decision_reason);
    const current = buckets.get(key) ?? { reason: key, count: 0, lastAt: 0 };
    current.count += Number(row.n) || 0;
    current.lastAt = Math.max(current.lastAt, Number(row.last) || 0);
    buckets.set(key, current);
  }
  const all = [...buckets.values()].sort((left, right) => (right.count - left.count) || (right.lastAt - left.lastAt));
  return { total: all.reduce((sum, item) => sum + item.count, 0), buckets: all.slice(0, totalLimit), truncated: all.length > totalLimit };
}

/**
 * 打开 runtime 的值文件（**只读**）。
 *
 * 给的是"为什么打不开"，不是一个笼统的 null：库没建出来（runtime 从未在本机跑过）与
 * 库在但表不在（旧 schema / 另一个库）是两种完全不同的运维动作。
 */
function openReadonly(file) {
  try {
    const handle = new DatabaseSync(file, { readOnly: true });
    return { ok: true, handle };
  } catch (error) {
    return { ok: false, code: 'db-unopenable', reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
  }
}

/**
 * 读一遍分享链的现状。**只读、有界、缺数据就说缺数据。**
 *
 * @param root     companion 根（`home/companion` 在它下面）
 * @param dbFile   显式值文件（测试用）；缺省按环境变量与默认规则推
 * @param scopeKey 只看一个作用域（`u:…|p:…|w:…`）；省略 = 全部
 * @param now      注入时钟（毫秒）
 * @param ttlMs    判定"卡住"的阈值；缺省用 contact 侧的 6 小时分享 TTL
 */
export function describeShareChain({ root, dbFile = '', scopeKey = '', now = Date.now(), ttlMs = 6 * 3_600_000 } = {}) {
  const at = Number(now);
  const file = String(dbFile || process.env.DSH_COMPANION_RUNTIME_DB || path.join(String(root ?? ''), DEFAULT_DB_RELATIVE));
  const base = {
    // 路径只回相对形状，不回绝对路径（证据与诊断都不该带本机目录）。
    source: 'companion-runtime.db:p2_share_candidates',
    scope: scopeKey ? 'scoped' : 'all-scopes',
    readOnly: true,
    sent: Object.freeze({
      value: null,
      honest: 'not-wired',
      why: 'runtime 的库里没有"对方收到了"这个事实；是否发出只能看 contact（QQ 侧）自己的投递账本',
    }),
  };
  if (!fs.existsSync(file)) {
    return { ok: false, code: 'db-missing', ...base, note: 'runtime 的值文件不存在（这台机器没跑过 cognitive runtime），不是"零候选"' };
  }
  const opened = openReadonly(file);
  if (!opened.ok) return { ok: false, code: opened.code, reason: opened.reason, ...base };

  try {
    const hasTable = opened.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'p2_share_candidates'").get();
    if (!hasTable) {
      return { ok: false, code: 'table-missing', ...base, note: '库在但没有 p2_share_candidates 表（旧 schema 或换了库），不是"零候选"' };
    }
    const where = scopeKey ? 'WHERE scope = ?' : '';
    const whereAnd = scopeKey ? 'WHERE scope = ? AND ' : 'WHERE ';
    const args = scopeKey ? [String(scopeKey)] : [];
    const all = (sql, ...params) => opened.handle.prepare(sql).all(...params);

    // 1) 按状态的总账
    const counts = {};
    for (const row of all(`SELECT status, COUNT(*) AS n FROM p2_share_candidates ${where} GROUP BY status`, ...args)) {
      counts[String(row.status)] = Number(row.n) || 0;
    }
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    // 出现表里不该有的状态（典型：有人把 `queued` 改成 `sent`）要**喊出来**，不能算进总数就完事。
    const unexpected = Object.keys(counts).filter(state => !SHARE_STATES.includes(state));

    // 2) 过期：条数、最后时刻、按原因分布（这是 §13.11.4 点名缺的那三样）
    const expiredRow = all(`SELECT COUNT(*) AS n, MAX(decision_at) AS last FROM p2_share_candidates ${whereAnd}status = 'expired'`, ...args)[0] ?? {};
    const expiredReasons = all(`SELECT decision_reason, COUNT(*) AS n, MAX(decision_at) AS last
                                 FROM p2_share_candidates ${whereAnd}status = 'expired'
                                 GROUP BY decision_reason ORDER BY n DESC`, ...args);
    const expiredHist = histogram(expiredReasons);
    const expired = {
      count: Number(expiredRow.n) || 0,
      lastAt: Number(expiredRow.last) || 0,
      lastAgeMs: Number(expiredRow.last) ? Math.max(0, at - Number(expiredRow.last)) : null,
      // 过期原因与被丢弃的闸门原因是同一套词表（`cooldown:room` / `quota:global` / …），
      // 去掉 runtime 自己加的 `expired:` 前缀，避免同一件事在诊断里出现两种写法。
      reasons: expiredHist.buckets.map(item => ({ ...item, reason: expireCauseOf(item.reason) })),
      reasonsTruncated: expiredHist.truncated,
    };

    // 3) 丢弃：gate 终态 / 撤回 / 被拒 —— 一条候选"没出去"的全部方式
    const dropRows = all(`SELECT status, decision_reason, COUNT(*) AS n, MAX(decision_at) AS last
                           FROM p2_share_candidates
                           ${whereAnd}status IN (${DROP_STATES.map(() => '?').join(',')})
                           GROUP BY status, decision_reason ORDER BY n DESC`, ...args, ...DROP_STATES);
    const dropHist = histogram(dropRows);
    const dropped = {
      count: dropHist.total,
      lastAt: dropHist.buckets.reduce((last, item) => Math.max(last, item.lastAt), 0),
      reasons: dropHist.buckets,
      reasonsTruncated: dropHist.truncated,
      byState: Object.fromEntries(DROP_STATES.map(state => [state, counts[state] ?? 0])),
      note: '这些候选**没出去**。`share-disabled` 是"开关关着"，`no-target` 是"没有主人私聊"，'
        + '`dedupe` 是"这件事已经投递过"，`share-port-unavailable` 是"没有 contact 端口"——四种都是终态，不会自己复活',
    };

    // 4) 还在等的：条数 + 最老等了多久（"卡住"与"在等"必须能分开）
    const pendingRow = all(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM p2_share_candidates ${whereAnd}status = 'pending'`, ...args)[0] ?? {};
    const oldestPendingAgeMs = Number(pendingRow.oldest) ? Math.max(0, at - Number(pendingRow.oldest)) : null;
    const pendingCount = Number(pendingRow.n) || 0;

    // 5) 已交给 contact 的：只报数量，不报"发出"
    const queuedCount = counts.queued ?? 0;

    const stuck = pendingCount > 0 && oldestPendingAgeMs !== null && oldestPendingAgeMs > Number(ttlMs);
    return {
      ok: true,
      ...base,
      at,
      total,
      counts,
      unexpectedStates: unexpected,
      expired,
      dropped,
      pending: {
        count: pendingCount,
        oldestAgeMs: oldestPendingAgeMs,
        stuck,
        ttlMs: Number(ttlMs),
        note: stuck
          ? `最老的一条候选已经等了 ${Math.round((oldestPendingAgeMs ?? 0) / 60000)} 分钟（超过阈值）：多半是投递泵没跑，不是闸门在等`
          : '在等的候选没有超过阈值',
      },
      queued: {
        count: queuedCount,
        contactAckAfterQueued: 'unknown',
        note: queuedCount === 0
          ? '还没有候选进过 contact 的账本'
          : '`queued` 只证明"进过 contact 账本"：contact 侧 6 小时 TTL 到期后它会标 expired，而 runtime 这行仍停在 queued',
      },
      // 一句话总结，给面板/日志直接用；**不出现"已发送"三个字**。
      summary: `候选 ${total} 条；在等 ${pendingCount}；进 contact 账本 ${queuedCount}；过期 ${expired.count}；丢弃 ${dropped.count}；真实送达 unknown（runtime 看不到）`,
    };
  } catch (error) {
    return { ok: false, code: 'query-failed', reason: (error instanceof Error ? error.message : String(error)).slice(0, 200), ...base };
  } finally {
    try { opened.handle.close(); } catch { /* already closed */ }
  }
}

export { DEFAULT_DB_RELATIVE };
