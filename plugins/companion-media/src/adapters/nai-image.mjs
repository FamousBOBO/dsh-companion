import { resolveGenerationSection } from '../generation-presets.mjs';
import { Code, mediaError } from '../errors.mjs';
import { assertSize, extensionFor, firstImageFromZip, parseNaiSse, sniffImage } from '../media-format.mjs';
import { resolvePreset } from '../presets.mjs';
import { IMAGE_PROVIDERS } from '../schema.mjs';
import { authHeaders, buildNaiParameters, ensureOk, joinUrl, parseJsonBody, probeReachability, remoteFailure } from './shared.mjs';

/**
 * NovelAI image generation, two transports.
 *
 * `official` (verified 2026-11-05 against api.novelai.net's Swagger, §2.2 of the
 * M0 report):
 *   POST {baseUrl}/ai/generate-image
 *   {input, model, action:'generate', parameters:{...}}
 *   → SSE or ZIP attachment, each carrying a base64 PNG
 *
 * `openai-relay` (community-verified shape, §2.3):
 *   POST {baseUrl}/v1/images/generations
 *   {prompt, size, n, model, parameters:{...}}
 *   → {data:[{b64_json|url}]}
 *
 * The two bodies are built separately on purpose: fields of one service must
 * never be sent to the other. Presets come from `resolvePreset()`, which is
 * family-scoped so a V5 preset can never reach a 4.5 request.
 */

export const record = IMAGE_PROVIDERS.nai;

export const TRANSPORTS = Object.freeze(['official', 'openai-relay']);

function pickTransport(section) {
  const transport = String(section.transport ?? 'official');
  if (!TRANSPORTS.includes(transport)) {
    throw mediaError(Code.PROVIDER_UNKNOWN, `未知 transport：${transport}（可选 ${TRANSPORTS.join(' / ')}）`);
  }
  return transport;
}

export async function generate({ section, limits, key, net, prompt, negative = '', signal }) {
  section = resolveGenerationSection(section);
  const text = String(prompt ?? '').trim();
  if (!text) throw mediaError(Code.BAD_INPUT, 'prompt 不能为空');
  if (text.length > limits.maxTextChars) {
    throw mediaError(Code.PARAM_OUT_OF_RANGE, `prompt 有 ${text.length} 字符，上限 ${limits.maxTextChars}`);
  }
  const model = String(section.model ?? '').trim();
  if (!model) throw mediaError(Code.NOT_CONFIGURED, '未填写模型（nai-diffusion-5-full / nai-diffusion-4-5-full …）');

  const preset = resolvePreset({
    model,
    presets: section.presets,
    negativePrompt: section.negativePrompt,
    artistString: section.artistString ?? '',
    request: { prompt: text, negative },
  });
  if (!preset.positive) throw mediaError(Code.BAD_INPUT, '提示词为空');

  const parameters = buildNaiParameters(section, { prompt: preset.positive, negative: preset.negative, preset });
  const transport = pickTransport(section);
  const size = `${section.width}x${section.height}`;

  const request = transport === 'official'
    ? {
        url: joinUrl(section.baseUrl, '/ai/generate-image'),
        body: { input: preset.positive, model, action: 'generate', parameters },
        accept: 'application/json, application/zip, text/event-stream',
      }
    : {
        url: joinUrl(section.baseUrl, '/v1/images/generations'),
        body: { prompt: preset.positive, size, n: 1, model, parameters },
        accept: 'application/json',
      };

  const response = await net.request(request.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: request.accept, ...authHeaders(key) },
    body: JSON.stringify(request.body),
    timeoutMs: section.timeoutMs,
    maxBytes: limits.maxResponseBytes,
    provider: record.label,
    signal,
  });
  if (!response.ok) throw remoteFailure(response, { provider: record.label, what: 'NovelAI 生成失败' });

  const bytes = extractImage(response, { provider: record.label });
  assertSize(bytes, limits.maxImageBytes, { what: '生成图片' });
  const sniffed = sniffImage(bytes);
  if (!sniffed) throw mediaError(Code.UNSUPPORTED_TYPE, '返回的字节不是 PNG/JPEG/WebP/GIF 图片（可能是错误页或空 ZIP）');

  return {
    bytes,
    mime: sniffed.mime,
    extension: extensionFor(sniffed.mime, 'png'),
    width: sniffed.width,
    height: sniffed.height,
    meta: {
      model,
      transport,
      size,
      steps: section.steps,
      sampler: section.sampler,
      presetFamily: preset.family,
      presetApplied: preset.applyDefaults,
      presetWarnings: preset.warnings,
    },
  };
}

/** One response body, three documented shapes: JSON, SSE, ZIP. */
function extractImage(response, { provider }) {
  const mime = String(response.mime || response.headers.get('content-type') || '').toLowerCase();
  if (mime.includes('zip') || response.bytes.subarray(0, 2).toString('latin1') === 'PK') {
    return firstImageFromZip(response.bytes).bytes;
  }
  const text = response.bytes.toString('utf8');
  if (mime.includes('event-stream') || /^\s*data:/m.test(text)) {
    const { base64, error } = parseNaiSse(text);
    if (error) throw mediaError(Code.UPSTREAM, `${provider} 在流中报告错误：${String(error).slice(0, 160)}`);
    if (!base64) throw mediaError(Code.UPSTREAM, `${provider} 的 SSE 响应里没有图像数据`);
    return Buffer.from(base64, 'base64');
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw mediaError(Code.UNSUPPORTED_TYPE, `${provider} 返回了无法识别的内容（非 JSON/SSE/ZIP）`);
  }
  if (typeof payload?.image === 'string') return Buffer.from(payload.image, 'base64');
  const item = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (typeof item?.b64_json === 'string') return Buffer.from(item.b64_json, 'base64');
  if (typeof item?.image === 'string') return Buffer.from(item.image, 'base64');
  throw mediaError(Code.UPSTREAM, `${provider} 的 JSON 响应里没有图像（字段：${Object.keys(payload ?? {}).join(',') || '空'}）`);
}

/**
 * Connection test: reachability only.
 *
 * NovelAI's billable endpoint has no free metadata call, and the plugin must not
 * spend the operator's account to prove a key works. So this reports
 * `level: 'reachability'` and says plainly that the credential is unverified.
 */
export async function test({ section, key, net, limits }) {
  if (!String(section.baseUrl ?? '').trim()) return { ok: false, code: Code.NOT_CONFIGURED, detail: 'Base URL 未填写' };
  if (!String(key ?? '').trim()) return { ok: false, code: Code.NOT_CONFIGURED, detail: 'API Key 未配置' };
  let transport;
  try {
    transport = pickTransport(section);
  } catch (error) {
    return { ok: false, code: error.code, detail: error.message };
  }
  const probe = await probeReachability({
    net,
    url: String(section.baseUrl).replace(/\/+$/, '') + '/',
    headers: authHeaders(key),
    timeoutMs: Math.min(section.timeoutMs ?? limits.connectTimeoutMs, limits.connectTimeoutMs),
    provider: record.label,
  });
  return { ...probe, transport, note: 'NovelAI 没有免费的元数据接口，本测试只证明地址可达；凭据有效性需操作者手动生成一次才知道' };
}

export default { record, id: record.id, kind: 'image', generate, test, probeReachability, ensureOk };
