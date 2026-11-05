import { Code, mediaError } from '../errors.mjs';
import { assertSize, extensionFor, sniffImage } from '../media-format.mjs';
import { IMAGE_PROVIDERS } from '../schema.mjs';
import { authHeaders, ensureOk, joinUrl, parseJsonBody, probeReachability, remoteFailure } from './shared.mjs';

/**
 * OpenAI-compatible image generation.
 *
 * Protocol (verified 2026-11-05 against the official OpenAPI document, see
 * docs/media/M0-report.md §2.1):
 *   POST {baseUrl}/images/generations
 *   {model, prompt, n, size, quality?, background?, output_format?}
 *   → {data:[{b64_json?|url?}]}
 *
 * Deliberate choices:
 *  - `response_format` is NOT sent: the spec marks it deprecated, and GPT image
 *    models always answer base64.
 *  - `url` responses are downloaded through this plugin's bounded transport, so
 *    an upstream cannot point us at an arbitrary target.
 *  - There is no retry here at all. A failure is returned to the caller.
 */

export const record = IMAGE_PROVIDERS['openai-compatible'];

const OUTPUT_FORMATS = new Set(['png', 'jpeg', 'webp']);

export async function generate({ section, limits, key, net, prompt, signal }) {
  const text = String(prompt ?? '').trim();
  if (!text) throw mediaError(Code.BAD_INPUT, 'prompt 不能为空');
  if (text.length > limits.maxTextChars) {
    throw mediaError(Code.PARAM_OUT_OF_RANGE, `prompt 有 ${text.length} 字符，上限 ${limits.maxTextChars}`);
  }
  const model = String(section.model ?? '').trim();
  if (!model) throw mediaError(Code.NOT_CONFIGURED, '未填写模型名');

  const outputFormat = OUTPUT_FORMATS.has(section.outputFormat) ? section.outputFormat : 'png';
  const url = joinUrl(section.baseUrl, '/images/generations');
  const body = {
    model,
    prompt: text,
    n: 1,
    size: section.size || '1024x1024',
  };
  if (section.quality && section.quality !== 'auto') body.quality = section.quality;
  if (section.background && section.background !== 'auto') body.background = section.background;
  if (outputFormat) body.output_format = outputFormat;

  const response = await net.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(key) },
    body: JSON.stringify(body),
    timeoutMs: section.timeoutMs,
    maxBytes: limits.maxResponseBytes,
    provider: record.label,
    signal,
  });
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    throw mediaError(Code.UNSUPPORTED_TYPE, '该端点返回了 SSE 流；本插件只接受一次性 JSON 响应（请在配置里关闭 stream）');
  }
  const payload = parseJsonBody(response, { provider: record.label });
  let item = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!item && typeof payload?.b64_json === 'string') item = payload;
  if (!item) {
    // Some compatible gateways wrap the image one level deeper; accept it but say so.
    if (typeof payload?.image === 'string') item = { b64_json: payload.image };
    else throw mediaError(Code.UPSTREAM, `${record.label} 的响应里没有 data[0]（字段：${Object.keys(payload ?? {}).join(',') || '空'}）`);
  }

  let bytes;
  if (typeof item.b64_json === 'string' && item.b64_json.trim()) {
    bytes = Buffer.from(stripDataUri(item.b64_json), 'base64');
  } else if (typeof item.url === 'string' && item.url.trim()) {
    const download = await net.request(item.url, {
      timeoutMs: section.timeoutMs,
      maxBytes: limits.maxImageBytes,
      provider: record.label,
      signal,
    });
    if (!download.ok) throw remoteFailure(download, { provider: record.label, what: '下载结果图失败' });
    bytes = download.bytes;
  } else {
    throw mediaError(Code.UPSTREAM, `${record.label} 既没有 b64_json 也没有 url`);
  }

  assertSize(bytes, limits.maxImageBytes, { what: '生成图片' });
  const sniffed = sniffImage(bytes);
  if (!sniffed) throw mediaError(Code.UNSUPPORTED_TYPE, '返回的字节不是 PNG/JPEG/WebP/GIF 图片（可能是错误页）');
  return {
    bytes,
    mime: sniffed.mime,
    extension: extensionFor(sniffed.mime, outputFormat),
    width: sniffed.width,
    height: sniffed.height,
    meta: {
      model,
      requestedSize: body.size,
      revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : null,
      usage: payload?.usage ?? null,
    },
  };
}

/**
 * Connection test. Uses `GET {baseUrl}/models` (documented, non-billing) and
 * degrades to a reachability answer when a gateway does not implement it. It
 * never generates an image, so "test ok" means "the endpoint answers with this
 * credential", NOT "generation works".
 */
export async function test({ section, key, net, limits }) {
  if (!String(section.baseUrl ?? '').trim()) return { ok: false, code: Code.NOT_CONFIGURED, detail: 'Base URL 未填写' };
  if (!String(key ?? '').trim()) return { ok: false, code: Code.NOT_CONFIGURED, detail: 'API Key 未配置' };
  const url = joinUrl(section.baseUrl, '/models');
  try {
    const response = await net.request(url, {
      headers: authHeaders(key),
      timeoutMs: Math.min(section.timeoutMs ?? limits.connectTimeoutMs, limits.connectTimeoutMs),
      maxBytes: 256 * 1024,
      provider: record.label,
    });
    if (response.ok) {
      let models = null;
      try {
        const parsed = JSON.parse(response.bytes.toString('utf8'));
        models = Array.isArray(parsed?.data) ? parsed.data.map(item => item?.id).filter(Boolean).slice(0, 20) : null;
      } catch { /* a non-JSON 200 still proves the endpoint answers */ }
      return { ok: true, level: 'metadata', detail: 'GET /models 成功（凭据有效）；未发起生成', models };
    }
    if (response.status === 404) {
      return { ok: true, level: 'reachability', detail: '端点可达但没有 /models；未发起生成，凭据有效性未验证', status: 404 };
    }
    if (response.status === 401 || response.status === 403) {
      const failure = remoteFailure(response, { provider: record.label, what: '鉴权失败' });
      return { ok: false, code: failure.code, detail: failure.message, status: response.status };
    }
    const failure = remoteFailure(response, { provider: record.label, what: '连接测试' });
    return { ok: false, code: failure.code, detail: failure.message, status: response.status };
  } catch (error) {
    return { ok: false, code: error?.code ?? Code.NETWORK, detail: error?.message ?? String(error) };
  }
}

/** `b64_json` must not carry a data URI prefix, but gateways do send one. */
function stripDataUri(value) {
  const text = String(value).trim();
  if (!text.startsWith('data:')) return text;
  const comma = text.indexOf(',');
  return comma >= 0 ? text.slice(comma + 1) : text;
}

export default { record, id: record.id, kind: 'image', generate, test, probeReachability, ensureOk };
