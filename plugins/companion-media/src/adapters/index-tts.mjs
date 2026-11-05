import { Code, mediaError } from '../errors.mjs';
import { TTS_PROVIDERS } from '../schema.mjs';

/**
 * Index-TTS: **not connected**.
 *
 * M0 finding (docs/media/M0-report.md §3.5): the official repository ships a
 * Python API (`indextts.infer_v2.IndexTTS2`), a Gradio WebUI, and vLLM/Triton
 * deployment recipes — but no HTTP JSON protocol that could be verified. The
 * plan forbids sharing one request body across "TTS projects that all look
 * alike", so this adapter intentionally implements nothing except a refusal
 * that names the reason.
 *
 * When the project publishes a documented HTTP API, this file is the only place
 * that has to change; the registry entry's `status` flips to `connected`.
 */

export const record = TTS_PROVIDERS['index-tts'];

export async function generate() {
  throw mediaError(
    Code.PROVIDER_NOT_IMPLEMENTED,
    `Index-TTS 尚未接入：${record.reason}`,
    { evidence: record.evidence, source: 'index-tts' },
  );
}

export async function test() {
  return {
    ok: false,
    code: Code.PROVIDER_NOT_IMPLEMENTED,
    level: 'none',
    detail: `Index-TTS 尚未接入：${record.reason}`,
  };
}

export default { record, id: record.id, kind: 'tts', generate, test };
