#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// companion-health acceptance entry (`node plugins/companion-health/scripts/check-health.mjs`).
//
// It builds a **read-only** service instance: no polling loop, no sync, no database creation, no
// config creation — the only network call is the explicit `--probe`. That is what makes it safe to
// run against the real `home/` while the host is running.
//
// Exit codes: 0 = healthy, 1 = not healthy (fault present, database not ok, or not initialised).
// `--exit-zero` forces 0 (for wrappers that only want the report). `--json` prints one line.
//
// Nothing here may print a token, a plain uid, or a device identifier; the only permitted form of an
// account id is 4 characters + ellipsis.

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '..');
const WORKSPACE_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
const SERVICE_FILE = path.join(PLUGIN_ROOT, 'lib', 'service.mjs');
const TZ = 'Asia/Shanghai';

/**
 * companion home，和 `lib/service.mjs` 的 `resolveHome()` 同一套顺序（这里也要算 dbPath，
 * 所以不能只把 null 丢给服务）：
 *   显式 `--home` → `$DSH_COMPANION_HEALTH_HOME` → `$DSH_COMPANION_DATA_DIR/home` → `<套件根>/data/home`
 */
function resolveHome(explicit) {
  if (explicit) return path.resolve(String(explicit));
  const envHome = process.env.DSH_COMPANION_HEALTH_HOME;
  if (envHome && envHome.trim()) return path.resolve(envHome.trim());
  const envData = process.env.DSH_COMPANION_DATA_DIR;
  if (envData && envData.trim()) return path.join(path.resolve(envData.trim()), 'home');
  return path.join(WORKSPACE_ROOT, 'data', 'home');
}

const USAGE = `用法: node plugins/companion-health/scripts/check-health.mjs [选项]

  --json            输出单行 JSON（机器消费）
  --probe           额外做一次低频只读 sidecar 探测（GET /api/data?days=7）
  --days <n>        搭配 --probe，窗口 1..30，默认 7
  --home <dir>      指定 companion home（默认 $DSH_COMPANION_HEALTH_HOME → $DSH_COMPANION_DATA_DIR/home → <套件根>/data/home）
  --exit-zero       无论结果如何都以 0 退出
  -h, --help        显示本帮助

只读：不启动轮询、不 sync、不创建数据库/配置、默认不联网。`;

function parseArgs(argv) {
  const options = {
    json: false, probe: false, exitZero: false, home: null, days: 7, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === '--json') options.json = true;
    else if (arg === '--probe') options.probe = true;
    else if (arg === '--exit-zero') options.exitZero = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--home') { options.home = argv[++i] ?? null; }
    else if (arg.startsWith('--home=')) options.home = arg.slice('--home='.length);
    else if (arg === '--days') { options.days = Number(argv[++i]); }
    else if (arg.startsWith('--days=')) options.days = Number(arg.slice('--days='.length));
    else {
      return { error: `未知参数: ${arg}` };
    }
  }
  return options;
}

/** Local wall clock in Asia/Shanghai, independent of the host TZ. */
function localText(isoText) {
  if (!isoText) return '—';
  const ms = Date.parse(String(isoText));
  if (!Number.isFinite(ms)) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ms)).replace(/\//g, '-');
  } catch {
    return new Date(ms).toISOString();
  }
}

function ageText(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 60) return `${Math.round(n)} 分钟前`;
  if (n < 60 * 48) return `${Math.round(n / 60)} 小时前`;
  return `${Math.round(n / (60 * 24))} 天前`;
}

function bytesText(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function num(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return digits > 0 ? n.toFixed(digits) : String(Math.round(n));
}

const AUTH_TEXT = {
  valid: 'valid（有效）',
  expiring: 'expiring（即将到期）',
  expired: 'expired（已过期，需要重新登录）',
  required: 'required（云端已拒绝，必须重新授权）',
  unknown: 'unknown（来源读不到或还没采过，鉴权状态无法确认）',
};

const FRESH_TEXT = {
  fresh: 'fresh（新鲜）',
  delayed: 'delayed（有延迟）',
  stale: 'stale（过旧）',
  no_data: 'no_data（还没有样本）',
  error: 'error（最近一次采集失败）',
};

const SLEEP_TEXT = {
  awaiting_first_night: 'awaiting_first_night（等待首次真实夜间记录）',
  no_data: 'no_data（没有睡眠数据）',
  partial: 'partial（有汇总但不可靠/不完整）',
  present: 'present（有可用睡眠记录）',
};

function readDbFileInfo(dbPath) {
  try {
    const stat = fs.statSync(dbPath);
    return { exists: true, sizeBytes: stat.size, mtime: stat.mtime.toISOString() };
  } catch {
    return { exists: false, sizeBytes: 0, mtime: null };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.error) {
    process.stderr.write(`${options.error}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const home = resolveHome(options.home);
  const dbPath = path.join(home, 'health', 'health.db');
  const configPath = path.join(home, 'health', 'config.json');
  const fileInfo = readDbFileInfo(dbPath);

  let createHealthService = null;
  let loadError = null;
  try {
    ({ createHealthService } = await import(pathToFileURL(SERVICE_FILE).href));
  } catch (error) {
    loadError = error instanceof Error ? (error.message || String(error.code ?? '')) : String(error);
  }

  const report = {
    ok: false,
    reason: null,
    generatedAt: new Date().toISOString(),
    timezone: TZ,
    workspace: WORKSPACE_ROOT,
    home,
    dbPath,
    configPath,
    dbExists: fileInfo.exists,
    configExists: fs.existsSync(configPath),
    service: null,
    source: null,
    collector: null,
    db: null,
    freshness: null,
    auth: null,
    sleep: null,
    consents: null,
    heartbeat: null,
    faults: [],
    probe: null,
    notes: [],
    readiness: null,
    exitCode: 1,
  };

  if (!createHealthService) {
    // The plugin surface itself is missing (e.g. a partial checkout). Say so plainly instead of
    // printing a stack trace: this is an acceptance tool, not a debugger.
    report.reason = 'service-unavailable';
    report.notes.push(`无法加载 ${path.relative(WORKSPACE_ROOT, SERVICE_FILE)}: ${String(loadError ?? '').slice(0, 200)}`);
    report.exitCode = options.exitZero ? 0 : 1;
    return finish(report, options);
  }

  const service = createHealthService({
    root: WORKSPACE_ROOT,
    home,
    readOnly: true,
    log: () => {}, // silence the service's own one-liners; this script reports instead
  });

  const init = await service.initialize();

  // 三通道诚实状态（采集 / 账号 / 心率）：**任何阶段**都能回答，所以放在分支之前取。
  // 这就是「未配置」和「不可用」被区分开的地方 —— 不要从 `ok:false` 反推。
  report.readiness = (() => {
    try { return service.readiness(); } catch { return null; }
  })();

  // Described **after** initialize: before it runs, the health-core modules are not loaded yet and
  // `modulesMissing` would list all seven even though they are right there on disk.
  report.service = (() => {
    try {
      const info = service.describe();
      return {
        version: info.version,
        phase: info.phase,
        readOnly: true,
        modulesLoaded: info.modules?.loaded?.length ?? 0,
        modulesMissing: info.modules?.missing ?? [],
        note: '只读实例：不启动轮询、不 sync、不创建文件',
      };
    } catch {
      return { readOnly: true, note: '只读实例：不启动轮询、不 sync、不创建文件' };
    }
  })();

  // The probe runs before the initialisation verdict is acted on: verifying the live sidecar link is
  // exactly what an operator wants *before* the first successful collection ever happened.
  if (options.probe) {
    const probe = await service.probeSource({ days: options.days });
    report.probe = probe;
    if (probe?.ok !== true) {
      report.notes.push(`探测失败：${probe?.code ?? 'unknown'}（${probe?.message ?? ''}）`);
    }
  }

  if (init?.ok !== true) {
    report.reason = init?.reason ?? 'not-initialized';
    report.dbExists = fs.existsSync(dbPath);
    report.notes.push(init?.message ?? '健康服务未就绪');
    if (Array.isArray(init?.missing)) {
      report.notes.push(`缺少模块: ${init.missing.map(item => item.module).join('、')}`);
    }
    // Report the heartbeat anyway: "is the service alive at all" is a different question from
    // "does it have data", and the answer here is still readable (`initialized:false`).
    try { report.heartbeat = service.heartbeat(); } catch { report.heartbeat = null; }
    // Still report the file facts we can see without a database handle.
    report.db = {
      exists: report.dbExists,
      path: dbPath,
      sizeBytes: fileInfo.sizeBytes,
      integrity: 'unknown',
      integrityCheckedAt: null,
    };
    report.exitCode = options.exitZero ? 0 : 1;
    return finish(report, options);
  }

  const status = service.status();
  const heartbeat = service.heartbeat();
  const describe = service.describe();
  const dbFile = readDbFileInfo(dbPath);
  const integrity = (() => { try { return service.lastIntegrity(); } catch { return null; } })();

  report.heartbeat = heartbeat;  report.configWarnings = describe?.config?.warnings ?? [];

  if (status?.ok !== true) {
    report.reason = 'status-failed';
    report.notes.push(status?.message ?? '读取健康状态失败');
    report.db = { exists: dbFile.exists, path: dbPath, sizeBytes: dbFile.sizeBytes, integrity: 'unknown', integrityCheckedAt: null };
    report.exitCode = options.exitZero ? 0 : 1;
    return finish(report, options);
  }

  const samples = Number(status.db.observations || 0) + Number(status.db.dailySummaries || 0)
    + Number(status.db.workouts || 0) + Number(status.db.sleepSessions || 0);

  report.source = status.source;
  report.collector = status.collector;
  report.freshness = status.source?.freshness ?? null;
  report.auth = status.source?.auth ?? null;
  report.sleep = status.sleep;
  report.consents = status.consents;
  report.faults = Array.isArray(status.faults) ? status.faults : [];
  report.db = {
    exists: dbFile.exists,
    path: status.db.path,
    journalMode: status.db.journalMode,
    sizeBytes: status.db.sizeBytes,
    integrity: status.db.integrity,
    integrityCheckedAt: integrity?.at ? new Date(Number(integrity.at)).toISOString() : null,
    integrityQuickCheck: integrity?.quickCheck ?? null,
    integrityForeignKeys: integrity?.foreignKeyViolations ?? null,
    integrityDurationMs: integrity?.durationMs ?? null,
    counts: {
      observations: status.db.observations,
      workouts: status.db.workouts,
      devices: status.db.devices,
      dailySummaries: status.db.dailySummaries,
      sleepSessions: status.db.sleepSessions,
      sleepStages: status.db.sleepStages,
    },
  };

  // Two distinct not-yet-useful states, per the lead's ruling: no database at all is
  // `not-initialized`, an initialised database with zero samples is `awaiting_data`.
  //
  // 故障要分「现在还在坏」和「坏过、已经好了」。2026-11-04 00:4x 的真实现场：宿主重启把 sidecar
  // 一起带走 3 小时，恢复后 `health_sources.last_error_code` 已被成功同步清空、
  // `consecutiveFailures` 归零，但 `faults[]` 里仍留着 4 条历史 `unreachable`，
  // 于是体检判 `degraded / 有故障`、退出码 1 —— 而此刻链路是好的，任何按退出码做的自动化
  // 都会误报。判据只用"当前是否还在坏"的三个信号，历史只作叙述。
  const activeFaults = [];
  if (status.db.integrity === 'failed') {
    activeFaults.push({ code: 'db-integrity-failed', message: '健康数据库完整性校验未通过', at: Date.now() });
  }
  const consecutiveFailures = Number(status.collector?.consecutiveFailures ?? 0);
  if (consecutiveFailures > 0) {
    activeFaults.push({ code: 'consecutive-failures', message: `连续 ${consecutiveFailures} 次采集失败`, at: null });
  }
  const lastErrorCode = status.source?.lastErrorCode ?? null;
  if (lastErrorCode) {
    const known = activeFaults.find(fault => fault.code === String(lastErrorCode));
    if (!known) {
      const fromHistory = report.faults.find(fault => String(fault.code) === String(lastErrorCode));
      activeFaults.push(fromHistory ?? { code: String(lastErrorCode), message: `来源错误码 ${lastErrorCode}`, at: null });
    }
  }
  const activeCodes = new Set(activeFaults.map(fault => String(fault.code)));
  report.activeFaults = activeFaults;
  report.recentFaults = report.faults.filter(fault => !activeCodes.has(String(fault.code)));

  const healthy = status.db.integrity !== 'failed' && activeFaults.length === 0;
  report.ok = healthy && samples > 0;
  report.reason = samples > 0 ? (healthy ? 'ready' : 'degraded') : 'awaiting_data';
  if (!report.ok && activeFaults.length === 0 && samples === 0) {
    report.notes.push('数据库已建好但还没有任何样本：等第一次成功采集写入后即为 ready');
  }
  if (report.recentFaults.length > 0 && activeFaults.length === 0) {
    report.notes.push(`已恢复：当前无故障，历史 ${report.recentFaults.length} 条见下方"历史故障（已恢复）"`);
  }
  if (status.sleep?.availability === 'awaiting_first_night') {
    report.notes.push('睡眠：云端还没有任何睡眠记录，本轮只等待，不生成任何睡眠数据');
  }

  report.exitCode = options.exitZero ? 0 : (report.ok ? 0 : 1);
  return finish(report, options);
}

function finish(report, options) {
  if (options.json) {
    // Single line, machine-friendly. `exitCode` is mirrored inside the payload so a wrapper that
    // cannot read the process exit code still sees the verdict.
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    process.stdout.write(`${renderHuman(report, options)}\n`);
  }
  process.exitCode = report.exitCode;
}

function renderHuman(report, options) {
  const lines = [];
  const push = (text = '') => lines.push(text);
  const verdict = report.reason === 'ready' ? '健康'
    : report.reason === 'awaiting_data' ? '已初始化，尚无样本'
      : report.reason === 'degraded' ? '有故障'
        : report.reason === 'not-initialized' ? '尚未初始化（还没有数据库）'
          : report.reason === 'modules-missing' ? '健康模块未就绪（health-core 尚未落地）'
            : report.reason === 'service-unavailable' ? '插件入口不可用'
              : `异常（${report.reason ?? 'unknown'}）`;

  push(`companion-health 体检 · ${localText(report.generatedAt)} (${TZ})`);
  push(`工作区 ${report.workspace}`);
  push(`home   ${report.home}`);
  push('模式   只读：不启动轮询 / 不 sync / 不建库建配置 / 默认不联网');
  push();
  push(`结论   ${report.ok ? '健康' : verdict}${report.ok ? '' : ''}   [reason=${report.reason ?? 'unknown'}]`);
  if (report.readiness) {
    const readiness = report.readiness;
    push(`三态   采集 ${readiness.collection?.label ?? '—'} · 账号 ${readiness.account?.label ?? '—'}`
      + ` · 心率 ${readiness.ble?.label ?? '—'}`);
    // 只有「不是正常」的通道才解释原因，避免健康时刷一堆字。
    for (const [label, channel] of [['采集', readiness.collection], ['账号', readiness.account], ['心率', readiness.ble]]) {
      if (channel && channel.state !== 'ready' && channel.state !== 'authorized') {
        push(`       ${label}：${channel.hint}`);
      }
    }
  }
  for (const note of report.notes ?? []) push(`说明   ${note}`);
  if ((report.configWarnings ?? []).length) {
    for (const warning of report.configWarnings) push(`配置   ${warning}`);
  }
  push();

  if (report.source) {
    const source = report.source;
    push(`来源   ${source.displayName}（${source.id} / ${source.provider}）  启用=${source.enabled ? '是' : '否'}`);
    const auth = report.auth ?? source.auth ?? {};
    const minutes = Number(auth.minutesLeft);
    push(`鉴权   ${AUTH_TEXT[auth.status] ?? String(auth.status)}`
      + `${Number.isFinite(minutes) ? `，剩余 ${Math.round(minutes)} 分钟` : ''}`
      + `${auth.expiresAt ? `（到期 ${localText(auth.expiresAt)}）` : ''}`
      + `${auth.rotated === true ? '，本轮发生过轮转' : ''}`);
    push(`最近成功 ${localText(source.lastSuccessAt)}${source.lastErrorCode ? `  最近错误码 ${source.lastErrorCode}` : ''}`);
    const freshness = report.freshness ?? source.freshness ?? {};
    push(`新鲜度 ${FRESH_TEXT[freshness.status] ?? String(freshness.status)}`
      + `  最新样本 ${localText(freshness.newestSampleAt)}（${ageText(freshness.ageMinutes)}）`);
    push();
  }

  if (report.collector) {
    const collector = report.collector;
    push(`采集器 ${collector.mode} ${collector.baseUrl}  每 ${collector.pollMinutes} 分钟  窗口 ${collector.windowDays} 天`
      + `  运行中=${collector.running ? '是' : '否'}  单飞=${collector.singleFlight ? '是' : '否'}`);
    push(`       最近一轮 ${localText(collector.lastRunAt)}  下次允许 ${localText(collector.nextAllowedAt)}`
      + `  连续失败 ${collector.consecutiveFailures}  限流至 ${localText(collector.rateLimitedUntil)}`);
    push();
  }

  if (report.db) {
    const db = report.db;
    push(`数据库 ${db.path}  存在=${db.exists ? '是' : '否'}`);
    push(`       journal=${db.journalMode ?? '—'}  integrity=${db.integrity}`
      + `  大小 ${bytesText(db.sizeBytes)}  校验于 ${localText(db.integrityCheckedAt)}`);
    if (db.counts) {
      const counts = db.counts;
      push(`       观测 ${num(counts.observations)} / 训练 ${num(counts.workouts)} / 设备 ${num(counts.devices)}`
        + ` / 日汇总 ${num(counts.dailySummaries)} / 睡眠 ${num(counts.sleepSessions)} / 睡眠阶段 ${num(counts.sleepStages)}`);
    }
    push();
  }

  if (report.sleep) {
    push(`睡眠   ${SLEEP_TEXT[report.sleep.availability] ?? String(report.sleep.availability)}`
      + `  ${num(report.sleep.sessions)} 条  最近 ${localText(report.sleep.lastSessionAt)}`
      + `  阶段保真度 ${report.sleep.stageFidelity ?? '—'}`
      + `${report.sleep.firstNightPending ? '  等待首次真实夜间记录' : ''}`);
    push();
  }

  if (report.heartbeat) {
    const hb = report.heartbeat;
    push(`服务心跳 at=${localText(hb.at)}  running=${hb.running ? '是' : '否'}  initialized=${hb.initialized === false ? '否' : '是'}`
      + `  lastRunAt=${localText(hb.lastRunAt)}  nextAllowedAt=${localText(hb.nextAllowedAt)}`
      + `  consecutiveFailures=${hb.consecutiveFailures ?? 0}  rateLimitedUntil=${localText(hb.rateLimitedUntil)}`);
    push();
  }

  if (report.consents && typeof report.consents === 'object') {
    const entries = Object.entries(report.consents);
    if (entries.length) {
      push(`授权   ${entries.map(([key, value]) => `${key}=${value === true ? 'on' : 'off'}`).join('  ')}`);
      push();
    }
  }

  if (report.activeFaults?.length) {
    push('故障（当前）');
    for (const fault of report.activeFaults) {
      push(`  [${fault.code}] ${fault.message}${fault.at ? `  @${localText(fault.at)}` : ''}`);
    }
  } else {
    push('故障（当前）   无');
  }
  if (report.recentFaults?.length) {
    push(`历史故障（已恢复）   ${report.recentFaults.length} 条，仅作叙述，不影响结论`);
    for (const fault of report.recentFaults.slice(0, 5)) {
      push(`  [${fault.code}] ${fault.message}  @${localText(fault.at)}`);
    }
    if (report.recentFaults.length > 5) push(`  …还有 ${report.recentFaults.length - 5} 条`);
  }

  if (report.probe) {
    push();
    const probe = report.probe;
    if (probe.ok !== true) {
      push(`探测  失败 code=${probe.code ?? 'unknown'} http=${probe.httpStatus ?? '—'} 耗时 ${num(probe.latencyMs)} ms`);
      if (probe.message) push(`      ${probe.message}`);
    } else {
      const summary = probe.summary ?? {};
      push(`探测  HTTP ${probe.httpStatus ?? '—'}  耗时 ${num(probe.latencyMs)} ms  窗口 ${probe.days} 天`
        + `  sidecar 同步于 ${localText(summary.syncedAt)}`);
      push(`      活动 ${summary.daily?.lastDate ?? '—'} ${num(summary.daily?.steps)} 步`
        + ` / ${num(summary.daily?.distanceM)} m / ${num(summary.daily?.kcal, 1)} kcal`
        + `（活跃 ${num(summary.daily?.activeHours)} h，中高强度 ${num(summary.daily?.exerciseMin)} min，目标 ${num(summary.daily?.stepGoal)}）`);
      const hr = summary.health?.heartRate;
      const stress = summary.health?.stress;
      const spo2 = summary.health?.spo2;
      push(`      心率 ${hr ? `avg ${num(hr.avg)} / max ${num(hr.max)} / min ${num(hr.min)} / resting ${num(hr.resting)}` : '—'}`);
      push(`      压力 ${stress ? `avg ${num(stress.avg)} / max ${num(stress.max)} / min ${num(stress.min)} / 测量 ${num(stress.measurements)} 次` : '—'}`);
      push(`      血氧 ${spo2 ? `avg ${num(spo2.avg, 1)}% / max ${num(spo2.max)} / min ${num(spo2.min)}` : '—'}`);
      const rt = summary.realtime ?? {};
      push(`      实时 ${rt.heartRate ? `心率 ${num(rt.heartRate.value)} bpm @${localText(rt.heartRate.at)}` : '心率 —'}`
        + `、${rt.stress ? `压力 ${num(rt.stress.value)} @${localText(rt.stress.at)}` : '压力 —'}`
        + `、${rt.spo2 ? `血氧 ${num(rt.spo2.value)}% @${localText(rt.spo2.at)}` : '血氧 —'}`);
      push(`      训练 ${num(summary.sessions?.count)} 条`
        + `${summary.sessions?.last ? `（最近 ${summary.sessions.last.startText ?? '—'} ${summary.sessions.last.label ?? ''} ${num(summary.sessions.last.durationMin)} min）` : ''}`
        + `  设备 ${num(summary.devices?.count)} 台（不打印任何设备标识）`);
      push(`      睡眠 ${SLEEP_TEXT[summary.sleep?.availability] ?? String(summary.sleep?.availability ?? '—')}`
        + `（sidecar 返回 ${num(summary.sleep?.rows)} 行；没有就是没有，不编造）`);
      const token = probe.token ?? {};
      const auth = summary.auth ?? {};
      push(`      鉴权 ${token.status ?? '—'}  剩余 ${num(token.minutesLeft)} 分钟`
        + `${auth.refreshDiesText ? `  刷新令牌到期 ${auth.refreshDiesText}` : ''}`
        + `${token.hostKind ? `  轮廓 ${token.hostKind}` : ''}`
        + `${auth.accountHint ? `  账号 ${auth.accountHint}` : ''}`);
      if (summary.errors?.length) push(`      sidecar errors: ${summary.errors.join(' | ')}`);
    }
  } else if (!options.probe) {
    push();
    push('探测   未开启（需要真实链路复核时加 --probe；默认不联网）');
  }
  return lines.join('\n');
}

main().catch(error => {
  // A crash here must still be readable: one line, no credential, non-zero exit.
  process.stderr.write(`check-health 失败: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
