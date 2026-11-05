#!/usr/bin/env node
/**
 * `npm run setup` — 初始化本套件的本地目录、配置模板与独立 DSH profile。
 *
 * 三条硬规则（见 AGENTS.md）：
 *   1. 绝不覆盖用户已有配置：`config/suite.json`、`config/persona.md`、profile 都存在即跳过并说明。
 *   2. 绝不写套件目录以外的位置（数据目录可由 config/suite.json 的 dataDir 显式指到别处，
 *      那种情况会明确警告）。
 *   3. 失败要说清楚原因，不要吞：每个插件安装的结果都单独汇报。
 *
 * 用法：
 *   node scripts/setup.mjs [--dry-run] [--check] [--force] [--json]
 *
 *   --check    只读：检查前置条件并打印计划，不写任何文件；前置条件不满足时退出码 1。
 *   --dry-run  打印将要执行的每一步，但不落盘、不调宿主。
 *   --force    重新渲染生成物并重跑插件安装（仍然不覆盖用户配置）。
 *   --json     机器可读结果写到 stdout，人读信息走 stderr。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUITE_ROOT, SUITE_PATHS, dataPaths } from '../tools/lib/paths.mjs';
import { loadConfig, enabledModules, SAFE_DEFAULTS } from '../tools/lib/config.mjs';
import { resolveHost, checkCompatibility, compareVersions } from '../tools/lib/host.mjs';
import {
  describeLauncher,
  profileDir,
  profileExists,
  readProfilePackage,
  createProfile,
  addPlugin,
} from '../tools/lib/dsh.mjs';

/** 记忆与运行时直接用 `node:sqlite` 的 `DatabaseSync`：Node 20 没有，Node 22 需要实验开关。 */
const MIN_NODE = '24.0.0';

/** 生成物与模板。模板入库，生成物 gitignore。 */
export const PATCH_TEMPLATE = path.join(SUITE_PATHS.profileTemplateDir, 'companion.patch.template.yml');
export const PATCH_GENERATED = path.join(SUITE_PATHS.profileTemplateDir, 'companion.patch.yml');

/**
 * 模块清单：套件里每个可选模块怎么装、需要模板里哪个可选块。
 *
 * kind:
 *   core     —— 核心五件套，由 companion-foundation 以兄弟相对路径 import，成套安装；
 *   bundle   —— 自带 cordis.patch.yml 的包，通过 `dsh plugin add <目录>` 装进 profile；
 *   file     —— 不入 profile 依赖，靠补丁里的 file:// 行挂载；
 *   external —— 不在本仓库里，setup 不安装，只打印指引。
 */
export const MODULE_SPECS = {
  core: {
    kind: 'core',
    directories: ['plugins/companion-foundation', 'plugins/companion-memory', 'plugins/companion-runtime', 'plugins/companion-group'],
    title: '核心五件套（人格/记忆/运行时/群边界）',
  },
  memoryStudio: {
    kind: 'bundle',
    directory: 'plugins/companion-memory-studio',
    title: '陪伴空间 Web UI（companion-memory-studio）',
  },
  qq: {
    kind: 'bundle',
    directory: 'plugins/dsh-channel-qq',
    patchBlocks: ['qq'],
    title: 'QQ 通道（dsh-channel-qq）',
  },
  bilibili: {
    kind: 'external',
    blockTitle: 'B站 刷视频（dsh-bili-scroll）',
    title: 'B站 刷视频（dsh-bili-scroll，外部模块）',
    note: 'B站 是外部模块，本仓库不含它的代码，setup 不会安装/挂载它。',
    instructions: [
      '装：dsh plugin --profile <profile> add https://github.com/c1overzz/dsh-bili-scroll/releases/download/v2.4.0/dsh-bili-scroll-2.4.0.tgz',
      '再自行准备它的 Python 虚拟环境，并把 pythonPath 写进 profile 的 cordis.patch.yml，详见 docs/03-modules-support-matrix.md。',
      '它的自动评论/转写默认关闭，打开后会对外发言与产生模型调用。',
    ],
  },
  health: {
    kind: 'file',
    directory: 'plugins/companion-health',
    patchBlocks: ['health'],
    title: '健康数据（companion-health + 华为健康 sidecar）',
  },
  media: {
    kind: 'file',
    directory: 'plugins/companion-media',
    patchBlocks: ['media'],
    title: '媒体层（生图/TTS/识图，能力默认全关）',
  },
  pasteSearch: {
    kind: 'bundle',
    directory: 'plugins/dsh-paste-search',
    title: '搜图入口（dsh-paste-search）',
  },
  superInjector: {
    kind: 'bundle',
    directory: 'plugins/dsh-super-injector',
    title: '超级注入器（dsh-super-injector）',
  },
};

/* ────────────────────────── 参数与输出 ────────────────────────── */

function parseArgs(argv) {
  const opts = { dryRun: false, check: false, force: false, json: false, help: false };
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`未知参数：${arg}（可用：--dry-run --check --force --json --help）`);
  }
  if (opts.check) opts.dryRun = true;
  return opts;
}

const STATUS_LABEL = { ok: '完成', skip: '跳过', warn: '注意', fail: '失败', planned: '计划', info: '信息' };

function makeReporter(json) {
  const steps = [];
  const say = (line = '') => { if (!json) process.stderr.write(`${line}\n`); };
  return {
    steps,
    say,
    heading: (text) => { say(''); say(text); },
    record(step) { steps.push(step); return step; },
  };
}

function reportStep(reporter, { id, title, status, detail = '', extra }) {
  reporter.record({ id, title, status, detail, ...(extra ? { extra } : {}) });
  reporter.say(`  [${STATUS_LABEL[status] || status}] ${title}${detail ? ` — ${detail}` : ''}`);
}

/* ────────────────────────── 模板渲染 ────────────────────────── */

/**
 * 渲染补丁模板。
 *
 * 只有两条规则，故意做得很笨，以便一眼看懂生成物：
 *   1. `#@@begin:<block>` / `#@@end:<block>` 之间的内容按 activeBlocks 决定保留还是整块丢弃；
 *   2. `${NAME}` 换成 placeholders 里的值（单引号写法的值做 YAML 转义）。
 *
 * 渲染后仍残留 `${...}` 就报错 —— 宁可让 setup 失败，也不要让用户拿到带占位符的补丁。
 *
 * @param {string} templateText
 * @param {{placeholders: Record<string, string|number>, activeBlocks: Set<string>}} opts
 * @returns {string}
 */
export function renderPatchTemplate(templateText, { placeholders, activeBlocks }) {
  const lines = templateText.split(/\r?\n/);
  const out = [];
  const stack = [];

  for (const line of lines) {
    const begin = /^\s*#@@begin:([A-Za-z0-9_-]+)\s*$/.exec(line);
    if (begin) {
      stack.push({ name: begin[1], enabled: activeBlocks.has(begin[1]), start: out.length });
      continue;
    }
    const end = /^\s*#@@end:([A-Za-z0-9_-]+)\s*$/.exec(line);
    if (end) {
      const block = stack.pop();
      if (!block || block.name !== end[1]) throw new Error(`模板可选块标记不配对：${line.trim()}`);
      if (!block.enabled) {
        out.length = block.start;
        out.push(`# [未启用] ${block.name} 相关的可选块已略去（config/suite.json 的 modules.${block.name} 不是 true）。`);
        out.push('');
      }
      continue;
    }
    if (stack.some((block) => !block.enabled)) continue;
    out.push(line);
  }
  if (stack.length) throw new Error(`模板里有未闭合的可选块标记：#@@begin:${stack[stack.length - 1].name}`);

  let text = out.join('\n');
  for (const [name, raw] of Object.entries(placeholders)) {
    const value = String(raw ?? '').replace(/'/g, "''");
    text = text.split(`\${${name}}`).join(value);
  }
  const leftover = /\$\{([A-Za-z0-9_]+)\}/.exec(text);
  if (leftover) throw new Error(`补丁模板里有未提供的占位符：\${${leftover[1]}}`);
  return text;
}

/** 生成物开头的那段说明（让用户一眼看出这是生成物、怎么重生成）。 */
function generatedHeader({ profile, blocks, modules }) {
  const active = blocks.length ? blocks.join(', ') : '（无）';
  const switches = Object.entries(modules)
    .filter(([key]) => !key.startsWith('$'))
    .map(([key, value]) => `${key}=${value ? 'on' : 'off'}`)
    .join(' ');
  return [
    '# =============================================================================',
    '# ⚠️ 这个文件是生成物，不是模板：',
    '#     模板 = config/profile/companion.patch.template.yml（入库，可提 PR）',
    '#     生成 = 由 `npm run setup` 渲染；内容有变化时旧文件备份为 .yml.bak-<时间戳>',
    `#     生成时间 ${new Date().toISOString()}`,
    `#     profile = ${profile}；启用的可选块 = ${active}`,
    `#     模块开关（config/suite.json）：${switches}`,
    '# =============================================================================',
    '',
  ].join('\n');
}

/* ────────────────────────── 小工具 ────────────────────────── */

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function readPluginManifest(directory) {
  const file = path.join(directory, 'package.json');
  if (!fs.existsSync(file)) return null;
  return readJsonSafe(file);
}

/** 插件声明的入口文件是否存在（bundle 包必须能加载 `main`/`exports` 才会被挂上）。 */
function pluginEntry(manifest, directory) {
  if (!manifest) return { declared: '', exists: false };
  const mainField = manifest.exports?.['.'];
  const declared = typeof mainField === 'string'
    ? mainField
    : (mainField?.default || mainField?.import || manifest.main || '');
  if (!declared) return { declared: '', exists: false };
  return { declared, exists: fs.existsSync(path.join(directory, declared)) };
}

/** 把包名加进 profile 的 `dsh.profile.bundles`（bundle 包只有被列进去才会加载它的 cordis.patch.yml）。 */
function registerBundle(profilePackageFile, packageName) {
  const pkg = readJsonSafe(profilePackageFile);
  if (!pkg) return { ok: false, error: `profile 的 package.json 解析失败：${profilePackageFile}` };
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  if (bundles.includes(packageName)) return { ok: true, changed: false };
  bundles.push(packageName);
  pkg.dsh.profile.bundles = bundles;
  const tmp = `${profilePackageFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, profilePackageFile);
  return { ok: true, changed: true };
}

/** 人格文件：从模板生成，但换掉「模板」这层标题，免得用户以为要用模板当正文。 */
function personaFromExample(exampleText) {
  const lines = exampleText.split(/\r?\n/);
  const firstSection = lines.findIndex((line) => /^##\s+/.test(line));
  const body = (firstSection === -1 ? [] : lines.slice(firstSection)).join('\n').trimEnd();
  return [
    '# 人格（本机配置，不入库）',
    '',
    '> 本文件由 `npm run setup` 从 `config/persona.example.md` 生成，此后归你所有：',
    '> setup 不会再覆盖它。改完重启 `npm run start` 生效。',
    '> 下面只是可以照抄的起点 —— 名字、关系、性格、说话风格都按你自己的偏好写。',
    '',
    body,
    '',
  ].join('\n');
}

function firstExisting(...files) {
  return files.find((file) => file && fs.existsSync(file)) || '';
}

/* ────────────────────────── 主流程 ────────────────────────── */

export async function runSetup(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const reporter = makeReporter(opts.json);
  const say = reporter.say;

  if (opts.help) {
    say('用法：node scripts/setup.mjs [--dry-run] [--check] [--force] [--json]');
    return 0;
  }

  const started = Date.now();
  const actions = [];
  const planActions = (action) => { actions.push(action); };

  say('DSH Companion — setup');
  say(`  套件根：${SUITE_ROOT}`);
  if (opts.check) say('  模式：--check（只读）');
  else if (opts.dryRun) say('  模式：--dry-run（不落盘）');
  else if (opts.force) say('  模式：--force（重渲染生成物、重跑安装）');

  /* ── 1. 前置条件 ───────────────────────────────────────────── */
  reporter.heading('1. 前置条件');

  let hardFailure = false;

  const nodeVersion = process.versions.node;
  if (compareVersions(nodeVersion, MIN_NODE) < 0) {
    hardFailure = true;
    reportStep(reporter, {
      id: 'node', title: 'Node.js 版本', status: 'fail',
      detail: `当前 ${nodeVersion}，需要 >= ${MIN_NODE}（记忆与运行时直接用 node:sqlite）`,
    });
  } else {
    reportStep(reporter, { id: 'node', title: 'Node.js 版本', status: 'ok', detail: `${nodeVersion}` });
  }

  let loaded;
  try {
    loaded = loadConfig();
    reportStep(reporter, {
      id: 'config', title: '套件配置', status: 'ok',
      detail: `来源：${loaded.sources.map((source) => path.relative(SUITE_ROOT, source) || source).join(' → ')}`,
    });
  } catch (err) {
    hardFailure = true;
    loaded = { config: SAFE_DEFAULTS, dataPaths: dataPaths(path.join(SUITE_ROOT, 'data')), sources: [] };
    reportStep(reporter, { id: 'config', title: '套件配置', status: 'fail', detail: err.message });
  }

  const config = loaded.config;
  const paths = loaded.dataPaths;
  const modules = enabledModules(config);
  const profileName = config.dsh?.profile || 'companion';
  const dshHome = paths.home;

  const host = resolveHost(config.dsh || {});
  const launcher = describeLauncher(host);
  const compatibility = checkCompatibility(host.version);

  if (!host.found) {
    hardFailure = true;
    reportStep(reporter, {
      id: 'host', title: 'DSH 宿主', status: 'fail',
      detail: '未检测到宿主。请安装 DeepSeek Harness 桌面版，或在 config/suite.json 里写 dsh.executable / dsh.moduleRoot',
    });
    if (host.candidates?.length) {
      say('    已尝试过：');
      for (const candidate of host.candidates) say(`      - ${candidate}`);
    }
  } else if (!launcher.ready) {
    hardFailure = true;
    reportStep(reporter, { id: 'host', title: 'DSH 宿主', status: 'fail', detail: launcher.reason });
  } else {
    reportStep(reporter, {
      id: 'host', title: 'DSH 宿主', status: 'ok',
      detail: `${host.executable || '(无桌面可执行文件，改用 node)'} · 版本 ${host.version || '未知'} · 启动方式 ${launcher.launcher}`,
    });
    reportStep(reporter, {
      id: 'host-compat', title: '宿主兼容性', status: compatibility.ok ? (compatibility.level === 'newer' ? 'warn' : 'ok') : 'warn',
      detail: compatibility.message,
    });
    if (launcher.launcher === 'node') {
      reportStep(reporter, { id: 'host-launcher', title: '启动方式回退', status: 'warn', detail: launcher.reason });
    }
  }

  if (hardFailure) {
    reporter.heading('前置条件不满足，未做任何改动。');
    finish(opts, reporter, { ok: false, actions, config, paths, profileName, started, hardFailure: true });
    return 1;
  }

  /* ── 2. 数据目录 ───────────────────────────────────────────── */
  reporter.heading('2. 数据目录');
  const outsideSuite = !paths.root.toLowerCase().startsWith(SUITE_ROOT.toLowerCase());
  if (outsideSuite) {
    reportStep(reporter, {
      id: 'data-outside', title: '数据目录在套件目录之外', status: 'warn',
      detail: `${paths.root}（由 config/suite.json 的 dataDir 指定；setup 只会写这里与套件内的 config/）`,
    });
  }
  for (const [key, dir] of Object.entries(paths)) {
    if (key === 'root') continue;
    const exists = fs.existsSync(dir);
    if (exists) {
      reportStep(reporter, { id: `dir:${key}`, title: `目录 ${path.relative(paths.root, dir) || '.'}`, status: 'skip', detail: '已存在' });
      continue;
    }
    planActions({ kind: 'mkdir', target: dir });
    if (!opts.dryRun) fs.mkdirSync(dir, { recursive: true });
    reportStep(reporter, {
      id: `dir:${key}`, title: `目录 ${path.relative(paths.root, dir) || '.'}`,
      status: opts.dryRun ? 'planned' : 'ok', detail: opts.dryRun ? '将创建' : '已创建',
    });
  }

  /* ── 3. 本机配置模板 ───────────────────────────────────────── */
  reporter.heading('3. 本机配置（存在的文件一律不覆盖）');

  if (fs.existsSync(SUITE_PATHS.configFile)) {
    reportStep(reporter, { id: 'suite-config', title: 'config/suite.json', status: 'skip', detail: '已存在，保持原样' });
  } else {
    planActions({ kind: 'write', target: SUITE_PATHS.configFile });
    if (!opts.dryRun) {
      const example = readJsonSafe(SUITE_PATHS.configExample);
      if (!example) throw new Error(`config/suite.example.json 不是合法 JSON：${SUITE_PATHS.configExample}`);
      // 把刚探测到的宿主位置写进**新生成**的配置里，省掉用户手填；已存在的配置绝不改。
      example.dsh = example.dsh || {};
      if (!example.dsh.executable) example.dsh.executable = host.executable || '';
      if (!example.dsh.moduleRoot) example.dsh.moduleRoot = host.moduleRoot || '';
      if (!example.dsh.profile) example.dsh.profile = profileName;
      fs.mkdirSync(path.dirname(SUITE_PATHS.configFile), { recursive: true });
      fs.writeFileSync(SUITE_PATHS.configFile, `${JSON.stringify(example, null, 2)}\n`, 'utf8');
    }
    reportStep(reporter, {
      id: 'suite-config', title: 'config/suite.json',
      status: opts.dryRun ? 'planned' : 'ok',
      detail: opts.dryRun ? '将从 config/suite.example.json 生成' : '已从 config/suite.example.json 生成（含探测到的宿主位置）',
    });
  }

  const personaFile = path.join(SUITE_PATHS.configDir, 'persona.md');
  if (fs.existsSync(personaFile)) {
    reportStep(reporter, { id: 'persona', title: 'config/persona.md', status: 'skip', detail: '已存在，保持原样' });
  } else if (!fs.existsSync(SUITE_PATHS.personaExample)) {
    reportStep(reporter, { id: 'persona', title: 'config/persona.md', status: 'warn', detail: `缺少模板 ${SUITE_PATHS.personaExample}` });
  } else {
    planActions({ kind: 'write', target: personaFile });
    if (!opts.dryRun) {
      fs.writeFileSync(personaFile, personaFromExample(fs.readFileSync(SUITE_PATHS.personaExample, 'utf8')), 'utf8');
    }
    reportStep(reporter, {
      id: 'persona', title: 'config/persona.md',
      status: opts.dryRun ? 'planned' : 'ok',
      detail: opts.dryRun ? '将从 config/persona.example.md 生成' : '已从 config/persona.example.md 生成，之后归你所有',
    });
  }

  /* ── 4. profile ───────────────────────────────────────────── */
  reporter.heading(`4. DSH profile（${profileName}）`);
  say(`  DSH_HOME = ${dshHome}`);

  if (profileExists(dshHome, profileName)) {
    reportStep(reporter, {
      id: 'profile', title: `profile “${profileName}”`, status: 'skip',
      detail: `已存在，保持原样：${profileDir(dshHome, profileName)}`,
    });
  } else if (opts.dryRun) {
    planActions({ kind: 'profile', profile: profileName });
    reportStep(reporter, {
      id: 'profile', title: `profile “${profileName}”`, status: 'planned',
      detail: '将用 --profile … --from-default-profile web 离线创建',
    });
  } else {
    const created = createProfile({ host, dshHome, profile: profileName, template: 'web', launcher });
    planActions({ kind: 'profile', profile: profileName, ok: created.ok });
    reportStep(reporter, {
      id: 'profile', title: `profile “${profileName}”`,
      status: created.ok ? 'ok' : 'fail',
      detail: created.ok ? created.message : created.message,
    });
    if (!created.ok) {
      reporter.heading('profile 创建失败，后面的步骤跳过。');
      finish(opts, reporter, { ok: false, actions, config, paths, profileName, started });
      return 1;
    }
  }

  /* ── 5. 模块安装 ───────────────────────────────────────────── */
  reporter.heading('5. 模块（只处理 config/suite.json 里打开的那些）');
  const activeBlocks = new Set();
  const moduleResults = [];

  for (const [key, spec] of Object.entries(MODULE_SPECS)) {
    const wanted = modules[key] === true;
    if (!wanted) {
      reportStep(reporter, { id: `module:${key}`, title: spec.title, status: 'skip', detail: 'config/suite.json 里未启用' });
      moduleResults.push({ key, status: 'disabled' });
      continue;
    }

    if (spec.kind === 'core') {
      const missing = spec.directories.filter((dir) => !fs.existsSync(path.join(SUITE_ROOT, dir)));
      const ok = missing.length === 0;
      reportStep(reporter, {
        id: `module:${key}`, title: spec.title, status: ok ? 'ok' : 'fail',
        detail: ok ? '成套存在（由 companion-foundation 以兄弟相对路径加载）' : `缺少目录：${missing.join('、')}`,
      });
      if (!ok) {
        reporter.heading('核心模块不完整，无法继续。');
        finish(opts, reporter, { ok: false, actions, config, paths, profileName, started });
        return 1;
      }
      moduleResults.push({ key, status: 'ok' });
      continue;
    }

    if (spec.kind === 'external') {
      reportStep(reporter, {
        id: `module:${key}`, title: spec.title, status: 'skip',
        detail: spec.note,
      });
      say('    安装方式（本套件不代做）：');
      for (const line of spec.instructions) say(`      · ${line}`);
      moduleResults.push({ key, status: 'external', instructions: spec.instructions });
      continue;
    }

    const directory = path.join(SUITE_ROOT, spec.directory);
    if (!fs.existsSync(directory)) {
      reportStep(reporter, {
        id: `module:${key}`, title: spec.title, status: 'fail',
        detail: `目录不存在：${spec.directory}（发布树不完整？）`,
      });
      moduleResults.push({ key, status: 'fail', reason: 'missing-directory' });
      continue;
    }

    if (spec.kind === 'file') {
      for (const block of spec.patchBlocks || []) activeBlocks.add(block);
      reportStep(reporter, {
        id: `module:${key}`, title: spec.title, status: 'ok',
        detail: `补丁里会挂载 file://${spec.directory}（不进 profile 依赖）`,
      });
      moduleResults.push({ key, status: 'ok' });
      continue;
    }

    // kind === 'bundle'：装进 profile 依赖，并登记到 dsh.profile.bundles
    const manifest = readPluginManifest(directory);
    if (!manifest?.name) {
      reportStep(reporter, { id: `module:${key}`, title: spec.title, status: 'fail', detail: '插件的 package.json 缺失或没有 name 字段' });
      moduleResults.push({ key, status: 'fail', reason: 'bad-manifest' });
      continue;
    }
    const entry = pluginEntry(manifest, directory);
    if (opts.dryRun) {
      planActions({ kind: 'plugin-add', name: manifest.name, directory });
      for (const block of spec.patchBlocks || []) activeBlocks.add(block);
      reportStep(reporter, {
        id: `module:${key}`, title: spec.title, status: 'planned',
        detail: `将 dsh plugin add ${manifest.name}${entry.exists ? '' : '（注意：入口文件尚未构建）'}`,
      });
      moduleResults.push({ key, status: 'planned' });
      continue;
    }

    const installed = addPlugin({ host, dshHome, profile: profileName, directory, launcher });
    if (!installed.ok) {
      reportStep(reporter, {
        id: `module:${key}`, title: spec.title, status: 'fail',
        detail: `dsh plugin add 失败（退出码 ${installed.code}）：${firstLines(installed.stderr || installed.stdout, 3)}`,
      });
      moduleResults.push({ key, status: 'fail', reason: 'plugin-add' });
      continue;
    }
    const registered = registerBundle(path.join(profileDir(dshHome, profileName), 'package.json'), manifest.name);
    if (!registered.ok) {
      reportStep(reporter, { id: `module:${key}`, title: spec.title, status: 'fail', detail: registered.error });
      moduleResults.push({ key, status: 'fail', reason: 'register-bundle' });
      continue;
    }
    for (const block of spec.patchBlocks || []) activeBlocks.add(block);
    reportStep(reporter, {
      id: `module:${key}`, title: spec.title,
      status: entry.exists ? 'ok' : 'warn',
      detail: `已安装 ${manifest.name}${registered.changed ? '，已登记到 dsh.profile.bundles' : '（bundle 已登记）'}`
        + (entry.exists ? '' : `；但入口 ${entry.declared || '(未声明)'} 不存在 —— 先跑 npm run build`),
    });
    moduleResults.push({ key, status: entry.exists ? 'ok' : 'warn' });
  }

  /* ── 6. 渲染补丁 ───────────────────────────────────────────── */
  reporter.heading('6. profile 叠加补丁');
  let patchResult = { written: false, path: PATCH_GENERATED, changed: false };

  if (!fs.existsSync(PATCH_TEMPLATE)) {
    reportStep(reporter, { id: 'patch', title: 'companion.patch.yml', status: 'fail', detail: `缺少模板 ${PATCH_TEMPLATE}` });
    finish(opts, reporter, { ok: false, actions, config, paths, profileName, started, moduleResults });
    return 1;
  }

  const placeholderMap = buildPlaceholders({ config, paths, profileName });
  const rendered = generatedHeader({ profile: profileName, blocks: [...activeBlocks], modules })
    + renderPatchTemplate(fs.readFileSync(PATCH_TEMPLATE, 'utf8'), { placeholders: placeholderMap, activeBlocks });

  const previous = fs.existsSync(PATCH_GENERATED) ? fs.readFileSync(PATCH_GENERATED, 'utf8') : '';
  const changed = normalizeNewlines(previous) !== normalizeNewlines(rendered);

  if (!changed && !opts.force) {
    reportStep(reporter, { id: 'patch', title: 'companion.patch.yml', status: 'skip', detail: '内容无变化，未改动' });
  } else if (opts.dryRun) {
    planActions({ kind: 'write', target: PATCH_GENERATED });
    reportStep(reporter, {
      id: 'patch', title: 'companion.patch.yml', status: 'planned',
      detail: `将写入 ${path.relative(SUITE_ROOT, PATCH_GENERATED)}（可选块：${[...activeBlocks].join(', ') || '无'}）`,
    });
    patchResult = { written: false, path: PATCH_GENERATED, changed: true };
  } else {
    fs.mkdirSync(path.dirname(PATCH_GENERATED), { recursive: true });
    let backup = '';
    if (previous && changed) {
      backup = `${PATCH_GENERATED}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.writeFileSync(backup, previous, 'utf8');
    }
    fs.writeFileSync(PATCH_GENERATED, rendered, 'utf8');
    reportStep(reporter, {
      id: 'patch', title: 'companion.patch.yml',
      status: 'ok', detail: `已渲染 ${path.relative(SUITE_ROOT, PATCH_GENERATED)}${backup ? `（旧版本备份到 ${path.basename(backup)}）` : ''}`,
    });
    patchResult = { written: true, path: PATCH_GENERATED, changed, backup };
  }

  /* ── 7. 下一步 ─────────────────────────────────────────────── */
  reporter.heading('7. 下一步');
  const nextReal = [
    '改 config/persona.md（人格与称呼）与 config/suite.json（可选模块、外部服务地址）',
    'npm run doctor    # 只读检查，确认 profile 能合成、入口文件都在',
    'npm run start     # 启动本套件自己的 DSH 环境，URL 与日志路径都会打印',
    'npm run verify    # 发布前的离线检查与测试',
  ];
  nextReal.forEach((line, index) => say(`  ${index + 1}. ${line}`));
  if (moduleResults.some((item) => item.status === 'warn' && item.reason !== undefined)) {
    say('  （有模块入口还没构建：先按 AGENTS.md 跑 npm ci && npm run build）');
  }

  finish(opts, reporter, {
    ok: reporter.steps.every((step) => step.status !== 'fail'),
    actions, config, paths, profileName, started, moduleResults,
    patch: patchResult, activeBlocks: [...activeBlocks], dryRun: opts.dryRun,
  });
  return reporter.steps.some((step) => step.status === 'fail') ? 1 : 0;
}

function normalizeNewlines(text) {
  return String(text).replace(/\r\n/g, '\n');
}

function firstLines(text, count) {
  return String(text || '').split(/\r?\n/).filter(Boolean).slice(-count).join(' | ');
}

function buildPlaceholders({ config, paths, profileName }) {
  const slash = (value) => String(value).replace(/\\/g, '/').replace(/\/+$/, '');
  const onebot = config.services?.onebot || {};
  const health = config.services?.health || {};
  const selfId = Number(onebot.selfId);
  return {
    SUITE_ROOT: slash(SUITE_ROOT),
    DSH_HOME: slash(paths.home),
    WORKSPACE_DIR: slash(paths.workspace),
    GROUP_WORKSPACE_DIR: slash(paths.groupWorkspace),
    DESKTOP_DATA_DIR: slash(paths.desktopData),
    PROFILE: profileName,
    ONEBOT_URL: onebot.url || '',
    ONEBOT_ACCESS_TOKEN: onebot.accessToken || '',
    ONEBOT_SELF_ID: Number.isFinite(selfId) && selfId > 0 ? String(selfId) : '0',
    HEALTH_SIDECAR_URL: health.sidecarUrl || '',
  };
}

function finish(opts, reporter, payload) {
  const ok = Boolean(payload.ok);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      command: 'setup',
      ok,
      dryRun: Boolean(payload.dryRun),
      suiteRoot: SUITE_ROOT,
      dataRoot: payload.paths?.root,
      dshHome: payload.paths?.home,
      profile: payload.profileName,
      patchFile: PATCH_GENERATED,
      actions: payload.actions || [],
      modules: payload.moduleResults || [],
      activeBlocks: payload.activeBlocks || [],
      patch: payload.patch || null,
      steps: reporter.steps,
      durationMs: Date.now() - payload.started,
    }, null, 2)}\n`);
  } else {
    reporter.say('');
    reporter.say(ok ? 'setup 完成。' : 'setup 结束，但有失败项，见上面的 [失败]。');
  }
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
    const code = await runSetup();
    process.exitCode = code;
  } catch (err) {
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ command: 'setup', ok: false, error: err.message }, null, 2)}\n`);
    }
    process.stderr.write(`setup 失败：${err.message}\n`);
    process.exitCode = 1;
  }
}

export default { runSetup, renderPatchTemplate, MODULE_SPECS, PATCH_TEMPLATE, PATCH_GENERATED };
