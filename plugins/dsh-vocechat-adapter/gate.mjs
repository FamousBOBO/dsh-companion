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

const MAX_TEXT = 64 * 1024;

/** Normalize a list of ids that may arrive as numbers, numeric strings, or JSON. */
export function idList(value) {
  const raw = value === undefined || value === null ? [] : value;
  const items = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
  const out = new Set();
  for (const item of items) {
    const n = Number(String(item).trim());
    if (Number.isInteger(n) && n >= 1) out.add(n);
  }
  return out;
}

/**
 * @param {object} input
 * @param {Set<number>} input.allowUsers
 * @param {Set<number>} input.allowGroups
 * @param {number} input.selfUid
 * @param {number} [input.dmPolicy] not used yet; DMs are gated by allowUsers alone
 */
export function createGate({ allowUsers, allowGroups, selfUid } = {}) {
  const users = allowUsers instanceof Set ? allowUsers : idList(allowUsers);
  const groups = allowGroups instanceof Set ? allowGroups : idList(allowGroups);
  const self = Number(selfUid) || 0;

  /**
   * @param {object} event normalized event from the transport
   * @returns {{allow: boolean, reason: string}}
   */
  function decide(event) {
    if (!event || typeof event !== 'object') return { allow: false, reason: 'no-event' };

    // Rule 4 first: a non-chat event is not a message, so no other rule applies.
    if (event.kind !== 'chat') return { allow: false, reason: `kind:${event.kind ?? 'missing'}` };

    // Rule 3: our own message. Cheap, and it protects against a platform that echoes.
    const from = Number(event.fromUid);
    if (!Number.isInteger(from) || from < 1) return { allow: false, reason: 'no-sender' };
    if (self > 0 && from === self) return { allow: false, reason: 'from-self' };

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

    // Rule 5 is the caller's job (it owns the seen set), but the payload sanity check is here:
    // an empty or absurd message must not start a turn.
    const text = String(event.content ?? '');
    if (text.trim() === '') return { allow: false, reason: 'empty-text' };
    if (text.length > MAX_TEXT) return { allow: false, reason: 'text-too-large' };

    return { allow: true, reason: 'ok' };
  }

  /** A copy for `info()`, with no secrets and no message bodies. */
  function describe() {
    return {
      allowUsers: [...users].sort((a, b) => a - b),
      allowGroups: [...groups].sort((a, b) => a - b),
      selfUid: self,
      // The single most important line for an operator debugging "why is nothing happening".
      failClosed: users.size === 0,
    };
  }

  return { decide, describe };
}

export { MAX_TEXT };
