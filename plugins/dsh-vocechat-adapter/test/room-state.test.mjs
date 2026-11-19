// 两个水位：`lastHandledMid`（我看到哪了）与 `lastSentMid`（我说到哪了）。
//
// 这一组守的是一个**真实发生过的上下文丢失**（2026-11-19，gid=1）：
//
//   沈幺说 1148-1150 → 三月七看到并回了 1151-1153 → 水位（当时用的是 lastSentMid）→ 1153
//   → 主人问"沈幺刚才说她今天干嘛了"
//   → 上下文按 1153 过滤 → 沈幺那三条全被挡掉 → 三月七答"没看着她说啊"
//
// 那些话她明明看过并回应过。根因：把"我说到哪"当成"我看到哪"——一旦我发言，
// 水位就越过了别人在我发言**之前**说的话。而群里"别人在我发言之前说的话"正是最需要记住的。
//
// 五组：
//   1. 分开推进：handled 与 sent 互不覆盖
//   2. 只增不减（重投/乱序不许倒退）
//   3. 跨重启（落盘 + 重新打开）
//   4. 老状态兼容（只有 lastSentMid 时不丢上下文）
//   5. 那个具体场景的回归（同伴在我说之前说的话，必须留在上下文里）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRoomState } from '../room-state.mjs';
import { mapHistoryRows, selectRows } from '../history.mjs';

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vc-rooms-'));
}

// ── 1. 两个水位分开 ─────────────────────────────────────────────────────

test('noteHandled 与 noteSent 各记各的，互不覆盖', () => {
  const root = freshRoot();
  const rooms = createRoomState({ dataRoot: root });
  rooms.noteHandled('vc-chan-1', 1150);
  rooms.noteSent('vc-chan-1', 1153);
  assert.equal(rooms.watermarkOf('vc-chan-1'), 1150, '上下文界是"看到哪"，不是"说到哪"');
  const info = rooms.info();
  assert.equal(info.sentMarks['vc-chan-1'], 1153, '发送水位仍然可查（运维用）');
  fs.rmSync(root, { recursive: true, force: true });
});

test('noteHandled 返回值：推进 true，重复/倒退 false', () => {
  const root = freshRoot();
  const rooms = createRoomState({ dataRoot: root });
  assert.equal(rooms.noteHandled('vc-chan-1', 100), true);
  assert.equal(rooms.noteHandled('vc-chan-1', 100), false, '同一条再记一次不算推进');
  assert.equal(rooms.noteHandled('vc-chan-1', 99), false, '倒退不许成功');
  assert.equal(rooms.noteHandled('vc-chan-1', 101), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('非法 mid（0 / 负数 / 非整数 / null）不推进，也不写文件', () => {
  const root = freshRoot();
  const rooms = createRoomState({ dataRoot: root });
  for (const bad of [0, -1, 1.5, null, 'abc', undefined]) {
    assert.equal(rooms.noteHandled('vc-chan-1', bad), false, `mid=${String(bad)} 不该推进`);
    assert.equal(rooms.noteSent('vc-chan-1', bad), false, `mid=${String(bad)} 不该推进`);
  }
  assert.equal(rooms.watermarkOf('vc-chan-1'), null);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── 2. 只增不减 ─────────────────────────────────────────────────────────

test('noteSent 同样只增不减（重投不会让"说到哪"倒退）', () => {
  const root = freshRoot();
  const rooms = createRoomState({ dataRoot: root });
  assert.equal(rooms.noteSent('vc-chan-1', 200), true);
  assert.equal(rooms.noteSent('vc-chan-1', 199), false);
  assert.equal(rooms.info().sentMarks['vc-chan-1'], 200);
  fs.rmSync(root, { recursive: true, force: true });
});

test('两个水位互相独立地只增不减', () => {
  const root = freshRoot();
  const rooms = createRoomState({ dataRoot: root });
  rooms.noteSent('vc-chan-1', 300);
  rooms.noteHandled('vc-chan-1', 150);
  assert.equal(rooms.watermarkOf('vc-chan-1'), 150);
  assert.equal(rooms.info().sentMarks['vc-chan-1'], 300);
  // 再说一句更早的话：发送水位不倒退，上下文界也不受影响。
  rooms.noteSent('vc-chan-1', 299);
  assert.equal(rooms.info().sentMarks['vc-chan-1'], 300);
  assert.equal(rooms.watermarkOf('vc-chan-1'), 150);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── 3. 跨重启 ───────────────────────────────────────────────────────────

test('两个水位都能跨重启保留', () => {
  const root = freshRoot();
  const rooms = createRoomState({ dataRoot: root });
  rooms.noteHandled('vc-chan-1', 500);
  rooms.noteSent('vc-chan-1', 510);
  const reopened = createRoomState({ dataRoot: root });
  assert.equal(reopened.watermarkOf('vc-chan-1'), 500);
  assert.equal(reopened.info().sentMarks['vc-chan-1'], 510);
  fs.rmSync(root, { recursive: true, force: true });
});

test('写入是原子替换：目录里不留下 .tmp', () => {
  const root = freshRoot();
  const rooms = createRoomState({ dataRoot: root });
  rooms.noteHandled('vc-chan-1', 1);
  const dir = path.join(root, 'home', 'vocechat-adapter');
  assert.deepEqual(fs.readdirSync(dir), ['rooms.json']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('坏文件不拦住挂载，水位退化为"没有"', () => {
  const root = freshRoot();
  const dir = path.join(root, 'home', 'vocechat-adapter');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rooms.json'), '{ this is not json');
  const rooms = createRoomState({ dataRoot: root });
  assert.equal(rooms.watermarkOf('vc-chan-1'), null);
  // 仍然能写：坏文件被下一次写入覆盖掉。
  assert.equal(rooms.noteHandled('vc-chan-1', 7), true);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── 4. 老状态兼容 ───────────────────────────────────────────────────────

test('只有 lastSentMid 的老文件：把它当上下文界读一次（不丢上下文）', () => {
  const root = freshRoot();
  const dir = path.join(root, 'home', 'vocechat-adapter');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify({ 'vc-chan-1': { lastSentMid: 580 } }));
  const rooms = createRoomState({ dataRoot: root });
  assert.equal(rooms.watermarkOf('vc-chan-1'), 580);
  fs.rmSync(root, { recursive: true, force: true });
});

test('有了 lastHandledMid 之后以它为准（老字段不再影响上下文）', () => {
  const root = freshRoot();
  const dir = path.join(root, 'home', 'vocechat-adapter');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify({
    'vc-chan-1': { lastSentMid: 580, lastHandledMid: 600 },
  }));
  const rooms = createRoomState({ dataRoot: root });
  assert.equal(rooms.watermarkOf('vc-chan-1'), 600);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── 5. 那个具体场景的回归 ───────────────────────────────────────────────

test('同伴在我说之前说的话，必须留在上下文里（2026-11-19 的真实丢失）', () => {
  // 频道里的事实时序：
  //   1148-1150 沈幺(uid 5) 说三句
  //   1151-1153 三月七(uid 4) 回三句   ← 这一轮结束时 lastSentMid = 1153
  //   1154 主人问"沈幺刚才说她今天干嘛了"
  const rows = mapHistoryRows([
    { mid: 1148, from_uid: 5, detail: { content: '在呢' } },
    { mid: 1149, from_uid: 5, detail: { content: '不算忙，今天写了点稿子' } },
    { mid: 1150, from_uid: 5, detail: { content: '修仙呢' } },
    { mid: 1151, from_uid: 4, detail: { content: '在呢，这个点还没睡呀' } },
    { mid: 1152, from_uid: 4, detail: { content: '状态还行' } },
    { mid: 1153, from_uid: 4, detail: { content: '沈幺的部分让他自己说' } },
    { mid: 1154, from_uid: 1, detail: { content: '沈幺刚才说她今天干嘛了' } },
  ]);

  // 错的界：用"我说到哪"（1153）过滤 → 只剩主人那句，沈幺的三句全丢。
  const bySentMark = selectRows(rows, { watermark: 1153, batchMids: [1154] });
  assert.deepEqual(bySentMark.map(row => row.mid), [], '这就是当时"没看着她说"的原因');

  // 对的界：用"我回到哪"（1151 之前，即上一轮收到的最后一条 1147）过滤 → 沈幺三句都在。
  const byHandledMark = selectRows(rows, { watermark: 1147, batchMids: [1154] });
  assert.deepEqual(byHandledMark.map(row => row.mid), [1148, 1149, 1150, 1151, 1152, 1153]);
});

test('沉默的一轮也推进界（否则群里每轮都把上一批重看一遍）', () => {
  const root = freshRoot();
  const rooms = createRoomState({ dataRoot: root });
  // 一轮收到 1145-1147，模型决定不说话 → 没有任何 noteSent。
  rooms.noteHandled('vc-chan-1', 1147);
  assert.equal(rooms.watermarkOf('vc-chan-1'), 1147, '看过了就该推进，与说没说无关');
  const rows = mapHistoryRows([
    { mid: 1145, from_uid: 1, detail: { content: 'a' } },
    { mid: 1147, from_uid: 1, detail: { content: 'c' } },
    { mid: 1148, from_uid: 5, detail: { content: 'd' } },
  ]);
  assert.deepEqual(selectRows(rows, { watermark: rooms.watermarkOf('vc-chan-1') }).map(r => r.mid), [1148]);
  fs.rmSync(root, { recursive: true, force: true });
});
