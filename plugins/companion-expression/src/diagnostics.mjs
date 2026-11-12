/**
 * 只读诊断面：回答「为什么这轮没发图 / 这个会话到底能不能发」。
 *
 * 三件事，且**全部只读**（不写库、不下载、不调模型、不发图）：
 *   1. 图库与审核态计数（已审核多少、待审多少、隔离多少、批准了多少条可见性）；
 *   2. 按**会话**算「当前可用素材数」——用与检索/投递同一个 `scopesFor` + 可见性硬门口径，
 *      而不是另写一套 SQL 语义；两者一旦分叉，「诊断说能发、实际发不出」就再也查不清；
 *   3. 最近一次候选/发图的**结果码**与 `message_id`（「有没有真的发出去」的唯一证据）。
 *
 * 输出里不含路径、URL、QQ 号、消息正文：作用域本来就是加盐哈希，这里也不解开它们。
 * 「读不出来」与「读到 0」是两件事，所以读失败时给 `null`，不给 0。
 */
import { scopesFor } from './scopes.mjs';

/** 审核态里「能发」的那一个（与 scopes.mjs 的 SENDABLE_APPROVALS 同口径）。 */
const SENDABLE = 'approved';

/** 最近一次事件里最多带多少字的消息（结果码之外的那一句人话）。 */
const MESSAGE_MAX = 160;

function text(value) {
  return String(value ?? '').slice(0, MESSAGE_MAX);
}

function stamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

/**
 * 建一个诊断句柄。
 *
 * @param {{db: object, library: object, config: object, salt: string,
 *   isOwnerFor: Function, events: object, clock?: Function}} input
 */
export function createExpressionDiagnostics({ db, library, config, salt, isOwnerFor, events, clock = () => Date.now() }) {
  if (!db || typeof db.all !== 'function') throw new Error('createExpressionDiagnostics 需要数据库句柄。');
  const readEvents = events ?? {};
  const ownerOf = typeof isOwnerFor === 'function' ? isOwnerFor : () => false;

  /** 一次 count 查询：读不出来给 `null`（调用方据此区分「0」与「不知道」）。 */
  const count = (sql, params = []) => {
    try {
      return Number(db.get(sql, params)?.total ?? 0);
    } catch {
      return null;
    }
  };

  /** 一个作用域里**此刻真的能发**的素材数：可见性批准 + 素材审核通过。 */
  const usableInScope = scope => count(
    `SELECT count(*) AS total FROM asset_visibility v
       JOIN assets a ON a.id = v.asset_id
      WHERE v.scope = ? AND v.approval = ? AND a.moderation_state = ?`,
    [String(scope), SENDABLE, SENDABLE],
  );

  /**
   * 一个会话目标（dm / group）的可用面。
   *
   * `reason` 与 `expression_candidates` 的 `reasonCode` 用同一套作用域判定
   * （`scopesFor`），所以「诊断说 group-use-off」时候选调用也一定是这个原因。
   */
  function targetOf({ kind = 'dm', chatId = 0, isOwner } = {}) {
    const id = Number(chatId) || 0;
    if (id <= 0) return { kind, chatId: 0, reason: 'chat-id-invalid', usableScopes: 0, usableAssets: 0 };
    let scopes;
    try {
      scopes = scopesFor({
        kind: kind === 'group' ? 'group' : 'dm',
        chatId: id,
        isOwner: isOwner === undefined ? ownerOf({ chatId: id, isGroup: kind === 'group' }) === true : isOwner === true,
        salt,
        config,
      });
    } catch (error) {
      return { kind, chatId: id, reason: `scope-failed:${text(error?.message ?? error)}`, usableScopes: 0, usableAssets: 0 };
    }
    if (scopes.usable.length === 0) {
      return {
        kind, chatId: id,
        reason: scopes.reason || 'no-usable-scope',
        usableScopes: 0, usableAssets: 0,
        // 采集与可用是两件事：这个群可能照样在收集素材，只是这一轮没有能发的。
        capture: scopes.capture === true,
        scopes: [],
      };
    }
    const perScope = scopes.usable.map(scope => ({
      // 只给作用域**家族**：`group:123` 里那一段是群号，`private` 里那一段是哈希。
      scopeKind: scope.startsWith('group:') ? 'group' : (scope.split(':')[0] ?? scope),
      assets: usableInScope(scope),
    }));
    const usableAssets = perScope.reduce((sum, row) => sum + (row.assets ?? 0), 0);
    return {
      kind, chatId: id,
      // `reason` 与 `scopesFor` 完全一致：它既可能是「收不到采集」，也可能是「群授权了但
      // use 关着」——两者都会让这一轮没有可用素材，而排障时要的就是原始原因码。
      reason: scopes.reason || '',
      usableScopes: scopes.usable.length,
      usableAssets,
      capture: scopes.capture === true,
      scopes: perScope,
    };
  }

  /** 一次完整诊断；`targets` 由调用方给（它才知道主人是谁、有哪些群）。 */
  function report({ targets = [], limit = 5 } = {}) {
    let stats = null;
    try {
      stats = library.stats();
    } catch {
      stats = null;
    }
    const review = count("SELECT count(*) AS total FROM asset_visibility WHERE approval = 'review'");
    const quarantined = count("SELECT count(*) AS total FROM asset_visibility WHERE approval = 'quarantined'");
    const revoked = count("SELECT count(*) AS total FROM asset_visibility WHERE approval = 'revoked'");
    const recent = Math.max(1, Math.min(10, Number(limit) || 5));
    return {
      ok: true,
      readAt: stamp(clock()),
      module: {
        enabled: config?.enabled !== false,
        deliveryEnabled: config?.delivery?.enabled === true,
        captureGroups: config?.capture?.groupEnabled === true,
        captureOwnerPrivate: config?.capture?.ownerPrivate === true,
        crossRoomReuse: config?.privacy?.crossRoomReuse === true,
        minFitScore: Number(config?.retrieval?.minFitScore ?? 0),
        // 召回池上限：诊断里要能看出「候选池是不是被这个数字卡住了」。
        poolLimit: Number(config?.retrieval?.poolLimit ?? 0),
      },
      library: {
        available: stats !== null,
        assets: stats?.assets ?? null,
        cards: stats?.cards ?? null,
        reviewAssets: stats?.review ?? null,
        quarantinedAssets: stats?.quarantined ?? null,
        visibility: { approved: stats?.approvals ?? null, review, quarantined, revoked },
      },
      targets: (Array.isArray(targets) ? targets : []).slice(0, 20).map(targetOf),
      lastCandidate: candidateView(readEvents.lastCandidate ?? null),
      lastReply: replyView(readEvents.lastReply ?? null),
      ingest: {
        observed: Number(readEvents.observed ?? 0),
        queued: Number(readEvents.queued ?? 0),
        dropped: Number(readEvents.dropped ?? 0),
        lastAt: stamp(readEvents.lastAt),
      },
      recentDeliveries: recentDeliveries(recent),
    };
  }

  /** 最近几次投递尝试（`deliveries` 是事实表，含失败原因码；不含消息正文）。 */
  function recentDeliveries(limit) {
    try {
      return db.all(
        'SELECT plan_id, part_index, asset_id, status, reason_code, provider_message_id, at FROM deliveries ORDER BY at DESC LIMIT ?',
        [limit],
      ).map(row => ({
        planId: text(row.plan_id),
        index: Number(row.part_index ?? 0),
        assetId: row.asset_id === null || row.asset_id === undefined ? null : String(row.asset_id),
        status: String(row.status ?? ''),
        reasonCode: String(row.reason_code ?? ''),
        // 回执是「真的发出去了」的唯一证据；空就是没有。
        messageId: row.provider_message_id === null || row.provider_message_id === undefined
          ? null
          : String(row.provider_message_id),
        at: stamp(row.at),
      }));
    } catch {
      return [];
    }
  }

  return { report, targetOf };
}

/** 最近一次 `expression_candidates` 的结局（只留结果码与计数，不留候选内容）。 */
export function candidateView(event) {
  if (event === null || typeof event !== 'object') return null;
  return {
    ok: event.ok === true,
    reasonCode: text(event.reasonCode ?? ''),
    send: event.send === true,
    candidates: Number(event.candidates ?? 0),
    fitScore: Number(event.fitScore ?? 0),
    // 内部成因（`no-candidates-in-pool` / `all-below-fit-threshold` / `opposite-expression` …）：
    // 对外只有一个 `no-compatible-expression`，但排障必须看得出是哪一道断掉的。
    cause: text(event.cause ?? ''),
    at: stamp(event.at),
  };
}

/** 最近一次 `expression_reply` 的结局（`messageId` 为空 = 没有回执 = 不算发过）。 */
export function replyView(event) {
  if (event === null || typeof event !== 'object') return null;
  return {
    ok: event.ok === true,
    reasonCode: text(event.reasonCode ?? ''),
    delivered: Number(event.delivered ?? 0),
    messageId: event.messageId === null || event.messageId === undefined ? null : String(event.messageId),
    assetId: event.assetId === null || event.assetId === undefined ? null : String(event.assetId),
    at: stamp(event.at),
  };
}

export default { createExpressionDiagnostics, candidateView, replyView };
