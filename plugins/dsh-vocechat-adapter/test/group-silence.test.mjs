// 沉默：群里"决定不说"是合法的，而且必须可查。
//
// 这一组的核心是**两条路必须分开**：
//   私聊  有正文 + 没调工具 + 已提交 → 注入一次纠正（老行为，一个字不改）
//   频道  同样条件 → 不纠正，只记一行 `model-silence`
//
// 混在一起会出现两种事故：群里每轮都被逼着发言（像机器人），或者私聊真的漏发却没人管。
// 所以断言既要"群里不纠正"，也要"私聊仍然纠正"，只测一半等于没测。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTurnObserver } from '../turns.mjs';
import { createSentLog } from '../sent-log.mjs';

/** 一帧"模型答在本地、没调工具、已提交"的回合。 */
function committedTurnWithoutTool(observer) {
  observer.observe({ type: 'start', turn: 1 });
  observer.observe({ type: 'chunk', chunk: { type: 'text-delta', text: '我答在本地了' } });
  observer.observe({ type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message' } });
}

function observerOf({ allowCorrection = () => true, onSilence = null } = {}) {
  const corrections = [];
  const observer = createTurnObserver({
    isToolVisible: () => true,
    correctionText: () => '现在调用 vc_message 发出去',
    onCorrection: text => corrections.push(text),
    allowCorrection,
    onSilence,
  });
  return { observer, corrections };
}

// ── 群里：不纠正，只记账 ────────────────────────────────────────────────

test('频道：答在本地不纠正，返回 false', () => {
  const { observer, corrections } = observerOf({ allowCorrection: () => false });
  committedTurnWithoutTool(observer);
  assert.equal(observer.maybeCorrect(null), false);
  assert.deepEqual(corrections, [], '群里不许注入纠正');
});

test('频道：一轮最多记一行 silence（两个时机各调一次也只记一次）', () => {
  const silences = [];
  const { observer } = observerOf({ allowCorrection: () => false, onSilence: info => silences.push(info) });
  committedTurnWithoutTool(observer);
  observer.maybeCorrect(null);   // turn-stopping 时机
  observer.maybeCorrect(null);   // idle 时机
  assert.equal(silences.length, 1);
  assert.equal(silences[0].textTail.includes('我答在本地了'), true);
  assert.equal(observer.state().silenceNoted, true);
});

test('频道：新一轮开始后 silence 标记清零（否则第二轮永远不记）', () => {
  const silences = [];
  const { observer } = observerOf({ allowCorrection: () => false, onSilence: info => silences.push(info) });
  committedTurnWithoutTool(observer);
  observer.maybeCorrect(null);
  observer.observe({ type: 'start', turn: 2 });
  observer.observe({ type: 'chunk', chunk: { type: 'text-delta', text: '第二轮' } });
  observer.observe({ type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message' } });
  observer.maybeCorrect(null);
  assert.equal(silences.length, 2);
});

test('频道：调过工具就不算沉默（正常发送不该被记账）', () => {
  const silences = [];
  const { observer } = observerOf({ allowCorrection: () => false, onSilence: info => silences.push(info) });
  observer.observe({ type: 'start', turn: 1 });
  observer.observe({ type: 'chunk', chunk: { type: 'block-start', blockType: 'tool-call' } });
  observer.observe({ type: 'chunk', chunk: { type: 'text-delta', text: '发出去了' } });
  observer.observe({ type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message' } });
  observer.maybeCorrect(null);
  assert.equal(silences.length, 0);
});

test('频道：没提交（committed=false）不算沉默', () => {
  const silences = [];
  const { observer } = observerOf({ allowCorrection: () => false, onSilence: info => silences.push(info) });
  observer.observe({ type: 'start', turn: 1 });
  observer.observe({ type: 'chunk', chunk: { type: 'text-delta', text: '半截' } });
  assert.equal(observer.maybeCorrect(null), false);
  assert.equal(silences.length, 0, 'committed 只在 end 帧里定，不能提前记账');
});

test('频道：工具不可见时不记沉默（那不是"决定不说"，是装不上工具）', () => {
  const silences = [];
  const observer = createTurnObserver({
    isToolVisible: () => false,
    correctionText: () => 'x',
    onCorrection: () => {},
    allowCorrection: () => false,
    onSilence: info => silences.push(info),
  });
  committedTurnWithoutTool(observer);
  assert.equal(observer.maybeCorrect(null), false);
  assert.equal(silences.length, 0);
});

// ── 私聊：语义一字不改 ──────────────────────────────────────────────────

test('私聊：答在本地仍然纠正一次，且只一次', () => {
  const { observer, corrections } = observerOf();
  committedTurnWithoutTool(observer);
  assert.equal(observer.maybeCorrect(null), true);
  assert.equal(corrections.length, 1);
  assert.equal(observer.maybeCorrect(null), false, '同一轮不许纠正第二次');
});

test('私聊：reasoning-delta 不算正文（先思考再答在本地，仍要纠正）', () => {
  const { observer, corrections } = observerOf();
  observer.observe({ type: 'start', turn: 1 });
  observer.observe({ type: 'chunk', chunk: { type: 'reasoning-delta', text: '我在想' } });
  observer.observe({ type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message' } });
  assert.equal(observer.maybeCorrect(null), false, '只有思考没有正文时不该纠正');
  assert.equal(corrections.length, 0);
});

test('allowCorrection 抛错时按"允许"处理（默认路径不能被一个坏闭包关掉）', () => {
  const { observer, corrections } = observerOf({ allowCorrection: () => { throw new Error('bad'); } });
  committedTurnWithoutTool(observer);
  assert.equal(observer.maybeCorrect(null), true);
  assert.equal(corrections.length, 1);
});

test('不传 allowCorrection 的老调用方行为不变', () => {
  const corrections = [];
  const observer = createTurnObserver({
    isToolVisible: () => true,
    correctionText: () => '发送',
    onCorrection: text => corrections.push(text),
  });
  committedTurnWithoutTool(observer);
  assert.equal(observer.maybeCorrect(null), true);
  assert.equal(corrections.length, 1);
});

// ── 账本 ────────────────────────────────────────────────────────────────

test('sent-log 的 silence 行：kind/model-silence，只留 preview 不留全文', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-silence-'));
  const sentLog = createSentLog({ dataRoot: root });
  sentLog.silence({ room: 'vc-chan-1', mid: 3, tail: '这是一段很长的思考'.repeat(30) });
  const row = JSON.parse(fs.readFileSync(sentLog.file, 'utf8').trim());
  assert.equal(row.kind, 'model-silence');
  assert.equal(row.room, 'vc-chan-1');
  assert.equal(row.mid, 3);
  assert.equal(row.preview.length <= 61, true);
});

test('sent-log 的 history-miss 行：kind/history-miss，带原因码不含正文', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-hmiss-'));
  const sentLog = createSentLog({ dataRoot: root });
  sentLog.historyMiss({ room: 'vc-chan-1', reason: 'error:forbidden' });
  const row = JSON.parse(fs.readFileSync(sentLog.file, 'utf8').trim());
  assert.equal(row.kind, 'history-miss');
  assert.equal(row.reason, 'error:forbidden');
});

test('沉默与纠正记在不同的 kind 上（运维要能分开数）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-both-'));
  const sentLog = createSentLog({ dataRoot: root });
  sentLog.silence({ room: 'vc-chan-1', mid: 1, tail: 'x' });
  sentLog.skipped({ room: 'vc-chan-1', mid: 2, reason: 'chance-skip:0.3', fromUid: 5 });
  const kinds = fs.readFileSync(sentLog.file, 'utf8').trim().split('\n').map(line => JSON.parse(line).kind);
  assert.deepEqual(kinds, ['model-silence', 'skipped']);
});
