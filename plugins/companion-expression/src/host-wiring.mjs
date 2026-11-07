/**
 * 宿主接线：把 `companion-expression` 需要、但补丁配置给不了的四样东西接到真实宿主上。
 *
 * 为什么单独一个文件：`apply(ctx, options)` 的第二个参数**只能**来自补丁行的 `config:` 块
 * （cordis 调 `runtime.callback(this.ctx, this.config)`），而补丁是 `JSON_SCHEMA` 解析的，
 * 唯一能带代码的节点是 `!!js` —— 本仓库不用那个东西。所以函数型依赖必须在 `apply` 里
 * 从 `ctx` 现取。把这一步集中在这里，`src/index.mjs` 只负责「有就用、没有就说清」。
 *
 * 这里接的四条线（每条都**只接已存在的能力**，不新增外发路径）：
 *   1. `qqSender`   —— 从 `ctx.tools` 取 `qq_message` / `qq_sticker` 的执行器，按投递层要的窄接口包一层。
 *                      调用**走工具运行时**（`tools.execute`），因此预执行策略、群边界守卫、
 *                      出站边界都照常生效——不绕过任何人。
 *   2. `http`       —— `security.createGuardedHttp({fetchImpl: fetch})`，采集只走它（SSRF 闸门全在里面）。
 *   3. `ingest`      —— `ingest.createIngest(...)` + 入站元数据到 `ingestOne()` 的适配。
 *   4. `isOwner`    —— 读 `home/companion/identity.json` 的 `owner.id`（与 foundation 同一份事实）。
 *
 * 全部失败都降级为「这一路没有」，**不抛**：表情包模块挂不上不该拖垮宿主。
 */
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

import { createIngest } from './ingest.mjs';
import { createGuardedHttp } from './security.mjs';
import { scopesFor } from './scopes.mjs';

/** 工具执行时的 agent，供发送器换算「这次投递算谁的回合」。AsyncLocalStorage：不跨调用串味。 */
export const TOOL_AGENT = new AsyncLocalStorage();

/** 在工具执行期间带上 agent；`registerTools` 每次调用都包一层。 */
export function withToolAgent(agent, fn) {
  if (agent === undefined || agent === null) return fn();
  return TOOL_AGENT.run(agent, fn);
}

/** 当前工具执行所属的 agent（没有就是 undefined）。 */
export function currentToolAgent() {
  return TOOL_AGENT.getStore();
}

/**
 * 读主人身份。与 `companion-foundation/identity.mjs` 读的是同一个文件，这里只读不改：
 * 表情模块没有身份写入权（那是 foundation 的事）。文件不在或坏掉 ⇒ `null`。
 * @param {{dataRoot: string, env?: object}} options
 */
export function readOwner({ dataRoot, env = process.env } = {}) {
  const override = String(env?.DSH_COMPANION_OWNER_ID ?? '').trim();
  if (override) return { id: override, platform: String(env?.DSH_COMPANION_OWNER_PLATFORM ?? '').trim() || 'local' };
  try {
    const text = fs.readFileSync(path.join(dataRoot, 'home', 'companion', 'identity.json'), 'utf8').replace(/^\uFEFF/, '');
    const value = JSON.parse(text);
    const id = String(value?.owner?.id ?? '').trim();
    if (!id) return null;
    return { id, platform: String(value?.owner?.platform ?? '').trim() };
  } catch {
    return null;
  }
}

/**
 * `isOwner({chatId, isGroup})`：只认主人自己的私聊号；群聊一律不是主人（群里任何人发言都不是主人，
 * 与 `companion-group` 的人格约定一致）。
 *
 * 每次现读一次文件（identity.json 只有几百字节、且可能刚被运维改过）；读不到就是 `false`
 * ——「宁可不认主人，也不要把陌生人算成主人」。
 */
export function createOwnerCheck({ dataRoot, env = process.env } = {}) {
  return ({ chatId = 0, isGroup = false } = {}) => {
    if (isGroup === true) return false;
    const owner = readOwner({ dataRoot, env });
    if (!owner || !owner.id) return false;
    return String(Number(chatId) || '') === owner.id;
  };
}

/** 从工具返回里挖出 OneBot 的 `message_id`（形状随工具而异，有就取，没有就 null）。 */
function messageIdOf(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  const direct = value.message_id;
  if (typeof direct === 'number') return direct;
  for (const key of ['result', 'data', 'value']) {
    const nested = messageIdOf(value[key], depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * 投递层传给 `qqSender` 的 `target` 有两种形态：投递层内部用 `{kind, id}`，
 * 而工具要的是**一个 QQ 号**。两种都认，认不出就是 `null`（宁可不发，也不发错群）。
 */
function targetIdOf(target) {
  if (target && typeof target === 'object') {
    const id = Number(target.id ?? target.chatId);
    return Number.isFinite(id) && id > 0 ? id : null;
  }
  const id = Number(target);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** 一次工具调用的结果 → 投递层要的三态（`unknown` 单独成态：它决定「不许重试」）。 */
function outcomeOf(result) {
  if (!result || result.isError === true) {
    const message = String(result?.error?.message ?? 'QQ 工具执行失败。').slice(0, 200);
    return { ok: false, code: 'tool-error', message };
  }
  const value = result.value;
  const messageId = messageIdOf(value);
  if (messageId !== null) return { ok: true, messageId };
  if (value && typeof value === 'object' && value.ok === false) {
    return { ok: false, code: String(value.code ?? 'send-failed'), message: String(value.message ?? '').slice(0, 200) };
  }
  return { ok: true, status: 'sent' };
}

/** 一层原子计数，只为诊断写进事件日志时能看出「发送器被调了几次」。 */
function createCounter() {
  return { calls: 0, failures: 0, lastError: null };
}

/**
 * 把宿主工具表包成投递层的 `qqSender`。
 *
 * 关键约束：**绝不自己发请求**。每一次发送都是一次真实的工具调用，因此通道的群边界、
 * 出站边界、策略闸门全都照常跑一遍；这里只做参数搬运与结果解读。
 *
 * @param {{
 *   tools: {get: Function, execute: Function} | null,
 *   signal?: () => AbortSignal | undefined,
 *   log?: (text: string) => void,
 * }} options
 * @returns {{sendText: Function, sendSticker: Function, counters: object} | null}
 */
export function createQqSender({ tools, signal, log = () => {} } = {}) {
  if (!tools || typeof tools.get !== 'function' || typeof tools.execute !== 'function') return null;
  const counters = createCounter();
  /** 两次异步调用要有不同的 callId，否则运行时把它们当成同一次调度。 */
  let seq = 0;

  /**
   * 工具运行时**必须**收到一个 `AbortSignal`（`dsh-tools` 在 `createExecution` 里直接读
   * `exec.signal.aborted`）；不给就是一次 TypeError。这里每次发送给一个自己从不取消的
   * 控制器：取消权在线程/回合那边，投递层只负责「这会儿还该不该发」。
   */
  const signalFor = () => {
    if (typeof signal === 'function') {
      const given = signal();
      if (given && typeof given.aborted === 'boolean') return given;
    }
    return new AbortController().signal;
  };

  /** 工具在不在册。`tools.get(name)` 返回的是定义对象（不在册时是 `undefined`）。 */
  const hasTool = name => {
    try { return tools.get(name) !== undefined; } catch { return false; }
  };

  /** 同一个动作可能对应合并面或旧工具名；按存在性挑一个。 */
  function pickText() {
    if (hasTool('qq_message')) return { name: 'qq_message', args: (a) => ({ action: 'send', ...a }) };
    if (hasTool('qq_send_text')) return { name: 'qq_send_text', args: (a) => ({ ...a }) };
    return null;
  }
  function pickSticker() {
    if (hasTool('qq_sticker')) return { name: 'qq_sticker', args: (a) => ({ action: 'send', ...a }) };
    if (hasTool('qq_send_emoji')) return { name: 'qq_send_emoji', args: (a) => ({ ...a }) };
    return null;
  }

  const textTool = pickText();
  const stickerTool = pickSticker();
  if (!textTool && !stickerTool) return null;
  // 文本能力缺失时不要假装有：投递层会按 `sendText` 是否函数来判「sender-unavailable」。
  if (!textTool || !stickerTool) log(`QQ 发送器只接上一半（文本=${textTool ? '有' : '无'}，图片=${stickerTool ? '有' : '无'}）。`);

  async function invoke(entry, args) {
    const agent = TOOL_AGENT.getStore();
    seq += 1;
    counters.calls += 1;
    try {
      const result = await tools.execute({
        callId: `expression-delivery:${seq}`,
        rootCallId: `expression-delivery:${seq}`,
        name: entry.name,
        arguments: entry.args(args),
        ...(agent === undefined ? {} : { agent }),
        // 标记为「嵌套派发」：`ptc` 模式下模型直呼会被折叠成 run_code，工具内部再派发不受影响。
        parent: Symbol('companion-expression:delivery'),
        signal: signalFor(),
      });
      const outcome = outcomeOf(result);
      if (outcome.ok !== true) {
        counters.failures += 1;
        counters.lastError = String(outcome.message ?? outcome.code ?? '').slice(0, 240);
      }
      return outcome;
    } catch (error) {
      counters.failures += 1;
      counters.lastError = String(error?.message ?? error).slice(0, 240);
      return { ok: false, code: 'sender-threw', message: counters.lastError };
    }
  }

  /** 地址不合法就直接失败：宁可这一条不发，也不能因为 `NaN` 发进别的会话。 */
  const refuseTarget = (kind, target) => {
    const id = targetIdOf(target);
    counters.calls += 1;
    counters.failures += 1;
    counters.lastError = `target-invalid: ${String(kind)} ${JSON.stringify(target)}`.slice(0, 240);
    return { ok: false, code: 'target-invalid', message: '投递地址不是有效的 QQ 号：本轮不发。' };
  };

  const sender = { counters };
  if (textTool) {
    sender.sendText = ({ kind, target, text }) => {
      const id = targetIdOf(target);
      if (id === null) return refuseTarget(kind, target);
      return invoke(textTool, { isGroup: kind === 'group', target: id, text: String(text ?? '') });
    };
  }
  if (stickerTool) {
    sender.sendSticker = ({ kind, target, file }) => {
      const id = targetIdOf(target);
      if (id === null) return refuseTarget(kind, target);
      return invoke(stickerTool, { isGroup: kind === 'group', target: id, file: String(file ?? '') });
    };
  }
  return sender;
}

/**
 * 采集侧的 `http`：只做一件事——把全局 `fetch` 包进 `createGuardedHttp`。
 * SSRF 白名单、字节上限、每跳重判、超时都在 security.mjs 里，这里不重复实现。
 */
export function createIngestHttp({ fetchImpl = globalThis.fetch, now } = {}) {
  if (typeof fetchImpl !== 'function') return null;
  try {
    return createGuardedHttp({ fetchImpl, ...(typeof now === 'function' ? { now } : {}) });
  } catch {
    return null;
  }
}

/** 入站元数据（`channel-qq` 的 `ExpressionInbound`）→ `ingestOne()` 的入参。 */
function ingestInputOf(event, { salt, isOwnerFor }) {
  const images = Array.isArray(event?.images) ? event.images : [];
  const url = String(images[0]?.url ?? '').trim();
  if (url === '') return null;
  const kind = event?.kind === 'group' ? 'group' : 'dm';
  const chatId = Number(event?.chatId) || 0;
  if (chatId <= 0) return null;
  return {
    kind, chatId, salt,
    isOwner: isOwnerFor({ chatId, isGroup: kind === 'group' }) === true,
    url,
    messageHash: event?.messageId ? String(event.messageId) : '',
    summaryHint: String(images[0]?.summary ?? ''),
    subType: images[0]?.subType === undefined ? '' : String(images[0].subType),
    // 一条消息里的第二张图起：仍然按 URL 去重入队，不丢弃（sourceKey 内含 url）。
    extraUrls: images.slice(1).map(image => String(image?.url ?? '').trim()).filter(Boolean),
  };
}

/**
 * 建采集适配器：`observe(inbound)` → 对消息里每张图各跑一次 `ingestOne()`。
 *
 * 同步返回、绝不 await（投递/入站路径不能被下载拖慢）；失败只计数，不外抛。
 * @returns {{observe: Function, counters: object} | null}
 */
export function createIngestBridge({ db, library, config, http, salt, isOwnerFor, now, log = () => {} } = {}) {
  if (!db || !library || typeof http?.get !== 'function' || typeof salt !== 'string' || salt === '') return null;
  let ingest;
  try {
    ingest = createIngest({ db, library, config, http, now });
  } catch (error) {
    log(`采集管道没建起来：${String(error?.message ?? error).slice(0, 160)}`);
    return null;
  }
  const counters = { observed: 0, queued: 0, dropped: 0, lastError: null };

  function observe(event = {}) {
    counters.observed += 1;
    const base = ingestInputOf(event, { salt, isOwnerFor });
    if (!base) {
      counters.dropped += 1;
      return { ok: false, queued: 0, reasonCode: 'no-image-url' };
    }
    const urls = [base.url, ...base.extraUrls];
    for (const url of urls) {
      counters.queued += 1;
      // 每张图独立一条；一条失败不影响其余（`ingestOne` 自己就永不抛，这里再兜一层）。
      Promise.resolve(ingest.ingestOne({ ...base, url })).catch((error) => {
        counters.dropped += 1;
        counters.lastError = String(error?.message ?? error).slice(0, 200);
      });
    }
    return { ok: true, queued: urls.length };
  }

  return { observe, counters, ingest };
}

/**
 * 「这条消息要不要」：`channel-qq` 先问 `offers()`，回来不是 `true` 就整段跳过。
 * 这里直接复用 `scopesFor().capture`，与真正入库用的是**同一个判定**，不会出现
 * 「接口说收、入库说没授权」的两套口径。
 */
export function createOffers({ config, salt, isOwnerFor }) {
  return ({ kind = 'dm', chatId = 0 } = {}) => {
    const chat = Number(chatId) || 0;
    if (chat <= 0) return false;
    const isGroup = kind === 'group';
    const { capture } = scopesFor({
      kind: isGroup ? 'group' : 'dm', chatId: chat,
      isOwner: isOwnerFor({ chatId: chat, isGroup }) === true,
      salt, config,
    });
    return capture === true;
  };
}

/**
 * 装配全部四条线。任何一条没接上都只是「少一样能力」，返回值里说清哪一条缺。
 *
 * @param {{
 *   ctx: object, dataRoot: string, db: object, library: object, config: object,
 *   salt: string, env?: object, now?: Function, log?: Function,
 * }} input
 */
export function createHostWiring({
  ctx, dataRoot, db, library, config, salt, env = process.env, now, fetchImpl, log = () => {},
} = {}) {
  const notes = [];
  let tools = null;
  try {
    const toolsService = typeof ctx?.get === 'function' ? ctx.get('tools') : ctx?.tools;
    if (toolsService && typeof toolsService.get === 'function' && typeof toolsService.execute === 'function') tools = toolsService;
  } catch (error) {
    notes.push(`读 ctx.tools 失败：${String(error?.message ?? error).slice(0, 120)}`);
  }

  const owner = readOwner({ dataRoot, env });
  const isOwner = createOwnerCheck({ dataRoot, env });
  if (!owner) notes.push('identity.json 里没有可用的 owner.id：主人私聊按 peer 处理（宁可不认）。');

  const qqSender = tools ? createQqSender({ tools, log }) : null;
  if (!qqSender) notes.push('没有可用的 QQ 发送器（ctx.tools 或 qq_message/qq_sticker 缺失）：本轮不会真发图。');

  const http = createIngestHttp({ now, ...(typeof fetchImpl === 'function' ? { fetchImpl } : {}) });
  if (!http) notes.push('没有可用的 HTTP 采集实现（全局 fetch 缺失）：入站图片不会下载。');

  const ingestBridge = http
    ? createIngestBridge({ db, library, config, http, salt, isOwnerFor: isOwner, now, log })
    : null;
  if (http && !ingestBridge) notes.push('采集管道没建起来：入站图片不会入库。');

  const offers = createOffers({ config, salt, isOwnerFor: isOwner });

  return {
    ...(qqSender ? { qqSender } : {}),
    ...(http ? { http } : {}),
    ...(ingestBridge ? { ingest: ingestBridge.observe } : {}),
    isOwner,
    offers,
    counters: ingestBridge?.counters ?? null,
    senderCounters: qqSender?.counters ?? null,
    notes,
    wired: Object.freeze({
      sender: qqSender !== null,
      http: http !== null,
      ingest: ingestBridge !== null,
      owner: owner !== null,
    }),
  };
}

export default {
  TOOL_AGENT, withToolAgent, currentToolAgent, readOwner, createOwnerCheck,
  createQqSender, createIngestHttp, createIngestBridge, createOffers, createHostWiring,
};
