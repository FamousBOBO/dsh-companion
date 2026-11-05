// companion-health: 三通道「诚实状态」推导（采集 / 账号授权 / BLE 心率）。
//
// 为什么单独一个文件：这张表要在**任何阶段**都能回答，包括数据库还没建、sidecar 没起来、
// 用户压根没配置过的时候。所以这里不 import 任何 `lib/*`，也不读库、不发请求 —— 只把调用方
// 已经知道的几个事实翻译成「未配置 / 不可用 / 未启用 / 正常」这类人话，外加一句为什么。
//
// 硬规则（和团队公约 §8「不许伪造成功」一致）：
//   1. 没有证据 = 不给「正常」。没连过就是 `unconfigured`，连不上就是 `unavailable`。
//   2. 三个通道各自独立判定：采集关着不代表 BLE 不可用，BLE 没硬件也不代表采集坏了。
//   3. 每个状态都带 `label`（中文短词，UI 直接显示）和 `hint`（一句为什么），
//      上层不需要自己拼文案，也就不会出现「配置已保存」被显示成「连接成功」。

/** 通道状态枚举。`unknown` 只在「有证据但读不懂」时出现，不当作默认值。 */
export const COLLECTION_STATES = Object.freeze([
  'disabled', 'not-initialized', 'unconfigured', 'unavailable', 'unchecked', 'ready', 'unknown',
]);
export const ACCOUNT_STATES = Object.freeze([
  'unconfigured', 'authorized', 'reauthorize', 'unavailable', 'unknown',
]);
export const BLE_STATES = Object.freeze([
  'disabled', 'unavailable', 'no-session', 'ready', 'unknown',
]);

/** 中文短标签：UI 显示的就是这几个词，别处不要再拼一遍。 */
export const LABELS = Object.freeze({
  // 采集
  'collection.disabled': '未启用',
  'collection.not-initialized': '未初始化',
  'collection.unconfigured': '未配置',
  'collection.unavailable': '不可用',
  'collection.unchecked': '未检测',
  'collection.ready': '正常',
  'collection.unknown': '未知',
  // 账号授权
  'account.unconfigured': '未配置',
  'account.authorized': '已授权',
  'account.reauthorize': '需要重新登录',
  'account.unavailable': '不可用',
  'account.unknown': '未知',
  // BLE 心率
  'ble.disabled': '未启用',
  'ble.unavailable': '不可用',
  'ble.no-session': '未连接',
  'ble.ready': '正常',
  'ble.unknown': '未知',
});

/** 传输层错误码：说明「根本没问到」，不能说成鉴权失败，也不能说成成功。 */
const TRANSPORT_CODES = Object.freeze(['unreachable', 'timeout', 'http-error', 'bad-json', 'non-loopback-refused']);
/** 上游明确拒绝凭证的错误码。 */
const AUTH_CODES = Object.freeze([
  '1002', '1004', '1005', '20020001', '20020003', '20010004', 'auth-required', 'unauthorized',
]);
/** BLE sidecar「连不上/没有设备」这类结论（pulse 层自己的 code 表）。 */
const BLE_UNAVAILABLE_CODES = Object.freeze([
  'device-not-found', 'connect-timeout', 'unreachable', 'timeout', 'http-error', 'pulse-unreachable',
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pick(state, channel, hint, extra = {}) {
  return {
    state,
    label: LABELS[`${channel}.${state}`] ?? '未知',
    hint,
    ...extra,
  };
}

/**
 * @param {object} input
 * @param {object} [input.config]          已校验的配置
 * @param {string} [input.phase]           'idle' | 'ready' | 'failed' | 'closed'
 * @param {boolean} [input.readOnly]
 * @param {object|null} [input.auth]       最近一次成功同步记下的鉴权快照（已脱敏）
 * @param {object|null} [input.lastRun]    最近一轮采集 `{status,errorCode}`
 * @param {string|null} [input.lastErrorCode] `health_sources.last_error_code`
 * @param {boolean} [input.hasDatabase]    健康库文件是否存在
 * @param {object|null} [input.pulse]      `{enabled,ready,failure,lastPollCode,sessionActive,bpm}`
 * @returns {{collection:object, account:object, ble:object, summary:string}}
 */
export function buildReadiness(input = {}) {
  const {
    config = null, phase = 'idle', readOnly = false, auth = null, lastRun = null,
    lastErrorCode = null, hasDatabase = false, pulse = null,
  } = input && typeof input === 'object' ? input : {};

  const collectionEnabled = config?.enabled === true;
  const code = text(lastErrorCode) || text(lastRun?.errorCode);
  const runStatus = text(lastRun?.status);
  const succeeded = runStatus === 'ok' || runStatus === 'partial';

  // ── 采集 ────────────────────────────────────────────────────────────────────────────────────
  let collection;
  if (readOnly) {
    collection = pick('unknown', 'collection', '只读实例只报告别人的状态，不判定采集是否在跑。');
  } else if (!collectionEnabled) {
    collection = pick('disabled', 'collection',
      '健康采集默认关闭：config.enabled=false 时不会访问 sidecar、不建库、不轮询。');
  } else if (phase !== 'ready') {
    collection = pick('not-initialized', 'collection',
      hasDatabase
        ? '采集已开启，但健康服务还没初始化完成（看宿主日志里 `[companion-health] not ready` 那一行）。'
        : '采集已开启，但还没有健康数据库：第一轮成功采集之后才会建库。');
  } else if (TRANSPORT_CODES.includes(code)) {
    collection = pick('unavailable', 'collection',
      '采集已开启，但连不上本机健康 sidecar（127.0.0.1:8765）：sidecar 没运行或被别的程序占了端口。');
  } else if (AUTH_CODES.includes(code)) {
    collection = pick('unavailable', 'collection',
      '采集已开启，但华为云拒绝了当前凭证：需要在本机 sidecar 里重新登录一次。');
  } else if (succeeded) {
    collection = pick('ready', 'collection', '采集正常运行。');
  } else if (!auth && !lastRun) {
    collection = pick('unconfigured', 'collection',
      '采集已开启，但一次都没跑过：本机华为健康 sidecar 还没启动或还没登录账号。');
  } else {
    collection = pick('unknown', 'collection', '采集有记录，但最近一轮的结论读不懂；看 faults 里的明细。');
  }

  // ── 账号授权 ────────────────────────────────────────────────────────────────────────────────
  const authStatus = text(auth?.status);
  let account;
  if (AUTH_CODES.includes(code) || authStatus === 'required') {
    account = pick('reauthorize', 'account', '华为云要求重新登录：在本机 sidecar 跑一次登录流程（见 sidecars 的 RUNBOOK）。');
  } else if (authStatus === 'expired') {
    account = pick('reauthorize', 'account', '凭证已过期：在本机 sidecar 重新登录一次。');
  } else if (authStatus === 'valid' || authStatus === 'expiring') {
    account = pick('authorized', 'account',
      authStatus === 'expiring' ? '凭证即将到期，sidecar 会自动轮转；不用手动处理。' : '已登录本机 sidecar，凭证有效。');
  } else if (TRANSPORT_CODES.includes(code)) {
    account = pick('unavailable', 'account',
      '没连上本机 sidecar，因此**不知道**账号是否还有效；这不是「未登录」，等 sidecar 起来再看。');
  } else if (!auth) {
    account = pick('unconfigured', 'account',
      '未配置：还没连接过本机的华为健康 sidecar，也没有账号登录记录。');
  } else {
    account = pick('unknown', 'account', '有账号快照，但状态读不懂；不要当成已授权。');
  }

  // ── BLE 心率 ────────────────────────────────────────────────────────────────────────────────
  const pulseEnabled = config?.pulse?.enabled === true;
  const pulseReady = pulse?.ready === true;
  const pollCode = text(pulse?.lastPollCode);
  let ble;
  if (!pulseEnabled) {
    ble = pick('disabled', 'ble', '实时心率默认关闭：config.pulse.enabled=false 时不扫描、不连 BLE、不轮询。');
  } else if (pulse?.failure || !pulseReady) {
    ble = pick('unavailable', 'ble', '实时心率模块没就绪，读不到任何读数。');
  } else if (BLE_UNAVAILABLE_CODES.includes(pollCode)) {
    ble = pick('unavailable', 'ble',
      '不可用：本机 BLE sidecar（127.0.0.1:8151）没运行，或者没扫描到支持心率广播（0x180D）的设备 —— 手表的「心率广播」可能没开。');
  } else if (pulse?.sessionActive === true) {
    ble = pick('ready', 'ble', '会话进行中，读数是本机 BLE 实时值。');
  } else if (pulse?.bpm != null) {
    ble = pick('no-session', 'ble', '设备连着，但没有开启会话；不开会话就不会有任何读数进提示词。');
  } else {
    ble = pick('unknown', 'ble', '功能已开启，但还没有任何一次成功读数：不做任何「可用」的推断。');
  }

  const summary = `采集：${collection.label} · 账号：${account.label} · 心率：${ble.label}`;
  return { collection, account, ble, summary };
}
