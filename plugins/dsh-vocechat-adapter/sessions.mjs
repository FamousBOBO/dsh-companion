// 会话供给：get → create → resume 的重试链。
//
// **这一段为什么单独存在**：`dsh-channel-qq` 的 `agents.ts` 是 TypeScript，路径与构建都不共享，
// 无法 import。这里按它的语义写一份精简版，只保留 VoceChat 需要的那部分。
//
// 三个事件的顺序与重试次数是**逐条照抄**，不是重新设计 —— 每一次重试都对应一个真实发生过的
// 竞态（批量自愈正在发布这个会话时，紧随的 resume 会撞上注册表不一致）：
//
//   1. `agents.get(sessionId)` 命中 → 直接接上（活着的 agent 优先于持久化恢复）
//   2. 否则 `agents.create({ sessionId, meta, agentOptions, setup })`
//   3. create 抛 `already exists` → 说明是上一次运行留下的会话，走 resume 链
//   4. resume 链：每次先等 `RESUME_BACKOFF_MS * (attempt+1)`，再查 `get`
//      —— 有人可能刚在这段等待里把它发布出来了；仍不在才 `agents.resume()`
//
// 与 QQ 版的差别（有意为之）：
//
//   - 不做 workspace 归属、不做 permissionPresets、不做 sessionTitle 改名。
//     VoceChat 的房间没有对应的工作区语义；三处都可能失败，而它们失败时不该拦住一条消息。
//     （若将来接工作区，加在这一层，别散到调用方。）
//   - 不做 model override 重装。QQ 那条是因为 Web UI 会在回合之间换掉会话持久化的路由头，
//     VoceChat 的会话由一个固定 preset 供给，不存在第二个写入方。
//   - `setup` 里只做本通道的事：装回合监听、装兜底纠正。

import { readWorkspaceGuard, effectiveRoute } from './route.mjs';

const RESUME_ATTEMPTS = 3;
const RESUME_BACKOFF_MS = 1500;

/**
 * @param {object} input
 * @param {object} input.agents     `ctx.agents`
 * @param {object} input.agentPresets `ctx.agentPresets` (resolve + mount)
 * @param {object} [input.agentDefaultModel] `ctx.agentDefaultModel` — used when no explicit route
 * @param {(agentCtx: object, agent: object, sessionId: string) => Promise<void>|void} input.setupPerAgent
 *        called inside the harness `setup` callback, for every create and every resume.
 * @param {object|null} [input.titles]   `ctx.sessionTitle`（可缺席）。有它才给会话起中文名。
 * @param {(sessionId: string) => string} [input.titleOf] 房间 → 会话标题。
 * @param {(sessionId: string) => Promise<void>|void} [input.attachTo] 把会话挂进工作区（可缺席）。
 * @param {(line: string) => void} [input.log]
 */
export function createSessions({
  agents, agentPresets, agentDefaultModel = null, setupPerAgent,
  titles = null, titleOf = null, attachTo = null, log = null,
} = {}) {
  const say = line => {
    if (typeof log !== 'function') return;
    try { log(line); } catch { /* */ }
  };
  if (!agents || typeof agents.create !== 'function') throw new Error('createSessions: agents 不可用');
  if (!agentPresets || typeof agentPresets.mount !== 'function') throw new Error('createSessions: agentPresets 不可用');

  /** One-line error rendering; the harness throws objects that stringify to `{}`. */
  function errorChain(error) {
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    try {
      const json = JSON.stringify(error);
      return json === '{}' ? String(error) : json;
    } catch { return String(error); }
  }

  /**
   * The route to run under.
   *
   * **This is not optional** (measured 2026-11-17): passing `provider: ''`/`model: ''` through to
   * `agents.create` produced `SessionAlreadyExistsError` → resume → a turn that errored with an
   * opaque "unknown" and wrote nothing to the session log. The harness needs a real route, and the
   * host already knows one — `ctx.agentDefaultModel.currentSelection()` is what the Web UI shows.
   */
  function routeOf({ provider, model, maxTokens }) {
    const explicit = String(provider ?? '').trim() && String(model ?? '').trim();
    let route;
    if (explicit) {
      route = { provider: String(provider).trim(), model: String(model).trim() };
    } else {
      const selection = agentDefaultModel?.currentSelection?.();
      const p = String(selection?.provider ?? '').trim();
      const m = String(selection?.model ?? '').trim();
      if (!p || !m) {
        throw new Error('没有可用的模型路由：config.provider/model 为空，且 ctx.agentDefaultModel 也没有当前选择');
      }
      route = { provider: p, model: m };
      if (selection?.reasoningEffort) route.reasoningEffort = selection.reasoningEffort;
    }
    if (maxTokens) route.maxTokens = maxTokens;
    return route;
  }

 /**
   * Record the choice so the harness and the workspace guard agree.
   *
   * `agent.model.select()` is what the harness's own error message prescribes: a recorded
   * selection takes precedence over `AgentOptions`, so both sides of the `agent/request`
   * waterfall propose the same provider. Without it the guard's alias and the step-preparation
   * route differ and the turn fails with "proposed … after step preparation fixed …".
   */
  function recordSelection(agent, route) {
    try {
      const model = agent?.model;
      if (!model || typeof model.select !== 'function') return false;
      model.select({ provider: route.provider, model: route.model });
      return true;
    } catch (error) {
      say(`agent.model.select 失败：${errorChain(error).slice(0, 160)}`);
      return false;
    }
  }

  /**
   * Process-local cache: sessionId → last agent we proved live.
   *
   * Why this exists (measured 2026-11-17): `agents.get(sessionId)` returned `undefined` even
   * right after a successful `resume()`, so every inbound message paid `create` → 
   * `SessionAlreadyExistsError` → 1.5 s backoff → `resume`. That is 1.5 s of dead time on every
   * message, and it hides the real registry miss behind a misleading "create failed" log line.
   * Caching the handle we were given is both faster and truthful: if the harness later disposes
   * it, `status` disappears and the next call falls through to the registry path again.
   */
  const proven = new Map();

  /** An agent from cache, but only when it still looks alive. */
  function liveFromCache(sessionId) {
    const cached = proven.get(sessionId);
    if (!cached) return null;
    // `status` is mirrored on every `agent/status` transition; a disposed agent has none.
    if (typeof cached.status !== 'string') {
      proven.delete(sessionId);
      return null;
    }
    return cached;
  }

  /**
   * Give the session a readable name, once — and **never overwrite one it already has**.
   *
   * 为什么要做（2026-11-18）：VoceChat 的房间键是 `vc-dm-1` / `vc-chan-1`，不写标题时侧栏里就只剩
   * 这两个字符串 —— 而 QQ 那条通道在建会话时就写了 `QQ 私聊1429709395`，两边看起来像两个产品。
   *
   * 为什么只在"没有标题"时写：`session/title` 事件有两种来源，人工改名是 `kind: 'user'`，
   * 而 `vc-chan-1` 上那个「VoceChat 生产入站验证」正是人工起的。用"与目标不同就改名"的写法会
   * 把人的命名覆盖掉，且每来一条消息都可能重写。所以判据是 `get(session) === undefined`：
   * 只补空缺，不动已有的。标题只是显示层，因此这里**永不抛**。
   */
  function nameIt(agent) {
    if (!titles || typeof titles.rename !== 'function' || typeof titleOf !== 'function') return;
    if (typeof titles.get !== 'function') return;
    const session = agent?.session;
    if (!session?.id) return;
    let current;
    try { current = titles.get(session); } catch { return; }
    if (current !== undefined) return; // 已有标题（人工或自动）：本层不碰
    let want = '';
    try { want = String(titleOf(session.id) ?? '').trim(); } catch { return; }
    if (!want) return;
    try {
      titles.rename(session, want);
      say(`titled ${session.id} → ${want}`);
    } catch (error) {
      say(`起名失败 ${session.id}：${errorChain(error).slice(0, 120)}`);
    }
  }

  /**
   * 把会话挂进工作区。
   *
   * 与 `nameIt` 一样属于显示层，因此同样**永不抛**：挂不上只影响侧栏分组，消息照发。
   * 每条会话每进程只挂一次（成功才记），失败下次再试 —— 于是"进程崩在登记中间"留下的
   * 孤儿会话会在下一条消息时自己修好。
   */
  const attached = new Set();
  async function attach(sessionId) {
    if (typeof attachTo !== 'function') return;
    const id = String(sessionId);
    if (attached.has(id)) return;
    try {
      const result = await attachTo(id);
      // `attachTo` 返回 `{attached, reason}`；没返回值时按成功处理（调用方自己的实现）。
      if (result === undefined || result === null || result.attached === true) attached.add(id);
      else say(`挂工作区未完成 ${id}：${String(result.reason ?? '').slice(0, 120)}`);
    } catch (error) {
      say(`挂工作区失败 ${id}：${errorChain(error).slice(0, 120)}`);
    }
  }

  /**
   * Ensure a live agent for `sessionId`.
   *
   * @returns {Promise<{agent: object, resumed: boolean, created: boolean, route: object}>}
   */
  async function ensure({ sessionId, presetId, cwd, provider, model, maxTokens, dataRoot = '' }) {
    const preset = await agentPresets.resolve(presetId);
    const route = routeOf({ provider, model, maxTokens });
    // 目的：让记录的选择与 workspace 守卫最终提议的 provider 一致（否则回合会以
    // proposed X after step preparation fixed Y 失败）。守卫没开时这里返回同一对。
    const guard = readWorkspaceGuard(dataRoot);
    const setup = async agentCtx => {
      await agentPresets.mount(agentCtx, preset.id);
      await setupPerAgent(agentCtx, null, String(sessionId));
    };

    // 0. Proven-live from a previous call: skip the registry entirely.
    const cached = liveFromCache(sessionId);
    if (cached) {
      recordSelection(cached, effectiveRoute(route, cwd, guard));
      nameIt(cached);
      await attach(String(sessionId));
      return { agent: cached, resumed: true, created: false, route, cached: true };
    }

    // 1. Already live in this process: attach without touching the registry.
    const live = agents.get(sessionId);
    if (live !== undefined) {
      // A live agent created by another row already has its preset bound; mounting again would
      // be refused by the scope binding. We only add what its own setup could not: our hooks.
      if (live.ctx !== undefined && live.ctx !== null) {
        try { await setupPerAgent(live.ctx, live, String(sessionId)); } catch (error) {
          say(`hook install failed on live ${sessionId}: ${errorChain(error).slice(0, 160)}`);
        }
      }
      recordSelection(live, effectiveRoute(route, cwd, guard));
      proven.set(sessionId, live);
      nameIt(live);
      await attach(String(sessionId));
      return { agent: live, resumed: true, created: false, route };
    }

    const createOptions = {
      meta: { cwd, agentPreset: preset.id },
      agentOptions: route,
      setup,
    };

    // 2. Fresh create.
    try {
      const handle = await agents.create({ ...createOptions, sessionId });
      recordSelection(handle.agent, effectiveRoute(route, cwd, guard));
      proven.set(String(sessionId), handle.agent);
      nameIt(handle.agent);
      await attach(String(sessionId));
      return { agent: handle.agent, resumed: false, created: true, route };
    } catch (createError) {
      const text = errorChain(createError);
      say(`create failed for ${sessionId}: ${text.slice(0, 200)}`);
      // Only "already exists" is recoverable. A validation or preset error must surface: retrying
      // it three times would turn one clear failure into a three-second delay plus the same failure.
      if (!/already exists/i.test(text)) throw createError;
    }

    // 3. It is a session from a previous run: hydrate it.
    let lastError = null;
    for (let attempt = 0; attempt < RESUME_ATTEMPTS; attempt += 1) {
      // The first retry goes out immediately. The backoff exists for one specific race (another
      // row is mid-publish on this session id, so `resume` would hit an inconsistent registry);
      // in the common case — process restarted, session already on disk — there is no race at
      // all, and paying 1.5 s per first message is pure latency. Waiting only from attempt 2
      // keeps the race protection where it is actually needed.
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, RESUME_BACKOFF_MS * attempt));
      const again = agents.get(sessionId);
      if (again !== undefined) {
        if (again.ctx !== undefined && again.ctx !== null) {
          try { await setupPerAgent(again.ctx, again, String(sessionId)); } catch (error) {
            say(`hook install failed on ${sessionId} (retry ${attempt + 1}): ${errorChain(error).slice(0, 160)}`);
          }
        }
        say(`resumed ${sessionId} (retry ${attempt + 1}, live registry)`);
        recordSelection(again, effectiveRoute(route, cwd, guard));
        proven.set(String(sessionId), again);
        nameIt(again);
        await attach(String(sessionId));
        return { agent: again, resumed: true, created: false, route };
      }
      try {
        const handle = await agents.resume({ resumeSessionId: sessionId, agentOptions: route, setup });
        say(`resumed ${sessionId} (retry ${attempt + 1}, persisted)`);
        recordSelection(handle.agent, effectiveRoute(route, cwd, guard));
        proven.set(String(sessionId), handle.agent);
        nameIt(handle.agent);
        return { agent: handle.agent, resumed: true, created: false, route };
      } catch (resumeError) {
        lastError = resumeError;
        say(`resume ${sessionId} retry ${attempt + 1} failed: ${errorChain(resumeError).slice(0, 160)}`);
      }
    }
    throw lastError ?? new Error(`无法恢复会话 ${sessionId}`);
  }

  return { ensure, errorChain };
}

export { RESUME_ATTEMPTS, RESUME_BACKOFF_MS };
