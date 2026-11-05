import fs from 'node:fs';
import path from 'node:path';

// Tag composition for the image pipeline.
//
// The independent pipeline turns the request into tags with a dedicated prompt
// file (`src/prompts/advanced.txt`) and the V4.1 model. The migration keeps that
// file as the source of truth instead of copying it: the prompt text is read at
// call time from the read-only reference install, so a change there is visible
// here instead of drifting.
//
// What this seam does NOT do: it does not reuse `llm.py`'s AstrBot-coupled
// caller, conversation fetch or preset/artist resolution. Those are recorded as
// remaining work; when the tag model fails the raw request is used verbatim.

export function loadAdvancedPrompt(imagePipelineRoot, relative = 'src/prompts/advanced.txt') {
  try {
    return fs.readFileSync(path.join(imagePipelineRoot, relative), 'utf8');
  } catch {
    return '';
  }
}

const OUTPUT_CONTRACT = `

【本次迁移的传输约定】
上一次输出只用于程序拼装，不是给用户看的文字。必须只输出一个 JSON 对象，不加解释、不加 Markdown：
{"tag":"英文逗号分隔的 NovelAI 正向 tag（可含权重语法）","negative":"可选的额外负向 tag，没有就给空字符串"}
tag 以画面内容为主体，覆盖主体、动作/姿态、服装、场景、构图与光线；不要写角色姓名以外的元信息，不要输出解释。`;

export function parseTagResult(text) {
  const source = String(text ?? '').trim();
  const cleaned = source.startsWith('```') ? source.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim() : source;
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('tag model did not return JSON');
  const data = JSON.parse(cleaned.slice(start, end + 1));
  const tag = typeof data.tag === 'string' ? data.tag.trim() : '';
  if (!tag) throw new Error('tag model returned an empty tag');
  const negative = typeof data.negative === 'string' ? data.negative.trim() : '';
  return { tag: tag.slice(0, 2000), negative: negative.slice(0, 1000) };
}

/** Compose tags from this turn's request; falls back to the raw request. */
export async function composeImageTags({ host, request, context = '', config, signal, log = () => {} } = {}) {  const pipelineRoot = config.image.imagePipelineRoot;
  const advanced = loadAdvancedPrompt(pipelineRoot, config.image.promptFile ?? 'src/prompts/advanced.txt');
  const raw = String(request ?? '').trim();
  if (!raw) throw new Error('image request is empty');
  if (!host?.available?.()) return { tag: raw, negative: '', composed: false, reason: 'host llm unavailable' };
  try {
    const system = `${advanced}${OUTPUT_CONTRACT}`;
    const input = [
      context.trim() ? `【本轮上下文】\n${context.trim().slice(0, 2000)}` : '',
      `【本次要求】\n${raw}`,
    ].filter(Boolean).join('\n\n');
    const result = await host.completeText({
      system,
      input,
      provider: config.image.tagProvider?.provider ?? config.vision.cloud.provider,
      model: config.image.tagProvider?.model ?? config.vision.cloud.model,
      maxTokens: 1200,
      timeoutMs: config.image.tagTimeoutMs ?? 120_000,
      signal,
      purpose: 'companion-media-image-tags',
    });
    const parsed = parseTagResult(result.text);
    return { ...parsed, composed: true, reason: 'tag model' };
  } catch (error) {
    log({ event: 'image.tag.fallback', message: String(error?.message ?? error).slice(0, 200) });
    return { tag: raw, negative: '', composed: false, reason: 'tag model failed' };
  }
}

// NovelAI is trained on English captions. A Chinese prompt is put verbatim into
// `v4_prompt.caption.base_caption`, where the model can only match stray tokens —
// observed 2026-10-31 with "窗边的午后，一只猫趴在窗台上". Translate first, keep the
// natural-language shape (V5 handles English prose well), and never translate
// twice or scramble an already-English prompt.

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

export function needsTranslation(text) {
  return CJK.test(String(text ?? ''));
}

const TRANSLATE_SYSTEM = [
  '你是 NovelAI 生图的提示词翻译。把用户给的中文画面描述翻译成自然的英文句子。',
  '保留全部视觉细节、数量、颜色、位置、镜头与风格限定词，不增加也不删减内容。',
  '不要解释、不要加引号、不要输出标签列表或 JSON，只输出一行英文。',
].join('\n');

export async function translateImagePrompt({ host, request, style = '', config, signal, log = () => {} } = {}) {
  const raw = String(request ?? '').trim();
  const styleText = String(style ?? '').trim();
  if (!raw) return { prompt: raw, style: styleText, translated: false, reason: 'empty prompt' };
  if (!needsTranslation(raw) && !needsTranslation(styleText)) {
    return { prompt: raw, style: styleText, translated: false, reason: 'already english' };
  }
  if (!host?.available?.()) {
    return { prompt: raw, style: styleText, translated: false, reason: 'host llm unavailable' };
  }
  try {
    const input = [raw, styleText ? `Additional art style: ${styleText}` : ''].filter(Boolean).join('\n');
    const result = await host.completeText({
      system: TRANSLATE_SYSTEM,
      input,
      provider: config.image.tagProvider?.provider ?? config.vision.cloud.provider,
      model: config.image.tagProvider?.model ?? config.vision.cloud.model,
      maxTokens: 400,
      timeoutMs: Math.min(config.image.tagTimeoutMs ?? 120_000, 60_000),
      signal,
      purpose: 'companion-media-image-translate',
    });
    const text = String(result?.text ?? '').replace(/^["'“”\s]+|["'“”\s]+$/g, '').trim();
    if (!text || needsTranslation(text)) throw new Error('translation did not produce english');
    // The style hint is folded into the English sentence, so callers must not
    // append the Chinese style again.
    return { prompt: text, style: '', translated: true, reason: 'translated' };
  } catch (error) {
    log({ event: 'image.translate.fallback', message: String(error?.message ?? error).slice(0, 200) });
    return { prompt: raw, style: styleText, translated: false, reason: 'translation failed' };
  }
}
