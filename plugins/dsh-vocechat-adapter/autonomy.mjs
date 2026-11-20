// 频道（群聊）的**自主链路**：旁听 → 定时判断 → 发言闸门 → 发送。
//
// 为什么需要它（2026-11-20）：这一层原来只有「掷骰子」（`gate.mjs` 的
// `decideChannel` 里的 `talkProbability`）。骰子回答的是「这一句接不接」，
// 不是「这一句**该不该**接」——它对这个群在聊什么一无所知。
// QQ 那条链路早就有完整的一套（`dsh-channel-qq` 的 `GroupPresence`：恰听缓冲、
// 定时判断、决策表、限频闸门），这里把**同样的形状**搬到 VoceChat，
// 判断本身复用 QQ 插件发布的 `companionJudge` 端口（见 `judge-link.mjs`）。
//
// 五条与 QQ 对齐的口径（逐条都有理由）：
//
//   1. **旁听 ≠ 驱动。** 频道里每条消息都进 ring，但**不是每条都驱动一轮回合**。
//      这正是「掷骰子」与「判断」的根本差别：前者在事件到达时掷，后者等一小段时间、
//      看清楚这一段话在说什么之后再决定。所以 ring 只存不改，判断由定时器发起。
//   2. **判断之前先让路。** 如果刚刚有一轮回合在跑（或刚结束不到
//      `quietAfterTurnMs`），这一轮判断跳过——否则会出现「她刚回完一句，
//      三秒后又自己补一句」。群里最像机器人的行为就是这个。
//   3. **说话要过三道闸。** `speakMinIntervalMs`（两次自主发言的最小间隔）、
//      `speakMaxPerHour`（每小时额度）、`replyMaxChars`（字数上限）。
//      闸门在**发送前**判，不在提交判断前判——判断是免费的（本地）或很便宜（云端），
//      而说错话是不可撤销的。
//   4. **`silent` 不占额度。** 不说话是正常结论，不该消耗「每小时能说几句」。
//      只有真的发出去才 `noteSpoke()`。
//   5. **影子模式只写不扔。** `mode === 'shadow'` 时判断照跑、结论落盘，一句都不发。
//      落盘格式与 QQ 的 `logs/presence-shadow.jsonl` 一致，方便两个通道一起盲评。
//
// 这个文件**不读时钟、不读文件、不发送**：全部从参数进来（`clock` / `append` / `send`）。
// 这样单测可以精确推进时间、断言落盘内容，而不需要真的等一分钟或连平台。

/** 一条旁听（与 QQ 的 `JudgeEntry` / `JudgeLine` 同形，只留判断用得上的字段）。 */
function lineOf(event, selfUid) {
  const fromUid = Number(event?.fromUid);
  const mid = Number(event?.mid);
  const createdAt = Number(event?.createdAt);
  return {
    messageId: Number.isInteger(mid) && mid > 0 ? mid : null,
    name: '',
    userId: Number.isInteger(fromUid) && fromUid >= 0 ? fromUid : 0,
    text: typeof event?.content === 'string' ? event.content : '',
    self: Number.isInteger(fromUid) && fromUid === selfUid,
    atMs: Number.isFinite(createdAt) ? createdAt : 0,
  };
}

/** 旁听缓冲：只留最近若干条、总字数不超上限、过期即丢。 */
export function createAmbient({ maxEntries = 40, maxChars = 6000, ttlMs = 600000, selfUid = 0 } = {}) {
  /** @type {ReturnType<typeof lineOf>[]} */
  let rows = [];

  return {
    observe(event, nowMs) {
      const line = lineOf(event, selfUid);
      if (line.text.trim() === '') return;
      rows.push(line);
      // 过期清理：`atMs` 已经给出，不需要读时钟（`nowMs` 由调用方给）。
      // `atMs <= 0` 是"时间未知"，两个清理点都按同一条规则保留它 —— 否则同一条消息
      // 在 `observe` 里被丢掉、却又能在 `lines` 里留下，两个入口的判断口径就不一致了。
      const floor = Number.isFinite(nowMs) ? nowMs - ttlMs : null;
      if (floor !== null) rows = rows.filter((row) => row.atMs <= 0 || row.atMs >= floor);
      if (rows.length > maxEntries) rows = rows.slice(rows.length - maxEntries);
      let chars = rows.reduce((sum, row) => sum + [...row.text].length, 0);
      while (rows.length > 1 && chars > maxChars) {
        chars -= [...rows[0].text].length;
        rows = rows.slice(1);
      }
    },
    /**
     * 当前这一批（按时间正序）。
     *
     * **过期清理在这里也做一遍**（2026-11-20 实测的真故障）：原来只在 `observe` 里清，
     * 于是"群里没人说话"时 `observe` 根本不被调到，环里的旧话题就**永远**不走。
     * 后果是判断每分钟都看见同一段 22:35 的技术讨论，一直判成 `unanswered-help`，
     * 而短语冷却一到点就再发一遍「后来是怎么解决的？」——群里看到的就是同一句话反复弹。
     *
     * 读的时候按**调用方给的** `nowMs` 清，判据仍是不读时钟（单测能精确推进时间）。
     * 传了 `nowMs` 才清：不传就原样返回（老调用点不会因为漏传而少看到东西）。
     * `atMs <= 0` 的行当"时间未知"保留 —— 静默丢掉一条证据比多留一条糟得多。
     */
    lines(nowMs) {
      if (Number.isFinite(nowMs)) {
        const floor = nowMs - ttlMs;
        rows = rows.filter((row) => row.atMs <= 0 || row.atMs >= floor);
      }
      return rows.slice();
    },
    /** 判断之后要不要清？**不清**：一条消息会在相邻几轮里都算上下文，
     *  这与 QQ 的 ring 一致（清掉就等于「每轮都从空白开始猜」）。 */
    size() { return rows.length; },
    reset() { rows = []; },
  };
}

/**
 * 发言闸门：四道，顺序即优先级。
 *
 * 返回值 `{ allow, reason }`；`reason` 一律进账本，因为「她这一轮为什么没说」
 * 是运维最先问的问题。
 *
 * 第四道（`phraseRepeatWithinMs`）是 2026-11-20 实测补的：短语库只有 13 条，
 * 而同一段 state 上的判断是**稳定**的——tech 场景会一直选同一条 `ask_more`。
 * 三道原有闸门都放行（5 分钟正好是 `speakMinIntervalMs`），于是群里连着出现
 * 三遍"后来是怎么解决的？"。所以这里给**同一句**加一道冷却：重复不开口，
 * 比换个说法更安全（短语是人写的，临时生成会破"不经生成"的那条硬规矩）。
 */
export function createSpeakGate({
  speakMinIntervalMs = 300000,
  speakMaxPerHour = 3,
  replyMaxChars = 70,
  phraseRepeatWithinMs = 1_800_000,
} = {}) {
  let lastSpokeAt = null;
  /** 过去一小时的发言时刻（滚动窗口）。 */
  let stamps = [];
  /** 最近说过的句子（正文 → 时刻）：用来挡"同一句连着说"。 */
  const said = new Map();

  return {
    allow({ text, nowMs }) {
      const chars = [...String(text ?? '')].length;
      if (chars <= 0) return { allow: false, reason: 'empty-text' };
      if (replyMaxChars > 0 && chars > replyMaxChars) {
        return { allow: false, reason: `text-too-long:${chars}>${replyMaxChars}` };
      }
      // @ 与 CQ 码：正文是短语库（人写的），但配置可以改，而「发出去才发现要 @ 人」
      // 是不可撤销的。与 QQ 的发送侧同一个口径。
      if (/@|\[cq:/i.test(String(text))) return { allow: false, reason: 'mention' };
      if (lastSpokeAt !== null && nowMs - lastSpokeAt < speakMinIntervalMs) {
        return { allow: false, reason: `speak-cooldown:${nowMs - lastSpokeAt}<${speakMinIntervalMs}` };
      }
      const floor = nowMs - 3_600_000;
      stamps = stamps.filter((stamp) => stamp >= floor);
      if (stamps.length >= speakMaxPerHour) {
        return { allow: false, reason: `hour-quota:${stamps.length}/${speakMaxPerHour}` };
      }
      if (phraseRepeatWithinMs > 0) {
        const previous = said.get(String(text));
        if (previous !== undefined && nowMs - previous < phraseRepeatWithinMs) {
          return { allow: false, reason: `phrase-repeat:${nowMs - previous}<${phraseRepeatWithinMs}` };
        }
      }
      return { allow: true, reason: 'ok' };
    },
    /** 真的发出去之后才记账（`silent` 不占额度）。 */
    noteSpoke(nowMs, text = '') {
      lastSpokeAt = nowMs;
      stamps.push(nowMs);
      const floor = nowMs - 3_600_000;
      stamps = stamps.filter((stamp) => stamp >= floor);
      if (text !== '') {
        said.set(String(text), nowMs);
        // 清掉过期的，别让这个 Map 长跑成泄漏。
        for (const [body, at] of said) {
          if (nowMs - at >= Math.max(phraseRepeatWithinMs, 3_600_000)) said.delete(body);
        }
      }
    },
    /** 诊断用。 */
    describe() {
      return { lastSpokeAt, lastHour: stamps.length, saidUnique: said.size };
    },
  };
}

/**
 * 自主链路本体。
 *
 * `judge` 是 QQ 插件发布的端口（可能还没出现：`null` 时这一轮直接跳过）。
 * `send` 由调用方给（它负责分段、上传、错误记账），这里只管「发不发、发什么」。
 */
export function createAutonomy({
  config,                    // resolveAutonomy 的产物
  clock,                     // { now(): number }（测试注入）
  getJudge,                  // () => port | null
  send,                      // async ({ room, gid, text, reason }) => boolean
  append,                    // (row) => void（影子日志落盘；缺省 = 不落）
  note,                      // (line) => void
  gate = createSpeakGate(config),
  // **字段名必须逐个映射**（2026-11-20 实测的真故障）：`createAmbient` 认的是
  // `maxEntries / maxChars / ttlMs / selfUid`，而 `resolveAutonomy` 产出的是
  // `ambientMaxEntries / ambientMaxChars / ambientTtlMs / selfUid`。直接把 config 整个
  // 传进去，四个里三个读不到、全部退回默认值 —— 而默认 `ttlMs` 恰好也是 10 分钟，
  // 于是症状不是"明显报错"，而是"过期清不掉"，极难定位。
  ambient = createAmbient({
    maxEntries: config.ambientMaxEntries,
    maxChars: config.ambientMaxChars,
    ttlMs: config.ambientTtlMs,
    selfUid: config.selfUid,
  }),
}) {
  const say = typeof note === 'function' ? note : () => {};
  const state = {
    started: false,
    lastJudgeAt: null,
    /** 上一次真的判过的那一批里最新的消息号（挡"同一批话被每分钟重判"）。 */
    lastJudgeMid: null,
    lastTurnEndAt: null,
    judges: 0, silences: 0, spokes: 0, shadowed: 0, skipped: 0, failures: 0,
    lastReason: '', lastCostUsd: 0,
  };
  /** 每群一个定时器。 */
  const timers = new Map();
  /** 上一次打过的跳过原因（每个房间一条）：只在**原因变化**时打日志。 */
  const lastLogged = new Map();
  /** 每个房间上一次真的判过的最新消息号（挡"同一批话被每分钟重判"）。 */
  const lastJudgeMid = new Map();

  /**
   * 打一行"这一轮为什么没判"。
   *
   * 只在原因变化时打：每分钟一轮、每轮都打一行会把日志淹掉，而运维真正要看的是
   * **变化**（"刚才开始跳过了"比"一直在跳过"重要得多）。
   */
  function noteSkip(room, reason) {
    if (lastLogged.get(room) === reason) return;
    lastLogged.set(room, reason);
    say(`自主判断 ${room}：跳过（${reason}）`);
  }

  /** 一轮判断（永不抛）。 */
  async function judgeOnce(room, gid) {
    const port = getJudge();
    if (!port) { state.skipped += 1; state.lastReason = 'judge-port-absent'; noteSkip(room, 'judge-port-absent'); return; }
    if (config.mode === 'off') { state.skipped += 1; state.lastReason = 'mode-off'; return; }
    const nowMs = clock.now();
    // 让路：刚跑完一轮回合就跳过这一拍（见文件头第 2 条）。
    if (state.lastTurnEndAt !== null && nowMs - state.lastTurnEndAt < config.quietAfterTurnMs) {
      state.skipped += 1; state.lastReason = 'quiet-after-turn'; noteSkip(room, 'quiet-after-turn'); return;
    }
    const lines = ambient.lines(nowMs);
    if (lines.length === 0) { state.skipped += 1; state.lastReason = 'ambient-empty'; noteSkip(room, 'ambient-empty'); return; }
    // **最后一句是她说的时候不判**（2026-11-20 实测的真故障，比 stale ring 更根本）。
    //
    // 现场：21:38 / 21:43 / 21:48 / 22:35 / 23:05 / 23:35 / 00:05 七次发出同一句
    // 「后来是怎么解决的？」。链路是自持的 ——
    //
    //   她发出 → SSE 把**她自己的话**回灌进旁听环（故意如此，QQ 那条链路也这么做：
    //   "她刚说过什么"是判断要不要接着说的依据）→ 旁听环最后一句变成一条**问句**
    //   → 判断看到"有人提问、没人回答" → `unanswered-help` → 30 分钟短语冷却一到点
    //   → 再说一遍 → 再回灌 → ……
    //
    // 关键在"没人回答"这个前提被破坏了：那句话是她自己问的。所以这里加一道结构闸：
    // **最后一句必须不是她说的**，才值得判断。别人接上话之前，她刚说完的那一句
    // 不是"可以再补一句"的理由，而是"该等对方"的理由。
    //
    // 这道闸不替代 `quietAfterTurnMs`：那个是回合级的（回合刚结束 60 秒内不判），
    // 这个是一句级的（回合结束后 60 秒过了，只要没人接话仍然不判）。
    const last = lines[lines.length - 1];
    if (last !== undefined && last.self) {
      state.skipped += 1; state.lastReason = 'last-line-is-self'; noteSkip(room, 'last-line-is-self'); return;
    }
    // **这一批没有新消息就不重判**（第三道结构闸，也是这三道里最硬的一道）。
    //
    // 前两道（过期清理、最后一句不是她）解决的是"环里有旧东西"；这一道解决的是
    // "环里没有新东西"——群里安静下来之后，同一批话会被每分钟重判一次，
    // 而判断是**稳定**的：同一批仍然判 `unanswered-help`，短语冷却一到点就再说一遍。
    // 判据是消息号（`null` 不参与比较：合成行没有号，用号判它会把两批合成行当成同一批）。
    const newestMid = last !== undefined && Number.isInteger(last.messageId) ? last.messageId : null;
    // **按房间记**，不是一个全局变量：多群时"上一个判的是哪个群"会把另一个群的新消息挡掉。
    if (newestMid !== null && lastJudgeMid.get(room) === newestMid) {
      state.skipped += 1; state.lastReason = `same-batch:${newestMid}`; noteSkip(room, `same-batch:${newestMid}`); return;
    }
    state.lastJudgeAt = nowMs;
    if (newestMid !== null) { lastJudgeMid.set(room, newestMid); state.lastJudgeMid = newestMid; }
    let verdict;
    try {
      verdict = await port.decide({
        origin: 'vc', room, lines, nowMs,
        nowLabel: labelOf(nowMs),
        replyMaxChars: config.replyMaxChars,
        windowMs: config.replayWindowMs,
        selfId: config.selfUid,
      });
    } catch (error) {
      state.failures += 1;
      state.lastReason = 'judge-threw';
      say(`自主判断抛错（${room}）：${String(error?.message ?? error).slice(0, 160)}`);
      return;
    }
    state.judges += 1;
    await handleVerdict(room, gid, verdict, nowMs);
    // 一轮一行：`state.lastReason` 只在后台诊断里看得到，而"她为什么没说话"
    // 是运维最先问的问题——把它同时写进日志，别让人非得开后台才能回答。
    // 频率是每群每 `judgeIntervalMs` 一行（默认 1 分钟），不会淹掉别的日志。
    say(`自主判断 ${room}：${describeVerdictOf(verdict)}（${state.lastReason}）`);
  }

  /** 拿到判决之后做什么（发 / 不发 / 只记）。 */
  async function handleVerdict(room, gid, verdict, nowMs) {
    if (verdict === null || typeof verdict !== 'object') {
      state.failures += 1; state.lastReason = 'bad-verdict'; return;
    }
    if (verdict.kind === 'no-route') {
      // 判断这一路不可用**不算失败**：它与 QQ 那边同一条口径（可选加速件的缺席不改记账）。
      state.skipped += 1; state.lastReason = `no-route:${String(verdict.detail ?? '').slice(0, 80)}`; return;
    }
    if (verdict.kind === 'invalid') {
      state.failures += 1; state.lastReason = `invalid:${String(verdict.reason ?? '').slice(0, 80)}`; return;
    }
    if (verdict.action === 'silent' || verdict.action === 'observe') {
      state.silences += 1; state.lastReason = String(verdict.reason ?? '');
      return;
    }
    const gateDecision = gate.allow({ text: verdict.text, nowMs });
    if (!gateDecision.allow) {
      state.skipped += 1; state.lastReason = gateDecision.reason;
      return;
    }
    // 影子模式：只落盘，一句都不发。
    if (config.mode === 'shadow') {
      state.shadowed += 1; state.lastReason = `shadow:${String(verdict.reason ?? '')}`;
      // `outcome` 要能区分"本来要说但影子拦住了"与"真的说了"——盲评看的就是这个区别。
      record(room, gid, verdict, state.lastReason);
      return;
    }
    const ok = await send({ room, gid, text: verdict.text, reason: verdict.reason ?? '' });
    if (!ok) { state.failures += 1; state.lastReason = 'send-failed'; return; }
    gate.noteSpoke(nowMs, String(verdict.text ?? ''));
    state.spokes += 1; state.lastReason = String(verdict.reason ?? '');
    record(room, gid, verdict, 'spoke');
  }

  /** 落一行影子/实发记录（与 QQ 的 `presence-shadow.jsonl` 同格式）。 */
  function record(room, gid, verdict, outcome) {
    if (typeof append !== 'function') return;
    try {
      append({
        at: clock.now(),
        room, gid,
        action: verdict.action,
        text: verdict.text,
        reason: verdict.reason ?? '',
        outcome,
        target: verdict.targetMessageId ?? null,
        mode: config.mode,
      });
    } catch (error) { say(`影子日志落盘失败：${String(error?.message ?? error).slice(0, 120)}`); }
  }

  return {
    /** 每条频道消息都进旁听（**不**驱动回合）。 */
    observe(event, gid) {
      if (config.mode === 'off') return;
      ambient.observe(event, clock.now());
    },
    /** 一轮回合结束（给「让路」用）。 */
    noteTurnEnd(nowMs) { state.lastTurnEndAt = nowMs; },
    /** 起每群的定时器（幂等）。 */
    start(gids) {
      if (state.started) return;
      state.started = true;
      for (const gid of gids) {
        const room = `vc-chan-${gid}`;
        const timer = setInterval(() => { void judgeOnce(room, gid); }, config.judgeIntervalMs);
        try { timer.unref?.(); } catch { /* not supported */ }
        timers.set(gid, timer);
      }
      say(`自主链路 on（mode=${config.mode} interval=${config.judgeIntervalMs}ms 群=${JSON.stringify(gids)}）`);
    },
    stop() {
      for (const timer of timers.values()) clearInterval(timer);
      timers.clear();
      state.started = false;
    },
    /** 立刻判一次（测试与「手动触发」用）。 */
    judgeNow(gid) { return judgeOnce(`vc-chan-${gid}`, gid); },
    state,
    gate,
    ambient,
  };
}

/** `HH:MM` 形式的「现在几点」（状态文本末尾那一行用它）。 */
function labelOf(nowMs) {
  const date = new Date(nowMs);
  const two = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** 一句日志里能读懂的判决摘要（不打印正文：正文已经在账本里了）。 */
function describeVerdictOf(verdict) {
  if (verdict === null || typeof verdict !== 'object') return '形状不明';
  if (verdict.kind === 'no-route') return '不可用';
  if (verdict.kind === 'invalid') return '坏回答';
  return String(verdict.action ?? '?');
}
