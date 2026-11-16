import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_META_KEYS, HOT_LEVELS, STATUSES, PERMISSIONS,
  catalogFromQQ, catalogFromStudio, keywordsOf, normalizeText,
  searchCatalog, toMetaView,
} from '../lib/settings-catalog.mjs';

// W1-2：唯一字段注册目录。这个目录**不存字段清单**（它是 QQ schema 与 Studio spec 的投影），
// 所以测试的重点是「投影是否忠实、搜索是否可解释」，而不是「清单里有没有某个键」。

const QQ_FIXTURE = [
  {
    path: 'talkValue', section: null, page: 'groups',
    spec: { kind: 'number', default: 0.6, label: '群聊回复概率', hot: 'live', help: '主群可单独覆盖。' },
  },
  {
    path: 'requireMention', section: null, page: 'groups',
    spec: { kind: 'boolean', default: true, label: '群里必须 @ 才理', hot: 'live' },
  },
  {
    path: 'accessToken', section: null, page: 'connection',
    spec: { kind: 'string', label: '访问令牌', secret: true, hot: 'reload' },
  },
  {
    path: 'maxMessageLength', section: null, page: 'messages',
    spec: { kind: 'number', default: 4000, label: '单条消息上限', hot: 'live', dormant: true },
  },
  {
    path: 'flood.enabled', section: 'flood', page: 'flood',
    spec: { kind: 'boolean', default: true, label: '启用', hot: 'live' },
  },
];

const STUDIO_SPEC = {
  backend: { section: null, key: 'backend', check: () => true },
  topK: { section: 'retrieval', key: 'topK', check: () => true },
};
const STUDIO_SECRET = { embeddingApiKey: 'embedding', rerankApiKey: 'rerank' };
const STUDIO_CLIENT = {
  backend: { section: 'storage', label: '存储后端', control: 'select', path: 'backend', hint: '回滚不同步新库内容' },
  topK: { section: 'retrieval', label: '每轮召回条数', control: 'integer', path: 'retrieval.topK', hint: '' },
};

test('catalog projects QQ schema into the mandated meta shape', () => {
  const entries = catalogFromQQ(QQ_FIXTURE);
  assert.equal(entries.length, QQ_FIXTURE.length);
  for (const entry of entries) {
    const meta = toMetaView(entry);
    assert.deepEqual(Object.keys(meta), [...CATALOG_META_KEYS]);
    assert.ok(HOT_LEVELS.includes(meta.hotLevel), meta.hotLevel);
    assert.ok(STATUSES.includes(meta.status), meta.status);
    assert.ok(PERMISSIONS.includes(meta.permission), meta.permission);
    assert.ok(meta.keywords.length > 0);
    assert.match(meta.id, /^qq:/);
  }
  // 未标注 hot 的字段按保守口径落到 restart，与 schema 的元数据约定一致。
  assert.equal(entries.find((e) => e.id === 'qq:talkValue').hotLevel, 'live');
  // secret / dormant 必须原样透传，不能因为「目录里看不到值」就丢掉标记。
  const token = entries.find((e) => e.id === 'qq:accessToken');
  assert.equal(token.secret, true);
  // 没有任何配置层视图时，只写密钥的「有没有」证明不了 → unknown（不猜）。
  // 旧实现在这里恒回 secret-unset，于是"已配置的密钥永远显示未设置"（M4）。
  assert.equal(token.status, 'unknown');
  assert.equal(entries.find((e) => e.id === 'qq:maxMessageLength').dormant, true);
});

test('catalog marks status from layer presence instead of guessing', () => {
  const override = new Set(['talkValue']);
  const patch = new Set(['requireMention']);
  const entries = catalogFromQQ(QQ_FIXTURE, { overridePaths: override, patchPaths: patch });
  assert.equal(entries.find((e) => e.id === 'qq:talkValue').status, 'configured');
  assert.equal(entries.find((e) => e.id === 'qq:requireMention').status, 'configured');
  assert.equal(entries.find((e) => e.id === 'qq:flood.enabled').status, 'default');
  // 拿不到层信息时必须回 unknown，不能写 default（那是谎报「没被改过」）。
  const blind = catalogFromQQ(QQ_FIXTURE);
  assert.equal(blind.find((e) => e.id === 'qq:flood.enabled').status, 'unknown');
  // 模块未装载时整片 unavailable，且优先级高于 configured/default。
  const off = catalogFromQQ(QQ_FIXTURE, { overridePaths: override, moduleAvailable: false });
  assert.equal(off.every((e) => e.status === 'unavailable' && e.available === false), true);
});

test('studio catalog keeps the host permission verdict and marks secrets as write-only', () => {
  const entries = catalogFromStudio(STUDIO_SPEC, STUDIO_SECRET, STUDIO_CLIENT, {
    overridePaths: new Set(['retrieval.topK']),
    secretSet: { embeddingApiKey: true },
  });
  assert.equal(entries.length, 4);
  const topK = entries.find((e) => e.id === 'studio:topK');
  assert.equal(topK.status, 'configured');
  assert.equal(topK.hotLevel, 'restart');
  // Studio 设置路由没有 viewer 判定（docs/25 §3.5.1 实测），所以是 host 不是 owner。
  assert.equal(topK.permission, 'host');
  const emb = entries.find((e) => e.id === 'studio:embeddingApiKey');
  assert.equal(emb.secret, true);
  assert.equal(emb.status, 'secret-set');
  const rerank = entries.find((e) => e.id === 'studio:rerankApiKey');
  assert.equal(rerank.status, 'secret-unset');
  // 只写密钥的搜索路径用 secrets.* 而不是真实配置文件路径，避免前端误当可读字段。
  assert.equal(emb.path, 'secrets.embeddingApiKey');
});

test('search ranks label matches above description matches and is stable', () => {
  const entries = [...catalogFromQQ(QQ_FIXTURE), ...catalogFromStudio(STUDIO_SPEC, STUDIO_SECRET, STUDIO_CLIENT)];
  const hit = searchCatalog(entries, '群聊回复概率');
  assert.equal(hit.matches[0].id, 'qq:talkValue');
  assert.equal(hit.query, '群聊回复概率');
  assert.equal(hit.returned, hit.matches.length);

  // 别名表让「回复概率」这种说法也能命中同一字段（别名只影响搜索，不影响写入）。
  const alias = searchCatalog(entries, '回复概率');
  assert.ok(alias.matches.some((m) => m.id === 'qq:talkValue'), '别名应命中原字段');

  // 空查询不是错误：回稳定列表，且过滤掉不可用项。
  const empty = searchCatalog(entries, '');
  assert.equal(empty.total, entries.filter((e) => e.status !== 'unavailable').length);
  assert.equal(empty.matches.every((m) => m.status !== 'unavailable'), true);
});

test('search returns nothing for a non-matching query and never throws on junk input', () => {
  const entries = catalogFromQQ(QQ_FIXTURE);
  const miss = searchCatalog(entries, '完全不存在的词xyz');
  assert.equal(miss.total, 0);
  assert.equal(miss.matches.length, 0);
  for (const junk of [null, undefined, 0, {}, [], '   ']) {
    assert.doesNotThrow(() => searchCatalog(entries, junk), String(junk));
  }
  // limit 只裁剪结果，不改 total（前端需要知道「还有多少条没显示」）。
  const limited = searchCatalog(entries, '启用', { limit: 1 });
  assert.equal(limited.matches.length, 1);
  assert.equal(limited.returned, 1);
});

test('keyword and text helpers are deterministic and idempotent', () => {
  assert.equal(normalizeText('  群聊 回复 概率 '), '群聊回复概率');
  assert.equal(normalizeText('embedding.baseUrl'), 'embeddingbaseurl');
  const once = keywordsOf({ id: 'x', label: '群聊回复概率', path: 'talkValue', section: null, aliases: ['回复概率'] });
  const twice = keywordsOf({ id: 'x', label: '群聊回复概率', path: 'talkValue', section: null, aliases: ['回复概率', '群聊回复概率'] });
  assert.deepEqual(once, twice, '重复输入不应产生重复关键词');
  assert.equal(new Set(once).size, once.length);
});
