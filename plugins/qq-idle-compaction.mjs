/** qq-idle-compaction：QQ 会话空闲时做一次上下文压缩（可选，**默认关闭**）。
 *
 * 为什么默认关：它每 60 秒醒一次，命中条件时会调用宿主的压缩服务——压缩会走到
 * 模型（计费），属于"后台模型任务"。装好套件就自己开始花调用额度不是默认行为。
 *
 * 打开方式（二选一，都不需要改代码）：
 *   - `config/suite.json` 里 `"qqIdleCompaction": true`（setup 生成的模板里有这一项）；
 *   - 环境变量 `QQ_IDLE_COMPACTION=1`。
 *
 * 另外两个可调项（都有默认值）：
 *   - `QQ_IDLE_COMPACTION_TZ`（默认 `Asia/Shanghai`）：判断"夜里不做"的时区；
 *   - `QQ_IDLE_COMPACTION_FROM_HOUR`（默认 `4`）：这个整点之前不跑（不半夜烧调用）。
 */

export const name = 'qq-idle-compaction';
export const inject = ['agents', 'tokenMeter', 'llm', 'compaction'];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** `true/false/1/0/yes/no` 都认；其余一律当 false（fail-closed）。 */
function flag(raw) {
  return /^(1|true|yes|on)$/i.test(String(raw ?? '').trim());
}

export function enabled(env = process.env) {
  return flag(env.QQ_IDLE_COMPACTION);
}

function hourOf(now, timeZone) {
  const hour = new Intl.DateTimeFormat('en', { timeZone, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(now))
    .find((part) => part.type === 'hour');
  return Number(hour?.value);
}

function lastTurnTime(session) {
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq);
    if (event?.type === 'turn/end' || event?.type === 'turn/start') return event.time;
  }
}

export function apply(ctx) {
  if (!enabled()) {
    console.log('[qq-idle-compaction] disabled by default (set QQ_IDLE_COMPACTION=1 to enable)');
    return;
  }

  const timeZone = process.env.QQ_IDLE_COMPACTION_TZ || 'Asia/Shanghai';
  const fromHour = Number(process.env.QQ_IDLE_COMPACTION_FROM_HOUR ?? 4);
  const startHour = Number.isFinite(fromHour) ? fromHour : 4;
  const controller = new AbortController();
  const retryAfter = new WeakMap();
  let running = false;

  async function tick() {
    if (running || controller.signal.aborted) return;
    if (hourOf(Date.now(), timeZone) < startHour) return;
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
          if (hourOf(Date.now(), timeZone) < startHour) break;
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
  }, MINUTE_MS);
  timer.unref?.();
  ctx.on('dispose', () => {
    clearInterval(timer);
    controller.abort();
  });
  console.log(`[qq-idle-compaction] scheduled (${startHour}:00–24:00 ${timeZone}, >90% window, >1h idle)`);
}
