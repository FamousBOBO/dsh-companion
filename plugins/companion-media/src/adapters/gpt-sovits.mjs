import { Code, mediaError } from '../errors.mjs';
import { assertSize, extensionFor, sniffAudio } from '../media-format.mjs';
import { TTS_PROVIDERS } from '../schema.mjs';
import { authHeaders, probeReachability, remoteFailure } from './shared.mjs';

/**
 * GPT-SoVITS — official `api_v2.py`.
 *
 * Verified 2026-11-05 (§3.2 of the M0 report):
 *   POST {baseUrl}/tts   JSON
 *   {text, text_lang, ref_audio_path, prompt_text, prompt_lang, media_type, ...}
 *   → audio/<media_type> stream (200) or {message} JSON (400)
 *
 * The important asymmetry: `ref_audio_path` is a path **on the TTS server**, not
 * a local file. This adapter therefore never uploads anything and never reads a
 * local file — the operator configures a path that exists where the service runs.
 */

export const record = TTS_PROVIDERS['gpt-sovits'];

const ALLOWED_MEDIA = new Set(['wav', 'ogg', 'aac']);

export async function generate({ section, limits, key, net, text, signal }) {
  const content = String(text ?? '').trim();
  if (!content) throw mediaError(Code.NO_TEXT, 'text 不能为空');
  if (content.length > limits.maxTextChars) {
    throw mediaError(Code.PARAM_OUT_OF_RANGE, `text 有 ${content.length} 字符，上限 ${limits.maxTextChars}`);
  }
  const mediaType = String(section.mediaType ?? 'wav').toLowerCase();
  if (!ALLOWED_MEDIA.has(mediaType)) {
    throw mediaError(
      Code.PARAM_OUT_OF_RANGE,
      `media_type=${mediaType} 不受支持：raw 没有可靠的采样率信息，无法封装成可发送的音频；请用 wav`,
    );
  }

  const body = {
    text: content,
    text_lang: section.textLang || 'zh',
    ref_audio_path: String(section.refAudioPath ?? '').trim(),
    prompt_text: String(section.promptText ?? '').trim(),
    prompt_lang: section.promptLang || 'zh',
    media_type: mediaType,
    streaming_mode: false,
    speed_factor: section.speedFactor ?? 1,
    top_k: section.topK ?? 15,
    top_p: section.topP ?? 1,
    temperature: section.temperature ?? 1,
    seed: section.seed ?? -1,
  };
  if (!body.ref_audio_path) throw mediaError(Code.NOT_CONFIGURED, '未填写参考音频路径（服务端路径）');

  const response = await net.request(`${String(section.baseUrl).replace(/\/+$/, '')}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(key) },
    body: JSON.stringify(body),
    timeoutMs: section.timeoutMs,
    maxBytes: limits.maxAudioBytes,
    provider: record.label,
    signal,
  });
  if (!response.ok) {
    // A 400 here is usually the service quoting a bad reference path; keep the
    // redacted upstream text so the operator can act on it.
    throw remoteFailure(response, { provider: record.label, what: 'GPT-SoVITS 合成失败' });
  }
  assertSize(response.bytes, limits.maxAudioBytes, { what: '语音产物' });
  const sniffed = sniffAudio(response.bytes);
  if (!sniffed) {
    throw mediaError(
      Code.UNSUPPORTED_TYPE,
      `GPT-SoVITS 返回的字节不是可识别音频（Content-Type: ${response.mime || '空'}）；确认 media_type 与模型匹配`,
    );
  }
  return {
    bytes: response.bytes,
    mime: sniffed.mime,
    extension: extensionFor(sniffed.mime, mediaType),
    format: sniffed.format,
    durationSeconds: sniffed.durationSeconds ?? null,
    meta: { model: section.model || 'gpt-sovits', reference: body.ref_audio_path, mediaType },
  };
}

/**
 * Connection test.
 *
 * `api_v2.py` has no health endpoint and `/control?command=exit` would STOP the
 * service, so the only safe probe is reachability of the root path. Reported as
 * such: it proves the port answers, not that the models are loaded.
 */
export async function test({ section, key, net, limits }) {
  if (!String(section.baseUrl ?? '').trim()) return { ok: false, code: Code.NOT_CONFIGURED, detail: '服务地址未填写' };
  const probe = await probeReachability({
    net,
    url: String(section.baseUrl).replace(/\/+$/, '') + '/',
    headers: authHeaders(key),
    timeoutMs: Math.min(section.timeoutMs ?? limits.connectTimeoutMs, limits.connectTimeoutMs),
    provider: record.label,
  });
  return { ...probe, note: 'GPT-SoVITS 没有 /health，且 /control 会改服务状态，因此只探测端口；模型是否加载需操作者自行确认' };
}

export default { record, id: record.id, kind: 'tts', generate, test, probeReachability };
