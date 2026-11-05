import { Code, mediaError } from '../errors.mjs';
import { assertSize, extensionFor, sniffAudio } from '../media-format.mjs';
import { TTS_PROVIDERS } from '../schema.mjs';
import { authHeaders, probeReachability, remoteFailure } from './shared.mjs';

/**
 * Fish Audio protocol — shared by two adapters.
 *
 * Verified 2026-11-05 against the official API reference (§3.3/§3.4 of the M0
 * report):
 *   POST {baseUrl}/v1/tts
 *   headers: Authorization: Bearer <token>, model: <s1|s2-pro|s2.1-pro|s2.1-pro-free|drama-3>
 *   {text, reference_id, format, latency, temperature, top_p, ...}
 *   → audio bytes (format=wav/pcm/mp3/opus); errors are JSON {status,message,reason}
 *
 * Drama3 is NOT a separate protocol: it is Fish Audio's `drama-3` model, which
 * also accepts a reference_id ARRAY plus `<|speaker:0|>` tags for dialogue. The
 * two adapters therefore differ only in their pinned model and their declared
 * fields — which is why the request builder is shared and the *validation* is not.
 */

const PROTOCOL = {
  audioFormats: new Set(['wav', 'pcm', 'mp3', 'opus']),
};

function referenceIds(value, { multi = false } = {}) {
  const text = String(value ?? '').trim();
  if (!text) return multi ? [] : '';
  if (!multi) return text;
  return text.split(',').map(part => part.trim()).filter(Boolean);
}

function buildBody(section, { text, multiSpeaker }) {
  const format = PROTOCOL.audioFormats.has(section.format) ? section.format : 'wav';
  const body = {
    text,
    format,
    latency: section.latency || 'normal',
    temperature: section.temperature ?? 0.7,
    top_p: section.topP ?? 0.7,
    normalize: true,
  };
  const ids = referenceIds(section.referenceId, { multi: multiSpeaker });
  if (Array.isArray(ids)) body.reference_id = ids;
  else if (ids) body.reference_id = ids;
  return body;
}

async function synthesize({ record, section, limits, key, net, text, signal, multiSpeaker = false }) {
  const content = String(text ?? '').trim();
  if (!content) throw mediaError(Code.NO_TEXT, 'text 不能为空');
  if (content.length > limits.maxTextChars) {
    throw mediaError(Code.PARAM_OUT_OF_RANGE, `text 有 ${content.length} 字符，上限 ${limits.maxTextChars}`);
  }
  const body = buildBody(section, { text: content, multiSpeaker });
  const model = String(section.model ?? '').trim();

  const response = await net.request(`${String(section.baseUrl).replace(/\/+$/, '')}/v1/tts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(model ? { model } : {}),
      ...authHeaders(key),
    },
    body: JSON.stringify(body),
    timeoutMs: section.timeoutMs,
    maxBytes: limits.maxAudioBytes,
    provider: record.label,
    signal,
  });
  if (!response.ok) throw remoteFailure(response, { provider: record.label, what: `${record.label} 合成失败` });
  assertSize(response.bytes, limits.maxAudioBytes, { what: '语音产物' });

  const declared = String(response.mime || '').toLowerCase();
  if (declared.includes('json')) {
    throw mediaError(Code.UPSTREAM, `${record.label} 返回了 JSON 而不是音频（多半是错误信封）：${response.bytes.toString('utf8').slice(0, 160)}`);
  }

  if (declared.includes('audio/pcm') || body.format === 'pcm') {
    // The API documents pcm as 16-bit mono but the exact rate is supplied per
    // format; without it we refuse rather than guess a pitch-shifted file.
    throw mediaError(
      Code.UNSUPPORTED_TYPE,
      'format=pcm 需要采样率才能封装成 WAV，而 Fish Audio 的响应头不一定给；请用 format=wav',
    );
  }

  const sniffed = sniffAudio(response.bytes);
  if (!sniffed) throw mediaError(Code.UNSUPPORTED_TYPE, `${record.label} 返回的字节不是可识别音频（Content-Type: ${declared || '空'}）`);
  return {
    bytes: response.bytes,
    mime: sniffed.mime,
    extension: extensionFor(sniffed.mime, body.format),
    format: sniffed.format,
    durationSeconds: sniffed.durationSeconds ?? null,
    meta: {
      model: model || body.model || record.id,
      referenceId: body.reference_id ?? '',
      format: body.format,
      multiSpeaker,
    },
  };
}

/**
 * Connection test: `GET /model` is the documented model listing and is free; we
 * only care that it answers (and with which status), never that it returns data.
 */
async function probe({ record, section, key, net, limits }) {
  if (!String(section.baseUrl ?? '').trim()) return { ok: false, code: Code.NOT_CONFIGURED, detail: '服务地址未填写' };
  if (!String(key ?? '').trim()) return { ok: false, code: Code.NOT_CONFIGURED, detail: 'API Key 未配置' };
  try {
    const response = await net.request(`${String(section.baseUrl).replace(/\/+$/, '')}/model`, {
      headers: authHeaders(key),
      timeoutMs: Math.min(section.timeoutMs ?? limits.connectTimeoutMs, limits.connectTimeoutMs),
      maxBytes: 128 * 1024,
      provider: record.label,
    });
    if (response.ok) return { ok: true, level: 'metadata', detail: 'GET /model 成功：凭据有效；未合成任何语音' };
    if (response.status === 401 || response.status === 402) {
      const failure = remoteFailure(response, { provider: record.label, what: '鉴权检查' });
      return { ok: false, code: failure.code, detail: failure.message, status: response.status };
    }
    if (response.status === 404) {
      return { ok: true, level: 'reachability', detail: '端点可达但没有 /model；未合成语音', status: 404 };
    }
    const failure = remoteFailure(response, { provider: record.label, what: '连接测试' });
    return { ok: false, code: failure.code, detail: failure.message, status: response.status };
  } catch (error) {
    // Some gateways reject unauthenticated GETs on that path; fall back to a
    // plain reachability answer instead of claiming the key is wrong.
    const fallback = await probeReachability({
      net,
      url: String(section.baseUrl).replace(/\/+$/, '') + '/',
      headers: authHeaders(key),
      timeoutMs: Math.min(section.timeoutMs ?? limits.connectTimeoutMs, limits.connectTimeoutMs),
      provider: record.label,
    });
    return { ...fallback, note: `${error?.message ?? error}；已退化为可达性探测` };
  }
}

export function createFishAdapter(id, { multiSpeaker = false } = {}) {
  const record = TTS_PROVIDERS[id];
  return {
    id,
    kind: 'tts',
    record,
    async generate({ section, limits, key, net, text, signal }) {
      return synthesize({ record, section, limits, key, net, text, signal, multiSpeaker });
    },
    async test({ section, key, net, limits }) {
      return probe({ record, section, key, net, limits });
    },
  };
}

export const fishAudio = createFishAdapter('fish-audio');
export const drama3 = createFishAdapter('drama3', { multiSpeaker: true });
export default { fishAudio, drama3 };
