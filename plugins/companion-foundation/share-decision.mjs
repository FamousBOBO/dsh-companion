// 任务包 F：B站观看后的**分享决策**与**完成事件驱动的候选生产者**。
//
// 为什么需要这一层（本 worktree 已核实，勿照抄旧文档）：
//   * `share-producer.mjs:63` 的 `shareCandidateForActivity()` 只有模型**显式**调用
//     `companion_share_activity`（注册点 `companion-foundation/index.mjs:672-685`）时才会跑；
//   * 活动完成的钩子（`lib/activities.mjs:2721-2745` → `companion-runtime/index.mjs:2578` 的
//     `p2ActivityFinished`）只写 `memory/ingest-request`（`index.mjs:2476-2505`），**不产候选**；
//   * 非测试代码里 `createShareCandidate` 的生产调用点只有 `share-producer.mjs:106`。
//   ⇒ 这就是「`p2_share_candidates` 0 行」的真正原因：**没人产**，不是开关关着。
//
// 本模块只补两件事：
//   1. `decideShare()` —— 纯函数决策（兴趣 / 内容 / 新鲜度 / 重复度 / 预算 → 具名理由码）；
//   2. `produceCandidateForFinishedActivity()` —— 受开关控制、幂等、fail-closed 的生产者。
//
// 边界（与 `share-producer.mjs` 的头部纪律一致，不重复发明）：
//   * **不是发送方**：只调 runtime 的 `createShareCandidate`（写一行候选）。从不调 contact、
//     从不碰 outbox、从不发送。候选入库 ≠ 已进 contact ≠ 已送达。
//   * **默认关**：`config.p2.share.enabled !== true` ⇒ `share-disabled`，一行都不写。
//   * **fail-closed**：真活动 + done + 有观看证据（`kind:'watch'`）+ BV 合法，缺一拒绝；
//     `report`（只写了日报）**不是**观看证据（`lib/bilibili-rounds.mjs:9`）。
//   * **不编感想**：视频标题/内容摘要只能由调用方从真实来源传进来；拿不到就写“没有内容摘要，
//     不编感想”，并且通常落 `low-relevance`。
//   * **字幕 ≠ 看过**：`method:'transcript'` 是 `lib/bilibili-rounds.mjs:13` 才带出来的单向标记，
//     本模块必须把它说出来（标题与正文都分叉），不允许把字幕秒数说成观看时长。
//
// 纯函数纪律：`decideShare` 无 IO、无默认系统时钟、不改入参；所有判据都在返回值里可复核。

import { createHash } from 'node:crypto';

/** 分享决策的具名理由码。字符串即契约：日志/诊断一律 grep 这些词。 */
export const SHARE_REASON = Object.freeze({
    OK: 'share-ok',
    DISABLED: 'share-disabled',
    RUNTIME_NOT_MOUNTED: 'runtime-not-mounted',
    SCOPE_REQUIRED: 'scope-required',
    INVALID_INPUT: 'invalid-input',
    ACTIVITY_NOT_FOUND: 'activity-not-found',
    SIMULATED: 'simulated-not-shared',
    NOT_DONE: 'not-done',
    NO_EVIDENCE: 'no-evidence',
    NO_VIDEO_ID: 'no-video-id',
    TRANSCRIPT_ONLY: 'transcript-only-blocked',
    DUPLICATE: 'duplicate',
    LOW_RELEVANCE: 'low-relevance',
    STALE: 'stale',
    BUDGET: 'budget-exhausted',
    ROUND_FAILED: 'round-failed',
    ROUND_UNKNOWN: 'round-unknown',
    ROUND_QUOTA: 'round-quota-exhausted',
    QUEUE_FULL: 'share-queue-full',
    CREATE_FAILED: 'share-create-failed',
    CREATE_THREW: 'share-create-threw',
    ACTIVITY_READ_FAILED: 'activity-read-failed',
});

/**
 * 每个理由码的处置分类。
 *
 *   terminal —— 对**这一份证据快照**是“不”，重试没有意义（"等新事件"不算重试）；
 *   retry    —— 是“还不行”，时间/窗口/队列变化后同一份证据仍然有效。
 *
 * `gateCode` 指向 `lib/p2.mjs:1525-1558` 的闸门词表里语义相同的那一个（没有对应就空串）。
 * 这张表是机器可读的，测试与面板都读它，避免“新增一个理由码悄悄继承重试语义”。
 */
export const REASON_CLASS = Object.freeze({
    [SHARE_REASON.OK]: { terminal: false, retry: false, gateCode: '' },
    [SHARE_REASON.DISABLED]: { terminal: true, retry: false, gateCode: 'share-disabled' },
    [SHARE_REASON.RUNTIME_NOT_MOUNTED]: { terminal: true, retry: false, gateCode: 'share-port-unavailable' },
    [SHARE_REASON.SCOPE_REQUIRED]: { terminal: true, retry: false, gateCode: 'scope-mismatch' },
    [SHARE_REASON.INVALID_INPUT]: { terminal: true, retry: false, gateCode: 'scope-mismatch' },
    [SHARE_REASON.ACTIVITY_NOT_FOUND]: { terminal: true, retry: false, gateCode: 'scope-mismatch' },
    [SHARE_REASON.SIMULATED]: { terminal: true, retry: false, gateCode: '' },
    [SHARE_REASON.NOT_DONE]: { terminal: false, retry: true, gateCode: '' },
    [SHARE_REASON.NO_EVIDENCE]: { terminal: false, retry: true, gateCode: '' },
    [SHARE_REASON.NO_VIDEO_ID]: { terminal: false, retry: true, gateCode: '' },
    [SHARE_REASON.TRANSCRIPT_ONLY]: { terminal: true, retry: false, gateCode: '' },
    [SHARE_REASON.DUPLICATE]: { terminal: true, retry: false, gateCode: 'dedupe' },
    [SHARE_REASON.LOW_RELEVANCE]: { terminal: true, retry: false, gateCode: '' },
    [SHARE_REASON.STALE]: { terminal: true, retry: false, gateCode: 'expired' },
    [SHARE_REASON.BUDGET]: { terminal: false, retry: true, gateCode: 'quota' },
    [SHARE_REASON.ROUND_FAILED]: { terminal: true, retry: false, gateCode: '' },
    [SHARE_REASON.ROUND_UNKNOWN]: { terminal: true, retry: false, gateCode: '' },
    [SHARE_REASON.ROUND_QUOTA]: { terminal: true, retry: false, gateCode: '' },
    [SHARE_REASON.QUEUE_FULL]: { terminal: false, retry: true, gateCode: '' },
    [SHARE_REASON.CREATE_FAILED]: { terminal: false, retry: true, gateCode: 'share-sink-failed' },
    [SHARE_REASON.CREATE_THREW]: { terminal: false, retry: true, gateCode: 'share-sink-failed' },
    [SHARE_REASON.ACTIVITY_READ_FAILED]: { terminal: false, retry: true, gateCode: '' },
});

/** 决策可调参数（全部可从 `config.p2.share.decision` 覆盖）。 */
export const DEFAULT_DECISION_CONFIG = Object.freeze({
    /** `false` ⇒ 只读字幕的证据一律拒绝（`transcript-only-blocked`）。 */
    allowTranscriptOnly: true,
    /** 分数门槛（0..1）。 */
    minScore: 0.5,
    /** 字幕/消费秒数的“够相关内容”门槛；低于它证据强度打折。 */
    minRelevantSeconds: 180,
    /** 证据新鲜度 TTL；超过即 `stale`（对齐闸门 `expired`，不复活旧积压）。 */
    freshnessTtlMs: 2 * 3600 * 1000,
    /** 每日分享预算与窗口。 */
    maxSharesPerDay: 3,
    budgetWindowMs: 24 * 3600 * 1000,
    /** `true` ⇒ 没有内容摘要直接 `low-relevance`（宁可不说，也不编）。 */
    requireContentSummary: false,
    /** 每个候选最多带几个视频（BV 号去重后截断，避免一条候选变成长清单）。 */
    maxVideos: 5,
});

/** 固定声明：任何返回里都带着它，避免“候选已建”被读成“已送达”。 */
export const CANDIDATE_NOTE = '候选已写入 runtime 的候选表（不是已进 contact，更不是已送达）。'
    + '投递由 contact 的既有闸门决定；真实送达只能看 contact 自己的投递账本。';

const BV = /^BV[a-zA-Z0-9]{10}$/;

function textOf(value) {
    return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
}

function sha256Hex(value) {
    return createHash('sha256').update(String(value)).digest('hex');
}

function finiteOr(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return n < 0 ? 0 : (n > 1 ? 1 : n);
}

function round3(value) {
    return Math.round(clamp01(value) * 1000) / 1000;
}

/** 公开链接**只由 BV 号拼**，不猜真实 URL、不带任何未经验证的参数。 */
export function bilibiliVideoUrl(videoId) {
    const id = textOf(videoId).trim();
    return BV.test(id) ? `https://www.bilibili.com/video/${id}` : '';
}

/** 决策参数：默认值 ← `config.p2.share.decision`（只读，`undefined` 视为未配置）。 */
export function decisionConfig(config) {
    const raw = config?.p2?.share?.decision ?? {};
    const out = { ...DEFAULT_DECISION_CONFIG };
    for (const key of Object.keys(DEFAULT_DECISION_CONFIG)) {
        if (raw[key] === undefined) continue;
        out[key] = typeof DEFAULT_DECISION_CONFIG[key] === 'boolean' ? raw[key] === true : finiteOr(raw[key], DEFAULT_DECISION_CONFIG[key]);
    }
    out.maxVideos = Math.max(1, Math.min(10, Math.trunc(out.maxVideos) || DEFAULT_DECISION_CONFIG.maxVideos));
    out.minScore = clamp01(out.minScore);
    return out;
}

/** `p2.share.enabled` 的**唯一**判据（与 `share-producer.mjs:72`、`lib/p2.mjs:1471` 同一口径）。 */
export function shareEnabled(config) {
    return config?.p2?.share?.enabled === true;
}

/** shadow 档：只决策、不建候选（计划 §9.3 的灰度要求）。 */
export function shareShadow(config) {
    return config?.p2?.share?.shadow === true;
}

// --------------------------------------------------------------------------- 证据

/**
 * 把 round 摘要 / 活动 checkpoint 归一成**可判定的证据**。
 *
 * 输入形态（都接受，优先级从高到低）：
 *   `evidence.items` → `evidence.round` / `evidence` 平铺的 watch 项 →
 *   `activity.checkpoint.bilibiliRound` → `activity.bilibiliRound`
 *
 * ⚠️ B站的 `activity.consumedPrefix`/`totalUnits` **不是秒数也不是视频数**：
 * `lib/activities.mjs` 只给 bilibili 在 start 时写 0（`:857-859`），progress 分支它不走；
 * 真正的计数是 `checkpoint.bilibiliRound.watched`（`index.mjs:2362`、`lib/p2.mjs:1286-1287`）。
 * 所以这里**不读** `consumedPrefix` 来当证据。
 */
export function deriveBilibiliEvidence({ activity, evidence } = {}) {
    const supplied = Array.isArray(evidence?.items) ? evidence.items : (Array.isArray(evidence?.evidence) ? evidence.evidence : null);
    const checkpointRound = activity?.checkpoint && typeof activity.checkpoint === 'object'
        ? activity.checkpoint.bilibiliRound
        : undefined;
    const round = supplied ? null : (evidence?.round ?? checkpointRound ?? activity?.bilibiliRound ?? null);
    const rawItems = supplied ?? (Array.isArray(round?.evidence) ? round.evidence : []);
    const watches = [];
    for (const item of rawItems.slice(0, 100)) {
        if (!item || typeof item !== 'object') continue;
        if (textOf(item.kind) !== 'watch') continue;
        const videoId = textOf(item.videoId).trim();
        if (!BV.test(videoId)) continue;
        const consumedSeconds = finiteOr(item.consumedSeconds, 0);
        if (!(consumedSeconds > 0)) continue;
        watches.push({ videoId, consumedSeconds, method: textOf(item.method) === 'transcript' ? 'transcript' : '' });
    }
    const roundId = textOf(evidence?.roundId ?? round?.roundId ?? activity?.roundId ?? '')
        || textOf(activity?.activityId ?? '');
    const roundStatus = textOf(evidence?.roundStatus ?? round?.status ?? '').toLowerCase();
    // `watched` 是**去重视频数**；它与“有逐条 BV 证据”是两件事：
    // 知道看过 3 条、却不知道是哪 3 条 ⇒ 不能拼链接，也不能猜（见 decideShare 的 no-video-id）。
    const watchedHint = finiteOr(round?.watched, 0);
    const summaryRaw = textOf(evidence?.summary ?? round?.summary ?? '').replace(/\s+/g, ' ').trim();
    const titleRaw = textOf(evidence?.title ?? round?.title ?? '').replace(/\s+/g, ' ').trim();
    return {
        roundId,
        roundStatus,
        watched: watchedHint,
        watches,
        watchedIds: [...new Set(watches.map(item => item.videoId))],
        summary: summaryRaw.slice(0, 400),
        title: titleRaw.slice(0, 200),
        supplied: supplied !== null,
        source: supplied ? 'evidence.items' : (round ? 'activity.bilibiliRound' : 'none'),
    };
}

// --------------------------------------------------------------------------- 兴趣

/** 中文按二元组、拉丁按词：够用的近似即可，不引入分词依赖。 */
function tokensOf(value) {
    const normalized = textOf(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    const tokens = new Set();
    const latin = textOf(value).toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
    for (const word of latin) tokens.add(word);
    const cjk = normalized.replace(/[^\u3400-\u9fff]/g, '');
    for (let index = 0; index + 2 <= cjk.length; index += 1) tokens.add(cjk.slice(index, index + 2));
    return tokens;
}

/** `[0,1]`：两个集合的重合度（用较小集合做分母，短标题不会因长度被系统性压低）。 */
function overlapOf(left, right) {
    if (left.size === 0 || right.size === 0) return 0;
    let shared = 0;
    for (const token of left) if (right.has(token)) shared += 1;
    return shared / Math.min(left.size, right.size);
}

/** 兴趣来源：显式 `evidence.interests` → `activity.interests` → `config.p2.share.decision.interests`。 */
function interestsOf({ activity, evidence, config }) {
    const candidates = [evidence?.interests, activity?.interests, config?.p2?.share?.decision?.interests];
    for (const value of candidates) {
        if (Array.isArray(value)) {
            return value
                .filter(row => row && typeof row === 'object' && textOf(row.status || 'active').toLowerCase() === 'active')
                .map(row => ({ title: textOf(row.title).trim(), note: textOf(row.note).trim(), strength: clamp01(finiteOr(row.strength, 0.5)) }))
                .filter(row => row.title !== '');
        }
    }
    return null;
}

/**
 * 兴趣匹配：拿真实标题/摘要与 `p2_interests` 的标题比对。
 *
 * `unavailable` 与 `0` 必须分开：读不到兴趣不等于“没兴趣”，否则所有候选都会以
 * `low-relevance` 被毙掉——那正是“测试绿、生产空”的另一种形态。
 */
function interestMatch({ interests, haystack }) {
    if (interests === null) return { state: 'unavailable', score: 0, matched: [] };
    if (interests.length === 0) return { state: 'empty', score: 0, matched: [] };
    const text = tokensOf(haystack);
    let best = 0;
    const matched = [];
    for (const interest of interests) {
        const overlap = overlapOf(tokensOf(interest.title), text);
        if (overlap <= 0) continue;
        const weighted = clamp01(overlap * (0.5 + 0.5 * interest.strength));
        if (weighted > best) best = weighted;
        if (overlap >= 0.34) matched.push(interest.title.slice(0, 60));
    }
    return { state: 'available', score: best, matched };
}

// --------------------------------------------------------------------------- 历史

function asRows(history) {
    if (Array.isArray(history)) return history;
    if (history && typeof history.list === 'function') {
        try {
            const rows = history.list();
            return Array.isArray(rows) ? rows : null;
        } catch { return null; }
    }
    if (history && Array.isArray(history.candidates)) return history.candidates;
    return null;
}

/** 单行归一：同时吃数据库列名（snake）与 JS 形状（camel），不猜缺失字段。 */
function normalizeRow(row) {
    if (!row || typeof row !== 'object') return null;
    const activityId = textOf(row.activityId ?? row.activity_id).trim();
    const candidateId = textOf(row.candidateId ?? row.candidate_id).trim();
    const status = textOf(row.status ?? row.state).trim().toLowerCase();
    const createdAt = finiteOr(row.createdAt ?? row.created_at ?? row.submittedAt ?? row.submitted_at, 0);
    if (activityId === '' && candidateId === '') return null;
    return {
        activityId,
        candidateId,
        kind: textOf(row.kind).trim() || 'activity',
        status,
        createdAt,
    };
}

/**
 * 历史快照：`available` 表示**真的读到了**（可能是空数组），`unavailable` 表示读不到。
 * 两者的处置完全不同（后者不能判重复/预算，只能交给 runtime 的 pending 唯一性兜住）。
 */
function historySnapshot(history) {
    const rows = asRows(history);
    if (rows === null) return { state: 'unavailable', rows: [] };
    const normalized = rows.map(normalizeRow).filter(Boolean);
    return { state: 'available', rows: normalized };
}

// --------------------------------------------------------------------------- 决策

/**
 * 一条完成活动 → **要不要分享**。
 *
 * 纯函数：无 IO、不读系统时间、不改入参。所有分支都在 `reasons` 里留下一条具名理由。
 *
 * @param activity 活动行投影（见 `plugins/companion-foundation/docs/F-share-chain-draft.md` §3.1）
 * @param evidence 可选显式证据（`items` 或 `round`），优先级高于 `activity.checkpoint`
 * @param config   runtime 配置（只读）
 * @param now      epoch ms；缺失时退化为 `activity.endedAt/updatedAt`，并把 freshness 标 `unknown`
 * @param history  只读历史快照（数组 / `{list()}` / `{candidates}`）；缺省 `null` = 读不到
 */
export function decideShare({ activity, evidence, config, now, history } = {}) {
    const reasons = [];
    const reason = (code, detail) => { reasons.push({ code, detail: textOf(detail).slice(0, 200) }); return code; };
    const cfg = decisionConfig(config);
    const enabled = shareEnabled(config);
    const atRaw = finiteOr(now, NaN);
    const activityObj = activity && typeof activity === 'object' ? activity : null;
    const derived = deriveBilibiliEvidence({ activity: activityObj, evidence });
    const activityId = textOf(activityObj?.activityId ?? derived.roundId).trim();
    const kind = textOf(activityObj?.kind ?? (derived.watches.length || derived.roundStatus ? 'bilibili' : '')).trim();
    const roundId = derived.roundId || activityId;
    const endedAt = finiteOr(activityObj?.endedAt ?? activityObj?.updatedAt, 0);
    const reference = Number.isFinite(atRaw) ? atRaw : endedAt;
    const snapshot = historySnapshot(history);

    const facts = {
        activityId,
        roundId,
        kind,
        videoIds: [],
        links: [],
        method: 'none',
        methodLabel: '没有观看证据',
        evidenceRef: '',
        journalKey: roundId ? sha256Hex(roundId) : '',
        watched: 0,
        consumedSeconds: 0,
        roundStatus: derived.roundStatus || '',
        interestMatch: 0,
        interestState: 'unavailable',
        content: { source: 'absent', chars: 0 },
        freshness: { ageMs: null, ttlMs: cfg.freshnessTtlMs, band: 'unknown' },
        budget: { used: 0, limit: cfg.maxSharesPerDay, windowMs: cfg.budgetWindowMs, state: snapshot.state === 'available' ? 'ok' : 'unavailable' },
        history: snapshot.state,
        reality: textOf(activityObj?.reality),
        status: textOf(activityObj?.status),
        shadow: shareShadow(config),
        evidenceSource: derived.source,
    };

    /** 统一的失败出口：`share:false` + 具名码 + reasons + facts + score。 */
    const refuse = (code, score = 0) => ({ share: false, reasonCode: code, reasons, facts, score: round3(score) });

    // ---- 1. 开关（最便宜）
    if (!enabled) {
        reason(SHARE_REASON.DISABLED, 'p2.share.enabled !== true：不决策分享、不建候选、不外发');
        return refuse(SHARE_REASON.DISABLED);
    }
    // ---- 2. 入参
    if (activityObj === null) {
        reason(SHARE_REASON.INVALID_INPUT, 'activity 缺失或不是对象');
        return refuse(SHARE_REASON.INVALID_INPUT);
    }
    if (activityId === '') {
        reason(SHARE_REASON.INVALID_INPUT, 'activity 没有 activityId');
        return refuse(SHARE_REASON.INVALID_INPUT);
    }
    // ---- 3. 真活动 / 完成
    if (facts.reality !== 'actual_tool_activity') {
        reason(SHARE_REASON.SIMULATED, `reality=${facts.reality || '(空)'}：模拟世界的“做过”不算做过`);
        return refuse(SHARE_REASON.SIMULATED);
    }
    // ---- 3. round 终态**先于**活动行 status 判：
    //    B站的 `settleBilibili` 在 round 非 completed 时把活动行也标成 `failed`
    //    （`lib/activities.mjs:2802-2808`），所以只报 `not-done` 会把“这一轮为什么没成”的信息吞掉。
    //    `unknown` 是终态、**不重试**：子进程可能已经到了 B站，只是回话丢了（`bilibili-rounds.mjs:86-87`）。
    if (derived.roundStatus && derived.roundStatus !== 'completed') {
        const code = derived.roundStatus === 'failed'
            ? SHARE_REASON.ROUND_FAILED
            : (derived.roundStatus === 'quota-exhausted' ? SHARE_REASON.ROUND_QUOTA : SHARE_REASON.ROUND_UNKNOWN);
        reason(code, `round status=${derived.roundStatus}：这一轮没有成功结算，不产候选、不重试`);
        return refuse(code);
    }
    // ---- 4. 活动行状态
    if (facts.status !== 'done') {
        reason(SHARE_REASON.NOT_DONE, `status=${facts.status || '(空)'}：只有 done 才算完成（running/paused/abandoned/failed 都不算）`);
        return refuse(SHARE_REASON.NOT_DONE);
    }
    // ---- 5. 观看证据（report 不算）
    if (derived.watches.length === 0) {
        // 两种“没有 BV”必须分开：round 说看过 N 条、却没有逐条 BV ⇒ 不能猜编号，也不能拼链接；
        // 而 round 一条都没看过 ⇒ 根本没有观看证据。
        if (derived.watched > 0) {
            reason(SHARE_REASON.NO_VIDEO_ID, `round 报告看过 ${derived.watched} 个视频，但没有逐条 BV 证据：不猜 BV、不拼链接；调用方需把 round evidence 传进来`);
            return refuse(SHARE_REASON.NO_VIDEO_ID);
        }
        reason(SHARE_REASON.NO_EVIDENCE, derived.supplied
            ? 'evidence.items 里没有合法的 watch 项（report/interaction 不是观看证据）'
            : 'checkpoint.bilibiliRound 里没有可用 watch 证据；调用方需把 round evidence 传进来');
        return refuse(SHARE_REASON.NO_EVIDENCE);
    }
    const videoIds = derived.watchedIds.slice(0, cfg.maxVideos);
    if (videoIds.length === 0) {
        reason(SHARE_REASON.NO_VIDEO_ID, '证据里的 videoId 不是合法 BV 号，且不猜 URL');
        return refuse(SHARE_REASON.NO_VIDEO_ID);
    }
    facts.videoIds = videoIds;
    facts.links = videoIds.map(bilibiliVideoUrl);
    facts.watched = derived.watchedIds.length;
    facts.consumedSeconds = Math.max(...derived.watches.map(item => item.consumedSeconds));
    // 三态只有一种来源：`bilibili-rounds.mjs:13` 只会给"字幕路径"的 watch 带上 method。
    // 因此“全是字幕”= transcript、“一个都没标”= unstated、其余 = mixed。
    const transcriptCount = derived.watches.filter(item => item.method === 'transcript').length;
    facts.method = transcriptCount === 0 ? 'unstated'
        : (transcriptCount === derived.watches.length ? 'transcript' : 'mixed');
    facts.methodLabel = {
        transcript: '只读了字幕',
        mixed: '部分证据只读了字幕',
        unstated: '记录里没有标注观看方式',
        none: '没有观看证据',
    }[facts.method];
    facts.evidenceRef = `round:${sha256Hex(roundId).slice(0, 16)}#${videoIds[0]}`;

    if (facts.method === 'transcript' && cfg.allowTranscriptOnly !== true) {
        reason(SHARE_REASON.TRANSCRIPT_ONLY, '策略 allowTranscriptOnly=false：只读了字幕的证据不分享');
        return refuse(SHARE_REASON.TRANSCRIPT_ONLY);
    }
    if (facts.method !== 'transcript') {
        // 不是失败，只是必须诚实：没有标注就不能声称“看过画面”。
        reason(SHARE_REASON.OK, '证据未标注观看方式：候选会明说“记录里没有写下观看方式”，不声称看过画面');
    }

    // ---- 6. 新鲜度
    if (!Number.isFinite(atRaw)) {
        // 没有注入 `now` 就不读系统时间：新鲜度只能是 unknown，也不能据此判 stale。
        reason(SHARE_REASON.OK, '没有注入 now：新鲜度标 unknown（不判 stale，也不假装“刚发生”）');
    } else if (endedAt <= 0) {
        reason(SHARE_REASON.OK, '活动没有 endedAt/updatedAt：新鲜度标记为 unknown（不判 stale）');
    } else {
        const ageMs = Math.max(0, atRaw - endedAt);
        facts.freshness = { ageMs, ttlMs: cfg.freshnessTtlMs, band: ageMs <= cfg.freshnessTtlMs ? 'live' : (ageMs <= cfg.freshnessTtlMs * 3 ? 'aging' : 'stale') };
        if (facts.freshness.band === 'stale') {
            reason(SHARE_REASON.STALE, `证据已过 ${Math.round(ageMs / 60000)} 分钟（TTL ${Math.round(cfg.freshnessTtlMs / 60000)} 分钟）：关闭期积压不自动复活`);
            return refuse(SHARE_REASON.STALE);
        }
    }

    // ---- 7. 重复度（幂等的主闸；读不到历史就交给 runtime 的 pending 唯一性兜住）
    if (snapshot.state === 'available') {
        const same = snapshot.rows.find(row => row.activityId === activityId && row.kind === ((kind || 'bilibili')));
        if (same && same.status !== 'withdrawn') {
            facts.existingCandidateId = same.candidateId;
            reason(SHARE_REASON.DUPLICATE, `同一活动已有候选 ${same.candidateId || '(无 id)'}（status=${same.status || '未知'}）：不重复建、不重发`);
            return refuse(SHARE_REASON.DUPLICATE);
        }
    } else {
        reason(SHARE_REASON.OK, '历史读不到：重复判定交给 runtime 的 (scope, activityId, kind, pending) 唯一性');
    }

    // ---- 8. 预算（窗口内已建候选数）
    if (snapshot.state === 'available' && reference > 0) {
        const windowStart = reference - cfg.budgetWindowMs;
        const used = snapshot.rows.filter(row => row.createdAt >= windowStart && row.status !== 'withdrawn').length;
        facts.budget = {
            used,
            limit: cfg.maxSharesPerDay,
            windowMs: cfg.budgetWindowMs,
            state: used >= cfg.maxSharesPerDay ? 'exhausted' : 'ok',
        };
        if (facts.budget.state === 'exhausted') {
            reason(SHARE_REASON.BUDGET, `窗口内已分享 ${used} 条（上限 ${cfg.maxSharesPerDay}）：过一会儿同一份证据仍然有效`);
            return refuse(SHARE_REASON.BUDGET);
        }
    }

    // ---- 9. 兴趣 + 内容 + 分数
    const interests = interestsOf({ activity: activityObj, evidence, config });
    const haystack = [derived.title, derived.summary, textOf(activityObj?.title)].filter(Boolean).join(' ');
    const interest = interestMatch({ interests, haystack });
    facts.interestMatch = round3(interest.score);
    facts.interestState = interest.state;

    const contentSource = derived.summary !== '' ? 'evidence-summary' : (derived.title !== '' ? 'evidence-title' : 'absent');
    facts.content = {
        source: contentSource,
        chars: derived.summary.length || derived.title.length,
        summary: derived.summary,
        title: derived.title,
        matchedInterests: interest.matched,
    };

    const evidenceStrength = cfg.minRelevantSeconds <= 0
        ? 1
        : clamp01(facts.consumedSeconds / (cfg.minRelevantSeconds * 2));
    const contentStrength = contentSource === 'evidence-summary' ? (derived.summary.length >= 20 ? 1 : 0.6)
        : (contentSource === 'evidence-title' ? 0.35 : 0);
    const freshnessStrength = facts.freshness.band === 'live' ? 1 : (facts.freshness.band === 'aging' ? 0.7 : (facts.freshness.band === 'unknown' ? 0.6 : 0));
    // 分数 = 基础分（证据/内容/新鲜度，权重和恒为 1）+ 兴趣**加分**。
    // 为什么是加分而不是重新分配权重：重新分配会让“兴趣命中”反而压低分数
    // （命中 0.2 分的项换成 0.2 权重时，原来 1.0 的候选会掉到 0.8），
    // 那会得出“越相关越不该分享”的荒谬结论——这条由测试钉住。
    const baseScore = evidenceStrength * 0.50 + contentStrength * 0.35 + freshnessStrength * 0.15;
    const interestBonus = interest.state === 'available' ? 0.20 * clamp01(interest.score) : 0;
    const score = clamp01(baseScore + interestBonus);

    if (interest.state === 'available') {
        reason(SHARE_REASON.OK, interest.matched.length
            ? `兴趣命中：${interest.matched.slice(0, 3).join('、')}`
            : '兴趣没命中：分数只由证据与内容组成');
    } else {
        reason(SHARE_REASON.OK, `兴趣不可用（${interest.state}）：不把“读不到兴趣”当成“没兴趣”`);
    }
    if (cfg.requireContentSummary === true && contentSource !== 'evidence-summary') {
        reason(SHARE_REASON.LOW_RELEVANCE, '策略 requireContentSummary=true：没有内容摘要就不分享（不编感想）');
        return refuse(SHARE_REASON.LOW_RELEVANCE, score);
    }
    if (round3(score) < cfg.minScore) {
        reason(SHARE_REASON.LOW_RELEVANCE, `分数 ${round3(score)} < 门槛 ${cfg.minScore}：内容不够，不编一段感想`);
        return refuse(SHARE_REASON.LOW_RELEVANCE, score);
    }
    reason(SHARE_REASON.OK, `分数 ${round3(score)} ≥ 门槛 ${cfg.minScore}：可以分享（字幕=“只读了字幕”，会写进候选正文）`);
    return { share: true, reasonCode: SHARE_REASON.OK, reasons, facts, score: round3(score) };
}

// --------------------------------------------------------------------------- 候选文本

/**
 * 候选标题：**按观看方式分叉**，绝不把字幕说成看过视频。
 * 长度上限 200（与 `lib/p2.mjs:1484`、`autonomy-share.mjs:166` 一致）。
 */
function titleOf(facts) {
    const count = facts.videoIds.length;
    const many = count > 1 ? `${count} 个视频` : '一个视频';
    const text = facts.method === 'transcript' ? `B站：读了${many}的字幕`
        : (facts.method === 'mixed' ? `B站：看了${many}（部分只读了字幕）` : `B站：看了${many}`);
    return text.slice(0, 200);
}

/**
 * 候选正文：视频标识 + 公开链接 + 观看方式 + 内容（若有来源）+ 证据引用 + 关联 ID。
 * 长度上限 2000（与 `lib/p2.mjs:1484` 一致）。**不写任何未由调用方提供的事实。**
 */
function bodyOf(facts) {
    const lines = [];
    const minutes = Math.max(1, Math.round(facts.consumedSeconds / 60));
    facts.videoIds.forEach((videoId, index) => {
        const link = facts.links[index] || '';
        lines.push(link ? `视频 ${index + 1}：${videoId} ${link}` : `视频 ${index + 1}：${videoId}`);
    });
    if (facts.method === 'transcript') {
        lines.push(`观看方式：只读了字幕（约 ${minutes} 分钟字幕），没有看画面`);
    } else if (facts.method === 'mixed') {
        lines.push('观看方式：部分证据只读了字幕，不是全部看过画面');
    } else {
        lines.push('观看方式：记录里没有写下观看方式（不声称看过画面）');
    }
    if (facts.content.source === 'evidence-summary') {
        lines.push(`内容：${facts.content.summary}`);
    } else if (facts.content.source === 'evidence-title') {
        lines.push(`内容：${facts.content.title}`);
    } else {
        lines.push('内容：没有内容摘要，不编感想');
    }
    if (facts.evidenceRef) lines.push(`证据：${facts.evidenceRef}`);
    lines.push(`关联：activity=${facts.activityId} round=${facts.roundId}`);
    // 最后一行必须说清“这只是一个候选项”：候选入库 ≠ 投递 ≠ 送达。
    lines.push('说明：这只是候选，还没有投递出去。');
    return lines.join('\n').slice(0, 2000);
}

// --------------------------------------------------------------------------- 生产者

/** 把 `u:x|p:y|w:z` 拆成 runtime 认的 bound 形状（**不**做第二套 scope 解析：拆不出就返回 null）。 */
function boundOfScopeKey(scopeKey) {
    const match = /^u:(.+)\|p:(.+)\|w:(.+)$/.exec(textOf(scopeKey));
    if (!match) return null;
    return { userId: match[1], personaId: match[2], worldId: match[3] };
}

/**
 * 历史回读（可选）：给了 `history` 就用；否则问 runtime 的候选列表（同一库、同一作用域）。
 * 读不到就返回 `null`（**不**把“读不到”说成“没有历史”）。
 *
 * 作用域必须**随 `scopeKey` 一起传下去**：runtime 的 `shareCandidates()` 只认
 * `bound`/`binding`/`scope`，或退一步用 `sessionId` 找 identity；活动完成事件里通常
 * 没有 sessionId，于是只传 `{sessionId, status}` 会拿到 `{ok:false, code:'unbound'}`
 * —— 空数组看起来和“没有历史”一模一样，重复判定与每日预算就永远不生效。
 * 这里把 `u:x|p:y|w:z` 拆回 runtime 认的 bound 形状（拆不出就只传 sessionId，
 * 由 runtime 自己拒绝，绝不在这里猜作用域）。
 */
function resolveHistory({ cognitive, sessionId, scopeKey, history }) {
    if (history !== undefined && history !== null) return history;
    const lister = cognitive && typeof cognitive.shareCandidates === 'function' ? cognitive.shareCandidates : null;
    if (!lister) return null;
    const bound = boundOfScopeKey(scopeKey);
    if (!sessionId && bound === null) return null;
    try {
        const listed = lister({ sessionId, ...(bound === null ? {} : { bound }), status: 'all' });
        if (Array.isArray(listed)) return listed;
        if (Array.isArray(listed?.candidates)) return listed.candidates;
        return null;
    } catch { return null; }
}

/**
 * 为一条**已完成的真活动**产出候选（完成事件驱动版）。
 *
 * 顺序（每道 fail-closed，先便宜判断）：
 *   开关 → shadow → 决策 → 文本 → runtime 落库。
 *
 * 幂等：主键是 `(scopeKey, activityId, kind)`——
 *   * 事件重复：`history`（或 runtime 的 pending 唯一性）判 `duplicate`，不建第二条；
 *   * 跨重启：`history` 由持久化的候选表回读，重启后同一活动仍落 `duplicate`；
 *   * 超时/unknown round：`round-unknown` 是 terminal，**不盲目重试**。
 *
 * 返回值的 `note` 固定声明“候选入库 ≠ 已进 contact ≠ 已送达”。
 */
export function produceCandidateForFinishedActivity({
    cognitive,
    config,
    sessionId = '',
    scopeKey = '',
    activity,
    evidence,
    now,
    history,
    interests,
} = {}) {
    // 开关关着 / shadow 档：**一次都不碰 runtime**。
    //   开关关着时连候选列表都不读（零写入、零读取，行为与关闭前的生产逐字相同）；
    //   shadow 档只记录决策，调用方若想看重复度/预算就显式传 `history`。
    const touchRuntime = shareEnabled(config) && !shareShadow(config);
    const resolvedHistory = touchRuntime ? resolveHistory({ cognitive, sessionId, scopeKey, history }) : (history ?? null);
    // `interests` 只是给调用方省一次拼装的便利参数：它覆盖 `activity.interests`，不覆盖 `evidence.interests`。
    const subject = activity && typeof activity === 'object' && Array.isArray(interests)
        ? { ...activity, interests }
        : activity;
    const decision = decideShare({
        activity: subject,
        evidence,
        config,
        now,
        history: resolvedHistory,
    });
    const base = {
        // `ok` 的含义在这里被钉死：**这次调用有没有让“该活动现在有一条候选”这个目标成立**。
        //   created=true  ⇒ ok=true（新建了一行）；
        //   duplicate     ⇒ ok=true、created=false（已经有一行，幂等成功，**不新增**）；
        //   任何拒绝      ⇒ ok=false。
        // 于是“ok=true”永远不等于“新发了什么”，调用方必须看 `created`/`duplicate` 才不会误报。
        ok: false,
        created: false,
        duplicate: false,
        reasonCode: decision.reasonCode,
        reasons: decision.reasons,
        candidateId: '',
        activityId: decision.facts.activityId,
        roundId: decision.facts.roundId,
        facts: decision.facts,
        decision,
        note: CANDIDATE_NOTE,
    };
    if (decision.reasonCode === SHARE_REASON.DUPLICATE) {
        // 历史里已经有同一活动的候选：幂等命中，不碰 runtime。
        const same = decision.reasons.find(entry => entry.code === SHARE_REASON.DUPLICATE);
        const existing = decision.facts && decision.facts.existingCandidateId ? decision.facts.existingCandidateId : '';
        return { ...base, ok: true, duplicate: true, candidateId: existing, reasons: decision.reasons, note: `${CANDIDATE_NOTE}（这一次是幂等命中，没有新增行）` , detail: same?.detail ?? '' };
    }
    if (!decision.share) return base;

    // shadow：跑到“可以分享”就不写库（灰度期只记录决策与理由）。
    if (shareShadow(config)) {
        return { ...base, reasonCode: SHARE_REASON.OK, shadow: true, note: 'shadow 档：决策已记录，未创建候选（也没有任何外发）。' };
    }
    if (!cognitive || typeof cognitive.createShareCandidate !== 'function') {
        return {
            ...base,
            reasonCode: SHARE_REASON.RUNTIME_NOT_MOUNTED,
            reasons: [...base.reasons, { code: SHARE_REASON.RUNTIME_NOT_MOUNTED, detail: 'cognitive.createShareCandidate 不可用' }],
        };
    }
    const bound = boundOfScopeKey(scopeKey);
    if (scopeKey && bound === null) {
        return {
            ...base,
            reasonCode: SHARE_REASON.SCOPE_REQUIRED,
            reasons: [...base.reasons, { code: SHARE_REASON.SCOPE_REQUIRED, detail: `scopeKey 形状不合法：${textOf(scopeKey).slice(0, 60)}` }],
        };
    }
    if (!sessionId && bound === null) {
        return {
            ...base,
            reasonCode: SHARE_REASON.SCOPE_REQUIRED,
            reasons: [...base.reasons, { code: SHARE_REASON.SCOPE_REQUIRED, detail: '既没有 sessionId 也没有合法 scopeKey：不从默认人物/世界猜作用域' }],
        };
    }

    let created;
    try {
        created = cognitive.createShareCandidate({
            sessionId,
            ...(bound === null ? {} : { bound }),
            activityId: decision.facts.activityId,
            kind: 'bilibili',
            title: titleOf(decision.facts),
            body: bodyOf(decision.facts),
            sourceRef: decision.facts.evidenceRef,
        });
    } catch (error) {
        return {
            ...base,
            reasonCode: SHARE_REASON.CREATE_THREW,
            reasons: [...base.reasons, { code: SHARE_REASON.CREATE_THREW, detail: (error instanceof Error ? error.message : String(error)).slice(0, 160) }],
        };
    }
    const code = textOf(created?.code);
    if (created?.ok !== true) {
        const mapped = code === 'share-disabled' ? SHARE_REASON.DISABLED
            : code === 'share-queue-full' ? SHARE_REASON.QUEUE_FULL
                : code === 'unbound' ? SHARE_REASON.SCOPE_REQUIRED
                    : SHARE_REASON.CREATE_FAILED;
        return {
            ...base,
            reasonCode: mapped,
            upstream: created ?? null,
            reasons: [...base.reasons, { code: mapped, detail: `runtime 拒绝：${code || '(无 code)'}` }],
        };
    }
    if (created.duplicate === true) {
        return {
            ...base,
            ok: true,
            duplicate: true,
            candidateId: textOf(created.candidateId),
            reasonCode: SHARE_REASON.DUPLICATE,
            reasons: [...base.reasons, { code: SHARE_REASON.DUPLICATE, detail: 'runtime 侧已有同活动候选（幂等命中，未新增行）' }],
        };
    }
    return { ...base, ok: true, created: true, candidateId: textOf(created.candidateId), note: CANDIDATE_NOTE };
}

/**
 * 给 `activities.mjs` 的 `onFinished` 用的薄适配（**接线由集成负责人做**，本模块不动那边）。
 *
 * 它做三件事：把 `onFinished` 的 info 投影成本模块的 `activity` 形状；把 `doneness` 判成
 * `done|failed|abandoned`（B站的 `consumedPrefix` 是 watched 数，不是秒数）；永不抛。
 *
 * `now`/`history`/`evidence` 由调用方注入（**没有**内部时钟，也没有内部 IO）。
 */
export function createFinishedActivityShareHook({ cognitive, config, sessionId = '', scopeKey = '', now, history, evidenceFor, onDecision } = {}) {
    if (!cognitive || typeof cognitive !== 'object') {
        return () => ({ ok: false, code: 'runtime-not-mounted', note: '分享钩子未装配：cognitive 不可用' });
    }
    return info => {
        try {
            const at = finiteOr(typeof now === 'function' ? now() : now, 0) || finiteOr(info?.at, 0);
            const phase = textOf(info?.phase);
            const activity = {
                activityId: info?.activityId ?? '',
                kind: info?.kind ?? 'bilibili',
                reality: info?.reality ?? '',
                status: phase === 'finished' ? 'done' : (phase === 'abandoned' ? 'abandoned' : (phase === 'failed' ? 'failed' : '')),
                endedAt: finiteOr(info?.at, at),
                updatedAt: finiteOr(info?.at, at),
                checkpoint: info?.checkpoint ?? {},
            };
            const evidence = typeof evidenceFor === 'function' ? evidenceFor(info) : undefined;
            const produced = produceCandidateForFinishedActivity({
                cognitive, config, sessionId: info?.sessionId ?? sessionId,
                scopeKey: info?.scopeKey ?? scopeKey,
                activity, evidence, now: at, history,
            });
            if (typeof onDecision === 'function') {
                try { onDecision(produced); } catch { /* observer only */ }
            }
            return produced;
        } catch (error) {
            return { ok: false, code: 'share-hook-threw', reason: (error instanceof Error ? error.message : String(error)).slice(0, 160), note: CANDIDATE_NOTE };
        }
    };
}

export default {
    SHARE_REASON,
    REASON_CLASS,
    DEFAULT_DECISION_CONFIG,
    CANDIDATE_NOTE,
    decideShare,
    produceCandidateForFinishedActivity,
    createFinishedActivityShareHook,
    deriveBilibiliEvidence,
    bilibiliVideoUrl,
};
