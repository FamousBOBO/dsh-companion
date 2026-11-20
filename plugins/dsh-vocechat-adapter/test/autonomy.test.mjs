// 自主链路与判断端口连接的测试。
//
// 这一层的错都**不会抛**，只会表现为"群里不说话"或"群里说太多"——两种都不会有人发现。
// 所以每个断言都钉一个具体的、会静默发生的错：
//
//   1. `mode:'off'` 连判断都不跑（省一次云端请求，也不会在日志里刷"判断了但不发"）；
//   2. `enabled:false` 与 `mode:'off'` 是两件事（前者连定时器都不该起）；
//   3. `silent` 不占每小时额度（否则"没说"会挤掉"该说"的机会）；
//   4. 刚跑完一轮回合的静默窗内不判（否则会出现"刚回完一句，三秒后又补一句"）；
//   5. `shadow` 只落盘不发（影子模式的全部意义就是不发）；
//   6. `no-route` 不算失败（对端抖动不该被记成"她判错了"）；
//   7. 判断端口缺席时**不起定时器**（判断不了就不要说话）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAutonomy, createAmbient, createSpeakGate } from '../autonomy.mjs';
import { resolveAutonomy, autonomyActive } from '../autonomy-config.mjs';
import { isJudgePort, resolveJudgePort, watchJudgePort } from '../judge-link.mjs';

const SELF = 4;
const GID = 1;
const T0 = 1_792_000_000_000;

/** 一条频道消息事件（与 `dsh-channel-vocechat` 的 `normalize.mjs` 同形）。 */
function event(mid, fromUid, content, atMs) {
  return { mid, fromUid, content, contentType: 'text/plain', createdAt: atMs };
}

/** 可控时钟。 */
function clockAt(start) {
  let at = start;
  return {
    now: () => at,
    advance: (ms) => { at += ms; },
    set: (ms) => { at = ms; },
  };
}

/** 一份判决。 */
function verdict(action, text, extra = {}) {
  return { kind: 'decision', action, text, reason: `rule:${action}`, ...extra };
}

/** 造一个自主链路（judge 是"判决工厂"或 null；send 记账、append 记录）。 */
function build({ mode = 'live', judge = () => verdict('reply', '我也踩过这个坑'), config: extra = {} } = {}) {
  const clock = clockAt(T0);
  const sent = [];
  const rows = [];
  const autonomy = createAutonomy({
    config: resolveAutonomy({ enabled: true, mode, judgeIntervalMs: 60_000, ...extra }, { selfUid: SELF }),
    clock,
    // 端口形状：`decide`（`judge` 为 null 时返回 null，模拟"QQ 插件还没发布"）。
    getJudge: () => (judge === null ? null : { decide: async () => judge() }),
    send: async ({ room, text }) => { sent.push({ room, text }); return true; },
    append: (row) => rows.push(row),
    note: () => {},
  });
  return { autonomy, clock, sent, rows };
}

test('配置：mode 认不出的一律 off，enabled 默认 false', () => {
  assert.equal(resolveAutonomy({}).mode, 'off');
  assert.equal(resolveAutonomy({}).enabled, false);
  assert.equal(resolveAutonomy({ mode: 'LIVE' }).mode, 'live');
  assert.equal(resolveAutonomy({ mode: 'lvie' }).mode, 'off', '拼错的模式必须 fail-closed，不是猜一个');
  // 数字夹紧：写 5 毫秒会把云端打成限频，写 0 会让定时器变成忙等。
  assert.equal(resolveAutonomy({ judgeIntervalMs: 5 }).judgeIntervalMs, 5_000);
  assert.equal(resolveAutonomy({ judgeIntervalMs: 0 }).judgeIntervalMs, 60_000);
});

test('配置：enabled 与 mode 是两件事', () => {
  assert.equal(autonomyActive(resolveAutonomy({ enabled: false, mode: 'live' })), false, '不开就是不开，哪怕 mode 写了 live');
  assert.equal(autonomyActive(resolveAutonomy({ enabled: true, mode: 'off' })), false);
  assert.equal(autonomyActive(resolveAutonomy({ enabled: true, mode: 'shadow' })), true, 'shadow 要跑判断，只是不发');
});

test('旁听：只留最近若干条、跳过空正文、自己发的标记成 self', () => {
  const ambient = createAmbient({ maxEntries: 3, maxChars: 10_000, ttlMs: 600_000, selfUid: SELF });
  ambient.observe(event(1, 1, '在吗', T0), T0);
  ambient.observe(event(2, SELF, '在的', T0 + 1000), T0 + 1000);
  ambient.observe(event(3, 1, '', T0 + 2000), T0 + 2000);
  ambient.observe(event(4, 1, '今天好热', T0 + 3000), T0 + 3000);
  const lines = ambient.lines();
  assert.equal(lines.length, 3, '空正文不该进缓冲（它只会白占字数额度）');
  assert.equal(lines[1].self, true, '她自己发的那条必须标 self（判断层要靠它剥掉"自己的话"）');
  assert.equal(lines[2].text, '今天好热');
});

test('旁听：过期条目会被丢掉（长跑进程不许把环养成泄漏）', () => {
  const ambient = createAmbient({ maxEntries: 40, maxChars: 6000, ttlMs: 60_000, selfUid: SELF });
  ambient.observe(event(1, 1, '老消息', T0), T0);
  ambient.observe(event(2, 1, '新消息', T0 + 120_000), T0 + 120_000);
  assert.equal(ambient.lines().length, 1);
});

test('闸门：最小间隔、每小时额度、字数上限、@ 拦截', () => {
  const gate = createSpeakGate({ speakMinIntervalMs: 300_000, speakMaxPerHour: 2, replyMaxChars: 70 });
  assert.equal(gate.allow({ text: '我也踩过这个坑', nowMs: T0 }).allow, true);
  gate.noteSpoke(T0);
  // 冷却内不许再说。
  assert.match(gate.allow({ text: '后来呢', nowMs: T0 + 1000 }).reason, /speak-cooldown/);
  // 过了冷却但额度用完（一小时 2 条）。
  gate.noteSpoke(T0 + 400_000);
  assert.match(gate.allow({ text: '第三句', nowMs: T0 + 700_000 }).reason, /hour-quota/);
  // 字数上限、@ 都是发出去就不可撤销的错，必须在发之前挡。
  assert.match(gate.allow({ text: 'x'.repeat(80), nowMs: T0 + 800_000 }).reason, /text-too-long/);
  assert.match(gate.allow({ text: '你过来 @小明', nowMs: T0 + 800_000 }).reason, /mention/);
});

test('闸门：同一句短语在冷却窗内被挡（2026-11-20 实测：连着说三遍）', () => {
  // 短语库只有 13 条，而同一段 state 上的判断是稳定的 → tech 场景会一直选同一条。
  // 三道原有闸门都放行（5 分钟正好是 speakMinIntervalMs），于是群里出现三遍
  // "后来是怎么解决的？"。这条冷却就是为它加的。
  const gate = createSpeakGate({
    speakMinIntervalMs: 300_000, speakMaxPerHour: 10, replyMaxChars: 70,
    phraseRepeatWithinMs: 1_800_000,
  });
  assert.equal(gate.allow({ text: '后来是怎么解决的？', nowMs: T0 }).allow, true);
  gate.noteSpoke(T0, '后来是怎么解决的？');
  // 过了最小间隔（5 分钟）但没过多重复冷却（30 分钟）。
  assert.match(gate.allow({ text: '后来是怎么解决的？', nowMs: T0 + 310_000 }).reason, /phrase-repeat/);
  // 换一句就能说：冷却只针对**同一句**。
  assert.equal(gate.allow({ text: '先看看日志里有没有异常堆栈', nowMs: T0 + 310_000 }).allow, true);
  // 过了 30 分钟，同一句可以再说。
  assert.equal(gate.allow({ text: '后来是怎么解决的？', nowMs: T0 + 1_900_000 }).allow, true);
});

test('配置：phraseRepeatWithinMs 写 0 是"关掉"，不是"没写"', () => {
  // `clampInt` 会把 0 当"没写"退回默认值——配了 0 却仍然挡重复，是最难查的配置错。
  assert.equal(resolveAutonomy({ enabled: true, mode: 'live' }).phraseRepeatWithinMs, 1_800_000);
  assert.equal(resolveAutonomy({ enabled: true, mode: 'live', phraseRepeatWithinMs: 0 }).phraseRepeatWithinMs, 0);
});

test('silent 不占掉每小时额度', async () => {
  const silentJudge = () => verdict('silent', '');
  const { autonomy, sent } = build({ judge: silentJudge, config: { speakMaxPerHour: 1 } });
  autonomy.observe(event(1, 1, '随便聊聊', T0), GID);
  await autonomy.judgeNow(GID);
  assert.equal(sent.length, 0);
  assert.equal(autonomy.state.silences, 1);
  assert.equal(autonomy.gate.describe().lastHour, 0, '沉默不该消耗额度（否则"没说"会挤掉"该说"的机会）');
});

test('shadow：判断照跑、落盘一行、一句都不发', async () => {
  const { autonomy, sent, rows } = build({ mode: 'shadow' });
  autonomy.observe(event(1, 1, '报错了', T0), GID);
  await autonomy.judgeNow(GID);
  assert.equal(sent.length, 0, 'shadow 模式的全部意义就是不发');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'shadow:rule:reply');
  assert.equal(rows[0].action, 'reply');
  assert.equal(autonomy.state.shadowed, 1);
});

test('live：真的发出去之后才记额度', async () => {
  const { autonomy, sent, rows } = build({ mode: 'live' });
  autonomy.observe(event(1, 1, '报错了', T0), GID);
  await autonomy.judgeNow(GID);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].room, `vc-chan-${GID}`);
  assert.equal(autonomy.state.spokes, 1);
  assert.equal(autonomy.gate.describe().lastHour, 1);
  assert.equal(rows[0].outcome, 'spoke');
});

test('回合刚结束的静默窗内不判（避免"刚回完又补一句"）', async () => {
  const { autonomy, sent } = build({ config: { quietAfterTurnMs: 60_000 } });
  autonomy.observe(event(1, 1, '报错了', T0), GID);
  autonomy.noteTurnEnd(T0);
  await autonomy.judgeNow(GID);
  assert.equal(sent.length, 0);
  assert.equal(autonomy.state.lastReason, 'quiet-after-turn');
  assert.equal(autonomy.state.skipped, 1);
});

test('no-route 不算失败（对端抖动不该被记成"她判错了"）', async () => {
  const { autonomy, sent } = build({ judge: () => ({ kind: 'no-route', detail: 'status:429' }) });
  autonomy.observe(event(1, 1, '报错了', T0), GID);
  await autonomy.judgeNow(GID);
  assert.equal(sent.length, 0);
  assert.equal(autonomy.state.failures, 0, 'no-route 是"这一轮没判"，不是"判错"');
  assert.match(autonomy.state.lastReason, /no-route/);
});

test('invalid 记失败（那是自己的形状或配置坏了）', async () => {
  const { autonomy } = build({ judge: () => ({ kind: 'invalid', reason: 'shape' }) });
  autonomy.observe(event(1, 1, '报错了', T0), GID);
  await autonomy.judgeNow(GID);
  assert.equal(autonomy.state.failures, 1);
});

test('判断端口抛错 → 记失败但绝不让异常逃出去', async () => {
  const { autonomy } = build({ judge: () => { throw new Error('boom'); } });
  autonomy.observe(event(1, 1, '报错了', T0), GID);
  await autonomy.judgeNow(GID);
  assert.equal(autonomy.state.failures, 1);
  assert.equal(autonomy.state.lastReason, 'judge-threw');
});

test('没有判断端口 → 跳过，不发、不起定时器', async () => {
  const { autonomy, sent } = build({ judge: null });
  autonomy.observe(event(1, 1, '报错了', T0), GID);
  await autonomy.judgeNow(GID);
  assert.equal(sent.length, 0);
  assert.equal(autonomy.state.lastReason, 'judge-port-absent');
});

test('mode off：连旁听都不存（省内存也不刷日志）', () => {
  const { autonomy } = build({ mode: 'off' });
  autonomy.observe(event(1, 1, '报错了', T0), GID);
  assert.equal(autonomy.ambient.size(), 0);
  assert.equal(autonomy.state.judges, 0);
});

test('自持回环 2026-11-20：她自己刚说的那句不构成"该再补一句"的理由', async () => {
  // 现场：21:38 起每 30 分钟一句「后来是怎么解决的？」，共 7 次。
  // 链路是她发出 → SSE 回灌她自己那句（**故意保留**，QQ 也这么做）→ 旁听环最后一句
  // 变成一条问句 → 判断看见"有人提问没人回答" → `unanswered-help` → 冷却到点再说。
  // 所以这道闸是结构性的：**最后一句是她就跳过**，不等于是"永远不判"——
  // 别人接上话之后照样判。
  const { autonomy, sent } = build({ config: { speakMinIntervalMs: 300_000, phraseRepeatWithinMs: 1_800_000 } });
  autonomy.observe(event(1619, SELF, '刚才不还是栈溢出么，怎么转头又变空指针了？', T0), GID);
  await autonomy.judgeNow(GID);
  assert.equal(sent.length, 0, '她自己说的最后一句不该触发判断');
  assert.equal(autonomy.state.lastReason, 'last-line-is-self');

  // 别人接一句之后，判断重新生效（闸只挡"没人接话"这种状态）。
  autonomy.observe(event(1620, 5, '我这边没新报错', T0 + 1000), GID);
  await autonomy.judgeNow(GID);
  assert.equal(sent.length, 1);
});

test('旁听过期：判断时也按 nowMs 清（只在 observe 里清会留下永不退场的旧话题）', async () => {
  // 现场：22:35 那段技术讨论在 23:35、00:05 仍被判成 `unanswered-help`。
  // 根因是 `observe` 只在**有新消息**时被调到，群里安静下来之后旧行永远不走。
  const ambient = createAmbient({ maxEntries: 40, maxChars: 6000, ttlMs: 60_000, selfUid: SELF });
  ambient.observe(event(1606, 1, '刚才那个报错我复现了', T0), T0);
  assert.equal(ambient.lines().length, 1);
  assert.equal(ambient.lines(T0 + 300_000).length, 0, '过了 ttl 就该在读取时消失');
  // 时间未知的行（`atMs <= 0`）保留：静默丢掉一条证据比多留一条糟。
  ambient.observe({ mid: 99, fromUid: 1, content: '没有时间戳', createdAt: 0 }, T0);
  assert.equal(ambient.lines(T0 + 300_000).length, 1);
});

test('配置字段必须真的接进旁听环（ambientMaxEntries ≠ maxEntries 这个坑）', async () => {
  // `resolveAutonomy` 产出的是 `ambientMaxEntries`，而 `createAmbient` 认 `maxEntries`。
  // 整份 config 直传时四个里三个读不到、全部退回默认值 —— 而默认 ttl 恰好也是 10 分钟，
  // 于是症状不是报错，而是"配了不生效"，最难查。
  const clock = clockAt(T0);
  const autonomy = createAutonomy({
    config: resolveAutonomy({ enabled: true, mode: 'live', ambientMaxEntries: 2, ambientTtlMs: 60_000 }, { selfUid: SELF }),
    clock,
    getJudge: () => ({ decide: async () => verdict('silent', '') }),
    send: async () => true,
    append: () => {},
    note: () => {},
  });
  for (let index = 0; index < 5; index += 1) autonomy.observe(event(index + 1, 1, `第 ${index + 1} 句`, T0 + index * 1000), GID);
  assert.equal(autonomy.ambient.size(), 2, 'ambientMaxEntries 必须生效（默认是 40）');
});

test('同一批话不重判（群里安静下来之后，每分钟重判 = 每 30 分钟再说一遍同一句）', async () => {
  // 现场：22:35 之后群里再没人说话，但 23:05 / 23:35 / 00:05 仍然各发一句。
  // 三道结构闸里这一道回答的是"环里根本没有新东西"——那就不该重判，
  // 因为判断是稳定的：同一批话仍然判 `unanswered-help`，短语冷却一到点就再说一遍。
  const { autonomy, sent, clock } = build({ config: { speakMinIntervalMs: 300_000, phraseRepeatWithinMs: 1_800_000 } });
  autonomy.observe(event(1606, 1, '刚才那个报错我复现了，你们遇到过没？', T0), GID);
  await autonomy.judgeNow(GID);
  assert.equal(sent.length, 1, '第一批该判，也该说');

  // 群里安静 40 分钟，同一条消息仍然在环里（ttl 默认 10 分钟 → 先用大 ttl 复现"没清掉"这一面）。
  clock.advance(2_400_000);
  await autonomy.judgeNow(GID);
  assert.equal(sent.length, 1, '同一批话不许重判');
  assert.match(autonomy.state.lastReason, /^(same-batch:|ambient-empty)/);

  // 有人说了新的，就重新判。
  autonomy.observe(event(1607, 5, '我这边没新报错', T0 + 2_500_000), GID);
  await autonomy.judgeNow(GID);
  assert.equal(sent.length, 2, '有新消息之后必须重新判');
});

test('同一批判据按房间分开（多群时不能互相挡）', async () => {
  const sent = [];
  const clock = clockAt(T0);
  const autonomy = createAutonomy({
    config: resolveAutonomy({ enabled: true, mode: 'live', speakMinIntervalMs: 30_000, speakMaxPerHour: 60, phraseRepeatWithinMs: 0 }, { selfUid: SELF }),
    clock,
    getJudge: () => ({ decide: async () => verdict('reply', '我也踩过这个坑') }),
    send: async ({ room, text }) => { sent.push({ room, text }); return true; },
    append: () => {},
    note: () => {},
  });
  // 两个群各自收到**同一个 mid**（真实可能出现：重连/多实例下同一个消息号在两边露面）。
  // 用一个全局变量记 lastJudgeMid 就会把第二个群挡掉。
  autonomy.observe(event(500, 1, '报错了', T0), 1);
  autonomy.observe(event(500, 1, '报错了', T0), 2);
  await autonomy.judgeNow(1);
  // 发言闸门是**实例级**的（`speakMinIntervalMs` 跨房间共享），所以推进时钟再判第二个群，
  // 免得这条断言被闸门的限频挡掉 —— 要验的是"同一批判据"，不是限频。
  clock.set(T0 + 30_000);
  await autonomy.judgeNow(2);
  assert.equal(sent.filter(row => row.room === 'vc-chan-1').length, 1);
  assert.equal(sent.filter(row => row.room === 'vc-chan-2').length, 1, '第二个群不该被第一个群的账挡掉');
});

test('judge-link：形状检查必须存在（防止把传输端口误当判断端口）', () => {
  assert.equal(isJudgePort(null), false);
  assert.equal(isJudgePort({ send: () => {}, subscribe: () => {}, info: () => {} }), false,
    '传输端口没有 decide，不许被认成判断端口');
  assert.equal(isJudgePort({ decide: () => {} }), true);
});

test('judge-link：从进程注册表按命名键取到，ready() 不认账的不取', () => {
  const symbol = Symbol.for('dsh.companion.ports.v1');
  const root = 'D:\\DSH\\dsh-production\\data';
  const port = { decide: async () => verdict('silent', '') };
  const map = new Map();
    map.set(`companionJudge\u0000${root}`, { name: 'companionJudge', service: port, ready: () => true });
  process[symbol] = map;
  try {
    assert.equal(resolveJudgePort({ root }), port);
    // ready() 返回 false 的服务当作不存在（"发布了但还没就绪"是真实状态）。
    process[symbol] = new Map([
      [`companionJudge\u0000${root}`, { name: 'companionJudge', service: port, ready: () => false }],
    ]);
    assert.equal(resolveJudgePort({ root }), null);
  } finally {
    delete process[symbol];
  }
});

test('judge-link：watch 在端口晚到时补上（不假装成功）', async () => {
  const symbol = Symbol.for('dsh.companion.ports.v1');
  const root = 'D:\\DSH\\dsh-production\\data';
  delete process[symbol];
  const found = [];
  const watcher = watchJudgePort({ root, onFound: (port) => found.push(port), log: () => {}, retryMs: 20 });
  assert.equal(watcher.port, null, '一开始就该诚实说"没有"');
  await new Promise((resolve) => setTimeout(resolve, 5));
  process[symbol] = new Map([
    [`companionJudge\u0000${root}`, { name: 'companionJudge', service: { decide: async () => null }, ready: () => true }],
  ]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  watcher.stop();
  try {
    assert.equal(found.length, 1, '端口出现之后必须补上一次 onFound');
    watcher.stop();
  } finally {
    delete process[symbol];
  }
});
