export const name = 'qq-idle-compaction';
export const inject = ['agents', 'tokenMeter', 'llm', 'compaction'];

const HOUR_MS = 60 * 60_000;
const hourInShanghai = new Intl.DateTimeFormat('en', {
  timeZone: 'Asia/Shanghai', hour: 'numeric', hourCycle: 'h23',
});

function lastTurnTime(session) {
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq);
    if (event?.type === 'turn/end' || event?.type === 'turn/start') return event.time;
  }
}

export function apply(ctx) {
  const controller = new AbortController();
  const retryAfter = new WeakMap();
  let running = false;

  async function tick() {
    if (running || controller.signal.aborted || Number(hourInShanghai.format(Date.now())) < 4) return;
    running = true;
    try {
      for (const agent of ctx.agents.roots()) {
        if (controller.signal.aborted) break;
        const { session } = agent;
        if (!/^qq-(?:dm|group)-\d+$/.test(session.id) || agent.status !== 'idle') continue;
        const now = Date.now();
        if ((retryAfter.get(session) ?? 0) > now) continue;
        const lastTurn = lastTurnTime(session);
        if (!Number.isFinite(lastTurn) || now - lastTurn <= HOUR_MS) continue;
        const seq = session.seq;
        const route = session.requestHeader()?.config;
        if (!route?.provider || !route?.model) continue;
        try {
          const info = await ctx.llm.resolveModelInfo(route.provider, route.model);
          const window = info.context?.contextWindow;
          if (controller.signal.aborted || session.seq !== seq || agent.status !== 'idle') continue;
          if (!Number.isFinite(window) || window <= 0) continue;
          const { totalTokens } = ctx.tokenMeter.measure(session);
          if (!Number.isFinite(totalTokens) || totalTokens <= 0.9 * window) continue;
          if (Number(hourInShanghai.format(Date.now())) < 4) break;
          retryAfter.set(session, Date.now() + HOUR_MS);
          const result = await ctx.compaction.compactNow(agent, controller.signal);
          if (result) console.log(`[qq-idle-compaction] ${session.id} compacted (${totalTokens}/${window} tokens)`);
        } catch (error) {
          if (!controller.signal.aborted) console.warn(`[qq-idle-compaction] ${session.id}: ${error.message}`);
        }
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void tick().catch(error => console.warn(`[qq-idle-compaction] ${error.message}`));
  }, 60_000);
  timer.unref?.();
  ctx.on('dispose', () => {
    clearInterval(timer);
    controller.abort();
  });
  console.log('[qq-idle-compaction] scheduled (04:00–24:00 Asia/Shanghai, >90%, >1h idle)');
}
