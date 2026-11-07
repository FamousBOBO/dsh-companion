/**
 * 图库：assets / asset_sources / asset_visibility / expression_cards / expression_fts 之上的读写层。
 * ① 按 sha256 物理去重：同字节只落一份文件，重复素材只追加来源行；可见性又是「每个来源一行」，
 * 所以去重永远不会把 A 的授权顺给 B。② 对外只给 assetId，只有投递层用的
 * `getFileForDelivery()`（已过硬门 + 哈希校验）才拿得到路径。③ 撤回与删除都留痕。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { inside } from './paths.mjs';
import { realpathInside, safeJoin } from './security.mjs';
import { APPROVALS, visibilityGate } from './scopes.mjs';

/** 素材允许的审核态（与 scopes.mjs 的 APPROVALS 同口径）。 */
export const MODERATION_STATES = APPROVALS;

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

export function sha256Of(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/** assetId 由内容哈希派生：同一字节永远同一个 id，去重不再需要额外索引。 */
export function assetIdFor(sha256) {
  return `ast_${String(sha256).slice(0, 20)}`;
}

/** 切词：`doc=true` 额外输出中文单字（入库用，让 unicode61 命中二字）；`doc=false` 只出二字与拉丁整词。 */
function tokenize(text, { doc }) {
  const source = String(text ?? '').slice(0, 4000);
  const out = [];
  let run = [];
  let word = '';
  const flushRun = () => {
    if (doc) out.push(...run);
    else if (run.length === 1) out.push(run[0]);
    for (let index = 0; index + 1 < run.length; index += 1) out.push(run[index] + run[index + 1]);
    run = [];
  };
  const flushWord = () => { if (word) out.push(word); word = ''; };
  for (const char of source) {
    if (CJK.test(char)) { flushWord(); run.push(char); continue; }
    flushRun();
    // 拉丁字母按「整词」入索引：按单字母切会让 "happy" 退化成 h/a/p/y，命中一片噪声。
    if (/[A-Za-z0-9_]/.test(char)) { word += char.toLowerCase(); continue; }
    flushWord();
  }
  flushRun();
  flushWord();
  return [...new Set(out.filter(token => token.length > 0))];
}

/** 入库文本：中文单字 + 二字 + 拉丁词，用空格连成 unicode61 能切开的形。 */
export function tokenizeForFts(text) {
  return tokenize(text, { doc: true }).join(' ');
}

/** 查询文本 → FTS5 表达式（纯 OR，短语加引号是唯一可靠的转义）。空串表示无可检索词。 */
export function buildFtsQuery(query) {
  return tokenize(query, { doc: false }).map(token => `"${token}"`).join(' OR ');
}

/** 对外可见的素材视图：没有 file_path，也没有任何路径片段。 */
function publicAsset(row) {
  if (!row) return null;
  return {
    assetId: String(row.id), sha256: String(row.sha256), kind: String(row.kind), mime: String(row.mime),
    byteSize: Number(row.byte_size ?? 0), width: row.width ?? null, height: row.height ?? null,
    moderationState: String(row.moderation_state), createdAt: Number(row.created_at ?? 0),
  };
}

function listOf(text) {
  try {
    const value = JSON.parse(String(text ?? '[]'));
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

const CARD_LIST_FIELDS = [
  ['intents', 'intents_json'], ['emotions', 'emotions_json'], ['tone', 'tone_json'],
  ['rhetoric', 'rhetoric_json'], ['scenes', 'scenes_json'], ['avoidWhen', 'avoid_json'],
];

function cardFromRow(row) {
  if (!row) return null;
  const card = {
    assetId: String(row.asset_id),
    literal: String(row.literal ?? ''),
    ocr: String(row.ocr ?? ''),
    aggression: row.aggression ?? null,
    confidence: row.confidence ?? null,
    modelVersion: String(row.model_version ?? ''),
    updatedAt: Number(row.updated_at ?? 0),
  };
  for (const [field, column] of CARD_LIST_FIELDS) card[field] = listOf(row[column]);
  return card;
}

/** 六列表字段统一成 JSON 文本，避免 upsert 里散落十三个参数。 */
function cardColumns(card) {
  const list = value => JSON.stringify(Array.isArray(value) ? value : []);
  return {
    literal: String(card.literal ?? ''),
    ocr: String(card.ocr ?? ''),
    intents: list(card.intents),
    emotions: list(card.emotions),
    tone: list(card.tone),
    rhetoric: list(card.rhetoric),
    scenes: list(card.scenes),
    avoid: list(card.avoidWhen),
    aggression: card.aggression === undefined ? null : Number(card.aggression),
    confidence: card.confidence === undefined ? null : Number(card.confidence),
    modelVersion: String(card.modelVersion ?? ''),
  };
}

const CARD_UPSERT_SQL = `INSERT INTO expression_cards
   (asset_id, literal, ocr, intents_json, emotions_json, tone_json, rhetoric_json, scenes_json,
    avoid_json, aggression, confidence, model_version, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(asset_id) DO UPDATE SET literal = excluded.literal, ocr = excluded.ocr,
     intents_json = excluded.intents_json, emotions_json = excluded.emotions_json,
     tone_json = excluded.tone_json, rhetoric_json = excluded.rhetoric_json,
     scenes_json = excluded.scenes_json, avoid_json = excluded.avoid_json,
     aggression = excluded.aggression, confidence = excluded.confidence,
     model_version = excluded.model_version, updated_at = excluded.updated_at`;

/**
 * 图库句柄。
 * @param {{db: object, assetsDir: string, now?: () => number}} options
 */
export function createLibrary({ db, assetsDir, now = () => Date.now() } = {}) {
  if (!db || typeof db.run !== 'function') throw new Error('createLibrary 需要 openExpressionDb 返回的句柄。');
  if (typeof assetsDir !== 'string' || !assetsDir.trim()) throw new Error('createLibrary 需要素材目录。');
  const root = path.resolve(assetsDir);
  const clock = () => Number(now()) || Date.now();

  /** 写一份素材文件（<sha 前两位>/<sha><ext>）；同内容已存在就直接复用，不重写。 */
  function writeBytes(bytes, sha256, ext) {
    const folder = path.join(root, sha256.slice(0, 2));
    const target = safeJoin(folder, `${sha256}${ext}`);
    if (fs.existsSync(target)) return target;
    fs.mkdirSync(folder, { recursive: true });
    const temp = path.join(folder, `.${sha256}.${process.pid}.tmp`);
    fs.writeFileSync(temp, Buffer.from(bytes));
    fs.renameSync(temp, target);
    return target;
  }

  const assetExists = assetId => Boolean(db.get('SELECT id FROM assets WHERE id = ?', [String(assetId)]));

  function visibilityRows(assetId) {
    return db.all('SELECT scope, approval FROM asset_visibility WHERE asset_id = ?', [String(assetId)])
      .map(row => ({ scope: String(row.scope), approval: String(row.approval) }));
  }

  function sourcesOf(assetId) {
    return db.all('SELECT * FROM asset_sources WHERE asset_id = ?', [String(assetId)]).map(row => ({
      originScope: String(row.origin_scope),
      sourceMessageHash: row.source_message_hash ?? null,
      senderHash: row.sender_hash ?? null,
      consentRef: row.consent_ref ?? null,
      firstSeen: row.first_seen ?? null,
      lastSeen: row.last_seen ?? null,
    }));
  }

  function setVisibilityRow(assetId, scope, approval) {
    if (!APPROVALS.includes(approval)) throw new Error(`未知审核态：${String(approval)}`);
    db.run(
      `INSERT INTO asset_visibility (asset_id, scope, approval) VALUES (?, ?, ?)
         ON CONFLICT(asset_id, scope) DO UPDATE SET approval = excluded.approval`,
      [String(assetId), String(scope), String(approval)],
    );
    return { assetId: String(assetId), scope: String(scope), approval: String(approval) };
  }

  /** 记一条来源；同一 (asset, scope, messageHash) 只更新 last_seen，不重复插入。 */
  function attachSource(assetId, source = {}) {
    const at = clock();
    const originScope = String(source.originScope ?? '').trim();
    if (!originScope) throw new Error('来源缺少 originScope（来源必须可追溯到具体作用域）。');
    db.run(
      `INSERT INTO asset_sources (asset_id, origin_scope, source_message_hash, sender_hash, consent_ref, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(asset_id, origin_scope, source_message_hash)
         DO UPDATE SET last_seen = excluded.last_seen`,
      [String(assetId), originScope,
        source.sourceMessageHash === undefined ? null : String(source.sourceMessageHash),
        source.senderHash === undefined ? null : String(source.senderHash),
        source.consentRef === undefined ? null : String(source.consentRef), at, at],
    );
  }

  /**
   * 收一份素材（字节必须已过 `security.validateImage`，本层只信调用方的判型结果）。
   * @returns {{ok: true, assetId: string, sha256: string, deduped: boolean, createdFile: boolean}
   *   | {ok: false, reasonCode: string, message: string}}
   */
  function receive({ bytes, format, width = null, height = null, moderationState = 'review' } = {}) {
    if (!bytes || Buffer.from(bytes).length === 0) return { ok: false, reasonCode: 'empty-bytes', message: '没有可入库的字节。' };
    if (!format || typeof format.ext !== 'string') return { ok: false, reasonCode: 'missing-format', message: '缺少字节判型结果。' };
    const buffer = Buffer.from(bytes);
    const sha256 = sha256Of(buffer);
    const assetId = assetIdFor(sha256);
    const existing = db.get('SELECT file_path FROM assets WHERE sha256 = ?', [sha256]);
    let createdFile = false;
    if (existing) {
      // 同一份字节可能被别人删过物理文件；这里补回，但它仍然只有一份。
      if (!fs.existsSync(String(existing.file_path))) { writeBytes(buffer, sha256, format.ext); createdFile = true; }
      return { ok: true, assetId, sha256, deduped: true, createdFile };
    }
    const filePath = writeBytes(buffer, sha256, format.ext);
    db.run(
      `INSERT INTO assets (id, sha256, phash, kind, mime, file_path, byte_size, width, height, moderation_state, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [assetId, sha256, String(format.kind), String(format.mime), filePath, buffer.length,
        width, height, String(moderationState), clock()],
    );
    return { ok: true, assetId, sha256, deduped: false, createdFile };
  }

  /** 收完之后挂来源与可见性，各自成行；先落文件再落权限，事务包权限部分。 */
  function register({ assetId, sources = [], visibility = [] } = {}) {
    const id = String(assetId ?? '');
    if (!assetExists(id)) return { ok: false, reasonCode: 'asset-missing', message: `素材 ${id} 不存在。` };
    db.tx(() => {
      for (const source of sources) attachSource(id, source);
      for (const row of visibility) setVisibilityRow(id, row.scope, row.approval);
    });
    return { ok: true, assetId: id, sources: sources.length, visibility: visibility.length };
  }

  function getCard(assetId) {
    return cardFromRow(db.get('SELECT * FROM expression_cards WHERE asset_id = ?', [String(assetId)]));
  }

  function getAsset(assetId) {
    const asset = publicAsset(db.get('SELECT * FROM assets WHERE id = ?', [String(assetId)]));
    if (!asset) return null;
    return { ...asset, visibility: visibilityRows(assetId), sources: sourcesOf(assetId), card: getCard(assetId) };
  }

  /** 写/更新语义卡，并把可检索文本重新灌进 FTS（FTS 行必须与卡一致）。 */
  function upsertCard(assetId, card = {}) {
    const id = String(assetId ?? '');
    if (!assetExists(id)) return { ok: false, reasonCode: 'asset-missing', message: `素材 ${id} 不存在。` };
    const columns = cardColumns(card);
    db.tx(() => {
      db.run(CARD_UPSERT_SQL, [id, columns.literal, columns.ocr, columns.intents, columns.emotions,
        columns.tone, columns.rhetoric, columns.scenes, columns.avoid, columns.aggression,
        columns.confidence, columns.modelVersion, clock()]);
      db.run('DELETE FROM expression_fts WHERE asset_id = ?', [id]);
      db.run(
        'INSERT INTO expression_fts (asset_id, literal, ocr, intents, scenes) VALUES (?, ?, ?, ?, ?)',
        [id, tokenizeForFts(columns.literal), tokenizeForFts(columns.ocr),
          tokenizeForFts(listOf(columns.intents).join(' ')), tokenizeForFts(listOf(columns.scenes).join(' '))],
      );
    });
    return { ok: true, assetId: id };
  }

  /** FTS5 检索 → assetId 列表（bm25 升序，相关度高的在前）。 */
  function search(query, { limit = 10 } = {}) {
    const expression = buildFtsQuery(query);
    if (!expression) return [];
    return db.all(
      'SELECT asset_id FROM expression_fts WHERE expression_fts MATCH ? ORDER BY bm25(expression_fts) LIMIT ?',
      [expression, Math.max(1, Math.min(50, Number(limit) || 10))],
    ).map(row => String(row.asset_id));
  }

  /** 列表（Studio 用）。过滤条件全部参数绑定，排序键走白名单。 */
  function listAssets({ query = '', scope = '', moderation = '', sort = 'newest', limit = 20, offset = 0 } = {}) {
    const take = Math.max(1, Math.min(200, Number(limit) || 20));
    const skip = Math.max(0, Number(offset) || 0);
    const where = [];
    const params = [];
    if (String(query ?? '').trim()) {
      const ids = search(query, { limit: take + skip });
      if (ids.length === 0) return { total: 0, items: [] };
      where.push(`id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    if (moderation) { where.push('moderation_state = ?'); params.push(String(moderation)); }
    if (scope) { where.push('id IN (SELECT asset_id FROM asset_visibility WHERE scope = ?)'); params.push(String(scope)); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(db.get(`SELECT count(*) AS total FROM assets ${clause}`, params)?.total ?? 0);
    const rows = db.all(
      `SELECT * FROM assets ${clause} ORDER BY created_at ${sort === 'oldest' ? 'asc' : 'desc'} LIMIT ? OFFSET ?`,
      [...params, take, skip],
    );
    return { total, items: rows.map(row => ({ ...publicAsset(row), visibility: visibilityRows(row.id) })) };
  }

  const getVisibility = assetId => visibilityRows(assetId);

  function setVisibility({ assetId, scope, approval } = {}) {
    const id = String(assetId ?? '');
    if (!assetExists(id)) return { ok: false, reasonCode: 'asset-missing', message: `素材 ${id} 不存在。` };
    if (!String(scope ?? '').trim()) return { ok: false, reasonCode: 'scope-empty', message: '必须指定作用域。' };
    try {
      return { ok: true, ...setVisibilityRow(id, scope, String(approval)) };
    } catch (error) {
      return { ok: false, reasonCode: 'approval-invalid', message: String(error?.message ?? error) };
    }
  }

  /** 作用域硬门：retrieval / delivery 都从这里过，不允许任何计分绕过。 */
  const gateFor = (assetId, usable) => visibilityGate({ visibility: visibilityRows(assetId), usable });

  /**
   * **仅供投递层**：过硬门 → 路径在库目录内 → 真实路径存在 → sha256 相符，才返回路径。
   */
  function getFileForDelivery({ assetId, usable, verifyHash = true } = {}) {
    const gate = gateFor(assetId, usable);
    if (!gate.ok) return { ok: false, reasonCode: gate.reason, message: `素材 ${String(assetId)} 不在本次作用域内（${gate.reason}）。` };
    const row = db.get('SELECT * FROM assets WHERE id = ?', [String(assetId)]);
    if (!row) return { ok: false, reasonCode: 'asset-missing', message: '素材不存在。' };
    if (!inside(root, String(row.file_path))) return { ok: false, reasonCode: 'path-escape', message: '素材路径不在图库目录内。' };
    const real = realpathInside(root, String(row.file_path));
    if (!real.ok) return { ok: false, reasonCode: 'file-missing', message: '素材文件不在磁盘上（可能已被删除）。' };
    if (verifyHash) {
      let actual = '';
      try {
        actual = sha256Of(fs.readFileSync(real.path));
      } catch {
        return { ok: false, reasonCode: 'file-unreadable', message: '素材文件无法读取。' };
      }
      if (actual !== String(row.sha256)) return { ok: false, reasonCode: 'hash-mismatch', message: '素材内容与记录不符，已拒绝投递。' };
    }
    return { ok: true, path: real.path, sha256: String(row.sha256), mime: String(row.mime), kind: String(row.kind), scope: gate.scope };
  }

  /** 删除一份素材：写删除审计、清 FTS/卡/来源/可见性、删物理文件。 */
  function deleteAsset({ assetId, reason = '', scope = null } = {}) {
    const id = String(assetId ?? '');
    const row = db.get('SELECT file_path FROM assets WHERE id = ?', [id]);
    if (!row) return { ok: false, reasonCode: 'asset-missing', message: `素材 ${id} 不存在。` };
    let removedFile = false;
    try {
      db.tx(() => {
        for (const table of ['expression_fts', 'expression_cards', 'asset_visibility', 'asset_sources']) {
          db.run(`DELETE FROM ${table} WHERE asset_id = ?`, [id]);
        }
        db.run('DELETE FROM assets WHERE id = ?', [id]);
        db.run('INSERT INTO delete_audit (asset_id, scope, at, reason) VALUES (?, ?, ?, ?)',
          [id, scope === null ? null : String(scope), clock(), String(reason).slice(0, 200)]);
      });
      const filePath = String(row.file_path);
      if (inside(root, filePath) && fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
        removedFile = true;
      }
    } catch (error) {
      return { ok: false, reasonCode: 'delete-failed', message: String(error?.message ?? error).slice(0, 160) };
    }
    return { ok: true, assetId: id, removedFile };
  }

  /**
   * 撤销一个来源：写 `asset_revocations` 并把**该作用域**的可见性改成 `revoked`；其它作用域的行
   * 不动 —— 这正就是「物理去重但不共享权限」。
   */
  function revokeScope({ scope, reason = '' } = {}) {
    const text = String(scope ?? '').trim();
    if (!text) return { ok: false, reasonCode: 'scope-empty', message: '必须指定要撤销的作用域。' };
    const revoked = db.tx(() => {
      db.run('INSERT INTO asset_revocations (origin_scope, at, reason) VALUES (?, ?, ?)', [text, clock(), String(reason).slice(0, 200)]);
      return Number(db.run("UPDATE asset_visibility SET approval = 'revoked' WHERE scope = ? AND approval <> 'revoked'", [text])?.changes ?? 0);
    });
    return { ok: true, scope: text, revoked };
  }

  /** Studio / 统计用的一句话数字。 */
  function stats() {
    const count = table => Number(db.get(`SELECT count(*) AS total FROM ${table}`)?.total ?? 0);
    return {
      assets: count('assets'),
      sources: count('asset_sources'),
      cards: count('expression_cards'),
      quarantined: Number(db.get("SELECT count(*) AS total FROM assets WHERE moderation_state = 'quarantined'")?.total ?? 0),
      review: Number(db.get("SELECT count(*) AS total FROM assets WHERE moderation_state = 'review'")?.total ?? 0),
      approvals: Number(db.get("SELECT count(*) AS total FROM asset_visibility WHERE approval = 'approved'")?.total ?? 0),
    };
  }

  return {
    root, clock, receive, register, getAsset, getCard, upsertCard, search, listAssets,
    getVisibility, setVisibility, gateFor, getFileForDelivery, deleteAsset, revokeScope, stats,
  };
}

export default { createLibrary, sha256Of, assetIdFor, tokenizeForFts, buildFtsQuery, MODERATION_STATES };
