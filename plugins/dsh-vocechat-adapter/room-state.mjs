// 房间状态：每个房间的「我看到哪了」与「我说到哪了」。
//
// ── 两个水位，不是一回事（2026-11-19 实测后修正）──────────────────────────
//
// 最初只有一个 `lastSentMid`（我最后**发出**的那条），拿它当"自上次回复以来"的界。
// 私聊里这个近似成立：一对一时，我说完话之后对方再说，界正好落在中间。
//
// **群里不成立。** 实测（2026-11-19，gid=1，实例甲 uid=4 / 实例乙 uid=5）：
//
//   实例乙说 1148-1150 → 实例甲看到并回了 1151-1153 → 水位推进到 1153
//   → 主人问"实例乙刚才说她今天干嘛了"
//   → 实例甲的上下文按 1153 过滤 → 实例乙那三条**全被挡掉** → 她答"没看着她说啊"
//
// 那些话她明明看过并回应过。错在把"我说到哪"当成了"我看到哪"：
// 一旦我发言，水位就越过了别人在我**发言之前**说的话。
//
// 所以现在两个字段各管一件事：
//
//   `lastHandledMid`  我**看到**哪了 → 频道上下文的下界（跨回合累积）
//   `lastSentMid`     我**说到**哪了 → 只用于诊断（"这个房间多久没说话了"）
//
// 上下文用 `lastHandledMid`，含义正是"自上次回复以来"：两次回合之间发生的所有事，
// 包括同伴说的、包括我自己说的（自己说的会标「你自己」，那是有用的信息，不该藏）。
//
// 为什么必须落盘：宿主重启是常态（升级、崩溃、手工重启）。放内存里，重启一次上下文断一次。
//
// 为什么不是从 `sent-log.jsonl` 现算：账本按 2 MB 轮转，历史会被改名；而且它记的是"发送尝试"，
// 判据比这里复杂得多。状态文件只回答两个问题，读它是 O(1)。
//
// 写入纪律：
//   - **原子替换**（写 `.tmp` 再 `rename`），与 `store.mjs` 的持久化风格一致；
//   - 失败只记日志、不抛：水位更新失败的表现是"上下文少一段"，不该让一条消息发不出去；
//   - 两个水位都**只增不减**：SSE 重投或乱序不能让它们倒退（倒退等于把已处理过的又当新的）。

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {object} input
 * @param {string} input.dataRoot  绝对路径（`.../data`）
 * @param {(line: string) => void} [input.log]
 */
export function createRoomState({ dataRoot, log = null } = {}) {
  const root = String(dataRoot ?? '').trim();
  if (!root || !path.isAbsolute(root)) throw new Error('createRoomState: dataRoot 必须是绝对路径');

  const dir = path.join(root, 'home', 'vocechat-adapter');
  const file = path.join(dir, 'rooms.json');
  const say = line => {
    if (typeof log !== 'function') return;
    try { log(line); } catch { /* 日志不能反过来打断状态更新 */ }
  };

  /** room → {lastSentMid, lastTurnAt, lastReplyAt} */
  let state = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed;
  } catch {
    // 文件不存在是正常的第一次启动；坏文件也不该拦住插件挂载（水位退化为"没有"）。
  }

  let writable = true;

  function persist() {
    if (!writable) return false;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
      fs.renameSync(tmp, file);
      return true;
    } catch (error) {
      writable = false;
      say(`rooms.json 写入失败（后续不再尝试）：${String(error?.message ?? error).slice(0, 160)}`);
      return false;
    }
  }

  function entryOf(room) {
    const key = String(room ?? '');
    if (key === '') return null;
    if (!state[key] || typeof state[key] !== 'object') state[key] = {};
    return state[key];
  }

  return {
    /**
     * 频道上下文的下界：**我看到了哪一条**。
     *
     * 没有返回 null（渲染层据此换成"最近说过这些话"）。
     * 兼容：老文件里只有 `lastSentMid`，把它当 `lastHandledMid` 读一次 —— 单实例单房间时
     * 两者恰好相等，所以老状态不会让上下文凭空消失。
     */
    watermarkOf(room) {
      const entry = state?.[String(room ?? '')];
      const handled = Number(entry?.lastHandledMid);
      if (Number.isInteger(handled) && handled > 0) return handled;
      const legacy = Number(entry?.lastSentMid);
      return Number.isInteger(legacy) && legacy > 0 ? legacy : null;
    },

    /**
     * 记"我已经看过这一批了"。回合开始时调用，界推进到这一批的最后一条。
     *
     * **这是上下文能不能跨回合连续的关键。** 只在"发出去了"时推进是不够的（模型可能决定
     * 沉默），也不能用发送的 mid 代替（那会越过别人在此之前说的话）。
     *
     * @returns {boolean} 是否真的推进了
     */
    noteHandled(room, mid, { at = Date.now() } = {}) {
      const value = Number(mid);
      if (!Number.isInteger(value) || value <= 0) return false;
      const entry = entryOf(room);
      if (!entry) return false;
      const previous = Number(entry.lastHandledMid);
      if (Number.isInteger(previous) && previous >= value) { persist(); return false; }
      entry.lastHandledMid = value;
      entry.lastHandledAt = at;
      persist();
      return true;
    },

    /**
     * 记一次成功发送。`mid` 是平台返回的消息 id，可能为 null（平台答 200 无 body）。
     *
     * 它**不再**决定上下文的下界（那是 `lastHandledMid` 的事），只作为运维事实：
     * "这个房间最后说话是哪一条、什么时候"。
     *
     * @returns {boolean} 是否真的推进了
     */
    noteSent(room, mid, { at = Date.now() } = {}) {
      const value = Number(mid);
      if (!Number.isInteger(value) || value <= 0) return false;
      const entry = entryOf(room);
      if (!entry) return false;
      const previous = Number(entry.lastSentMid);
      // 只增不减：重投/乱序不许让水位倒退。
      if (Number.isInteger(previous) && previous >= value) {
        entry.lastReplyAt = at;
        persist();
        return false;
      }
      entry.lastSentMid = value;
      entry.lastReplyAt = at;
      persist();
      return true;
    },

    /** 记一轮被驱动过（用于运维判断"这个房间还活着吗"）。 */
    noteTurn(room, { at = Date.now() } = {}) {
      const entry = entryOf(room);
      if (!entry) return false;
      entry.lastTurnAt = at;
      return persist();
    },

    /** 诊断用：两个水位都报，不带正文（本来也不存正文）。 */
    info() {
      const rooms = Object.keys(state);
      return {
        rooms: rooms.length,
        watermarks: Object.fromEntries(rooms.map(room => [room, this.watermarkOf(room)])),
        sentMarks: Object.fromEntries(rooms.map(room => [room, Number(state[room]?.lastSentMid) || null])),
        writable,
        file,
      };
    },

    file,
  };
}
