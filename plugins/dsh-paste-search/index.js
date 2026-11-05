// DSH 搜图 · Host 半
//
// 职责边界（按需求）：这个插件**不自己实现任何搜图请求**。
// 它只做两件事：
//   1. 入口：把面板塞进来的「目标图 + 补充说明」落成一个新工作区目录，
//      并为这一次搜索起一个**全新的会话**（每次搜索一个会话）；
//   2. 工具：给那个会话一份任务书，并提供面板读取结果所需的本机 HTTP 接口
//      （状态 / 结果文件 / 图片代理）。
//
// 真正的 SauceNAO / IQDB / Ascii2D / P 站原图怎么查，由那个会话里的 agent
// 自己用它的工具去实现；它把结论写进工作目录的 .paste-search/result.json，
// 面板轮询这个文件即可，不需要插件理解搜图协议。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-paste-search';

/** searchId → { searchId, sessionId, dir, imagePath, notes, createdAt, error } */
const searches = new Map();

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function fail(code, message, status = 200) {
  return json({ ok: false, error: { code, message } }, status);
}

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function decodeImageDataUrl(dataUrl) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(dataUrl ?? ''));
  if (!match) return undefined;
  const mime = match[1].toLowerCase();
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) return undefined;
  if (buffer.length > 24 * 1024 * 1024) return undefined;
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'jpg';
  return { mime, ext, buffer };
}

/** 结果文件：会话自己写，面板自己读；插件只负责「读得到就返回」。 */
function readResultFile(dir) {
  const file = path.join(dir, '.paste-search', 'result.json');
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readJournal(dir) {
  const file = path.join(dir, '.paste-search', 'journal.md');
  try {
    return fs.readFileSync(file, 'utf8').slice(-8000);
  } catch {
    return undefined;
  }
}

const TEMPLATE_PATH = (() => {
  try {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), 'task-template.md');
  } catch {
    // 用 data:/vm 方式载入时没有 file URL（自测脚手架会走这里）。
    return process.env.DSH_PASTE_SEARCH_TEMPLATE ?? path.join(process.cwd(), 'task-template.md');
  }
})();

function buildTaskFile({ imagePath, notes, searchId, extras }) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const extraBlock = extras.length === 0
    ? '（无）'
    : extras.map((entry) => `- \`${entry.path}\`${entry.name && entry.name !== path.basename(entry.path) ? `（原名 ${entry.name}）` : ''}`).join('\n');
  return template
    .replaceAll('{{searchId}}', searchId)
    .replaceAll('{{imagePath}}', imagePath)
    .replaceAll('{{extras}}', extraBlock)
    .replaceAll('{{notes}}', notes?.trim() ? notes.trim() : '（无）');
}

/**
 * 搜索根目录 = **一个**固定的工作区（`<用户工作区>/paste-search-sessions`）。
 * 每次搜索只是这个工作区里的一个会话 + 一个子目录，不再单独开工作区。
 */
function resolveSearchRoot(ctx) {
  try {
    const workspaces = ctx.get('workspaceRegistry')?.list?.() ?? [];
    const candidates = workspaces
      .filter((entry) => typeof entry?.path === 'string' && entry.path.length > 0 && !entry.path.includes('paste-search-sessions'))
      .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
    const active = candidates[0];
    if (active) return path.join(active.path, 'paste-search-sessions');
  } catch { /* 注册表不可用就走兜底 */ }
  return path.join(ctx.get('workingDirectory')?.defaultDirectory ?? process.cwd(), 'paste-search-sessions');
}

/** 早期版本「每次搜索建一个工作区」留下的空行：顺手清掉，别让侧栏堆垃圾。 */
function cleanupStaleWorkspaces(ctx, keepRoot) {
  try {
    const registry = ctx.get('workspaceRegistry');
    if (!registry || typeof registry.delete !== 'function') return;
    for (const entry of registry.list?.() ?? []) {
      const dir = entry?.path ?? '';
      if (!dir.includes('paste-search-sessions')) continue;
      if (keepRoot !== undefined && path.resolve(dir) === path.resolve(keepRoot)) continue; // 现在用的这个根，留
      if (Array.isArray(entry.sessionIds) && entry.sessionIds.length > 0) continue;
      Promise.resolve(registry.delete(entry.id)).catch(() => {});
    }
  } catch { /* 清理失败无所谓 */ }
}

/**
 * 只注册一次「搜图」工作区，并把 Workspace 实例返回给调用方：
 * 会话建好后要靠它 `attachSession()` 才会出现在这个工作区的对话列表里。
 */
let registeredRoot;
let registeredWorkspace;
async function ensureSearchWorkspace(ctx, root) {
  cleanupStaleWorkspaces(ctx, root);
  if (registeredRoot === root && registeredWorkspace) return registeredWorkspace;
  try {
    const registry = ctx.get('workspaceRegistry');
    let workspace = await registry?.resolveByPath?.(root);
    if (!workspace) workspace = await registry?.create?.(root, '搜图');
    registeredRoot = root;
    registeredWorkspace = workspace;
    return workspace;
  } catch { /* 注册失败不影响搜索本身 */ }
  return undefined;
}

/** 会话建好之后挂进「搜图」工作区；cwd 与工作区路径不一致时 attach 会拒绝，记下来方便排查。 */
async function attachToWorkspace(workspace, sessionId) {
  if (!workspace || typeof workspace.attachSession !== 'function') return 'no-workspace';
  try {
    await workspace.attachSession(sessionId);
    return 'attached';
  } catch (error) {
    return String(error?.message ?? error).slice(0, 240);
  }
}

/**
 * 搜索结果出来后把会话重命名成一眼能认出的一条：
 * 「搜图 · pixiv 原作 #130756078，作者 udon.」这类。只在结果真的变了时改一次。
 */
function titleFor(result) {
  const summary = String(result?.summary ?? '').trim();
  const first = Array.isArray(result?.items) ? result.items[0] : undefined;
  const base = summary
    || [first?.title, first?.author].filter(Boolean).join(' · ')
    || (first?.target ? String(first.target) : '');
  if (!base) return undefined;
  return `搜图 · ${base.replace(/\s+/g, ' ').trim().slice(0, 48)}`;
}

function renameAfterSearch(ctx, session, record) {
  try {
    const result = readResultFile(record.dir);
    const title = titleFor(result);
    if (!title || record.titleApplied === title) return;
    const service = ctx.get('sessionTitle');
    if (!service || typeof service.rename !== 'function') return;
    service.rename(session, title);
    record.titleApplied = title;
    record.title = title;
  } catch { /* 重命名失败不影响结果 */ }
}

/** 把面板送来的附件收集成 [{ name, dataUrl }]，兼容旧的单个 image 字段。 */
function collectAttachments(payload) {
  const list = [];
  if (Array.isArray(payload?.attachments)) list.push(...payload.attachments);
  if (payload?.image && list.length === 0) list.push({ name: payload.name ?? 'input', dataUrl: payload.image });
  return list
    .map((entry) => ({ name: String(entry?.name ?? ''), dataUrl: String(entry?.dataUrl ?? '') }))
    .filter((entry) => entry.dataUrl.startsWith('data:'));
}

function safeFileName(name, fallback) {
  const base = String(name || '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(0, 80);
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * 搜图会话要自己干活：禁掉委派/团队类工具（尤其 subagent → codex）。
 * 不同 profile 暴露的工具不同，所以从宽到窄试几档，能禁多少禁多少。
 */
function lockDelegation(agent) {
  const wanted = ['subagent', 'spawn_teammate', 'send_message', 'wait_agent', 'interrupt_agent', 'list_agents', 'team_task_create', 'team_task_update', 'team_task_get', 'team_task_list', 'workflow'];
  const locked = [];
  for (const name of wanted) {
    try {
      agent.ctx.tools.restrict({ deny: [name] });
      locked.push(name);
    } catch { /* 这份组合里没有这个名字，跳过 */ }
  }
  // 动态注册的工具（subagent 之类）可能不在可限制名单里，再兜一层执行期拦截。
  try {
    const denial = '这个会话不委派：不要用 subagent / codex / 团队工具，自己用 pwsh、web_fetch、read_image 完成搜索。';
    agent.ctx.tools.guard((exec) => (wanted.includes(exec?.name) ? denial : undefined));
    locked.push('guard');
  } catch { /* 守卫装不上也不致命 */ }
  return locked;
}

/**
 * 搜图会话必须是「能干活的」那份组合：本 profile 的默认 preset 是 companion
 * （QQ/bili 那套，没有 shell/文件工具），所以优先挑 standard。
 */
async function pickSearchPreset(ctx) {
  try {
    const presets = (await ctx.get('agentPresets')?.list?.()) ?? [];
    const ids = new Set(presets.map((preset) => preset.id));
    for (const candidate of ['standard', 'minimal', 'cordis']) {
      if (ids.has(candidate)) return candidate;
    }
  } catch { /* 拿不到就按默认组合 */ }
  return undefined;
}

async function startSearch(ctx, payload) {
  const attachments = collectAttachments(payload);
  const images = [];
  const others = [];
  for (const entry of attachments) {
    const decoded = decodeImageDataUrl(entry.dataUrl);
    if (decoded) images.push({ ...entry, ...decoded });
    else if (/^data:[^;]+;base64,/.test(entry.dataUrl)) {
      const mime = /^data:([^;]+);base64,/.exec(entry.dataUrl)?.[1] ?? 'application/octet-stream';
      const buffer = Buffer.from(entry.dataUrl.slice(entry.dataUrl.indexOf(',') + 1), 'base64');
      if (buffer.length > 0 && buffer.length <= 24 * 1024 * 1024) others.push({ name: entry.name || 'file', mime, buffer });
    }
  }
  if (images.length === 0) return { error: fail('bad-image', '至少要一张图片（JPEG/PNG/WebP/GIF，每张 ≤24MB）') };

  const workspaceBase = resolveSearchRoot(ctx);
  fs.mkdirSync(workspaceBase, { recursive: true });

  const searchId = randomUUID();
  const dir = path.join(workspaceBase, `${stamp()}-${searchId.slice(0, 6)}`);
  fs.mkdirSync(path.join(dir, '.paste-search'), { recursive: true });
  // 第一张图是「目标图」；同一次任务里的其余图片和任意文件都放进 files/。
  const primary = images[0];
  const imagePath = path.join(dir, `input.${primary.ext}`);
  fs.writeFileSync(imagePath, primary.buffer);
  const extras = [];
  const extraImages = images.slice(1);
  if (extraImages.length > 0 || others.length > 0) fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  extraImages.forEach((entry, index) => {
    const target = path.join(dir, 'files', safeFileName(entry.name, `image-${index + 2}.${entry.ext}`));
    fs.writeFileSync(target, entry.buffer);
    extras.push({ path: target, name: entry.name });
  });
  for (const entry of others) {
    const target = path.join(dir, 'files', safeFileName(entry.name, `file-${extras.length + 1}`));
    fs.writeFileSync(target, entry.buffer);
    extras.push({ path: target, name: entry.name });
  }

  fs.writeFileSync(
    path.join(dir, '.paste-search', 'task.md'),
    buildTaskFile({ imagePath, notes: payload?.notes, searchId, extras }),
    'utf8',
  );

  // 结论先行：先把记录放进表里，哪怕后面会话起不来面板也能看到错误。
  const record = { searchId, sessionId: undefined, dir, imagePath, notes: String(payload?.notes ?? ''), createdAt: new Date().toISOString(), error: undefined };
  searches.set(searchId, record);

  // 同一个「搜图」工作区，每次搜索只在这里多一个会话 + 一个子目录。
  const searchWorkspace = await ensureSearchWorkspace(ctx, workspaceBase);

  const agents = ctx.get('agents');
  if (!agents || typeof agents.create !== 'function') {
    record.error = '这个 profile 没有 agents 服务，起不了会话来干活';
    return { error: fail('no-agents', record.error) };
  }

  const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
  const agentOptions = selection?.provider && selection?.model ? { provider: selection.provider, model: selection.model } : {};
  const agentPreset = await pickSearchPreset(ctx);
  const sessionId = randomUUID();

  try {
    const handle = await agents.create({
      sessionId,
      meta: { cwd: workspaceBase, ...(agentPreset ? { agentPreset } : {}) },
      agentOptions,
    });
    record.sessionId = sessionId;
    record.agentPreset = agentPreset;
    record.agent = handle.agent;
    // 低层 API 不会自动装 preset：显式切到「能干活的」那份组合，否则搜图会话只有 IM 工具。
    if (agentPreset) {
      try {
        await ctx.get('agentPresets')?.select?.(handle.agent, agentPreset);
      } catch (error) {
        record.presetError = String(error?.message ?? error).slice(0, 200);
      }
    }
    // 挂进「搜图」工作区，否则会话不会出现在那一组下面。
    record.workspace = await attachToWorkspace(searchWorkspace, sessionId);
    record.lockedTools = lockDelegation(handle.agent);
    handle.agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text: `帮我查这张图的原始出处。完整任务书在 \`${path.join(dir, '.paste-search', 'task.md')}\`，先读它再动手。\n\n注意：**不要委派**——不要用 subagent / codex / 团队工具，自己在本会话里用 pwsh、web_fetch、read_image 这些工具把活干完。`,
      }],
      source: { kind: 'user' },
    });
  } catch (error) {
    record.error = String(error?.message ?? error).slice(0, 400);
    return { error: fail('session-failed', `起会话失败：${record.error}`) };
  }

  return {
    body: json({
      ok: true,
      search: {
        searchId,
        sessionId,
        dir,
        imagePath,
        notes: record.notes,
        extras: extras.map((entry) => entry.path),
        createdAt: record.createdAt,
      },
    }),
  };
}

function describeSearch(ctx, record) {
  const agent = record.sessionId ? ctx.get('agents')?.get?.(record.sessionId) : undefined;
  return {
    searchId: record.searchId,
    sessionId: record.sessionId,
    dir: record.dir,
    notes: record.notes,
    createdAt: record.createdAt,
    error: record.error,
    status: agent?.status ?? (record.error ? 'failed' : 'unknown'),
    agentPreset: record.agentPreset,
    presetError: record.presetError,
    workspace: record.workspace,
    title: record.title,
    lockedTools: record.lockedTools,
    result: readResultFile(record.dir),
    journal: readJournal(record.dir),
  };
}

const IMAGE_HOST_REFERER = [
  [/^https?:\/\/i\.pximg\.net\//i, 'https://www.pixiv.net/'],
  [/^https?:\/\/[^/]*saucenao\.com\//i, 'https://saucenao.com/'],
  [/^https?:\/\/[^/]*iqdb\.org\//i, 'https://iqdb.org/'],
  [/^https?:\/\/[^/]*ascii2d\.net\//i, 'https://ascii2d.net/'],
  [/^https?:\/\/[^/]*trace\.moe\//i, 'https://trace.moe/'],
  [/^https?:\/\/[^/]*donmai\.us\//i, 'https://danbooru.donmai.us/'],
  [/^https?:\/\/[^/]*yande\.re\//i, 'https://yande.re/'],
];

async function proxyImage(request) {
  const url = new URL(request.url, 'http://localhost');
  const target = url.searchParams.get('u');
  if (!target || !/^https?:\/\//i.test(target)) return new Response('bad target', { status: 400 });
  let referer = url.searchParams.get('r') || undefined;
  if (!referer) referer = IMAGE_HOST_REFERER.find(([pattern]) => pattern.test(target))?.[1];
  try {
    const upstream = await fetch(target, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        ...(referer ? { referer } : {}),
        accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    if (!upstream.ok) return new Response(`upstream ${upstream.status}`, { status: 502 });
    const type = upstream.headers.get('content-type') ?? 'image/jpeg';
    const bytes = await upstream.arrayBuffer();
    return new Response(bytes, {
      headers: { 'content-type': type, 'cache-control': 'public, max-age=3600' },
    });
  } catch (error) {
    return new Response(`proxy failed: ${String(error?.message ?? error).slice(0, 160)}`, { status: 502 });
  }
}

/** 路由表：path 唯一，方法在内部派发（Connection 的 Exact Fetch 按 path 去重）。 */
const ROUTES = [
  {
    path: '/api/dsh-paste-search/search',
    methods: ['POST', 'GET'],
    handler: async (request, ctx) => {
      if (request.method === 'GET') {
        const id = new URL(request.url, 'http://localhost').searchParams.get('id');
        const record = id ? searches.get(id) : undefined;
        if (!record) return fail('not-found', '没有这次搜索');
        return json({ ok: true, search: describeSearch(ctx, record) });
      }
      let payload;
      try {
        payload = await request.json();
      } catch {
        return fail('bad-json', '请求体不是 JSON');
      }
      const outcome = await startSearch(ctx, payload);
      return outcome.error ?? outcome.body;
    },
  },
  {
    path: '/api/dsh-paste-search/recent',
    methods: ['GET'],
    handler: async (request, ctx) => {
      const list = [...searches.values()].slice(-12).reverse().map((record) => describeSearch(ctx, record));
      return json({ ok: true, searches: list });
    },
  },
  {
    path: '/api/dsh-paste-search/note',
    methods: ['POST'],
    handler: async (request, ctx) => {
      let body;
      try {
        body = await request.json();
      } catch {
        return fail('bad-json', '请求体不是 JSON');
      }
      const record = body?.searchId ? searches.get(String(body.searchId)) : undefined;
      if (!record?.sessionId) return fail('not-found', '没有这次搜索');
      const text = String(body?.text ?? '').trim().slice(0, 4000);
      if (!text) return fail('bad-note', '补充说明是空的');
      const agent = record.agent ?? ctx.get('agents')?.get?.(record.sessionId);
      if (!agent) return fail('session-gone', '那个会话已经不在了');
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      });
      record.notes = record.notes ? `${record.notes}\n${text}` : text;
      return json({ ok: true });
    },
  },
  {
    path: '/api/dsh-paste-search/img',
    methods: ['GET'],
    handler: (request) => proxyImage(request),
  },
];

function registerApi(target, ctx) {
  const connection = typeof target?.get === 'function' ? target.get('connection') : undefined;
  if (!connection?.fetch || typeof connection.fetch.register !== 'function') return 0;
  const effect = typeof ctx.effect === 'function' ? ctx.effect : (runner) => {
    const dispose = runner();
    return typeof dispose === 'function' ? dispose : () => {};
  };
  let registered = 0;
  for (const route of ROUTES) {
    effect(
      () => connection.fetch.register({
        path: route.path,
        methods: route.methods,
        requestBody: 'buffered',
        fetch: (request) => route.handler(request, ctx),
      }),
      `dsh-paste-search: ${route.path}`,
    );
    registered += 1;
  }
  return registered;
}

export function apply(ctx) {
  const root = resolveSearchRoot(ctx);
  ctx.logger?.info?.(`dsh-paste-search: 入口就绪，搜索都落在 ${root}`);
  cleanupStaleWorkspaces(ctx, root);

  const direct = registerApi(ctx, ctx);
  if (direct === 0 && typeof ctx.inject === 'function') {
    // connection 由自己的 row 异步提供，晚到时再挂一次。
    ctx.inject(['connection'], (injected) => {
      registerApi(injected, ctx);
    });
  }

  ctx.effect(() => () => {
    // 插件卸载时只松开引用，会话本身是用户的资产，不主动销毁。
    for (const record of searches.values()) record.agent = undefined;
  }, 'dsh-paste-search: lifetime');

  // 会话每结束一轮就看一眼结果文件：有结论了就把那个对话重命名成「搜图 · …」。
  try {
    if (typeof ctx.on === 'function') {
      ctx.effect(() => ctx.on('session/event', (session, event) => {
        if (event?.type !== 'turn/end' || !session) return;
        for (const record of searches.values()) {
          if (record.sessionId === session.id) {
            renameAfterSearch(ctx, session, record);
            return;
          }
        }
      }), 'dsh-paste-search: rename on turn end');
    }
  } catch { /* 事件总线不可用就算了 */ }
}

/**
 * 开发期自测入口：让一个临时 bundle 能直接调用「起一次搜索」这段逻辑，
 * 绕开 Connection 的浏览器鉴权（curl 拿不到 cookie）。产品路径不经过这里。
 */
export const __testing = { startSearch, describeSearch, searches };
