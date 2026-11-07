import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Code, mediaError } from '../errors.mjs';
import { joinUrl } from './shared.mjs';

// The configured coordination server grants a lease. Generation still goes
// directly to NovelAI, and no prompts or raw credentials go to the queue.
export async function withNaiQueue({ section, key, net, signal }, generate) {
  if (section.transport !== 'official' || section.queueEnabled !== true) return generate();
  if (!key?.trim()) throw mediaError(Code.NOT_CONFIGURED, 'NovelAI 密钥未配置');
  const queueSignal = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
  const identity = {
    key_hash: createHash('sha256').update(key.trim()).digest('hex'),
    user_id: section.queueUserId.trim(),
    task_id: randomUUID(),
  };
  const call = async (route, body, requestSignal) => {
    const response = await net.request(joinUrl(section.queueBaseUrl.trim(), route), {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs: 5000,
      maxBytes: 32_768,
      provider: 'NovelAI 排队服务器',
      signal: requestSignal,
    });
    if (!response.ok) throw mediaError(Code.UPSTREAM, 'NovelAI 排队服务器请求失败');
    return body && (route === '/complete' || route === '/leave-queue') ? null : JSON.parse(response.bytes.toString('utf8'));
  };
  let lease = null;
  let attempted = false;
  try {
    try {
      queueSignal.throwIfAborted();
      attempted = true;
      const entry = await call('/join-queue', { ...identity, greeting: null }, queueSignal);
      lease = typeof entry?.lock_token === 'string' && entry.lock_token || null;
      while (!lease) {
        await delay(1000, undefined, { signal: queueSignal });
        const turn = await call('/my-turn?' + new URLSearchParams(identity), null, queueSignal);
        if (turn?.is_my_turn === true && typeof turn.lock_token === 'string') lease = turn.lock_token;
      }
      queueSignal.throwIfAborted();
    } catch {
      throw mediaError(Code.UPSTREAM, 'NovelAI 排队失败或已取消，本次未提交生图');
    }
    signal?.throwIfAborted();
    return await generate();
  } finally {
    if (attempted) {
      await call(lease ? '/complete' : '/leave-queue', { ...identity, lock_token: lease }, undefined).catch(() => {});
    }
  }
}
