#!/usr/bin/env node
/**
 * `npm run doctor` — 只读诊断。
 *
 * 它做三件事：
 *   1. 检查环境（Node / npm / 宿主可执行文件 / 宿主 CLI 入口）与套件配置是否自洽；
 *   2. 检查每个**已启用**模块的入口文件、profile 依赖与 bundle 登记；
 *   3. 让宿主真正合成一次 profile（`--dump-config`，不挂载），再逐个验证它引用的
 *      `file://` 插件路径确实存在。
 *
 * 状态分级（UI 与文档里不要混用）：
 *   ok          检查通过
 *   warn        能跑，但要注意（例如宿主版本高于已验证基线、人格文件用的还是模板）
 *   pending     还没到那一步（例如还没跑 setup），不是错误，会给出下一步该做什么
 *   skipped     前置条件不足，这项没做（例如没有宿主时无法合成 profile）
 *   info        只是报告事实，不参与判定（外部服务未配置、模块开关状态）
 *   fail        核心检查失败，退出码 1
 *
 * 用法：node scripts/doctor.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUITE_ROOT, SUITE_PATHS, dataPaths } from '../tools/lib/paths.mjs';
import { loadConfig, enabledModules, SAFE_DEFAULTS } from '../tools/lib/config.mjs';
import { resolveHost, checkCompatibility, compareVersions, COMPATIBILITY } from '../tools/lib/host.mjs';
import {
  describeLauncher,
  profileDir,
  profileExists,
  readProfilePackage,
  profileBundles,
  dumpConfig,
  dumpEntryIds,
  dumpFileUrls,
  fileUrlToPath,
} from '../tools/lib/dsh.mjs';

const MIN_NODE = '24.0.0';
const MIN_NPM = '10.0.0';
const PATCH_GENERATED = path.join(SUITE_PATHS.profileTemplateDir, 'companion.patch.yml');
const PATCH_TEMPLATE = path.join(SUITE_PATHS.profileTemplateDir, 'companion.patch.template.yml');

/** 模块 → 检查方式。与 setup.mjs 的 MODULE_SPECS 保持一致（doctor 不写，所以只读子集）。 */
const MODULE_CHECKS = {
  core: {
    kind: 'core',
    title: '核心五件套（人格/记忆/运行时/群边界）',
    directories: [
      'plugins/companion-foundation/index.mjs',
      'plugins/companion-memory/index.mjs',
      'plugins/companion-runtime/index.mjs',
      'plugins/companion-group/index.mjs',
    ],
  },
  memoryStudio: { kind: 'bundle', directory: 'plugins/companion-memory-studio', title: '陪伴空间 Web UI' },
  qq: {
    kind: 'bundle',
    directory: 'plugins/dsh-channel-qq',
    title: 'QQ 通道',
    expectedEntryIds: ['channel-qq'],
    files: ['plugins/qq-idle-compaction.mjs', 'plugins/companion-group/boundary.mjs'],
  },
  bilibili: { kind: 'external', title: 'B站 刷视频（外部模块）', packageName: 'dsh-bili-scroll' },
  health: { kind: 'file', directory: 'plugins/companion-health', entry: 'index.mjs', title: '健康数据（含华为健康 sidecar）' },
  media: { kind: 'file', directory: 'plugins/companion-media', entry: 'index.mjs', title: '媒体层（生图/TTS/识图）' },
  pasteSearch: { kind: 'bundle', directory: 'plugins/dsh-paste-search', title: '搜图入口' },
  superInjector: { kind: 'bundle', directory: 'plugins/dsh-super-injector', title: '超级注入器' },
};

const STATUS_ORDER = { fail: 0, warn: 1, pending: 2, skipped: 3, ok: 4, info: 5 };
const STATUS_LABEL = {
  ok: '通过', warn: '注意', pending: '未就绪', skipped: '跳过', info: '信息', fail: '失败',
};

function parseArgs(argv) {
  const opts = { json: false, help: false };
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`未知参数：${arg}（可用：--json --help）`);
  }
  return opts;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { __error: true };
  }
}

/** 从 package.json 的 exports/main 推导入口文件，返回它是否真的存在。 */
function pluginEntry(directory) {
  const file = path.join(directory, 'package.json');
  if (!fs.existsSync(file)) return { declared: '', exists: false, name: '', file };
  const manifest = readJsonSafe(file);
  if (manifest.__error) return { declared: '', exists: false, name: '', file };
  const dot = manifest.exports?.['.'];
  const declared = typeof dot === 'string' ? dot : (dot?.default || dot?.import || manifest.main || '');
  return {
    declared,
    exists: declared ? fs.existsSync(path.join(directory, declared)) : false,
    name: manifest.name || '',
    file,
  };
}

function npmVersion() {
  const agent = process.env.npm_config_user_agent || '';
  const match = /npm\/([0-9][^\s]*)/.exec(agent);
  return match ? match[1] : '';
}

export function runDoctor(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const started = Date.now();
  const checks = [];
  const lines = [];
  const say = (line = '') => { lines.push(line); };

  const add = (check) => {
    checks.push({ ...check });
    return check;
  };

  say('DSH Companion — doctor（只读）');
  say(`  套件根：${SUITE_ROOT}`);

  /* ── 环境 ─────────────────────────────────────────────────── */
  say('');
  say('环境');

  const nodeVersion = process.versions.node;
  const nodeOk = compareVersions(nodeVersion, MIN_NODE) >= 0;
  add({
    id: 'node', title: 'Node.js', status: nodeOk ? 'ok' : 'fail',
    detail: nodeOk ? `${nodeVersion}` : `${nodeVersion} 低于要求 ${MIN_NODE}（node:sqlite 需要 Node 24）`,
  });

  const npm = npmVersion();
  if (!npm) {
    add({ id: 'npm', title: 'npm', status: 'info', detail: '不是通过 npm 运行，版本未知（npm run doctor 会给出）' });
  } else {
    const npmOk = compareVersions(npm, MIN_NPM) >= 0;
    add({ id: 'npm', title: 'npm', status: npmOk ? 'ok' : 'warn', detail: npm });
  }

  let loaded;
  let config;
  let paths;
  const configExists = fs.existsSync(SUITE_PATHS.configFile);
  if (configExists) {
    const raw = readJsonSafe(SUITE_PATHS.configFile);
    if (raw.__error) {
      add({
        id: 'config', title: 'config/suite.json', status: 'fail',
        detail: '不是合法 JSON。修好它，或删掉它让 setup 用 config/suite.example.json 重新生成',
      });
      loaded = { config: SAFE_DEFAULTS, dataPaths: dataPaths(path.join(SUITE_ROOT, 'data')), sources: [] };
    } else {
      try {
        loaded = loadConfig();
        add({ id: 'config', title: 'config/suite.json', status: 'ok', detail: '存在且合法' });
      } catch (err) {
        add({ id: 'config', title: 'config/suite.json', status: 'fail', detail: err.message });
        loaded = { config: SAFE_DEFAULTS, dataPaths: dataPaths(path.join(SUITE_ROOT, 'data')), sources: [] };
      }
    }
  } else {
    add({
      id: 'config', title: 'config/suite.json', status: 'pending',
      detail: '尚未生成；当前用 config/suite.example.json 的默认值（可选模块全关）。跑 npm run setup 生成它',
    });
    try {
      loaded = loadConfig();
    } catch {
      loaded = { config: SAFE_DEFAULTS, dataPaths: dataPaths(path.join(SUITE_ROOT, 'data')), sources: [] };
    }
  }
  config = loaded.config;
  paths = loaded.dataPaths;

  const modules = enabledModules(config);
  const profileName = config.dsh?.profile || 'companion';
  const dshHome = paths.home;

  add({ id: 'data-root', title: '数据目录', status: 'info', detail: `${paths.root}（DSH_HOME = ${dshHome}）` });

  /* ── 宿主 ─────────────────────────────────────────────────── */
  say('');
  say('宿主');

  const host = resolveHost(config.dsh || {});
  if (!host.found) {
    add({
      id: 'host', title: 'DSH 宿主', status: 'fail',
      detail: '未检测到宿主。装 DeepSeek Harness 桌面版，或在 config/suite.json 写 dsh.executable / dsh.moduleRoot',
    });
    if (host.candidates?.length) {
      add({ id: 'host-candidates', title: '已尝试的宿主路径', status: 'info', detail: host.candidates.join(' | ') });
    }
  } else {
    add({
      id: 'host', title: 'DSH 宿主', status: 'ok',
      detail: `${host.executable || '(无桌面可执行文件)'}（来源：${host.source}）`,
    });
    const launcher = describeLauncher(host);
    if (!launcher.ready) {
      add({ id: 'host-cli', title: '宿主 CLI 入口', status: 'fail', detail: launcher.reason });
    } else {
      add({
        id: 'host-cli', title: '宿主 CLI 入口', status: launcher.launcher === 'node' ? 'warn' : 'ok',
        detail: launcher.launcher === 'node' ? launcher.reason : `${launcher.cliPath}`,
      });
    }
    const compatibility = checkCompatibility(host.version);
    add({
      id: 'host-version', title: '宿主版本', status: compatibility.ok ? (compatibility.level === 'newer' ? 'warn' : 'ok') : 'warn',
      detail: compatibility.message,
    });
    add({ id: 'host-baseline', title: '已验证基线', status: 'info', detail: `${COMPATIBILITY.verifiedAgainst}（最低 ${COMPATIBILITY.minimum}）` });
  }
  const launcher = describeLauncher(host);

  /* ── 数据目录 ─────────────────────────────────────────────── */
  say('');
  say('数据目录');

  for (const [key, dir] of Object.entries(paths)) {
    if (key === 'root') continue;
    const label = path.relative(paths.root, dir) || '.';
    if (!fs.existsSync(dir)) {
      add({ id: `dir:${key}`, title: `data/${label}`, status: 'pending', detail: '不存在（npm run setup 会创建）' });
      continue;
    }
    let writable = true;
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      writable = false;
    }
    add({
      id: `dir:${key}`, title: `data/${label}`, status: writable ? 'ok' : 'fail',
      detail: writable ? '存在且可写' : '存在但不可写（权限问题）',
    });
  }

  /* ── 人格文件 ─────────────────────────────────────────────── */
  say('');
  say('人格与配置');

  const personaCandidates = [
    { file: path.join(SUITE_PATHS.configDir, 'persona.md'), status: 'ok', label: 'config/persona.md' },
    { file: SUITE_PATHS.personaExample, status: 'warn', label: 'config/persona.example.md' },
    { file: path.join(paths.workspace, 'PERSONA.md'), status: 'warn', label: 'data/workspace/PERSONA.md（旧路径）' },
  ];
  const personaFound = personaCandidates.find((candidate) => fs.existsSync(candidate.file));
  if (!personaFound) {
    add({ id: 'persona', title: '人格文件', status: 'pending', detail: '一个都没找到（npm run setup 会生成 config/persona.md）' });
  } else if (personaFound.label === 'config/persona.md') {
    add({ id: 'persona', title: '人格文件', status: 'ok', detail: `${personaFound.label}` });
  } else {
    add({
      id: 'persona', title: '人格文件', status: personaFound.status,
      detail: `用的是 ${personaFound.label} —— 不是你自己的设定。跑 npm run setup 生成 config/persona.md 再改`,
    });
  }

  if (fs.existsSync(PATCH_TEMPLATE)) {
    add({ id: 'patch-template', title: '补丁模板', status: 'ok', detail: 'config/profile/companion.patch.template.yml' });
  } else {
    add({ id: 'patch-template', title: '补丁模板', status: 'fail', detail: '缺少 config/profile/companion.patch.template.yml（发布树不完整）' });
  }

  /* ── profile ──────────────────────────────────────────────── */
  say('');
  say(`profile（${profileName}）`);

  const hasProfile = profileExists(dshHome, profileName);
  if (!hasProfile) {
    add({
      id: 'profile', title: `profile “${profileName}”`, status: 'pending',
      detail: `不存在（npm run setup 会用 --from-default-profile web 创建）路径：${profileDir(dshHome, profileName)}`,
    });
  } else {
    add({ id: 'profile', title: `profile “${profileName}”`, status: 'ok', detail: profileDir(dshHome, profileName) });
    const bundles = profileBundles(dshHome, profileName);
    if (!bundles.length) {
      add({ id: 'profile-bundles', title: 'profile bundles', status: 'warn', detail: 'dsh.profile.bundles 为空，profile 可能无法启动' });
    } else {
      add({ id: 'profile-bundles', title: 'profile bundles', status: 'ok', detail: bundles.join(', ') });
    }
  }

  const hasPatch = fs.existsSync(PATCH_GENERATED);
  if (!hasPatch) {
    add({ id: 'patch', title: '补丁生成物', status: 'pending', detail: 'config/profile/companion.patch.yml 不存在（npm run setup 会渲染）' });
  } else {
    add({ id: 'patch', title: '补丁生成物', status: 'ok', detail: 'config/profile/companion.patch.yml' });
  }

  /* ── 模块 ─────────────────────────────────────────────────── */
  say('');
  say('模块（config/suite.json 里打开的那些）');

  const profilePkg = hasProfile ? readProfilePackage(dshHome, profileName) : null;
  const installedDeps = profilePkg?.dependencies || {};
  const registeredBundles = profileBundles(dshHome, profileName);
  const expectedEntryIds = [];

  for (const [key, spec] of Object.entries(MODULE_CHECKS)) {
    const enabled = modules[key] === true;
    if (!enabled) {
      add({ id: `module:${key}`, title: spec.title, status: 'info', detail: '未启用（自然不会有任何动作或外发）' });
      continue;
    }

    if (spec.kind === 'core') {
      const missing = spec.directories.filter((rel) => !fs.existsSync(path.join(SUITE_ROOT, rel)));
      add({
        id: `module:${key}`, title: spec.title, status: missing.length ? 'fail' : 'ok',
        detail: missing.length ? `缺少 ${missing.join('、')}` : '入口齐全',
      });
      expectedEntryIds.push('preset-companion', 'companion-foundation', 'companion-workspace-context');
      continue;
    }

    if (spec.kind === 'external') {
      const installed = Object.keys(installedDeps).some((name) => name === spec.packageName || name.includes('bili-scroll'));
      add({
        id: `module:${key}`, title: spec.title, status: installed ? 'ok' : 'warn',
        detail: installed
          ? '已安装（外部模块，本仓库不含它的代码）'
          : '外部模块，当前未安装：按 docs/03 用 dsh plugin add <固定 tarball URL> 自行安装；不影响本套件启动',
      });
      continue;
    }

    const directory = path.join(SUITE_ROOT, spec.directory);
    if (!fs.existsSync(directory)) {
      add({ id: `module:${key}`, title: spec.title, status: 'fail', detail: `发布树里缺少 ${spec.directory}` });
      continue;
    }

    if (spec.kind === 'file') {
      const entryFile = path.join(directory, spec.entry || 'index.mjs');
      add({
        id: `module:${key}`, title: spec.title, status: fs.existsSync(entryFile) ? 'ok' : 'fail',
        detail: fs.existsSync(entryFile) ? `补丁挂载 ${path.relative(SUITE_ROOT, entryFile).replace(/\\/g, '/')}` : `入口不存在：${entryFile}`,
      });
      if (key === 'health') expectedEntryIds.push('companion-health');
      if (key === 'media') expectedEntryIds.push('companion-media');
      continue;
    }

    // bundle 模块
    const entry = pluginEntry(directory);
    const installed = entry.name ? Object.prototype.hasOwnProperty.call(installedDeps, entry.name) : false;
    const registered = entry.name ? registeredBundles.includes(entry.name) : false;
    const problems = [];
    if (!entry.declared) problems.push('package.json 没声明入口（main/exports）');
    else if (!entry.exists) problems.push(`入口文件不存在：${entry.declared}（先跑 npm run build）`);
    if (!installed) problems.push('尚未装进 profile（npm run setup 会装）');
    if (installed && !registered) problems.push('没登记到 dsh.profile.bundles（加载不到它的 cordis.patch.yml）');
    const status = problems.length === 0 ? 'ok' : (problems.some((p) => p.includes('先跑 npm run build')) ? 'warn' : 'pending');
    add({
      id: `module:${key}`, title: spec.title, status,
      detail: problems.length ? problems.join('；') : `${entry.name} 已安装、已登记、入口就绪`,
    });
    for (const id of spec.expectedEntryIds || []) expectedEntryIds.push(id);
    for (const rel of spec.files || []) {
      const file = path.join(SUITE_ROOT, rel);
      add({
        id: `file:${rel}`, title: path.basename(rel), status: fs.existsSync(file) ? 'ok' : 'fail',
        detail: fs.existsSync(file) ? rel : `缺少 ${rel}`,
      });
    }
  }

  /* ── 合成检查 ─────────────────────────────────────────────── */
  say('');
  say('合成（--dump-config，不挂载）');

  if (!hasProfile) {
    add({ id: 'compose', title: 'profile 合成', status: 'skipped', detail: 'profile 还不存在，无法合成' });
  } else if (!launcher.ready) {
    add({ id: 'compose', title: 'profile 合成', status: 'skipped', detail: '没有可用的宿主 CLI' });
  } else {
    const result = dumpConfig({
      host, dshHome, profile: profileName,
      patchFiles: hasPatch ? [PATCH_GENERATED] : [],
      launcher,
    });
    if (!result.ok) {
      add({
        id: 'compose', title: 'profile 合成', status: 'fail',
        detail: `宿主合成失败（退出码 ${result.code}）：${tail(result.stderr || result.text, 6)}`,
      });
    } else {
      const ids = dumpEntryIds(result.text);
      add({ id: 'compose', title: 'profile 合成', status: 'ok', detail: `${ids.length} 个条目，${result.durationMs} ms` });

      // 合成结果里每个 file:// 插件路径都必须真的存在，否则启动时才炸。
      const urls = dumpFileUrls(result.text);
      const broken = [];
      for (const url of urls) {
        const asPath = fileUrlToPath(url);
        if (!asPath || !fs.existsSync(asPath)) broken.push(asPath || url);
      }
      add({
        id: 'compose-file-urls', title: '补丁引用的插件文件', status: broken.length ? 'fail' : 'ok',
        detail: broken.length ? `${broken.length} 个路径不存在：${broken.join(' | ')}` : `${urls.length} 个 file:// 入口全部存在`,
      });

      // 启用的模块必须在合成结果里真的出现，否则「配置已保存」≠「已经挂上」。
      const missingIds = expectedEntryIds.filter((id) => !ids.includes(id));
      const mustHave = ['preset-companion', 'companion-workspace-context'];
      const missingMust = missingIds.filter((id) => mustHave.includes(id));
      if (missingMust.length) {
        add({
          id: 'compose-preset', title: 'companion 预设是否挂上', status: hasPatch ? 'fail' : 'pending',
          detail: hasPatch
            ? `合成结果里没有 ${missingMust.join('、')}（补丁没生效？）`
            : '还没有生成补丁，所以只有宿主默认预设（npm run setup 会生成）',
        });
      } else {
        add({ id: 'compose-preset', title: 'companion 预设是否挂上', status: 'ok', detail: 'preset-companion 与 workspace-context 均在合成结果里' });
      }
      const optionalMissing = missingIds.filter((id) => !mustHave.includes(id));
      if (optionalMissing.length) {
        add({
          id: 'compose-modules', title: '已启用模块的条目', status: 'fail',
          detail: `合成结果里缺少 ${optionalMissing.join('、')}（模块开关开了但没挂上，检查安装与补丁）`,
        });
      }
    }
  }

  /* ── 外部服务与安全开关 ───────────────────────────────────── */
  say('');
  say('外部服务（未配置不是错误：套件不会主动去连）');

  const onebot = config.services?.onebot || {};
  add({
    id: 'service:onebot', title: 'OneBot / NapCat', status: 'info',
    detail: onebot.url
      ? `已配置 ${onebot.url}${onebot.accessToken ? '（带 accessToken）' : '（无 accessToken）'}`
      : '未配置（QQ 通道不会拨号）',
  });
  const health = config.services?.health || {};
  add({
    id: 'service:health', title: '健康 sidecar', status: 'info',
    detail: health.sidecarUrl ? `已配置 ${health.sidecarUrl}` : '未配置（健康采集不会发起任何请求）',
  });
  const media = config.services?.media || {};
  add({
    id: 'service:media', title: '媒体服务商', status: 'info',
    detail: media.baseUrl || media.apiKeyEnv
      ? `baseUrl=${media.baseUrl || '(空)'} apiKeyEnv=${media.apiKeyEnv || '(空)'}`
      : '未配置（生图/TTS/识图全部不可用）',
  });

  say('');
  say('安全开关（默认全关；打开就意味着会外发或产生计费调用）');

  const safety = { ...SAFE_DEFAULTS.safety, ...(config.safety || {}) };
  const on = Object.entries(safety).filter(([, value]) => value === true).map(([key]) => key);
  add({
    id: 'safety', title: '自动外发/计费开关', status: on.length ? 'warn' : 'ok',
    detail: on.length ? `已打开：${on.join('、')}（确认这是你要的）` : '全部关闭',
  });

  /* ── 密钥自检 ─────────────────────────────────────────────── */
  say('');
  say('密钥自检');

  const suspicious = [];
  const secretPatterns = [
    { re: /sk-[A-Za-z0-9_-]{16,}/g, label: '形如 sk-… 的 API key' },
    { re: /(?:accessToken|apiKey|token)\s*:\s*'?[A-Za-z0-9_\-]{16,}/g, label: '可疑的 token 值' },
  ];
  const filesToScan = [SUITE_PATHS.configFile, PATCH_GENERATED].filter((file) => fs.existsSync(file));
  for (const file of filesToScan) {
    const text = fs.readFileSync(file, 'utf8');
    for (const { re, label } of secretPatterns) {
      for (const match of text.matchAll(re)) {
        suspicious.push(`${path.relative(SUITE_ROOT, file)}：${label}`);
      }
    }
  }
  add({
    id: 'secrets', title: '配置里的明文密钥', status: suspicious.length ? 'warn' : 'ok',
    detail: suspicious.length
      ? `${suspicious.length} 处命中（本地文件已 gitignore，但确认它不该提交）：${[...new Set(suspicious)].join('；')}`
      : 'config/suite.json 与生成的补丁里没有明显密钥',
  });

  /* ── 收尾 ─────────────────────────────────────────────────── */
  return finish({ opts, checks, lines, started, config, paths, profileName, dshHome });
}

function tail(text, count) {
  return String(text || '').split(/\r?\n/).filter(Boolean).slice(-count).join(' | ');
}

function finish({ opts, checks, lines, started, config, paths, profileName, dshHome }) {
  const failures = checks.filter((check) => check.status === 'fail');
  const warnings = checks.filter((check) => check.status === 'warn');
  const pending = checks.filter((check) => check.status === 'pending');
  const ok = failures.length === 0;

  for (const check of checks) {
    lines.push(`  [${STATUS_LABEL[check.status]}] ${check.title}${check.detail ? ` — ${check.detail}` : ''}`);
  }

  lines.push('');
  lines.push(`结论：${ok ? '核心检查通过' : `核心检查失败 ${failures.length} 项`}`
    + `（注意 ${warnings.length}、未就绪 ${pending.length}、共 ${checks.length} 项）`);
  if (pending.length) lines.push('提示：带 [未就绪] 的项通常意味着还没跑 npm run setup。');
  if (failures.length) lines.push('提示：先处理 [失败] 项；docs/06-troubleshooting.md 按症状列了排查步骤。');

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      command: 'doctor',
      ok,
      suiteRoot: SUITE_ROOT,
      dataRoot: paths?.root,
      dshHome,
      profile: profileName,
      counts: { total: checks.length, fail: failures.length, warn: warnings.length, pending: pending.length },
      checks,
      durationMs: Date.now() - started,
    }, null, 2)}\n`);
  } else {
    process.stderr.write(`${lines.join('\n')}\n`);
  }
  return ok ? 0 : 1;
}

/* ────────────────────────── 入口 ────────────────────────── */

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    process.exitCode = runDoctor();
  } catch (err) {
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ command: 'doctor', ok: false, error: err.message }, null, 2)}\n`);
    }
    process.stderr.write(`doctor 失败：${err.message}\n`);
    process.exitCode = 1;
  }
}

export default { runDoctor };
