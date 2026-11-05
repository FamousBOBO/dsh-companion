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
 * 媒体工具（2026-11-02）：识图 / 合成语音 / 生成图片 / 查任务。
 *
 * 这四个工具**只产出本地文件**、不直接往 QQ 发东西，所以群聊放开的只是"看图和准备素材"；
 * 真正的发送仍然只有下面三条固定动作，且目标必须是当前群。
 * 刻意**不**放 `companion_media_warm`：那是拉/卸 GPU 的运维开关，群聊没有理由动它。
 */
export const GROUP_MEDIA_TOOLS = Object.freeze([
  'companion_media_status',
  'companion_media_inspect',
  'companion_media_draw',
  'companion_media_speak',
  'companion_media_job',
]);

/** 群聊允许出现的工具集合：与 `index.mjs` 的 `tools.restrict({ allow })` 共用一份。 */
export const GROUP_ALLOWED_TOOLS = Object.freeze(['qq_message', 'qq_sticker', 'qq_voice', ...GROUP_MEDIA_TOOLS]);

/** 发送类动作的白名单：工具名 → 允许的 action 与允许的参数键。 */
const SEND_RULES = Object.freeze({
  qq_message: { action: 'send', keys: ['action', 'isGroup', 'target', 'text', 'phase'] },
  qq_sticker: { action: 'send', keys: ['action', 'isGroup', 'target', 'file'] },
  qq_voice: { action: 'send_file', keys: ['action', 'isGroup', 'target', 'file'] },
});

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

  const rule = SEND_RULES[name];
  // 默认拒绝包括宿主 shell/文件/网络、委派、私聊记忆、跨群、管理与所有未来工具。
  if (!rule) return '群聊目前只开放：给当前群发文字/图片/语音，以及看图、生成图片和合成语音。';

  const args = parseArgs(exec.arguments);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '群聊工具参数无效。';
  if (args.action !== rule.action || args.isGroup !== true || args.target !== group) return '只能向当前群发送消息，不能跨群、私聊或执行管理动作。';
  if (Object.keys(args).some(key => !rule.keys.includes(key))) return '群聊发送不接受额外参数。';

  if (name === 'qq_message') {
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 4000 || /\[CQ:/i.test(args.text)) return '群聊只接受 1–4000 字的纯文本。';
    if (args.phase !== undefined && args.phase !== 'final') return '群聊目前只发送最终文本，不建立后台任务。';
    return undefined;
  }

  // 图片/语音：只允许发媒体层自己产出的文件（home/media 下面），不把任意磁盘文件当图发出去。
  if (!insideRoot(options.mediaRoot, args.file)) return '群聊只能发送媒体层生成的图片或语音（绝对路径且位于 home/media 下）。';
  return undefined;
}
