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
 * @param {(line: string) => void} [input.log]
 */
export function createSessions({ agents, agentPresets, agentDefaultModel = null, setupPerAgent, log = null } = {}) {
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
        return { agent: again, resumed: true, created: false, route };
      }
      try {
        const handle = await agents.resume({ resumeSessionId: sessionId, agentOptions: route, setup });
        say(`resumed ${sessionId} (retry ${attempt + 1}, persisted)`);
        recordSelection(handle.agent, effectiveRoute(route, cwd, guard));
        proven.set(String(sessionId), handle.agent);
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
