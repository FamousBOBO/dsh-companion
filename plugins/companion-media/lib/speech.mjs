import fs from 'node:fs';
import path from 'node:path';
import { Code, mediaError, toFailure, unreachableBackend } from './errors.mjs';
import { sha256Hex } from './ids.mjs';
import { writeManaged } from './media.mjs';
import { managedPath } from './paths.mjs';
import { planDelivery } from './delivery.mjs';
import { assertCoordinator } from './vision.mjs';
import { directSpeech } from './director.mjs';
import { runProcess } from './exec.mjs';

// Breeze TTS 2 client.
//
// The old provider's important lessons are encoded here:
//  * the backend ignores `speed`, so tempo changes happen once, in FFmpeg, and
//    only when speed !== 1 (never double-applied);
//  * the backend streams a WAV with placeholder chunk lengths, so the container
//    is parsed and rewritten instead of trusting the header;
//  * the backend needs the 8139 coordinator to own the GPU, so the base URL is
//    the coordinator path, never port 8137 directly.

const ALIASES = { 自然: '自然', neutral: '自然', normal: '自然', 开心: '开心', 高兴: '开心', happy: '开心', joyful: '开心', 委屈: '委屈', 难过: '委屈', sad: '委屈', 伤心: '委屈', 生气: '生气', 愤怒: '生气', angry: '生气' };

const NATURAL = '保持参考说话人的音色。自然亲切地说话，语速适中，吐字清楚，句末自然收住，不额外叹气或呼气。';

/** Parse a RIFF/WAVE buffer and tolerate placeholder chunk sizes. */
export function parseWav(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  if (buf.length < 44) throw mediaError(Code.WAV_INVALID, 'wav payload is too short');
  if (buf.subarray(0, 4).toString('latin1') !== 'RIFF' || buf.subarray(8, 12).toString('latin1') !== 'WAVE') {
    throw mediaError(Code.WAV_INVALID, 'not a RIFF/WAVE payload');
  }
  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let declaredDataSize = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.subarray(offset, offset + 4).toString('latin1');
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (body + 16 > buf.length) throw mediaError(Code.WAV_INVALID, 'truncated fmt chunk');
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        blockAlign: buf.readUInt16LE(body + 12),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOffset = body;
      declaredDataSize = size;
      break;
    }
    if (size === 0) break;
    offset = body + size + (size % 2);
  }
  if (!fmt) throw mediaError(Code.WAV_INVALID, 'missing fmt chunk');
  if (dataOffset < 0) throw mediaError(Code.WAV_INVALID, 'missing data chunk');
  const available = buf.length - dataOffset;
  const usable = declaredDataSize > 0 && declaredDataSize <= available ? declaredDataSize : available;
  const blockAlign = fmt.blockAlign || fmt.channels * (fmt.bitsPerSample / 8);
  const trimmed = usable - (blockAlign ? usable % blockAlign : 0);
  const pcm = buf.subarray(dataOffset, dataOffset + trimmed);
  if (!pcm.length) throw mediaError(Code.WAV_INVALID, 'empty pcm payload');
  return {
    format: fmt.format,
    channels: fmt.channels,
    width: fmt.bitsPerSample / 8,
    bitsPerSample: fmt.bitsPerSample,
    rate: fmt.rate,
    pcm,
    durationSeconds: pcm.length / (fmt.rate * blockAlign),
  };
}

/** Rebuild a canonical 44-byte-header WAV from raw PCM. */
export function buildWav({ pcm, channels = 1, rate = 44100, bitsPerSample = 16 }) {
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Strip recognised emotion tags and return the effective emotion. */
export function consumeEmotionTags(text, initialEmotion = '自然') {
  let emotion = ALIASES[String(initialEmotion).toLowerCase()] ?? '自然';
  const spoken = String(text ?? '').replace(/[\[【]([^\]】\n]{1,24})[\]】]/g, (match, label) => {
    const mapped = ALIASES[String(label).trim().toLowerCase()];
    if (!mapped) return match;
    emotion = mapped;
    return '';
  }).trim();
  return { text: spoken, emotion };
}

export function loadPresets(config) {
  const presets = { ...(config.speech.emotionPresets ?? {}) };
  const file = config.speech.presetsFile;
  if (file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      for (const [key, value] of Object.entries(parsed?.presets ?? {})) {
        if (typeof value === 'string' && !presets[key]) presets[key] = value;
      }
    } catch { /* a missing presets file falls back to the configured defaults */ }
  }
  return presets;
}

export function resolveInstruction({ emotion, instructions, presets, config }) {
  if (instructions && String(instructions).trim()) return String(instructions).trim();
  return presets?.[emotion] ?? config.speech.defaultInstructions ?? NATURAL;
}

export function buildSpeechPayload({ text, voice, cfgScale, seed, instructions, maxNewTokens, model }) {
  return {
    model,
    voice,
    input: text,
    instructions,
    response_format: 'wav',
    cfg_scale: cfgScale,
    seed,
    max_new_tokens: maxNewTokens,
  };
}

/** A probability that cannot be read is a probability of zero: never speak on garbage. */
export function clampAutoProbability(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  if (number <= 0) return 0;
  if (number >= 100) return 100;
  return number;
}

/** A missing or nonsense interval means "no extra gate"; probability still applies. */
export function normalizeAutoMinInterval(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number;
}

/**
 * Decide whether this reply should become speech.
 * One decision per reply, never per segment. The 180s interval is a hard gate
 * measured from the last *attempt* (a failed synthesis also holds the clock, so
 * a dead backend cannot be turned into a request storm); probability is
 * evaluated only when the interval allows it.
 *
 * Boundaries are explicit: probability 0 never speaks, 100 always speaks, and
 * an unusable probability or rng fails closed instead of falling through to
 * `roll < NaN`.
 */
export function decideAutoVoice({ enabled, probability, minIntervalSeconds, lastTriggeredAt, now = Date.now(), random = Math.random, text = '', maxChars = 0 }) {
  if (enabled !== true) return { speak: false, reason: 'auto voice disabled' };
  const limit = clampAutoProbability(probability);
  if (limit <= 0) return { speak: false, reason: 'probability is 0 or unreadable; auto voice never fires' };
  const chars = Number(maxChars);
  if (Number.isFinite(chars) && chars > 0 && [...String(text ?? '')].length > chars) return { speak: false, reason: 'text longer than the auto-voice limit' };
  const interval = normalizeAutoMinInterval(minIntervalSeconds);
  if (lastTriggeredAt && interval > 0) {
    const previous = new Date(lastTriggeredAt).getTime();
    // A corrupted clock must not become an unlimited licence to speak: treat it
    // as "just spoke", which self-heals after one interval.
    const elapsed = Number.isFinite(previous) ? (now - previous) / 1000 : 0;
    if (elapsed < interval) return { speak: false, reason: `global interval ${Math.round(elapsed)}s < ${interval}s` };
  }
  let roll;
  try {
    roll = Number(random()) * 100;
  } catch {
    // An rng that throws must not fall through to "speak".
    roll = NaN;
  }
  const value = Number.isFinite(roll) ? roll : 100;
  if (!(value < limit)) return { speak: false, reason: `probability miss (${value.toFixed(1)} >= ${limit})` };
  return { speak: true, reason: `probability hit (${value.toFixed(1)} < ${limit})` };
}

export function createSpeechService({
  config,
  ledger,
  log = () => {},
  fetchImpl = globalThis.fetch,
  run = runProcess,
  host = null,
  root,
  now = () => new Date().toISOString(),
} = {}) {
  const presets = loadPresets(config);

  async function atempo({ pcm, channels, rate, speed }) {
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(rate), '-ac', String(channels), '-i', 'pipe:0', '-af', `atempo=${speed}`, '-f', 's16le', 'pipe:1'];
    const result = await run(config.speech.ffmpegPath || 'ffmpeg', args, { input: pcm, timeoutMs: config.speech.atempoTimeoutMs ?? 60_000 });
    if (result.code !== 0 || !result.stdout?.length) {
      throw mediaError(Code.TEMPO_FAILED, `ffmpeg atempo failed: ${String(result.stderr ?? '').slice(0, 200)}`);
    }
    const blockAlign = channels * 2;
    const usable = result.stdout.length - (result.stdout.length % blockAlign);
    return result.stdout.subarray(0, usable);
  }

  // One synthesis per idempotency key at a time. Review round 1 found that a
  // concurrent duplicate and a retry after failure both re-ran the backend; the
  // in-flight map and the stored job now make the key authoritative.
  const inFlight = new Map();

  async function synthesize({ text, emotion = '自然', instructions = '', sessionId, idempotencyKey, context = '', signal, useDirector = true } = {}) {
    if (!config.speech.enabled) return { ok: false, error: { code: Code.DISABLED, message: 'speech is disabled' } };
    const consumed = consumeEmotionTags(text, emotion);
    if (!consumed.text) return { ok: false, error: { code: Code.NO_TEXT, message: 'speech text is empty after removing emotion tags' } };
    const key = idempotencyKey ?? `speech:${sha256Hex(Buffer.from(`${consumed.text}|${consumed.emotion}`))}`;

    if (inFlight.has(key)) {
      const shared = await inFlight.get(key);
      return { ...shared, concurrent: true };
    }

    const existing = ledger.findJobByIdempotencyKey(key);
    if (existing?.state === 'succeeded' && existing.artifactId) {
      const artifact = ledger.getArtifact(existing.artifactId);
      if (artifact) return { ok: true, artifact, replay: true, director: existing.directorUsed ? 'replayed' : 'none' };
    }
    if (existing?.state === 'running') {
      return {
        ok: false,
        error: { code: Code.UNKNOWN_RESULT, message: 'an earlier synthesis with this key is still running or was interrupted; it will not be replayed automatically' },
        jobId: existing.jobId,
      };
    }

    let jobId;
    if (existing) {
      jobId = existing.jobId;
      ledger.updateJob(jobId, { state: 'running', attempts: (existing.attempts ?? 1) + 1, error: undefined });
    } else {
      const proposed = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const created = ledger.createJob({
        jobId: proposed, requestId: proposed, idempotencyKey: key, capability: 'speech', sessionId,
        state: 'running', createdAt: now(), attempts: 1,
        paramsDigest: sha256Hex(Buffer.from(JSON.stringify({ voice: config.speech.backend.voice, cfg: config.speech.backend.cfgScale, speed: config.speech.backend.speed, seed: config.speech.backend.seed }))),
      });
      jobId = created.job.jobId;
      if (!created.created) {
        return {
          ok: false,
          error: { code: Code.UNKNOWN_RESULT, message: `an earlier synthesis with this key is ${created.job.state}; it will not be replayed automatically` },
          jobId,
        };
      }
    }

    const pending = runSynthesis({ jobId, consumed, instructions, sessionId, context, signal, useDirector });
    inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      inFlight.delete(key);
    }
  }

  async function runSynthesis({ jobId, consumed, instructions, sessionId, context, signal, useDirector }) {
    // The Breeze backend is only reachable through the coordinator; a direct
    // 8137 call would bypass the GPU mutex.
    assertCoordinator(config.speech.backend.baseUrl, { expectedPort: 8139, pathPrefix: '/breeze' });
    let directed = null;
    if (useDirector && config.speech.director.enabled) {
      directed = await directSpeech({
        host,
        text: consumed.text,
        context: typeof context === 'string' ? context : '',
        sessionId,
        config,
        signal,
        log,
      });
    }
    ledger.updateJob(jobId, { directorUsed: Boolean(directed?.used) });
    const spokenInput = directSpeechInput(directed, consumed.text);
    const instruction = directed?.used ? directed.instructions : resolveInstruction({ emotion: consumed.emotion, instructions, presets, config });
    const startedAt = Date.now();
    try {
      const payload = buildSpeechPayload({
        text: spokenInput,
        voice: config.speech.backend.voice,
        cfgScale: config.speech.backend.cfgScale,
        seed: config.speech.backend.seed,
        instructions: instruction,
        maxNewTokens: config.speech.backend.maxNewTokens,
        model: config.speech.backend.model,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('speech request timed out')), config.speech.backend.timeoutMs);
      const composed = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let audio;
      try {
        const response = await fetchImpl(`${config.speech.backend.baseUrl.replace(/\/$/, '')}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: composed,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw mediaError(Code.BACKEND_FAILED, `breeze HTTP ${response.status}: ${detail.slice(0, 200)}`);
        }
        audio = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        throw unreachableBackend(error, { what: 'Breeze TTS', baseUrl: config.speech.backend.baseUrl }) ?? error;
      } finally {
        clearTimeout(timer);
      }
      const parsed = parseWav(audio);
      if (parsed.bitsPerSample !== 16) throw mediaError(Code.WAV_INVALID, `expected 16-bit PCM, got ${parsed.bitsPerSample}-bit`);
      let pcm = parsed.pcm;
      let tempoApplied = false;
      const speed = Number(config.speech.backend.speed);
      if (Number.isFinite(speed) && speed !== 1) {
        pcm = await atempo({ pcm, channels: parsed.channels, rate: parsed.rate, speed });
        tempoApplied = true;
      }
      const wav = buildWav({ pcm, channels: parsed.channels, rate: parsed.rate, bitsPerSample: 16 });
      const digest = sha256Hex(wav);
      const filename = `speech-${digest.slice(0, 16)}.wav`;
      const relative = writeManaged(root, 'home/media/artifacts/speech', wav, filename);
      const artifact = {
        artifactId: `art_${digest.slice(0, 24)}`,
        kind: 'audio',
        path: relative,
        mime: 'audio/wav',
        bytes: wav.length,
        sha256: digest,
        durationSeconds: Number((pcm.length / (parsed.rate * parsed.channels * 2)).toFixed(3)),
        sampleRate: parsed.rate,
        channels: parsed.channels,
        origin: 'tts',
        jobId,
        createdAt: now(),
        meta: { voice: payload.voice, cfgScale: payload.cfg_scale, seed: payload.seed, speed, tempoApplied, emotion: consumed.emotion, directed: Boolean(directed?.used), instructionChars: instruction.length },
      };
      ledger.putArtifact(artifact);
      ledger.updateJob(jobId, { state: 'succeeded', artifactId: artifact.artifactId, finishedAt: now(), elapsedMs: Date.now() - startedAt });
      log({ event: 'speech.ok', jobId, duration: artifact.durationSeconds, tempoApplied, directed: Boolean(directed?.used) });
      return { ok: true, artifact, jobId, director: directed?.used ? 'applied' : (directed?.reason ?? 'disabled'), tempoApplied };
    } catch (error) {
      const failure = toFailure(error);
      ledger.updateJob(jobId, { state: 'failed', error: failure, finishedAt: now() });
      log({ event: 'speech.failed', jobId, code: failure.code });
      return { ok: false, error: failure, jobId };
    }
  }

  return { synthesize, presets, decideAutoVoice: options => decideAutoVoice(options) };
}

function directSpeechInput(directed, original) {
  if (directed?.used && directed.input) return directed.input;
  return original;
}

/** Where a generated WAV lives on disk for playback or channel encoding. */
export function artifactAbsolutePath(root, artifact) {
  return path.resolve(root, artifact.path);
}

// ---------------------------------------------------------------------------
// Auto voice: "should she say this line out loud, unprompted?"
//
// `decideAutoVoice` above is only the coin flip. Everything that makes the flip
// safe to run in a live companion was missing, and is what this section adds:
//
//  * a persisted trigger clock, so the interval survives a restart (it lives in
//    `home/media/state/auto-voice.json`, next to the ledger, not in memory);
//  * a reservation written *before* synthesis, so two turns — in this process or
//    in two processes sharing the same state file — cannot both start talking;
//  * `deliveryMode` translated into `planDelivery`'s `voiceOnly`, so
//    `voice_only` really means "no second copy of the same words";
//  * a fail-closed result when synthesis breaks: nothing was spoken, so nothing
//    may be presented as spoken, and no text is emitted in the voice's place.
//
// The rule the whole section obeys: what she says and what is played must be the
// same line, and "the tool returned" is never "she was heard".
// ---------------------------------------------------------------------------

export const AUTO_VOICE_SCHEMA_VERSION = 1;

/** Relative to the media root, i.e. `<root>/home/media/state/auto-voice.json`. */
export const AUTO_VOICE_STATE_RELATIVE = 'state/auto-voice.json';

function emptyAutoVoiceState() {
  return {
    schemaVersion: AUTO_VOICE_SCHEMA_VERSION,
    lastAttemptAt: null,
    lastSpokenAt: null,
    lastFailureAt: null,
    lastDecision: null,
    lastReason: null,
    lastError: null,
    lastArtifactId: null,
    consecutiveFailures: 0,
    counters: { attempts: 0, spoken: 0, failed: 0 },
  };
}

/** Absolute path of the persisted trigger clock. */
export function autoVoiceStatePath(root) {
  return managedPath(root, AUTO_VOICE_STATE_RELATIVE);
}

/**
 * Read the trigger clock. A missing file is a fresh start; an unreadable one is
 * a fresh start plus `readable:false`, which the caller reports rather than hides.
 */
export function readAutoVoiceState(file) {
  const empty = emptyAutoVoiceState();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!raw || typeof raw !== 'object') return { state: empty, readable: false, exists: true, recovered: false };
    return {
      state: {
        ...empty,
        ...raw,
        schemaVersion: AUTO_VOICE_SCHEMA_VERSION,
        consecutiveFailures: Number(raw.consecutiveFailures) || 0,
        counters: { ...empty.counters, ...(raw.counters && typeof raw.counters === 'object' ? raw.counters : {}) },
      },
      readable: true,
      exists: true,
      recovered: false,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: empty, readable: true, exists: false, recovered: false };
    // A damaged file must not become a licence to speak on every turn: fall back
    // to the file's own mtime as the last attempt. It is conservative (mtime is
    // never older than the write) and it heals as soon as a real write lands.
    let lastAttemptAt = null;
    try {
      lastAttemptAt = fs.statSync(file).mtime.toISOString();
    } catch { /* unreadable and unstattable: nothing to anchor on */ }
    return { state: { ...empty, lastAttemptAt, lastDecision: 'state-unreadable' }, readable: false, exists: true, recovered: Boolean(lastAttemptAt) };
  }
}

/** Atomic write (tmp + rename), the same discipline the ledger uses. */
export function writeAutoVoiceState(file, state) {
  const next = { ...emptyAutoVoiceState(), ...state, schemaVersion: AUTO_VOICE_SCHEMA_VERSION };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return next;
}

/**
 * `voice_only` never repeats the line as text; anything unrecognised (including
 * a missing value) also resolves to `voice_only`, because doubling a line is the
 * failure mode that annoys a listener, while speaking alone is merely quiet.
 */
export function resolveAutoDeliveryMode(mode) {
  const value = String(mode ?? '').trim().toLowerCase();
  if (value === 'voice_and_text' || value === 'voice+text' || value === 'both' || value === 'text_and_voice') return 'voice_and_text';
  return 'voice_only';
}

/**
 * Build the delivery plan for one auto-voice line.
 *
 * With an artifact: `voice_only` yields a plan whose only step is the voice.
 * Without one: an empty, explicitly degraded plan. That second branch is the
 * red line — `planDelivery` alone would happily turn `{text, voice:null,
 * voiceOnly:true}` into a text step (because `voiceOnly && voice` is false), and
 * a caller could then present typed words as the thing she said.
 */
export function buildAutoPlan({ sessionId, text = '', artifact = null, deliveryMode = 'voice_only', channel = 'desktop', target = '', order, transportMode } = {}) {
  const mode = resolveAutoDeliveryMode(deliveryMode);
  const voiceOnly = mode === 'voice_only';
  if (!artifact) {
    return {
      planId: null,
      sessionId,
      channel,
      target,
      mode: transportMode ?? 'mock',
      voiceOnly,
      steps: [],
      degraded: true,
      textSuppressed: true,
      reason: 'no audio artifact: this line was never spoken',
      instruct: '这句没有被念出来：按普通文字回复她本来的话，不要声称已经发过语音，也不要重试同一句。',
    };
  }
  const plan = planDelivery({ sessionId, channel, target, text, voice: artifact, mode: transportMode ?? 'mock', voiceOnly, order });
  return {
    ...plan,
    degraded: false,
    textSuppressed: voiceOnly,
    // What was spoken and what the plan says are provably the same line.
    spokenText: text,
  };
}

/**
 * The auto-voice engine: decide, reserve, synthesize, persist, plan.
 *
 * Everything is injected (`now`, `random`, `speech`, `stateFile`) so the tests
 * can drive the clock and the coin without touching a backend or the wall clock.
 */
export function createAutoVoiceService({
  config,
  speech,
  root,
  log = () => {},
  now = () => Date.now(),
  random = Math.random,
  stateFile = null,
} = {}) {
  if (!root) throw mediaError(Code.BAD_INPUT, 'auto voice needs a media root for its state file');
  if (!speech || typeof speech.synthesize !== 'function') throw mediaError(Code.BAD_INPUT, 'auto voice needs the speech service');
  const file = stateFile ?? autoVoiceStatePath(root);
  const currentConfig = () => (typeof config === 'function' ? config() : config);

  /** The four numbers this layer actually reads, normalised and honest. */
  function settings() {
    const auto = currentConfig()?.speech?.auto ?? {};
    const maxChars = Number(auto.maxChars);
    return {
      enabled: auto.enabled === true,
      probability: clampAutoProbability(auto.probability),
      minIntervalSeconds: normalizeAutoMinInterval(auto.minIntervalSeconds),
      deliveryMode: resolveAutoDeliveryMode(auto.deliveryMode),
      maxChars: Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 0,
    };
  }

  /** The configured transport, so the plan never claims a mode the deployment is not in. */
  function transportMode() {
    return currentConfig()?.delivery?.mode ?? 'mock';
  }

  // One decision at a time per process: the interval is a read-modify-write on a
  // file, and two interleaved turns would both read "long enough ago".
  let queue = Promise.resolve();

  function decideNow({ text, emotion } = {}) {
    const auto = settings();
    const spoken = consumeEmotionTags(text ?? '', emotion).text;
    const { state } = readAutoVoiceState(file);
    const decision = decideAutoVoice({
      enabled: auto.enabled,
      probability: auto.probability,
      minIntervalSeconds: auto.minIntervalSeconds,
      // The clock is measured from the last attempt, not the last success: a
      // failing backend must not be retried every turn.
      lastTriggeredAt: state.lastAttemptAt,
      now: now(),
      random,
      text: spoken,
      maxChars: auto.maxChars,
    });
    if (decision.speak && !spoken.trim()) return { speak: false, reason: 'nothing to speak (empty line)', auto, spoken, state };
    return { ...decision, auto, spoken, state };
  }

  async function run({ text, sessionId, context, emotion, instructions, useDirector, signal }) {
    const evaluated = decideNow({ text, emotion });
    const auto = evaluated.auto;
    const decision = { speak: evaluated.speak, reason: evaluated.reason };
    if (!evaluated.speak) {
      log({ event: 'auto.voice.skipped', reason: evaluated.reason });
      return { ok: true, spoke: false, decision, auto, textSuppressed: false };
    }

    // Reserve first: whoever reads this file next (another turn, another process)
    // now sees an attempt that just happened and stays quiet.
    const at = new Date(now()).toISOString();
    let state = writeAutoVoiceState(file, {
      ...evaluated.state,
      lastAttemptAt: at,
      lastDecision: 'attempting',
      lastReason: evaluated.reason,
      counters: { ...evaluated.state.counters, attempts: evaluated.state.counters.attempts + 1 },
    });

    let result;
    try {
      result = await speech.synthesize({
        text: evaluated.spoken,
        emotion,
        instructions,
        context,
        sessionId,
        signal,
        useDirector,
      });
    } catch (error) {
      result = { ok: false, error: toFailure(error) };
    }
    const finishedAt = new Date(now()).toISOString();

    if (!result?.ok || !result.artifact) {
      const failure = result?.error ?? { code: Code.BACKEND_FAILED, message: 'synthesis returned no artifact' };
      state = writeAutoVoiceState(file, {
        ...state,
        lastFailureAt: finishedAt,
        lastDecision: 'failed',
        lastReason: failure.code,
        consecutiveFailures: state.consecutiveFailures + 1,
        lastError: { code: failure.code, message: String(failure.message ?? '').slice(0, 200) },
        counters: { ...state.counters, failed: state.counters.failed + 1 },
      });
      log({ event: 'auto.voice.failed', code: failure.code });
      return {
        ok: false,
        spoke: false,
        decision,
        auto,
        failure,
        // Fail closed. No artifact means no voice: nothing is delivered in its
        // place, and the caller is told the line is still unsaid.
        delivery: { mode: auto.deliveryMode, voiceOnly: false, textSuppressed: true, spoken: false, degraded: true },
        plan: buildAutoPlan({ sessionId, text: evaluated.spoken, artifact: null, deliveryMode: auto.deliveryMode, transportMode: transportMode() }),
        instruct: '语音合成失败：这句没有被念出来。按普通文字回复她本来的话，不要声称已发过语音，也不要换一种说法冒充这句。',
      };
    }

    state = writeAutoVoiceState(file, {
      ...state,
      lastSpokenAt: finishedAt,
      lastDecision: 'spoken',
      lastReason: evaluated.reason,
      consecutiveFailures: 0,
      lastError: null,
      lastArtifactId: result.artifact.artifactId,
      counters: { ...state.counters, spoken: state.counters.spoken + 1 },
    });
    log({ event: 'auto.voice.spoken', artifactId: result.artifact.artifactId, mode: auto.deliveryMode });

    const plan = buildAutoPlan({
      sessionId,
      text: evaluated.spoken,
      artifact: result.artifact,
      deliveryMode: auto.deliveryMode,
      transportMode: transportMode(),
    });
    return {
      ok: true,
      spoke: true,
      decision,
      auto,
      artifact: result.artifact,
      jobId: result.jobId,
      director: result.director,
      tempoApplied: result.tempoApplied,
      plan,
      spokenText: evaluated.spoken,
      // Producing the WAV is not delivering it; the channel tool still has to
      // send the file and report a receipt.
      delivered: false,
      delivery: {
        mode: auto.deliveryMode,
        voiceOnly: plan.voiceOnly,
        textSuppressed: plan.textSuppressed,
        spoken: false,
        degraded: false,
      },
      instruct: 'voice-only: 只发这条语音，不要再发一遍同样的文字；发送后按通道回执记录，不要假设对方已听到。',
    };
  }

  return {
    stateFile: file,
    settings,
    status() {
      const auto = settings();
      const { state, readable, exists } = readAutoVoiceState(file);
      const previous = state.lastAttemptAt ? new Date(state.lastAttemptAt).getTime() : NaN;
      const nextEligibleAt = Number.isFinite(previous) && auto.minIntervalSeconds > 0
        ? new Date(previous + auto.minIntervalSeconds * 1000).toISOString()
        : null;
      return {
        enabled: auto.enabled,
        probability: auto.probability,
        minIntervalSeconds: auto.minIntervalSeconds,
        deliveryMode: auto.deliveryMode,
        maxChars: auto.maxChars,
        stateFile: file,
        stateExists: exists,
        stateReadable: readable,
        lastAttemptAt: state.lastAttemptAt,
        lastSpokenAt: state.lastSpokenAt,
        lastFailureAt: state.lastFailureAt,
        lastDecision: state.lastDecision,
        lastReason: state.lastReason,
        lastError: state.lastError,
        lastArtifactId: state.lastArtifactId,
        consecutiveFailures: state.consecutiveFailures,
        counters: state.counters,
        nextEligibleAt,
        // Same honesty rule as `status().capabilities.speech`: this layer decides
        // and synthesizes; hearing it is the channel's job.
        deliversToChannel: false,
      };
    },
    decide: options => decideNow(options),
    maybeSpeak(options = {}) {
      const task = queue.then(() => run(options));
      queue = task.then(() => {}, () => {});
      return task;
    },
  };
}

