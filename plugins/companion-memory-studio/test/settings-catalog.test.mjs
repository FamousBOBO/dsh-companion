import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogFromQQ } from '../lib/settings-catalog.mjs';

// W1 前置：设置字段目录的「唯一 owner」判据（计划 W1 验收项之一）。
//
// 现状是同一批 21 个可写键散在三处（write.mjs SETTINGS_SPEC / read.mjs editableView /
// pages-settings.js FIELDS），三者的「一致」过去只写在注释里。这个用例把注释变成断言：
// 任何一处漂移（加键只改一边、密钥混进可读目录、客户端字段缺渲染元数据）都会红。
//
// 具体核对逻辑住在 scripts/check-settings-catalog.mjs，这里只是把它当子进程跑一遍，
// 因为该脚本按行解析源码文本，用独立进程跑可以保证它读到的是磁盘上的当前内容。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-settings-catalog.mjs');

test('setting field catalog stays single-sourced across write, read and client', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `目录核对失败：\n${result.stdout}\n${result.stderr}`);

  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.problems, []);

  // 三份可写键集合必须逐个相同，不是「数量相同」。顺序无关（三处的排列理由各不同：
  // 服务端按校验分组、客户端按页面分区），所以比集合而不是比数组。
  const asSet = (list) => [...list].sort();
  assert.deepEqual(asSet(summary.keys.writeSpec), asSet(summary.keys.clientFields));
  assert.deepEqual(asSet(summary.keys.writeSpec), asSet(summary.keys.readView));

  // 只写密钥一个都不许出现在任何可读目录里（GET 永不返回明文）。
  for (const key of summary.keys.secrets) {
    assert.ok(!summary.keys.writeSpec.includes(key), `${key} 不该出现在 SETTINGS_SPEC`);
    assert.ok(!summary.keys.clientFields.includes(key), `${key} 不该出现在客户端 FIELDS`);
    assert.ok(!summary.keys.readView.includes(key), `${key} 不该出现在 editableView`);
  }
});

test('catalog check reports the expected key counts so a silent shrink is visible', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8' });
  const summary = JSON.parse(result.stdout);
  // 数的意义：项目缩水（比如有人「顺手删掉」一个设置项）应当被发现，而不是悄悄通过。
  assert.equal(summary.counts.writeSpec, 21);
  assert.equal(summary.counts.readView, 21);
  assert.equal(summary.counts.clientFields, 21);
  assert.equal(summary.counts.writeOnlySecrets, 2);
});
// ── 审查报告 M4 的回归点 ────────────────────────────────────────────────────

test('a write-only secret that IS in the config layer reports secret-set, not secret-unset (M4)', () => {
  const refs = [
    { path: 'onebot.accessToken', section: 'onebot', page: 'connections', spec: { label: '访问令牌', secret: true, hot: 'reload' } },
    { path: 'chat.replyRate', section: 'chat', page: 'chat', spec: { label: '回复概率', hot: 'live' } },
  ];
  // 密钥出现在 override 层 → 已设置（不可读，但存在这件事可证明）。
  const withSecret = catalogFromQQ(refs, {
    overridePaths: new Set(['onebot.accessToken']),
    patchPaths: new Set(['chat.replyRate']),
  });
  const token = withSecret.find((entry) => entry.path === 'onebot.accessToken');
  assert.equal(token.status, 'secret-set', '已配置的只写密钥不能报「未设置」');
  const rate = withSecret.find((entry) => entry.path === 'chat.replyRate');
  assert.equal(rate.status, 'configured');

  // 真的没出现 → 未设置。
  const withoutSecret = catalogFromQQ(refs, { overridePaths: new Set(), patchPaths: new Set(['chat.replyRate']) });
  const missing = withoutSecret.find((entry) => entry.path === 'onebot.accessToken');
  assert.equal(missing.status, 'secret-unset');

  // 两层都拿不到：密钥的"有没有"证明不了 → 未知（不猜）。
  const blind = catalogFromQQ(refs, {});
  const unknown = blind.find((entry) => entry.path === 'onebot.accessToken');
  assert.equal(unknown.status, 'unknown');
});
