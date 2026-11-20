// 取「判断端口」：跨兄弟 cordis 行读 `companionJudge`（QQ 插件发布的那一个）。
//
// 为什么要有这一层（2026-11-20）：VoceChat 的频道门控原来只有「是成员 + 掷骰子」——
// 骰子回答的是「这一句接不接」，而不是「这一句**该不该**接」。九门 + 决策表那套判断
// 已经在 QQ 那条链路上跑（`dsh-channel-qq` 的 `judge-gates.ts`），把它复用过来
// 比在 VoceChat 里再造一份判断逻辑安全得多：两份逻辑一定会漂移。
//
// 三条取法，顺序与 `subscribe.mjs`（也就是 `companion-foundation/port-publish.mjs`）一致：
//   1. `ctx.get(name)`         —— 同子树时才有效，先试，不花钱
//   2. 命名空间键 `<name>\0<root>` —— 一定是我们自己的
//   3. 裸 root 键              —— **最后**，必须带形状检查（那个键可能被别的服务占着）
//
// **形状检查是硬要求**：`companionJudge` 与 `companionVoceChat` 住在同一个注册表里，
// 只看「有没有对象」会把传输端口误当判断端口，然后在很远的地方才炸
// （`decide is not a function` 出现在某个群消息回调里）。
//
// 取不到时诚实降级：返回 `null`，自主链路整条不启用，日志里说清楚。**不假装成功**——
// 假装成功的后果是「群里说话了，但说的都是没经过判断的话」，那比不说话难查得多。

const RETRY_MS = 8000;

/** 与 `subscribe.mjs` 同一条规范化（不 `realpath`：data 目录可能还没建）。 */
function pathNormalize(value) {
  let text = String(value ?? '').replace(/\\+$/g, '').replace(/\\+/g, '\\');
  if (process.platform === 'win32') text = text.replace(/\//g, '\\');
  return text;
}

/** 一个 root 的拼写变体（键比较用）。 */
function keyVariants(root) {
  const literal = pathNormalize(root);
  const variants = new Set([literal]);
  variants.add(literal.replace(/\\/g, '/'));
  if (process.platform === 'win32') variants.add(literal.toLowerCase());
  variants.delete('');
  return [...variants];
}

/**
 * 进程级注册表。**`process` 而不是 `globalThis`**：Node 里 `process` 是被 `globalThis`
 * *引用*的另一个对象，写在其中一个上的键在另一个上看不见——`subscribe.mjs` 的注释
 * 记着这个坑，这里用同一枚 symbol 与同一个持有者。
 */
function registry() {
  const symbol = Symbol.for('dsh.companion.ports.v1');
  if (!(process[symbol] instanceof Map)) process[symbol] = new Map();
  return process[symbol];
}

/** `ready()` 认账：报自己不 ready 的服务当作不存在。 */
function usable(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.ready === 'function') {
    try { return entry.ready() === true; } catch { return false; }
  }
  return true;
}

/**
 * 判断端口的形状。
 *
 * 只要 `decide`：`info` / `ready` 是诊断用的可选面。**不**要求它有 `send` ——
 * 要求了就说明这层分不清「判断」和「发送」，而这两件事必须分开
 * （判断由 QQ 插件提供，发送由本适配层自己的 `vc_message` 走）。
 */
export function isJudgePort(value) {
  return Boolean(value) && typeof value.decide === 'function';
}

/**
 * 立刻解析一次。
 *
 * @param {object} input
 * @param {string} input.root       裸 dataRoot（`.../data`），不是 suiteRoot，不是 data/home
 * @param {() => unknown} [input.context]  本行的 ctx（`ctx.get` 快路径）
 * @param {string} [input.name='companionJudge']
 * @returns {object|null}
 */
export function resolveJudgePort({ root, context = null, name = 'companionJudge' } = {}) {
  try {
    if (typeof context === 'function') {
      const ctx = context();
      if (ctx && typeof ctx.get === 'function') {
        const local = ctx.get(name);
        if (isJudgePort(local)) return local;
      }
    }
  } catch { /* 注册表才是必须能通的那条 */ }

  try {
    const map = registry();
    for (const variant of keyVariants(root)) {
      const entry = map.get(`${name}\u0000${variant}`);
      if (usable(entry) && isJudgePort(entry.service)) return entry.service;
    }
    for (const variant of keyVariants(root)) {
      const entry = map.get(variant);
      if (!usable(entry)) continue;
      // 裸键可能被别的服务占着：形状不对就不认。
      if (!isJudgePort(entry.service)) continue;
      return entry.service;
    }
  } catch { /* 没发布 */ }
  return null;
}

/**
 * 现在解析，取不到就在后台每 8 秒重试一次。
 *
 * 为什么不「取不到就永久关掉」：QQ 插件那一行可能比本行更晚挂载（profile 顺序不固定），
 * 而「晚 10 秒出现」和「永远不出现」是两件完全不同的事。重试代价几乎为零
 * （一次 `Map.get`），所以宁可多试到它出现为止。
 *
 * @param {object} input
 * @param {(port: object) => void} input.onFound  第一次出现时调用一次
 * @param {(line: string) => void} [input.log]
 */
export function watchJudgePort({ root, context = null, name = 'companionJudge', onFound, log = null, retryMs = RETRY_MS } = {}) {
  const say = line => {
    if (typeof log !== 'function') return;
    try { log(line); } catch { /* */ }
  };

  const immediate = resolveJudgePort({ root, context, name });
  if (immediate) {
    try { onFound(immediate); } catch (error) { say(`onFound 抛错：${String(error?.message ?? error)}`); }
    return { port: immediate, stop: () => {} };
  }

  say('companionJudge 尚未发布；每 8 秒重试一次（此时不判断、不说话，消息仍落盘）');
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const found = resolveJudgePort({ root, context, name });
    if (!found) return;
    stopped = true;
    clearInterval(timer);
    say('companionJudge 已出现，自主判断启用');
    try { onFound(found); } catch (error) { say(`onFound 抛错：${String(error?.message ?? error)}`); }
  }, retryMs);
  try { timer.unref?.(); } catch { /* not supported */ }

  return {
    port: null,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
