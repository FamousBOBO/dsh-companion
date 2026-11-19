// 回合驱动：把一条入站消息变成一轮对话，并抓住"它到底回复了没有"。
//
// **决定（2026-11-17 确认，不推翻）**：模型必须显式调用 `vc_message`，适配层不代发。
//
// 为什么不是代发：代发（`onIdle` 直接取最后一段文本发送）省一个工具，但那条路永远做不到
// "分两次说"——先说"我查一下"再发结果。显式调用让"说了什么"有回执可查，也让进度提示成为可能。
//
// 但显式调用有一个必然的失败模式：**模型答在本地、没调工具**。所以这里装三道：
//
//   1. 回合监听（`agent/assistant-stream`）：记录本轮是否出现正文、是否出现过工具调用
//   2. 提交判定（`end` 帧 `outcome.kind === 'committed' && eventType === 'assistant/message'`）
//   3. 兜底纠正（`agent/turn-stopping`）：满足全部条件时，注入**一次**提醒，不重放任何工具
//
// 判据逐条照 `DmDeliveryGuard.observe`（28 行，语义已实测）。三处差异必须说清：
//
//   - QQ 的守卫只管 DM；VoceChat 的守卫**频道与私聊都用**。理由：VoceChat 里频道就是
//     "和一个朋友的小房间"，答在本地不发送的失败模式和 DM 完全一样，而 QQ 群有 @ 触发与
//     多人语境，抑制了"必须每条都发"的期望。这个差别是有意的，不是漏抄。
//   - `toolVisible` 判定改成"本会话作用域里 vc_message 是否可见"。不可见就不纠正——
//     否则会要求模型调用一个不存在的工具，那比不纠正更糟。
//   - 纠正文本里**带房间目标**是从会话 id 反解出来的，不来自模型；模型手里仍然没有目标号。
//
// ── 2026-11-18 增补：群里沉默合法（`allowCorrection`）──────────────────────
//
// 上面第 16–18 行原来说"频道与私聊都用守卫"。群聊这条链路做完之后这句话不成立了：
//
//   私聊    一对一，对方发消息就是找你说话。答在本地不发送 = 事故，必须纠正一次。
//   频道    多人在场，被触发只是"这一刻可以说话"，说完不说都正常。群里每一轮都逼它
//           必须发言，结果是"每句都接"，那正是群聊里最像机器人的行为。
//
// 所以 `allowCorrection` 成了一个**按房间**的参数：`vc-chan-*` 传 false。
// 不纠正不等于不记账：`onSilence` 让"模型决定不说"在 sent-log 里留一行 `model-silence`，
// 与"纠正失败/未送达"分开可查。没有这一行，"她没说话"永远查不出是设计的还是坏的。

const CORRECTIONS = Symbol.for('companion.vocechat-corrections.v1');

/** Per-agent-turn observation state. Mirrors the fields QQ's guard tracks. */
export function createTurnObserver({
  onCorrection, isToolVisible, correctionText,
  // 默认 true：老调用方（以及私聊）语义不变。只有群聊显式关掉。
  allowCorrection = () => true,
  // 群聊里"本可以说但决定不说"的落点。可选：没有它时只记 state，不写账本。
  onSilence = null,
} = {}) {
  let turn = -1;
  let sawText = false;
  let calledTool = false;
  let corrected = false;
  let committed = false;
  let textTail = '';
  /** 本轮是否已经为「沉默」记过账，保证一轮最多一行。 */
  let silenceNoted = false;

  return {
    observe(frame) {
      if (!frame || typeof frame !== 'object') return;
      if (frame.type === 'start') {
        if (frame.turn !== turn) {
          turn = frame.turn ?? -1;
          sawText = false;
          calledTool = false;
          corrected = false;
          textTail = '';
          silenceNoted = false;
        }
        committed = false;
      }
      const chunk = frame.chunk;
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.trim()) {
        sawText = true;
        // Keep a short tail only; the full text is the harness's business, not ours.
        textTail = `${textTail}${chunk.text}`.slice(-120);
      }
      // `reasoning-delta` must never count as text: a model that reasons and then answers locally
      // would otherwise look like it had something to deliver. This is a measured trap, not theory.
      if (chunk?.type === 'block-start' && chunk.blockType === 'tool-call') calledTool = true;
      if (frame.type === 'end') {
        committed = frame.outcome?.kind === 'committed' && frame.outcome?.eventType === 'assistant/message';
      }
    },

    /**
     * Called on `agent/turn-stopping`. Returns true when a correction was requested.
     *
     * Every condition is required; any one missing means "stay silent".
     *
     * `agent` comes from the event payload, not from a closure. That matters: during a fresh
     * `create` or a `resume`, the setup callback runs **before** the agent is published, so the
     * only live reference available at hook-install time is `null`. `turn-stopping` carries the
     * real agent, which is also the object `inject` must be called on.
     */
    maybeCorrect(agent = null) {
      if (typeof onCorrection !== 'function') return false;
      if (corrected) return false;
      // 「有正文、没调工具、已提交」是两条路共同的前提：群聊里它意味着"她想说但没说出去"，
      // 私聊里意味着"她要说的没发出去"。判据不变，处理方式分档。
      if (!committed || !sawText || calledTool) return false;
      let visible = false;
      try { visible = isToolVisible() === true; } catch { visible = false; }
      if (!visible) return false;

      let permitted = true;
      try { permitted = allowCorrection() !== false; } catch { permitted = true; }
      if (!permitted) {
        // 群里：沉默合法。记一行便于运维区分「设计的沉默」与「坏掉的发送」。
        if (!silenceNoted && typeof onSilence === 'function') {
          silenceNoted = true;
          try { onSilence({ agent, turn, textTail }); } catch { /* 记账不能反过来打断回合 */ }
        }
        return false;
      }

      corrected = true;
      const text = typeof correctionText === 'function' ? String(correctionText() ?? '') : String(correctionText ?? '');
      if (text.trim() === '') return false;
      onCorrection(text, agent);
      return true;
    },

    /** For diagnostics: what the observer believes right now. */
    state() {
      return { turn, sawText, calledTool, corrected, committed, textTail, silenceNoted };
    },

    reset() {
      turn = -1;
      sawText = false;
      calledTool = false;
      corrected = false;
      committed = false;
      textTail = '';
      silenceNoted = false;
    },
  };
}

export { CORRECTIONS };
