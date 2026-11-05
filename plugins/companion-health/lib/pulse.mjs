// Live pulse engine (design/pulse-bond-20261103.md §4.5 + §5).
//
// Two halves, deliberately kept apart:
//
//   * **pure functions** at the top (`zoneOf`, `trendOf`, `rmssdOf`, `renderPulseLine`, …) — no
//     clock, no I/O, no state. Everything the prompt says about a body reading is decided here,
//     which is the only way the honesty rules can be tested without a strap.
//   * **one engine factory** holding the ring buffer and the session state machine. It never
//     writes to the database and never talks to the sidecar: the service feeds it snapshots and
//     drains closed-session summaries for persistence.
//
// The rule that shapes every line: a number is printed only when a real notification produced it,
// and its *age* is always visible when it is not fresh. "She can hear your heartbeat" is only
// charming while it stays true — a made-up 120 bpm is the one thing this module exists to prevent.

export const PULSE_ZONES = Object.freeze(['calm', 'warming', 'racing', 'peak']);

/** Pacing hint carried by the live line. Behaviour, not content: the persona does the rest. */
export const PULSE_ZONE_HINTS = Object.freeze({
  calm: '节奏：平静，可以逗他',
  warming: '节奏：正在升温',
  racing: '节奏：他有点扛不住，可以慢一点吊着',
  peak: '节奏：峰值附近，容易失控，注意他的状态',
});

export const PULSE_NOTE = '设备读数，不是医学判断。';

export const DEFAULT_PULSE_POLICY = Object.freeze({
  /** Baseline = median of the first minute of a session; below `baselineMinSamples` there is none. */
  baselineWindowMs: 60_000,
  baselineMinSamples: 10,
  trendWindowMs: 60_000,
  /** Zone thresholds are *deltas above the session baseline*, not absolute heart rates. */
  zoneWarming: 8,
  zoneRacing: 20,
  zonePeak: 40,
  zonePeakAbsolute: 170,
  tooFastBpm: 185,
  tooFastHoldMs: 60_000,
  veryLowBpm: 45,
  /** A sample older than this is not "live" any more, and the line says so. */
  freshMs: 15_000,
  /** Past this the device is treated as gone rather than merely quiet. */
  lostMs: 90_000,
  /**
   * A session **follows the device** (owner decision 2026-11-04): there is no timer window, and the
   * session closes by itself once the broadcast has been quiet for this long — that is what makes
   * "turn the band off → the line disappears" true without any call to `stop`.
   */
  deviceOffMs: 30_000,
  seriesPoints: 60,
  maxSamples: 1800,
  marksMax: 20,
  lineMaxChars: 200,
});

export const PULSE_STOP_REASONS = Object.freeze(['manual', 'ttl', 'host-reload', 'safety', 'device-off']);

function num(value) {
  // `Number(null) === 0` and `Number('') === 0`: a missing reading must never become a reading
  // of zero bpm, so absence is checked before coercion.
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function median(list) {
  const values = (Array.isArray(list) ? list : []).map(num).filter(value => value != null).sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

/** RMSSD over the given RR intervals (ms). Needs at least three intervals to mean anything. */
export function rmssdOf(rrMs) {
  const values = (Array.isArray(rrMs) ? rrMs : []).map(num).filter(value => value != null && value > 0);
  if (values.length < 3) return null;
  let total = 0;
  for (let index = 1; index < values.length; index += 1) {
    const diff = values[index] - values[index - 1];
    total += diff * diff;
  }
  return Math.sqrt(total / (values.length - 1));
}

/** Zone from an absolute bpm and the session baseline. No baseline → no zone (null, not 'calm'). */
export function zoneOf(bpm, baseline, policy = {}) {
  const rules = { ...DEFAULT_PULSE_POLICY, ...(policy || {}) };
  const reading = num(bpm);
  const base = num(baseline);
  if (reading == null) return null;
  if (base == null) return reading >= Number(rules.zonePeakAbsolute) ? 'peak' : null;
  const delta = reading - base;
  if (delta > Number(rules.zonePeak) || reading >= Number(rules.zonePeakAbsolute)) return 'peak';
  if (delta > Number(rules.zoneRacing)) return 'racing';
  if (delta > Number(rules.zoneWarming)) return 'warming';
  return 'calm';
}

/**
 * Baseline for a session: the median of its first `baselineWindowMs`.
 *
 * Returns `{value, delta, ready}` — `ready:false` means "not enough samples yet", which the line
 * turns into words rather than into a zero.
 */
export function baselineOf(samples, { startedAt = 0, policy = {} } = {}) {
  const rules = { ...DEFAULT_PULSE_POLICY, ...(policy || {}) };
  const list = Array.isArray(samples) ? samples : [];
  const from = Number(startedAt) || (list.length ? list[0].t : 0);
  const window = list.filter(sample => sample?.t != null && sample.t <= from + Number(rules.baselineWindowMs)
    && sample.t >= from && sample.bpm != null).map(sample => sample.bpm);
  const value = median(window);
  return {
    value: value == null ? null : Math.round(value),
    samples: window.length,
    ready: window.length >= Number(rules.baselineMinSamples) && value != null,
  };
}

/**
 * Slope sign over the last `trendWindowMs`, plus the size of the change in bpm.
 *
 * `delta` is `last - first` of that window (rounded); `trend` is the sign of a least-squares
 * slope, not of `delta`, so a single spike at either end cannot flip the verdict.
 */
export function trendOf(samples, nowMs = Date.now(), policy = {}) {
  const rules = { ...DEFAULT_PULSE_POLICY, ...(policy || {}) };
  const list = (Array.isArray(samples) ? samples : []).filter(sample => sample?.bpm != null && sample?.t != null);
  const since = Number(nowMs) - Number(rules.trendWindowMs);
  const window = list.filter(sample => sample.t >= since);
  if (window.length < 3) return { trend: null, delta: null, samples: window.length };
  const n = window.length;
  const meanX = window.reduce((total, sample) => total + sample.t, 0) / n;
  const meanY = window.reduce((total, sample) => total + sample.bpm, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const sample of window) {
    const dx = sample.t - meanX;
    numerator += dx * (sample.bpm - meanY);
    denominator += dx * dx;
  }
  const slope = denominator > 0 ? numerator / denominator : 0;
  // bpm per minute; anything under 1.5 bpm/min is reported as flat rather than as noise.
  const perMinute = slope * 60_000;
  const trend = perMinute > 1.5 ? 'up' : (perMinute < -1.5 ? 'down' : 'flat');
  return {
    trend,
    delta: Math.round(window[n - 1].bpm - window[0].bpm),
    samples: n,
    perMinute: Math.round(perMinute * 10) / 10,
  };
}

/**
 * Safety verdict. `null` means "nothing to say"; a string means the next turn must slow down.
 *
 * These are product guardrails, not diagnoses: the sentence attached to each code asks the
 * character to check on the person, never to interpret the number medically.
 */
export function safetyOf({ bpm, sampleAgeMs, sessionActive, fastSince, nowMs, policy = {} } = {}) {
  const rules = { ...DEFAULT_PULSE_POLICY, ...(policy || {}) };
  const reading = num(bpm);
  const age = num(sampleAgeMs);
  if (reading != null && reading >= Number(rules.tooFastBpm)) {
    const held = fastSince == null ? 0 : Number(nowMs) - Number(fastSince);
    if (held >= Number(rules.tooFastHoldMs)) return { code: 'too-fast', bpm: reading, heldMs: held };
  }
  if (reading != null && reading <= Number(rules.veryLowBpm)) {
    return { code: 'very-low', bpm: reading, heldMs: 0 };
  }
  if (sessionActive === true && age != null && age > Number(rules.lostMs)) {
    return { code: 'lost', bpm: reading, heldMs: age };
  }
  return null;
}

/** `21:41:05` in the health timezone; never a locale-dependent format. */
export function formatClock(ms, timeZone = 'Asia/Shanghai') {
  const value = num(ms);
  if (value == null) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(value));
  } catch {
    return new Date(value).toISOString().slice(11, 19);
  }
}

function clampLine(text, maxChars) {
  const limit = Math.max(40, Math.trunc(Number(maxChars) || DEFAULT_PULSE_POLICY.lineMaxChars));
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

/**
 * Assemble the live line so that it degrades **in a fixed order** instead of being cut mid-word.
 *
 * Priority (highest first): the current reading → baseline + movement → the pacing hint → the
 * session peak → the honesty suffix. When the budget is tight, the peak loses its clock, then the
 * hint goes, then the suffix loses its second clause — and only a pathological input reaches the
 * hard clamp. That is why a truncated "（设备读数，不是医学…" can never be the last thing the model
 * reads: the sentence a turn depends on for honesty always arrives whole.
 */
const SUFFIX_FULL = '（设备读数，不是医学判断；数字可以说，别每句都报。）';
const SUFFIX_SHORT = '（设备读数，不是医学判断。）';

function assembleLiveLine({ parts, hint, peak, maxChars }) {
  const limit = Math.max(40, Math.trunc(Number(maxChars) || DEFAULT_PULSE_POLICY.lineMaxChars));
  const build = (chosenParts, chosenHint, chosenSuffix) => {
    const head = `【心跳读数｜真实设备】${chosenParts.join('，')}。`;
    const withHint = chosenHint ? `${head}${chosenHint}。` : head;
    return `${withHint}${chosenSuffix}`;
  };
  const candidates = [];
  const peakVariants = peak
    ? [`本次峰值 ${peak.bpm}（${peak.clock}）`, `本次峰值 ${peak.bpm}`]
    : [null];
  for (const peakText of peakVariants) {
    const full = peakText ? [...parts, peakText] : [...parts];
    candidates.push(build(full, hint, SUFFIX_FULL));
    candidates.push(build(full, hint, SUFFIX_SHORT));
    candidates.push(build(full, '', SUFFIX_SHORT));
  }
  candidates.push(build([parts[0]], '', SUFFIX_SHORT));
  for (const candidate of candidates) {
    if (candidate.length <= limit) return candidate;
  }
  return clampLine(candidates[0], limit);
}

function offlineReason(view) {
  const errorCode = String(view?.sidecar?.errorCode ?? '');
  if (errorCode === 'unreachable') return '接收端没在运行';
  if (errorCode === 'timeout') return '接收端没响应';
  if (errorCode === 'non-loopback-refused' || errorCode === 'payload-rejected') return '读数被安全策略拒绝';
  if (errorCode === 'http-error' || errorCode === 'bad-json') return '接收端返回异常';
  const deviceCode = String(view?.lastErrorCode ?? '');
  if (deviceCode === 'connect-failed') return '连接失败';
  if (deviceCode === 'scan-timeout') return '没扫到广播设备';
  if (deviceCode === 'notify-failed') return '设备不给读数';
  if (deviceCode === 'disconnected') return '设备断开';
  return '设备没有读数';
}

/**
 * The injected line (contract §5). Returns `''` when there is nothing honest to say:
 * no session, no numbers, no speculation.
 */
export function renderPulseLine(view, { maxChars = DEFAULT_PULSE_POLICY.lineMaxChars, policy = {} } = {}) {
  const rules = { ...DEFAULT_PULSE_POLICY, ...(policy || {}) };
  if (!view || view.session?.active !== true) return '';
  if (view.enabled === false) return '';

  const bpm = num(view.bpm);
  const age = num(view.sampleAgeMs);
  const reachable = view.sidecar?.reachable !== false;
  const safety = view.safety && typeof view.safety === 'object' ? view.safety : null;

  // 4. safety first: it overrides every other form, including "no reading".
  if (safety) {
    const seconds = Math.max(1, Math.round(Number(safety.heldMs ?? 0) / 1000));
    if (safety.code === 'too-fast') {
      return clampLine(`【心跳读数｜注意】${safety.bpm} bpm 已持续偏高 ${seconds} 秒；先停下来关心他，不要继续加码。`, maxChars);
    }
    if (safety.code === 'very-low') {
      return clampLine(`【心跳读数｜注意】${safety.bpm} bpm 偏低；先停下来确认他的状态，别自己往下演。`, maxChars);
    }
    return clampLine(`【心跳读数｜注意】读数已中断 ${seconds} 秒；先确认设备和他的状态，不要凭空往下演。`, maxChars);
  }

  // 3. offline: no sidecar, or nothing from the device for longer than `lostMs`.
  const lost = !reachable || age == null || age > Number(rules.lostMs) || bpm == null;
  if (lost) {
    return clampLine(`【心跳读数】设备此刻不在线（原因：${offlineReason(view)}）。这件事现在不知道，不要假装知道。`, maxChars);
  }

  // 2. quiet: a real reading, but not a fresh one.
  if (age > Number(rules.freshMs)) {
    return clampLine(`【心跳读数】最后读数 ${Math.round(bpm)}（${Math.round(age / 1000)} 秒前），现在没有新数据；不要当成实时。`, maxChars);
  }

  const peak = view.peak && num(view.peak.bpm) != null
    ? { bpm: Math.round(view.peak.bpm), clock: formatClock(view.peak.at) || '刚才' }
    : null;

  // 1b. a live reading, but the baseline is still forming: say exactly that.
  if (num(view.baseline) == null) {
    const tail = peak ? `；本次峰值 ${peak.bpm}（${peak.clock}）` : '';
    return clampLine(`【心跳读数｜真实设备】现在 ${Math.round(bpm)} bpm${tail}。还在建立基线，先别对“快不快”下结论。${SUFFIX_SHORT}`, maxChars);
  }

  const base = Math.round(Number(view.baseline));
  const trend = String(view.trend ?? '');
  const delta = num(view.trendDelta ?? view.delta);
  // A slope can be non-zero while the *change* rounds to 0 bpm ("近 1 分钟降了 0" is nonsense).
  const magnitude = delta == null ? 0 : Math.abs(Math.round(delta));
  let movement = '读数平稳';
  if (magnitude >= 1 && trend === 'up') movement = `近 1 分钟升了 ${magnitude}`;
  else if (magnitude >= 1 && trend === 'down') movement = `近 1 分钟降了 ${magnitude}`;

  const zone = PULSE_ZONES.includes(String(view.zone)) ? view.zone : null;
  const hint = zone ? PULSE_ZONE_HINTS[zone] : '';
  return assembleLiveLine({
    parts: [`现在 ${Math.round(bpm)} bpm`, `基线 ${base}`, movement],
    hint,
    peak,
    maxChars,
  });
}

/**
 * The engine. One per process (the service owns it).
 *
 * `now` is injectable so tests can move time without sleeping.
 */
export function createPulseEngine({
  policy = {},
  now = () => Date.now(),
  timeZone = 'Asia/Shanghai',
  createId = null,
} = {}) {
  const rules = { ...DEFAULT_PULSE_POLICY, ...(policy || {}) };
  const clock = () => {
    const value = Number(now());
    return Number.isFinite(value) ? Math.trunc(value) : Date.now();
  };
  const nextId = typeof createId === 'function'
    ? createId
    : () => `pulse-${clock().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  /** `{t, bpm}` readings, oldest first, bounded by count and by age. */
  let samples = [];
  /** Last snapshot fields from the adapter (device identity, contact, error code). */
  let last = null;
  /** Last successful reading, kept across polls so a stale number can still be *dated*. */
  let lastSample = null;
  /** Consecutive ≥tooFastBpm run start (bpm), for the sustained-fast guardrail. */
  let fastSince = null;
  /** Session or null. Marks and counters live inside it; the DB row is written on close. */
  let session = null;
  /** Sessions closed by TTL inside `applyState`; the service drains and persists them. */
  let closed = [];
  /** Whether the last adapter call succeeded. */
  let reachable = false;
  let errorCode = null;
  let enabled = true;

  function prune(nowMs) {
    const oldest = nowMs - 30 * 60_000;
    samples = samples.filter(sample => sample.t >= oldest);
    if (samples.length > Number(rules.maxSamples)) samples = samples.slice(samples.length - Number(rules.maxSamples));
  }

  /** Record one session-relevant reading. Called only for genuinely new samples. */
  function absorb(sample) {
    samples.push(sample);
    prune(sample.t);
    if (sample.bpm >= Number(rules.tooFastBpm)) {
      if (fastSince == null) fastSince = sample.t;
    } else {
      fastSince = null;
    }
    if (!session) return;
    session.samples += 1;
    if (session.peak == null || sample.bpm > session.peak.bpm) session.peak = { bpm: sample.bpm, at: sample.t };
    // The zone needs a baseline; before that, readings still count towards it but not to a zone.
    const baseline = session.baseline;
    const zone = baseline == null ? null : zoneOf(sample.bpm, baseline, rules);
    if (zone) session.zoneCounts[zone] = (session.zoneCounts[zone] ?? 0) + 1;
    if (session.baseline == null) {
      const candidate = baselineOf(session.samplesWindow, { startedAt: session.startedAt, policy: rules });
      if (candidate.ready) session.baseline = candidate.value;
    }
  }

  /**
   * Feed one adapter result. `ok:false` only flips reachability — the previous reading stays,
   * but its age keeps growing, which is exactly what the line needs in order to be honest.
   */
  function applyState(result) {
    const nowMs = clock();
    if (!result || result.ok !== true) {
      reachable = false;
      errorCode = String(result?.code ?? 'unreachable');
    } else {
      reachable = true;
      errorCode = null;
      last = {
        connected: result.connected === true,
        deviceLabel: result.deviceLabel ?? null,
        addressHash: result.addressHash ?? null,
        contact: result.contact ?? 'unsupported',
        sensorLocation: result.sensorLocation ?? null,
        lastErrorCode: result.lastErrorCode ?? null,
        scanning: result.scanning === true,
        rrMs: Array.isArray(result.rrMs) ? result.rrMs : [],
      };
      if (result.bpm != null && (lastSample == null || (result.sampleAt != null && result.sampleAt > lastSample.t))) {
        lastSample = { t: Number(result.sampleAt ?? nowMs), bpm: Number(result.bpm) };
        if (session) session.samplesWindow.push({ t: lastSample.t, bpm: lastSample.bpm });
        absorb({ t: lastSample.t, bpm: lastSample.bpm });
      }
    }
    // 1. device-driven close (owner rule 2026-11-04): turning the band's broadcast off ends the
    //    session by itself, so the injected line disappears without anyone calling `stop`.
    //    Measured from the last real beat — floored at the session start, so a stale sample from a
    //    previous session cannot close a fresh one instantly.
    if (session) {
      const connectedNow = result?.ok === true ? last?.connected === true : null;
      if (connectedNow === false) {
        if (session.disconnectedSince == null) session.disconnectedSince = nowMs;
      } else if (connectedNow === true) {
        session.disconnectedSince = null;
      }
      const reference = lastSample == null ? session.startedAt : Math.max(session.startedAt, lastSample.t);
      const quietFor = nowMs - reference;
      const downFor = session.disconnectedSince == null ? null : nowMs - session.disconnectedSince;
      const grace = Number(rules.deviceOffMs);
      if (quietFor > grace || (downFor != null && downFor > grace)) close('device-off');
    }
    // 2. optional timer window (only when the caller explicitly asked for one)
    if (session && session.endsAt != null && nowMs >= session.endsAt) close('ttl');
    return { ok: true };
  }

  function sessionView(nowMs) {
    if (!session) {
      return {
        active: false, id: null, startedAt: null, endsAt: null, minutes: null,
        mode: null, remainingMs: null, deviceOffMs: Number(rules.deviceOffMs),
      };
    }
    return {
      active: true,
      id: session.id,
      startedAt: session.startedAt,
      endsAt: session.endsAt,
      minutes: session.minutes,
      mode: session.mode,
      remainingMs: session.endsAt == null ? null : Math.max(0, session.endsAt - nowMs),
      deviceOffMs: Number(rules.deviceOffMs),
    };
  }

  /** The facade view behind `service.pulse()` and the studio card. */
  function view() {
    const nowMs = clock();
    const bpm = lastSample?.bpm ?? null;
    const sampleAgeMs = lastSample == null ? null : Math.max(0, nowMs - lastSample.t);
    const sessionActive = session != null;
    const baseline = session?.baseline ?? null;
    const trendResult = trendOf(samples.filter(sample => sample.t >= nowMs - Number(rules.trendWindowMs)), nowMs, rules);
    const safety = safetyOf({
      bpm, sampleAgeMs, sessionActive, fastSince, nowMs, policy: rules,
    });
    return {
      ok: true,
      enabled,
      sidecar: { reachable, baseUrl: null, errorCode },
      connected: last?.connected === true,
      // Why the link is down, straight from the device layer (`disconnected` = the band stopped
      // broadcasting). The UI uses it to tell "the owner switched the band off" apart from an error.
      lastErrorCode: last?.lastErrorCode ?? null,
      deviceLabel: last?.deviceLabel ?? null,
      bpm,
      sampleAgeMs,
      quality: last?.contact === 'no' ? 'no-contact' : (sampleAgeMs == null || sampleAgeMs > Number(rules.freshMs) ? 'sparse' : 'ok'),
      contact: last?.contact ?? 'unsupported',
      sensorLocation: last?.sensorLocation ?? null,
      rrMs: last?.rrMs ?? [],
      rmssdMs: rmssdOf(last?.rrMs ?? []),
      zone: zoneOf(bpm, baseline, rules),
      trend: trendResult.trend,
      trendDelta: trendResult.delta,
      baseline,
      peak: session?.peak ? { bpm: session.peak.bpm, at: session.peak.at } : null,
      session: sessionView(nowMs),
      series: samples.slice(-Number(rules.seriesPoints)).map(sample => ({ t: sample.t, bpm: sample.bpm })),
      safety,
      note: PULSE_NOTE,
    };
  }

  function startSession({ minutes = null } = {}) {
    if (session) return { ok: true, already: true, session: sessionView(clock()) };
    const nowMs = clock();
    const wanted = Number(minutes);
    const limit = Number(rules.sessionMinutesCeiling ?? 120);
    // No `minutes` → the session follows the device and has **no** end time. Only an explicit
    // request turns it into a timed window (kept for "keep it on for 20 minutes" style use).
    const duration = Number.isFinite(wanted) && wanted > 0
      ? Math.min(limit, Math.max(5, Math.trunc(wanted)))
      : null;
    session = {
      id: nextId(),
      startedAt: nowMs,
      endsAt: duration == null ? null : nowMs + duration * 60_000,
      minutes: duration,
      mode: duration == null ? 'device' : 'timer',
      samples: 0,
      samplesWindow: [],
      baseline: null,
      peak: null,
      marks: [],
      zoneCounts: { calm: 0, warming: 0, racing: 0, peak: 0 },
      disconnectedSince: null,
    };
    // A session starts its own baseline window; older samples must not leak into it.
    return { ok: true, already: false, session: sessionView(nowMs) };
  }

  /** Build the persistence payload for the current session (contract §4.3). */
  function summaryOf(sessionState, reason) {
    const fallbackBaseline = baselineOf(sessionState.samplesWindow ?? [], { startedAt: sessionState.startedAt, policy: rules });
    return {
      id: sessionState.id,
      startedAt: sessionState.startedAt,
      endedAt: clock(),
      stopReason: PULSE_STOP_REASONS.includes(reason) ? reason : 'manual',
      baselineBpm: sessionState.baseline ?? (fallbackBaseline.ready ? fallbackBaseline.value : null),
      peakBpm: sessionState.peak?.bpm ?? null,
      peakAt: sessionState.peak?.at ?? null,
      samples: sessionState.samples,
      zoneCounts: { ...sessionState.zoneCounts },
      marks: sessionState.marks.slice(0, Number(rules.marksMax)).map(mark => ({ at: mark.at, label: mark.label, bpm: mark.bpm })),
    };
  }

  function close(reason) {
    if (!session) return null;
    const summary = summaryOf(session, reason);
    session = null;
    closed.push(summary);
    return summary;
  }

  function stopSession(reason = 'manual') {
    if (!session) return { ok: false, code: 'pulse-no-session' };
    const summary = close(reason);
    return { ok: true, session: null, summary };
  }

  function mark(label = '') {
    if (!session) return { ok: false, code: 'pulse-no-session' };
    const nowMs = clock();
    const text = String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const entry = { at: nowMs, label: text, bpm: lastSample?.bpm ?? null };
    if (session.marks.length >= Number(rules.marksMax)) session.marks.shift();
    session.marks.push(entry);
    return { ok: true, mark: entry, count: session.marks.length };
  }

  /** Summaries closed by the engine (TTL) since the last drain. Persisted by the service. */
  function drainClosed() {
    const out = closed;
    closed = [];
    return out;
  }

  function line(options = {}) {
    const current = view();
    return renderPulseLine(current, {
      maxChars: options.maxChars ?? rules.lineMaxChars,
      policy: rules,
    });
  }

  function setEnabled(value) {
    enabled = value !== false;
  }

  /** Forget everything: used by tests and by `service.stop()`. */
  function reset() {
    samples = [];
    last = null;
    lastSample = null;
    fastSince = null;
    session = null;
    closed = [];
    reachable = false;
    errorCode = null;
  }

  return {
    applyState,
    view,
    line,
    startSession,
    stopSession,
    mark,
    close,
    drainClosed,
    setEnabled,
    reset,
    active: () => sessionView(clock()),
    policy: Object.freeze({ ...rules }),
    timeZone,
  };
}
