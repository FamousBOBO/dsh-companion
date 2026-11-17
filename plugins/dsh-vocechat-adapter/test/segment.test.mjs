import test from 'node:test';
import assert from 'node:assert/strict';

import { segmentText, stripJunk, splitByEnders } from '../segment.mjs';
import { resolveSegmentation } from '../index.mjs';

const opts = (over = {}) => ({
  enabled: true, style: 'active', minLength: 8, maxSegments: 6, removeTrailingPeriod: false, ...over,
});

test('a one-liner stays one message', () => {
  assert.deepEqual(segmentText('今天天气不错', opts()), ['今天天气不错']);
});

test('the persona style — one clause per line, no sentence enders — is segmented', () => {
  // This is the measured failure: under `natural` this whole block is one "sentence" and ships as
  // a single message with embedded newlines, which is what "分段没有" looks like on the phone.
  const text = '在的在的\n怎么了，这么晚才想起来找我';
  assert.deepEqual(segmentText(text, opts()), ['在的在的', '怎么了，这么晚才想起来找我']);
});

test('the same text under natural stays one message (which is why active is the default)', () => {
  const text = '在的在的\n怎么了，这么晚才想起来找我';
  assert.deepEqual(segmentText(text, opts({ style: 'natural' })), [text]);
});

test('sentence enders split, and a run of the same ender stays together', () => {
  assert.deepEqual(segmentText('真的吗！！！这也太离谱了吧……', opts()), ['真的吗！！！', '这也太离谱了吧……']);
});

test('blank lines collapse; three paragraphs become three messages', () => {
  const text = '第一条\n\n第二条\n\n第三条';
  assert.deepEqual(segmentText(text, opts()), ['第一条', '第二条', '第三条']);
});

test('punctuation inside protected regions is never a boundary', () => {
  // Book titles and quoted speech routinely contain a full stop that is not a sentence end.
  assert.deepEqual(segmentText('那本书叫《活着。很好哭》。', opts()), ['那本书叫《活着。很好哭》。']);
  assert.deepEqual(segmentText('他说“先这样。再说吧”就走了。', opts()), ['他说“先这样。再说吧”就走了。']);
  assert.deepEqual(segmentText('他昨天说（其实是前天。我记错了）。', opts()), ['他昨天说（其实是前天。我记错了）。']);
});

test('a fenced code block survives as ONE message, fences included', () => {
  // Measured before the mask: `active` split on newlines first, so a fenced block became four
  // messages — "```js" / "const a = 1.5;" / "```" — and the fence markers arrived as their own
  // messages. The block must be protected from BOTH punctuation and newline splitting.
  const text = '前言。\n\n```js\nconst a = 1.5;\n```\n看这段。';
  const pieces = segmentText(text, opts());
  assert.deepEqual(pieces, ['前言。', '```js\nconst a = 1.5;\n```', '看这段。']);
  assert.equal(pieces.includes('```js'), false, 'the fence must not be its own message');
});

test('empty and junk-only input produce nothing at all', () => {
  assert.deepEqual(segmentText('', opts()), []);
  assert.deepEqual(segmentText('   \n  ', opts()), []);
  assert.deepEqual(segmentText('NO_REPLY', opts()), []);
  assert.deepEqual(segmentText('<思考>要不要说话</思考>', opts()), []);
});

test('reasoning blocks are stripped before segmentation', () => {
  // `removeTrailingPeriod` is on here because the assertion is about what survives stripping,
  // not about punctuation. With the default (false) the period is correctly kept.
  assert.deepEqual(segmentText('<思考>要不要说话</思考>我说两句。', opts({ removeTrailingPeriod: true })), ['我说两句']);
  assert.deepEqual(segmentText('<thinking>hmm</thinking>好。', opts({ removeTrailingPeriod: true })), ['好']);
});

test('a word-count hint is not part of the message', () => {
  assert.deepEqual(segmentText('好。（32字）', opts({ removeTrailingPeriod: true })), ['好']);
});

test('disabled returns the whole body untouched', () => {
  const text = '第一句。第二句。';
  assert.deepEqual(segmentText(text, opts({ enabled: false })), [text]);
});

test('duplicate lines are sent once', () => {
  assert.deepEqual(segmentText('走了\n走了', opts()), ['走了']);
});

test('maxSegments merges the tail instead of dropping it', () => {
  // QQ drops what it cannot send (`slice`); here dropping the end of an answer to one person is
  // not acceptable, so the overflow is joined into the last message.
  const pieces = segmentText('一\n二\n三\n四\n五\n六\n七', opts({ maxSegments: 3 }));
  assert.equal(pieces.length, 3);
  assert.equal(pieces[0], '一');
  assert.equal(pieces[1], '二');
  assert.match(pieces[2], /三/);
  assert.match(pieces[2], /七/, 'the tail must survive');
});

test('maxSegments = 1 collapses to a single joined message', () => {
  const pieces = segmentText('一\n二\n三', opts({ maxSegments: 1 }));
  assert.equal(pieces.length, 1);
  assert.match(pieces[0], /一/);
  assert.match(pieces[0], /三/);
});

test('conservative glues short neighbours; natural does not', () => {
  const text = '好。行。我们出发。';
  // The glued segments lose their inner full stops (「好。，行。」是拼接痕迹，不是语气),
  // but the final period stays unless `removeTrailingPeriod` asks for it. QQ's own test expects
  // no final period because its fixture sets `removeTrailingPeriod: true`; here the default is
  // false, so the period is correct.
  assert.deepEqual(segmentText(text, opts({ style: 'conservative', minLength: 8 })), ['好，行，我们出发。']);
  assert.deepEqual(
    segmentText(text, opts({ style: 'conservative', minLength: 8, removeTrailingPeriod: true })),
    ['好，行，我们出发'],
  );
  assert.deepEqual(
    segmentText(text, opts({ style: 'conservative', minLength: 0, removeTrailingPeriod: true })),
    ['好', '行', '我们出发'],
  );
});

test('removeTrailingPeriod strips the final full stop only when asked', () => {
  assert.deepEqual(segmentText('先吃饭。', opts({ removeTrailingPeriod: true })), ['先吃饭']);
  assert.deepEqual(segmentText('先吃饭。', opts()), ['先吃饭。']);
});

test('half-width punctuation is left alone (VoceChat renders plain text)', () => {
  // QQ converts `,` → `，`; that would mangle English and URLs. Deliberately different.
  const text = 'Hello, world. How are you?';
  const pieces = segmentText(text, opts({ style: 'natural' }));
  assert.equal(pieces.join(' ').includes('Hello, world'), true);
});

test('a URL is not split on its own punctuation', () => {
  const text = '看这个 https://example.com/a?b=1,c=2 。';
  const pieces = segmentText(text, opts({ style: 'natural' }));
  assert.equal(pieces.some(p => p.includes('https://example.com/a?b=1,c=2')), true);
});

test('splitByEnders keeps an ellipsis run as one tail', () => {
  assert.deepEqual(splitByEnders('等等……然后呢。'), ['等等……', '然后呢。']);
});

test('the resolved config defaults are active and capped at 6', () => {
  const seg = resolveSegmentation(undefined);
  assert.equal(seg.enabled, true);
  assert.equal(seg.style, 'active');
  assert.equal(seg.maxSegments, 6);
  assert.equal(seg.removeTrailingPeriod, false);
});

test('resolveSegmentation honours every switch', () => {
  const seg = resolveSegmentation({ enabled: false, style: 'conservative', minLength: 12, maxSegments: 3, removeTrailingPeriod: true });
  assert.equal(seg.enabled, false);
  assert.equal(seg.style, 'conservative');
  assert.equal(seg.minLength, 12);
  assert.equal(seg.maxSegments, 3);
  assert.equal(seg.removeTrailingPeriod, true);
});

test('a garbage style falls back to active rather than throwing', () => {
  assert.equal(resolveSegmentation({ style: 'nonsense' }).style, 'active');
  assert.equal(resolveSegmentation({ maxSegments: -3 }).maxSegments, 6);
});

test('stripJunk leaves ordinary text alone', () => {
  assert.equal(stripJunk('今天下雨了。'), '今天下雨了。');
});
