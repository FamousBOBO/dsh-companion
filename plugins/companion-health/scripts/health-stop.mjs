#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// companion-health 一键停机 / 回滚（`node plugins/companion-health/scripts/health-stop.mjs`）。
//
// 它只做一件事：把 `<home>/health/config.json` 的 `enabled` 改成 false（原子写，先备份）。
// **不杀进程、不碰 host、不删数据库、不动授权表。** 下一轮 `start()`/`syncNow()` 会以
// `health-disabled` 拒绝，但已经在宿主进程里的定时器要等 reload/重启才消失 —— 这一点脚本会明说，
// 而不是假装"已经彻底停了"。
//
// 用法：
//   node plugins/companion-health/scripts/health-stop.mjs                 关闭采集（写 enabled:false，先备份）
//   node plugins/companion-health/scripts/health-stop.mjs --status        只读报告当前 enabled 与最近一次 sync run
//   node plugins/companion-health/scripts/health-stop.mjs --restore <bak> 用备份恢复配置
//   node plugins/companion-health/scripts/health-stop.mjs --json          单行 JSON（可与上面任意一种组合）
//   --home <dir>                                 指定 companion home（默认 $DSH_COMPANION_HEALTH_HOME → $DSH_COMPANION_DATA_DIR/home → <套件根>/data/home）

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '..');
const WORKSPACE_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
const CONFIG_MODULE = path.join(PLUGIN_ROOT, 'lib', 'config.mjs');
const SERVICE_MODULE = path.join(PLUGIN_ROOT, 'lib', 'service.mjs');
const TZ = 'Asia/Shanghai';

/**
 * companion home，和 `lib/service.mjs` 的 `resolveHome()` 同一套顺序：
 * 显式 `--home` → `$DSH_COMPANION_HEALTH_HOME` → `$DSH_COMPANION_DATA_DIR/home` → `<套件根>/data/home`。
 * 这里也要算出 configPath，所以不能只把 null 交给服务。
 */
function resolveHome(explicit) {
  if (explicit) return path.resolve(String(explicit));
  const envHome = process.env.DSH_COMPANION_HEALTH_HOME;
  if (envHome && envHome.trim()) return path.resolve(envHome.trim());
  const envData = process.env.DSH_COMPANION_DATA_DIR;
  if (envData && envData.trim()) return path.join(path.resolve(envData.trim()), 'home');
  return path.join(WORKSPACE_ROOT, 'data', 'home');
}

const USAGE = `用法: node plugins/companion-health/scripts/health-stop.mjs [选项]

  （无参数）        关闭采集：把 <home>/health/config.json 的 enabled 改为 false（原子写，先备份）
  --status          只读报告当前 enabled 与最近一次 sync run
  --restore <bak>   用备份文件恢复配置（会先备份当前配置）
  --home <dir>      指定 companion home（默认 $DSH_COMPANION_HEALTH_HOME → $DSH_COMPANION_DATA_DIR/home → <套件根>/data/home）
  --json            输出单行 JSON
  -h, --help        显示本帮助

只改配置：不杀进程、不碰宿主、不删数据库、不动授权表。`;

function parseArgs(argv) {
  const options = { action: 'disable', status: false, restore: null, json: false, home: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === '--status') { options.status = true; options.action = 'status'; }
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--restore') { options.restore = argv[++i] ?? null; options.action = 'restore'; }
    else if (arg.startsWith('--restore=')) { options.restore = arg.slice('--restore='.length); options.action = 'restore'; }
    else if (arg === '--home') options.home = argv[++i] ?? null;
    else if (arg.startsWith('--home=')) options.home = arg.slice('--home='.length);
    else return { error: `未知参数: ${arg}` };
  }
  if (options.restore !== undefined && options.action === 'restore' && !options.restore) {
    return { error: '--restore 需要一个备份文件路径' };
  }
  return options;
}

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

async function loadConfigModule() {
  return import(pathToFileURL(CONFIG_MODULE).href);
}

function readJsonFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('顶层不是 JSON 对象');
  }
  return value;
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

  const configPath = path.join(home, 'health', 'config.json');

  let configModule = null;
  try {
    configModule = await loadConfigModule();
  } catch (error) {
    process.stderr.write(`无法加载 lib/config.mjs: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  if (options.action === 'status') return statusReport({ home, configPath, configModule, options });
  if (options.action === 'restore') return restoreConfig({ home, configPath, configModule, options });
  return disableCollection({ home, configPath, configModule, options });
}

// ------------------------------------------------------------------------------------------------

async function statusReport({ home, configPath, configModule, options }) {
  const exists = fs.existsSync(configPath);
  let enabled = null;
  let warnings = [];
  let raw = null;
  if (exists) {
    try { raw = readJsonFile(configPath); } catch (error) { warnings = [`配置文件不是合法 JSON: ${String(error.message).slice(0, 120)}`]; }
  }
  if (raw) {
    const validated = configModule.validateConfig(raw);
    enabled = validated.config.enabled === true;
    warnings = warnings.concat(validated.warnings);
  }

  // The last sync run is reported through the read-only service (never via a fresh SQLite
  // connection of our own). When health-core is not there yet, say so instead of guessing.
  let lastRun = null;
  let collector = null;
  let serviceNote = null;
  try {
    const { createHealthService } = await import(pathToFileURL(SERVICE_MODULE).href);
    const service = createHealthService({ root: WORKSPACE_ROOT, home, readOnly: true, log: () => {} });
    const init = await service.initialize();
    if (init?.ok === true) {
      const status = service.status();
      if (status?.ok === true) {
        lastRun = {
          at: status.collector.lastRunAt,
          nextAllowedAt: status.collector.nextAllowedAt,
          consecutiveFailures: status.collector.consecutiveFailures,
          rateLimitedUntil: status.collector.rateLimitedUntil,
          running: status.collector.running,
        };
        collector = status.collector;
      } else {
        serviceNote = status?.message ?? '读取状态失败';
      }
      await service.close();
    } else {
      serviceNote = `服务未就绪（${init?.reason ?? init?.code ?? 'unknown'}）`;
    }
  } catch (error) {
    serviceNote = `服务不可用（${String(error instanceof Error ? error.message : error).slice(0, 120)}）`;
  }

  const report = {
    ok: true,
    action: 'status',
    generatedAt: new Date().toISOString(),
    home,
    configPath,
    configExists: exists,
    enabled,
    pollMinutes: collector?.pollMinutes ?? null,
    baseUrl: collector?.baseUrl ?? null,
    lastRunAt: lastRun?.at ?? null,
    nextAllowedAt: lastRun?.nextAllowedAt ?? null,
    consecutiveFailures: lastRun?.consecutiveFailures ?? null,
    rateLimitedUntil: lastRun?.rateLimitedUntil ?? null,
    running: lastRun?.running ?? null,
    serviceNote,
    warnings,
    restartRequiredToUnload: enabled === false,
    exitCode: 0,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    const lines = [];
    lines.push(`companion-health 状态 · ${localText(report.generatedAt)} (${TZ})`);
    lines.push(`home   ${home}`);
    lines.push(`配置   ${configPath}${exists ? '' : '（不存在：尚未初始化，等价于默认 enabled=false（发布默认就是不采集））'}`);
    lines.push(`enabled ${enabled === null ? '未知' : (enabled ? 'true（采集开启）' : 'false（采集已关闭）')}`);
    if (collector) {
      lines.push(`采集器 ${collector.mode} ${collector.baseUrl}  每 ${collector.pollMinutes} 分钟  窗口 ${collector.windowDays} 天  运行中=${collector.running ? '是' : '否'}`);
      lines.push(`最近一轮 ${localText(report.lastRunAt)}  下次允许 ${localText(report.nextAllowedAt)}`
        + `  连续失败 ${report.consecutiveFailures ?? 0}  限流至 ${localText(report.rateLimitedUntil)}`);
    } else if (serviceNote) {
      lines.push(`采集器 ${serviceNote}（无法报告最近一轮）`);
    }
    for (const warning of warnings) lines.push(`配置警告 ${warning}`);
    if (enabled === false) {
      lines.push('提示   配置已关闭；宿主进程内的定时器要等 reload/重启才彻底消失。');
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  process.exitCode = report.exitCode;
}

// ------------------------------------------------------------------------------------------------

async function disableCollection({ home, configPath, configModule, options }) {
  const report = {
    ok: false,
    action: 'disable',
    generatedAt: new Date().toISOString(),
    home,
    configPath,
    previousEnabled: null,
    enabled: null,
    backup: null,
    created: false,
    restartRequired: true,
    rollbackCommand: null,
    notes: [],
    exitCode: 1,
  };

  let raw = null;
  const exists = fs.existsSync(configPath);
  if (exists) {
    try {
      raw = readJsonFile(configPath);
    } catch (error) {
      report.notes.push(`配置文件不是合法 JSON，未做任何改动：${String(error.message).slice(0, 120)}`);
      return finishStop(report, options);
    }
  }

  let next;
  if (raw) {
    const validated = configModule.validateConfig(raw);
    report.previousEnabled = validated.config.enabled === true;
    // Only `enabled` is touched: operator-owned values (and any hand edit) survive.
    next = { ...raw, enabled: false };
    for (const warning of validated.warnings) report.notes.push(`配置警告：${warning}`);
  } else {
    report.previousEnabled = null;
    next = { ...configModule.defaultConfig(), enabled: false };
    report.created = true;
  }

  if (report.previousEnabled === false) {
    // Already off: do not rewrite the file (a no-op write would still churn the backup files).
    report.enabled = false;
    report.ok = true;
    report.exitCode = 0;
    report.notes.push('enabled 本来就是 false，未改写配置');
    return finishStop(report, options);
  }

  try {
    report.backup = configModule.backupConfig(configPath);
    configModule.writeConfigAtomic(configPath, next);
    report.enabled = false;
    report.ok = true;
    report.exitCode = 0;
  } catch (error) {
    report.notes.push(`写入配置失败：${String(error instanceof Error ? error.message : error).slice(0, 160)}`);
    return finishStop(report, options);
  }

  const relativeScript = path.relative(process.cwd(), path.join(SCRIPT_DIR, 'health-stop.mjs')) || 'health-stop.mjs';
  report.rollbackCommand = report.backup
    ? `node ${relativeScript} --restore "${report.backup}"`
    : `node ${relativeScript} --home "${home}"   # 原配置不存在：删掉 ${configPath} 即回到默认 enabled=true`;
  report.notes.push('已写 enabled:false；宿主进程内的轮询要等桌面宿主 reload/重启才彻底卸载。');
  return finishStop(report, options);
}

function finishStop(report, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.exitCode;
    return;
  }
  const lines = [];
  lines.push(`companion-health 停机 · ${localText(report.generatedAt)} (${TZ})`);
  lines.push(`home   ${report.home}`);
  lines.push(`配置   ${report.configPath}${report.created ? '（原本不存在，已新建一份 enabled:false）' : ''}`);
  lines.push(`结果   ${report.ok ? '已关闭采集' : '未改动 / 失败'}`);
  if (report.previousEnabled !== null) {
    lines.push(`改动   enabled: ${report.previousEnabled ? 'true' : 'false'} → ${report.enabled === false ? 'false' : '（未改）'}`);
  }
  if (report.backup) lines.push(`备份   ${report.backup}`);
  for (const note of report.notes) lines.push(`说明   ${note}`);
  lines.push('注意   本脚本不杀进程、不碰宿主进程；只改配置。');
  if (report.rollbackCommand) lines.push(`回滚   ${report.rollbackCommand}`);
  lines.push(`验证   node ${path.relative(process.cwd(), path.join(SCRIPT_DIR, 'health-stop.mjs')) || 'health-stop.mjs'} --status`);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exitCode = report.exitCode;
}

// ------------------------------------------------------------------------------------------------

async function restoreConfig({ home, configPath, configModule, options }) {
  const report = {
    ok: false,
    action: 'restore',
    generatedAt: new Date().toISOString(),
    home,
    configPath,
    backupFile: null,
    backupOfCurrent: null,
    enabled: null,
    notes: [],
    exitCode: 1,
  };
  const requested = path.resolve(String(options.restore));
  report.backupFile = requested;
  if (!fs.existsSync(requested)) {
    report.notes.push(`备份文件不存在：${requested}`);
    return finishRestore(report, options);
  }
  let restored = null;
  try {
    restored = readJsonFile(requested);
  } catch (error) {
    report.notes.push(`备份文件不是合法 JSON：${String(error.message).slice(0, 120)}`);
    return finishRestore(report, options);
  }
  const validated = configModule.validateConfig(restored);
  report.enabled = validated.config.enabled === true;
  for (const warning of validated.warnings) report.notes.push(`配置警告：${warning}`);
  try {
    // Never overwrite the backup we are about to restore from.
    report.backupOfCurrent = configModule.backupConfig(configPath, { avoid: [requested] }) ?? null;
    configModule.writeConfigAtomic(configPath, restored);
    report.ok = true;
    report.exitCode = 0;
    report.notes.push('已用备份覆盖配置；宿主需要 reload/重启后行为才会改变。');
  } catch (error) {
    report.notes.push(`恢复失败：${String(error instanceof Error ? error.message : error).slice(0, 160)}`);
  }
  return finishRestore(report, options);
}

function finishRestore(report, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.exitCode;
    return;
  }
  const lines = [];
  lines.push(`companion-health 回滚 · ${localText(report.generatedAt)} (${TZ})`);
  lines.push(`home   ${report.home}`);
  lines.push(`备份   ${report.backupFile}`);
  lines.push(`结果   ${report.ok ? '已恢复' : '未恢复'}`);
  if (report.backupOfCurrent) lines.push(`原配置已另存 ${report.backupOfCurrent}`);
  if (report.enabled !== null) lines.push(`enabled ${report.enabled ? 'true' : 'false'}`);
  for (const note of report.notes) lines.push(`说明   ${note}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exitCode = report.exitCode;
}

main().catch(error => {
  process.stderr.write(`health-stop 失败: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
