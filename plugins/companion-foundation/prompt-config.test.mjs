import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadPromptConfig,
  sanitizePromptConfig,
  effectivePromptMode,
  promptConfigFile,
  thinkingModeFor,
  DEFAULT_PROMPT_CONFIG,
} from './prompt-config.mjs';

// 配置是整条链路的开关。这里的每一条断言都对应任务书 §10 / §14.1 的一条要求：
// 默认关闭、非法配置安全降级、预算有上限、绝不创建或覆盖文件。

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  fs.mkdirSync(path.join(root, 'home/companion'), { recursive: true });
  return root;
}

function writeConfig(root, value) {
  fs.writeFileSync(promptConfigFile(root), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

test('默认关闭：没有配置文件时 enabled=false、mode=off，且不创建任何文件', t => {
  const root = tempRoot(t);
  const { config, file, error, warnings } = loadPromptConfig(root, { env: {} });
  assert.equal(config.enabled, false);
  assert.equal(config.mode, 'off');
  assert.equal(effectivePromptMode(config), 'off');
  assert.equal(file, path.join(root, 'home/companion/prompt-engine.config.json'));
  assert.equal(error, '');
  assert.deepEqual(warnings, []);
  assert.equal(fs.existsSync(file), false, '读取配置不得创建文件');
});

test('默认值与任务书 §10 的默认配置逐字一致', () => {
  assert.equal(DEFAULT_PROMPT_CONFIG.schemaVersion, 1);
  assert.equal(DEFAULT_PROMPT_CONFIG.enabled, false);
  assert.equal(DEFAULT_PROMPT_CONFIG.mode, 'off');
  assert.equal(DEFAULT_PROMPT_CONFIG.interactionMode, 'auto');
  assert.deepEqual({ ...DEFAULT_PROMPT_CONFIG.thinkingMode }, { chat: 'guided', companion: 'guided', roleplay: 'guided', task: 'guided' });
  assert.deepEqual({ ...DEFAULT_PROMPT_CONFIG.budgets }, { chat: 600, companion: 800, roleplay: 1300, task: 500 });
  assert.equal(DEFAULT_PROMPT_CONFIG.planner.enabled, false);
  assert.equal(DEFAULT_PROMPT_CONFIG.planner.maxInputChars, 8000);
  assert.equal(DEFAULT_PROMPT_CONFIG.planner.maxOutputTokens, 800);
  assert.equal(DEFAULT_PROMPT_CONFIG.planner.timeoutMs, 20000);
  assert.equal(DEFAULT_PROMPT_CONFIG.planner.maxCallsPerTurn, 1);
  assert.equal(DEFAULT_PROMPT_CONFIG.review.enabled, false);
  assert.equal(DEFAULT_PROMPT_CONFIG.review.maxRepairCalls, 1);
});

test('enabled:false 拥有最高关闭优先级，任何 mode 都复活不了它', () => {
  const { config } = sanitizePromptConfig({ enabled: false, mode: 'active' });
  assert.equal(config.enabled, false);
  assert.equal(config.mode, 'off');
  assert.equal(effectivePromptMode(config), 'off');
});

test('非法 JSON 安全降级为默认值并留下 warning，不抛错', t => {
  const root = tempRoot(t);
  writeConfig(root, '{ this is not json');
  const { config, error, warnings } = loadPromptConfig(root, { env: {} });
  assert.equal(config.enabled, false);
  assert.equal(effectivePromptMode(config), 'off');
  assert.match(error, /read-failed|json|JSON/i);
  assert.ok(warnings.length >= 1);
  // 文件原样保留：引擎永不覆盖用户配置。
  assert.equal(fs.readFileSync(promptConfigFile(root), 'utf8'), '{ this is not json');
});

test('顶层不是对象时按默认值运行', t => {
  const root = tempRoot(t);
  writeConfig(root, [1, 2, 3]);
  const { config, warnings } = loadPromptConfig(root, { env: {} });
  assert.equal(config.mode, 'off');
  assert.ok(warnings.some(warning => /顶层不是对象/.test(warning)));
});

test('非法 interactionMode / thinkingMode 回落默认值并记录 warning', t => {
  const { config, warnings } = sanitizePromptConfig({
    enabled: true, mode: 'active',
    interactionMode: 'novel',
    thinkingMode: { chat: 'deep', companion: 'strict', roleplay: 'weird', task: 'guided' },
  });
  assert.equal(config.interactionMode, 'auto');
  assert.equal(config.thinkingMode.chat, 'guided');
  assert.equal(config.thinkingMode.roleplay, 'guided');
  assert.equal(config.thinkingMode.companion, 'strict', '合法值保留');
  assert.ok(warnings.length >= 3);
});

test('预算上限有效：越界被夹到 [120, 4000]，非法取默认值', () => {
  const { config } = sanitizePromptConfig({
    enabled: true, mode: 'active',
    budgets: { chat: 5, companion: 99999, roleplay: 'lots', task: 500 },
  });
  assert.equal(config.budgets.chat, 120);
  assert.equal(config.budgets.companion, 4000);
  assert.equal(config.budgets.roleplay, 1300, '非法值取默认值');
  assert.equal(config.budgets.task, 500);
});

test('planner 调用上限被夹到 1..2，并说明原因', () => {
  const { config, warnings } = sanitizePromptConfig({ enabled: true, mode: 'active', planner: { enabled: true, maxCallsPerTurn: 9 } });
  assert.equal(config.planner.maxCallsPerTurn, 2);
  assert.ok(warnings.some(warning => /maxCallsPerTurn/.test(warning)));
  assert.equal(sanitizePromptConfig({ planner: { maxCallsPerTurn: 0 } }).config.planner.maxCallsPerTurn, 1);
});

test('文件里的嵌套对象不会把默认值吃掉一半', t => {
  const root = tempRoot(t);
  writeConfig(root, { enabled: true, mode: 'active', planner: { enabled: true } });
  const { config } = loadPromptConfig(root, { env: {} });
  assert.equal(config.planner.enabled, true);
  assert.equal(config.planner.maxInputChars, 8000, '未写的子键仍取默认值');
  assert.equal(config.planner.timeoutMs, 20000);
  assert.deepEqual({ ...config.budgets }, { chat: 600, companion: 800, roleplay: 1300, task: 500 });
});

test('合法配置生效：active 模式与自定义预算', t => {
  const root = tempRoot(t);
  writeConfig(root, {
    schemaVersion: 1, enabled: true, mode: 'active', interactionMode: 'companion',
    budgets: { chat: 500, companion: 700, roleplay: 1200, task: 400 },
    modules: { disabled: ['style.universal', 'style.universal', '  style.anti-deepseek  '] },
  });
  const { config, warnings } = loadPromptConfig(root, { env: {} });
  assert.equal(effectivePromptMode(config), 'active');
  assert.equal(config.interactionMode, 'companion');
  assert.equal(config.budgets.roleplay, 1200);
  assert.deepEqual(config.modules.disabled, ['style.universal', 'style.anti-deepseek'], '去重并 trim');
  assert.deepEqual(warnings, []);
});

test('shadow 模式只算不注入，仍是"启用"状态', t => {
  const root = tempRoot(t);
  writeConfig(root, { enabled: true, mode: 'shadow' });
  const { config } = loadPromptConfig(root, { env: {} });
  assert.equal(config.enabled, true);
  assert.equal(effectivePromptMode(config), 'shadow');
});

test('DSH_COMPANION_PROMPT_ENGINE 覆盖文件：active / shadow / off', t => {
  const root = tempRoot(t);
  writeConfig(root, { enabled: true, mode: 'shadow' });
  assert.equal(effectivePromptMode(loadPromptConfig(root, { env: { DSH_COMPANION_PROMPT_ENGINE: 'active' } }).config), 'active');
  assert.equal(effectivePromptMode(loadPromptConfig(root, { env: { DSH_COMPANION_PROMPT_ENGINE: '1' } }).config), 'active');
  assert.equal(effectivePromptMode(loadPromptConfig(root, { env: { DSH_COMPANION_PROMPT_ENGINE: 'shadow' } }).config), 'shadow');
  assert.equal(effectivePromptMode(loadPromptConfig(root, { env: { DSH_COMPANION_PROMPT_ENGINE: '0' } }).config), 'off');
  // 无关取值不改变任何东西
  assert.equal(effectivePromptMode(loadPromptConfig(root, { env: { DSH_COMPANION_PROMPT_ENGINE: 'maybe' } }).config), 'shadow');
});

test('thoughtMode 取场景值，未知场景回落 chat', () => {
  const { config } = sanitizePromptConfig({ enabled: true, mode: 'active', thinkingMode: { roleplay: 'structured' } });
  assert.equal(thinkingModeFor(config, 'roleplay'), 'structured');
  assert.equal(thinkingModeFor(config, 'chat'), 'guided');
  assert.equal(thinkingModeFor(config, 'nonsense'), 'guided');
});

test('没有 root 时不读文件，只用默认值（可安全用于纯单元测试）', () => {
  const { config, file } = loadPromptConfig(null, { env: {} });
  assert.equal(file, '');
  assert.equal(config.enabled, false);
});

test('配置文件不会被写入或改动（读取是只读的）', t => {
  const root = tempRoot(t);
  const original = JSON.stringify({ enabled: true, mode: 'active', budgets: { chat: 1 } });
  writeConfig(root, original);
  const before = fs.statSync(promptConfigFile(root)).mtimeMs;
  loadPromptConfig(root, { env: {} });
  loadPromptConfig(root, { env: { DSH_COMPANION_PROMPT_ENGINE: 'off' } });
  assert.equal(fs.readFileSync(promptConfigFile(root), 'utf8'), original);
  assert.equal(fs.statSync(promptConfigFile(root)).mtimeMs, before);
});
