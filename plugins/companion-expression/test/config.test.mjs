import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 配置层的验收：三条硬规则逐条钉住。
 *
 *   1. 文件只生成一次，之后绝不静默重写（`npm run setup` 与插件都不得覆盖用户资产）。
 *   2. 坏值落默认并给 warning，而不是「带着错的数字继续跑」。
 *   3. `delivery.stageRoot` 必须仍在 `home/media` 内；越界一律回退并说明。
 *
 * 还有一条只在保存路径上成立：UI 提交的越界值要被**拒绝**（`ok:false`）且不写盘——
 * 静默把一个数改成另一个数，比报错更难排查。
 */

const { loadConfig, saveConfig, normalizeConfig, validateConfig, DEFAULT_CONFIG, writeConfigFile }
  = await import('../src/config.mjs');

/** 一个独立的临时数据根；每个用例自己的，互不影响。 */
function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expression-config-'));
  return {
    root,
    file: path.join(root, 'home', 'expression', 'config.json'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('首次读取会创建配置文件，内容等于默认值', () => {
  const ctx = freshRoot();
  try {
    const result = loadConfig({ file: ctx.file, dataRoot: ctx.root });
    assert.equal(result.exists, false);
    assert.equal(result.created, true);
    assert.equal(fs.existsSync(ctx.file), true);

    const onDisk = JSON.parse(fs.readFileSync(ctx.file, 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(onDisk.schemaVersion, DEFAULT_CONFIG.schemaVersion);
    assert.equal(onDisk.delivery.enabled, false, '对外发送默认必须关');
    assert.equal(onDisk.capture.groupEnabled, false, '群收集默认必须关');
    assert.equal(onDisk.capture.ownerPrivate, true);
    assert.deepEqual(result.warnings, []);
  } finally {
    ctx.cleanup();
  }
});

test('第二次读取不会重写已有文件', () => {
  const ctx = freshRoot();
  try {
    loadConfig({ file: ctx.file, dataRoot: ctx.root });
    // 用户手改：把群收集打开
    const edited = JSON.parse(fs.readFileSync(ctx.file, 'utf8'));
    edited.capture.groupEnabled = true;
    edited.capture.groups = [{ chatId: 1000000003, capture: true, store: true, use: true }];
    fs.writeFileSync(ctx.file, `${JSON.stringify(edited, null, 2)}\n`, 'utf8');
    const before = fs.readFileSync(ctx.file);
    const beforeStat = fs.statSync(ctx.file);

    const second = loadConfig({ file: ctx.file, dataRoot: ctx.root });
    assert.equal(second.exists, true);
    assert.equal(second.created, false);
    assert.equal(second.config.capture.groupEnabled, true);
    assert.equal(second.config.capture.groups.length, 1);

    const after = fs.readFileSync(ctx.file);
    assert.deepEqual(after, before, '已有配置必须逐字节不变');
    assert.equal(fs.statSync(ctx.file).mtimeMs, beforeStat.mtimeMs, '不得悄悄重写 mtime');
  } finally {
    ctx.cleanup();
  }
});

test('坏 JSON → 按默认值运行，原文件字节不变，并给出 warning', () => {
  const ctx = freshRoot();
  try {
    fs.mkdirSync(path.dirname(ctx.file), { recursive: true });
    const broken = '{ "delivery": { "enabled": tru }';
    fs.writeFileSync(ctx.file, broken, 'utf8');
    const result = loadConfig({ file: ctx.file, dataRoot: ctx.root });
    assert.equal(result.config.delivery.enabled, false);
    assert.ok(result.warnings.length >= 1, '必须说明为什么按默认值跑');
    assert.match(result.warnings[0], /不是合法 JSON/);
    assert.equal(fs.readFileSync(ctx.file, 'utf8'), broken, '解析失败不得改动用户文件');
  } finally {
    ctx.cleanup();
  }
});

test('stageRoot 越界（home/media 之外）→ 回退默认并给 warning', () => {
  const ctx = freshRoot();
  try {
    fs.mkdirSync(path.dirname(ctx.file), { recursive: true });
    const config = normalizeConfig(DEFAULT_CONFIG).config;
    config.delivery.stageRoot = '../../etc/expression-out';
    fs.writeFileSync(ctx.file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const result = loadConfig({ file: ctx.file, dataRoot: ctx.root });
    assert.equal(result.config.delivery.stageRoot, DEFAULT_CONFIG.delivery.stageRoot);
    assert.ok(result.warnings.some((line) => line.includes('stageRoot')), '越界必须被说出来');
  } finally {
    ctx.cleanup();
  }
});

test('白名单内的 stageRoot 被原样接受', () => {
  const ctx = freshRoot();
  try {
    fs.mkdirSync(path.dirname(ctx.file), { recursive: true });
    const config = normalizeConfig(DEFAULT_CONFIG).config;
    config.delivery.stageRoot = 'home/media/expression-out';
    fs.writeFileSync(ctx.file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const result = loadConfig({ file: ctx.file, dataRoot: ctx.root });
    assert.equal(result.config.delivery.stageRoot, 'home/media/expression-out');
    assert.equal(result.warnings.filter((line) => line.includes('stageRoot')).length, 0);
  } finally {
    ctx.cleanup();
  }
});

test('保存越界值被拒绝，且不写盘', () => {
  const ctx = freshRoot();
  try {
    loadConfig({ file: ctx.file, dataRoot: ctx.root });
    const before = fs.readFileSync(ctx.file);
    const outcome = saveConfig({
      file: ctx.file,
      dataRoot: ctx.root,
      raw: { ...DEFAULT_CONFIG, delivery: { ...DEFAULT_CONFIG.delivery, maxPerTurn: 5 } },
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /maxPerTurn/);
    assert.deepEqual(fs.readFileSync(ctx.file), before, '被拒绝的保存不得留下半个文件');
  } finally {
    ctx.cleanup();
  }
});

test('保存合法值会落盘；请求里没打开的开关保持关闭（未知字段被丢弃）', () => {
  const ctx = freshRoot();
  try {
    const outcome = saveConfig({
      file: ctx.file,
      dataRoot: ctx.root,
      raw: {
        enabled: true,
        capture: { ownerPrivate: true, groupEnabled: true, groups: [{ chatId: 1000000003, capture: true, store: true, use: true }] },
        delivery: { enabled: false, stageRoot: 'home/media/expression-out' },
      },
    });
    assert.equal(outcome.ok, true);
    const onDisk = JSON.parse(fs.readFileSync(ctx.file, 'utf8'));
    assert.equal(onDisk.capture.groupEnabled, true);
    assert.equal(onDisk.capture.groups[0].chatId, 1000000003);
    assert.equal(onDisk.delivery.enabled, false, '没在请求里打开的开关必须保持关闭');
  } finally {
    ctx.cleanup();
  }
});

test('saveConfig 拒绝非对象与非法 chatId', () => {
  const ctx = freshRoot();
  try {
    loadConfig({ file: ctx.file, dataRoot: ctx.root });
    const notObject = saveConfig({ file: ctx.file, dataRoot: ctx.root, raw: [] });
    assert.equal(notObject.ok, false);
    const badGroup = saveConfig({
      file: ctx.file, dataRoot: ctx.root,
      raw: { capture: { groups: [{ chatId: 'abc', capture: true }] } },
    });
    assert.equal(badGroup.ok, false);
    assert.match(badGroup.error, /chatId/);
  } finally {
    ctx.cleanup();
  }
});

test('normalizeConfig 对越界数值钳制并把 cloudVision 与 host-vision 的矛盾说出来', () => {
  const { config, warnings } = normalizeConfig({
    capture: { maxDownloadBytes: 1 },
    delivery: { maxPerTurn: 9, dmCooldownSeconds: -3 },
    analysis: { mode: 'host-vision' },
  });
  assert.equal(config.capture.maxDownloadBytes, 64 * 1024, '低于下限必须抬到下限');
  assert.equal(config.delivery.maxPerTurn, 3, '高于上限必须压到上限');
  assert.equal(config.delivery.dmCooldownSeconds, 0);
  assert.equal(config.capture.cloudVision, 'deny', 'cloudVision 非法值回退 deny');
  assert.ok(warnings.some((line) => line.includes('host-vision')), '矛盾组合必须报告');
});

test('未知枚举值一律回退默认，不抛', () => {
  const { config } = normalizeConfig({ capture: { uncertain: 'whatever', privatePeers: 'maybe' }, analysis: { mode: 'gpt' } });
  assert.equal(config.capture.uncertain, DEFAULT_CONFIG.capture.uncertain);
  assert.equal(config.capture.privatePeers, DEFAULT_CONFIG.capture.privatePeers);
  assert.equal(config.analysis.mode, DEFAULT_CONFIG.analysis.mode);
});

test('validateConfig 接受默认配置', () => {
  const checked = validateConfig(normalizeConfig(DEFAULT_CONFIG).config);
  assert.equal(checked.ok, true);
});

test('writeConfigFile 是原子的：目标目录不存在时也能写成功', () => {
  const ctx = freshRoot();
  try {
    const nested = path.join(ctx.root, 'deep', 'nested', 'config.json');
    writeConfigFile(nested, normalizeConfig(DEFAULT_CONFIG).config);
    assert.equal(fs.existsSync(nested), true);
    assert.deepEqual(fs.readdirSync(path.dirname(nested)).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    ctx.cleanup();
  }
});
