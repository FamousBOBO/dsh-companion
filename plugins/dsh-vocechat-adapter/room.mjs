// 房间键：VoceChat 事件 ↔ DSH 会话 id 的**唯一**映射。
//
// 纯函数、零 IO，这样它可以被测试重放，也可以在门控、会话、工具三处共用而不产生漂移。
//
// 格式（一旦定下不再改 —— 改它等于丢掉所有历史）：
//
//   频道：vc-chan-<gid>      例 vc-chan-1
//   私聊：vc-dm-<uid>        例 vc-dm-1     ← uid 是**对方**（发送者），不是自己
//
// 私聊为什么用发送者：一条私聊进来时，`target` 是 `{uid: 自己}`，`fromUid` 才是对方。
// 若用 target 的 uid 建房间，所有私聊都会挤进同一个 `vc-dm-<自己>` 房间，等于把不同的人
// 混成一团对话。用 fromUid 才是"和谁在聊"。
//
// 命名空间（G5 多实例）：
//   `vc-<ns>-chan-<gid>`  /  `vc-<ns>-dm-<uid>`
// 插入位置固定在 `vc-` 之后，所以解析时按 `/<ns>` 的可选前缀读，其余不变。

const ROOM_PATTERN = /^vc-(?:([a-z0-9-]{1,16})-)?(chan|dm)-(\d+)$/;

/** A room in the form the harness uses as a session id. */
export function roomKeyOf({ target = null, fromUid = 0, namespace = '' } = {}) {
  const ns = cleanNamespace(namespace);
  const prefix = ns ? `vc-${ns}` : 'vc';
  const t = target && typeof target === 'object' ? target : {};
  const gid = Number(t.channel);
  if (Number.isInteger(gid) && gid >= 1) return `${prefix}-chan-${gid}`;
  const uid = Number(t.user);
  // The DM room belongs to the *other* party. `target.user` is ourselves; `fromUid` is them.
  if (Number.isInteger(uid) && uid >= 1) {
    const peer = Number(fromUid);
    if (!Number.isInteger(peer) || peer < 1) return null;
    return `${prefix}-dm-${peer}`;
  }
  return null;
}

/** `{kind, id, namespace}` or null. The inverse of `roomKeyOf`. */
export function describeRoom(room) {
  const match = ROOM_PATTERN.exec(String(room ?? ''));
  if (!match) return null;
  const id = Number(match[3]);
  if (!Number.isInteger(id) || id < 1) return null;
  return { namespace: match[1] ?? '', kind: match[2], id };
}

/** The send target for a room. This is what the tool will use, so the model never names one. */
export function targetOfRoom(room) {
  const info = describeRoom(room);
  if (!info) return null;
  return info.kind === 'chan' ? { channel: info.id } : { user: info.id };
}

/** `true` when the id looks like one of ours (used to decide which agent hook to install). */
export function isVoceChatRoom(value, namespace = '') {
  const info = describeRoom(value);
  if (!info) return false;
  const ns = cleanNamespace(namespace);
  return info.namespace === ns;
}

/** A DM room's peer uid, or 0 for a channel/non-room. */
export function dmPeerOf(room) {
  const info = describeRoom(room);
  return info && info.kind === 'dm' ? info.id : 0;
}

function cleanNamespace(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16);
}

export { ROOM_PATTERN };
