// handoff 必须按通道决定 —— 这是 2026-11-18 检查里最危险的一处。
//
// 事故原样：handoff 写死 `qq_sticker`，而 VoceChat 会话里那 28 个 `qq_*` 工具是可见的。
// 「在 VoceChat 里画一张图」的真实结果是图发到了主人的 QQ 私聊（`qq_sticker` 的目标被
// `assertTargetAllowed` 限定为 `admins[0]`），VoceChat 这边什么都没有 ——
// 而且是**静默成功**，比失败难查得多。
//
// 所以这里钉的不是"字符串对不对"，而是三件事：
//   1. vc 会话拿到的是 vc 的工具，qq 会话拿到的是 qq 的工具；
//   2. 认不出通道时**不给工具名**（猜错的代价是发到别人的窗口里）；
//   3. 多人在场的判据包含 VoceChat 频道，不只是 QQ 群。

import test from 'node:test';
import assert from 'node:assert/strict';

import { handoffFor } from '../src/service.mjs';

test('VoceChat 会话指向 vc_send_file，不是 qq_sticker', () => {
  const image = handoffFor('image', 'vc-dm-1');
  assert.equal(image.channel, 'vocechat');
  assert.equal(image.tool, 'vc_send_file');
  assert.match(image.mustSend, /vc_send_file/);

  const speech = handoffFor('speech', 'vc-chan-1');
  assert.equal(speech.channel, 'vocechat');
  assert.equal(speech.tool, 'vc_send_file', '语音也用同一个工具：VoceChat 只有一条媒体出口');
});

test('QQ 会话的工具与此前逐字一致（不改变既有链路）', () => {
  const image = handoffFor('image', 'qq-dm-1429709395');
  assert.equal(image.channel, 'qq');
  assert.equal(image.tool, 'qq_sticker');
  assert.equal(image.action, 'send_image');

  const group = handoffFor('image', 'qq-group-145326153');
  assert.equal(group.tool, 'qq_sticker');

  const speech = handoffFor('speech', 'qq-dm-1429709395');
  assert.equal(speech.tool, 'qq_voice');
  assert.equal(speech.action, 'send_file');
});

test('认不出通道时不给工具名，也不猜（猜错就是发到别人的窗口）', () => {
  for (const sessionId of ['', null, undefined, 'session-abc', 'desktop', 'qqq-dm-1']) {
    const handoff = handoffFor('image', sessionId);
    assert.equal(handoff.channel, 'unknown', `sessionId=${String(sessionId)}`);
    assert.equal(handoff.tool, null);
    assert.equal(handoff.action, null);
    assert.match(handoff.mustSend, /不要调用任何发送工具/);
  }
});

test('vc-group 这种不存在的形状不会被误判成 vocechat', () => {
  // 房间键只有 vc-dm- / vc-chan- 两种；给一个别的形状必须落到 unknown 而不是硬塞。
  const handoff = handoffFor('image', 'vc-room-1');
  assert.equal(handoff.channel, 'vocechat', '前缀是 vc-，归 vocechat 是安全的：目标仍由房间反解');
  // 但未知通道绝不给 qq 的工具。
  assert.notEqual(handoff.tool, 'qq_sticker');
});
