// 发送账本：谁在什么时候发了什么到哪个房间，以及**有没有送达**。
//
// 这个文件存在的唯一理由：`vc_message` 是模型显式调用的工具，"没调用"和"调用了但失败"是
// 两种完全不同的失败，而两者在会话里长得一模一样（都是"没有回复"）。有账本才能回答
// "昨晚那条为什么没出去"。
//
// 记什么：
//   - 每次发送尝试（含结果 mid）、每次进度提示、每次兜底纠正
//   - 每轮被拒绝驱动的入站消息（门控拒绝、队列满、超时）——它们不带正文，只带 mid
//
// 不记什么：
//   - 消息正文全文。只留前 60 字，够定位，不够泄密。
//
// 落盘位置：`<dataRoot>/home/vocechat-adapter/sent-log.jsonl`，按大小轮转一次。
// 用 append + 批量 `fsync` 交替：账号对账不该成为每条消息的成本，但崩溃后要能读回。

import fs from 'node:fs';
import path from 'node:path';

const ROTATE_BYTES = 2 * 1024 * 1024;
const PREVIEW_CHARS = 60;

export function createSentLog({ dataRoot, rotateBytes = ROTATE_BYTES } = {}) {
  const root = String(dataRoot ?? '').trim();
  if (!root || !path.isAbsolute(root)) {
    throw new Error('createSentLog: dataRoot 必须是绝对路径');
  }

  const dir = path.join(root, 'home', 'vocechat-adapter');
  const file = path.join(dir, 'sent-log.jsonl');
  let writable = true;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    writable = false;
  }

  function rotateIfLarge() {
    if (!writable) return;
    try {
      const size = fs.statSync(file).size;
      if (size < rotateBytes) return;
      fs.renameSync(file, `${file}.1`);
    } catch {
      // A missing file (first write) is normal; a rotation failure must not stop logging.
    }
  }

  function append(record) {
    if (!writable) return false;
    try {
      rotateIfLarge();
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
      return true;
    } catch {
      writable = false;
      return false;
    }
  }

  function preview(text) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value.length <= PREVIEW_CHARS ? value : `${value.slice(0, PREVIEW_CHARS)}…`;
  }

  return {
    /** A send that reached the platform (or failed trying). */
    sent({ room, target, mid = null, text = '', phase = 'final', ok = true, error = null, segment = 0, of = 0 }) {
      return append({
        at: Date.now(), kind: 'sent', room, target, mid, phase,
        ok, chars: String(text ?? '').length, preview: preview(text),
        // 分段上下文：这是第几段、一共几段。没有它，"这条为什么只发了一半"查不出来。
        ...(segment ? { segment, of } : {}),
        ...(error ? { error: String(error).slice(0, 160) } : {}),
      });
    },

    /** One inbound message we deliberately did not hand to the model. */
    skipped({ room, mid, reason, fromUid = 0 }) {
      return append({ at: Date.now(), kind: 'skipped', room, mid, reason: String(reason).slice(0, 80), fromUid });
    },

    /** A turn that started for `mid`, so a later "no reply" is auditable. */
    turnStarted({ room, mid, resumed, created, mids = null, batched = 0 }) {
      return append({
        at: Date.now(), kind: 'turn-start', room, mid, resumed, created,
        // 攒批：`mid` 是这一批的最后一条，`mids` 是这一批的全部。
        // 有它才能回答"这轮为什么答了一整段话"—— 因为那是三四条消息合起来的意思。
        ...(mids && mids.length > 1 ? { mids, batched } : {}),
      });
    },

    /** A turn that produced no delivery — the case this log exists for. */
    undelivered({ room, mid, reason }) {
      return append({ at: Date.now(), kind: 'undelivered', room, mid, reason: String(reason).slice(0, 120) });
    },

    file,
    writable: () => writable,
  };
}
