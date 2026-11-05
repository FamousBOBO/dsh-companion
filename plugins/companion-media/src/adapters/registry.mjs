import { Code, mediaError } from '../errors.mjs';
import * as openaiImage from './openai-image.mjs';
import * as naiImage from './nai-image.mjs';
import * as breeze from './breeze.mjs';
import * as gptSovits from './gpt-sovits.mjs';
import * as indexTts from './index-tts.mjs';
import { drama3, fishAudio } from './fish.mjs';

/**
 * Adapter registry: the only place that knows which ids exist.
 *
 * Lookup by id is total: an unknown id is a typed error, and a known-but-
 * unimplemented adapter is a *different* typed error (see index-tts). That
 * distinction is what keeps the UI honest.
 */

const IMAGE = {
  openai: { ...openaiImage, kind: 'image' },
  nai: { ...naiImage, kind: 'image' },
};

const TTS = {
  'breeze-tts-2': { ...breeze, kind: 'tts' },
  'gpt-sovits': { ...gptSovits, kind: 'tts' },
  drama3: { ...drama3, kind: 'tts' },
  'index-tts': { ...indexTts, kind: 'tts' },
  'fish-audio': { ...fishAudio, kind: 'tts' },
};

export function imageAdapter(id) {
  const adapter = IMAGE[id];
  if (!adapter) throw mediaError(Code.PROVIDER_UNKNOWN, `未知生图 provider：${id}`);
  return adapter;
}

export function ttsAdapter(id) {
  const adapter = TTS[id];
  if (!adapter) throw mediaError(Code.PROVIDER_UNKNOWN, `未知 TTS provider：${id}`);
  return adapter;
}

export const ADAPTERS = Object.freeze({ image: IMAGE, tts: TTS });

/** Ids plus the research record, for the status payload and the page. */
export function adapterCatalog() {
  return {
    image: Object.values(IMAGE).map(adapter => ({
      id: adapter.record.id,
      label: adapter.record.label,
      status: adapter.record.status,
      endpoint: adapter.record.endpoint,
      responseFormat: adapter.record.responseFormat,
      voiceListing: adapter.record.voiceListing,
      rateLimit: adapter.record.rateLimit,
      license: adapter.record.license,
      version: adapter.record.version,
      evidence: adapter.record.evidence,
      requiredFields: adapter.record.requiredFields,
      fieldLabels: adapter.record.fieldLabels,
      ...(adapter.record.reason ? { reason: adapter.record.reason } : {}),
    })),
    tts: Object.values(TTS).map(adapter => ({
      id: adapter.record.id,
      label: adapter.record.label,
      status: adapter.record.status,
      endpoint: adapter.record.endpoint,
      responseFormat: adapter.record.responseFormat,
      voiceListing: adapter.record.voiceListing,
      rateLimit: adapter.record.rateLimit,
      license: adapter.record.license,
      version: adapter.record.version,
      evidence: adapter.record.evidence,
      requiredFields: adapter.record.requiredFields,
      fieldLabels: adapter.record.fieldLabels,
      ...(adapter.record.reason ? { reason: adapter.record.reason } : {}),
    })),
  };
}
