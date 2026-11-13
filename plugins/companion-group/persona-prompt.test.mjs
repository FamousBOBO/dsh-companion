import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGroupPersonaSnapshot } from '../companion-foundation/group-persona.mjs';
import { renderPublicPersona } from './persona-prompt.mjs';
import { apply, GROUP_PERSONA } from './index.mjs';

test('public role-card fields reach the group prompt without private sections', () => {
  const markdown = ['# 角色设定', '- **姓名**: 测试角色', '- **性格底色**: 活泼好奇', '- **说话习惯**: 短句口语', '- **兴趣爱好**: 拍照', '## 私聊秘密', '- **性格底色**: private-marker', '## 主人的公开身份', 'private-owner-marker'].join(String.fromCharCode(10));
  const snapshot = buildGroupPersonaSnapshot(markdown);
  const text = renderPublicPersona(snapshot);
  assert.match(text, /测试角色/);
  assert.match(text, /活泼好奇/);
  assert.match(text, /短句口语/);
  assert.doesNotMatch(text, /private-marker|private-owner-marker/);
  const sections = [];
  apply({ tools: { guard() {}, restrict() {} }, systemPrompt: { section(s) { sections.push(s); } }, on() {} });
  assert.equal(typeof sections.find(s => s.name === 'companion:group-public-persona').text, 'function');
  assert.match(GROUP_PERSONA, /expression_reply\(mode=text_then_sticker/);
  assert.match(GROUP_PERSONA, /此规则优先于人格里的颜文字习惯/);
});
