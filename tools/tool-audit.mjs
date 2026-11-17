#!/usr/bin/env node
/**
 * P3 工具能力、权限与可见性审计（任务包 C）。
 *
 * 三条硬口径：
 *   1. 工具矩阵**从真实挂载取值**（`resolveModuleRoot` + `mountCompanion` + 假 ctx 收集
 *      `tools.register`），不靠 grep 猜名字或猜 schema 体积；
 *   2. QQ 侧工具**只读源码描述事实**，不构建它的运行实例（它的运行依赖 OneBot
 *      连接与 section 装配，审计不该连外网）；
 *   3. 宿主能力只读包内文件（`.d.ts` / `README.md`），给结论 + 证据（文件与函数名）。
 *
 * 另外两条不许忘：
 *   * 只报**字符数**，不报 Token（宿主没有给这里可用的计数器 ⇒ 写 unavailable）；
 *   * 合成根建在 `os.tmpdir()`，绝不读 `data/` 下的真实 DB、记忆或聊天。
 *
 * 用法：node tools/tool-audit.mjs [--json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SUITE_ROOT = path.resolve(here, '..');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
// `--keep` 保留合成根（排查用）；默认跑完就删，不给磁盘留垃圾。
const keepRoot = argv.includes('--keep');

const chars = value => (typeof value === 'string' ? value.length : 0);

/**
 * 合成数据根：能挂起 foundation 的最小目录树。刻意不读 DSH_HOME。
 * persona 与 suite-paths 解析出的 id 一致，否则 identity.resolve 会失败关闭。
 */
function syntheticRoot(personaId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-audit-'));
  for (const dir of ['workspace', 'logs', 'home/memory', 'home/companion', 'home/channel-qq']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1, persona: personaId,
    owner: { id: '10001', displayName: 'fixture', platform: 'qq' },
    desktop: { mode: 'local-owner', userId: '10001' },
    sessions: {},
  }));
  fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), '# audit\n\n合成人格正文，仅用于挂载。\n');
  fs.writeFileSync(path.join(root, 'home/companion/memory.config.json'), JSON.stringify({
    schemaVersion: 1, backend: 'sqlite',
    injection: { budgetChars: 0 },
    extraction: { enabled: false, minMessages: 3, maxMessages: 20 },
    embedding: { provider: 'local', dimensions: 8 },
    wiki: { enabled: false, dir: 'home/memory/wiki', autoCompile: false, minIntervalMs: 0 },
  }));
  // runtime 全关：审计的是**工具面**，不是自主行为；关着也照样注册工具。
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: false, mode: 'off', timeZone: 'Asia/Shanghai',
    p2: { share: { enabled: false } },
  }));
  return root;
}

/**
 * 每条注记的 `evidence` **运行时现算**，不写死行号。
 *
 * 为什么：`index.mjs` 是集成负责人正在改的共用文件，行号会漂；写死的行号会让
 * 审计报告第二天就变成假证据。这里只记「哪个文件里的 register/define 调用」，
 * 行号在该文件里现找。
 */
const EVIDENCE_SOURCES = [
  // 允许前面有别的东西（`registered.push(define(...`）与行首缩进两种情况。
  { file: 'plugins/companion-foundation/index.mjs', pattern: name => new RegExp(`(?:^|[^\\w.])register\\(\\s*'${name}'`) },
  { file: 'plugins/companion-foundation/health-tools.mjs', pattern: name => new RegExp(`(?:^|[^\\w.])define\\('${name}'`) },
  { file: 'plugins/companion-foundation/pulse-tools.mjs', pattern: name => new RegExp(`(?:^|[^\\w.])define\\('${name}'`) },
];

/** 在哪个文件/行注册了这个工具；找不到就返回 `not-found`（不猜）。 */
function locateRegistration(name) {
  for (const source of EVIDENCE_SOURCES) {
    let text;
    try { text = fs.readFileSync(path.join(SUITE_ROOT, source.file), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    const index = lines.findIndex(line => source.pattern(name).test(line));
    if (index !== -1) return `${source.file}:${index + 1}`;
  }
  // `companion_share_activity` 是用常量名注册的，只有这一处。
  if (name === 'companion_share_activity') {
    const anchor = anchorText({ file: 'plugins/companion-foundation/index.mjs', pattern: /(?:^|[^\w.])register\(SHARE_TOOL_NAME/ });
    return `${anchor}（register(SHARE_TOOL_NAME)）`;
  }
  return 'not-found';
}

/** 关键行锚点：全部现算，不写死行号（index.mjs 由集成负责人改动，行号会漂）。 */
const ANCHORS = {
  wrapper: { file: 'plugins/companion-foundation/index.mjs', pattern: /const register = \(name, description, parameters, execute/ },
  executorLine: { file: 'plugins/companion-foundation/index.mjs', pattern: /execute: async \(args, exec\) => JSON\.stringify/ },
  agendaPort: { file: 'plugins/companion-foundation/index.mjs', pattern: /const agendaPort = createAgendaPort/ },
  lifeSection: { file: 'plugins/companion-foundation/index.mjs', pattern: /name: 'companion:life'/ },
  p2Status: { file: 'plugins/companion-runtime/index.mjs', pattern: /function p2Status\(input = \{\}\)/ },
};

/** 锚点 → `file:line` 文本；找不到写 `not-found`。 */
function anchorText(anchor) {
  if (!anchor) return 'not-found';
  let text;
  try { text = fs.readFileSync(path.join(SUITE_ROOT, anchor.file), 'utf8'); } catch { return `${anchor.file}: not-found`; }
  const lines = text.split('\n');
  const index = lines.findIndex(line => anchor.pattern.test(line));
  return index === -1 ? `${anchor.file}: not-found` : `${anchor.file}:${index + 1}`;
}

/** 某些关键行（wrapper / agenda）也现算。 */
function locateAnchor(pattern) {
  const file = path.join(SUITE_ROOT, 'plugins/companion-foundation/index.mjs');
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const index = lines.findIndex(line => pattern.test(line));
    return index === -1 ? { file: 'plugins/companion-foundation/index.mjs', line: null } : { file: 'plugins/companion-foundation/index.mjs', line: index + 1 };
  } catch { return { file: 'plugins/companion-foundation/index.mjs', line: null }; }
}
const TOOL_NOTES = {
  companion_status: { registrar: 'index.mjs', deps: ['companionMemory（engine.store.status）'] },
  companion_identity: { registrar: 'index.mjs', deps: ['identity.resolve（宿主 session id）'] },
  companion_wardrobe_detail: { registrar: 'index.mjs', deps: ['wardrobe-state（本地文件）'] },
  companion_outfit_set: { registrar: 'index.mjs', deps: ['wardrobe-state（本地文件）'] },
  companion_visual_state: { registrar: 'index.mjs', deps: ['cognitive.p2Status + wardrobe'] },
  companion_recall: { registrar: 'index.mjs', deps: ['companionMemory engine'] },
  companion_remember: { registrar: 'index.mjs', deps: ['companionMemory engine'] },
  companion_recent_events: { registrar: 'index.mjs', deps: ['store（本地 jsonl）'] },
  companion_record_event: { registrar: 'index.mjs', deps: ['store（本地 jsonl）'] },
  companion_life_status: { registrar: 'index.mjs', deps: ['cognitive runtime（P2）+ autonomy ports'] },
  companion_plan_today: { registrar: 'index.mjs', deps: ['cognitive runtime + 规划模型（计费）'] },
  companion_runtime_status: { registrar: 'index.mjs', deps: ['cognitive runtime + share-diagnostics'] },
  companion_share_activity: { registrar: 'index.mjs', deps: ['cognitive.createShareCandidate + runtime 配置'] },
  companion_goal_list: { registrar: 'index.mjs', deps: ['cognitive runtime'] },
  companion_belief_list: { registrar: 'index.mjs', deps: ['cognitive runtime'] },
  companion_goal_switch: { registrar: 'index.mjs', deps: ['cognitive runtime'] },
  companion_goal_resume: { registrar: 'index.mjs', deps: ['cognitive runtime'] },
  companion_commitment_add: { registrar: 'index.mjs', deps: ['cognitive runtime'] },
  companion_belief_assert: { registrar: 'index.mjs', deps: ['cognitive runtime + 本回合用户原话'] },
  companion_belief_correct: { registrar: 'index.mjs', deps: ['cognitive runtime + 本回合用户原话'] },
  companion_goal_propose: { registrar: 'index.mjs', deps: ['cognitive runtime'] },
  companion_goal_transition: { registrar: 'index.mjs', deps: ['cognitive runtime'] },
  companion_schedule_today: { registrar: 'index.mjs', deps: ['companionAgenda / cognitive'] },
  companion_schedule_list: { registrar: 'index.mjs', deps: ['companionAgenda / cognitive'] },
  companion_schedule_create: { registrar: 'index.mjs', deps: ['companionAgenda / cognitive'] },
  companion_schedule_update: { registrar: 'index.mjs', deps: ['companionAgenda / cognitive'] },
  companion_schedule_cancel: { registrar: 'index.mjs', deps: ['companionAgenda / cognitive'] },
  companion_heartbeat_status: { registrar: 'index.mjs', deps: ['cognitive.heartbeat'] },
  companion_heartbeat_pause: { registrar: 'index.mjs', deps: ['cognitive.heartbeat'] },
  companion_heartbeat_resume: { registrar: 'index.mjs', deps: ['cognitive.heartbeat'] },
  companion_wiki_index: { registrar: 'index.mjs', deps: ['companionMemory（sqlite 后端才注册）'] },
  companion_wiki_get: { registrar: 'index.mjs', deps: ['companionMemory（sqlite 后端才注册）'] },
  companion_memory_pending: { registrar: 'index.mjs', deps: ['companionMemory（sqlite 后端才注册）'] },
  companion_memory_extract: { registrar: 'index.mjs', deps: ['companionMemory + 总结模型（计费）'] },
  companion_memory_forget: { registrar: 'index.mjs', deps: ['companionMemory（sqlite 后端才注册）'] },
  companion_memory_rebuild: { registrar: 'index.mjs', deps: ['companionMemory（sqlite 后端才注册）'] },
  companion_health_status: { registrar: 'health-tools.mjs', deps: ['companionHealth 服务（可能未挂载）'] },
  companion_health_today: { registrar: 'health-tools.mjs', deps: ['companionHealth 服务'] },
  companion_health_trend: { registrar: 'health-tools.mjs', deps: ['companionHealth 服务'] },
  companion_health_sleep: { registrar: 'health-tools.mjs', deps: ['companionHealth 服务'] },
  companion_health_sources: { registrar: 'health-tools.mjs', deps: ['companionHealth 服务'] },
  companion_pulse: { registrar: 'pulse-tools.mjs', deps: ['companionHealth pulse（BLE sidecar）'] },
};

/** 不在 foundation 里注册、但模型在别的上下文里看得见的工具族（只读源码事实，名字由 readQqFacts 现数）。 */
function buildOtherFamilies(qqFacts) {
  return {
    'channel-qq / qq-tools（tools.v2 关时）': {
      names: `${qqFacts.legacyCount} 个 qq_* spec（顺序 = REGISTRATION_ORDER，顺序本身属于提示词内容）`,
      nameList: qqFacts.legacyRegistrationOrder,
      evidence: anchorText({ file: 'plugins/dsh-channel-qq/src/features/qq-tools/register.ts', pattern: /const REGISTRATION_ORDER/ }) + '（顺序表）；' + anchorText({ file: 'plugins/dsh-channel-qq/src/features/qq-tools/register.ts', pattern: /export function registerQQTools/ }) + '（注册入口）',
      registrar: 'plugins/dsh-channel-qq（宿主 ctx.tools.register，全局层；' + anchorText({ file: 'plugins/dsh-channel-qq/src/adapters/dsh-host/tools.ts', pattern: /const remove = tools\.register/ }) + '）',
    },
    'channel-qq / tools.v2（打开时）': {
      names: `${qqFacts.mergedCount} 个合并工具（旧 spec 全被收编，不上宿主）`,
      nameList: qqFacts.mergedFaces,
      evidence: 'features/tools-v2/faces-core.ts / faces-media.ts / faces-content.ts / faces-misc.ts（现数名表）；' + anchorText({ file: 'plugins/dsh-channel-qq/src/features/tools-v2/surface.ts', pattern: /export function registerMergedSurface/ }) + '（收编 + 只注册合并面）',
      registrar: anchorText({ file: 'plugins/dsh-channel-qq/src/features/tools-v2/surface.ts', pattern: /export function registerMergedSurface/ }),
    },
    'companion-media': {
      names: '5 个：companion_media_status / companion_media_visual / companion_media_draw / companion_media_speak / companion_media_job',
      evidence: anchorText({ file: 'plugins/companion-media/index.mjs', pattern: /register\('companion_media_status'/ }),
      registrar: 'plugins/companion-media（预设内，随 modules.media）',
    },
    'companion-expression': {
      names: '5 个：expression_candidates / expression_reply / expression_feedback / expression_library_stats / expression_sticker_note',
      evidence: 'plugins/companion-expression/src/tools.mjs（TOOL_NAMES）',
      registrar: 'plugins/companion-expression（预设内，随 modules.expression）',
    },
  };
}

/**
 * 找一个**真实**的宿主包来只读调查。
 *
 * 挂载用的 moduleRoot 可能落在仓库内的 fixtures（那里面只有一个 8 行的 `defineTool`），
 * 拿它调查"宿主支不支持按轮过滤"只会得到一片 not-found。所以这里单独找真实包：
 * 先看挂载用的 root，再看本机 npm 缓存里的 npx 安装目录（只读，不写不跑）。
 */
function findHostPackage(mountRoot) {
  const candidates = [];
  const push = (dir, source) => {
    if (typeof dir === 'string' && dir.trim()) candidates.push({ dir, source });
  };
  push(mountRoot, 'mount-module-root');
  for (const base of [
    process.env.DSH_MODULE_ROOT,
    path.join(os.homedir(), 'AppData/Local/npm-cache/_npx'),
    path.join(os.homedir(), '.npm/_npx'),
    path.join(os.homedir(), 'AppData/Roaming/npm/node_modules'),
    path.join(os.homedir(), 'AppData/Local/DeepSeek/dsh'),
  ]) {
    if (typeof base !== 'string' || !base.trim()) continue;
    let entries = [];
    try { entries = fs.readdirSync(base); } catch { continue; }
    for (const entry of entries) {
      push(path.join(base, entry, 'node_modules'), `${base.replace(os.homedir(), '~')}/${entry}（npx 缓存）`);
    }
  }
  // 直接指向包目录也算。
  push(SUITE_ROOT, 'suite-node_modules');
  for (const candidate of candidates) {
    const probe = path.join(candidate.dir, '@deepseek-ai/dsh-tools/lib/types/index.d.ts');
    try { if (fs.existsSync(probe)) return { dir: candidate.dir, source: candidate.source }; } catch { /* unreadable */ }
  }
  return { dir: null, source: 'not-found' };
}

/** 读一个文件的行号索引，用来给宿主能力结论定位到行。 */
function lineIndexOf(file, patterns) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  const hits = {};
  for (const [key, pattern] of Object.entries(patterns)) {
    const index = lines.findIndex(line => pattern.test(line));
    hits[key] = index === -1 ? null : index + 1;
  }
  return hits;
}

/**
 * 只读调查宿主：按轮工具过滤 / 恢复 / 增删声明 / 执行层权限。
 * 每个结论都带**具体文件与行号**，找不到就写 `not-found`，不写"支持"。
 */
function investigateHost({ dir: moduleRoot, source: moduleRootSource }) {
  const pkg = moduleRoot ? path.join(moduleRoot, '@deepseek-ai/dsh-tools') : '';
  const indexTypes = path.join(pkg, 'lib/types/index.d.ts');
  const contracts = path.join(pkg, 'lib/types/contracts.d.ts');
  const events = path.join(pkg, 'lib/types/events.d.ts');
  const readme = path.join(pkg, 'README.md');
  const agentLoopReadme = path.join(moduleRoot, '@deepseek-ai/dsh-agent-loop/README.md');
  const present = [indexTypes, contracts, events, readme].some(file => fs.existsSync(file));

  const indexHits = lineIndexOf(indexTypes, {
    restrict: /^\s*restrict\(filter: ToolRestriction\)/,
    definitions: /^\s*definitions\(scope\?: ScopeKey/,
    schemas: /^\s*schemas\(scope\?: ScopeKey/,
    executable: /^\s*executable\(name: string/,
    resolve: /^\s*resolve\(context: ToolActivationContext\)/,
    guard: /^\s*guard\(guard: ToolGuard\)/,
    get: /^\s*get\(name: string/,
  });
  const contractHits = lineIndexOf(contracts, {
    when: /readonly when\?: \(context: ToolActivationContext\)/,
    activationContext: /export interface ToolActivationContext/,
    resolvedToolSet: /export interface ResolvedToolSet/,
    preToolDecision: /export type PreToolDecision/,
    restriction: /export interface ToolRestriction/,
    toolGuard: /export type ToolGuard/,
    postToolDecision: /export type PostToolDecision/,
  });
  const eventHits = lineIndexOf(events, {
    preExecute: /'tools\/pre-execute'/,
    execute: /'tools\/execute'/,
    postExecute: /'tools\/post-execute'/,
    result: /'tools\/result'/,
    change: /'tools\/change'/,
  });
  const readmeHits = lineIndexOf(readme, {
    whenText: /^`register\(definition, \{ when \}\)`/,
    resolveText: /^`resolve\(\{ agent, modelSelection, signal \}\)/,
    restrictText: /^`ctx\.tools\.restrict\(filter\)`/,
    guardText: /^`ctx\.tools\.guard\(guard\)`/,
  });
  const loopHits = lineIndexOf(agentLoopReadme, {
    developerMessage: /Comparing their names with the preceding header emits one `developer\/message`/,
    perStepSchemas: /^Each step sends the session's derived history/,
  });

  const supported = value => value !== null && value !== undefined;

  return {
    packagePresent: present,
    moduleRootSource,
    package: moduleRoot ? pkg.replace(os.homedir(), '~') : 'not-found',
    perTurn: {
      verdict: supported(contractHits?.when) ? 'supported' : 'not-found',
      mechanism: 'register(definition, { when })：条件在**每个模型步骤**准备时求值一次（agent + modelSelection + signal），false ⇒ 该工具既不出现在描述/PTC 绑定里，也不能执行。这是"按轮（每个 step）过滤"的唯一官方口子。',
      evidence: [
        contractHits?.when ? `lib/types/contracts.d.ts:${contractHits.when} ToolRegistrationOptions.when` : 'lib/types/contracts.d.ts: not-found',
        readmeHits?.whenText ? `README.md:${readmeHits.whenText} register(definition, { when })` : 'README.md: not-found',
      ],
      limits: [
        '条件是**插件注册时**给出的，不是模型或调用方能改的；条件里不能改注册、不能做工具工作（README 明写）。',
        '抛错 => TOOL_ACTIVATION_FAILED 直接让步骤准备失败，不是"工具不可用"。',
      ],
    },
    perStepAdmission: {
      verdict: supported(indexHits?.resolve) ? 'supported' : 'not-found',
      mechanism: 'ctx.tools.resolve({agent, modelSelection, signal}) 返回**该步骤独占**的 ResolvedToolSet，交给 prompt assembly 与该步骤 execute 批次；批次结算后必须 dispose。',
      evidence: [
        indexHits?.resolve ? `lib/types/index.d.ts:${indexHits.resolve} ToolsService.resolve` : 'lib/types/index.d.ts: not-found',
        contractHits?.resolvedToolSet ? `lib/types/contracts.d.ts:${contractHits.resolvedToolSet} ResolvedToolSet` : 'contracts: not-found',
        readmeHits?.resolveText ? `README.md:${readmeHits.resolveText}` : 'README.md: not-found',
      ],
    },
    restore: {
      verdict: (supported(indexHits?.restrict) && supported(indexHits?.definitions)) ? 'supported（通过 dispose 恢复）' : 'not-found',
      mechanism: 'restrict(filter) 返回**精确的 disposer**：dispose 即撤销这次限制，所以"先裁后恢复"是宿主一等能力，不是自己删注册再注册。恢复粒度是**作用域**（agent/preset scope），不是回合。',
      evidence: [
        indexHits?.restrict ? `lib/types/index.d.ts:${indexHits.restrict} ToolsService.restrict` : 'not-found',
        readmeHits?.restrictText ? `README.md:${readmeHits.restrictText}` : 'README.md: not-found',
      ],
      caveats: [
        '空 filter、未知名字、scope 内自己的注册名、保留传输名都会**失败**（index.d.ts 的注释明写），所以"恢复"不能靠一张固定白名单硬写。',
        '多个限制**取交集**：撤销其中一个不会自动回到全量。',
      ],
    },
    toolAddRemoveDeclaration: {
      verdict: supported(loopHits?.developerMessage) ? 'supported（宿主自动声明，插件不自己写）' : 'not-found',
      mechanism: '请求头里工具集合变化时，agent-loop 自己发一条 developer/message 声明新增/移除（独立于模型能力）；插件侧只需要让注册面变化，声明由宿主生成。',
      evidence: [
        loopHits?.developerMessage ? `@deepseek-ai/dsh-agent-loop/README.md:${loopHits.developerMessage}` : 'agent-loop README: not-found',
        loopHits?.perStepSchemas ? `@deepseek-ai/dsh-agent-loop/README.md:${loopHits.perStepSchemas}（每个 step 送当前可见 schema）` : 'agent-loop README: not-found',
        eventHits?.change ? `lib/types/events.d.ts:${eventHits.change} tools/change` : 'not-found',
      ],
      caveats: ['工具集合变化会让**前缀缓存从第一个变化的 token 起失效**（README 的缓存段），所以每轮裁剪不是免费的。'],
    },
    executionPermission: {
      verdict: {
        preExecute: supported(eventHits?.preExecute) ? 'supported' : 'not-found',
        guard: supported(indexHits?.guard) ? 'supported（单调，只能拒绝）' : 'not-found',
        approval: supported(contractHits?.preToolDecision) ? 'supported（ask ⇒ 需要审批服务，否则按拒绝）' : 'not-found',
      },
      mechanism: '执行层权限是三层：tools/pre-execute 瀑布（allow/deny/cancel/ask）→ 注册的单调 guard（返回原因即拒绝，后加的监听器无法翻案）→ 审批服务（allowed-once 才放行）。本仓库群聊边界用的就是 guard。',
      evidence: [
        eventHits?.preExecute ? `lib/types/events.d.ts:${eventHits.preExecute} tools/pre-execute` : 'not-found',
        contractHits?.preToolDecision ? `lib/types/contracts.d.ts:${contractHits.preToolDecision} PreToolDecision` : 'not-found',
        indexHits?.guard ? `lib/types/index.d.ts:${indexHits.guard} ToolsService.guard` : 'not-found',
        contractHits?.toolGuard ? `lib/types/contracts.d.ts:${contractHits.toolGuard} ToolGuard` : 'not-found',
        anchorText({ file: 'plugins/companion-group/boundary.mjs', pattern: /ctx\.tools\.guard\(exec => groupToolDenial/ }) + '（仓库内真实用例：ctx.tools.guard(groupToolDenial)）',
        anchorText({ file: 'plugins/companion-group/index.mjs', pattern: /ctx\.tools\.guard\(exec => groupToolDenial/ }) + '（同一 guard 的 preset 侧安装）',
      ],
      limits: [
        'guard 没有 "allow" 结果 ⇒ 权限只能收窄、不能放宽；这是设计而不是缺陷。',
        'pre-execute / execute / post-execute 都是 waterfall，插件可以替换结果、附加下一轮 context，但都不能改调用身份。',
      ],
    },
    hostVerdict: '按轮（每 step）过滤：支持（when）；按作用域裁剪并恢复：支持（restrict + disposer）；工具增删声明：宿主自动生成，插件不写；执行层权限：支持（pre-execute + guard + approval）。动态裁剪**可以做**，代价是每轮 schema 变化会打掉前缀缓存。',
    unavailable: [
      '按"轮次序号"做过滤（when 只给 agent/modelSelection/signal，没有 turn/step 计数）',
      '策略热加载（when 的闭包在注册时固定；改判定条件要重挂插件）',
    ],
  };
}

/** 从真实挂载里收集工具定义。 */
function collectTools(tools) {
  const items = [];
  for (const [name, tool] of tools) {
    const parameters = tool.parameters ?? tool.inputSchema ?? {};
    // 两种形状都要认：
    //   * 宿主 JSON Schema 投影后：{ type:'object', properties:{…}, required:[…] }
    //   * 夹具/仓库内的 spec 形状：{ key: { type, required, enum } }（defineTool 的原始参数表）
    const isJsonSchemaShape = parameters?.type === 'object' || Array.isArray(parameters?.properties);
    const rawProperties = isJsonSchemaShape
      ? (parameters.properties ?? {})
      : parameters;
    const requiredList = isJsonSchemaShape && Array.isArray(parameters.required) ? parameters.required : [];
    const properties = Object.fromEntries(Object.entries(rawProperties).map(([key, value]) => {
      const info = value ?? {};
      return [key, {
        type: String(info.type ?? ''),
        ...(Array.isArray(info.enum) ? { enum: [...info.enum] } : {}),
        ...(Array.isArray(info.items?.enum) ? { itemsEnum: [...info.items.enum] } : {}),
        required: requiredList.includes(key) || info.required === true,
      }];
    }));
    let kind = 'unknown';
    try { kind = String(tool.presentCall?.()?.kind ?? 'unknown'); } catch { kind = 'threw'; }
    const note = TOOL_NOTES[name] ?? {};
    items.push({
      name,
      kind,
      registrar: note.registrar ?? 'index.mjs',
      deps: note.deps ?? ['unknown'],
      evidence: locateRegistration(name),
      schemaChars: JSON.stringify(parameters).length,
      descriptionChars: chars(tool.description),
      totalChars: JSON.stringify(parameters).length + chars(tool.description),
      paramKeys: Object.keys(properties),
      params: properties,
      requiredKeys: Object.keys(properties).filter(key => properties[key].required),
      // 作用域：`register()` 包装器里固定调用 identity.resolve(exec.agent.session.id)。
      scope: { kind: 'owner-identity', resolver: 'identity.resolve(sessionId)', evidence: anchorText(ANCHORS.wrapper) },
      // 返回形状：字符串化 JSON 包成单个 text block（宿主 output schema 是 string）。
      output: { schema: 'string', render: 'text', evidence: anchorText(ANCHORS.executorLine) },
    });
  }
  return items.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * 四上下文矩阵。`desktop` / `qq-dm` 的取值来自本次真实挂载；`qq-group` 与
 * `background` 的取值来自源码事实（不构建运行实例），所以每条都标 `basis`。
 */
function buildContexts(toolItems, qqFacts) {
  const names = toolItems.map(item => item.name);
  const writeTools = toolItems.filter(item => item.kind === 'write').map(item => item.name);
  return [
    {
      id: 'desktop',
      label: '桌面（companion 预设里挂 foundation）',
      basis: '本次真实挂载（mountCompanion + 假 ctx）+ config/profile/companion.patch.template.yml:47-52',
      registered: { verdict: 'yes', detail: `${names.length} 个 foundation 工具（含 5 个只在 sqlite 后端出现的 wiki/memory 工具）` },
      visible: { verdict: 'yes', detail: '预设只挂 foundation 一行，工具面进模型一次；写类工具也在场', evidence: 'config/profile/companion.patch.template.yml:52' },
      executable: { verdict: 'yes', detail: `全部 ${names.length} 个；其中 ${writeTools.length} 个标 write：${writeTools.join(', ')}` },
      consumable: { verdict: 'yes', detail: 'execute 返回 JSON 字符串，宿主 render 成单个 text block；模型直接读得到', evidence: `${anchorText(ANCHORS.executorLine)} / ${anchorText(ANCHORS.wrapper)}` },
      blockers: [],
    },
    {
      id: 'qq-dm',
      label: 'QQ 私聊（owner 的 qq-dm-<ownerId> 会话，preset=companion）',
      basis: '源码事实 + 本次挂载（identity.resolve 对 owner 私聊放行）',
      registered: { verdict: 'yes', detail: `foundation 那 ${names.length} 个 + channel-qq 全局注册的 qq_* 面（tools.v2 关：${qqFacts.legacyCount} 个旧 spec；开：${qqFacts.mergedCount} 个合并工具）` },
      visible: { verdict: 'yes（除被 restrict 掉的以外）', detail: 'channel-qq 用宿主 ctx.tools.register 注册在**全局层**，因此所有 agent 作用域默认可见；agentPreset=companion ⇒ 与桌面同一份工具面', evidence: 'config/profile/companion.patch.template.yml（agentPreset: companion）; ' + anchorText({ file: 'plugins/dsh-channel-qq/src/adapters/dsh-host/tools.ts', pattern: /const remove = tools\.register/ }) },
      executable: { verdict: 'yes', detail: 'identity.resolve 只对 `qq-dm-<owner.id>` 放行（其它 qq-* 会话直接抛错），所以 foundation 工具在这个会话里能执行', evidence: `${anchorText({ file: 'plugins/companion-foundation/identity.mjs', pattern: /if \(sessionId\.startsWith\('qq-'\)/ })}（owner QQ 私聊之外一律抛错）` },
      consumable: { verdict: 'yes', detail: 'qq_* 的 execute 也把结果 lossless 化后交给宿主 render（text）；foundation 的回执是 JSON 字符串', evidence: anchorText({ file: 'plugins/dsh-channel-qq/src/adapters/dsh-host/tools.ts', pattern: /output: \{/ }) },
      blockers: [
        '如果部署把 agentPreset 写成别的预设（模板默认 companion，可被用户层覆盖），QQ 私聊就看不到 foundation 工具面。',
        '出站边界与 policy.v2 会在执行层再拒一次（发送类动作），这不影响只读工具。',
      ],
    },
    {
      id: 'qq-group',
      label: 'QQ 群聊（qq-group-<群号>，preset=companion-group）',
      basis: '源码事实（未构建运行实例）',
      registered: {
        verdict: '部分',
        detail: '全局层仍在册（qq_* 与 foundation 都是全局注册），但群 preset 在 agent/pre-step 里用 `tools.restrict({allow})` 把可见面裁到 11 个名字（3 发送 + 4 媒体 + 4 表情包）：'
          + 'qq_message / qq_sticker / qq_voice / companion_media_status / companion_media_draw / companion_media_speak / companion_media_job / expression_candidates / expression_reply / expression_feedback / expression_sticker_note',
        evidence: `${anchorText({ file: 'plugins/companion-group/core.mjs', pattern: /export const GROUP_ALLOWED_TOOLS/ })} (GROUP_ALLOWED_TOOLS)；${anchorText({ file: 'plugins/companion-group/index.mjs', pattern: /tools\.restrict\(\{ allow: GROUP_ALLOWED_TOOLS/ })}（restrict allow，按实际可限制名字过滤）`,
      },
      visible: { verdict: '仅白名单', detail: '非白名单工具从模型描述里消失（包括全部 companion_life_status / schedule_* / share_activity / 记忆工具）', evidence: anchorText({ file: 'plugins/companion-group/index.mjs', pattern: /ctx\.on\('agent\/pre-step'/ }) },
      executable: {
        verdict: '仅白名单 + guard 二次裁决',
        detail: '即使白名单里的工具也要过 groupToolDenial：只认当前群数字、isGroup=true，动作必须等于 send/send_image/send_file；未知工具默认拒绝；路径参数（file/path/url/dir/root）在表情包工具里一律拒绝',
        evidence: `${anchorText({ file: 'plugins/companion-group/core.mjs', pattern: /export function groupToolDenial/ })}；${anchorText({ file: 'plugins/companion-group/boundary.mjs', pattern: /ctx\.tools\.guard\(exec => groupToolDenial/ })}`,
      },
      consumable: { verdict: '是（白名单内）', detail: '白名单内的发送/媒体工具返回 OneBot 原始响应 JSON；模型能读 message_id 之类回执', evidence: anchorText({ file: 'plugins/dsh-channel-qq/src/adapters/dsh-host/tools.ts', pattern: /if \(value === undefined \|\| value === null\) return \{ ok: true \}/ }) },
      blockers: [
        'foundation 的 register 包装器固定调 identity.resolve，而它对 `qq-group-*` 会话**直接抛错**：所以就算把某个 foundation 工具塞进白名单，执行也会失败。',
        '@ 之外的回合在 step>1 且本回合未投递时被 pre-step 拒绝（群聊不续步）。',
        `群聊 preset 断言宿主必须有 tools.restrict / tools.guard，这两个缺失会让 preset 挂不上（${anchorText({ file: 'plugins/companion-group/index.mjs', pattern: /Group preset requires tools\.restrict/ })}）。`,
      ],
    },
    {
      id: 'background',
      label: '后台活动（P2 activity executor 的模型调用）',
      basis: '源码事实（未构建运行实例，没有模型调用）',
      registered: { verdict: '不适用', detail: '这条路径不是 agent 步骤，不经过 ctx.tools.execute，也没有 agent/session；工具注册与它无关' },
      visible: {
        verdict: 'no',
        detail: 'P2 只走 llm.prepareCall + call.stream，请求包里没有 tools 字段，也没有 system 里的工具清单',
        evidence: `${anchorText({ file: 'plugins/companion-foundation/host-llm.mjs', pattern: /messages,$/ })}（请求 options 只有 messages/system/purpose/signal/sessionId）；${anchorText({ file: 'plugins/companion-runtime/lib/p2.mjs', pattern: /modelResult = await callModel\(/ })}（callModel 只收 purpose/system/input/maxTokens）`,
      },
      executable: { verdict: 'no', detail: '没有工具声明就没有 tool-call 通道；progress 只能靠 applyModelProgress 的 modelReceipt 落库', evidence: anchorText({ file: 'plugins/companion-runtime/lib/activities.mjs', pattern: /function applyModelProgress\(input = \{\}\)/ }) },
      consumable: {
        verdict: 'no（返回值不是给模型的）',
        detail: '模型只产一段正文（write 还要 JSON {text,done}），消费方是 runtime 的校验器；没有任何工具结果回给这个"后台模型"',
        evidence: anchorText({ file: 'plugins/companion-runtime/lib/p2.mjs', pattern: /const rawAnswer = String\(modelResult\?\.text/ }),
      },
      blockers: [
        'P2 每一步的完成判据是正文/收据，不是工具调用；所以"后台不调工具"不是模型选择问题，是**没有工具面**。',
        `write 任务的完成信号必须是模型自己写 done:true，finish_reason=stop 不算（${anchorText({ file: 'plugins/companion-runtime/lib/p2.mjs', pattern: /只输出 JSON：\{"text"/ })} 注释）。`,
      ],
    },
  ];
}

/**
 * "模型不调用工具"的成因分类。每类都给**可验证特征**（就是审计/日志里该看什么），
 * 不允许用"调用次数少"反向归因。
 */
function buildAttribution() {
  return [
    {
      cause: '不可见（never visible）',
      verifiable: '该会话作用域下 tools.schemas(scope) / 宿主 header.tools 里没有这个工具名；restrict 或 preset 未挂',
      discriminator: '全局 tools.get(name) 有值但会话内没有 ⇒ 作用域裁剪；两者都没有 ⇒ 没注册',
      evidence: `${anchorText({ file: 'plugins/dsh-channel-qq/src/adapters/dsh-host/tool-visibility.ts', pattern: /三种完全不同的原因/ })}（本仓库自己的三态探针把这一层分开答）`,
    },
    {
      cause: '描述不清（description/schema 不足）',
      verifiable: '工具可见、被调用过，但参数校验失败率高（错误码是参数类而不是授权类），或参数取值来自"上一步结果里根本没有的字段"',
      discriminator: '看 tool/result 的 error.code 分布 + 参数名是否出现在相邻上一步的返回结构里',
      evidence: `${anchorText({ file: 'plugins/companion-foundation/index.mjs', pattern: /register\('companion_schedule_create'/ })}（schedule_create 的 required title/rule/timeZone 三项都必须由模型自己给出，工具结果里没有）`,
    },
    {
      cause: '路由错误（wrong tool for the intent）',
      verifiable: '同一意图反复调用只读工具而不进入写工具，或调了名字相近但语义不同的工具',
      discriminator: '按 intent→tool 的期望表比对实际调用序列；不是数量问题',
      evidence: `${anchorText({ file: 'plugins/companion-foundation/index.mjs', pattern: /register\('companion_life_status'/ })}（只读）vs ${anchorText({ file: 'plugins/companion-foundation/index.mjs', pattern: /register\('companion_plan_today'/ })}（写，且内部有一次计费模型调用）`,
    },
    {
      cause: '状态缺失（tool exists but the answer is "off"）',
      verifiable: '工具执行了但返回 {ok:false, code:"runtime-not-mounted"/"share-disabled"/"activities-disabled"/"agenda-disabled"/"health-not-mounted"}',
      discriminator: '回执里的 code 分布；这是能力关闭，不是模型没调',
      evidence: `${anchorText({ file: 'plugins/companion-foundation/index.mjs', pattern: /register\('companion_plan_today'/ })}（runtime-not-mounted）；${anchorText({ file: 'plugins/companion-foundation/share-producer.mjs', pattern: /code: 'share-disabled'/ })}（share-disabled）；${anchorText({ file: 'plugins/companion-foundation/health-tools.mjs', pattern: /health-not-mounted/ })}（health-not-mounted）`,
    },
    {
      cause: '模型选择（model simply chose not to）',
      verifiable: '工具可见、可执行、状态正常（同一进程里别处已成功调用过）、描述完整，但本回合的 header.tools 与 schema 都在而没有任何 tool/call',
      discriminator: '必须先排除上面四类；只能按"同一工具在相邻回合成功过"作为前提，不能凭单次缺席下结论',
      evidence: `${anchorText({ file: 'plugins/dsh-channel-qq/src/adapters/dsh-host/tool-visibility.ts', pattern: /这三层必须分别回答/ })}（这些层必须分别回答，否则结论不可行动）`,
    },
    {
      cause: '无工具面（no tool surface at all）',
      verifiable: '这条路径根本不是 agent step：请求里没有 tools 字段',
      discriminator: '看请求构造代码，而不是看调用次数',
      evidence: anchorText({ file: 'plugins/companion-foundation/host-llm.mjs', pattern: /const options = \{/ }),
    },
  ];
}

/** 只读抽取 QQ 侧的工具面事实：不构建它的运行实例，只数名字。 */
function readQqFacts() {
  const srcRoot = path.join(SUITE_ROOT, 'plugins/dsh-channel-qq/src');
  const readUnder = dir => file => {
    try { return fs.readFileSync(path.join(dir, file), 'utf8'); } catch { return ''; }
  };
  const read = readUnder(srcRoot);
  const bracketBlock = (text, startPattern) => {
    const match = text.match(startPattern);
    if (!match) return '';
    const from = match.index ?? 0;
    const end = text.indexOf('\n]', from);
    return end === -1 ? text.slice(from) : text.slice(from, end + 1);
  };
  const orderText = bracketBlock(read('features/qq-tools/register.ts'), /const REGISTRATION_ORDER[^=]*=\s*\[/);
  const orderNames = [...orderText.matchAll(/'([A-Za-z0-9_]+)'/g)].map(match => match[1]);
  const faceNames = [];
  for (const file of [
    'features/tools-v2/faces-core.ts', 'features/tools-v2/faces-media.ts',
    'features/tools-v2/faces-content.ts', 'features/tools-v2/faces-misc.ts',
  ]) {
    for (const match of read(file).matchAll(/^\s*name: '([a-z_]+)'/gm)) faceNames.push(match[1]);
  }
  return {
    legacyRegistrationOrder: orderNames,
    legacyCount: orderNames.length,
    legacyQqPrefixedCount: orderNames.filter(name => name.startsWith('qq_')).length,
    legacyNonQqNames: orderNames.filter(name => !name.startsWith('qq_')),
    mergedFaces: faceNames,
    mergedCount: faceNames.length,
    basis: '本脚本从源码现数（不构建运行实例）：legacy 顺序来自 features/qq-tools/register.ts 的 REGISTRATION_ORDER；'
      + '合并面来自 features/tools-v2/faces-*.ts。tools.v2 关 ⇒ legacy 面；开 ⇒ 合并面；两者互斥，不会同时上宿主。',
    groupAllowed: 'GROUP_ALLOWED_TOOLS = qq_message / qq_sticker / qq_voice + 4 个 companion_media_* + 4 个 expression_*（共 11 个名字）；证据 ' + anchorText({ file: 'plugins/companion-group/core.mjs', pattern: /export const GROUP_ALLOWED_TOOLS/ }),
  };
}

/** 关键场景能力链：每个场景给一条完整链，缺环就点名。 */
function buildChains() {
  return [
    {
      scenario: '问"你现在在干什么"',
      chain: '系统段 companion:life（index.mjs 的 lifeSection）→ 工具 companion_life_status（只读）→ cognitive.p2Status({sessionId}) → 返回 planning/activities/budget/reading',
      verdict: '桌面与 QQ 私聊可走通（前提：runtime 挂上且 scope 解析成功）；QQ 群聊**断在可见层**（不在 GROUP_ALLOWED_TOOLS）',
      evidence: `${anchorText({ file: 'plugins/companion-foundation/index.mjs', pattern: /register\('companion_life_status'/ })}；${anchorText(ANCHORS.lifeSection)}；${anchorText({ file: 'plugins/companion-group/core.mjs', pattern: /export const GROUP_ALLOWED_TOOLS/ })}`,
    },
    {
      scenario: '看今天/明天的安排',
      chain: 'companion_schedule_today（只读）→ cognitive.todaySchedule({sessionId}) → agenda 端口（reminderDelivery 恒为 not-wired）',
      verdict: '桌面与 QQ 私聊可读；群聊不可见；"已设置提醒"这句永远不成立，因为本模块从不投递提醒',
      evidence: `${anchorText({ file: 'plugins/companion-foundation/index.mjs', pattern: /register\('companion_schedule_today'/ })}；${anchorText(ANCHORS.agendaPort)}（端口建了，但 reminderDelivery 恒为 not-wired）`,
    },
    {
      scenario: '建/改一条日程',
      chain: 'companion_schedule_create（写）→ 必须自带 title + rule + timeZone + （once 时）date + time → cognitive.createSchedule → 返回 revision',
      verdict: '参数能从上一步结果取得的部分：timeZone（schedule_list 回执里有）、itemId+expectedRevision（update/cancel 需要，来自 list）；title 与 date/time 必须来自用户原话，不能从工具结果推断 ⇒ 这是"连续步骤"的真实断点',
      evidence: `${anchorText({ file: 'plugins/companion-foundation/index.mjs', pattern: /register\('companion_schedule_create'/ })}；${anchorText({ file: 'plugins/companion-foundation/index.mjs', pattern: /register\('companion_schedule_update'/ })}`,
    },
    {
      scenario: 'B站看完视频后分享',
      chain: 'provider ready → round → 证据（bilibili-rounds 的 evidenceOf：watch 需 BV 号 + consumedSeconds>0）→ settle 活动 → companion_share_activity（写）→ runtime.createShareCandidate → contact 闸门',
      verdict: '模型侧只有**一个**入口（companion_share_activity），而它默认 share-disabled；证据读取路径是 runtime 的 bilibili-rounds，模型拿不到（群聊/后台都不可见）',
      evidence: `${anchorText({ file: 'plugins/companion-foundation/index.mjs', pattern: /register\(SHARE_TOOL_NAME/ })}；${anchorText({ file: 'plugins/companion-foundation/share-producer.mjs', pattern: /export function assessShareableActivity/ })}；${anchorText({ file: 'plugins/companion-runtime/lib/bilibili-rounds.mjs', pattern: /function evidenceOf/ })}`,
    },
    {
      scenario: '判断"刚才做了什么"是计划还是执行',
      chain: 'companion_life_status 的 activities（status/reality/consumed）→ activity reality 必须是 actual_tool_activity 才算做过',
      verdict: '可读；但 reality=simulated_world/hypothetical 的活动在同一个列表里，模型必须自己区分；分享工具会把 simulated 拒掉（simulated-not-shared）',
      evidence: `${anchorText({ file: 'plugins/companion-runtime/lib/activities.mjs', pattern: /export const ACTIVITY_REALITY/ })}；${anchorText({ file: 'plugins/companion-foundation/share-producer.mjs', pattern: /simulated-not-shared/ })}`,
    },
  ];
}

async function main() {
  // `--json` 模式下 stdout 只能有 JSON：挂载本身会 console.log（议程发布、群人格、
  // group memory、异步 engine.initialize…），所以把 console.log 整体改道到 stderr。
  if (asJson) {
    console.log = (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`);
    console.error = console.log;
  }
  const { resolveModuleRoot } = await import(pathToFileURL(path.join(SUITE_ROOT, 'plugins/companion-foundation/test-fixtures/module-root.mjs')).href);
  const resolvedModuleRoot = resolveModuleRoot(SUITE_ROOT, process.env);
  process.env.DSH_COMPANION_MODULE_ROOT = resolvedModuleRoot.root;
  const { resolveSuitePaths } = await import(pathToFileURL(path.join(SUITE_ROOT, 'plugins/companion-foundation/suite-paths.mjs')).href);
  const suitePaths = resolveSuitePaths({});
  const { mountCompanion } = await import(pathToFileURL(path.join(SUITE_ROOT, 'plugins/companion-foundation/index.mjs')).href);

  const root = syntheticRoot(suitePaths.personaId ?? 'bot');
  const tools = new Map();
  const sections = [];
  const hooks = new Map();
  const internals = mountCompanion({
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    systemPrompt: { section: descriptor => sections.push(descriptor) },
    on(name, handler) { hooks.set(name, handler); },
    get() { return undefined; },
    provide() {},
    effect() {},
  }, root, { suitePaths });

  const toolItems = collectTools(tools);
  const qqFacts = readQqFacts();
  const totalSchema = toolItems.reduce((sum, item) => sum + item.schemaChars, 0);
  const totalDescription = toolItems.reduce((sum, item) => sum + item.descriptionChars, 0);
  const writeTools = toolItems.filter(item => item.kind === 'write');
  const readTools = toolItems.filter(item => item.kind === 'read');

  const report = {
    generatedAt: new Date().toISOString(),
    scope: 'P3 工具能力/权限/可见性审计（任务包 C）',
    basis: {
      moduleRoot: path.relative(SUITE_ROOT, resolvedModuleRoot.root) || resolvedModuleRoot.root,
      moduleRootSource: resolvedModuleRoot.source,
      syntheticRoot: 'os.tmpdir()（不读 data/，不读真实 DB/记忆/聊天）',
      mount: 'mountCompanion(ctx, syntheticRoot) 收集 ctx.tools.register',
      network: '零网络、零模型调用',
      qqSide: '只读 plugins/dsh-channel-qq 源码，未构建运行实例',
    },
    tools: {
      count: toolItems.length,
      readCount: readTools.length,
      writeCount: writeTools.length,
      totalSchemaChars: totalSchema,
      totalDescriptionChars: totalDescription,
      totalChars: totalSchema + totalDescription,
      tokenUsage: 'unavailable（宿主没有给本审计可用的 token 计数器；这里只有字符数，不报 Token）',
      charsNote: 'schemaChars 是 JSON.stringify(parameters).length；描述取 tool.description 的字符串长度。均为字符，不是字节，也不是 token。',
      items: toolItems,
    },
    contexts: buildContexts(toolItems, qqFacts),
    otherFamilies: buildOtherFamilies(qqFacts),
    qqFacts,
    keyScenarios: buildChains(),
    falseCallClassification: buildAttribution(),
    host: investigateHost(findHostPackage(resolvedModuleRoot.root)),
    evidenceLevel: 'E2（合成挂载 + 纯函数/模块审计）；E3/E4/E5 未执行，原因见 evidenceGaps',
    evidenceGaps: [
      'E3（真实宿主 + 隔离 profile + 本地合成模型）：未执行 —— 本次审计不允许启动宿主任一进程，也不允许挂 QQ 通道（需要 OneBot 连接）。',
      'E4（授权真实模型固定集）：未执行 —— 计划要求"未授权真实调用时只交离线证据"；本轮没有任何模型调用。',
      'E5（操作者显式触发真实通道）：未执行 —— 真实私聊发送/群发送只能由操作者触发。',
      '工具 token 数：unavailable —— 无可靠计数器；schemaChars 不能当 token 报。',
      'QQ 侧的 schema 字符数：unavailable —— 需构建它的运行实例；本审计只数名字与顺序。',
    ],
    unavailable: [
      'provider usage / TTFT（本审计不调模型）',
      '工具 token 数（无计数器）',
      'QQ 工具 schema 字符数（未构建运行实例）',
      '宿主按"轮次序号"过滤（when 不提供 turn/step 计数，见 host.perTurn.limits）',
    ],
  };

  for (const internalsKey of ['cognitive', 'engine', 'promptEngine']) {
    try {
      const value = internals?.[internalsKey];
      if (value?.dispose) value.dispose();
      else if (value?.close) await value.close();
    } catch { /* best effort */ }
  }
  if (!keepRoot) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }); } catch { /* best effort */ }
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const lines = [];
  const pad = (text, width) => String(text).padEnd(width).slice(0, width);
  lines.push('=== C1 工具矩阵（真实挂载，char 不是 token）===');
  lines.push(`${pad('name', 32)} ${pad('kind', 6)} ${pad('owner', 22)} ${pad('schema', 7)} ${pad('desc', 6)} params`);
  for (const item of toolItems) {
    lines.push(`${pad(item.name, 32)} ${pad(item.kind, 6)} ${pad(item.registrar, 22)} ${pad(item.schemaChars, 7)} ${pad(item.descriptionChars, 6)} ${item.paramKeys.join(',')}`);
  }
  lines.push(`合计 ${toolItems.length} 个（read ${readTools.length} / write ${writeTools.length}），schema ${totalSchema} 字符 + description ${totalDescription} 字符 = ${totalSchema + totalDescription}`);
  lines.push('');
  lines.push('=== C2 四上下文对比 ===');
  for (const context of report.contexts) {
    lines.push(`[${context.id}] ${context.label}`);
    lines.push(`  注册 ${context.registered.verdict}：${context.registered.detail}`);
    lines.push(`  可见 ${context.visible.verdict}：${context.visible.detail}`);
    lines.push(`  可执行 ${context.executable.verdict}：${context.executable.detail}`);
    lines.push(`  可消费 ${context.consumable.verdict}：${context.consumable.detail}`);
    for (const blocker of context.blockers) lines.push(`  ! ${blocker}`);
  }
  lines.push('');
  lines.push('=== C3 关键场景能力链 ===');
  for (const chain of report.keyScenarios) {
    lines.push(`[${chain.scenario}]`);
    lines.push(`  ${chain.chain}`);
    lines.push(`  结论：${chain.verdict}`);
  }
  lines.push('');
  lines.push('=== C4 宿主能力（只读调查）===');
  lines.push(`按轮过滤：${report.host.perTurn.verdict}（${report.host.perTurn.evidence.join(' | ')}）`);
  lines.push(`按步准入：${report.host.perStepAdmission.verdict}（${report.host.perStepAdmission.evidence.join(' | ')}）`);
  lines.push(`恢复：${report.host.restore.verdict}（${report.host.restore.evidence.join(' | ')}）`);
  lines.push(`增删声明：${report.host.toolAddRemoveDeclaration.verdict}（${report.host.toolAddRemoveDeclaration.evidence.join(' | ')}）`);
  lines.push(`执行层权限：pre-execute ${report.host.executionPermission.verdict.preExecute} / guard ${report.host.executionPermission.verdict.guard} / approval ${report.host.executionPermission.verdict.approval}`);
  lines.push(`结论：${report.host.hostVerdict}`);
  lines.push('');
  lines.push('=== C5 "不调用工具"归因分类（每类都有可验证特征）===');
  for (const row of report.falseCallClassification) {
    lines.push(`- ${row.cause}：${row.verifiable}`);
    lines.push(`  判别：${row.discriminator}`);
  }
  lines.push('');
  lines.push('=== 不可用指标 ===');
  for (const entry of report.unavailable) lines.push(`- ${entry}`);
  lines.push(`证据等级：${report.evidenceLevel}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch(error => {
  process.stderr.write(`tool-audit failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
