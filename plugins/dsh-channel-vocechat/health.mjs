// 健康探针：三个独立事实，分开报，因为把它们揉成一个布尔就是「链路正常」这句谎话的源头。
//
//   - **出站**：能不能拿到自己的资料？（`GET /api/user/me`，需要有效 access token）
//   - **入站**：SSE 循环在跑吗？游标在哪？最近一次收到帧是什么时候？
//   - **认证**：access token 还在有效期内吗？续期过几次？失败过几次？
//
// `ok` 只有三者都对才为 true。其余情况是 `degraded` 并点名原因 —— 从不返回裸布尔。

export function createHealthProbe({ api, sse, auth, enabled } = {}) {
  return async function probe() {
    const outbound = enabled
      ? await api.status()
      : { ok: false, code: 'disabled', message: '插件未启用', latencyMs: 0 };

    const sseInfo = sse.info();
    const authInfo = auth.describe();

    // Inbound is "healthy" when the loop is running AND we have seen a frame recently enough
    // that the stream is demonstrably alive. A running loop with no frames for an hour is
    // still worth flagging — ours sends `heartbeat` frames, so silence is a signal.
    const now = Date.now();
    const lastFrameAt = sseInfo.counters.lastFrameAt ?? null;
    const silentMs = lastFrameAt === null ? null : now - lastFrameAt;
    const streamAlive = sseInfo.running === true;

    const tokenValid = authInfo.hasAccessToken === true
      && typeof authInfo.expiresAt === 'number'
      && authInfo.expiresAt > now;

    const ok = enabled && outbound.ok === true && streamAlive && tokenValid;

    const reasons = [];
    if (!enabled) reasons.push('disabled');
    else {
      if (!outbound.ok) reasons.push(`outbound:${outbound.code ?? 'unknown'}`);
      if (!streamAlive) reasons.push('sse-not-running');
      if (!tokenValid) reasons.push(authInfo.hasAccessToken ? 'access-token-expired' : 'no-access-token');
      if (authInfo.stats?.failures > 0) reasons.push('auth-failures');
      if (sseInfo.counters?.errors > 0) reasons.push('sse-errors');
      if (sseInfo.counters?.rejected > 0) reasons.push('frames-rejected');
    }

    return {
      ok,
      state: ok ? 'ok' : enabled ? 'degraded' : 'disabled',
      outbound,
      inbound: {
        running: streamAlive,
        cursor: sseInfo.cursor,
        connects: sseInfo.counters.connects,
        disconnects: sseInfo.counters.disconnects,
        chat: sseInfo.counters.chat,
        skipped: sseInfo.counters.skipped,
        errors: sseInfo.counters.errors,
        lastFrameAt,
        silentMs,
      },
      auth: {
        uid: authInfo.uid,
        hasAccessToken: authInfo.hasAccessToken,
        hasRefreshToken: authInfo.hasRefreshToken,
        expiresAt: authInfo.expiresAt,
        source: authInfo.source,
        renewals: authInfo.stats?.renewals ?? 0,
        failures: authInfo.stats?.failures ?? 0,
      },
      reasons,
      checkedAt: now,
    };
  };
}
