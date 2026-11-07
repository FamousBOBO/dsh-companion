/**
 * `pack.mjs` 的离线测试：整包导入的**清单**这一层的验收。
 *
 * 为什么清单本身要单独测：图片字节能被 `security.validateImage` 判型，但「这张图什么时候
 * 能发」是人写的判断。清单写错的代价是「导进去了却永远检索不到」，而且不报错 ——
 * 所以这里把「什么样的清单算合法」钉死，一条都不含糊。
 *
 * 全部是纯函数；不碰数据库、不读真图、不落文件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PACK_LIMITS, ENTRY_KEYS, CURATED_MODEL_VERSION, CURATED_CONFIDENCE,
  validatePackEntry, validatePackManifest, cardForEntry, reconcilePack,
} from '../src/pack.mjs';

const entry = (over = {}) => ({ file: '01-吃糖.png', literal: '吃糖 好甜', ...over });

test('一条合法条目：原样整形，列表字段去重并保留顺序', () => {
  const parsed = validatePackEntry(entry({
    intents: ['laugh', 'comfort', 'laugh'], emotions: ['joy'], tone: ['warm'], scenes: ['meal'],
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entry.file, '01-吃糖.png');
  assert.deepEqual(parsed.entry.intents, ['laugh', 'comfort'], '重复项去掉，但顺序不动');
  assert.deepEqual(parsed.entry.avoidWhen, [], '不写就是空数组，不是 undefined');
  assert.equal(parsed.entry.aggression, 0, 'aggression 缺省为 0');
  assert.equal(parsed.warnings.length, 0);
});

test('字符串形式的列表字段被当成长度 1 的数组（手写清单的常见形态）', () => {
  const parsed = validatePackEntry(entry({ intents: 'laugh' }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.entry.intents, ['laugh']);
});

test('缺 literal 直接拒：没有 literal 的卡在检索里只剩 intents/scenes 能命中', () => {
  const parsed = validatePackEntry(entry({ literal: '   ' }));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reasonCode, 'pack-literal-missing');
});

test('缺 file 直接拒；file 必须存在且非空', () => {
  const parsed = validatePackEntry({ literal: 'x' });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reasonCode, 'pack-file-missing');
});

test('file 只能是裸文件名：路径分隔符、盘符、`..` 一律拒（与 zip.mjs 的边界同一条）', () => {
  for (const name of ['../a.png', 'a/b.png', 'a\\b.png', 'C:a.png', 'sub/../a.png']) {
    const parsed = validatePackEntry(entry({ file: name }));
    assert.equal(parsed.ok, false, `${name} 应该被拒`);
    assert.equal(parsed.reasonCode, 'pack-file-not-basename');
  }
});

test('file 里的控制字符被拒', () => {
  const parsed = validatePackEntry(entry({ file: 'a\u0000.png' }));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reasonCode, 'pack-file-control-char');
});

test('未知字段一律拒：拼错的键静默丢失比报错更难查', () => {
  const parsed = validatePackEntry(entry({ intent: ['laugh'] }));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reasonCode, 'pack-entry-unknown-key');
  assert.match(parsed.message, /intents/);
});

test('列表字段不是数组时拒；元素不是字符串/数字时拒', () => {
  assert.equal(validatePackEntry(entry({ intents: { a: 1 } })).reasonCode, 'pack-list-not-array');
  assert.equal(validatePackEntry(entry({ intents: [{ nested: true }] })).reasonCode, 'pack-list-item-invalid');
});

test('列表超过 8 项被截断，并且一定报出来（不静默丢）', () => {
  const many = Array.from({ length: 11 }, (_, index) => `i${index}`);
  const parsed = validatePackEntry(entry({ intents: many }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entry.intents.length, PACK_LIMITS.maxList);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /超过 8 项/);
});

test('aggression 被夹到 0–1；非数字拒；≥0.5 时给出「会被场景风险惩罚」的提示', () => {
  assert.equal(validatePackEntry(entry({ aggression: 2 })).entry.aggression, 1);
  assert.equal(validatePackEntry(entry({ aggression: -1 })).entry.aggression, 0);
  assert.equal(validatePackEntry(entry({ aggression: 'x' })).reasonCode, 'pack-ratio-invalid');
  const warned = validatePackEntry(entry({ aggression: 0.6 }));
  assert.equal(warned.ok, true);
  assert.match(warned.warnings.join('\n'), /场景风险惩罚/);
});

test('literal 超长被截到 200（入库前的门，不是静默接受超长文本）', () => {
  const parsed = validatePackEntry(entry({ literal: 'x'.repeat(400) }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entry.literal.length, PACK_LIMITS.maxLiteral);
});

test('整份清单：packId 必填且字符集受限', () => {
  assert.equal(validatePackManifest({ entries: [entry()] }).reasonCode, 'pack-id-invalid');
  assert.equal(validatePackManifest({ packId: 'a/b', entries: [entry()] }).reasonCode, 'pack-id-invalid');
  assert.equal(validatePackManifest({ packId: '', entries: [entry()] }).reasonCode, 'pack-id-invalid');
  const ok = validatePackManifest({ packId: 'qq-232180', entries: [entry()] });
  assert.equal(ok.ok, true);
  assert.equal(ok.pack.packId, 'qq-232180');
  assert.equal(ok.pack.name, 'qq-232180', '不写 name 就用 packId');
});

test('整份清单：entries 必须非空、不超过 200 条', () => {
  assert.equal(validatePackManifest({ packId: 'p', entries: [] }).reasonCode, 'pack-entries-empty');
  assert.equal(validatePackManifest({ packId: 'p', entries: 'x' }).reasonCode, 'pack-entries-empty');
  const tooMany = { packId: 'p', entries: Array.from({ length: 201 }, (_, index) => entry({ file: `f${index}.png` })) };
  assert.equal(validatePackManifest(tooMany).reasonCode, 'pack-too-many-entries');
});

test('整份清单：同一个文件出现两次直接拒（否则后一条会静默盖掉前一条的卡）', () => {
  const duplicated = { packId: 'p', entries: [entry(), entry({ literal: '另一张' })] };
  const parsed = validatePackManifest(duplicated);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reasonCode, 'pack-file-duplicate');
});

test('整份清单：坏条目的报错带序号，能直接定位到清单第几行', () => {
  const bad = { packId: 'p', entries: [entry(), { file: '02.png' }] };
  const parsed = validatePackManifest(bad);
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /第 2 条/);
  assert.match(parsed.message, /literal/);
});

test('清单不是对象时拒（JSON 解析出数组/标量的情况）', () => {
  assert.equal(validatePackManifest([entry()]).reasonCode, 'pack-manifest-not-object');
  assert.equal(validatePackManifest(null).reasonCode, 'pack-manifest-not-object');
  assert.equal(validatePackManifest('x').reasonCode, 'pack-manifest-not-object');
});

test('cardForEntry：产出 library.upsertCard 认的卡；ocr 恒为空（不做 OCR 就不撒谎）', () => {
  const parsed = validatePackEntry(entry({
    intents: ['laugh'], emotions: ['joy'], tone: ['warm'], scenes: ['meal'], avoidWhen: ['serious-conflict'], aggression: 0.2,
  }));
  const card = cardForEntry(parsed.entry);
  assert.equal(card.ocr, '');
  assert.equal(card.modelVersion, CURATED_MODEL_VERSION, '不冒充 heuristics-v1，也不冒充任何视觉模型');
  assert.equal(card.confidence, CURATED_CONFIDENCE);
  assert.deepEqual(card.intents, ['laugh']);
  assert.deepEqual(card.avoidWhen, ['serious-conflict']);
  assert.deepEqual(card.rhetoric, [], '清单不写修辞就不猜');
  assert.equal(card.aggression, 0.2);
});

test('cardForEntry 的列表字段是拷贝：改卡不会回写清单条目', () => {
  const parsed = validatePackEntry(entry({ intents: ['laugh'] }));
  const card = cardForEntry(parsed.entry);
  card.intents.push('extra');
  assert.deepEqual(parsed.entry.intents, ['laugh']);
});

test('reconcilePack：清单与包对上号时产出导入计划', () => {
  const pack = { entries: [entry({ file: 'a.png' }), entry({ file: 'b.png', literal: 'b' })] };
  const result = reconcilePack({ pack, zipNames: ['a.png', 'b.png', 'preview.png'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.map(row => row.file), ['a.png', 'b.png']);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.extra, ['preview.png'], '包里有但清单没写的要被报出来，不静默忽略');
});

test('reconcilePack：清单写了但包里没有 → 记 missing，其余照导', () => {
  const pack = { entries: [entry({ file: 'a.png' }), entry({ file: 'gone.png', literal: 'x' })] };
  const result = reconcilePack({ pack, zipNames: ['a.png'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, ['gone.png']);
  assert.deepEqual(result.plan.map(row => row.file), ['a.png']);
});

test('reconcilePack：一张都对不上时整体失败（导 0 张不是成功）', () => {
  const pack = { entries: [entry({ file: 'a.png' })] };
  const result = reconcilePack({ pack, zipNames: ['other.png'] });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'pack-zip-mismatch');
  assert.equal(result.plan.length, 0);
});

test('导出的常量是冻结的：改不掉白名单与上限', () => {
  assert.equal(Object.isFrozen(PACK_LIMITS), true);
  assert.equal(Object.isFrozen(ENTRY_KEYS), true);
  assert.deepEqual(ENTRY_KEYS, [
    'file', 'literal', 'intents', 'emotions', 'tone', 'scenes', 'avoidWhen', 'aggression', 'description',
  ]);
});
