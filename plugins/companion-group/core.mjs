// This module contains no IO, owner identity, private persona or memory access.
import path from 'node:path';

const ready = new WeakSet();

export function groupIdOf(agent) {
  const sessionId = agent?.session?.id;
  const agentId = agent?.id;
  const id = sessionId ?? agentId;
  if (!String(id ?? '').startsWith('qq-group-') && !String(agentId ?? '').startsWith('qq-group-')) return null;
  if (sessionId && agentId && sessionId !== agentId) return false;
  const match = /^qq-group-([1-9]\d*)$/.exec(String(id));
  if (!match || !Number.isSafeInteger(Number(match[1]))) return false;
  return Number(match[1]);
}

export function markGroupReady(agent) {
  if (groupIdOf(agent)) ready.add(agent);
}

export function groupIsReady(agent) { return ready.has(agent); }

/**
 * 媒体工具：状态 / 合成语音 / 生成图片 / 查任务。
 *
 * 这些工具不直接往 QQ 发东西，群聊只开放查询与准备素材；
 * 真正的发送仍然只有下面三条固定动作，且目标必须是当前群。
 * 刻意**不**放 `companion_media_warm`：那是拉/卸 GPU 的运维开关，群聊没有理由动它。
 */
export const GROUP_MEDIA_TOOLS = Object.freeze([
  'companion_media_status',
  'companion_media_draw',
  'companion_media_speak',
  'companion_media_job',
]);

/**
 * 表情包工具：两个**只读**查询 / 反馈旁路 + 一个发送动作。
 *
 * `expression_candidates` / `expression_feedback` 只在群里读候选、写反馈，不往 QQ 发东西；
 * `expression_reply` 才是一条真正的发送动作，所以走下面的 `SEND_RULES`。
 * 三者都**只认 assetId**：不接受 file/path 键，群友也拿不到库里的路径（见 `groupToolDenial`）。
 */
export const GROUP_EXPRESSION_TOOLS = Object.freeze([
  'expression_candidates',
  'expression_reply',
  'expression_feedback',
  // 表情词典：群里也要能认、能记（认错了会一直错，能改比不给改强）。它不发消息。
  'expression_sticker_note',
]);

/** 群聊允许出现的工具集合：与 `index.mjs` 的 `tools.restrict({ allow })` 共用一份。 */
export const GROUP_ALLOWED_TOOLS = Object.freeze(['qq_message', 'qq_sticker', 'qq_voice', ...GROUP_MEDIA_TOOLS, ...GROUP_EXPRESSION_TOOLS]);

/**
 * 表情包的只读旁路：不参与 isGroup/target 校验（它们不发消息、没有目标群），
 * 但同样要按**键白名单**判——多一个键就拒绝，`file`/`path` 因此进不来。
 *
 * 为什么单列而不是靠 `READ_PREFIXES`：那个前缀表在 `dsh-channel-qq` 的出站边界里，
 * 管的是"这条调用算不算只读"；群聊这一层的默认是**拒绝未知工具**，所以必须在这里
 * 逐个点名字。分两张表（只读 / 发送）是为了不把"只读"混进 `SEND_RULES` 的
 * `action/isGroup/target` 三元组里——那三条对只读工具没有意义。
 */
const READ_KEYS = Object.freeze({
  expression_candidates: ['isGroup', 'target', 'query', 'limit'],
  expression_feedback: ['isGroup', 'target', 'assetId', 'action', 'signal', 'note'],
  // 表情词典：只认消息行里给出的指纹与「意思」文本，路径类键进不来（FORBIDDEN_KEYS 兜底）。
  expression_sticker_note: ['isGroup', 'target', 'action', 'stickerKey', 'meaning', 'label', 'animated', 'limit'],
});

/** 发送类动作的白名单：工具名 → 允许的 action 与允许的参数键。 */
const SEND_RULES = Object.freeze({
  qq_message: { action: 'send', keys: ['action', 'isGroup', 'target', 'text', 'phase'] },
  qq_sticker: { action: 'send_image', keys: ['action', 'isGroup', 'target', 'file'] },
  qq_voice: { action: 'send_file', keys: ['action', 'isGroup', 'target', 'file'] },
  // 表情包投递：目标必须是当前群，素材只由 assetId 指名（库里的文件路径群聊拿不到）。
  expression_reply: { action: 'send', keys: ['action', 'isGroup', 'target', 'assetId', 'mode', 'text'] },
});

/** 任何工具都**绝不接受**的参数键：路径只能由媒体层自己挑，群聊给不出。 */
const FORBIDDEN_KEYS = Object.freeze(['file', 'path', 'filePath', 'file_path', 'url', 'dir', 'root']);

/** `child` 必须落在 `root` 里面（绝对路径、解析 `..` 之后仍然在内）。 */
function insideRoot(root, child) {
  if (typeof root !== 'string' || !root.trim()) return false;
  if (typeof child !== 'string' || !child.trim()) return false;
  if (/\[CQ:/i.test(child)) return false;
  if (!path.isAbsolute(child)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function parseArgs(raw) {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

/** 表情包反馈只接受这三种显式动作（沉默不算反馈）。 */
const FEEDBACK_ACTIONS = Object.freeze(['praise', 'reject', 'correction']);

/** 路径类参数：表情包工具没有任何理由传它们，出现即拒绝（qq_sticker/qq_voice 的 `file` 不在此列）。 */
function hasPathKey(args) {
  return Object.keys(args).some(key => FORBIDDEN_KEYS.includes(key));
}

/** 参数对象：字符串先试 JSON；没有参数（`undefined`/`null`）不算错。 */
function argsOf(exec) {
  const raw = exec?.arguments;
  if (raw === undefined || raw === null) return {};
  const args = parseArgs(raw);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return args;
}

/**
 * 只读旁路的判定：不吃 `action/isGroup/target` 三元组（它们不发消息、没有目标群），
 * 但**键白名单**照旧——多一个键、或者带任何路径类键，一律拒绝。
 * 真给了 `isGroup`/`target` 也只接受"当前群"：只读不等于可以借它看别的群。
 */
function readOnlyDenial(exec, name, group) {
  const keys = READ_KEYS[name];
  const args = argsOf(exec);
  if (args === null) return '群聊工具参数无效。';
  if (hasPathKey(args)) return '群聊不接受文件或路径参数：表情包只能按 assetId 使用。';
  if (Object.keys(args).some(key => !keys.includes(key))) return '群聊不接受额外参数。';
  if (args.isGroup !== undefined && args.isGroup !== true) return '只能向当前群发送消息，不能跨群、私聊或执行管理动作。';
  if (args.target !== undefined && !isThisGroup(args.target, group)) return '只能向当前群发送消息，不能跨群、私聊或执行管理动作。';
  if (name === 'expression_feedback' && args.action !== undefined && !FEEDBACK_ACTIONS.includes(args.action)) {
    return '群聊里的表情包反馈只接受 praise / reject / correction。';
  }
  return undefined;
}

/** `expression_reply` 的投递模式：与 `companion-expression/src/tools.mjs` 的 `REPLY_MODES` 一致。 */
const REPLY_MODES = Object.freeze(['text_only', 'sticker_only', 'text_then_sticker', 'sticker_then_text']);

/** `target` 是不是这个群：数字严格相等；字符串形态（工具 schema 里 target 是字符串）只认群里那个号。 */
function isThisGroup(target, group) {
  if (typeof target === 'number') return target === group;
  if (typeof target !== 'string' || !/^\d{1,12}$/.test(target)) return false;
  return Number(target) === group;
}

/** `expression_reply` 的完整判定：只发当前群、只认 assetId，绝不认路径。 */
function expressionReplyDenial(args, group) {
  if (args.action !== 'send' || args.isGroup !== true || !isThisGroup(args.target, group)) {
    return '只能向当前群发送消息，不能跨群、私聊或执行管理动作。';
  }
  if (Object.keys(args).some(key => !SEND_RULES.expression_reply.keys.includes(key))) return '群聊发送不接受额外参数。';
  const assetId = args.assetId;
  if (typeof assetId !== 'string' || assetId.trim() === '' || assetId.length > 120) {
    return '群聊只能用 assetId 指名表情包素材。';
  }
  if (/\s|[\\/]|\[CQ:/i.test(assetId)) return '群聊只能用 assetId 指名表情包素材，不能给路径、CQ 码或空白。';
  if (args.mode !== undefined && !REPLY_MODES.includes(args.mode)) {
    return '群聊里的表情包投递只接受 text_only / sticker_only / text_then_sticker / sticker_then_text。';
  }
  if (args.text !== undefined && (typeof args.text !== 'string' || args.text.length > 4000 || /\[CQ:/i.test(args.text))) {
    return '群聊只接受 1–4000 字的纯文本。';
  }
  return undefined;
}

/**
 * 群聊工具闸门（单调：只能拒绝，不能被后续插件放宽）。
 *
 * @param {{agent?: unknown, name?: string, arguments?: unknown}} exec 工具调用
 * @param {{mediaRoot?: string}} [options] `mediaRoot` = `home/media` 的绝对路径；
 *        缺省时**拒绝**发图/发语音（fail closed），其余规则不变。
 * @returns {string|undefined} 拒绝原因；`undefined` 表示放行。
 */
export function groupToolDenial(exec, options = {}) {
  const group = groupIdOf(exec?.agent);
  if (group === null) return undefined;
  if (!group || !groupIsReady(exec.agent)) return '群聊安全预设未就绪，工具调用已拒绝。';

  const name = exec?.name;
  // 媒体工具只写本地文件、不发消息；参数由工具自己限制（inbox 目录 / 提示词）。
  if (GROUP_MEDIA_TOOLS.includes(name)) return undefined;
  // 表情包的只读旁路（候选 / 反馈）：不发消息，但键白名单与路径禁令照旧。
  if (READ_KEYS[name] !== undefined) return readOnlyDenial(exec, name, group);

  const rule = SEND_RULES[name];
  // 默认拒绝包括宿主 shell/文件/网络、委派、私聊记忆、跨群、管理与所有未来工具。
  if (!rule) return '群聊目前只开放：给当前群发文字/图片/语音、挑一张表情包，以及看图、生成图片和合成语音。';

  const args = argsOf(exec);
  if (args === null) return '群聊工具参数无效。';
  // 表情包投递：素材只由 assetId 指名，路径由表情包模块自己 stage 到 home/media。
  // 它的 `target` 在工具 schema 里是字符串，所以三元组与路径禁令都自己判。
  if (name === 'expression_reply') return expressionReplyDenial(args, group);
  if (args.action !== rule.action || args.isGroup !== true || args.target !== group) return '只能向当前群发送消息，不能跨群、私聊或执行管理动作。';
  if (Object.keys(args).some(key => !rule.keys.includes(key))) return '群聊发送不接受额外参数。';

  if (name === 'qq_message') {
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 4000 || /\[CQ:/i.test(args.text)) return '群聊只接受 1–4000 字的纯文本。';
    if (args.phase !== undefined && args.phase !== 'final') return '群聊目前只发送最终文本，不建立后台任务。';
    return undefined;
  }

  // 图片/语音：只允许发媒体层自己产出的文件（home/media 下面），不把任意磁盘文件当图发出去。
  const roots = [options.mediaRoot, ...(options.mediaRoots ?? [])];
  if (!roots.some(root => insideRoot(root, args.file))) return '群聊只能发送媒体层生成的图片或语音（绝对路径且位于已授权媒体产物目录下）。';
  return undefined;
}
