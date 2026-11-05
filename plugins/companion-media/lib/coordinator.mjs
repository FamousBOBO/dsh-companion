/**
 * Client for the shared 8139 GPU coordinator (`runtime/gpu_model_gateway.py`).
 *
 * The coordinator already serialises vision and speech, loads models lazily and
 * releases them after `idle_seconds`, but it only ever reacts to a real request.
 * This module adds what a companion needs to drive it deliberately:
 *
 *   - `warm` sends the smallest real request that makes the coordinator load the
 *     weights (a queue of one: never two backends at once);
 *   - `release` drops the weights now, including the in-memory model;
 *   - an idle watchdog releases everything after the configured quiet period,
 *     even when the user stops talking mid-conversation.
 *
 * Sequencing rule: calls run one at a time (`serialize`). Switching backends is
 * allowed before or after another call, never during one.
 */
import { mediaError, Code } from './errors.mjs';
import { spawn } from 'node:child_process';

const VISION_WARM_PROMPT = 'warmup';
const VOICE_WARM_TEXT = '嗯';

export function createCoordinator({
  config,
  fetchImpl = fetch,
  now = () => Date.now(),
  log = () => {},
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const runtime = config.runtime ?? {};
  const baseUrl = String(runtime.baseUrl ?? 'http://127.0.0.1:8139').replace(/\/$/, '');
  const idleSeconds = Number(runtime.idleReleaseSeconds ?? 300);
  const loadTimeoutMs = Number(runtime.loadTimeoutMs ?? 300_000);
  const pollIntervalMs = Number(runtime.pollIntervalMs ?? 500);
  const retryAttempts = Math.max(1, Number(runtime.warmRetry?.attempts ?? 3));
  const retryDelayMs = Math.max(0, Number(runtime.warmRetry?.delayMs ?? 1500));

  /**
   * A cold coordinator answers 502/503/504 while Ollama is still coming up (the
   * first vision request during startup has been observed returning 504 after
   * ~6-9s). Warming is exactly the case where that must not be reported as a
   * failure, so retry those codes a few times before giving up.
   */
  async function withRetry(attempt, label) {
    let lastError;
    for (let index = 1; index <= retryAttempts; index += 1) {
      try {
        return await attempt();
      } catch (error) {
        lastError = error;
        const retryable = /MEDIA_BACKEND_FAILED/.test(String(error?.code ?? '')) && /\b(502|503|504)\b/.test(String(error?.message ?? ''));
        if (!retryable || index === retryAttempts) throw error;
        log(`${label}: ${error.message}; retry ${index}/${retryAttempts - 1} after ${retryDelayMs}ms`);
        await new Promise(resolve => setTimeoutImpl(resolve, retryDelayMs));
      }
    }
    throw lastError;
  }

  let queue = Promise.resolve();
  let idleTimer = null;
  let lastUsedAt = 0;
  let lastWarm = null;
  let released = 0;
  let warming = null;

  /** Serialise every backend interaction; `warming` mirrors the in-flight kind. */
  function serialize(task) {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function request(path, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeoutImpl(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(`${baseUrl}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeoutImpl(timer);
    }
  }

  async function health() {
    const response = await request('/health', { method: 'GET' }, 10_000);
    if (!response.ok) throw mediaError(Code.BACKEND_FAILED, `coordinator health returned ${response.status}`);
    return response.json();
  }

  /**
   * Make sure the coordinator is listening.
   *
   * It is a plain side process that dies with its parent shell (observed twice):
   * every media call after that fails with a bare connection error. When
   * `runtime.autoStart.enabled` is set, start it detached and wait for `/health`.
   */
  async function ensureRunning() {
    const live = await health().catch(() => null);
    if (live !== null) return { started: false, health: live };
    const auto = runtime.autoStart ?? {};
    if (auto.enabled !== true) {
      throw mediaError(
        Code.BACKEND_UNAVAILABLE,
        `coordinator unreachable at ${baseUrl}; start runtime/gpu_model_gateway.py or enable runtime.autoStart`,
      );
    }
    const python = String(auto.pythonPath ?? '');
    const script = String(auto.scriptPath ?? '');
    if (!python || !script) {
      throw mediaError(Code.BAD_INPUT, 'runtime.autoStart needs pythonPath and scriptPath');
    }
    try {
      const child = spawn(python, [script], {
        cwd: auto.cwd ?? undefined,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      log(`coordinator auto-start: spawned ${python} ${script}`);
    } catch (error) {
      throw mediaError(Code.BACKEND_UNAVAILABLE, `coordinator auto-start failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const deadline = now() + Number(auto.waitMs ?? 15_000);
    for (;;) {
      const status = await health().catch(() => null);
      if (status !== null) return { started: true, health: status };
      if (now() >= deadline) {
        throw mediaError(Code.BACKEND_UNAVAILABLE, `coordinator did not answer at ${baseUrl} within ${Number(auto.waitMs ?? 15_000)}ms after auto-start`);
      }
      await new Promise(resolve => setTimeoutImpl(resolve, pollIntervalMs));
    }
  }

  function touch() {
    lastUsedAt = now();
    if (!(idleSeconds > 0)) return;
    if (idleTimer !== null) clearTimeoutImpl(idleTimer);
    idleTimer = setTimeoutImpl(() => {
      idleTimer = null;
      void watchRelease();
    }, idleSeconds * 1000);
    // Never keep the host process alive just to unload a model.
    if (typeof idleTimer === 'object' && idleTimer !== null && typeof idleTimer.unref === 'function') idleTimer.unref();
  }

  async function watchRelease() {
    try {
      const status = await release();
      log(`idle ${idleSeconds}s: released ${status.releasedActive ?? 'model'} weights`);
    } catch (error) {
      log(`idle release failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function release() {
    return serialize(async () => {
      const response = await request('/unload', { method: 'POST' }, 60_000);
      if (!response.ok) throw mediaError(Code.BACKEND_FAILED, `coordinator unload returned ${response.status}`);
      const body = await response.json().catch(() => ({}));
      released += 1;
      lastUsedAt = 0;
      if (idleTimer !== null) {
        clearTimeoutImpl(idleTimer);
        idleTimer = null;
      }
      return { ok: true, action: 'release', active: body.active ?? null, health: await health().catch(() => null) };
    });
  }

  /**
   * Wait until the coordinator is not in the middle of a request. A loaded idle
   * backend does not block: the coordinator unloads it when the next POST switches
   * backends, so waiting for `active === null` would deadlock against a warm model.
   */
  async function waitUntilFree(timeoutMs) {
    const deadline = now() + timeoutMs;
    for (;;) {
      const status = await health().catch(() => null);
      if (status === null) return null;
      if (status.busy !== true) return status;
      if (now() >= deadline) {
        throw mediaError(Code.BACKEND_BUSY, `coordinator still busy with ${status.active ?? 'another request'} after ${timeoutMs}ms`);
      }
      await new Promise(resolve => setTimeoutImpl(resolve, pollIntervalMs));
    }
  }

  async function loadVision(timeoutMs) {
    const model = config.vision?.local?.model;
    const response = await request('/ollama/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: VISION_WARM_PROMPT,
        stream: false,
        keep_alive: '5m',
        options: { num_predict: 1, temperature: 0 },
      }),
    }, timeoutMs);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw mediaError(Code.BACKEND_FAILED, `vision warmup returned ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
    }
    await response.arrayBuffer().catch(() => undefined);
    return { backend: 'vision', model, path: '/ollama/api/generate' };
  }

  async function loadVoice(timeoutMs) {
    const backend = config.speech?.backend ?? {};
    const response = await request('/breeze/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: backend.model,
        input: VOICE_WARM_TEXT,
        voice: backend.voice,
        response_format: 'wav',
        speed: 1,
      }),
    }, timeoutMs);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw mediaError(Code.BACKEND_FAILED, `voice warmup returned ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
    }
    await response.arrayBuffer().catch(() => undefined);
    return { backend: 'voice', model: backend.model, voice: backend.voice, path: '/breeze/v1/audio/speech' };
  }

  /**
   * Load one backend. Refuses to start while another load is in flight, waits for
   * the coordinator to finish, then loads. Returns timing and the effective state.
   */
  async function warm({ target } = {}) {
    if (target !== 'voice' && target !== 'vision') {
      throw mediaError(Code.BAD_INPUT, "target must be 'voice' or 'vision'");
    }
    if (warming !== null) {
      throw mediaError(Code.BACKEND_BUSY, `already warming ${warming}; voice and vision never load at the same time`);
    }
    warming = target;
    const startedAt = now();
    try {
      return await serialize(async () => {
        // Bring the side process back if it died, before waiting on anything.
        const boot = await ensureRunning().catch(error => ({ error }));
        if (boot?.error) throw boot.error;
        const before = boot?.health?.busy === true ? await waitUntilFree(loadTimeoutMs) : boot?.health;
        const loaded = await withRetry(
          () => (target === 'voice' ? loadVoice(loadTimeoutMs) : loadVision(loadTimeoutMs)),
          `warm ${target}`,
        );
        const after = await health().catch(() => null);
        lastWarm = { target, at: new Date(startedAt).toISOString(), elapsedMs: now() - startedAt };
        touch();
        return {
          ok: true,
          action: 'warm',
          target,
          elapsedMs: now() - startedAt,
          loaded,
          switchedFrom: before?.active && before.active !== target ? before.active : null,
          active: after?.active ?? null,
          idleReleaseSeconds: idleSeconds,
          visionModels: after?.vision_models ?? null,
        };
      });
    } finally {
      warming = null;
    }
  }

  async function status() {
    const current = await health().catch(error => ({ error: error instanceof Error ? error.message : String(error), active: null }));
    const idleRemainingSeconds = lastUsedAt > 0 && idleSeconds > 0
      ? Math.max(0, idleSeconds - Math.floor((now() - lastUsedAt) / 1000))
      : null;
    return {
      ok: current.error === undefined,
      action: 'status',
      baseUrl,
      active: current.active ?? null,
      busy: current.busy ?? null,
      idleSeconds,
      idleRemainingSeconds,
      lastWarm,
      released,
      visionModels: current.vision_models ?? (current.error ? [] : null),
      error: current.error ?? null,
    };
  }

  return { warm, release, status, touch, health, waitUntilFree, idleSeconds, baseUrl };
}
