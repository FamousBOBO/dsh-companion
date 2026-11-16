import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walkDotPaths, qqLayerPaths, studioLayerPaths } from '../lib/settings-catalog-route.mjs';
import { catalogFromQQ, searchCatalog } from '../lib/settings-catalog.mjs';

// W1-3：设置搜索的服务端接线。这里只测**纯函数与投影**，不起 HTTP、不碰真实 data 目录。

test('walkDotPaths flattens nested objects and treats arrays as single leaves', () => {
  const out = new Set();
  walkDotPaths({ a: { b: 1, c: { d: true } }, list: [1, 2], empty: null }, '', out);
  assert.deepEqual([...out].sort(), ['a.b', 'a.c.d', 'empty', 'list']);
  // 数组整体是叶子：配置里数组是整值替换，没有「逐字段合并」这回事。
  assert.equal(out.has('list.0'), false);
});

test('qqLayerPaths reads override layer and degrades to null patch layer without yaml', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-layers-'));
  try {
    const home = path.join(root, 'home', 'channel-qq');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'admin-config.json'), JSON.stringify({
      talkValue: 0.5,
      segmentation: { maxSegments: 3 },
      presence: { ambientTtlMs: 90000 },
      keywordReactions: [{ keywords: ['a'], reaction: 'b' }],
    }));
    const suite = path.join(root, 'suite');
    fs.mkdirSync(path.join(suite, 'config', 'profile'), { recursive: true });
    fs.writeFileSync(path.join(suite, 'package.json'), JSON.stringify({ name: 'dsh-companion-suite' }));

    const savedEnv = process.env.DSH_COMPANION_MODULE_ROOT;
    delete process.env.DSH_COMPANION_MODULE_ROOT;
    const layers = qqLayerPaths(root, suite);
    assert.deepEqual([...layers.overridePaths].sort(), [
      'keywordReactions', 'presence.ambientTtlMs', 'segmentation.maxSegments', 'talkValue',
    ]);
    // 没有 yaml 时 patch 层不存在——目录会把状态退成「只看 override」，不编造 patch。
    assert.equal(layers.patchPaths, null);
    if (savedEnv !== undefined) process.env.DSH_COMPANION_MODULE_ROOT = savedEnv;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('studioLayerPaths reads memory.config.json and returns empty set when missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-studio-'));
  try {
    assert.equal(studioLayerPaths(root).size, 0);
    const dir = path.join(root, 'home', 'companion');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory.config.json'), JSON.stringify({
      retrieval: { topK: 6, semanticEnabled: true },
      rerank: { enabled: false },
    }));
    assert.deepEqual([...studioLayerPaths(root)].sort(), [
      'rerank.enabled', 'retrieval.semanticEnabled', 'retrieval.topK',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('override layer presence flips a field from default to configured in a live search', () => {
  const refs = [
    { path: 'talkValue', section: null, page: 'groups', spec: { kind: 'number', default: 0.6, label: '群聊回复概率', hot: 'live' } },
    { path: 'flood.enabled', section: 'flood', page: 'flood', spec: { kind: 'boolean', default: true, label: '启用', hot: 'live' } },
  ];
  const entries = catalogFromQQ(refs, { overridePaths: new Set(['talkValue']), patchPaths: new Set() });
  const hit = searchCatalog(entries, '群聊回复概率').matches[0];
  assert.equal(hit.id, 'qq:talkValue');
  assert.equal(hit.status, 'configured');
  const untouched = searchCatalog(entries, '风控').matches[0];
  assert.equal(untouched.status, 'default');
});
