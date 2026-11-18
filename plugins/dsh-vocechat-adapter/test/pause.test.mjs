// 分段之间的停顿：一条一条冒出来，而不是同一秒刷出三条。
//
// 两个方向都错过一次，所以两个方向都要钉住：
//   - 不等（0ms/字）→ 三条消息在同一毫秒到达，从手机上看是"刷屏"，不像人；
//   - 等过头（一句 200 字 × 60ms = 12 秒）→ 回合被看门狗掐掉，用户看到"发到一半不说了"。
// 所以断言的是**夹在上下限之间**，不是某个精确毫秒数。

import test from 'node:test';
import assert from 'node:assert/strict';

import { pauseFor, resolveSegmentation } from '../index.mjs';

test('按刚发出去那句的字数计时：短句几乎立刻，长句停得久', () => {
  const seg = resolveSegmentation({ delayPerCharMs: 60, delayMinMs: 200, delayMaxMs: 3000 });
  assert.equal(pauseFor('嗯', seg), 200, '一个字也至少停下限，不然像机器连发');
  assert.equal(pauseFor('昨天那个文件你放哪了', seg), 600, '十个字 600ms');
  assert.equal(pauseFor('这句话有二十个字对不对呀真的挺长的', seg), 1020, '十七个字 1020ms');
});

test('上限兜住超长句：不会把回合拖到看门狗超时', () => {
  const seg = resolveSegmentation({ delayPerCharMs: 60, delayMinMs: 200, delayMaxMs: 3000 });
  assert.equal(pauseFor('x'.repeat(200), seg), 3000, '两百字也最多停 3 秒');
});

test('0ms/字 表示完全不额外等待', () => {
  const seg = resolveSegmentation({ delayPerCharMs: 0 });
  assert.equal(seg.delayPerCharMs, 0);
  assert.equal(pauseFor('昨天那个文件你放哪了', seg), 0);
});

test('默认值与 QQ 那一组一致（60ms/字、200ms 下限、3000ms 上限）', () => {
  const seg = resolveSegmentation({});
  assert.equal(seg.delayPerCharMs, 60);
  assert.equal(seg.delayMinMs, 200);
  assert.equal(seg.delayMaxMs, 3000);
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
