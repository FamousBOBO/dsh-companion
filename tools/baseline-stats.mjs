#!/usr/bin/env node
/**
 * G0 基线统计（脱敏、无正文）。
 *
 * 目的：把「当前这一版代码+配置实际长什么样」变成可复现的数字，而不是引用旧抓包的
 * 5,881 字符 / 46 工具 / 26,621 字符。三项口径固定：
 *
 *   1. System Prompt 每个 Section 的**字符数**与名字（不含正文）；
 *   2. 每个工具的名字、参数 Schema 与描述字符数（不含描述正文）；
 *   3. 记忆注入口径（合成根预算为 0，因此这一轮天然为 0；不测召回质量）。
 *
 * 硬口径：
 *   * 不打印任何 Section 正文、工具描述正文、记忆正文、聊天内容；
 *   * 不写生产数据目录：mount 跑在 os.tmpdir() 的合成根上；
 *   * 拿不到的指标写 unavailable 并给原因，不写 0 冒充"没有"。
 *
 * 用法：node tools/baseline-stats.mjs [--json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SUITE_ROOT = path.resolve(here, '..');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

/** 只算长度，不回正文。 */
const chars = value => (typeof value === 'string' ? value.length : 0);

/**
 * 合成根：一个能挂载 foundation 的最小目录树。
 * 刻意不读 DSH_HOME：统计不该碰用户真实数据目录。
 */
function syntheticRoot(personaId = 'bot') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-stats-'));
  for (const dir of ['workspace', 'logs', 'home/memory', 'home/companion', 'home/channel-qq']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1, persona: personaId,
    owner: { id: '10001', displayName: 'fixture', platform: 'qq' },
    desktop: { mode: 'local-owner', userId: '10001' },
    sessions: {},
  }));
  fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), '# baseline\n\n合成人格正文，仅用于统计。\n');
  fs.writeFileSync(path.join(root, 'home/companion/memory.config.json'), JSON.stringify({
    schemaVersion: 1, backend: 'sqlite',
    injection: { budgetChars: 0 },
    extraction: { enabled: false, minMessages: 3, maxMessages: 20 },
    embedding: { provider: 'local', dimensions: 8 },
    wiki: { enabled: false, dir: 'home/memory/wiki', autoCompile: false, minIntervalMs: 0 },
  }));
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: false, mode: 'off', timeZone: 'Asia/Shanghai',
  }));
  return root;
}

/** 采集 Sections：`text` 可能是字符串或函数，只取长度。 */
function collectSections(ctxSections) {
  return ctxSections.map(entry => {
    let textLength = 0;
    let kind = 'string';
    try {
      if (typeof entry.text === 'function') {
        kind = 'function';
        textLength = chars(entry.text());
      } else {
        textLength = chars(entry.text);
      }
    } catch {
      kind = 'threw';
      textLength = 0;
    }
    return { name: String(entry.name ?? ''), order: Number(entry.order) || 0, kind, chars: textLength };
  }).sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
}

/** 工具：名字 + 参数 schema 与描述的**字符数**，不保留描述正文。 */
function collectTools(tools) {
  return [...tools.values()].map(tool => {
    const parameters = tool.parameters ?? tool.inputSchema ?? {};
    return {
      name: String(tool.name ?? ''),
      descriptionChars: chars(tool.description),
      schemaChars: JSON.stringify(parameters).length,
      schemaKeys: Object.keys(parameters?.properties ?? {}).length,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

async function main() {
  const { resolveModuleRoot } = await import(pathToFileURL(path.join(SUITE_ROOT, 'plugins/companion-foundation/test-fixtures/module-root.mjs')).href);
  const resolvedModuleRoot = resolveModuleRoot(SUITE_ROOT, process.env);
  process.env.DSH_COMPANION_MODULE_ROOT = resolvedModuleRoot.root;

  // The plugin (and the identity provisioner under it) logs with `console.log`, including from a
  // deferred callback that runs **after** the mount returns. On `--json` that noise would land in
  // stdout and make the report unparsable, so stdout is reserved for the report for the whole
  // process lifetime and every log line is forwarded to stderr instead — captured, never dropped,
  // because a silent script would hide a failed mount.
  if (asJson) {
    console.log = (...args) => { process.stderr.write(`${args.map(String).join(' ')}\n`); };
  }

  const { resolveSuitePaths } = await import(pathToFileURL(path.join(SUITE_ROOT, 'plugins/companion-foundation/suite-paths.mjs')).href);
  const suitePaths = resolveSuitePaths({});
  const { mountCompanion } = await import(pathToFileURL(path.join(SUITE_ROOT, 'plugins/companion-foundation/index.mjs')).href);
  const root = syntheticRoot(suitePaths.personaId ?? 'bot');
  const sections = [];
  const tools = new Map();
  const hooks = new Map();

  let internals = null;
  try {
    internals = mountCompanion({
      tools: { register: tool => tools.set(tool.name, tool) },
      systemPrompt: { section: descriptor => sections.push(descriptor) },
      on(name, handler) { hooks.set(name, handler); },
      get() { return undefined; },
    }, root, { suitePaths });
  } catch (error) {
    // A mount failure must be reported, not swallowed: it means the numbers below would describe
    // nothing. The report still runs so the failure is visible in the same shape as a success.
    process.stderr.write(`baseline-stats: mount failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  const sectionStats = collectSections(sections);
  const toolStats = collectTools(tools);
  const totalSectionChars = sectionStats.reduce((sum, item) => sum + item.chars, 0);
  const totalToolChars = toolStats.reduce((sum, item) => sum + item.schemaChars + item.descriptionChars, 0);

  const report = {
    generatedAt: new Date().toISOString(),
    suiteRoot: path.basename(SUITE_ROOT),
    moduleRootSource: resolvedModuleRoot.source,
    syntheticRootUsed: true,
    honesty: {
      note: '所有正文一律不采集；只保留长度。Section 文本为函数时按当前调用返回长度，'
        + 'runtime/cognitive 未挂载时为 0，属"未启用"而非"没有这段"。',
    },
    systemPrompt: {
      sectionCount: sectionStats.length,
      totalChars: totalSectionChars,
      sections: sectionStats,
      displaced: 'none',
    },
    tools: {
      count: toolStats.length,
      totalChars: totalToolChars,
      totalSchemaChars: toolStats.reduce((sum, item) => sum + item.schemaChars, 0),
      totalDescriptionChars: toolStats.reduce((sum, item) => sum + item.descriptionChars, 0),
      heaviest: [...toolStats]
        .sort((left, right) => (right.schemaChars + right.descriptionChars) - (left.schemaChars + left.descriptionChars))
        .slice(0, 8),
      items: toolStats,
    },
    // 记忆注入量：合成根预算为 0 ⇒ 这一轮天然为 0；如实标注口径。
    memory: {
      injectionBudgetChars: 0,
      candidatesInjected: 0,
      reason: '合成根把 injection.budgetChars 设为 0：本统计只测"结构与体积"，不测召回质量',
    },
    unavailable: ['provider usage', 'TTFT'],
  };

  try { internals?.cognitive?.dispose?.(); } catch { /* already gone */ }
  try { await internals?.engine?.close?.(); } catch { /* already closed */ }
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const lines = [];
  lines.push('=== System Prompt Sections（只报长度）===');
  for (const item of sectionStats) lines.push(`  ${String(item.chars).padStart(6)}  ${item.name.padEnd(30)} ${item.kind}`);
  lines.push(`  合计 ${totalSectionChars} 字符 / ${sectionStats.length} 段`);
  lines.push('');
  lines.push(`=== 工具清单（${toolStats.length} 个，共 ${totalToolChars} 字符）===`);
  for (const item of report.tools.heaviest) {
    lines.push(`  ${String(item.schemaChars + item.descriptionChars).padStart(6)}  ${item.name.padEnd(36)} schema ${item.schemaChars} + desc ${item.descriptionChars}`);
  }
  lines.push('');
  lines.push(`moduleRoot 来源：${report.moduleRootSource}`);
  lines.push('不可用指标：provider usage / TTFT（宿主未暴露计数器）');
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch(error => {
  process.stderr.write(`baseline-stats failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
