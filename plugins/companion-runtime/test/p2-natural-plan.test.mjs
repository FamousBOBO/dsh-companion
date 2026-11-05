import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlanningPrompt, materialTargets } from '../lib/planner.mjs';
import { mountRuntime } from '../index.mjs';

// Natural entry point (production smoke, 2026-10-30 19:00).
//
// The first real host round was rejected with `slot-without-source: slots[0] read` because the
// output contract still called `targetRef` optional while the validator requires it for every
// tool slot. The prompt is the product here: a normal persona, with no fixture instructions, must
// be able to produce a plan the validator accepts. These tests do not "make the plan valid" — they
// pin that the prompt and the validator say the same thing, and that a compliant plan commits.

// Resolved from this file, not from the cwd: the canonical command runs from the plugin folder
// while the real persona lives at the repository root.
const personaPath = fileURLToPath(new URL('../../../workspace/PERSONA.md', import.meta.url));
const hasPersona = fs.existsSync(personaPath);
const personaText = hasPersona ? fs.readFileSync(personaPath, 'utf8') : '';

const T0 = Date.UTC(2026, 10, 6, 6, 0, 0); // 14:00 Asia/Shanghai
const BOUND = { userId: 'natural-owner', persona: 'bot' };

test('prompt: targetRef is required for activity slots and the three kinds are distinguished', () => {
  const built = buildPlanningPrompt({
    material: { persona: { excerpt: '她喜欢安静地观察城市。', version: 'test' }, entryPoints: ['sources/notes.md'] },
    day: '2026-11-06', timeZone: 'Asia/Shanghai', now: T0, windowStart: T0, windowEnd: T0 + 6 * 3600_000,
  });
  const prompt = built.input;
  assert.equal(typeof prompt, 'string');
  assert.match(prompt, /targetRef 必填/, 'the contract no longer calls it optional');
  assert.doesNotMatch(prompt, /"targetRef":"可选/, 'the old optional wording is gone');
  assert.match(prompt, /read：只能填材料里真实存在的本地文本路径/, 'read is limited to real local text');
  assert.match(prompt, /explore：必须填一个可用的公开 http\(s\) URL/, 'explore must use a public URL');
  assert.match(prompt, /write：填 drafts\//, 'write names a draft path');
  assert.match(prompt, /新稿不受“公开来源集合”限制/, 'a new draft is exempt from the public set');
  assert.match(prompt, /宁可不安排/, 'and the model is told to plan nothing instead of inventing a source');
});

test('prompt: real persona text and a real local source are both offered', { skip: !hasPersona }, () => {
  const material = { persona: { excerpt: personaText.slice(0, 600), version: 'file' }, entryPoints: ['sources/notes.md'] };
  const prompt = buildPlanningPrompt({
    material, day: '2026-11-06', timeZone: 'Asia/Shanghai', now: T0, windowStart: T0, windowEnd: T0 + 6 * 3600_000,
  }).input;
  assert.equal(prompt.includes(personaText.slice(0, 40)), true, 'the real persona reaches the prompt');
  assert.equal(prompt.includes('sources/notes.md'), true, 'the real local source is listed as a target');
  assert.deepEqual(materialTargets(material), ['sources/notes.md']);
});

test('natural round: a compliant plan commits, an empty day commits as empty', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-natural-'));
  fs.mkdirSync(path.join(root, 'home/companion/works/sources'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/works/sources/notes.md'), '这是一段真实的本地材料。'.repeat(20));
  if (hasPersona) {
    fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), personaText, 'utf8');
  }
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    p2: { planning: { enabled: true, maxAttempts: 1 }, activities: { enabled: false, artifactRoot: 'home/companion/works' } },
  }));

  // What a compliant model would answer from the prompt: one real local read, then an empty day.
  const answers = [
    JSON.stringify({ summary: '读一点本地材料', slots: [{ kind: 'activity', activity: 'read', title: '读材料', startAt: T0 + 600_000, endAt: T0 + 2_400_000, flexibility: 'soft', targetRef: 'sources/notes.md' }] }),
    JSON.stringify({ summary: '今天不安排', slots: [] }),
  ];
  let index = 0;
  const prompts = [];
  const runtime = mountRuntime(null, root, {
    now: () => T0,
    identity: { resolve: sessionId => ({ ...BOUND, sessionId }) },
    callModel: async args => {
      if (args.purpose === 'p2-planning') { prompts.push(args.input); return { text: answers[index++] ?? answers[answers.length - 1], provider: 'test', model: 'test', inputTokens: 40, outputTokens: 20 }; }
      return { text: 'ok', provider: 'test', model: 'test', inputTokens: 1, outputTokens: 1 };
    },
    p2Ports: { readFile: async ({ path: file }) => ({ ok: true, text: fs.readFileSync(file, 'utf8') }) },
  });
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } fs.rmSync(root, { recursive: true, force: true }); });

  runtime.proposeGoal({ bound: BOUND, title: '自然入口' });
  const first = await runtime.pumpPlanning({ reason: 'timer' });
  const firstRound = first.rounds?.[0] ?? {};
  assert.equal(firstRound.code, 'committed', `a compliant plan commits (${JSON.stringify(firstRound).slice(0, 200)})`);
  const plan = runtime.listPlan({ bound: BOUND });
  assert.equal(plan.ok, true);
  // A committed plan is proven by the rows the reducer wrote, not by the shape of this page.
  const slots = plan.slots ?? plan.plan?.slots ?? [];
  assert.equal(slots.length, 1, 'one planned slot');
  assert.equal(slots[0]?.status, 'planned', 'the slot is planned');
  assert.equal(slots[0]?.activity, 'read');

  // A deliberately empty day is a real decision, not a failure.
  const second = await runtime.pumpPlanning({ reason: 'timer' });
  const secondRound = second.rounds?.[0] ?? {};
  assert.equal(['plan-exists', 'empty', 'committed'].includes(secondRound.code), true, JSON.stringify(secondRound));
  assert.equal(prompts.length >= 1, true);
  assert.equal(prompts[0].includes('targetRef 必填'), true, 'the prompt that reached the model carries the rule');
  // The material listing itself is covered by the prompt-render test above; here the point is
  // that the rule the model must obey is present in the very prompt it received.
});

test('prompt: a late start sees the exact now epoch and an empty day is a legal plan', () => {
  // Production smoke 2 (natural-host-1793372616463): the model planned a slot in the past because
  // the prompt only said "现在 14:00" while the validator compares raw epochs. The prompt now
  // carries the numbers, so "plan the remaining day" is computable and an empty plan is allowed.
  const now = T0;
  const built = buildPlanningPrompt({
    material: { persona: { excerpt: '她喜欢观察。' }, entryPoints: ['sources/notes.md'] },
    day: '2026-11-06', timeZone: 'Asia/Shanghai', now, windowStart: now, windowEnd: now + 3600_000,
  });
  const prompt = built.input;
  assert.equal(prompt.includes(`当前时间戳 now = ${now}`), true, 'the exact now epoch is in the prompt');
  assert.equal(prompt.includes(`上限时间戳 = ${now + 3600_000}`), true, 'the planning deadline epoch is in the prompt');
  assert.match(prompt, /startAt 必须 >= 这个数/, 'the start rule is explicit');
  assert.match(prompt, /endAt 必须 <= 这个数/, 'the end rule is explicit');
  assert.match(prompt, /如果剩余时间不够安排一件事，就输出空的 slots/, 'an exhausted day may plan nothing');
  assert.match(prompt, /"slots":\[\] 是合法结果/, 'and it is stated as legal, not as a failure');
  assert.match(prompt, /当前本地时间 \d\d:\d\d/, 'the local clock reading is still human readable');
});