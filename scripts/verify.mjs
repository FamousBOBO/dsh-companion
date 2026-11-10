#!/usr/bin/env node
/**
 * Release verification.
 *
 * Three independent groups, matching what docs/01 and CI rely on:
 *   unit     per-module offline tests (`node --test` or the package's test script)
 *   static   packaging metadata, source-tree hygiene, and leak scanning
 *   compose  host composition check (`dsh --dump-config`)
 *
 * Honesty rules baked in here:
 *   - a module with no tests is reported as "no tests", never as passing;
 *   - `compose` without a DSH host prints SKIPPED and does not fail the run;
 *   - any real failure exits 1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SUITE_ROOT, SUITE_PATHS } from '../tools/lib/paths.mjs';
import { loadConfig, enabledModules } from '../tools/lib/config.mjs';
import { dshEnv, dumpFileUrls, patchFileUrls } from '../tools/lib/dsh.mjs';
import { activePatchBlocks, renderPatchTemplate, PATCH_TEMPLATE } from './setup.mjs';

const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith('--only='));
const groups = onlyArg
  ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean)
  : ['unit', 'static', 'compose'];
const want = (g) => groups.includes(g);
const isWindows = process.platform === 'win32';

/**
 * Invoke npm without a shell. When this script runs under `npm run`, npm_execpath points at
 * npm's own JS entry, so we can spawn `node <npm-cli.js> …` and avoid both the shell (and its
 * argument-concatenation warning) and any quoting questions. Falls back to the shell only when
 * the script is invoked directly outside npm.
 */
const NPM_EXECPATH = process.env.npm_execpath;
/** A leaked `npm_config_workspaces` collides with our explicit `--workspace`. Strip it. */
function cleanEnv() {
  const env = { ...process.env, CI: '1' };
  for (const key of Object.keys(env)) {
    if (/^npm_config_workspaces?$/i.test(key)) delete env[key];
  }
  return env;
}
function npmSpawn(args, options) {
  if (NPM_EXECPATH && /npm-cli\.js$/.test(NPM_EXECPATH)) {
    return spawnSync(process.execPath, [NPM_EXECPATH, ...args], { ...options, shell: false });
  }
  return spawnSync(isWindows ? 'npm.cmd' : 'npm', args, { ...options, shell: isWindows });
}

const summary = { unit: {}, static: {}, compose: {} };
let failures = 0;
let skips = 0;

function section(title) {
  console.log(`\n═══ ${title} ═══`);
}

function record(group, name, status, detail = '') {
  summary[group][name] = { status, detail };
  const icon = status === 'ok' ? '✓' : status === 'skipped' ? '○' : status === 'no-tests' ? '·' : '✗';
  console.log(`${icon} ${name}${detail ? ' — ' + detail : ''}`);
  if (status === 'failed') failures += 1;
  if (status === 'skipped' || status === 'no-tests') skips += 1;
}

function readPkg(dir) {
  const p = path.join(dir, 'package.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function listModules() {
  if (!fs.existsSync(SUITE_PATHS.plugins)) return [];
  return fs
    .readdirSync(SUITE_PATHS.plugins, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(SUITE_PATHS.plugins, e.name);
      return { dirName: e.name, dir, pkg: readPkg(dir) };
    });
}

const modules = listModules();

/* ─────────────────────────── unit ─────────────────────────── */
function runUnit() {
  section('unit — 逐模块离线测试');
  for (const m of modules) {
    const label = m.pkg?.name || m.dirName;
    const testScript = m.pkg?.scripts?.test;
    const hasTestDirs =
      fs.existsSync(path.join(m.dir, 'test')) || fs.existsSync(path.join(m.dir, 'tests'));
    const hasTestFiles = fs
      .readdirSync(m.dir, { withFileTypes: true })
      .some((e) => e.isFile() && /\.test\.(mjs|cjs|js|ts)$/.test(e.name));

    if (!testScript && !hasTestDirs && !hasTestFiles) {
      record('unit', label, 'no-tests', '该模块没有测试');
      continue;
    }

    // Run through npm from the suite root: invoking npm inside a workspace directory makes
    // npm fight over --workspace/--no-workspaces. `--workspace` needs a resolvable name, so
    // a package without one falls back to running the module's tests directly.
    let res;
    if (testScript && m.pkg?.name) {
      res = npmSpawn(['run', 'test', `--workspace=${m.pkg.name}`], {
        cwd: SUITE_ROOT,
        stdio: 'pipe',
        encoding: 'utf8',
        env: cleanEnv(),
        timeout: 20 * 60 * 1000,
      });
    } else {
      res = spawnSync(process.execPath, ['--test'], {
        cwd: m.dir,
        stdio: 'pipe',
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
        timeout: 20 * 60 * 1000,
      });
    }

    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (res.status === 0) {
      const passMatch = out.match(/# pass (\d+)/);
      record('unit', label, 'ok', passMatch ? `${passMatch[1]} 个测试通过` : '通过');
    } else {
      // Name the failing tests instead of only echoing the tail: a 1200-test suite can fail on
      // one assertion many screens above the end of its output, which makes a red run useless
      // for diagnosis. Fall back to the tail when the reporter printed no test names.
      const named = out
        .split('\n')
        .filter((l) => /^\s*(?:✖|not ok)\s/.test(l))
        .map((l) => l.trim())
        .slice(0, 8);
      const tail = out.trim().split('\n').slice(-12).join('\n      ');
      const detail = named.length
        ? `exit ${res.status}\n      失败用例：\n      ${named.join('\n      ')}`
        : `exit ${res.status}\n      ${tail}`;
      record('unit', label, 'failed', detail);
    }
  }
}

/* ────────────────────────── static ────────────────────────── */
const LEAK_RULES = [
  ['persona-三月七', /三月七|小七|sanyueqi/],
  ['author-path', /[A-Za-z]:[\\/](?:Users[\\/][A-Za-z0-9_.-]+|Bot[\\/]dsh-companion)/i],
  ['author-name', /FamousBOBO|bobo-march7/i],
  ['legacy-persona-id', /\bmarch7\b/],
];

/**
 * The one documented exception for `author-name`: the canonical clone URL.
 *
 * `README.md` has to tell people where to clone from, and that URL necessarily carries the
 * account name — it is the public repository address, not an author identity leaking into the
 * tree. Only the exact `https://github.com/<owner>/<repo>` form is stripped, and only for that
 * rule, so a stray path or prose mention still fails the scan.
 */
const AUTHOR_NAME_ALLOWED = [
  ['author-name', /https:\/\/github\.com\/FamousBOBO\/dsh-companion(?:\.git)?/gi],
];

function redactAllowed(text, rule) {
  let out = text;
  for (const [name, re] of AUTHOR_NAME_ALLOWED) {
    if (name !== rule) continue;
    out = out.replace(re, '<canonical-clone-url>');
  }
  return out;
}

// Secret-shaped strings legitimately appear in fixtures. These rules therefore skip
// test trees; the leak rules above never do.
const SECRET_RULES = [
  ['openai-key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['bearer', /Bearer\s+[A-Za-z0-9._-]{24,}/],
];

/* ── author-name exception: the repository's own published clone URL ──
 *
 * The install docs must show a command the user can paste as-is:
 *
 *     git clone https://github.com/FamousBOBO/dsh-companion.git
 *
 * The repository's own public address is not a leak — it is the entry point we publish. The
 * `author-name` rule keeps its full force everywhere else: the author's name standing on its own
 * ("作者 FamousBOBO"), in another path (`github.com/FamousBOBO/other`), or as a local checkout
 * (`D:\Bot\dsh-companion` → `author-path`) is still reported. Only the exact clone address is
 * masked, with an optional scheme, an optional `www.`, an optional `.git`, and a trailing
 * boundary that refuses to extend the match into `-suffix` (`dsh-companion-fork` stays flagged)
 * and a leading boundary that refuses to start mid-token (`evil.example/github.com/FamousBOBO/…`
 * and `http://FamousBOBO@github.com/…` stay flagged, because there the name appears as an
 * unrelated host prefix or as userinfo — neither is our published address).
 *
 * Deliberately NOT exempted, because widening this is how a leak rule quietly dies:
 *   - the bare author name, in any casing, anywhere else;
 *   - the SSH form (`git@github.com:FamousBOBO/...`) — it does not appear in the tree, and if it
 *     ever does, a human should decide rather than inherit an exemption for free;
 *   - markdown `// leak-scan-allow:` markers, which `allowedIn()` refuses for .md on purpose.
 * The masking is length-preserving so reported line numbers stay exact.
 */
const PUBLIC_CLONE_URL =
  /(?<![\w.@/-])(?:https?:\/\/)?(?:www\.)?github\.com\/FamousBOBO\/dsh-companion(?:\.git)?(?![\w-])/gi;
const CLONE_URL_MASK = 'x';

/**
 * Mask the published clone URL. Length-preserving: every character stays in place, so a line
 * number computed from the masked text is the same line number a reader would see.
 * The mask is `x` — a character that belongs to no leak rule and to no ASCII word boundary,
 * so a masked span can never `\b`-join with its neighbours into a new match.
 */
function maskPublicCloneUrl(text) {
  return text.replace(PUBLIC_CLONE_URL, (m) => CLONE_URL_MASK.repeat(m.length));
}

/**
 * The text a rule should actually match against. Only `author-name` gets the masked copy; every
 * other rule (and the reported line count) is unaffected because the mask is length-preserving.
 */
function scannableFor(ruleName, text) {
  if (ruleName !== 'author-name') return text;
  return maskPublicCloneUrl(text);
}

/** Files whose own text is the rule table — scanning them is a guaranteed false positive. */
const SCAN_SELF_EXCLUDE = new Set(['scripts/verify.mjs']);

/**
 * Local, generated, git-ignored files. They legitimately contain this machine's absolute
 * paths (they are produced by substituting the real suite root), and they are never
 * published, so scanning them would only produce noise.
 */
const LOCAL_ONLY = new Set([
  'config/suite.json',
  'config/persona.md',
  'config/profile/companion.patch.yml',
]);

/**
 * Audited exception mechanism. A file that must contain a forbidden literal can declare it
 * on its own comment line:
 *
 *     // leak-scan-allow: persona-三月七  (regression guard: asserts the old name is gone)
 *
 * Three deliberate limits:
 *   - the marker must be a whole comment line, not prose inside a sentence;
 *   - markdown files can never grant an exemption, so documenting this mechanism cannot
 *     silently whitelist the documentation itself;
 *   - it covers exactly one rule name, in one file.
 */
function allowedIn(text, rule, ext) {
  if (ext === '.md' || ext === '.mdx') return false;
  const escaped = rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The trailing guard must not be `\b`: rule names can end in CJK (persona-三月七), where
  // `\b` never matches, which silently disabled the exemption. `(?![\w-])` rejects only a
  // continuation into ASCII word characters, which is what we actually want.
  return new RegExp(
    `^[ \\t]*(?://|#|/\\*|\\*)[ \\t]*leak-scan-allow:[^\\n]*${escaped}(?![\\w-])`,
    'm',
  ).test(text);
}

/** Test trees, where placeholder credentials are expected and required. */
const TEST_TREE = /(^|\/)(test|tests|fixtures)(\/|$)|\.test\.(mjs|cjs|js|ts)$/;

const SCAN_EXT = new Set([
  '.mjs', '.js', '.cjs', '.ts', '.tsx', '.json', '.jsonl', '.yml', '.yaml', '.md',
  '.css', '.html', '.svg', '.py', '.ps1', '.sh', '.txt', '.toml', '.example',
]);

function walk(dir, acc = []) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'data') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

/**
 * The set of files that would actually be published: everything git tracks plus everything git
 * does not ignore. Using git here is what makes the artifact and leak checks meaningful — a local
 * `npm run build` output is git-ignored, so scanning the working directory would report phantom
 * failures for files that are never committed. Falls back to a directory walk outside a git
 * checkout (a tarball, for instance).
 */
function publishedFiles() {
  const res = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: SUITE_ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (res.status !== 0 || typeof res.stdout !== 'string') return null;
  return res.stdout
    .split('\0')
    .filter(Boolean)
    .map((rel) => path.join(SUITE_ROOT, rel));
}

function runStatic() {
  section('static — 包元数据与源码树卫生');
  const tracked = publishedFiles();
  const files = tracked || walk(SUITE_ROOT);
  console.log(
    tracked
      ? `· 扫描范围：git 跟踪 + 未忽略的文件（${files.length} 个）——构建产物与本地数据不在其内`
      : `· 扫描范围：目录遍历（${files.length} 个）——不在 git 检出内，无法区分忽略文件`,
  );

  // 1. packaging metadata
  for (const m of modules) {
    const label = m.pkg?.name || m.dirName;
    if (!m.pkg) {
      record('static', `${label}`, 'failed', '缺少 package.json');
      continue;
    }
    const problems = [];
    if (!m.pkg.name) problems.push('缺 name');
    if (/^@local\//.test(m.pkg.name || '')) problems.push('包名仍是 @local/* 占位');
    if (!m.pkg.version) problems.push('缺 version');
    if (!m.pkg.license) problems.push('缺 license');
    const mainRef = String(m.pkg.main || m.pkg.exports?.['.'] || '');
    if (/build[\\/]lib-[a-z0-9-]*\d{8}/i.test(mainRef) || /\d{8}/.test(mainRef)) {
      problems.push(`入口指向带日期目录: ${mainRef}`);
    }
    if (problems.length) record('static', `${label} (metadata)`, 'failed', problems.join('; '));
    else record('static', `${label} (metadata)`, 'ok');
  }

  // 1b. Regressions found by the 2026-11-05 new-environment validation. Both shipped broken and
  //     both are pure functions, so they are asserted here instead of only being described: an
  //     install path containing a space broke doctor's URL parsing, and the launcher not passing
  //     the host module root left the companion preset unable to start at all.
  {
    const label = '含空格的 file URL 不被截断';
    const sample = '      name: file://C:/Users/u/My Docs/DSH clean 20261105/plugins/x/index.mjs';
    const urls = dumpFileUrls(sample);
    const ok = urls.length === 1 && urls[0].includes('DSH clean 20261105') && urls[0].endsWith('index.mjs');
    if (ok) record('static', label, 'ok');
    else record('static', label, 'failed', `解析出 ${JSON.stringify(urls)}`);
  }
  {
    const label = '宿主子进程拿到 DSH_COMPANION_MODULE_ROOT';
    const env = dshEnv({ home: 'H', moduleRoot: 'M' });
    const ok = env.DSH_COMPANION_MODULE_ROOT === 'M' && env.DSH_HOME === 'H';
    if (ok) record('static', label, 'ok');
    else record('static', label, 'failed', `env=${JSON.stringify({ moduleRoot: env.DSH_COMPANION_MODULE_ROOT ?? null, home: env.DSH_HOME ?? null })}`);
  }
  {
    // The existence check must read our own quoted patch file: a YAML rendering of the composed
    // tree folds long scalars, so a spaced path has no reliable boundary there.
    const label = '补丁文件里的含空格路径被完整读出';
    const sample = "            name: 'file://D:/v/DSH clean 验证 20261105/plugins/companion-foundation/index.mjs'";
    const urls = patchFileUrls(sample);
    const ok = urls.length === 1 && urls[0].endsWith('/plugins/companion-foundation/index.mjs') && urls[0].includes('DSH clean 验证 20261105');
    if (ok) record('static', label, 'ok');
    else record('static', label, 'failed', `解析出 ${JSON.stringify(urls)}`);
  }

  // 1c. The author-name exception must stay exactly as narrow as it claims. These three checks
  //     exist so the exception cannot be widened by accident: they fail the run the moment the
  //     published clone address stops being exempt, or the moment a bare author name or a local
  //     checkout path stops being a leak.
  {
    const label = 'author-name 例外仅覆盖本仓库克隆地址';
    const samples = [
      'git clone https://github.com/FamousBOBO/dsh-companion.git',
      'git clone https://github.com/FamousBOBO/dsh-companion',
      'git clone github.com/FamousBOBO/dsh-companion.git',
      'git clone github.com/FamousBOBO/dsh-companion',
      'https://www.github.com/FamousBOBO/dsh-companion.git',
      'see [repo](https://github.com/FamousBOBO/dsh-companion) for details',
    ];
    const stillHits = [
      '作者 FamousBOBO',
      'maintained by famousbobo',
      'git@github.com:FamousBOBO/dsh-companion.git',
      'https://github.com/FamousBOBO/other-repo',
      'https://github.com/FamousBOBO/dsh-companion-fork',
      'https://example.com/FamousBOBO/dsh-companion',
      // Not our address: userinfo before the host, and the bare name must stay visible.
      'git clone http://FamousBOBO@github.com/FamousBOBO/dsh-companion.git',
    ];
    const missed = samples.filter((s) => scannableFor('author-name', s).match(/FamousBOBO|bobo-march7/i));
    const leaked = stillHits.filter((s) => !scannableFor('author-name', s).match(/FamousBOBO|bobo-march7/i));
    if (!missed.length && !leaked.length) record('static', label, 'ok');
    else {
      const why = [
        missed.length ? `克隆地址仍被误报: ${JSON.stringify(missed)}` : '',
        leaked.length ? `非克隆地址漏报: ${JSON.stringify(leaked)}` : '',
      ].filter(Boolean).join('; ');
      record('static', label, 'failed', why);
    }
  }
  {
    const label = 'author-name 仍拦截单独出现的作者名';
    const samples = ['作者 FamousBOBO', 'author: bobo-march7', 'FamousBOBO@example.com'];
    const missed = samples.filter((s) => !scannableFor('author-name', s).match(/FamousBOBO|bobo-march7/i));
    if (!missed.length) record('static', label, 'ok');
    else record('static', label, 'failed', `漏报: ${JSON.stringify(missed)}`);
  }
  {
    const label = 'author-path 不受克隆地址例外影响';
    const rule = LEAK_RULES.find(([name]) => name === 'author-path')[1];
    const samples = ['D:\\Bot\\dsh-companion\\plugins', 'C:\\Users\\bobo\\Desktop', 'D:/Bot/dsh-companion'];
    const missed = samples.filter((s) => !rule.test(scannableFor('author-path', s)));
    if (!missed.length) record('static', label, 'ok');
    else record('static', label, 'failed', `漏报: ${JSON.stringify(missed)}`);
  }

  // 1c. Prompt-layer regressions (docs/09-prompt-baseline.md). The companion preset used to mount
  //     eight host plugins whose system-prompt sections describe an agent that edits the harness
  //     itself: file/shell/jobs rules (≈1,470 chars) plus the two profile-level sections
  //     (harness-dev-context 1,146 + ui-deliverables 1,192). They are now off by default and are
  //     driven by `config/suite.json` `prompt.*`. Asserted here because a template edit that
  //     silently restores them would only show up as a fatter prompt in a live capture.
  //
  //     The template is rendered with stand-in placeholders: only the presence of rows matters
  //     here, and `renderPatchTemplate` refuses to leave any `${...}` behind.
  const PATCH_TEMPLATE_FOR_CHECK = PATCH_TEMPLATE;
  const PLACEHOLDERS_FOR_CHECK = {
    SUITE_ROOT: 'file:///suite',
    DSH_HOME: 'H',
    WORKSPACE_DIR: 'W',
    GROUP_WORKSPACE_DIR: 'G',
    DESKTOP_DATA_DIR: 'DD',
    PROFILE: 'companion',
    ONEBOT_URL: '',
    ONEBOT_ACCESS_TOKEN: '',
    ONEBOT_SELF_ID: '0',
    HEALTH_SIDECAR_URL: '',
  };
  {
    const label = '陪伴预设默认不装载开发工具';
    const blocks = activePatchBlocks({ prompt: {} }, { enabled: { core: true } });
    const rendered = renderPatchTemplate(fs.readFileSync(PATCH_TEMPLATE_FOR_CHECK, 'utf8'), {
      placeholders: PLACEHOLDERS_FOR_CHECK,
      activeBlocks: blocks,
    });
    const devRows = ['tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-skill', 'skill-filesystem', 'agent-instructions'];
    const leaked = devRows.filter((id) => new RegExp(`^\\s+- id: ${id}$`, 'm').test(rendered));
    if (leaked.length === 0) record('static', label, 'ok');
    else record('static', label, 'failed', `默认渲染里仍有：${leaked.join('、')}`);
  }
  {
    const label = '陪伴预设默认裁掉宿主两段提示';
    const blocks = activePatchBlocks({ prompt: {} }, { enabled: { core: true } });
    const rendered = renderPatchTemplate(fs.readFileSync(PATCH_TEMPLATE_FOR_CHECK, 'utf8'), {
      placeholders: PLACEHOLDERS_FOR_CHECK,
      activeBlocks: blocks,
    });
    const missing = ['harness-dev-context', 'ui-deliverables']
      .filter((id) => !new RegExp(`^- id: ${id}\\n  disabled: true$`, 'm').test(rendered));
    if (missing.length === 0) record('static', label, 'ok');
    else record('static', label, 'failed', `没有关掉：${missing.join('、')}`);
  }
  {
    const label = 'prompt.* 开关能把块加回来';
    const on = activePatchBlocks(
      { prompt: { companionDevTools: true, harnessDevContext: true, deliverableHints: true } },
      { enabled: { core: true } },
    );
    const rendered = renderPatchTemplate(fs.readFileSync(PATCH_TEMPLATE_FOR_CHECK, 'utf8'), {
      placeholders: PLACEHOLDERS_FOR_CHECK,
      activeBlocks: on,
    });
    const restored = rendered.includes('- id: tool-pwsh');
    const notTrimmed = !/- id: harness-dev-context\n  disabled: true/.test(rendered)
      && !/- id: ui-deliverables\n  disabled: true/.test(rendered);
    if (restored && notTrimmed) record('static', label, 'ok');
    else record('static', label, 'failed', `tool-pwsh 恢复=${restored}，裁剪撤销=${notTrimmed}`);
  }
  {
    // The `skill` registry row must never live inside a preset: the host already registers the
    // `skills` service globally, and a second registration marks the whole companion preset
    // broken (`agentPresets/list` reports "service skills has been registered at SkillRegistry").
    const label = '预设里不重复注册 skill 服务';
    const template = fs.readFileSync(PATCH_TEMPLATE_FOR_CHECK, 'utf8');
    const blocks = activePatchBlocks({ prompt: { companionDevTools: true } }, { enabled: { core: true } });
    const rendered = renderPatchTemplate(template, { placeholders: PLACEHOLDERS_FOR_CHECK, activeBlocks: blocks });
    if (!/^\s+- id: skill$/m.test(rendered)) record('static', label, 'ok');
    else record('static', label, 'failed', '打开 companionDevTools 后预设里出现了 - id: skill');
  }

  // 2. no build artifacts inside the tracked tree. Only real build outputs count:
  // most modules keep hand-written sources under lib/, so lib/ is NOT treated as an artifact.
  // A package that declares dsh.suite.prebuilt ships its bundle deliberately (it cannot be
  // rebuilt without a DSH source checkout), so its lib/ is allowed.
  const prebuiltDirs = new Set(
    modules.filter((m) => m.pkg?.dsh?.suite?.prebuilt === true).map((m) => `plugins/${m.dirName}/`),
  );
  const ARTIFACT = /^plugins\/(?:[^/]+\/(?:build|dist)|dsh-super-injector\/lib)\//;
  const artifacts = files
    .map((f) => path.relative(SUITE_ROOT, f).replace(/\\/g, '/'))
    .filter((rel) => ARTIFACT.test(rel))
    .filter((rel) => ![...prebuiltDirs].some((p) => rel.startsWith(p)));
  record(
    'static',
    '源码树不含构建产物',
    artifacts.length ? 'failed' : 'ok',
    artifacts.length ? `${artifacts.length} 个文件落在 build/lib/dist 下` : '',
  );

  // 3. leak scan — two passes, because fixtures may contain placeholder credentials
  //    but must never contain a real author path or the old persona name.
  const scanPass = (rules, { skipTests }) => {
    for (const [name, re] of rules) {
      const hits = [];
      for (const f of files) {
        const rel = path.relative(SUITE_ROOT, f).replace(/\\/g, '/');
        if (SCAN_SELF_EXCLUDE.has(rel) || LOCAL_ONLY.has(rel)) continue;
        if (skipTests && TEST_TREE.test(rel)) continue;
        const ext = path.extname(f).toLowerCase();
        if (ext && !SCAN_EXT.has(ext)) continue;
        let text;
        try {
          if (fs.statSync(f).size > 4 * 1024 * 1024) continue;
          text = fs.readFileSync(f, 'utf8');
        } catch {
          continue;
        }
        if (allowedIn(text, name, ext)) continue;
        // Only the author-name rule sees the masked text: the repository's own clone URL is the
        // documented install entry point, not a leak. Every other rule — and every other
        // occurrence of the author name — scans the file exactly as it is.
        const scannable = scannableFor(name, text);
        const m = re.exec(scannable);
        if (m) {
          const line = scannable.slice(0, m.index).split('\n').length;
          hits.push(`${rel}:${line}`);
        }
      }
      record('static', name, hits.length ? 'failed' : 'ok', hits.slice(0, 8).join(' '));
    }
  };
  scanPass(LEAK_RULES, { skipTests: false });
  scanPass(SECRET_RULES, { skipTests: true });

  // 4. suite config parses and core is on
  try {
    const { config, dataPaths } = loadConfig();
    const mods = enabledModules(config);
    record('static', 'config/suite.example.json 可解析', 'ok', `dataDir=${dataPaths.root}`);
    record('static', 'core 模块始终启用', mods.core ? 'ok' : 'failed');
  } catch (err) {
    record('static', 'config/suite.example.json 可解析', 'failed', err.message);
  }

  // 5. required root files
  for (const rel of ['AGENTS.md', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'config/persona.example.md']) {
    record('static', rel, fs.existsSync(path.join(SUITE_ROOT, rel)) ? 'ok' : 'failed');
  }

  // 6. Windows PowerShell 5.1 decodes a BOM-less .ps1 as ANSI, which corrupts CJK text and
  //    breaks quoting/parens. Every .ps1 we ship must carry a UTF-8 BOM.
  const ps1 = files.filter((f) => f.toLowerCase().endsWith('.ps1'));
  const bomless = ps1.filter((f) => {
    try {
      const buf = fs.readFileSync(f);
      return !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf);
    } catch {
      return false;
    }
  });
  record(
    'static',
    '.ps1 带 UTF-8 BOM（PowerShell 5.1 需要）',
    bomless.length ? 'failed' : 'ok',
    bomless.map((f) => path.relative(SUITE_ROOT, f).replace(/\\/g, '/')).slice(0, 6).join(' '),
  );

  // 7. data-root parity (TEAM-BRIEF D2): the suite CLI and the plugins must agree on where
  //    runtime data lives, otherwise the UI and the engine open two different databases.
  return checkDataRootParity();
}

async function checkDataRootParity() {
  const label = '数据目录解析一致（CLI ↔ 插件）';
  const suitePaths = path.join(SUITE_PATHS.plugins, 'companion-foundation', 'suite-paths.mjs');
  if (!fs.existsSync(suitePaths)) {
    record('static', label, 'skipped', 'companion-foundation/suite-paths.mjs 不存在');
    return;
  }
  try {
    const { dataPaths } = loadConfig();
    const mod = await import(new URL(`file://${suitePaths.replace(/\\/g, '/')}`).href);
    const resolved = mod.resolveSuitePaths ? mod.resolveSuitePaths({ env: process.env }) : null;
    const pluginRoot = resolved?.dataRoot;
    if (!pluginRoot) {
      record('static', label, 'skipped', '插件侧没有导出 resolveSuitePaths()');
      return;
    }
    const same = path.resolve(pluginRoot) === path.resolve(dataPaths.root);
    record('static', label, same ? 'ok' : 'failed', same ? path.resolve(pluginRoot) : `CLI=${dataPaths.root} 插件=${pluginRoot}`);
  } catch (err) {
    record('static', label, 'failed', err.message);
  }
}

/* ────────────────────────── compose ───────────────────────── */
function runCompose() {
  section('compose — 宿主合成检查');
  let host;
  try {
    const { config } = loadConfig();
    host = config.dsh || {};
  } catch {
    host = {};
  }
  const exe = host.executable && fs.existsSync(host.executable) ? host.executable : '';
  const cli = host.moduleRoot
    ? path.join(host.moduleRoot, '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
    : '';
  const patch = path.join(SUITE_PATHS.configDir, 'profile', 'companion.patch.yml');

  if (!exe || !cli || !fs.existsSync(cli)) {
    record('compose', 'dsh --dump-config', 'skipped', '未检测到 DSH 宿主（CI 正常现象，不算失败）');
    return;
  }
  if (!fs.existsSync(patch)) {
    record('compose', 'dsh --dump-config', 'skipped', '还没有生成 profile 补丁，先跑 npm run setup');
    return;
  }
  const res = spawnSync(exe, ['--expose-internals', cli, '--profile', host.profile || 'companion', '--patch', patch, '--dump-config'], {
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: path.join(SUITE_ROOT, 'data', 'home'),
    },
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (res.status === 0 && out.includes('- id:')) {
    const rows = (out.match(/^- id: /gm) || []).length;
    record('compose', 'dsh --dump-config', 'ok', `${rows} 个 loader 行`);
  } else {
    record('compose', 'dsh --dump-config', 'failed', `exit ${res.status}: ${out.trim().split('\n').slice(-6).join(' | ')}`);
  }
}

/* ─────────────────────────── drive ────────────────────────── */
if (want('unit')) runUnit();
if (want('static')) runStatic();
if (want('compose')) runCompose();

console.log('\n═══ 汇总 ═══');
for (const g of Object.keys(summary)) {
  if (!want(g)) continue;
  const rows = Object.values(summary[g]);
  const ok = rows.filter((r) => r.status === 'ok').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const skippedN = rows.filter((r) => r.status === 'skipped' || r.status === 'no-tests').length;
  console.log(`${g.padEnd(8)} ok ${String(ok).padStart(3)}  failed ${String(failed).padStart(2)}  skipped/no-tests ${String(skippedN).padStart(2)}`);
}

if (argv.includes('--json')) {
  console.log(JSON.stringify({ ok: failures === 0, summary }, null, 2));
}

if (failures) {
  console.error(`\n验证未通过：${failures} 项失败。`);
  process.exit(1);
}
console.log(`\n验证通过（${skips} 项跳过/无测试，跳过不等于通过，见 docs/07-verification-status.md）。`);
