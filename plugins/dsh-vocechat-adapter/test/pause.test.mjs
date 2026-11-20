// 分段之间的停顿：一条一条冒出来，而不是同一秒刷出三条。
//
// 两个方向都错过一次，所以两个方向都要钉住：
//   - 不等（0ms/字）→ 三条消息在同一毫秒到达，从手机上看是"刷屏"，不像人；
//   - 等过头（一句 200 字 × 140ms = 28 秒）→ 回合被看门狗掐掉，用户看到"发到一半不说了"。
// 所以断言的是**夹在上下限之间**，不是某个精确毫秒数。
//
// 默认值照抄 QQ **线上 profile** 那一组（140/700/5000），不是 QQ 源码里的 60/200/3000：
// 用户真正体验到"字越多、间隔越长"的是前者。两者都要有测试，否则改回去没人发现。

import test from 'node:test';
import assert from 'node:assert/strict';

import { pauseFor, pausePlan, resolveSegmentation } from '../index.mjs';

test('按刚发出去那句的字数计时：短句几乎立刻，长句停得久', () => {
  const seg = resolveSegmentation({ delayPerCharMs: 140, delayMinMs: 700, delayMaxMs: 5000 });
  assert.equal(pauseFor('嗯', seg), 700, '一个字也至少停下限，不然像机器连发');
  assert.equal(pauseFor('昨天那个文件你放哪了', seg), 1400, '十个字 1400ms');
  assert.equal(pauseFor('这句话有十六个字对不对呀真的挺长的话', seg), 2520, '十八个字 2520ms');
});

test('上限兜住超长句：不会把回合拖到看门狗超时', () => {
  const seg = resolveSegmentation({ delayPerCharMs: 140, delayMinMs: 700, delayMaxMs: 5000 });
  assert.equal(pauseFor('x'.repeat(200), seg), 5000, '两百字也最多停 5 秒');
});

test('0ms/字 表示完全不额外等待', () => {
  const seg = resolveSegmentation({ delayPerCharMs: 0 });
  assert.equal(seg.delayPerCharMs, 0);
  assert.equal(pauseFor('昨天那个文件你放哪了', seg), 0);
  assert.deepEqual(pausePlan(['一', '二', '三'], seg), [0, 0], '计划表也全是 0');
});

test('默认值与 QQ 线上 profile 一致（140ms/字、700ms 下限、5000ms 上限）', () => {
  const seg = resolveSegmentation({});
  assert.equal(seg.delayPerCharMs, 140);
  assert.equal(seg.delayMinMs, 700);
  assert.equal(seg.delayMaxMs, 5000);
  assert.equal(seg.delayTotalMaxMs, 20_000, '总额封顶 20 秒');
});

test('下限高于上限时上限被抬到下限，不会出现负数间隔', () => {
  const seg = resolveSegmentation({ delayPerCharMs: 10, delayMinMs: 800, delayMaxMs: 100 });
  assert.equal(seg.delayMaxMs, 800);
  assert.equal(pauseFor('嗯', seg), 800);
});

test('emoji 按字符计（不是 UTF-16 码元），一个表情算一个字', () => {
  const seg = resolveSegmentation({ delayPerCharMs: 100, delayMinMs: 0, delayMaxMs: 5000 });
  // '👩‍🚀' 是 5 个码元、但视觉上是一个字；这里按 Array.from 的码点数算，不按 length。
  assert.equal(pauseFor('👩‍🚀', seg), 300);
});

test('分段开关的其余字段不受停顿配置影响', () => {
  const seg = resolveSegmentation({ enabled: false, style: 'natural', maxSegments: 3 });
  assert.equal(seg.enabled, false);
  assert.equal(seg.style, 'natural');
  assert.equal(seg.maxSegments, 3);
});

// ── 节奏表（pausePlan）────────────────────────────────────────────────────
//
// 存在的理由：这里是**同步**发送，停顿全算在工具调用里。QQ 那边尾段是后台发的
// （`scheduleTailSends`），所以它不需要总额封顶；这边需要，否则 6 段 × 5 秒 = 30 秒
// 一等等完，两三个工具连着用就可能撞上 180 秒的回合预算。

test('节奏表比段数少一项：最后一段之后没有下一句，不需要等', () => {
  const seg = resolveSegmentation({});
  assert.deepEqual(pausePlan([], seg), []);
  assert.deepEqual(pausePlan(['只有一条'], seg), []);
  assert.equal(pausePlan(['一', '二'], seg).length, 1);
  assert.equal(pausePlan(['一', '二', '三', '四'], seg).length, 3);
});

test('理想节奏：每项就是前一段的 pauseFor', () => {
  const seg = resolveSegmentation({});
  const pieces = ['嗯', '昨天那个文件你放哪了', '这句话有十八个字对不对呀真的挺长的话'];
  // 3 段 ⇒ 2 次停顿（最后一段后面没有下一句）
  assert.deepEqual(pausePlan(pieces, seg), [
    pauseFor(pieces[0], seg),
    pauseFor(pieces[1], seg),
  ]);
});

test('总额超预算时等比例压缩，不超预算时一个字节都不动', () => {
  const pieces = ['x'.repeat(60), 'y'.repeat(50), 'z'.repeat(40), 'w'.repeat(30), 'v'.repeat(20), 'u'.repeat(10)];
  // 不封顶跑一遍拿理想值，再开默认封顶跑一遍对比
  const uncapped = resolveSegmentation({ delayTotalMaxMs: 0 });
  const ideal = pausePlan(pieces, uncapped);
  const idealTotal = ideal.reduce((sum, ms) => sum + ms, 0);
  assert.ok(idealTotal > 20_000, `这组应当超预算（实际 ${idealTotal}）`);

  const capped = pausePlan(pieces, resolveSegmentation({}));
  assert.equal(capped.reduce((sum, ms) => sum + ms, 0), 20_000, '正好压到上限');
  assert.notDeepEqual(capped, ideal, '压缩过就必须和理想值不同');

  // 短文本不超预算 → 一个字节都不动
  const short = ['嗯', '好', '那就这样'];
  assert.deepEqual(pausePlan(short, resolveSegmentation({})), [700, 700], '不超预算时保持原样');
});

test('压缩保住"长句停得久"的形状，而不是前几句等够了后几句连发', () => {
  const pieces = ['x'.repeat(80), 'y'.repeat(60), 'z'.repeat(40), 'w'.repeat(20)];
  const plan = pausePlan(pieces, resolveSegmentation({}));
  // 原句长度递减 ⇒ 压缩后仍应递减（允许相等，取整会有并列）
  assert.ok(plan[0] >= plan[1], `${plan[0]} >= ${plan[1]}`);
  assert.ok(plan[1] >= plan[2], `${plan[1]} >= ${plan[2]}`);
  // 而且第一项不能塌成 0：压缩不是"从前面省出来"
  assert.ok(plan[0] > 1000, `首项 ${plan[0]} 太小`);
});

test('delayTotalMaxMs = 0 表示不封顶（需要精确复现 QQ 节奏时用）', () => {
  const seg = resolveSegmentation({ delayTotalMaxMs: 0 });
  const pieces = ['x'.repeat(60), 'y'.repeat(50), 'z'.repeat(40), 'w'.repeat(30), 'v'.repeat(20), 'u'.repeat(10)];
  const plan = pausePlan(pieces, seg);
  const total = plan.reduce((sum, ms) => sum + ms, 0);
  assert.ok(total > 20_000, `不封顶时应当超过 20 秒（实际 ${total}）`);
  assert.deepEqual(plan, pieces.slice(0, -1).map(piece => pauseFor(piece, seg)));
});
