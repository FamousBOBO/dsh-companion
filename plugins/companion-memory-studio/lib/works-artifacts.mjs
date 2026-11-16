// 陪伴空间 · 作品中心（W3）的读取层。
//
// 计划 W3 的六条要求，逐条落到实现上：
//   1. **不扫全盘**：只读 `p2_activities` / `p2_activity_receipts` 两段已经落库的证据，
//      加上 `artifactRoot` 目录内的文件元数据；不遍历用户磁盘。
//   2. **不暴露绝对路径**：对外只给 `relative`（相对 artifactRoot）与 `segmentCount`，
//      绝对路径永远留在服务端。
//   3. **路径校验 fail-closed**：直接复用 runtime 的 `resolveInsideWorkspace`
//      （`companion-runtime/lib/activity-adapters.mjs`），不在这里重写第二套判据；
//      再补一层 realpath 校验，挡住符号链接把路径带到根目录外。
//   4. **只读浏览**：没有写、删、覆盖、分享的入口。
//   5. **没有 receipt 的文件不标「已完成」**：状态由 activity + receipt 共同决定，
//      不靠文件存在就推断完成。
//   6. **不为作品正文新建第二本库**：列表索引是**现场派生**的（每次读都从既有证据重建），
//      不落盘、不做长期索引。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scopeKey, databaseFile } from '../../companion-runtime/lib/scope.mjs';
import { resolveInsideWorkspace } from '../../companion-runtime/lib/activity-adapters.mjs';

/** 允许预览的文本类型。其余一律"不给读"，只允许用宿主既有能力打开。 */
export const TEXT_EXTENSIONS = Object.freeze(['.md', '.markdown', '.txt', '.json', '.csv', '.yaml', '.yml', '.log']);

/** 预览上限：超过就只报大小，不下发正文（避免把大文件灌进浏览器）。 */
export const MAX_PREVIEW_BYTES = 256 * 1024;

/** 列表上限：一次最多回这么多作品，超出只报告 total。 */
export const MAX_ITEMS = 200;

export const WORK_STATUSES = Object.freeze(['draft', 'running', 'review', 'done', 'failed']);

const STATUS_LABEL = Object.freeze({
  draft: '草稿',
  running: '进行中',
  review: '待核对',
  done: '已完成',
  failed: '失败',
});

/**
 * 作品状态。
 *
 * 判据只有两条，都来自既有证据：
 *   - `done` 需要**同一条 activity 有一条 `ok` 的 finish receipt**。文件存在不算完成。
 *   - `failed` 需要**有一条 `ok=false` 的 receipt**（有收据的失败是"确证失败"，
 *     而不是猜出来的）。
 * 其余按 activity 的 `status` 映射：`running`/`paused` → `running`；
 * `done` 但只有 review 收据 → `review`（写了内容但还在核对）；`abandoned` → `draft`。
 */
export function workStatusOf(activity, receipts = []) {
  const rows = receipts.filter((receipt) => receipt.activity_id === activity.activity_id);
  const hasFinishOk = rows.some((receipt) => receipt.operation === 'finish' && Boolean(receipt.ok));
  const hasFailure = rows.some((receipt) => !Boolean(receipt.ok));
  const hasReviewOk = rows.some((receipt) => receipt.operation === 'review' && Boolean(receipt.ok));
  const status = String(activity.status || '');

  if (hasFailure) return 'failed';
  if (hasFinishOk) return 'done';
  if (status === 'done') return hasReviewOk ? 'review' : 'review';
  if (status === 'running' || status === 'paused') return 'running';
  if (status === 'failed') return 'failed';
  return 'draft';
}

/** 从相对引用里取一个可读标题：文件名去掉扩展名，不读正文、不猜内容。 */
export function titleOf(relative) {
  const base = String(relative ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  const withoutExt = base.replace(/\.(md|markdown|txt|json|csv|yaml|yml|log)$/i, '');
  return withoutExt || base || '(未命名)';
}

/** 文件类型：扩展名小写，没有扩展名回 `unknown`。 */
export function typeOf(relative) {
  const ext = path.extname(String(relative ?? '')).toLowerCase();
  return ext ? ext.slice(1) : 'unknown';
}

/** 这一份能不能当文本预览（类型 + 大小两道闸）。 */
export function previewableOf(relative, size) {
  const ext = path.extname(String(relative ?? '')).toLowerCase();
  if (!TEXT_EXTENSIONS.includes(ext)) return { ok: false, reason: 'unsupported-type' };
  if (!Number.isFinite(size) || size < 0) return { ok: false, reason: 'stat-unavailable' };
  if (size > MAX_PREVIEW_BYTES) return { ok: false, reason: 'too-large' };
  return { ok: true, reason: '' };
}

/**
 * 解析 artifactRoot。
 *
 * 配置值是 suite 根相对路径（`home/companion/works`）。**不猜绝对路径**：目录不存在
 * 就如实回 `available:false`，让 UI 显示"作品目录还没建起来"，而不是给一个空列表
 * 让人以为"没有作品"。
 */
export function resolveArtifactRoot(root) {
  let config = null;
  try {
    config = JSON.parse(fs.readFileSync(path.join(String(root), 'home/companion/runtime.config.json'), 'utf8'));
  } catch { config = null; }
  const configured = String(config?.p2?.activities?.artifactRoot ?? 'home/companion/works');
  // 配置里如果是绝对路径，说明部署自己指定了根，照用；否则按 suite 根拼接。
  const base = path.isAbsolute(configured) ? configured : path.join(String(root), configured);
  return { configured, absolute: base, exists: fs.existsSync(base) };
}

/**
 * 对外可说的"配置值"。
 *
 * 部署可以把 `artifactRoot` 配成绝对本机路径；那是**服务端的运行事实**，不该回给浏览器
 * （模块头第 2 条：绝对路径永远留在服务端）。这里只做一件事：绝对路径 → 占位符，
 * 相对路径照原样给（它本来就是相对 suite 根的可读值）。
 */
export function publicRootOf(configured) {
  const text = String(configured ?? '');
  if (!text) return '';
  if (path.isAbsolute(text)) return '<绝对路径·仅服务端可见>';
  return text;
}

/** realpath 二次校验：符号链接可能把"根内"变成"根外"。 */
function realpathInside(rootAbsolute, candidateAbsolute) {
  let rootReal = '';
  let targetReal = '';
  try { rootReal = fs.realpathSync(rootAbsolute); } catch { return { ok: false, reason: 'root-unresolvable' }; }
  try { targetReal = fs.realpathSync(candidateAbsolute); } catch { return { ok: false, reason: 'missing' }; }
  const withSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  if (targetReal !== rootReal && !targetReal.startsWith(withSep)) {
    return { ok: false, reason: 'symlink-escapes-root' };
  }
    return { ok: true, reason: '', absolute: targetReal };
}

/**
 * 精确授权：这个 scope 里有没有一条 activity 引用了**这个文件**。
 *
 * 与 `readWorkEvidence` 分开是必须的：那个函数是**列表**用的窗口（最近 400 条），
 * 把归属判定建在它上面就等于"第 401 条之后的作品不算你的"（N5）。这里按
 * `artifact_ref` 等值查、只取一行，不受窗口大小影响。
 *
 * `available:false` 表示证据层本身读不到 —— 那是 `evidence-unavailable`，不是
 * "不是你的作品"（N4）。
 */
export function lookupWorkActivity({ root, scope, relative }) {
  const file = databaseFile(root);
  if (!fs.existsSync(file)) return { available: false, reason: 'runtime-db-missing', found: false };
  if (!scope) return { available: false, reason: 'no-scope', found: false };
  const wanted = normaliseRelative(relative);
  // 库里可能存成正斜杠或反斜杠两种写法，两种都试一次（都是等值查询，不扫表）。
  const candidates = [wanted, wanted.replace(/\//g, '\\'), relative];
  const columns = [
    'activity_id, kind, adapter, status, target, artifact_ref, artifact_version, artifact_hash,',
    'total_units, consumed_prefix, reality, started_at, ended_at, updated_at',
  ].join(' ');
  const receiptsSql = 'SELECT activity_id, operation, ok, code, artifact_ref, at '
    + 'FROM p2_activity_receipts WHERE scope = ? AND activity_id = ? ORDER BY at DESC LIMIT 200';
  const sql = `SELECT ${columns} FROM p2_activities WHERE scope = ? AND artifact_ref = ? `
    + 'ORDER BY updated_at DESC LIMIT 1';
  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout=1000; BEGIN');
    for (const candidate of candidates) {
      const row = db.prepare(sql).get(scope, candidate);
      if (row) {
        const receipts = db.prepare(receiptsSql).all(scope, row.activity_id);
        db.exec('COMMIT');
        return { available: true, reason: '', found: true, activity: row, receipts };
      }
    }
    db.exec('COMMIT');
    return { available: true, reason: '', found: false, receipts: [] };
  } catch (error) {
    return {
      available: false,
      reason: 'runtime-db-unreadable',
      detail: String(error?.message ?? '').slice(0, 120),
      found: false,
    };
  } finally {
    try { db?.close(); } catch { /* 已关 */ }
  }
}

/**
 * 读运行时证据（只读连接，不拿写租约）。
 *
 * 任何读失败都收敛成 `{ available:false, reason }`，不抛给路由层——否则整个作品页会 500，
 * 而真实原因只是"运行时还没起过"。
 */
export function readWorkEvidence({ root, scope }) {
  const file = databaseFile(root);
  if (!fs.existsSync(file)) return { available: false, reason: 'runtime-db-missing', activities: [], receipts: [] };
  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout=1000; BEGIN');
    const activities = db.prepare(`
      SELECT activity_id, kind, adapter, status, target, artifact_ref, artifact_version, artifact_hash,
             total_units, consumed_prefix, reality, started_at, ended_at, updated_at
      FROM p2_activities
      WHERE scope = ? AND artifact_ref IS NOT NULL AND artifact_ref != ''
      ORDER BY updated_at DESC
      LIMIT 400
    `).all(scope);
    const receipts = db.prepare(`
      SELECT activity_id, operation, ok, code, artifact_ref, at
      FROM p2_activity_receipts
      WHERE scope = ?
      ORDER BY at DESC
      LIMIT 2000
    `).all(scope);
    db.exec('COMMIT');
    return { available: true, reason: '', activities, receipts };
  } catch (error) {
    return { available: false, reason: 'runtime-db-unreadable', detail: String(error?.message ?? '').slice(0, 120), activities: [], receipts: [] };
  } finally {
    try { db?.close(); } catch { /* 已关 */ }
  }
}

/**
 * 建列表（现场派生，不落盘）。
 *
 * @returns `{ available, reason, root, items, skipped }`
 *   `items[].relative` 是相对路径；**没有 absolute**。
 *   `skipped` 是"有引用但走不到文件"的计数（缺失/越界/类型不支持等），带原因分布。
 */
export function buildWorksIndex({ root, scope }) {
  const artifactRoot = resolveArtifactRoot(root);
  const evidence = readWorkEvidence({ root, scope });

  if (!artifactRoot.exists) {
    return {
      available: false,
      reason: 'artifact-root-missing',
      root: { configured: publicRootOf(artifactRoot.configured) },
      evidence: { available: evidence.available, reason: evidence.reason || '' },
      total: 0,
      items: [],
      skipped: 0,
      skippedReasons: {},
    };
  }

  const skippedReasons = {};
  const noteSkip = (reason) => { skippedReasons[reason] = (skippedReasons[reason] || 0) + 1; };
  const items = [];

  for (const activity of evidence.activities ?? []) {
    const ref = String(activity.artifact_ref ?? '');
    let resolved;
    try {
      // 用 runtime 自己的判据：绝对路径、`..`、NUL、空引用全部 workspace-denied。
      resolved = resolveInsideWorkspace(artifactRoot.absolute, ref);
    } catch {
      noteSkip('path-denied');
      continue;
    }
    const real = realpathInside(artifactRoot.absolute, resolved.absolute);
    if (!real.ok) { noteSkip(real.reason); continue; }
    let stat = null;
    try { stat = fs.statSync(real.absolute); } catch { noteSkip('missing'); continue; }
    if (!stat.isFile()) { noteSkip('not-a-file'); continue; }

    const receipts = evidence.receipts ?? [];
    const status = workStatusOf(activity, receipts);
    const preview = previewableOf(resolved.relative, stat.size);
    items.push({
      activityId: String(activity.activity_id ?? ''),
      // 对外只给相对路径，绝对路径不出服务端。
      relative: resolved.relative,
      title: titleOf(resolved.relative),
      type: typeOf(resolved.relative),
      size: stat.size,
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
      status,
      statusLabel: STATUS_LABEL[status] || status,
      version: Number(activity.artifact_version ?? 0),
      hashPrefix: String(activity.artifact_hash ?? '').slice(0, 16),
      // 证据：有没有 finish/review 收据、版本号多少，都摆出来，不靠推断。
      evidence: {
        finishReceipted: receipts.some((receipt) => receipt.activity_id === activity.activity_id && receipt.operation === 'finish' && Boolean(receipt.ok)),
        reviewReceipted: receipts.some((receipt) => receipt.activity_id === activity.activity_id && receipt.operation === 'review' && Boolean(receipt.ok)),
        receiptCount: receipts.filter((receipt) => receipt.activity_id === activity.activity_id).length,
        reality: String(activity.reality ?? ''),
      },
      kind: String(activity.kind ?? ''),
      adapter: String(activity.adapter ?? ''),
      units: { total: Number(activity.total_units ?? 0), consumed: Number(activity.consumed_prefix ?? 0) },
      startedAt: activity.started_at ? new Date(Number(activity.started_at) || activity.started_at).toISOString() : null,
      updatedAt: activity.updated_at ? new Date(Number(activity.updated_at) || activity.updated_at).toISOString() : null,
      preview: { ok: preview.ok, reason: preview.reason },
      segmentCount: resolved.relative.split('/').length,
    });
  }

  // 同一份文件可能被多次活动写过（版本迭代）：按 relative + version 去重最新一条，
  // 其余作为"其他版本"计数，避免列表里出现 8 行同名文件。
  const byFile = new Map();
  for (const item of items) {
    const key = item.relative;
    const existing = byFile.get(key);
    if (!existing) { byFile.set(key, { ...item, otherVersions: 0 }); continue; }
    if (item.version > existing.version) {
      byFile.set(key, { ...item, otherVersions: existing.otherVersions + 1 });
    } else {
      existing.otherVersions += 1;
    }
  }
  const deduped = [...byFile.values()].sort((left, right) => String(right.modifiedAt).localeCompare(String(left.modifiedAt)));

  return {
    available: true,
    reason: '',
    root: { configured: publicRootOf(artifactRoot.configured) },
    evidence: { available: evidence.available, reason: evidence.reason || '' },
    total: deduped.length,
    items: deduped.slice(0, MAX_ITEMS),
    skipped: Object.values(skippedReasons).reduce((sum, count) => sum + count, 0),
    skippedReasons,
  };
}

/** 搜索与过滤（在服务端做，客户端不拉全量再筛）。 */
export function filterWorks(items, { q = '', type = '', status = '', from = '', to = '' } = {}) {
  const query = String(q ?? '').trim().toLowerCase();
  const typeFilter = String(type ?? '').trim().toLowerCase();
  const statusFilter = String(status ?? '').trim();
  const fromMs = from ? Date.parse(String(from)) : NaN;
  const toMs = to ? Date.parse(String(to)) : NaN;

  return items.filter((item) => {
    if (query && !`${item.title} ${item.relative}`.toLowerCase().includes(query)) return false;
    if (typeFilter && item.type !== typeFilter) return false;
    if (statusFilter && item.status !== statusFilter) return false;
    if (Number.isFinite(fromMs) && Date.parse(item.modifiedAt) < fromMs) return false;
    if (Number.isFinite(toMs) && Date.parse(item.modifiedAt) > toMs) return false;
    return true;
  });
}

/**
 * 读一份作品的预览。
 *
 * **顺序很重要：先授权，再读正文。**
 *
 * 这里的第一道闸不是路径，而是**归属**：`artifactRoot` 默认是所有 scope 共享的目录
 * （`home/companion/works`），所以"路径在根内"根本不等于"这是你的作品"。必须先问
 * 「当前 scope 里有没有一条 activity 的 `artifact_ref` 正是这个文件」，答不上来就
 * `not-in-scope`，一次 `readFileSync` 都不做。
 *
 * 然后才是三道原有闸：路径（runtime 判据 + realpath）、类型与大小（`previewableOf`）、
 * 内容形态（只回文本，不回二进制/base64；不做 HTML 渲染）。
 *
 * stat 与 read 都走**同一个已打开的 fd**：`realpath → stat → read` 三步之间文件可能被
 * 换成符号链接，用 fd 让"判过的那个 inode"就是"读的那个 inode"。
 */
export function readWorkPreview({ root, scope, relative }) {
  const artifactRoot = resolveArtifactRoot(root);
  if (!artifactRoot.exists) return { ok: false, reason: 'artifact-root-missing' };

  let resolved;
  try {
    resolved = resolveInsideWorkspace(artifactRoot.absolute, relative);
  } catch (error) {
    return { ok: false, reason: 'path-denied', detail: String(error?.message ?? '').slice(0, 160) };
  }

  // ── 第一道闸：归属。跨 scope 的路径在这里就回去，正文一个字节都不读。
  //
  // 用精确查询（`lookupWorkActivity`），不复用列表那个 LIMIT 400 的窗口 —— 否则同一 scope
  // 里活动数超过 400 之后，老作品会从"能预览"变成"不是你的作品"（N5）。
  const ownership = lookupWorkActivity({ root, scope, relative: resolved.relative });
  if (!ownership.available) {
    // 证据层读不到 ≠ 不是你的作品。这里必须与列表口径一致（列表同时会说
    // `evidence.available === false`），否则排障会被引到错误方向（N4）。
    return {
      ok: false,
      reason: 'evidence-unavailable',
      detail: '运行时证据层不可用，无法确认这份作品的归属；这不是"不在你的作品记录里"。',
      evidence: { available: false, reason: ownership.reason },
      meta: { relative: resolved.relative, size: null, type: typeOf(resolved.relative) },
    };
  }
  if (!ownership.found) {
    return {
      ok: false,
      reason: 'not-in-scope',
      detail: '这个文件不在当前身份的作品记录里：预览只对 p2_activities 里引用过的文件开放。',
      meta: { relative: resolved.relative, size: null, type: typeOf(resolved.relative) },
    };
  }

  const real = realpathInside(artifactRoot.absolute, resolved.absolute);
  if (!real.ok) return { ok: false, reason: real.reason };

  let fd = null;
  let stat = null;
  try {
    fd = fs.openSync(real.absolute, 'r');
    stat = fs.fstatSync(fd);
  } catch {
    try { if (fd !== null) fs.closeSync(fd); } catch { /* 已关 */ }
    return { ok: false, reason: 'missing' };
  }
  if (!stat.isFile()) {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
    return { ok: false, reason: 'not-a-file' };
  }

  const preview = previewableOf(resolved.relative, stat.size);
  if (!preview.ok) {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
    // 不可预览也要给出元信息（大小/类型/时间），UI 才能说明"为什么不能在这里读"。
    return {
      ok: false,
      reason: preview.reason,
      meta: { relative: resolved.relative, size: stat.size, type: typeOf(resolved.relative), modifiedAt: new Date(stat.mtimeMs).toISOString() },
    };
  }

  let text = '';
  try {
    text = fs.readFileSync(fd, 'utf8');
  } catch {
    return { ok: false, reason: 'read-failed', meta: { relative: resolved.relative, size: stat.size } };
  } finally {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
  }

  // 证据同样要回：预览页不能只显示内容而丢掉"这一版有没有收据"。
  // 收据同样来自精确查询（`lookupWorkActivity` 顺带取回），不依赖列表的 2000 条窗口。
  const activity = ownership.activity;
  const receipts = ownership.receipts ?? [];

  return {
    ok: true,
    reason: '',
    relative: resolved.relative,
    title: titleOf(resolved.relative),
    type: typeOf(resolved.relative),
    size: stat.size,
    modifiedAt: new Date(stat.mtimeMs).toISOString(),
    text,
    truncated: false,
    status: workStatusOf(activity, receipts),
    version: Number(activity?.artifact_version ?? 0),
    hashPrefix: String(activity?.artifact_hash ?? '').slice(0, 16),
    evidence: {
      finishReceipted: receipts.some((receipt) => receipt.operation === 'finish' && Boolean(receipt.ok)),
      reviewReceipted: receipts.some((receipt) => receipt.operation === 'review' && Boolean(receipt.ok)),
      receiptCount: receipts.length,
      receiptCodes: receipts.slice(0, 10).map((receipt) => `${receipt.operation}${receipt.ok ? '+' : '-'}${receipt.code ? `:${receipt.code}` : ''}`),
    },
  };
}

/** 相对路径归一：两种分隔符折成 `/`，用于 scope 归属比较（不做大小写折叠）。 */
function normaliseRelative(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\//, '');
}

export { STATUS_LABEL, scopeKey };
