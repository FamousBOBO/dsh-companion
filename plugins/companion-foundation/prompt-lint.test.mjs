import test from 'node:test';
import assert from 'node:assert/strict';

import { lintText, LINT_THRESHOLDS } from './prompt-lint.mjs';

// 文风检测的验收点（任务书 §12 / §14.3）：
// 只统计 + 理由码、不回传原文、不改写；正常中文不被误伤；白描只在叙事档才算问题。

test('正常中文不被误伤：不是 / 没有 / 其实 各出现一次不算超标', () => {
  const text = '今天有点累，不过还行。其实我不是很想出门，没有别的意思，就是懒。';
  const report = lintText(text, { profile: 'chat', mode: 'chat' });
  assert.equal(report.ok, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.counts.contrastiveTemplates, 0, '「不是…」单独出现不算对偶模板');
});

test('模板化的「不是X，而是Y」重复出现才判 contrastive-template', () => {
  const text = '不是不爱，而是不敢。不是不想，而是不能。不是不会，而是不愿。';
  const report = lintText(text, { profile: 'chat', mode: 'chat' });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some(finding => finding.code === 'contrastive-template'));
  assert.equal(report.counts.contrastiveTemplates, 3);
});

test('输出里不含任何原文片段（只允许统计与理由码）', () => {
  const text = '不是不爱，而是不敢。他说这话时眼神有些复杂，微微低了一下头，仿佛在等一个回答。' .repeat(3);
  const report = lintText(text, { profile: 'roleplay-narrative', mode: 'roleplay' });
  const serialized = JSON.stringify(report);
  for (const fragment of ['不是不爱', '眼神', '微微', '仿佛', '回答']) {
    assert.equal(serialized.includes(fragment), false, `回传了原文片段: ${fragment}`);
  }
  assert.equal(typeof report.chars, 'number');
  assert.equal(report.chars, text.length);
});

test('counts 全是数字，findings 只有 code 与 count', () => {
  const report = lintText('总之，说到底，或许这就是生活。', { profile: 'chat' });
  for (const [key, value] of Object.entries(report.counts)) {
    assert.equal(typeof value, 'number', `counts.${key} 不是数字`);
  }
  for (const finding of report.findings) {
    assert.deepEqual(Object.keys(finding).sort(), ['code', 'count']);
    assert.equal(typeof finding.code, 'string');
    assert.equal(typeof finding.count, 'number');
  }
});

test('机械性总结结尾被检出', () => {
  const report = lintText('今天就这样吧。总之，明天再说。说到底，日子还得过。', { profile: 'chat' });
  assert.ok(report.findings.some(finding => finding.code === 'summary-ending'));
});

test('填充词与比喻模板高频出现被检出', () => {
  const filler = '她微微点头，轻轻笑了一下，缓缓抬头看了你一眼，悄然把手放下，又微微叹了口气。';
  const fillerReport = lintText(filler, { profile: 'roleplay-narrative' });
  assert.ok(fillerReport.counts.fillerMotifs >= LINT_THRESHOLDS.fillerMotifs);
  assert.ok(fillerReport.findings.some(finding => finding.code === 'filler-motif'));

  const simile = '像是被抽走了力气。仿佛有人在耳边说话。好似一场梦。宛如旧照片。';
  const simileReport = lintText(simile, { profile: 'roleplay-narrative' });
  assert.ok(simileReport.findings.some(finding => finding.code === 'simile-template'));
});

test('动作后反复解释情绪被检出', () => {
  const text = '说完，他有些不安。笑着，似乎想缓和气氛。抬头，好像要说什么。伸手，似乎要拦人。';
  const report = lintText(text, { profile: 'roleplay-narrative' });
  assert.ok(report.counts.emotionExplanations >= LINT_THRESHOLDS.emotionExplanations);
  assert.ok(report.findings.some(finding => finding.code === 'emotion-explanation'));
});

test('复述用户原话只在聊天/陪伴档算问题，叙事档不因此误报', () => {
  const text = '你刚才说你今天很累，你的意思是先休息一下。';
  const chat = lintText(text, { profile: 'chat', mode: 'chat' });
  assert.ok(chat.findings.some(finding => finding.code === 'echo-user'));
  const narrative = lintText(text, { profile: 'roleplay-narrative', mode: 'roleplay' });
  assert.equal(narrative.findings.some(finding => finding.code === 'echo-user'), false);
});

test('普通聊天档不检测白描/过度解释动作', () => {
  const text = '她把茶杯推过去，这个动作的用意很明显，仿佛在说别急。';
  const chat = lintText(text, { profile: 'chat', mode: 'chat' });
  assert.equal(chat.counts.overExplainedAction, 0);
  assert.equal(chat.findings.some(finding => finding.code === 'over-explained-action'), false);
  const narrative = lintText(text, { profile: 'roleplay-narrative', mode: 'roleplay' });
  assert.ok(narrative.counts.overExplainedAction >= 1);
});

test('空回复与非法输入安全返回（不抛错）', () => {
  for (const value of ['', null, undefined, 123, {}]) {
    const report = lintText(value, { profile: 'chat' });
    assert.equal(report.chars, 0);
    assert.equal(report.ok, true);
    assert.deepEqual(report.findings, []);
  }
});

test('未知 profile 回落 chat 而不是抛错', () => {
  const report = lintText('早啊。', { profile: 'novel-writing' });
  assert.equal(report.profile, 'chat');
  assert.equal(report.ok, true);
});

test('lintText 是纯函数：同输入同输出，不改写文本', () => {
  const text = '不是不爱，而是不敢。';
  const first = lintText(text, { profile: 'chat' });
  const second = lintText(text, { profile: 'chat' });
  assert.deepEqual(first, second);
  assert.equal(text, '不是不爱，而是不敢。');
});

test('阈值集中在 LINT_THRESHOLDS，且都在合理范围', () => {
  for (const [key, value] of Object.entries(LINT_THRESHOLDS)) {
    if (key === 'narrativeOnlyFindings') continue;
    assert.equal(typeof value, 'number', key);
    assert.ok(value >= 1 && value <= 10, `${key}=${value}`);
  }
  assert.deepEqual([...LINT_THRESHOLDS.narrativeOnlyFindings], ['over-explained-action']);
});

test('任务档的直接回答不被误判成套话', () => {
  const text = '把 config/suite.json 里的 qq 改成 true，然后重启。报错来自缺少 moduleRoot，补上宿主路径即可。';
  const report = lintText(text, { profile: 'task', mode: 'task' });
  assert.equal(report.ok, true);
  assert.deepEqual(report.findings, []);
});
