// P2 autonomy ports for the companion foundation plugin.
//
// The runtime never does network or filesystem IO itself: it receives these ports. Keeping
// them here means the character's own workspace, the public-web allowlist and the model
// route stay in the plugin that already owns the host integration, and a test can mount the
// runtime with fake ports without touching this file.
//
// Nothing in this module writes memory or sends messages: the memory port only forwards to
// the public `ingestDomainEvent` entry of the existing memory engine, and the share port only
// forwards a candidate to whatever the contact owner exposes (if anything).

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHostWebPort } from './autonomy-host-web.mjs?v=reading-20261101-v2';
import { createHostLlmAdapter } from './host-llm.mjs?v=0.4.0';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINKS, DEFAULT_SEARCH_PROVIDER, DEFAULT_TIMEOUT_MS, createWebPort } from './autonomy-web.mjs?v=reading-20261101-v1';
import { createMemoryPort } from './autonomy-memory.mjs?v=0.1.0';
import { createMaterialsPort } from './autonomy-materials.mjs?v=reading-20261101-v1';

const MAX_FETCH_BYTES = DEFAULT_MAX_BYTES;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Build the P2 ports for one mounted companion.
 *
 * @param root     companion root directory (the same `root` mountRuntime received)
 * @param ctx      host context (for the LLM service)
 * @param options  { artifactRoot, readRoots, allowedSources, seedUrls, searchProvider,
 *                   maxLinksPerPage, model:{provider,model}, engine, outbox, fetchImpl, now }
 */
export function createAutonomyPorts({ root, ctx, options = {} }) {
  const artifactRoot = path.resolve(root, options.artifactRoot ?? 'workspace/companion-works');
  const readRoots = (Array.isArray(options.readRoots) ? options.readRoots : []).map(entry => path.resolve(root, entry));
  const allowedSources = options.allowedSources ?? [];

  function inside(target, base) {
    const resolved = path.resolve(target);
    const relative = path.relative(base, resolved);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  function textOf(value) {
    return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
  }

  /**
   * Real foreground signal for the budget's `shouldYield()` (contract §3).
   *
   * The host owns the truth: `ctx.get('agents').list()` returns the live agents and each
   * one's `status` is `'running'` while a turn is in flight (including a turn parked on an
   * approval). This fails **closed**: a missing service, an unreadable registry or a list
   * that is not an array all mean "busy", because a background day must never compete with
   * a chat turn.
   */
  function isForegroundBusy() {
    let agents = null;
    try { agents = typeof ctx?.get === 'function' ? ctx.get('agents') : null; } catch { return true; }
    if (!agents || typeof agents.list !== 'function') return true;
    let list;
    try { list = agents.list(); } catch { return true; }
    if (!Array.isArray(list)) return true;
    return list.some(agent => {
      if (textOf(agent?.status).toLowerCase() === 'running') return true;
      const session = agent?.session;
      return Boolean(session) && (textOf(session.status).toLowerCase() === 'running' || session.busy === true);
    });
  }

  // Public web discovery (contract v1.2 section 4). Every request — search, link discovery
  // and page fetch — is validated against the allowlist and the private-host rule.
  const web = options.searchProvider === 'dsh' ? createHostWebPort({
    ctx, root, allowedSources, seedUrls: options.seedUrls ?? [], topics: options.topics ?? [],
    maxSearchesPerDay: options.maxSearchesPerDay ?? 6, maxBytes: options.maxBytes ?? MAX_FETCH_BYTES,
    timeoutMs: options.timeoutMs ?? 30000, now: options.now,
  }) : createWebPort({
    allowedSources,
    seedUrls: options.seedUrls ?? [],
    searchProvider: options.searchProvider ?? DEFAULT_SEARCH_PROVIDER,
    maxLinksPerPage: options.maxLinksPerPage ?? DEFAULT_MAX_LINKS,
    maxBytes: options.maxBytes ?? MAX_FETCH_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
    now: options.now,
  });

  /**
   * Planning material (contract v1.2 §3). The runtime passes its own DB-derived slice as
   * `runtime`; everything this plugin can know truthfully (persona, capabilities, public
   * entry points) is added here, and any section nobody can answer is labelled `missing`.
   */
  const materialsPort = createMaterialsPort({
    root,
    identity: options.identity ?? null,
    web,
    options: {
      readRoots,
      artifactRoot: options.artifactRoot ?? 'workspace/companion-works',
      timeZone: options.timeZone,
      personaFile: options.personaFile,
      personaMaxChars: options.personaMaxChars,
      seedVerify: options.seedVerify,
      seedLimit: options.searchProvider === 'dsh' ? 8 : options.seedLimit,
      continuity: options.continuity,
      now: options.now,
    },
  });

  const ports = {
    /** Public web page: allowlisted host re-checked on every hop, capped, HTML reduced to text. */
    async fetchPage({ url, scopeKey } = {}) {
      return web.fetchPage({ url, scopeKey });
    },

    /** Public search: allowlisted provider host only, honest `search-unavailable` failures. */
    async search({ query, limit } = {}) {
      return web.search({ query, limit });
    },

    /** Absolute, deduped, bounded links from one page that is already allowed. */
    async discoverLinks({ url, limit } = {}) {
      return web.discoverLinks({ url, limit });
    },

    /** Concrete candidate sources (verified seed pages first, then one live search). */
    async seeds({ topic, limit, budget, verify } = {}) {
      return web.seeds({ topic, limit, budget, verify });
    },

    /** Real host foreground state; the budget's `shouldYield` hook reads this. */
    isForegroundBusy,

    /** Read a local text source inside one of the allowed read roots. */
    async readFile({ path: filePath } = {}) {
      const target = String(filePath ?? '').trim();
      if (!target) return { ok: false, code: 'source-invalid', reason: 'empty-path' };
      const absolute = path.resolve(root, target);
      const allowed = readRoots.some(base => inside(absolute, base)) || inside(absolute, artifactRoot);
      if (!allowed) return { ok: false, code: 'source-invalid', reason: 'path-not-allowed' };
      try {
        const stat = await fs.stat(absolute);
        if (!stat.isFile()) return { ok: false, code: 'source-invalid', reason: 'not-a-file' };
        if (stat.size > MAX_FETCH_BYTES) return { ok: false, code: 'source-invalid', reason: 'too-large' };
        const text = await fs.readFile(absolute, 'utf8');
        return { ok: true, text, bytes: Buffer.byteLength(text), sha256: sha256(text), path: absolute };
      } catch (error) {
        return { ok: false, code: 'source-not-found', reason: error instanceof Error ? error.message : String(error) };
      }
    },

    /** Write only inside the character's own artifact root. */
    async writeFile({ path: filePath, text } = {}) {
      const target = String(filePath ?? '').trim();
      if (!target) return { ok: false, code: 'workspace-denied', reason: 'empty-path' };
      const absolute = path.resolve(artifactRoot, target);
      if (!inside(absolute, artifactRoot)) return { ok: false, code: 'workspace-denied', reason: 'outside-artifact-root' };
      try {
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, String(text ?? ''), 'utf8');
        const body = String(text ?? '');
        return { ok: true, bytes: Buffer.byteLength(body), sha256: sha256(body), path: absolute };
      } catch (error) {
        return { ok: false, code: 'write-failed', reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };

  let adapter = null;
  let adapterError = '';
  const model = {
    /** Model port for P2 only: its own purpose label, never the memory-extraction one. */
    async call({ purpose = 'p2-planning', system = '', input = '', maxTokens = 2048, signal } = {}) {
      if (!adapter) {
        try {
          adapter = await createHostLlmAdapter(ctx, {
            provider: options.model?.provider ?? '',
            model: options.model?.model ?? '',
            timeoutMs: options.model?.timeoutMs ?? 90000,
          // One budget reservation must be at most one physical generation: the adapter's hidden
          // retries are disabled for P2, and a failed attempt is billed and retried by the
          // planner/executor instead (which is where the accounting lives).
          allowFallback: false,
            reasoningEffort: 'low',
            purpose: purpose === 'p2-activity' ? 'p2-activity' : 'p2-planning',
          });
        } catch (error) {
          adapterError = error instanceof Error ? error.message : String(error);
          throw error;
        }
      }
      const started = Date.now();
      const text = await adapter.complete({ system, input, maxTokens, signal });
      const body = String(text ?? '');
      return {
        text: body,
        provider: adapter.provider ?? '',
        model: adapter.model ?? '',
        // The host adapter returns text only; token counts are a documented estimate so the
        // budget stays enforceable without inventing precision.
        inputTokens: Math.ceil((String(system).length + String(input).length) / 4),
        outputTokens: Math.ceil(body.length / 4),
        estimated: true,
        elapsedMs: Date.now() - started,
        purpose,
      };
    },
    describe: () => ({ provider: adapter?.provider ?? options.model?.provider ?? '', model: adapter?.model ?? options.model?.model ?? '', error: adapterError }),
  };

  /**
   * Long-term memory: only the existing public ingest entry, only for actual activity
   * (contract v1.2 section 5). `createMemoryPort` owns scope parsing, the deterministic
   * dedupe key and the write-through into the runtime's existing `memory_outbox`.
   */
  const memoryPort = (options.engine && typeof options.engine.ingestDomainEvent === 'function') || options.outbox
    ? createMemoryPort({ engine: options.engine ?? null, outbox: options.outbox ?? null, now: options.now })
    : null;

  return {
    ports,
    model,
    memoryPort,
    web,
    materials: materialsPort.materials,
    persona: materialsPort.persona,
    continuity: materialsPort.continuity,
    preferences: materialsPort.preferences,
    isForegroundBusy,
    artifactRoot,
    describe: () => ({
      artifactRoot,
      readRoots,
      allowedSources,
      model: model.describe(),
      web: web.describe(),
      materials: materialsPort.describe(),
      memory: memoryPort?.describe() ?? null,
      foreground: { port: 'isForegroundBusy', wired: typeof ctx?.get === 'function' },
    }),
  };
}

/**
 * The chat-facing life view (P2-16): current activity, what is planned next, what is left.
 * Answers "你在做什么 / 今天准备干什么 / 刚才看到哪儿了" from the real runtime state.
 */
export function lifeSection(runtime, { bound } = {}) {
  if (!runtime || typeof runtime.p2Status !== 'function') return '';
  let status;
  try { status = runtime.p2Status({ bound }); } catch { return ''; }
  if (!status || !status.planning) return '';
  const lines = [];
  const plan = status.planning.plan;
  if (plan && plan.slots?.length) {
    const now = Date.now();
    const next = plan.slots.find(slot => slot.endAt > now && slot.status !== 'skipped');
    const finished = plan.slots.filter(slot => slot.endAt <= now || slot.status === 'done');
    const pending = plan.slots.filter(slot => slot.status === 'planned' && slot.endAt > now);
    if (next) lines.push(`接下来：${next.title}${next.activity ? `（${next.activity}）` : ''} ${new Date(next.startAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}–${new Date(next.endAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
    if (finished.length) lines.push(`今天已结束：${finished.length} 段`);
    if (pending.length) lines.push(`未完成待续：${pending.length} 段`);
  } else if (status.planning.enabled && status.planning.state !== 'paused') {
    lines.push('今天还没有正式安排（可以闲置，也可以等下一机会再排）');
  }
  const running = status.activities?.running > 0;
  if (running) {
    // The activity list carries the checkpoint; read it through the runtime API so the prompt
    // never claims progress that the receipts do not support.
    try {
      const list = runtime.listActivities({ bound });
      const current = list?.activities?.find(item => item.status === 'running' || item.status === 'paused');
      if (current) lines.push(`正在做：${current.kind} · ${String(current.target ?? '').slice(0, 60)}（已处理 ${current.consumed}/${current.totalUnits || '?'}）`);
    } catch { /* status only */ }
  } else if (status.activities?.enabled) {
    lines.push('当前没有进行中的活动');
  }
  const budget = status.budget;
  if (budget) lines.push(`自主预算：请求 ${budget.requests.used}/${budget.requests.limit}，输出 token ${budget.outputTokens.used}/${budget.outputTokens.limit}`);
  if (!lines.length) return '';
  return ['【今天的生活】', ...lines.map(line => `- ${line}`), '这些是真实状态；计划不等于已经做过，没有回执的事不要当成经历说。'].join('\n');
}
