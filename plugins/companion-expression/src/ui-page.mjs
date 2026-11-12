/**
 * The 「工具 → 表情包」 page, as data.
 *
 * Same division of labour as `companion-media/src/ui-page.mjs`: this module contains **no UI
 * framework code** (the companion space's client owns the DOM), it only produces a render-ready
 * descriptor — sections → fields with `path` / `pathParts` / label / input type / **current value**
 * / whether it is writable, the six state words, the endpoint list, per-section state, and the
 * `modules.expression=true` snippet for the disabled case.
 *
 * Two properties are load-bearing and are enforced by `test/expression-page.test.mjs` over in the
 * studio package, and by `test/http-api.test.mjs` here:
 *   1. `capabilities.canTest` is **always** false. Nothing in this module can prove a QQ send works
 *      from a page: the only evidence is a real delivery receipt, so the page must never offer a
 *      "test" button that would imply otherwise.
 *   2. Field values are plain config values. No field here is a secret, and no field here is a
 *      file path the client may post back — `delivery.stageRoot` is rendered read-only on purpose.
 */

import { DEFAULT_CONFIG, UNCERTAIN_MODES, CLOUD_VISION_MODES, ANALYSIS_MODES, PEER_POLICIES } from './config.mjs';

/** The six state words. The UI must copy these verbatim; it may not invent its own. */
export const STATES = Object.freeze([
  { id: 'disabled', label: '功能关闭' },
  { id: 'unconfigured', label: '未配置' },
  { id: 'not-connected', label: '尚未接入' },
  { id: 'saved-untested', label: '已保存、未测试' },
  { id: 'test-ok', label: '测试通过' },
  { id: 'test-failed', label: '测试失败' },
]);

/** The one prefix every route lives under. `studio.mjs` imports it instead of writing it twice. */
export const API_PREFIX = '/api/companion-expression';

/** `modules.expression = true` is the套件级 gate; `delivery.enabled` is the "may it send" gate. */
export const ENABLE_SNIPPET = ['{', '  "modules": {', '    "expression": true', '  }', '}'].join('\n');

const SECTION_ORDER = Object.freeze(['capture', 'analysis', 'retrieval', 'delivery', 'privacy']);

const TYPE_BY_NAME = Object.freeze({
  ownerPrivate: 'boolean',
  groupEnabled: 'boolean',
  enabled: 'boolean',
  crossRoomReuse: 'boolean',
  publicRequiresApproval: 'boolean',
  deleteOnRevocation: 'boolean',
  failClosed: 'boolean',
  fallbackToText: 'boolean',
  maxDownloadBytes: 'number',
  maxPerHour: 'number',
  minConfidence: 'number',
  candidatesToModel: 'number',
  minFitScore: 'number',
  poolLimit: 'number',
  maxPerTurn: 'number',
  dmCooldownSeconds: 'number',
  dmCooldownTurns: 'number',
  groupCooldownSeconds: 'number',
  maxDmPerHour: 'number',
  maxGroupPerHour: 'number',
  repeatWindowDmHours: 'number',
  repeatWindowGroupHours: 'number',
  stageTtlSeconds: 'number',
  stageRoot: 'readonly-path',
  privatePeers: 'select',
  uncertain: 'select',
  cloudVision: 'select',
  mode: 'select',
});

const LIMITS = Object.freeze({
  maxDownloadBytes: { min: 65536, max: 67108864 },
  maxPerHour: { min: 0, max: 600 },
  minConfidence: { min: 0, max: 1, step: 0.01 },
  candidatesToModel: { min: 1, max: 10 },
  minFitScore: { min: 0, max: 1, step: 0.01 },
  poolLimit: { min: 10, max: 200 },
  maxPerTurn: { min: 0, max: 3 },
  dmCooldownSeconds: { min: 0, max: 86400 },
  dmCooldownTurns: { min: 0, max: 100 },
  groupCooldownSeconds: { min: 0, max: 86400 },
  maxDmPerHour: { min: 0, max: 120 },
  maxGroupPerHour: { min: 0, max: 120 },
  repeatWindowDmHours: { min: 0, max: 8760 },
  repeatWindowGroupHours: { min: 0, max: 8760 },
  stageTtlSeconds: { min: 10, max: 3600 },
});

const LABELS = Object.freeze({
  enabled: '表情包模块总开关',
  'capture.ownerPrivate': '主人私聊里的图片可以被动收集',
  'capture.groupEnabled': '群聊收集总开关（逐群仍需单独授权）',
  'capture.privatePeers': '非主人私聊的收集策略',
  'capture.maxDownloadBytes': '单个素材体积上限（字节，65536–67108864）',
  'capture.maxPerHour': '每小时最多收集几个素材',
  'capture.uncertain': '分类不确定时怎么处理',
  'capture.cloudVision': '是否允许调用云端视觉模型',
  'analysis.mode': '分析强度',
  'analysis.minConfidence': '低于这个置信度就按「不确定」处理',
  'retrieval.candidatesToModel': '给模型的候选数量（3–5 最好）',
  'retrieval.minFitScore': '低于这个契合度就只发文字',
  'retrieval.poolLimit': '召回后待排序的候选池上限（10–200；不整库扫描）',
  'delivery.enabled': '允许把图真发出去（总闸）',
  'delivery.maxPerTurn': '每轮最多发几张（0–3）',
  'delivery.dmCooldownSeconds': '私聊冷却（秒）',
  'delivery.dmCooldownTurns': '私聊冷却（轮）',
  'delivery.groupCooldownSeconds': '群聊冷却（秒）',
  'delivery.maxDmPerHour': '私聊每小时上限',
  'delivery.maxGroupPerHour': '群聊每小时上限',
  'delivery.repeatWindowDmHours': '私聊同图抑制窗口（小时）',
  'delivery.repeatWindowGroupHours': '群聊同图抑制窗口（小时）',
  'delivery.stageRoot': '临时发图目录（只读，必须在 home/media 内）',
  'delivery.stageTtlSeconds': '临时文件保留（秒）',
  'delivery.failClosed': '投递失败时退回纯文字（不重试）',
  'delivery.fallbackToText': '没有合适素材时正常说话',
  'privacy.crossRoomReuse': '允许跨房间复用素材',
  'privacy.publicRequiresApproval': '公共精选必须人工批准',
  'privacy.deleteOnRevocation': '撤销授权时删除文件与索引',
});

const OPTION_SETS = Object.freeze({
  'capture.privatePeers': PEER_POLICIES.map(value => ({ value, label: value === 'opt_in' ? '逐个授权（opt_in）' : '一律不收集（off）' })),
  'capture.uncertain': UNCERTAIN_MODES.map(value => ({ value, label: value === 'review' ? '进复核队列（review）' : '直接隔离（quarantine）' })),
  'capture.cloudVision': CLOUD_VISION_MODES.map(value => ({ value, label: value === 'deny' ? '不调用（deny）' : '允许调用（allow，会计费）' })),
  'analysis.mode': ANALYSIS_MODES.map(value => ({
    value,
    label: value === 'off' ? '不分析' : value === 'heuristics' ? '启发式（本地，默认）' : '宿主视觉模型（需允许云端视觉）',
  })),
});

const HINTS = Object.freeze({
  'capture.cloudVision': 'deny 时绝不调用云端视觉模型；allow 时 `analysis.mode=host-vision` 才会真的发图给模型（可能计费）。',
  'delivery.enabled': '这是唯一能让人收到图的开关。关着时决策、检索、模拟、审核全部可用，一张图也不会出门。',
  'delivery.stageRoot': '路径由模块自己校验，必须是 home/media 内的相对路径；页面只读展示，不可编辑。',
  'analysis.mode': 'host-vision 需要 capture.cloudVision=allow，否则按启发式运行并说明原因。',
});

function readPath(config, parts) {
  let node = config;
  for (const part of parts) {
    if (node === null || node === undefined) return undefined;
    node = node[part];
  }
  return node;
}

function field(pathParts, config, { writable = true, group } = {}) {
  const dotted = pathParts.join('.');
  const raw = readPath(config, pathParts);
  const name = pathParts[pathParts.length - 1];
  const type = TYPE_BY_NAME[name] ?? 'text';
  const label = LABELS[dotted] ?? dotted;
  const base = { path: dotted, pathParts: [...pathParts], label, writable, type };
  if (group) base.group = group;
  const value = type === 'boolean' ? raw === true : (raw === undefined ? null : raw);
  if (type === 'select') {
    const options = OPTION_SETS[dotted] ?? [];
    return { ...base, type: options.length ? 'select' : 'text', value, options };
  }
  if (type === 'readonly-path') return { ...base, type: 'text', writable: false, value: String(value ?? ''), displayOnly: true };
  const limits = LIMITS[name];
  return { ...base, value, ...(limits ? { min: limits.min, max: limits.max, step: limits.step ?? (type === 'number' ? 1 : undefined) } : {}), ...(HINTS[dotted] ? { hint: HINTS[dotted] } : {}) };
}

/**
 * Overall state of the expression module, in the six declared words.
 *
 * Deliberately conservative: `test-ok` is reserved for "there is a real delivery receipt", because
 * that is the only thing that proves the whole chain works. A saved config that has never
 * delivered anything is `saved-untested`, never `test-ok`.
 *
 * @param {{
 *   moduleEnabled?: boolean, configEnabled?: boolean, configExists?: boolean,
 *   channelConnected?: boolean, deliveriesConfirmed?: number, deliveriesFailed?: number,
 * }} input
 */
export function overallState({ moduleEnabled, configEnabled, configExists, channelConnected, deliveriesConfirmed, deliveriesFailed } = {}) {
  if (moduleEnabled === false) return 'disabled';
  if (configEnabled === false) return 'disabled';
  if (configExists === false) return 'unconfigured';
  if (channelConnected === false) return 'not-connected';
  const confirmed = Number(deliveriesConfirmed ?? 0);
  const failed = Number(deliveriesFailed ?? 0);
  if (confirmed > 0) return 'test-ok';
  if (failed > 0) return 'test-failed';
  return 'saved-untested';
}

function sectionStates(config, status) {
  const capture = overallState({
    moduleEnabled: status.moduleEnabled,
    configEnabled: config?.enabled,
    configExists: status.configExists,
    channelConnected: status.channelConnected,
  });
  const deliveryOn = config?.delivery?.enabled === true;
  const sent = Number(status.deliveriesConfirmed ?? 0);
  return {
    capture,
    // 收集不需要通道也能看，但「没通道就收不到」必须说出来：这就是 not-connected。
    analysis: status.moduleEnabled === false ? 'disabled' : (config?.analysis?.mode === 'off' ? 'disabled' : 'unconfigured'),
    retrieval: status.moduleEnabled === false ? 'disabled' : 'saved-untested',
    delivery: status.moduleEnabled === false
      ? 'disabled'
      : (!deliveryOn ? 'disabled' : (sent > 0 ? 'test-ok' : 'saved-untested')),
    privacy: status.moduleEnabled === false ? 'disabled' : 'unconfigured',
  };
}

/**
 * Build the descriptor.
 *
 * @param {object} config normalised config (defaults already applied)
 * @param {object} [status] see `overallState`; plus `{ configFile, warnings, http, notes }`
 */
export function pageDescriptor(config, status = {}) {
  const safeConfig = config && typeof config === 'object' ? config : DEFAULT_CONFIG;
  const states = sectionStates(safeConfig, status);
  const confirmed = Number(status.deliveriesConfirmed ?? 0);
  const failed = Number(status.deliveriesFailed ?? 0);

  return {
    id: 'companion-expression',
    title: '表情包',
    group: '工具',
    subtitle: '图库、收集规则、自然度实验室与表达习惯；默认不收集、不发图',
    order: 80,
    states: STATES.map(item => ({ ...item })),
    state: overallState({
      moduleEnabled: status.moduleEnabled,
      configEnabled: safeConfig.enabled,
      configExists: status.configExists,
      channelConnected: status.channelConnected,
      deliveriesConfirmed: confirmed,
      deliveriesFailed: failed,
    }),
    api: {
      page: `GET ${API_PREFIX}/page`,
      config: `GET ${API_PREFIX}/config`,
      save: `POST ${API_PREFIX}/config`,
      assets: `GET ${API_PREFIX}/assets`,
      asset: `GET ${API_PREFIX}/asset`,
      action: `POST ${API_PREFIX}/asset`,
      thumb: `GET ${API_PREFIX}/thumb`,
      sources: `GET ${API_PREFIX}/sources`,
      grants: `POST ${API_PREFIX}/grants`,
      deliveries: `GET ${API_PREFIX}/deliveries`,
      metrics: `GET ${API_PREFIX}/metrics`,
      simulate: `POST ${API_PREFIX}/simulate`,
    },
    // 页面不能提供"测试连接"：这个模块没有轻量探测，唯一的证据是一次真实投递回执。
    capabilities: {
      canTest: false,
      canTestReason: '这个模块没有"轻量探测"：唯一的证据是一次真实投递回执，页面不提供测试按钮。',
      canSimulate: true,
      canSend: safeConfig?.delivery?.enabled === true && status.moduleEnabled !== false,
      canEditStageRoot: false,
      canChangeScope: true,
    },
    sections: SECTION_ORDER.map(id => ({
      id,
      title: { capture: '收集', analysis: '分析', retrieval: '检索', delivery: '投递', privacy: '隐私' }[id],
      state: states[id],
      fields: sectionFields(id, safeConfig),
    })),
    meta: {
      configFile: status.configFile ?? null,
      configExists: status.configExists ?? null,
      warnings: Array.isArray(status.warnings) ? status.warnings.slice(0, 12) : [],
      http: status.http ?? null,
      channel: status.channel ?? null,
      deliveries: { confirmed, failed, pending: Number(status.deliveriesPending ?? 0) },
      enableSnippet: ENABLE_SNIPPET,
      testPolicy: 'explicit-only',
      simulationPolicy: 'read-only·never-sends',
      configPolicy: 'full-object-or-patch',
      assetIdOnly: '客户端只能传 assetId；带 file/path/.. 或反斜杠的入参一律 400。',
      notImplemented: [
        'GIF 关键帧理解',
        'OCR',
        'embedding 向量召回',
        'QQ 内置 face 表情投递',
        '真实平台发送验收（证据只到离线测试）',
      ],
    },
  };
}

function sectionFields(id, config) {
  switch (id) {
    case 'capture':
      return [
        field(['enabled'], config),
        field(['capture', 'ownerPrivate'], config),
        field(['capture', 'groupEnabled'], config),
        field(['capture', 'privatePeers'], config),
        field(['capture', 'maxDownloadBytes'], config),
        field(['capture', 'maxPerHour'], config),
        field(['capture', 'uncertain'], config),
        field(['capture', 'cloudVision'], config),
      ];
    case 'analysis':
      return [field(['analysis', 'mode'], config), field(['analysis', 'minConfidence'], config)];
    case 'retrieval':
      return [
        field(['retrieval', 'candidatesToModel'], config),
        field(['retrieval', 'minFitScore'], config),
        field(['retrieval', 'poolLimit'], config),
      ];
    case 'delivery':
      return [
        field(['delivery', 'enabled'], config),
        field(['delivery', 'maxPerTurn'], config),
        field(['delivery', 'dmCooldownSeconds'], config),
        field(['delivery', 'dmCooldownTurns'], config),
        field(['delivery', 'groupCooldownSeconds'], config),
        field(['delivery', 'maxDmPerHour'], config),
        field(['delivery', 'maxGroupPerHour'], config),
        field(['delivery', 'repeatWindowDmHours'], config),
        field(['delivery', 'repeatWindowGroupHours'], config),
        field(['delivery', 'stageRoot'], config),
        field(['delivery', 'stageTtlSeconds'], config),
        field(['delivery', 'failClosed'], config),
        field(['delivery', 'fallbackToText'], config),
      ];
    case 'privacy':
      return [
        field(['privacy', 'crossRoomReuse'], config),
        field(['privacy', 'publicRequiresApproval'], config),
        field(['privacy', 'deleteOnRevocation'], config),
      ];
    default:
      return [];
  }
}

export const LABEL_BY_PATH = LABELS;

export default { STATES, ENABLE_SNIPPET, overallState, pageDescriptor, LABEL_BY_PATH };
