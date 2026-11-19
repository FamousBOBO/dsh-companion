// 探针：把 VoceChat 频道历史的**真实字段形状**固化下来。
//
// 为什么必须做这一步（而不是照 webhook 的形状猜）：
//   入站事件的形状有留证（`vocechat/evidence/webhook-raw.jsonl`），但那是 **SSE/webhook 帧**，
//   形如 `{mid, from_uid, target:{gid}, detail:{content}}`。而 `GET /api/group/{gid}/history`
//   是另一个端点，实测只确认了「200 且返回数组、最新在前」，**单条记录的字段名从来没有留证**。
//   字段名猜错的表现是「上下文永远是空的」——与「本来就没有历史」在日志里长得一模一样，
//   属于最难查的那一类故障。所以先用一个探针把这件事变成事实。
//
// 输出纪律：
//   - 只落**字段名与类型**，正文截断到 12 字。历史原文不进证据文件。
//   - 落盘位置 `D:\DSH\vocechat\evidence\history-shape-<日期>.json`。
//   - 凭据不经手：复用传输插件的 `auth.mjs`（它按 device 从数据库取 refresh_token，
//     并且续期是单例），探针只用 `auth.token()`。
//
// 用法：
//   node scripts/probe-history.mjs            # 默认 gid=1, limit=5
//   node scripts/probe-history.mjs 1 20       # 显式 gid 与 limit

import fs from 'node:fs';
import path from 'node:path';

const TRANSPORT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..', '..', 'dsh-channel-vocechat',
);

const BASE = process.env.VOICECHAT_BASE_URL || 'http://127.0.0.1:3009';
const UID = Number(process.env.VOICECHAT_UID || 4) || 4;
const DEVICE = process.env.VOICECHAT_DEVICE || 'dsh-companion';
const DB = process.env.VOICECHAT_DB || 'D:/DSH/vocechat/vocechat-data/db/db.sqlite';
const EVIDENCE = process.env.VOICECHAT_EVIDENCE_DIR || 'D:/DSH/vocechat/evidence';

const gid = Number(process.argv[2] ?? 1) || 1;
const limit = Number(process.argv[3] ?? 5) || 5;

/** `a` / `1` → 'number' etc. Only the type, never the value. */
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Field names + types of a flat object, one level of nesting expanded. */
function shapeOf(value, prefix = '', depth = 0) {
  const out = [];
  if (value === null || typeof value !== 'object') return out;
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    out.push({ field: name, type: typeOf(item) });
    // One nesting level is enough: `detail`, `properties`, `target` are the interesting ones.
    if (depth < 1 && item && typeof item === 'object' && !Array.isArray(item)) {
      out.push(...shapeOf(item, name, depth + 1));
    }
  }
  return out;
}

function preview(value) {
  const text = typeof value === 'string' ? value : '';
  if (text === '') return null;
  return text.length <= 12 ? text : `${text.slice(0, 12)}…(${text.length})`;
}

async function main() {
  const { createAuth } = await import(`file:///${path.join(TRANSPORT, 'auth.mjs').replace(/\\/g, '/')}`);
  const auth = createAuth({
    baseUrl: BASE,
    uid: UID,
    deviceName: DEVICE,
    dbFile: DB,
    log: line => console.log(`[auth] ${line}`),
  });

  const token = await auth.token();
  if (!token) throw new Error('拿不到 access token');

  const url = `${BASE}/api/group/${gid}/history?limit=${limit}`;
  const response = await fetch(url, { headers: { 'x-api-key': token } });
  const body = await response.text();

  let parsed;
  let parseError = null;
  try { parsed = JSON.parse(body); } catch (error) { parseError = String(error?.message ?? error); }

  const rows = Array.isArray(parsed) ? parsed : [];
  const shape = rows.length > 0 ? shapeOf(rows[0]) : [];

  // Union of fields across every returned row: a field present in only one row would otherwise
  // look absent, and that difference decides whether the mapper can rely on it.
  const union = new Map();
  for (const row of rows) {
    for (const item of shapeOf(row)) {
      // 首次出现的字段要**先插进表再改它**：`Map.set` 的返回值不是可用的句柄，
      // 而 `get` 在这一行之前还是 undefined —— 直接 `seen.types.add()` 会 TypeError。
      let entry = union.get(item.field);
      if (!entry) {
        entry = { field: item.field, types: new Set(), rows: 0 };
        union.set(item.field, entry);
      }
      entry.types.add(item.type);
      entry.rows += 1;
    }
  }
  const unionRows = [...union.values()].map(item => ({
    field: item.field,
    types: [...item.types],
    presentInRows: item.rows,
  }));

  const evidence = {
    at: new Date().toISOString(),
    base: BASE,
    gid,
    limit,
    uid: UID,
    device: DEVICE,
    status: response.status,
    count: rows.length,
    parseError,
    // 字段名与类型是这次探针的唯一目的；正文只留 12 字，用来确认哪个字段真的是正文。
    fieldsOfFirstRow: shape,
    fieldUnion: unionRows,
    mids: rows.map(row => row?.mid ?? null),
    previews: rows.slice(0, 3).map(row => {
      const guess = row?.content ?? row?.detail?.content ?? null;
      return { mid: row?.mid ?? null, contentPreview: preview(guess) };
    }),
  };

  fs.mkdirSync(EVIDENCE, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const file = path.join(EVIDENCE, `history-shape-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);

  console.log(`status=${response.status} rows=${rows.length}`);
  console.log('--- field union (field | types | presentInRows) ---');
  for (const item of unionRows) console.log(`${item.field} | ${item.types.join('|')} | ${item.presentInRows}`);
  console.log('--- mids ---');
  console.log(JSON.stringify(evidence.mids));
  console.log(`evidence → ${file}`);
  if (response.status !== 200) {
    console.log('--- body (first 300 chars) ---');
    console.log(body.slice(0, 300));
  }
}

main().catch(error => {
  console.error(String(error?.stack ?? error).slice(0, 800));
  process.exitCode = 1;
});
