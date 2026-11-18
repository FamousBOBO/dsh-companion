// 取端口：跨兄弟 cordis 行读 `companionVoceChat`。
//
// 为什么必须走 process 注册表：插件行（`channel-vocechat`）与适配行（`dsh-vocechat-adapter`）
// 是**兄弟行**，`ctx.get('companionVoceChat')` 在兄弟上看不见 —— 这是 cordis 的子树作用域
// 决定的，不是 bug（`companion-health` 当初就是这样整条链路静默失效的）。
//
// 三条取法，顺序与 `companion-foundation/port-publish.mjs` 一致：
//   1. `ctx.get(name)`         —— 同子树时才有效，先试，不花钱
//   2. 命名空间键 `<name>\0<root>` —— 一定是我们自己的
//   3. 裸 root 键              —— **最后**，因为 `companion-health` 也住在那个键上
//
// 第 3 条必须带形状检查（`accept`），否则可能拿到健康服务对象，然后在很远的地方才炸。
//
// 取不到时诚实降级：返回 null，调用方不订阅、不发送，后台每 8 秒重试一次并留一行说明。
// **不假装成功**——假装成功的后果是"消息进去了但永远没人回"，比一条明确的服务未挂载日志难查得多。

const RETRY_MS = 8000;

/** Mirrors companion-foundation/port-publish.mjs#keyVariants, without importing that package. */
function keyVariants(root) {
  const literal = pathNormalize(String(root ?? ''));
  const variants = new Set([literal]);
  variants.add(literal.replace(/\\/g, '/'));
  if (process.platform === 'win32') variants.add(literal.toLowerCase());
  variants.delete('');
  return [...variants];
}

function pathNormalize(value) {
  // Enough normalisation for key comparison; deliberately not `fs.realpath` so a not-yet-created
  // data directory still yields a stable key (the publisher has the same caveat).
  let text = value.replace(/\\+$/g, '').replace(/\\+/g, '\\');
  if (process.platform === 'win32') text = text.replace(/\//g, '\\');
  return text;
}

/**
 * The process-level registry.
 *
 * `process` — **not `globalThis`** — is the holder. Both authoritative implementations
 * (`companion-foundation/port-publish.mjs` and `dsh-channel-vocechat/publish.mjs`) write
 * `process[Symbol.for('dsh.companion.ports.v1')]`, and in Node `process` is an object
 * *referenced by* `globalThis`, not the same object: a key set on one is invisible on the other.
 * Using `globalThis` here is exactly the bug this comment exists to prevent — the publisher
 * succeeds, the consumer resolves nothing, and nothing appears in any log.
 */
function registry() {
  const symbol = Symbol.for('dsh.companion.ports.v1');
  if (!(process[symbol] instanceof Map)) process[symbol] = new Map();
  return process[symbol];
}

function usable(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.ready === 'function') {
    try { return entry.ready() === true; } catch { return false; }
  }
  return true;
}

/** The shape we require. Anything else occupying the key is "not found". */
export function isVoceChatPort(value) {
  return Boolean(value)
    && typeof value.send === 'function'
    && typeof value.subscribe === 'function'
    && typeof value.info === 'function';
}

/**
 * @param {object} input
 * @param {string} input.root       bare dataRoot (`.../data`), NOT suiteRoot, NOT data/home
 * @param {() => unknown} [input.context]  returns this row's ctx, for the `ctx.get` fast path
 * @param {string} [input.name='companionVoceChat']
 * @returns {object|null}
 */
export function resolveVoceChatPort({ root, context = null, name = 'companionVoceChat' } = {}) {
  try {
    if (typeof context === 'function') {
      const ctx = context();
      if (ctx && typeof ctx.get === 'function') {
        const local = ctx.get(name);
        if (isVoceChatPort(local)) return local;
      }
    }
  } catch { /* the registry is the channel that must work */ }

  try {
    const map = registry();
    for (const variant of keyVariants(root)) {
      const entry = map.get(`${name}\u0000${variant}`);
      if (usable(entry) && isVoceChatPort(entry.service)) return entry.service;
    }
    for (const variant of keyVariants(root)) {
      const entry = map.get(variant);
      if (!usable(entry)) continue;
      // Bare key: only accept when it is demonstrably ours or the shape matches.
      if (entry.name !== name && !isVoceChatPort(entry.service)) continue;
      if (isVoceChatPort(entry.service)) return entry.service;
    }
  } catch { /* absent */ }
  return null;
}

/**
 * Resolve now, and keep retrying in the background until it appears.
 *
 * @param {object} input
 * @param {(port: object) => void} input.onFound   called exactly once, when the port first appears
 * @param {(line: string) => void} [input.log]
 */
export function watchVoceChatPort({ root, context = null, name = 'companionVoceChat', onFound, log = null, retryMs = RETRY_MS } = {}) {
  const say = line => {
    if (typeof log !== 'function') return;
    try { log(line); } catch { /* */ }
  };

  const immediate = resolveVoceChatPort({ root, context, name });
  if (immediate) {
    try { onFound(immediate); } catch (error) { say(`onFound threw: ${String(error?.message ?? error)}`); }
    return { port: immediate, stop: () => {} };
  }

  say('companionVoceChat 尚未发布；每 8 秒重试一次（此时不订阅、不发送，消息仍在插件侧落盘）');
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const found = resolveVoceChatPort({ root, context, name });
    if (!found) return;
    stopped = true;
    clearInterval(timer);
    say('companionVoceChat 已出现，开始订阅');
    try { onFound(found); } catch (error) { say(`onFound threw: ${String(error?.message ?? error)}`); }
  }, retryMs);
  try { timer.unref?.(); } catch { /* not supported */ }

  return {
    port: null,
    stop: () => { stopped = true; clearInterval(timer); },
  };
}

export { RETRY_MS, keyVariants };
