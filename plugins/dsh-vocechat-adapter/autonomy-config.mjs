// 自主链路的**配置解析**（与 `gate.mjs#resolveGroup` 同一形状与同一精神）。
//
// 为什么单独一个文件而不是塞进 `index.mjs`：那个文件已经 1600+ 行，而这段要解释
// "每个旋钮为什么是这个默认值"——塞进去会使本来就难读的地方更难读。
//
// 三条纪律，每条对应一次真实事故：
//
//   1. **`mode` 默认 `off`。** 装上插件不等于开始在群里自主说话。显式写 `live` 才发；
//      写 `shadow` 只判断与落盘、一句不发。这与 QQ 的 `presence.mode` 空串口径不同
//      （那边是"按 enabled 推断"的历史遗留），这里没有历史包袱，就取最安全的那个默认。
//   2. **`enabled` 与 `mode` 分开。** `enabled:false` = 连判断都不跑（省一次云端请求）；
//      `mode:'shadow'` = 判断跑、只是不发。两件事，混成一个布尔就没法"先观察再说"。
//   3. **每个数字都夹到合理区间。** 写了 `judgeIntervalMs: 5`（5 毫秒）会把云端打成限频，
//      写了 `0` 会让定时器变成忙等。夹紧比"信任配置"安全。

/** 正数并夹住上下界（非数字/非正数走默认值）。 */
function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 允许 `0` 表示"关掉"的夹紧（`clampInt` 会把 0 当"没写"，这里不能）。
 *
 * 为什么单独一个：`phraseRepeatWithinMs: 0` 是**有意义的值**（关掉重复冷却），
 * 用 `clampInt` 会把意思吃掉——配了 0 却仍然挡重复，那是最难查的一类配置错误。
 */
function clampIntOrZero(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(max, Math.trunc(n));
}

/** 三态模式：认不出的一律按 `off`（fail-closed）。 */
function modeOf(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'live' || text === 'shadow' ? text : 'off';
}

/**
 * @param {object} raw  `vocechat-adapter.config.autonomy`
 * @param {{ selfUid?: number }} [extra]  从别处已知的值（selfUid 用同一个，不用再配一遍）
 */
export function resolveAutonomy(raw, { selfUid = 0 } = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    // `enabled:false` 连判断都不跑；默认 false —— 装上不等于开启。
    enabled: input.enabled === true,
    mode: modeOf(input.mode),
    // 每人轮流说一句的节奏。1 分钟：一个群一分钟判一次，人不会觉得被盯着，
    // 而云端一次约 $0.00004，一个月约 $1.7（见 docs/groups/jev-opencode-backend.md）。
    judgeIntervalMs: clampInt(input.judgeIntervalMs, 60_000, 5_000, 3_600_000),
    // 旁听缓冲：条数与字数都要有上限，否则长跑进程会把它养成泄漏。
    ambientMaxEntries: clampInt(input.ambientMaxEntries, 40, 1, 200),
    ambientMaxChars: clampInt(input.ambientMaxChars, 6000, 200, 20_000),
    ambientTtlMs: clampInt(input.ambientTtlMs, 600_000, 60_000, 86_400_000),
    // 两次自主发言的最小间隔。5 分钟：比"每次判断都能说"宽得多，
    // 群里最像机器人的行为就是"每句话都接"。
    speakMinIntervalMs: clampInt(input.speakMinIntervalMs, 300_000, 30_000, 86_400_000),
    // 每小时最多几句（滚动窗口，与 QQ 的 `speakMaxPerHour` 同口径）。
    speakMaxPerHour: clampInt(input.speakMaxPerHour, 3, 1, 60),
    // 一轮回合刚结束的这段窗口里不判：否则会"刚回完一句，三秒后又补一句"。
    quietAfterTurnMs: clampInt(input.quietAfterTurnMs, 60_000, 0, 3_600_000),
    // 自主发言的字数上限（与 QQ 的 `presence.replyMaxChars` 同义）。
    replyMaxChars: clampInt(input.replyMaxChars, 70, 4, 400),
    // 允许引用的时间窗（判断层用它筛"还在场"的目标消息号）。
    replayWindowMs: clampInt(input.replayWindowMs, 600_000, 60_000, 86_400_000),
    // 同一句短语的重复冷却（2026-11-20 实测补的：13 条短语库 + 稳定判断 = 连着说三遍）。
    // 30 分钟：比 speakMinIntervalMs 长得多，因为「同一句话」比「两次发言」更刺眼。
    phraseRepeatWithinMs: clampIntOrZero(input.phraseRepeatWithinMs, 1_800_000, 86_400_000),
    // 她在这个渠道上的 uid（与传输行必须一致；判断层用它剥掉"自己发的那条"）。
    selfUid: Number.isInteger(Number(selfUid)) && Number(selfUid) >= 0 ? Number(selfUid) : 0,
  };
}

/** 自主链路是否真的该跑（`enabled` 与 `mode` 都成立）。 */
export function autonomyActive(config) {
  return config !== null && typeof config === 'object'
    && config.enabled === true && config.mode !== 'off';
}
