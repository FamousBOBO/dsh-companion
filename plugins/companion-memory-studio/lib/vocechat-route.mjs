// 陪伴空间 · VoceChat 通道的只读观察面。
//
// 三个入口，全部**只读**、全部**只读文件**：
//
//   GET /vocechat                通道整体状态：传输侧挂载事实、游标、适配侧投递统计
//   GET /vocechat-events         已接收事件（按 mid 倒序，正文只给预览）
//   GET /vocechat-deliveries     发送账本（就是 `sent-log.jsonl`，本身已截断到 60 字）
//
// 为什么走文件而不走 `ctx.get('vocechatAdapter')`：Studio 与两个 VoceChat 行是**兄弟** cordis
// 行，`ctx.get` 在兄弟上看不见（`companion-health` 当初就是这样整条链路静默失效的）。适配行
// 也**没有**写 process 注册表，所以这里没有可解析的服务。于是这个观察面刻意只依赖**磁盘上
// 已经存在的事实**：
//
//   - 插件行没挂载 → 文件不存在 → 页面说"没有这一侧的文件"，而不是"一切正常"；
//   - 宿主重启过几次 → 文件还在 → 照样能看历史。
//
// 这也意味着**加这个页面不需要在生产上动任何插件行**，只有 Studio 自己多三个路由。
//
// ── 正文的边界 ───────────────────────────────────────────────────────────
//
// `events.jsonl` 里存的是**完整正文**。这个页面默认只给前 60 字（与适配层 `sent-log.mjs` 的
// `PREVIEW_CHARS` 一致），理由不是"怕泄密"（Studio 本来就只有主人能看），而是：
//
//   1. 列表页一次返回几百条，正文全长会把响应撑到几 MB，而页面上根本显示不下；
//   2. 聚合视图里混着全文，会让人误以为这里能"读全部聊天记录"——它能，但要一条一条要。
//
// 所以：默认预览；要看某一条的全文，用 `?mid=<n>&full=1`，一次只给一条，且仍走 owner 判定。

import fs from 'node:fs';
import path from 'node:path';

/** 预览长度。与 `dsh-vocechat-adapter/sent-log.mjs` 的 PREVIEW_CHARS 保持一致。 */
export const PREVIEW_CHARS = 60;

/** 一次最多返回多少条事件 / 投递。列表页用不完更多，也不该让响应无界。 */
export const MAX_ROWS = 300;

/**
 * 这几个路径都相对**数据根**（Studio 的 `kernel.root` = `<suite>/data`），与两个插件行的
 * `resolveDataRoot()` 结果一致。写成常量便于测试直接断言，而不是在测试里重复拼路径。
 */
export const VOCECHAT_PATHS = Object.freeze({
  mount: ['home', 'channel-vocechat', 'diag', 'mount.json'],
  cursor: ['home', 'channel-vocechat', 'state', 'last-processed.json'],
  events: ['home', 'channel-vocechat', 'events', 'events.jsonl'],
  gaps: ['home', 'channel-vocechat', 'events', 'gap.jsonl'],
  deliveries: ['home', 'vocechat-adapter', 'sent-log.jsonl'],
});

function fileOf(root, parts) {
  return path.join(String(root ?? ''), ...parts);
}

/** Read a JSON file, or null. Never throws: a missing/partial file is a fact, not an error. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read the last `limit` parseable JSON lines of a `.jsonl`.
 *
 * Reads the whole file: these files rotate at 2 MiB, so "whole file" is a bounded cost, and an
 * offset-based tail reader would have to handle a partial first line after rotation. A malformed
 * line is skipped and counted — one bad line must not make the page unopenable.
 */
function readJsonlTail(file, limit) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, reason: error?.code === 'ENOENT' ? 'missing' : 'unreadable', rows: [], skipped: 0, total: 0 };
  }
  const lines = text.split('\n');
  const rows = [];
  let skipped = 0;
  let total = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    total += 1;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      skipped += 1;
    }
  }
  return { ok: true, reason: '', rows: rows.slice(-limit), skipped, total };
}

/** Truncate for display and say whether anything was cut. */
export function preview(value, maxChars = PREVIEW_CHARS) {
  const text = String(value ?? '').replace(/\s+/g, ' ');
  if (text.length <= maxChars) return { text, truncated: false, chars: text.length };
  return { text: `${text.slice(0, maxChars)}…`, truncated: true, chars: text.length };
}

function numberOrNull(value) {
  // `Number(null)` is **0**, and `Number('')` is 0 too — both would make a "no mid given" query
  // look like `mid=0` and silently enter the full-body branch. Treat absent as absent.
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 传输侧的事实：全部来自 `diag/mount.json` 与 `state/last-processed.json`。 */
function transportFacts(root) {
  const mount = readJson(fileOf(root, VOCECHAT_PATHS.mount));
  const cursor = readJson(fileOf(root, VOCECHAT_PATHS.cursor));
  return {
    mounted: mount !== null,
    // 只挑能用来说明的字段。`keys` 里那串注册表键名与凭据来源路径对排查有用，
    // 但它们是**实现细节**，页面不展示；这里只保留"哪一侧说话、连哪个地址"。
    version: mount?.version ?? null,
    enabled: mount?.enabled ?? null,
    baseHost: mount?.baseHost ?? null,
    uid: mount?.uid ?? null,
    deviceName: mount?.deviceName ?? null,
    problems: Array.isArray(mount?.problems) ? mount.problems.slice(0, 8) : [],
    cursorMid: numberOrNull(cursor?.mid),
    cursorAt: numberOrNull(cursor?.at),
  };
}

/**
 * 通道整体状态。
 *
 * `available` 说的是"这个观察面有没有东西可看"，不是"通道健康"。两者必须分开：
 * 插件没挂载时前者是 false，后者无从判断 —— 用一句话说清楚，而不是给个绿点。
 */
export async function vocechatStatus(request, kernel) {
  kernel.viewer(await kernel.internal());
  const root = String(kernel.root ?? '');
  const transport = transportFacts(root);
  const events = readJsonlTail(fileOf(root, VOCECHAT_PATHS.events), 1);
  const gaps = readJsonlTail(fileOf(root, VOCECHAT_PATHS.gaps), MAX_ROWS);
  const deliveries = readJsonlTail(fileOf(root, VOCECHAT_PATHS.deliveries), MAX_ROWS);

  const deliveryRows = deliveries.rows ?? [];
  const sent = deliveryRows.filter((row) => row.kind === 'sent' && row.ok === true).length;
  const failed = deliveryRows.filter((row) => row.kind === 'sent' && row.ok === false).length;
  const undelivered = deliveryRows.filter((row) => row.kind === 'undelivered').length;
  const skippedRows = deliveryRows.filter((row) => row.kind === 'skipped').length;
  const turns = deliveryRows.filter((row) => row.kind === 'turn-start').length;

  const lastSent = [...deliveryRows].reverse().find((row) => row.kind === 'sent' && row.ok === true) ?? null;

  return kernel.ok({
    // 传输侧的挂载事实缺失 = 插件行没挂（或者从未起过），这是环境事实而不是错误。
    available: transport.mounted || events.ok || deliveries.ok,
    observedAt: new Date().toISOString(),
    root,
    transport,
    events: {
      readable: events.ok,
      reason: events.reason,
      stored: events.total ?? 0,
      skipped: events.skipped ?? 0,
    },
    gaps: {
      readable: gaps.ok,
      count: gaps.total ?? 0,
      // 补播断口是**真实丢消息**的唯一直接证据，所以它永远显示，不因为"看起来没问题"就藏起来。
      recent: (gaps.rows ?? []).slice(-5).map((row) => ({
        at: numberOrNull(row?.at),
        from: numberOrNull(row?.from),
        to: numberOrNull(row?.to),
        reason: String(row?.reason ?? '').slice(0, 60),
      })),
    },
    deliveries: {
      readable: deliveries.ok,
      reason: deliveries.reason,
      stored: deliveries.total ?? 0,
      skippedMalformed: deliveries.skipped ?? 0,
      // 窗口内（最多 MAX_ROWS 条账本）的计数。页面上要标"窗口内"，否则会被当成累计值。
      window: { sent, failed, undelivered, skipped: skippedRows, turns },
      lastSent: lastSent
        ? {
          at: numberOrNull(lastSent.at),
          mid: numberOrNull(lastSent.mid),
          room: String(lastSent.room ?? ''),
          phase: String(lastSent.phase ?? ''),
          chars: numberOrNull(lastSent.chars),
          preview: String(lastSent.preview ?? '').slice(0, PREVIEW_CHARS),
        }
        : null,
    },
  });
}

/**
 * 已接收事件（入站侧）。
 *
 * 按 `mid` 倒序，正文只给预览。要某一条的全文用 `?mid=<n>&full=1`。
 */
export async function vocechatEvents(request, kernel) {
  kernel.viewer(await kernel.internal());
  const root = String(kernel.root ?? '');
  const url = new URL(request.url);

  const mid = numberOrNull(url.searchParams.get('mid'));
  const full = url.searchParams.get('full') === '1';

  const read = readJsonlTail(fileOf(root, VOCECHAT_PATHS.events), MAX_ROWS);
  if (!read.ok) {
    return kernel.ok({
      available: false,
      reason: read.reason,
      events: [],
      total: 0,
      skipped: 0,
      observedAt: new Date().toISOString(),
    });
  }

  // 全文模式：一次只认一条，且必须给 mid。不给就退回预览列表 —— 不做"全给全文"这种批量开口。
  if (full && mid !== null) {
    const match = [...read.rows].reverse().find((row) => Number(row?.event?.mid) === mid);
    if (!match) {
      return kernel.ok({
        available: true,
        reason: 'mid-not-in-window',
        full: null,
        events: [],
        total: read.total,
        skipped: read.skipped,
        observedAt: new Date().toISOString(),
      });
    }
    return kernel.ok({
      available: true,
      reason: '',
      full: {
        mid,
        at: numberOrNull(match.at),
        fromUid: numberOrNull(match?.event?.fromUid),
        target: match?.event?.target ?? null,
        contentType: String(match?.event?.contentType ?? ''),
        content: String(match?.event?.content ?? ''),
      },
      events: [],
      total: read.total,
      skipped: read.skipped,
      observedAt: new Date().toISOString(),
    });
  }

  const events = [...read.rows]
    .reverse()
    .map((row) => {
      const event = row?.event ?? {};
      const body = preview(event?.content);
      return {
        at: numberOrNull(row?.at),
        mid: numberOrNull(event?.mid),
        fromUid: numberOrNull(event?.fromUid),
        // 目标用判别式表达（channel / user），不要压成一个布尔 —— 页面要能说清"这条进的是
        // 频道还是私聊"，而这两者对应的房间键完全不同。
        target: event?.target?.channel !== undefined
          ? { channel: numberOrNull(event.target.channel) }
          : { user: numberOrNull(event?.target?.user) },
        contentType: String(event?.contentType ?? ''),
        kind: String(event?.kind ?? ''),
        preview: body.text,
        previewTruncated: body.truncated,
        chars: body.chars,
      };
    });

  return kernel.ok({
    available: true,
    reason: '',
    full: null,
    window: MAX_ROWS,
    total: read.total,
    // `total` 是文件里的总条数，`events.length` 是这一页。两者分开，页面上才说得清
    // "只有 12 条"和"有 400 条但只显示最近 300 条"。
    returned: events.length,
    skipped: read.skipped,
    previewChars: PREVIEW_CHARS,
    events,
    observedAt: new Date().toISOString(),
  });
}

/**
 * 发送账本（出站侧）。
 *
 * `sent-log.jsonl` 本身已经是"预览 60 字、无全文"的形态，所以这里照原样返回，只补齐
 * `kind` 的白名单与排序，**不重新截断**（再截一次会让人以为是两条不同的长度）。
 */
export async function vocechatDeliveries(request, kernel) {
  kernel.viewer(await kernel.internal());
  const root = String(kernel.root ?? '');
  const url = new URL(request.url);
  const kind = String(url.searchParams.get('kind') ?? '').slice(0, 20);

  const read = readJsonlTail(fileOf(root, VOCECHAT_PATHS.deliveries), MAX_ROWS);
  if (!read.ok) {
    return kernel.ok({
      available: false,
      reason: read.reason,
      entries: [],
      total: 0,
      skipped: 0,
      observedAt: new Date().toISOString(),
    });
  }

  const KINDS = ['sent', 'skipped', 'turn-start', 'undelivered'];
  const rows = [...read.rows].reverse();
  const filtered = kind && KINDS.includes(kind) ? rows.filter((row) => row.kind === kind) : rows;

  return kernel.ok({
    available: true,
    reason: '',
    kind: kind && KINDS.includes(kind) ? kind : '',
    kinds: KINDS,
    window: MAX_ROWS,
    total: read.total,
    returned: filtered.length,
    skipped: read.skipped,
    entries: filtered.map((row) => ({
      at: numberOrNull(row?.at),
      kind: String(row?.kind ?? ''),
      room: String(row?.room ?? ''),
      mid: numberOrNull(row?.mid),
      phase: String(row?.phase ?? ''),
      ok: row?.ok === undefined ? null : row.ok === true,
      chars: numberOrNull(row?.chars),
      // 账本里的 `preview` 已经是 60 字预览；`reason` 是门控/超时的理由码。
      preview: String(row?.preview ?? ''),
      reason: String(row?.reason ?? ''),
      segment: numberOrNull(row?.segment),
      of: numberOrNull(row?.of),
      error: String(row?.error ?? ''),
    })),
    observedAt: new Date().toISOString(),
  });
}
