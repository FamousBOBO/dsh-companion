/**
 * 四个工具的定义与参数校验（设计文档 §6.2「模型选 ID 或 none」）。
 *
 * 唯一不可谈判的一条：**工具不接受任何路径参数**。模型只能给 `assetId`、动作、目标、模式与
 * 文本；stage、作用域校验、冷却、哈希校验全部在服务端做。所以这里先做白名单校验——未知键
 * 一律拒绝，`file` / `path` / `url` 这类键连「被忽略」的机会都没有。
 *
 * 本模块是纯的：不联网、不读盘、不碰数据库。`createToolHandlers()` 只把参数翻译成对注入
 * service 门面的调用，真正的行为在 retrieval / decision / planner / delivery / feedback 里。
 *
 * service 门面（由 index.mjs 组装，测试里用假实现）：
 *   candidates({isGroup, target, query, limit}) → {ok, candidates[], reasonCode, abstain}
 *   reply({assetId, mode, text, isGroup, target}) → {ok, planId, mode, parts, delivered, reasonCode, message}
 *   feedback({assetId, action, signal, note, isGroup, target}) → {ok, recorded, reasonCode, message}
 *   stats() → {ok, assets, ...}
 */
export const TOOL_NAMES = Object.freeze({
  candidates: 'expression_candidates',
  reply: 'expression_reply',
  feedback: 'expression_feedback',
  stats: 'expression_library_stats',
  stickerNote: 'expression_sticker_note',
});

/** 允许的参数键（白名单，唯一来源）。 */
export const ALLOWED_KEYS = Object.freeze([
  'assetId', 'action', 'isGroup', 'target', 'mode', 'text', 'query', 'limit', 'signal', 'note',
  'stickerKey', 'meaning', 'label', 'animated',
]);
/** 即使出现也直接拒绝的键：它们是「绕过服务端校验」的入口。 */
export const FORBIDDEN_KEYS = Object.freeze(['file', 'path', 'filePath', 'url', 'bytes', 'source', 'staged', 'scope']);

export const REPLY_ACTIONS = Object.freeze(['send']);
export const REPLY_MODES = Object.freeze(['text_only', 'sticker_only', 'text_then_sticker', 'sticker_then_text']);
export const FEEDBACK_ACTIONS = Object.freeze(['praise', 'reject', 'correction']);
/** 表情词典的三个动作：认 / 记 / 列。 */
export const NOTE_ACTIONS = Object.freeze(['lookup', 'record', 'list']);
export const ASSET_ID_PATTERN = /^ast_[0-9a-zA-Z_-]{6,40}$/;
/** 表情指纹形如 `f:0AB4…` / `s:困` / `u:xxx`（见 channel-qq 的 `stickerKeyOf`）。 */
export const STICKER_KEY_PATTERN = /^[fsu]:[\s\S]{1,180}$/;

function text(value, limit) {
  return String(value ?? '').slice(0, limit);
}

/**
 * 校验一组工具参数。
 * @returns {{ok: true, args: object} | {ok: false, reasonCode: string, message: string}}
 */
export function validateArgs(raw = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      return { ok: false, reasonCode: 'path-argument-forbidden', message: `不接受路径类参数（${key}）：素材路径只能由服务端 stage。` };
    }
    if (!ALLOWED_KEYS.includes(key)) {
      return { ok: false, reasonCode: 'argument-not-allowed', message: `不接受参数 ${key}；可用：${ALLOWED_KEYS.join(' / ')}。` };
    }
  }
  const args = {};
  if (input.assetId !== undefined && input.assetId !== null && String(input.assetId).trim() !== '') {
    const assetId = String(input.assetId).trim();
    if (!ASSET_ID_PATTERN.test(assetId)) return { ok: false, reasonCode: 'asset-id-invalid', message: 'assetId 必须是图库给的 id（形如 ast_…），不是路径。' };
    args.assetId = assetId;
  }
  if (input.action !== undefined) args.action = text(input.action, 24);
  if (input.isGroup !== undefined) args.isGroup = input.isGroup === true || input.isGroup === 'true';
  if (input.target !== undefined && input.target !== null) {
    const target = String(input.target).trim();
    if (target && !/^\d{1,12}$/.test(target)) return { ok: false, reasonCode: 'target-invalid', message: 'target 只能是 QQ 号或群号（数字）。' };
    if (target) args.target = target;
  }
  if (input.mode !== undefined) args.mode = text(input.mode, 32);
  if (input.text !== undefined) args.text = text(input.text, 4000);
  if (input.query !== undefined) args.query = text(input.query, 200);
  if (input.limit !== undefined) {
    const limit = Math.trunc(Number(input.limit));
    if (!Number.isFinite(limit) || limit < 1 || limit > 5) return { ok: false, reasonCode: 'limit-invalid', message: 'limit 必须是 1–5 的整数（只给模型 3–5 个候选）。' };
    args.limit = limit;
  }
  if (input.signal !== undefined) args.signal = text(input.signal, 24);
  if (input.note !== undefined) args.note = text(input.note, 240);
  if (input.stickerKey !== undefined) {
    const key = String(input.stickerKey ?? '').trim();
    // 只认指纹（`f:`/`s:`/`u:` 前缀），不认路径也不认 URL —— 与 assetId 同一条纪律。
    if (key !== '' && !STICKER_KEY_PATTERN.test(key)) {
      return { ok: false, reasonCode: 'sticker-key-invalid', message: 'stickerKey 必须是消息行里给出的指纹（形如 f:… / s:… / u:…）。' };
    }
    if (key !== '') args.stickerKey = key.slice(0, 200);
  }
  if (input.meaning !== undefined) args.meaning = text(input.meaning, 200);
  if (input.label !== undefined) args.label = text(input.label, 40);
  if (input.animated !== undefined) args.animated = input.animated === true || input.animated === 'true';
  return { ok: true, args };
}

const NOTHING = '不含路径、不含图片内容、不含别处会话的素材。';

/** 四个工具 spec。`parameters` 是作者侧的属性映射（宿主会用 defineTool 编成 JSON Schema）。 */
export const TOOL_SPECS = Object.freeze([
  {
    name: TOOL_NAMES.candidates,
    kind: 'read',
    description: `给当前会话检索 3–5 个表情包候选（assetId + 摘要 + 用途 + 禁忌）。只读：不发图。${NOTHING}没有合适候选时返回空列表，这是正常结果，不要因此重试。`,
    parameters: {
      query: { type: 'string', description: '想表达的意图或场景，用自然语言写。' },
      limit: { type: 'integer', description: '候选数量，默认 5，可选 1–5。' },
      isGroup: { type: 'boolean', description: '当前会话是否群聊。' },
      target: { type: 'string', description: 'QQ 号或群号（数字）；省略则用当前会话。' },
    },
  },
  {
    name: TOOL_NAMES.reply,
    kind: 'write',
    description: `发一张表情包（可选带一句话）。服务端会依次做作用域、审核态、冷却、配额、重复窗口、哈希校验，任何一步不过就退化成纯文字并在 message 里说明原因。只接受 assetId（来自 ${TOOL_NAMES.candidates}），绝不接受路径。默认整模块关闭时直接拒绝。`,
    parameters: {
      assetId: { type: 'string', required: true, description: '候选里的 assetId（形如 ast_…）。' },
      action: { type: 'string', description: '固定 send。' },
      mode: { type: 'string', description: 'text_then_sticker / sticker_only / sticker_then_text / text_only。' },
      text: { type: 'string', description: '随图一起发的文字（最多 4000 字）。' },
      isGroup: { type: 'boolean', description: '当前会话是否群聊。' },
      target: { type: 'string', description: 'QQ 号或群号（数字）。' },
    },
  },
  {
    name: TOOL_NAMES.feedback,
    kind: 'write',
    description: `显式反馈：praise / reject / correction。reject 会立刻抑制这张图在本会话的重发；沉默不算负反馈，不要用本工具记录「没反应」。群反馈只进表情包图库，不写主人记忆。`,
    parameters: {
      assetId: { type: 'string', description: '被反馈的 assetId。' },
      action: { type: 'string', required: true, description: 'praise / reject / correction。' },
      signal: { type: 'string', description: '可选：更细的信号名（仅记录，不改变语义）。' },
      note: { type: 'string', description: '可选：一句话原因，便于以后复核。' },
      isGroup: { type: 'boolean', description: '当前会话是否群聊。' },
      target: { type: 'string', description: 'QQ 号或群号（数字）。' },
    },
  },
  {
    name: TOOL_NAMES.stats,
    kind: 'read',
    description: `图库与投递统计（只读）。含素材/来源/审核/投递/反馈计数与 abstain 比例。${NOTHING}`,
    parameters: {
      limit: { type: 'integer', description: '最近投递条数，默认 10。' },
    },
  },
  {
    name: TOOL_NAMES.stickerNote,
    kind: 'write',
    description: `表情词典：对方发来的表情是**一句话**，不是一幅画。action=lookup 先问「这张以前记过没有」（认出来就用原来的意思，别描述画面）；action=record 把问清楚的意思记下来（下次同一个表情直接认出，动图一样）；action=list 看记过哪些。不要用它记画面描述。`,
    parameters: {
      action: { type: 'string', required: true, description: 'lookup / record / list。' },
      stickerKey: { type: 'string', description: '消息行里的表情指纹（[表情：困｜key=f:…] 里的 f:…）。' },
      meaning: { type: 'string', description: 'record：这个表情表达什么（抽象意思，不是画面），最多 200 字。' },
      label: { type: 'string', description: 'record：这个表情的字面（如 困 / 开心）。' },
      animated: { type: 'boolean', description: 'record：是不是动图表情。' },
      limit: { type: 'integer', description: 'list：最多几条，默认 20。' },
    },
  },
]);

/** 工具名 → spec，注册与测试都用它，避免两处硬编码。 */
export const TOOL_SPEC_BY_NAME = Object.freeze(Object.fromEntries(TOOL_SPECS.map(spec => [spec.name, spec])));

/** 与宿主 defineTool 相同的属性映射投影（宿主缺失时也能给出合法 JSON Schema）。 */
export function parametersToJsonSchema(spec = {}) {
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(spec)) {
    if (!value || typeof value !== 'object') continue;
    const { required: isRequired, ...rest } = value;
    properties[key] = rest;
    if (isRequired) required.push(key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

function refusal(reasonCode, message) {
  return { ok: false, reasonCode, message, candidates: [], delivered: 0 };
}

/** 参数 + 会话 → 服务端校验过的请求。会话信息只用来填 isGroup/target 的缺省，不覆盖显式值。
 *  作用域不在参数里（`scope` 是禁止键）：它只能由服务端按会话推导。 */
function requestOf({ args, exec }) {
  const session = exec?.agent?.session ?? {};
  const isGroup = args.isGroup === true || (args.isGroup === undefined && session?.kind === 'group');
  const target = args.target ?? (session?.chatId === undefined ? '' : String(session.chatId));
  return { ...args, isGroup, target: String(target || '') };
}

/**
 * 把 service 门面包装成「工具名 → 执行函数」。
 * 每个执行函数**永不抛**：工具报错在 QQ 会话里等于整轮失败，这里统一返回结构化失败。
 */
export function createToolHandlers({ service } = {}) {
  const call = async (method, payload) => {
    if (!service || typeof service?.[method] !== 'function') return refusal('service-unavailable', '表情包服务未挂载：本轮既不发图也不给候选。');
    try {
      const value = await service[method](payload);
      return value && typeof value === 'object' ? value : refusal('service-empty', '表情包服务没有返回结果。');
    } catch (error) {
      return refusal('service-threw', String(error?.message ?? error).slice(0, 200));
    }
  };

  return {
    async [TOOL_NAMES.candidates](rawArgs = {}, exec) {
      const checked = validateArgs(rawArgs);
      if (!checked.ok) return refusal(checked.reasonCode, checked.message);
      const request = requestOf({ args: checked.args, exec });
      return call('candidates', { isGroup: request.isGroup, target: request.target, query: request.query ?? '', limit: request.limit ?? 5 });
    },
    async [TOOL_NAMES.reply](rawArgs = {}, exec) {
      const checked = validateArgs(rawArgs);
      if (!checked.ok) return refusal(checked.reasonCode, checked.message);
      if (!checked.args.assetId) return refusal('asset-id-missing', `发图必须给 assetId（先用 ${TOOL_NAMES.candidates} 拿候选）。`);
      if (checked.args.action !== undefined && checked.args.action !== 'send') {
        return refusal('action-invalid', 'expression_reply 只接受 action=send（发送由服务端决定，不存在强制发送）。');
      }
      if (checked.args.mode !== undefined && !REPLY_MODES.includes(checked.args.mode)) {
        return refusal('mode-invalid', `mode 只能是 ${REPLY_MODES.join(' / ')}。`);
      }
      const request = requestOf({ args: checked.args, exec });
      return call('reply', {
        assetId: checked.args.assetId, mode: checked.args.mode ?? '', text: checked.args.text ?? '',
        isGroup: request.isGroup, target: request.target,
      });
    },
    async [TOOL_NAMES.feedback](rawArgs = {}, exec) {
      const checked = validateArgs(rawArgs);
      if (!checked.ok) return refusal(checked.reasonCode, checked.message);
      if (!checked.args.action) return refusal('action-missing', '反馈必须显式给 action：praise / reject / correction。');
      if (!FEEDBACK_ACTIONS.includes(checked.args.action)) {
        return refusal('action-invalid', `action 只能是 ${FEEDBACK_ACTIONS.join(' / ')}；沉默不是负反馈。`);
      }
      const request = requestOf({ args: checked.args, exec });
      return call('feedback', {
        assetId: checked.args.assetId ?? '', action: checked.args.action,
        signal: checked.args.signal ?? '', note: checked.args.note ?? '',
        isGroup: request.isGroup, target: request.target,
      });
    },
    async [TOOL_NAMES.stats](rawArgs = {}, exec) {
      const checked = validateArgs(rawArgs);
      if (!checked.ok) return refusal(checked.reasonCode, checked.message);
      void exec;
      return call('stats', { limit: checked.args.limit ?? 10 });
    },
    async [TOOL_NAMES.stickerNote](rawArgs = {}, exec) {
      const checked = validateArgs(rawArgs);
      if (!checked.ok) return refusal(checked.reasonCode, checked.message);
      const action = String(checked.args.action ?? '').trim();
      if (!NOTE_ACTIONS.includes(action)) {
        return refusal('action-invalid', `action 只能是 ${NOTE_ACTIONS.join(' / ')}。`);
      }
      // `record` 必须有意思与指纹：没有意思的记录等于没记，而编一个「意思」正是要防的事。
      if (action === 'record' && !checked.args.stickerKey) {
        return refusal('sticker-key-missing', 'record 需要 stickerKey（消息行里 [表情：…｜key=…] 的那个 key）。');
      }
      if (action === 'record' && String(checked.args.meaning ?? '').trim() === '') {
        return refusal('meaning-empty', 'record 需要 meaning：这个表情表达什么。不知道就先问，别猜。');
      }
      if (action === 'lookup' && !checked.args.stickerKey) {
        return refusal('sticker-key-missing', 'lookup 需要 stickerKey。');
      }
      const request = requestOf({ args: checked.args, exec });
      return call('stickerNote', {
        action, stickerKey: checked.args.stickerKey ?? '', meaning: checked.args.meaning ?? '',
        label: checked.args.label ?? '', animated: checked.args.animated === true,
        limit: checked.args.limit ?? 20, isGroup: request.isGroup, target: request.target,
      });
    },
  };
}

export default {
  TOOL_NAMES, ALLOWED_KEYS, FORBIDDEN_KEYS, REPLY_ACTIONS, REPLY_MODES, FEEDBACK_ACTIONS,
  NOTE_ACTIONS, STICKER_KEY_PATTERN,
  TOOL_SPECS, TOOL_SPEC_BY_NAME, validateArgs, createToolHandlers,
};
