// 门控：一条事件能不能驱动模型。
//
// **fail-closed 是硬要求**（评审定的）：`allowUsers` 为空数组时插件照常收事件、
// 照常落盘，但适配层一条都不交给模型。理由不是"保守"，而是一个具体的失败模式：
// 数组写错、字段名拼错、profile 里漏了一段，从容的结果是"全世界都能驱动你的模型"，
// 而严格的结果只是"没反应"——后者可以查日志修，前者不可撤销。
//
// 五条规则，每条对应一个真实会发生的输入：
//
//   1. `fromUid ∈ allowUsers`          — 白名单，空 = 谁都不触发
//   2. 频道事件 `target.channel ∈ allowGroups` — 同上
//   3. `fromUid == selfUid`            — 丢弃。平台理论上不回声，但不依赖平台
//   4. `kind !== 'chat'`               — 丢弃。未知类型不猜语义
//   5. `mid` 已处理                    — 交付层的幂等兜底（成本几乎为零）
//
// ── 2026-11-18 增补：频道（群聊）分两档 ────────────────────────────────────
//
// 私聊只有一个人，`allowUsers` 白名单是对的；频道里有好几个人，同一条规则会把
// 「群里其他人说话」全部拒掉（实测：`allowUsers:[1]` 时 uid 2/4/5 的消息全落
// `user-not-allowed`）。但把白名单去掉又会让"任何人都能驱动模型"成立。
//
// 所以频道另走一条判定（`decideChannel`），三个判据替代白名单：
//   1. 频道在 `allowGroups` 里（沿用，无变化）
//   2. 发送者是**该频道的成员**（成员表来自 `GET /api/group/{gid}` 的 `members`）
//   3. 掷一次骰子：`roll() < talkProbability` 才驱动（群聊不该每一句都插话）
//
// **成员表取不到时 fail-closed**：退回只放行 `allowUsers`，并给出原因
// `members-unavailable`。这一条不是防御性代码，而是必然会发生的情况——403（Bot 不是
// 成员）、断网、token 过期都会让成员表读不到，而那时"大家都不能驱动"比"全世界都能"
// 好得多。
//
// 概率之所以在门控层而不是在提示词里：提示词让模型"自己决定说不说"时，它仍然会被
// 驱动一轮（真实模型调用、真实 token、真实延迟），只是最后不发消息。群聊里被点名的
// 概率是"要不要开始想"，不是"想完了要不要说"——后者见 `turns.mjs` 的沉默路径。

const MAX_TEXT = 64 * 1024;

/** Normalize a list of ids that may arrive as numbers, numeric strings, JSON, or a Set. */
export function idList(value) {
  const raw = value === undefined || value === null ? [] : value;
  // **必须认 Set/迭代器。** `resolveGroup` 是幂等的（`createGate` 会拿它自己的产物再跑一遍），
  // 而它的产物里 `peerBots` 是 `Set`。`Array.isArray(Set)` 是 false，于是会落到
  // `String(set)` = `"[object Set]"` 这条分支上，解析出空集合 —— 表现是"配置里明明写了
  // peerBots，日志里却是 `peerBots: []`，两个实例照样互相点火"。实测踩过一次。
  const items = Array.isArray(raw)
    ? raw
    : (typeof raw === 'object' && typeof raw[Symbol.iterator] === 'function')
      ? [...raw]
      : String(raw).split(/[,\s]+/);
  const out = new Set();
  for (const item of items) {
    const n = Number(String(item).trim());
    if (Number.isInteger(n) && n >= 1) out.add(n);
  }
  return out;
}

/**
 * 频道（群聊）档的配置。
 *
 * `talkProbability` 默认 0.3：群里三句话接一句。0 = 群里永不主动开口（只记不驱动），
 * 1 = 有成员说话就驱动。默认值可被 profile 整段替换。
 *
 * `segmentation` 与 `allowCorrection` 在这里读出并原样带出去，是为了让"群聊这一档"
 * 只有**一个**配置入口——散成三处时，运维改了一处就以为改完了。
 *
 * ── `peerBots`：为什么必须有（2026-11-19）─────────────────────────────────
 *
 * 同一台机器上现在有两个陪伴实例（三月七 uid=4、沈幺 uid=5），**都是频道 gid=1 的成员**。
 * 成员判定会让"三月七说的话"成为沈幺的合法触发源，沈幺回的话又成为三月七的合法触发源：
 *
 *   三月七发言 → 沈幺看到（成员 4）→ 掷骰子 0.3 → 沈幺发言 → 三月七看到（成员 5）→ 0.3 → …
 *
 * 概率只能让这条链变短，**不能保证它停**。而每一环都是一次真实模型调用（真金白银 + 真延迟），
 * 群里的人看到的是两个人格突然开始自说自话。
 *
 * 所以：**另一个陪伴实例的 uid 不许触发回合**（原因码 `peer-bot:<uid>`）。
 * 那些话仍然**算上下文**——它们在平台历史里，`history.mjs` 照常取回来渲染给模型看。
 * 这个区分是整个设计的关键：同伴说的话是"资料"，不是"有人叫我"。
 *
 * 同理 `is_bot=1` 的平台机器人（旧的 companion-a uid=2）也要列进来。
 *
 * **判定顺序**：`peerBots` 在成员表之前。权衡是清楚的 —— 一个非成员的同伴会报
 * `peer-bot` 而不是 `not-a-member`，但同伴 uid 是本地配置写下的确定事实，而成员判定要
 * 走一次可能 403 的 HTTP。让确定的事实先回答，运维就不会被 403 引去查权限。
 *
 * @param {object} [raw]
 */
export function resolveGroup(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const probability = Number(input.talkProbability);
  const seg = input.segmentation && typeof input.segmentation === 'object' ? input.segmentation : {};
  const maxSegments = Number(seg.maxSegments);
  const maxChars = Number(seg.maxChars);
  const historyLimit = Number(input.historyLimit);
  const memberCacheMs = Number(input.memberCacheMs);
  return {
    enabled: input.enabled !== false,
    // 上下夹紧到 [0,1]：写了 3 或 -1 都当成边界值，而不是"永不成立"或"恒成立"的意外。
    talkProbability: Number.isFinite(probability) ? Math.min(1, Math.max(0, probability)) : 0.3,
    // 群聊上下文：自上次发言以来取多少条。
    historyLimit: Number.isInteger(historyLimit) && historyLimit > 0 ? Math.min(historyLimit, 100) : 20,
    // 成员表缓存时长。60 秒：足够挡掉"三条消息各查一次"，又不至于让新入群的人等太久。
    memberCacheMs: Number.isInteger(memberCacheMs) && memberCacheMs >= 0 ? memberCacheMs : 60000,
    // 群里沉默合法 —— 不注入兜底纠正（见 turns.mjs 的 allowCorrection）。
    allowCorrection: input.allowCorrection === true,
    // 别的陪伴实例 / 平台机器人：它们的话进上下文，但不驱动回合（防止两个实例互相点火）。
    peerBots: idList(input.peerBots),
    segmentation: {
      maxSegments: Number.isInteger(maxSegments) && maxSegments > 0 ? maxSegments : 3,
      maxChars: Number.isInteger(maxChars) && maxChars > 0 ? maxChars : 120,
      // 不给 style/minLength：那两项群聊与私聊共用，跟着顶层走，避免两处各有一套。
    },
  };
}

/**
 * @param {object} input
 * @param {Set<number>} input.allowUsers
 * @param {Set<number>} input.allowGroups
 * @param {number} input.selfUid
 * @param {ReturnType<typeof resolveGroup>} [input.group]
 */
export function createGate({ allowUsers, allowGroups, selfUid, group } = {}) {
  const users = allowUsers instanceof Set ? allowUsers : idList(allowUsers);
  const groups = allowGroups instanceof Set ? allowGroups : idList(allowGroups);
  const self = Number(selfUid) || 0;
  // `resolveGroup` 是幂等的：既吃原始配置，也吃它自己的产物。**不能**用
  // `'talkProbability' in group ? group : resolveGroup(group)` 这种"认形状"的写法 ——
  // 调用方只写 `{ talkProbability: 1 }`（不写 enabled）时，`enabled` 会是 undefined，
  // 于是整档被当成关闭、频道静默退回白名单。实测踩过一次。
  const cfg = resolveGroup(group);

  /** Rules 3 and 4 plus the payload sanity checks; shared by both paths. */
  function checkEnvelope(event) {
    if (!event || typeof event !== 'object') return { ok: false, reason: 'no-event' };
    // Rule 4 first: a non-chat event is not a message, so no other rule applies.
    if (event.kind !== 'chat') return { ok: false, reason: `kind:${event.kind ?? 'missing'}` };
    // Rule 3: our own message. Cheap, and it protects against a platform that echoes.
    const from = Number(event.fromUid);
    if (!Number.isInteger(from) || from < 1) return { ok: false, reason: 'no-sender' };
    if (self > 0 && from === self) return { ok: false, reason: 'from-self' };
    return { ok: true, from };
  }

  /** Empty/absurd payload must not start a turn. */
  function checkText(event) {
    const text = String(event.content ?? '');
    if (text.trim() === '') return { ok: false, reason: 'empty-text' };
    if (text.length > MAX_TEXT) return { ok: false, reason: 'text-too-large' };
    return { ok: true };
  }

  /** `{channel}` target shape, or null when this is not a channel event. */
  function channelOf(event) {
    const target = event?.target && typeof event.target === 'object' ? event.target : {};
    const gid = Number(target.channel);
    return Number.isInteger(gid) && gid >= 1 ? gid : null;
  }

  /**
   * The DM path — five rules, unchanged from 2026-11-17.
   *
   * @param {object} event normalized event from the transport
   * @returns {{allow: boolean, reason: string}}
   */
  function decide(event) {
    const envelope = checkEnvelope(event);
    if (!envelope.ok) return { allow: false, reason: envelope.reason };
    const from = envelope.from;

    // Rule 1: the whitelist. An empty whitelist denies everything — that is the design.
    if (!users.has(from)) return { allow: false, reason: `user-not-allowed:${from}` };

    // Rule 2: channel events also need the channel whitelisted.
    const target = event.target && typeof event.target === 'object' ? event.target : {};
    const gid = Number(target.channel);
    if (Number.isInteger(gid) && gid >= 1) {
      if (!groups.has(gid)) return { allow: false, reason: `channel-not-allowed:${gid}` };
    } else if (target.user === undefined) {
      return { allow: false, reason: 'no-target' };
    }

    // Rule 5 is the caller's job (it owns the seen set), but the payload sanity check is here.
    const text = checkText(event);
    if (!text.ok) return { allow: false, reason: text.reason };

    return { allow: true, reason: 'ok' };
  }

  /**
   * 频道路径：成员 + 概率。
   *
   * `isMember` 收**值**而不是闭包：成员表是一次真实的 async HTTP，判定必须早于这里完成。
   * 传闭包会让调用方把 Promise 传进来，而 `Promise !== true` 恒成立 —— 整个频道会被静默
   * 判成"成员表不可用"。这个坑写成注释留在这里，因为它是这一层最容易再犯的错。
   *
   * @param {object} event
   * @param {object} [options]
   * @param {boolean|null} [options.isMember]
   *        `true`/`false` 为已知事实；`null`（或缺省）= 成员表取不到（fail-closed 到 allowUsers）。
   * @param {() => number} [options.roll] 0..1 的骰子；测试注入确定性序列。
   * @returns {{allow: boolean, reason: string, gid?: number, from?: number, rolled?: number}}
   */
  function decideChannel(event, { isMember = null, roll = Math.random } = {}) {
    if (!cfg.enabled) return decide(event);

    const envelope = checkEnvelope(event);
    if (!envelope.ok) return { allow: false, reason: envelope.reason };
    const from = envelope.from;

    const gid = channelOf(event);
    if (gid === null) return decide(event); // 不是频道事件：私聊照旧
    if (!groups.has(gid)) return { allow: false, reason: `channel-not-allowed:${gid}`, gid, from };

    const text = checkText(event);
    if (!text.ok) return { allow: false, reason: text.reason, gid, from };

    // 别的陪伴实例 / 平台机器人：**它们的话进上下文，但不驱动回合**。
    //
    // 位置刻意放在成员判定**之前**：`peerBots` 是本地配置，它的结论不依赖成员表。
    // 放在后面的话，"成员表 403 + 同伴说话"会报 `members-unavailable` —— 那会把人引去查
    // 平台权限，而真正的原因是这个 uid 本来就不该触发。概率只能缩短互相点火的链条，
    // 不能让它停（尾期望永远不是 0），所以这一道必须是硬闸，也不能被"表读不到"绕过。
    if (cfg.peerBots.has(from)) return { allow: false, reason: `peer-bot:${from}`, gid, from };

    // 成员判定。`null` 不是"不是成员"，是"我不知道"——两者必须分开记，否则运维会把
    // "成员表 403" 看成"这个人不在群里"。
    if (isMember === false) return { allow: false, reason: `not-a-member:${from}`, gid, from };
    if (isMember !== true) {
      // 成员表不可用：只放行白名单里的人，且原因写清楚是"表不可用"而不是"不是成员"。
      if (!users.has(from)) return { allow: false, reason: `members-unavailable:${from}`, gid, from };
    }

    // 概率。0 = 永不主动开口（仍然落盘、仍然可查）；1 = 每句都接。
    if (cfg.talkProbability >= 1) return { allow: true, reason: 'ok', gid, from, rolled: 1 };
    let rolled = null;
    try { rolled = Number(roll()); } catch { rolled = null; }
    // 骰子坏掉（抛错 / NaN）时**接话**，不是跳过。理由是不对称：多说一句的代价是"稍微话多"，
    // 而不说的代价是"模型永远不回话"，后者在群里看起来就是彻底的故障。
    // 注意不能把兜底值写成 1 —— `rolled >= probability` 在概率 0.5 时会把 1 判成"跳过"，
    // 兜底方向恰好反了。实测踩过一次。
    if (!Number.isFinite(rolled)) return { allow: true, reason: 'ok', gid, from, rolled: null };
    if (rolled >= cfg.talkProbability) {
      return { allow: false, reason: `chance-skip:${cfg.talkProbability}`, gid, from, rolled };
    }
    return { allow: true, reason: 'ok', gid, from, rolled };
  }

  /** A copy for `info()`, with no secrets and no message bodies. */
  function describe() {
    return {
      allowUsers: [...users].sort((a, b) => a - b),
      allowGroups: [...groups].sort((a, b) => a - b),
      selfUid: self,
      // The single most important line for an operator debugging "why is nothing happening".
      // 注意：这只是**私聊**的 fail-closed 判据。频道另有成员表兜底，见 group 段。
      failClosed: users.size === 0,
      group: {
        enabled: cfg.enabled,
        talkProbability: cfg.talkProbability,
        historyLimit: cfg.historyLimit,
        memberCacheMs: cfg.memberCacheMs,
        allowCorrection: cfg.allowCorrection,
        peerBots: [...cfg.peerBots].sort((a, b) => a - b),
        maxSegments: cfg.segmentation.maxSegments,
        maxChars: cfg.segmentation.maxChars,
      },
    };
  }

  return { decide, decideChannel, describe, group: () => cfg };
}

export { MAX_TEXT };
