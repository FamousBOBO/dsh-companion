/**
 * Expression management API — mounted at the TOP LEVEL on purpose.
 *
 * Why a separate mount (same reason as `companion-media/http.mjs`): the expression plugin itself
 * lives inside the agent preset, and preset plugins get an isolate realm. Their `connection`
 * service is a private instance, so routes registered from inside the preset report success and
 * still 404 on the web server. A bundle patch runs at application level, which is the only context
 * where `connection.fetch.register` is accepted.
 *
 * What this file owns:
 *   - builds the facade `src/studio.mjs` talks to, over the **same on-disk config and database**
 *     the tools use (single source of truth: `config.mjs` re-reads the file every time, so there is
 *     no cached copy to drift);
 *   - registers the route table from `src/studio.mjs`, by path, with `effect:false`;
 *   - reports 「未启用」 when the module is off instead of 500 or 404.
 *
 * Nothing here sends a message. `POST /simulate` evaluates a decision and returns the plan that
 * *would* have been produced; the delivery path lives in `src/delivery.mjs` and is only reachable
 * from the tools, never from this HTTP surface.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createExpressionHandlers } from './src/studio.mjs';
import { ENABLE_SNIPPET, pageDescriptor } from './src/ui-page.mjs';
import { loadConfig, saveConfig, normalizeConfig, DEFAULT_CONFIG } from './src/config.mjs';
import { expressionPaths } from './src/paths.mjs';
import { openExpressionDb } from './src/db.mjs';
import { createLibrary } from './src/library.mjs';
import { describeScope, CURATED_PUBLIC, groupScope } from './src/scopes.mjs';
import { contextFromDraft, fromLibrary, retrieve } from './src/retrieval.mjs';
import { decide } from './src/decision.mjs';
import { plan as buildPlan } from './src/planner.mjs';
import { feedbackRows, feedbackScoreOf, feedbackSummary, isSuppressed } from './src/feedback.mjs';

export const name = 'companion-expression-http';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const SUITE_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');

/** 套件级闸门：`modules.expression`（环境变量优先，其次 config/suite.json，最后默认关）。 */
function moduleEnabled() {
  const fromEnv = String(process.env.DSH_COMPANION_MODULES_EXPRESSION ?? '').trim().toLowerCase();
  if (fromEnv) return ['1', 'true', 'yes', 'on'].includes(fromEnv);
  try {
    const suite = JSON.parse(fs.readFileSync(path.join(SUITE_ROOT, 'config', 'suite.json'), 'utf8').replace(/^\uFEFF/, ''));
    const value = suite?.modules?.expression;
    if (value === true) return true;
    if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  } catch {
    /* 没有 suite.json 时按默认「关」处理 */
  }
  return false;
}

/** QQ 通道是否在线。拿不到就是 `null`（页面会写「尚未接入」，不猜）。 */
function channelLookup(ctx) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('qqConnection') : null;
    if (service && typeof service.status === 'function') {
      const status = service.status();
      if (status && typeof status.connected === 'boolean') return status.connected;
    }
  } catch {
    /* 拿不到就按「未知」 */
  }
  return null;
}

/** 稀疏深合并：页面提交的 patch 只带改动字段，没发的段原样保留。 */
export function mergePatch(base, patch) {
  const target = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null || value === undefined) continue;
    const current = target[key];
    if (value && typeof value === 'object' && !Array.isArray(value)
      && current && typeof current === 'object' && !Array.isArray(current)) {
      target[key] = mergePatch(current, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

const withLabels = rows => rows.map(row => ({ ...row, label: describeScope(row.scope), describe: describeScope(row.scope) }));

/**
 * The facade `src/studio.mjs` talks to.
 *
 * Every method returns `{ ok, ... }` and never throws: a broken library degrades into a readable
 * answer, not a 500 on a page the operator can still open.
 */
export function createService({ dataDir, paths, db, stageRoot, log, ctx }) {
  const counters = { lastError: null };
  const note = (error) => {
    counters.lastError = String(error?.message ?? error).slice(0, 240);
    try { log?.({ event: 'studio-error', message: counters.lastError }); } catch { /* logging must not throw */ }
  };
  const library = (() => {
    try {
      return createLibrary({ db, assetsDir: paths.assets });
    } catch (error) {
      note(error);
      return null;
    }
  })();
  const configBundle = () => {
    const loaded = loadConfig({ file: paths.configFile, dataRoot: dataDir });
    return {
      config: loaded.config,
      warnings: loaded.warnings,
      exists: loaded.exists,
      created: loaded.created,
      file: paths.configFile,
    };
  };
  const statusOf = (extras) => ({
    moduleEnabled: true,
    configExists: extras.exists,
    channelConnected: channelLookup(ctx),
    configFile: extras.file,
    paths: { assets: paths.assets, quarantine: paths.quarantine, stageRoot },
    warnings: extras.warnings,
    http: extras.http,
  });
  const unavailable = what => ({
    ok: false,
    error: { code: 'expression-library-unavailable', message: `图库还没接上：${what}不可用。配置与授权不受影响。` },
  });

  /** 每张图的可见性行 → 人可以读的 scope 标签（私聊 scope 是加盐哈希，不回推 QQ 号）。 */
  const visibilityLabels = rows => withLabels(rows.map(row => ({ scope: String(row.scope), approval: String(row.approval) })));

  const cardOf = (assetId) => {
    try {
      return library?.getCard ? library.getCard(assetId) : null;
    } catch (error) {
      note(error);
      return null;
    }
  };

  const service = {
    dataRoot: dataDir,
    paths,
    status() {
      let stats = { assets: 0, sources: 0, deliveries: 0, feedback: 0 };
      let integrity = null;
      try {
        if (db) {
          stats = db.stats();
          integrity = db.integrity();
        }
      } catch (error) {
        note(error);
      }
      return {
        version: '0.1.0',
        dataDir,
        paths: { assets: paths.assets, quarantine: paths.quarantine, stageRoot },
        db: db ? { file: paths.dbFile, stats, integrity, journalMode: db.journalMode } : null,
        library: library ? library.stats() : null,
        lastError: counters.lastError,
      };
    },

    getConfig() {
      try {
        const loaded = configBundle();
        return {
          ok: true,
          config: loaded.config,
          exists: loaded.exists,
          configFile: loaded.file,
          stageRoot,
          warnings: loaded.warnings,
          status: statusOf(loaded),
        };
      } catch (error) {
        note(error);
        return { ok: false, error: { code: 'expression-config-failed', message: `读配置失败：${counters.lastError}` } };
      }
    },

    saveConfig(patch) {
      try {
        const loaded = configBundle();
        const merged = mergePatch(loaded.config, patch);
        const result = saveConfig({ file: paths.configFile, dataRoot: dataDir, raw: merged });
        if (result.ok === false) {
          return { ok: false, error: { code: 'expression-config-invalid', message: result.error } };
        }
        const reread = configBundle();
        return {
          ok: true,
          saved: true,
          config: reread.config,
          warnings: [...(result.warnings ?? []), ...reread.warnings],
          status: statusOf(reread),
        };
      } catch (error) {
        note(error);
        return { ok: false, error: { code: 'expression-config-failed', message: `保存配置失败：${counters.lastError}` } };
      }
    },

    listAssets(query) {
      if (!library) return unavailable('图库列表');
      try {
        const listed = library.listAssets(query);
        const items = listed.items.map((item) => {
          const visibility = visibilityLabels(item.visibility ?? []);
          const approved = visibility.find(row => row.approval === 'approved');
          return {
            assetId: String(item.assetId),
            assetSha: String(item.sha256 ?? ''),
            kind: String(item.kind ?? ''),
            mime: String(item.mime ?? ''),
            byteSize: Number(item.byteSize ?? 0),
            width: item.width ?? null,
            height: item.height ?? null,
            moderationState: String(item.moderationState ?? ''),
            createdAt: Number(item.createdAt ?? 0),
            literal: String(cardOf(item.assetId)?.literal ?? ''),
            scope: String(approved?.scope ?? visibility[0]?.scope ?? ''),
            scopeLabel: describeScope(approved?.scope ?? visibility[0]?.scope ?? ''),
            visibility,
          };
        });
        return { ok: true, total: listed.total, items };
      } catch (error) {
        note(error);
        return { ok: false, error: { code: 'expression-library-failed', message: `读图库失败：${counters.lastError}` } };
      }
    },

    getAsset(assetId) {
      if (!library) return unavailable('素材详情');
      try {
        const detail = library.getAsset(assetId);
        if (!detail) return { ok: false, error: { code: 'expression-not-found', message: '没有这个素材。' } };
        const sources = (detail.sources ?? []).map(row => ({
          scope: String(row.originScope ?? ''),
          firstSeen: row.firstSeen ?? null,
          lastSeen: row.lastSeen ?? null,
          consentRef: row.consentRef ?? null,
        }));
        const deliveries = db.all(
          'SELECT plan_id, part_index, scope, status, reason_code, at FROM deliveries WHERE asset_id = ? ORDER BY at DESC LIMIT 20',
          [String(assetId)],
        ).map(row => ({
          planId: String(row.plan_id),
          partIndex: Number(row.part_index),
          scope: String(row.scope),
          scopeLabel: describeScope(String(row.scope)),
          status: String(row.status),
          reasonCode: row.reason_code ? String(row.reason_code) : '',
          at: Number(row.at),
        }));
        const feedback = feedbackRows({ db, assetId: String(assetId) }).slice(0, 20).map(row => ({
          id: String(row.id ?? ''),
          signal: String(row.signal ?? ''),
          note: String(row.note ?? ''),
          at: Number(row.at ?? 0),
        }));
        return {
          ok: true,
          asset: {
            assetId: String(detail.assetId),
            kind: String(detail.kind ?? ''),
            mime: String(detail.mime ?? ''),
            byteSize: Number(detail.byteSize ?? 0),
            width: detail.width ?? null,
            height: detail.height ?? null,
            moderationState: String(detail.moderationState ?? ''),
            createdAt: Number(detail.createdAt ?? 0),
          },
          card: detail.card ?? null,
          visibility: visibilityLabels(detail.visibility ?? []),
          sources,
          deliveries,
          feedback: feedback.length ? feedback : feedbackRows({ db, assetId: String(assetId), scope: 'quarantine' }).slice(0, 20),
        };
      } catch (error) {
        note(error);
        return { ok: false, error: { code: 'expression-library-failed', message: `读素材失败：${counters.lastError}` } };
      }
    },

    /**
     * 六个显式动作。每一个都**只改库**，不触发任何投递：
     *   approve        → 该素材每个作用域的可见性改成 approved（+ moderation_state）
     *   resend-review  → 回到 review（素材仍在库，只是不可发送）
     *   quarantine     → 可见性 quarantined，素材移出可检索范围
     *   disable        → 可见性 disabled（保留素材，永不发送）
     *   delete         → 走 library.deleteAsset（写 delete_audit、删文件）
     *   edit-card      → 走 library.upsertCard（顺手重建 FTS）
     */
    assetAction({ action, assetId, card, note: operatorNote }) {
      if (!library) return unavailable('素材动作');
      const id = String(assetId ?? '');
      try {
        if (action === 'delete') {
          const result = library.deleteAsset({ assetId: id, reason: String(operatorNote || 'studio-delete').slice(0, 200) });
          if (result.ok === false) return { ok: false, error: { code: 'expression-action-failed', message: result.message } };
          log?.({ event: 'asset-deleted', assetId: id });
          return { ok: true, assetId: id, deleted: true, removedFile: result.removedFile === true };
        }
        if (action === 'edit-card') {
          const result = library.upsertCard(id, card ?? {});
          if (result.ok === false) return { ok: false, error: { code: 'expression-action-failed', message: result.message } };
          return { ok: true, assetId: id, cardEdited: true };
        }
        const detail = library.getAsset(id);
        if (!detail) return { ok: false, error: { code: 'expression-not-found', message: '没有这个素材。' } };
        const approval = { approve: 'approved', 'resend-review': 'review', quarantine: 'quarantined', disable: 'disabled' }[action];
        const moderation = { approve: 'approved', 'resend-review': 'review', quarantine: 'quarantined', disable: 'disabled' }[action];
        if (!approval) return { ok: false, error: { code: 'expression-bad-input', message: `未知动作：${action}` } };
        const scopes = (detail.visibility ?? []).map(row => String(row.scope));
        // 没有任何可见性行（例如刚入库、来源尚未登记）：补一条公共精选之外的占位会让权限凭空变宽，
        // 所以这里如实拒绝，并说明该修哪一层。
        if (!scopes.length) {
          return {
            ok: false,
            error: { code: 'expression-action-failed', message: '这个素材还没有作用域记录，先在收集阶段登记来源再审核。' },
          };
        }
        for (const scope of scopes) library.setVisibility({ assetId: id, scope, approval });
        db.run('UPDATE assets SET moderation_state = ? WHERE id = ?', [String(moderation), id]);
        log?.({ event: `asset-${action}`, assetId: id, scopes: scopes.length });
        return { ok: true, assetId: id, action, moderationState: moderation, scopes: scopes.length };
      } catch (error) {
        note(error);
        return { ok: false, error: { code: 'expression-action-failed', message: `动作没有完成：${counters.lastError}` } };
      }
    },

    /**
     * 缩略图字节：**只按 assetId**。路径来自库里的 `file_path`，读之前与读之后都不改它；
     * `studio.mjs` 会再对返回的 `filePath` 做 `realpath` 校验。
     */
    thumbBytes(assetId, options) {
      if (!db) return unavailable('缩略图');
      try {
        const row = db.get('SELECT id, file_path, mime, moderation_state FROM assets WHERE id = ?', [String(assetId)]);
        if (!row) return { ok: false, error: { code: 'expression-not-found', message: '没有这个素材。' } };
        const quarantined = String(row.moderation_state) === 'quarantined';
        if (quarantined && options?.allowQuarantine !== true) {
          return { ok: false, error: { code: 'quarantined', message: '这个素材在隔离区。' } };
        }
        const filePath = String(row.file_path ?? '');
        if (!filePath) return { ok: false, error: { code: 'expression-not-found', message: '这个素材没有文件记录。' } };
        let bytes;
        try {
          bytes = fs.readFileSync(filePath);
        } catch {
          return { ok: false, error: { code: 'expression-not-found', message: '缩略图文件已不在磁盘上（可能已被清理或删除）。' } };
        }
        return { ok: true, bytes, mime: String(row.mime ?? ''), filePath };
      } catch (error) {
        note(error);
        return { ok: false, error: { code: 'expression-thumb-failed', message: `读缩略图失败：${counters.lastError}` } };
      }
    },

    listSources() {
      try {
        const { config } = configBundle();
        const groups = (config.capture.groups ?? []).map(entry => ({
          scope: groupScope(entry.chatId),
          kind: 'group',
          chatId: Number(entry.chatId),
          granted: true,
          capture: entry.capture === true,
          store: entry.store === true,
          use: entry.use === true,
        }));
        const peers = (config.capture.peers ?? []).map((entry, index) => ({
          // 对端的 scope 是加盐哈希，这里没有盐也不该有：只给「已授权的第几个对端」。
          scope: `peer:${index + 1}`,
          kind: 'peer',
          chatId: Number(entry.chatId),
          granted: entry.approved === true,
        }));
        const reserved = [{ scope: CURATED_PUBLIC, kind: 'curated', granted: config.privacy.crossRoomReuse === true, note: '跨房间复用' }];
        let counts = {};
        try {
          if (db) {
            counts = Object.fromEntries(db.all('SELECT origin_scope AS scope, count(*) AS assets FROM asset_sources GROUP BY origin_scope')
              .map(row => [String(row.scope), Number(row.assets)]));
          }
        } catch (error) {
          note(error);
        }
        const items = withLabels([...groups, ...peers, ...reserved].map(row => ({
          ...row,
          assets: Number(counts[row.scope] ?? 0),
        })));
        return { ok: true, items, total: items.length };
      } catch (error) {
        note(error);
        return { ok: false, error: { code: 'expression-sources-failed', message: `读来源失败：${counters.lastError}` } };
      }
    },

    grantScope({ kind, chatId, granted, flags, note: operatorNote }) {
      try {
        const { config } = configBundle();
        const next = normalizeConfig(config).config;
        if (kind === 'group') {
          const list = next.capture.groups.filter(entry => Number(entry.chatId) !== Number(chatId));
          if (granted) {
            list.push({
              chatId: Number(chatId),
              capture: flags?.capture === true,
              store: flags?.store === true,
              use: flags?.use === true,
            });
          }
          next.capture.groups = list;
        } else {
          const list = next.capture.peers.filter(entry => Number(entry.chatId) !== Number(chatId));
          if (granted) list.push({ chatId: Number(chatId), approved: true });
          next.capture.peers = list;
        }
        const result = saveConfig({ file: paths.configFile, dataRoot: dataDir, raw: next });
        if (result.ok === false) return { ok: false, error: { code: 'expression-config-invalid', message: result.error } };
        // 撤销授权时把该作用域在库里的可见性一起改成 revoked（写 asset_revocations），
        // 但默认**不删**素材文件：删不删由 privacy.deleteOnRevocation 与操作者的显式动作决定。
        let revoked = 0;
        if (!granted && kind === 'group' && library) {
          try { revoked = library.revokeScope({ scope: groupScope(chatId), reason: String(operatorNote || 'studio-revoke').slice(0, 200) }).revoked ?? 0; } catch (error) { note(error); }
        }
        return {
          ok: true,
          granted,
          kind,
          chatId,
          revoked,
          note: granted
            ? '授权已保存；下一次收到图片才会开始收集。'
            : `授权已撤销，库里 ${revoked} 个作用域行标为 revoked。素材文件不会自动删除（privacy.deleteOnRevocation 为 true 时才在清理时删）。`,
          warnings: result.warnings ?? [],
        };
      } catch (error) {
        note(error);
        return { ok: false, error: { code: 'expression-grant-failed', message: `授权没有保存：${counters.lastError}` } };
      }
    },

    listDeliveries({ limit = 50, scope, status } = {}) {
      try {
        if (!db) return { ok: true, items: [], total: 0, note: '数据库还没打开，没有投递记录。' };
        const where = [];
        const params = [];
        if (scope) { where.push('scope = ?'); params.push(String(scope)); }
        if (status) { where.push('status = ?'); params.push(String(status)); }
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const rows = db.all(
          `SELECT plan_id, part_index, asset_id, scope, status, reason_code, at
             FROM deliveries ${clause} ORDER BY at DESC LIMIT ?`,
          [...params, Number(limit)],
        );
        const total = Number(db.get(`SELECT count(*) AS total FROM deliveries ${clause}`, params)?.total ?? rows.length);
        return {
          ok: true,
          total,
          items: rows.map(row => ({
            planId: String(row.plan_id),
            partIndex: Number(row.part_index),
            assetId: row.asset_id ? String(row.asset_id) : null,
            scope: String(row.scope),
            scopeLabel: describeScope(String(row.scope)),
            status: String(row.status),
            reasonCode: row.reason_code ? String(row.reason_code) : '',
            at: Number(row.at),
          })),
        };
      } catch (error) {
        note(error);
        return { ok: false, error: { code: 'expression-deliveries-failed', message: `读投递记录失败：${counters.lastError}` } };
      }
    },

    /**
     * 表达习惯指标。口径见 CONTRACT.md §5；**读不到的一律写 null**，页面显示「—」。
     * `abstain` / `context_fit` 没有落库（它们只在一次决策的返回值里），所以这里如实 null。
     */
    metrics({ windowHours = 168, scope } = {}) {
      try {
        if (!db) {
          return { ok: true, delivery: {}, feedback: {}, precision: null, repeat7d: 0, leak: null, p95: null, windowHours: Number(windowHours), unavailable: ['数据库还没打开，所有指标都读不到'] };
        }
        const since = Date.now() - Number(windowHours) * 3600_000;
        const scopeClause = scope ? ' AND scope = ?' : '';
        const params = scope ? [since, String(scope)] : [since];
        const byStatus = Object.fromEntries(
          db.all(`SELECT status, count(*) AS total FROM deliveries WHERE at >= ?${scopeClause} GROUP BY status`, params)
            .map(row => [String(row.status), Number(row.total)]),
        );
        const bySignal = Object.fromEntries(
          db.all(`SELECT signal, count(*) AS total FROM expression_feedback WHERE at >= ?${scopeClause === '' ? '' : ' AND scope = ?'} GROUP BY signal`,
            scope ? [since, String(scope)] : [since])
            .map(row => [String(row.signal), Number(row.total)]),
        );
        const confirmed = Number(byStatus.confirmed ?? 0);
        const unknown = Number(byStatus.unknown ?? 0);
        const failed = Number(byStatus.failed ?? 0);
        const sent = confirmed + unknown + failed;
        const praise = Number(bySignal.praise ?? 0);
        const reject = Number(bySignal.reject ?? 0);
        const judged = praise + reject;
        return {
          ok: true,
          windowHours: Number(windowHours),
          delivery: {
            confirmed, unknown, failed, total: sent,
            // 只有「有回执」的投递才算确认；unknown 不重试、也不冒充成功。
            confirmRate: sent ? confirmed / sent : null,
          },
          feedback: { praise, reject, correction: Number(bySignal.correction ?? 0), bySignal },
          precision: judged ? praise / judged : null,
          precisionNote: judged
            ? '显式反馈里的好评占比（沉默不计入：没说话不等于不满意，也不等于满意）。'
            : '还没有任何显式反馈：precision 无法计算，显示「—」。',
          repeat7d: Number(db.get(
            `SELECT count(*) AS total FROM deliveries WHERE at >= ? AND status = 'confirmed'${scopeClause}`,
            [Date.now() - 7 * 86400_000, ...(scope ? [String(scope)] : [])],
          )?.total ?? 0),
          // leak 没有落库字段：没有数据就是 null（页面显示「—」），绝不画 0。
          leak: null,
          leakNote: '这个库没有记录「不该发却发出去了」的独立计数：leak 显示「—」表示无从判断，不是 0。',
          abstain: null,
          abstainNote: 'abstain 只出现在决策返回值里，不落库：这里显示「—」，不估算。',
          context_fit: null,
          contextFitNote: 'context_fit 没有落库字段：显示「—」，不估算。',
          p95: null,
          p95Ms: null,
          p95Note: '投递没有记录耗时，p95 无法计算（不估算）。',
          unavailable: [],
        };
      } catch (error) {
        note(error);
        return { ok: false, error: { code: 'expression-metrics-failed', message: `读指标失败：${counters.lastError}` } };
      }
    },

    /**
     * 自然度实验室：**只读**。
     *
     * 返回两份决策：`decision`（按当前配置的口径）与 `decisionIfEnabled`（假设投递总闸打开）。
     * 后者是页面真正想看的内容（"这段话会不会配一张图"），但它明确标为假设；两者都不会发送。
     */
    simulate(input) {
      if (!db || !library) return unavailable('检索与决策');
      try {
        const { config } = configBundle();
        const isGroup = input.isGroup === true;
        const target = String(input.target ?? '').trim();
        const chatId = Number(target);
        const usable = [];
        if (isGroup && Number.isSafeInteger(chatId) && chatId > 0) usable.push(groupScope(chatId));
        else {
          // 私聊场景：lab 用「主人私聊已通过的那些作用域」。拿不到盐也算不出具体 scope，
          // 所以直接把库里所有非群作用域里已通过的那些当作可用集合，并在返回里说明。
          const rows = db.all("SELECT DISTINCT scope FROM asset_visibility WHERE approval = 'approved' AND scope NOT LIKE 'group:%'");
          for (const row of rows) usable.push(String(row.scope));
        }
        const reason = retrieve({
          library: fromLibrary(library, { poolLimit: Number(config.retrieval?.poolLimit ?? 60) }),
          usable,
          scope: usable[0] ?? '',
          // 实验室必须按真实回合的同一套上下文推导：否则页面上的「会不会发」与线上判的
          // 不是同一件事，这个数字就没有意义（也就是一句真话都没有）。
          context: contextFromDraft(input.text),
          limit: Number(input.limit ?? 5),
          // 实验室要把阈值的效果**展示出来**，所以这里不提前按 minFitScore 剪掉候选：
          // 让 decision 用配置里的阈值给出 `no-compatible-expression`（cause=all-below-fit-threshold），
          // 页面才说得清「为什么这次不发」。
          minFitScore: 0,
          poolLimit: Number(config.retrieval?.poolLimit ?? 60),
          now: Date.now(),
          // 显式拒绝过的素材不进候选。`retrieval.judgeCandidate` 只传 `{assetId, scope}`，
          // 所以 db 用闭包里那一份（同一个连接，不存在第二个 writer）。
          isSuppressed: ({ assetId: id, scope: candidateScope }) => {
            try {
              return isSuppressed({ db, scope: candidateScope, assetId: id });
            } catch {
              return false;
            }
          },
          // 正反馈/负反馈也参与打分（一次 reject 会降 0.4），口径与 feedback.mjs 一致。
          feedbackScore: ({ assetId: id, scope: candidateScope }) => {
            try {
              return feedbackScoreOf({ db, assetId: id, scope: candidateScope });
            } catch {
              return 0.5;
            }
          },
        });
        const candidates = Array.isArray(reason.candidates) ? reason.candidates : [];
        const base = {
          db,
          config,
          target: { kind: isGroup ? 'group' : 'dm', id: target },
          scope: usable[0] ?? '',
          draft: String(input.text ?? ''),
          now: Date.now(),
        };
        const live = decide({ ...base, candidates });
        const hypothetical = decide({
          ...base,
          config: { ...config, delivery: { ...config.delivery, enabled: true } },
          candidates,
        });
        const planned = buildPlan({
          turnId: `simulate-${Date.now()}`,
          target: { kind: isGroup ? 'group' : 'dm', id: target },
          decision: hypothetical,
          draft: String(input.text ?? '').slice(0, 400),
          now: Date.now(),
        });
        return {
          ok: true,
          sending: false,
          decision: live,
          decisionIfEnabled: hypothetical,
          candidates,
          plan: planned,
          retrieval: {
            reasonCode: reason.reasonCode, filtered: reason.filtered, matched: reason.matched,
            warnings: reason.warnings,
            // 逐阶段数字（召回路、门槛、冲突、低分项）只给实验室/开发者看；模型侧不读这里。
            diagnostics: reason.diagnostics ?? null,
          },
          scopeNote: isGroup
            ? (usable.length ? `按群作用域 ${usable[0]} 模拟。` : '没有给出群号：这次模拟没有可用的群作用域，候选只会是空的。')
            : '私聊场景用「库里已通过的非群作用域」当可用集合；页面不会因此构造任何具体私聊 scope。',
          hypotheticalNote: 'decisionIfEnabled 假设投递总闸打开，只用于评估自然度；真正的 delivery.enabled 仍然是关着就绝不发送。',
        };
      } catch (error) {
        note(error);
        return { ok: false, error: { code: 'expression-simulate-failed', message: `模拟没有完成：${counters.lastError}` } };
      }
    },
  };

  if (db && !configBundle().exists) {
    try { log?.({ event: 'config-created', file: paths.configFile }); } catch { /* ignore */ }
  }
  return service;
}

function buildContext(ctx) {
  const paths = expressionPaths({ moduleUrl: import.meta.url });
  const dataDir = paths.dataRoot;
  const logDir = path.join(paths.root, 'logs');
  const log = (record) => {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, 'expression-events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
    } catch {
      /* logging must never take the plugin down */
    }
  };
  let db = null;
  try {
    fs.mkdirSync(paths.root, { recursive: true });
    db = openExpressionDb({ file: paths.dbFile });
  } catch (error) {
    log({ event: 'db-open-failed', message: String(error?.message ?? error).slice(0, 240) });
  }
  const loaded = loadConfig({ file: paths.configFile, dataRoot: dataDir });
  const stage = String(loaded.config?.delivery?.stageRoot ?? DEFAULT_CONFIG.delivery.stageRoot);
  return { paths, dataDir, db, log, stageRoot: stage };
}

export async function apply(ctx) {
  if (!moduleEnabled()) {
    // 不注册任何路由：`未启用`是**页面自己**的判断（404 → 页面给出启用片段），比一个全程 503
    // 的假接口更容易理解。这里只在日志里说清为什么没挂。
    console.log('[companion-expression-http] 表情包模块未启用（modules.expression 不为 true），管理 API 未注册。');
    return undefined;
  }
  let built;
  try {
    built = buildContext(ctx);
  } catch (error) {
    console.log(`[companion-expression-http] 无法构建表情包服务：${error?.message ?? error}`);
    return undefined;
  }
  const { paths, dataDir, db, log, stageRoot } = built;
  const service = createService({ dataDir, paths, db, stageRoot, log, ctx });
  const handlers = createExpressionHandlers(service, { assetsRoot: paths.assets, quarantineRoot: paths.quarantine });

  // 等 `connection`：bundle 挂载时它常常还没提供，一次尝试就会落空。有界等待（≤5s）在 apply 里，
  // 这样 context 还是 active 的——在 inactive context 上注册会被宿主拒绝。
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined;
    if (connection && connection.fetch && typeof connection.fetch.register === 'function') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined;
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    log({ event: 'http-api-unavailable', reason: 'no-connection' });
    console.log('[companion-expression-http] connection 服务未就绪，管理 API 未注册（页面会说明未启用）。');
    return undefined;
  }

  // `effect:false` 是有意的：patch-inserted 的 context 上调 `ctx.effect` 会抛 "Invalid effect"，
  // 而「注册从没发生」远比「注册不随 fiber 回收」更糟。宿主按 path 去重，重复登记是覆盖不是叠加。
  const byPath = new Map();
  for (const key of Object.keys(handlers)) {
    const [method, routePath] = key.split(' ');
    const entry = byPath.get(routePath) ?? { path: routePath, methods: [], handlers: new Map() };
    entry.methods.push(method);
    entry.handlers.set(method, handlers[key]);
    byPath.set(routePath, entry);
  }
  let registered = 0;
  const failed = [];
  for (const entry of byPath.values()) {
    try {
      connection.fetch.register({
        path: entry.path,
        methods: entry.methods,
        requestBody: 'buffered',
        fetch: request => {
          const handler = entry.handlers.get(request.method);
          if (!handler) {
            return new Response(JSON.stringify({
              ok: false,
              error: { code: 'expression-method-not-allowed', message: `该路径只支持 ${entry.methods.join(' / ')}` },
            }), { status: 405, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
          }
          return handler(request);
        },
      });
      registered += 1;
    } catch (error) {
      // 一条路由出问题不能连带其它路由一起消失。
      failed.push({ path: entry.path, message: String(error?.message ?? error).slice(0, 200) });
    }
  }
  log({
    event: registered > 0 ? 'http-api-registered' : 'http-api-unavailable',
    how: 'top-level',
    registered,
    paths: [...byPath.keys()],
    failed,
  });
  // 数据库是进程级的：路由不随 fiber 回收（见上面 `effect:false` 的理由），所以库也跟着进程走。
  // 宿主支持 dispose 时仍挂一次关闭，避免热重载把旧 handle 留在内存里。
  try {
    if (typeof ctx?.on === 'function') {
      ctx.on('dispose', () => {
        try { db?.close(); } catch { /* 已经关了 */ }
      });
    }
  } catch {
    /* 宿主不支持这个事件：进程退出时由 OS 收尾 */
  }
  console.log(`[companion-expression-http] 已注册 ${registered} 条管理路由${failed.length ? `，${failed.length} 条失败` : ''}。`);
  // 返回 undefined：Cordis 把 apply 的返回值当成 effect 收集，一个普通对象会让它抛
  // "Invalid effect" 并丢掉整个插件——这正是「文件看着对、路由却不见了」的原因。
  return undefined;
}

/** 供诊断用：不建服务也能拿到同一份 descriptor 形状。 */
export const describePage = (config = normalizeConfig(DEFAULT_CONFIG).config, status = {}) => pageDescriptor(config, status);

export { createExpressionHandlers, ENABLE_SNIPPET, pageDescriptor, buildPlan, retrieve, decide, feedbackSummary };

export default { name, apply, createService, createExpressionHandlers };
