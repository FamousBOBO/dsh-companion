/**
 * `synonyms.mjs` 的离线测试：共享中文词表 + 否定规则 + 近义展开 + 冲突/相似度。
 *
 * 这个文件守的不是「某一行代码」，而是检索曾经出事故的那三条口径：
 *   1. **入库与查询只有一份中文词表**：`analyzeWithHeuristics()`（入库）与
 *      `contextFromDraft()`（查询）都读 `normalizeText()`；若有人再写一份中文近义表，
 *      这里遍历 `LEXICON` 的往返检查就会分叉。
 *   2. **近似不等于合并**：`乖巧` 只说明卖萌语气，不能自动等于「同意」；
 *      `别笑了` / `笑不出来` 里的「笑」先被 `SURFACE_RULES` 否掉，不能归成发笑。
 *   3. **允许混合信号**：`好气又好笑`、`哭笑不得` 同时留下相反标签（`mixed: true`），
 *      排序层才知道不该按「相反硬门」砍掉整条候选。
 *
 * 全部是纯函数断言：无 IO、无时钟、无随机数，同一输入永远同一输出。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEXICON, EMOTION_SIMILARITY,
  normalizeText, expandTerms, conflictsBetween, gradedOverlap,
} from '../src/synonyms.mjs';
import { analyzeWithHeuristics } from '../src/analyzer.mjs';
import { contextFromDraft } from '../src/retrieval.mjs';

const FAMILY_FIELD = Object.freeze({ intent: 'intents', emotion: 'emotions', tone: 'tone', scene: 'scenes' });
const CJK_TERM = /^[\u4e00-\u9fff]{2,}$/;

/** 词条里第一个「≥2 个汉字」的写法：用它做往返检查，结构级复现而不是抓源码文本。 */
function representativeTerm(entry) {
  for (const raw of entry.terms) {
    const term = String(typeof raw === 'string' ? raw : raw.t);
    if (CJK_TERM.test(term)) return term;
  }
  return null;
}

/** 展开项 → 它出现过的全部 category（同一写法可能同时挂在两个类别，例如「愉快」= joy + light）。 */
const CATEGORY_OF_TERM = (() => {
  const map = new Map();
  for (const entry of LEXICON) {
    for (const raw of entry.terms) {
      const term = String(typeof raw === 'string' ? raw : raw.t);
      if (!map.has(term)) map.set(term, new Set());
      map.get(term).add(entry.category);
    }
  }
  return map;
})();

test('共享表不变量：LEXICON 的每个词条在入库侧与查询侧得到同一标签', () => {
  // 结构级检查：遍历共享表，看三个入口是否给同一个 family 的同一个 id。
  // 这不是抓源码文本，因此有人另加一份中文表时它会直接失败（词条对不上）。
  const failures = [];
  for (const entry of LEXICON) {
    // 场景 family 的 `comfort` 有专门口径（必须同时有低落/无奈信号才计入，见 synonyms.mjs
    // 与 analyzer.mjs 的同一处过滤），不在本往返断言里；下面单独测其它场景。
    if (entry.family === 'scene' && entry.id === 'comfort') continue;
    const term = representativeTerm(entry);
    if (!term) continue;
    const field = FAMILY_FIELD[entry.family];
    const fromQuery = normalizeText(term)[field].includes(entry.id);
    const fromIngest = analyzeWithHeuristics({ literal: term })[field].includes(entry.id);
    const fromDraft = contextFromDraft(term)[field].includes(entry.id);
    if (!(fromQuery && fromIngest && fromDraft)) {
      failures.push({ id: entry.id, family: entry.family, term, field, fromQuery, fromIngest, fromDraft });
    }
  }
  assert.deepEqual(failures, [], '同一词条必须在三处读出同一标签（否则就是又写了一份中文表）');
  assert.ok(LEXICON.length >= 30, `共享表规模足够（实际 ${LEXICON.length} 条）`);

  // 任务书点名的三个字面量：答应 → agree、开心 → joy（三处一致）。
  for (const [literal, field, id] of [['答应', 'intents', 'agree'], ['开心', 'emotions', 'joy']]) {
    assert.ok(normalizeText(literal)[field].includes(id), `normalizeText(${literal}) → ${field}.${id}`);
    assert.ok(analyzeWithHeuristics({ literal })[field].includes(id), `analyzeWithHeuristics(${literal}) → ${field}.${id}`);
    assert.ok(contextFromDraft(literal)[field].includes(id), `contextFromDraft(${literal}) → ${field}.${id}`);
  }

  // `点头` 是 LEXICON 里的词条；它同时出现在两份输出里，说明两边读的是同一份表。
  assert.ok(normalizeText('点头').matched.some(hit => hit.term === '点头' && hit.id === 'agree'), 'normalizeText 命中的是词条本身');
  assert.ok(analyzeWithHeuristics({ literal: '点头' }).intents.includes('agree'), '入库侧同一词条 → agree');
  assert.ok(contextFromDraft('点头').labels.includes('agree'), '查询侧同一词条 → agree');
});

test('共享表不变量：场景 family 的标签往返（comfort 例外有专门口径）', () => {
  const scenes = LEXICON.filter(entry => entry.family === 'scene' && entry.id !== 'comfort');
  assert.ok(scenes.length >= 6);
  for (const entry of scenes) {
    const term = representativeTerm(entry);
    assert.ok(normalizeText(term).scenes.includes(entry.id), `normalizeText(${term}) → scenes.${entry.id}`);
    assert.ok(analyzeWithHeuristics({ literal: term }).scenes.includes(entry.id), `analyzeWithHeuristics(${term}) → scenes.${entry.id}`);
    assert.ok(contextFromDraft(term).scenes.includes(entry.id), `contextFromDraft(${term}) → scenes.${entry.id}`);
  }
});

test('近似不等于合并：乖巧只说语气（cute），不自动等于同意（agree）', () => {
  const alone = normalizeText('乖巧');
  assert.deepEqual(alone.tone, ['cute'], '乖巧 → tone cute');
  assert.equal(alone.intents.includes('agree'), false, '乖巧本身不是「答应」');
  assert.equal(analyzeWithHeuristics({ literal: '乖巧' }).intents.includes('agree'), false);
  assert.equal(contextFromDraft('乖巧').intents.includes('agree'), false);

  // 加上「点头」才是同意；cute 仍然保留。
  const nodding = normalizeText('乖巧点头');
  assert.ok(nodding.intents.includes('agree'), '乖巧点头 → agree（点头贡献意图）');
  assert.ok(nodding.tone.includes('cute'), 'cute 不被同意覆盖');
});

test('复合草稿：笑着答应 → agree + light；轻松愉快 → joy + light', () => {
  const agree = normalizeText('笑着答应');
  assert.ok(agree.intents.includes('agree'));
  assert.ok(agree.tone.includes('light'), '「笑着」给轻松语气，而不是发笑意图');
  assert.equal(agree.intents.includes('laugh'), false, '「笑着」不等于发笑');

  const easy = normalizeText('轻松愉快');
  assert.ok(easy.emotions.includes('joy'), '愉快 → joy');
  assert.ok(easy.tone.includes('light'), '轻松 → light');
});

test('否定规则：别笑了 / 不要笑了 不是发笑，是制止 + 无奈', () => {
  for (const literal of ['别笑了', '不要笑了']) {
    const normalized = normalizeText(literal);
    assert.equal(normalized.intents.includes('laugh'), false, `${literal} 不许归成发笑`);
    assert.ok(normalized.intents.includes('stop') || normalized.emotions.includes('resignation'), `${literal} 要有制止/无奈`);
    assert.deepEqual(normalized.suppressed, [{ id: 'laugh', rule: 'laugh-stop' }], `${literal} 记录 laugh-stop 规则`);
    assert.ok(normalized.hasSignal);
  }
  // 「别闹」这类没有「笑」字的制止仍然走词表。
  assert.ok(normalizeText('别闹').intents.includes('stop'));
});

test('否定规则：笑不出来 → 沮丧/无奈，不归成发笑', () => {
  const normalized = normalizeText('笑不出来');
  assert.equal(normalized.intents.includes('laugh'), false, '笑不出来不是发笑');
  assert.ok(normalized.emotions.includes('resignation'), '含无奈');
  assert.ok(normalized.emotions.includes('sadness'), '含低落');
  assert.deepEqual(normalized.suppressed, [{ id: 'laugh', rule: 'laugh-not-able' }]);
});

test('混合信号：好气又好笑 → anger + laugh；哭笑不得 → 无奈保留，laugh 只是弱信号', () => {
  const angry = normalizeText('好气又好笑');
  assert.equal(angry.mixed, true, 'mixed=true 才允许排序层不硬砍');
  assert.ok(angry.emotions.includes('anger'), '一个信号是生气');
  assert.ok(angry.intents.includes('laugh'), '一个信号是发笑');

  const cry = normalizeText('哭笑不得');
  assert.equal(cry.mixed, true);
  assert.ok(cry.emotions.includes('resignation'), '无奈必须保留');
  // 「laugh 允许作为弱信号」：SURFACE_RULES 的 cry-and-laugh 给的是 weight 0.5，
  // 所以它出现在 intents 里，但不应压过 resignation/sadness。
  assert.ok(cry.intents.includes('laugh'), 'laugh 作为弱信号存在');
  assert.ok(cry.emotions.includes('sadness'));
});

test('自嘲语气跨家族识别混合信号，否定发笑仍保留', () => {
  const mixed = normalizeText('有点好笑又有点无奈地吐槽');
  assert.equal(mixed.mixed, true);
  assert.ok(mixed.intents.includes('laugh'));
  assert.ok(mixed.emotions.includes('resignation'));
  assert.equal(normalizeText('笑不出来，又很无奈').intents.includes('laugh'), false);
});

test('确定性：同一输入永远同一输出；空串/纯标点没有信号', () => {
  for (const literal of ['好气又好笑', '笑着答应、乖巧点头、轻松愉快', '笑不出来']) {
    assert.equal(JSON.stringify(normalizeText(literal)), JSON.stringify(normalizeText(literal)));
    assert.equal(JSON.stringify(contextFromDraft(literal)), JSON.stringify(contextFromDraft(literal)));
  }
  for (const literal of ['', '   ', '，。！？', '……']) {
    const normalized = normalizeText(literal);
    assert.equal(normalized.hasSignal, false, `${JSON.stringify(literal)} 不该有信号`);
    assert.deepEqual(normalized.labels, []);
  }
  assert.equal(normalizeText('').matched.length, 0);
});

test('expandTerms：只扩同类别，且跳过相反表达', () => {
  const joyful = normalizeText('开心');
  const joyCategory = LEXICON.find(entry => entry.id === 'joy').category;
  const terms = expandTerms(joyful);
  assert.ok(terms.length > 0);
  assert.ok(terms.includes('高兴'), '开心家族包含高兴');
  assert.ok(terms.includes('愉快'), '开心家族包含愉快');
  // EXPANSION_LIMIT 默认 6：笑眯眯 在窗口之外，放宽 limit 才看得到——不是被跨类别丢掉。
  assert.equal(terms.includes('笑眯眯'), false, '默认只展开 6 个同类别写法');
  assert.ok(expandTerms(joyful, { limit: 30 }).includes('笑眯眯'), '放宽窗口后笑眯眯 仍在 joy 家族');
  for (const forbidden of ['拒绝', '难过', '生气']) {
    assert.equal(terms.includes(forbidden), false, `开心不该展开出 ${forbidden}`);
  }
  for (const term of expandTerms(joyful, { limit: 30 })) {
    const categories = CATEGORY_OF_TERM.get(term);
    assert.ok(categories?.has(joyCategory), `${term} 必须映射到 category=${joyCategory}（实际 ${[...(categories ?? [])].join(',')}）`);
  }

  const hug = normalizeText('抱抱');
  const comfortCategory = LEXICON.find(entry => entry.id === 'comfort').category;
  const hugTerms = expandTerms(hug);
  assert.ok(hugTerms.includes('贴贴'), '抱抱家族包含贴贴');
  for (const forbidden of ['嘲讽', '生气']) {
    assert.equal(hugTerms.includes(forbidden), false, `抱抱不该展开出 ${forbidden}`);
  }
  for (const term of hugTerms) {
    const categories = CATEGORY_OF_TERM.get(term);
    assert.ok(categories?.has(comfortCategory), `${term} 必须映射到 category=${comfortCategory}（实际 ${[...(categories ?? [])].join(',')}）`);
  }
});

test('conflictsBetween / gradedOverlap：相反与相近的分开算', () => {
  const pairs = [
    [['agree'], ['refuse']],
    [['joy'], ['sadness']],
    [['comfort'], ['tease']],
    [['laugh'], ['sadness']],
  ];
  for (const [left, right] of pairs) {
    const found = conflictsBetween(left, right);
    assert.equal(found.length, 1, `${left}/${right} 应命中一对相反表达式`);
  }
  assert.deepEqual(conflictsBetween(['agree', 'light'], ['refuse', 'serious']).length >= 1, true);
  assert.deepEqual(conflictsBetween(['joy'], ['affection']), [], '开心与亲昵不是相反');

  // gradedOverlap：完全相同 1；相近 <1；相反 0；wanted 为空 → null（「没问」不是 0 分）。
  assert.equal(gradedOverlap(['joy'], ['joy']), 1);
  assert.equal(gradedOverlap(['joy'], ['affection'], EMOTION_SIMILARITY), 0.7, 'joy↔affection 相近 0.7');
  assert.ok(gradedOverlap(['joy'], ['affection'], EMOTION_SIMILARITY) < 1, '相近永远小于完全相同');
  assert.equal(gradedOverlap(['joy'], ['sadness'], EMOTION_SIMILARITY), 0, '相反不相近');
  assert.equal(gradedOverlap([], []), null, '没问 = null，交给分母规则处理');
});
