import fs from 'node:fs';
import { Code, mediaError } from '../errors.mjs';
import { assertSize, pcmToWav, sniffAudio, extensionFor } from '../media-format.mjs';
import { TTS_PROVIDERS } from '../schema.mjs';
import { authHeaders, probeReachability, remoteFailure } from './shared.mjs';

/**
 * Breeze TTS 2 — official FastAPI service (`python -m breeze_infer.api`).
 *
 * Verified 2026-11-05 (§3.1 of the M0 report):
 *   POST {baseUrl}/v1/audio/speech   multipart/form-data
 *     text, instruction?, cfg_scale, seed, ref_audio?, ref_text?
 *   → audio/pcm, mono 24 kHz s16le (headers carry the real rate)
 *
 * Notes that shape this adapter:
 *  - the service has NO auth, so the Base URL is expected to be a local/inner
 *    address and the plugin never invents a token;
 *  - the service is single-concurrency and answers 409 while busy;
 *  - the body is multipart, so the PCM is wrapped into WAV here (a raw PCM file
 *    is useless to a messenger).
 */

export const record = TTS_PROVIDERS['breeze-tts2'];

const AUDIO_MIME = new Map([
  ['wav', 'audio/wav'],
  ['mp3', 'audio/mpeg'],
  ['ogg', 'audio/ogg'],
  ['opus', 'audio/opus'],
  ['raw', 'audio/pcm'],
]);

function buildMultipart({ fields, file }) {
  const boundary = `----dsh-companion-media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  }
  if (file) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
      'utf8',
    ));
    chunks.push(file.bytes, Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function generate({ section, limits, key, net, text, instruction = '', signal }) {
  const content = String(text ?? '').trim();
  if (!content) throw mediaError(Code.NO_TEXT, 'text 不能为空');
  if (content.length > limits.maxTextChars) {
    throw mediaError(Code.PARAM_OUT_OF_RANGE, `text 有 ${content.length} 字符，上限 ${limits.maxTextChars}`);
  }

  const refPath = String(section.refAudioPath ?? '').trim();
  const refText = String(section.refText ?? '').trim();
  if (Boolean(refPath) !== Boolean(refText)) {
    throw mediaError(Code.CONFIG_INVALID, '参考音频与逐字稿必须同时填写或同时留空（Breeze 服务端同样校验，缺一会返回 400）');
  }
  let file = null;
  if (refPath) {
    let bytes;
    try {
      const stat = fs.statSync(refPath);
      if (!stat.isFile()) throw new Error('not a regular file');
      if (stat.size > limits.maxAudioBytes) {
        throw mediaError(Code.TOO_LARGE, `参考音频 ${stat.size} 字节，超过上限 ${limits.maxAudioBytes}`);
      }
      bytes = fs.readFileSync(refPath);
    } catch (error) {
      if (error instanceof mediaError === false && error?.code === Code.TOO_LARGE) throw error;
      throw mediaError(Code.BAD_INPUT, `参考音频读不到：${String(error?.message ?? error).slice(0, 120)}`);
    }
    file = { field: 'ref_audio', filename: 'reference.wav', mime: 'audio/wav', bytes };
  }

  const multipart = buildMultipart({
    fields: {
      text: content,
      instruction: instruction || section.instruction || '',
      cfg_scale: section.cfgScale,
      seed: section.seed,
      ref_text: refText,
    },
    file,
  });

  const response = await net.request(`${String(section.baseUrl).replace(/\/+$/, '')}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': multipart.contentType, ...authHeaders(key) },
    body: multipart.body,
    timeoutMs: section.timeoutMs,
    maxBytes: limits.maxAudioBytes,
    provider: record.label,
    signal,
  });
  if (!response.ok) throw remoteFailure(response, { provider: record.label, what: 'Breeze 合成失败' });
  assertSize(response.bytes, limits.maxAudioBytes, { what: '语音产物' });

  const declared = String(response.mime || '').toLowerCase();
  let bytes = response.bytes;
  let mime = declared;
  let format = 'pcm';
  if (declared.includes('audio/pcm') || declared === 'application/octet-stream' || !declared) {
    const rate = Number(response.headers.get('x-sample-rate') ?? 0) || 24_000;
    bytes = pcmToWav(response.bytes, { sampleRate: rate });
    mime = 'audio/wav';
    format = 'wav';
  } else {
    const sniffed = sniffAudio(bytes);
    if (!sniffed) throw mediaError(Code.UNSUPPORTED_TYPE, `Breeze 返回的字节不是可识别音频（Content-Type: ${declared || '空'}）`);
    mime = sniffed.mime;
    format = sniffed.format;
  }
  const sniffed = sniffAudio(bytes) ?? { durationSeconds: null };
  return {
    bytes,
    mime,
    extension: extensionFor(mime, 'wav'),
    format,
    durationSeconds: sniffed.durationSeconds ?? null,
    meta: { model: section.model, voice: refPath ? `ref:${refPath}` : 'instruction-only', cfgScale: section.cfgScale, seed: section.seed },
  };
}

/** Connection test: `GET /health` is documented and free. */
export async function test({ section, net, limits }) {
  if (!String(section.baseUrl ?? '').trim()) return { ok: false, code: Code.NOT_CONFIGURED, detail: '服务地址未填写' };
  try {
    const response = await net.request(`${String(section.baseUrl).replace(/\/+$/, '')}/health`, {
      timeoutMs: Math.min(section.timeoutMs ?? limits.connectTimeoutMs, limits.connectTimeoutMs),
      maxBytes: 32 * 1024,
      provider: record.label,
    });
    if (response.ok) {
      let parsed = null;
      try { parsed = JSON.parse(response.bytes.toString('utf8')); } catch { /* health may be plain text */ }
      return {
        ok: true,
        level: 'health',
        detail: `GET /health 成功${parsed?.sample_rate ? `（sample_rate=${parsed.sample_rate}）` : ''}；未合成任何语音`,
        health: parsed,
      };
    }
    if (response.status === 503) {
      return { ok: false, code: Code.BACKEND_BUSY, detail: 'GET /health 返回 503：服务正在加载模型（Breeze 启动时会先返回 loading）', status: 503 };
    }
    const failure = remoteFailure(response, { provider: record.label, what: '健康检查' });
    return { ok: false, code: failure.code, detail: failure.message, status: response.status };
  } catch (error) {
    return { ok: false, code: error?.code ?? Code.NETWORK, detail: error?.message ?? String(error) };
  }
}

export const mimeForFormat = format => AUDIO_MIME.get(String(format)) ?? 'application/octet-stream';
export default { record, id: record.id, kind: 'tts', generate, test, probeReachability };
