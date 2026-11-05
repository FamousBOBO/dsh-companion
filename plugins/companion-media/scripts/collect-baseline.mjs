import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// M0 baseline collector.
//
// Produces a sanitized snapshot of what the old stack really is on disk, so the
// migration does not inherit a README's defaults. Only whitelisted keys are
// copied; credential-shaped values are replaced with a marker, never printed.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const companionRoot = path.resolve(packageRoot, '../..');
const botRoot = path.resolve(companionRoot, '..');

const OUT_DIR = path.join(companionRoot, 'logs/media-migration');
fs.mkdirSync(OUT_DIR, { recursive: true });

function readJson(rel) {
  try {
    // Several of the old config files start with a UTF-8 BOM; JSON.parse rejects it.
    return JSON.parse(fs.readFileSync(path.join(botRoot, rel), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function hashFile(rel) {
  try {
    const bytes = fs.readFileSync(path.join(botRoot, rel));
    return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16) };
  } catch {
    return null;
  }
}

function pick(source, keys) {
  const out = {};
  for (const key of keys) if (source && key in source) out[key] = source[key];
  return out;
}

function findProvider(config, id) {
  return (config?.provider ?? []).find(item => item.id === id) ?? null;
}

const astrbotConfig = readJson('astrbot/data/cmd_config.json');
const companionConfig = readJson('astrbot/data/config/astrbot_plugin_private_companion_config.json');
const imageConfig = readJson('astrbot/data/config/astrbot_plugin_image_pipeline_config.json');
const screenConfig = readJson('astrbot/data/config/astrbot_plugin_screen_companion_config.json');
const desktopPatch = fs.readFileSync(path.join(companionRoot, 'home/profiles/desktop/cordis.patch.yml'), 'utf8');

const breeze = findProvider(astrbotConfig, 'local-march7-breeze');
const opencodeSource = (astrbotConfig?.provider_sources ?? []).find(item => item.id === 'opencode') ?? null;
const ollamaSource = (astrbotConfig?.provider_sources ?? []).find(item => item.id === 'ollama') ?? null;

async function probe(url, init) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    const text = await response.text();
    return { url, ok: response.ok, status: response.status, body: text.slice(0, 300) };
  } catch (error) {
    return { url, ok: false, error: String(error?.message ?? error).slice(0, 200) };
  }
}

const baseline = {
  at: new Date().toISOString(),
  evidenceLevel: '① static/config inspection plus live endpoint probes',
  caveat: 'Disk configuration and reachability only. A reachable endpoint is not proof that the old companion pipeline is healthy.',
  roots: {
    companion: companionRoot,
    bot: botRoot,
  },
  host: {
    runtimeVersion: JSON.parse(fs.readFileSync(path.join(companionRoot, 'runtime.local.json'), 'utf8')).version,
    presetPatch: 'home/profiles/desktop/cordis.patch.yml',
    foundationMounted: desktopPatch.includes('companion-foundation/index.mjs'),
    qqChannelMounted: desktopPatch.includes('channel-qq'),
    mediaPluginMounted: desktopPatch.includes('companion-media'),
    defaultModel: (() => {
      const match = desktopPatch.match(/- id: agent-default-model[\s\S]*?provider: (\S+)[\s\S]*?model: (\S+)/);
      return match ? { provider: match[1], model: match[2] } : null;
    })(),
    multimodal: {
      // Verified from the installed pi-ai catalog, not from documentation.
      route: 'opencode-go/deepseek-v4.1-flash',
      inputModalities: ['text', 'image'],
      evidence: 'resources/app/dsh/node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json',
    },
  },
  sources: {
    vision: {
      private_image: hashFile('astrbot/data/plugins/astrbot_plugin_private_companion/private_image.py'),
      model_routing: hashFile('astrbot/data/plugins/astrbot_plugin_private_companion/model_routing.py'),
      gpu_gateway: hashFile('runtime/gpu_model_gateway.py'),
    },
    tts: {
      provider: hashFile('astrbot/data/plugins/astrbot_plugin_breeze_tts2/provider.py'),
      direction: hashFile('astrbot/data/plugins/astrbot_plugin_breeze_tts2/direction.py'),
      presets: hashFile('breeze-tts2/march7-emotion-presets.json'),
    },
    image: {
      main: hashFile('astrbot/data/plugins/astrbot_plugin_image_pipeline/main.py'),
      params: hashFile('astrbot/data/plugins/astrbot_plugin_image_pipeline/src/params.py'),
      data_source: hashFile('astrbot/data/plugins/astrbot_plugin_image_pipeline/src/data_source.py'),
      v5: hashFile('astrbot/data/plugins/astrbot_plugin_image_pipeline/src/v5.py'),
      config: hashFile('astrbot/data/plugins/astrbot_plugin_image_pipeline/src/config.py'),
      advanced_prompt: hashFile('astrbot/data/plugins/astrbot_plugin_image_pipeline/src/prompts/advanced.txt'),
    },
    screen: {
      main: hashFile('astrbot/data/plugins/astrbot_plugin_screen_companion/main.py'),
      remote_client: hashFile('astrbot/data/plugins/astrbot_plugin_screen_companion/remote_client.py'),
    },
  },
  effectiveConfig: {
    vision: pick(companionConfig, [
      'PLUGIN_VISION_PROVIDER_ID', 'READING_ARCHIVE_VISION_PROVIDER_ID', 'WARDROBE_VISION_PROVIDER_ID',
      'private_image_vision_provider_priority', 'private_image_vision_max_chars', 'private_image_provider_timeout_seconds',
      'private_image_vision_wait_seconds', 'enable_private_image_type_probe', 'private_image_type_probe_max_dimension',
      'enable_private_image_gif_enhancement', 'private_image_gif_max_frames', 'enable_private_image_vision_cache',
      'private_image_vision_cache_max_items', 'enable_context_image_captioning', 'context_image_caption_max_items',
      'reaction_expression_image_format', 'reaction_expression_vision_verify_mode', 'enable_group_image_understanding',
    ]),
    imageCaptionProvider: astrbotConfig?.provider_settings?.default_image_caption_provider_id ?? null,
    speech: pick(companionConfig, [
      'enable_voice_action', 'enable_tts_enhancement', 'tts_synthesis_backend', 'tts_provider_id_zh',
      'tts_generation_mode', 'tts_delivery_mode', 'tts_conversion_scope', 'tts_conversion_provider_id',
      'tts_frequency_control_mode', 'tts_session_min_interval_seconds', 'tts_trigger_probability',
      'auto_voice_enabled', 'auto_voice_probability', 'auto_voice_max_chars', 'auto_voice_cooldown_seconds',
      'voice_action_max_chars',
    ]),
    breezeProvider: breeze
      ? {
        id: breeze.id, type: breeze.type, api_base: breeze.api_base, model: breeze.model, voice: breeze.voice,
        cfg_scale: breeze.cfg_scale, speed: breeze.speed, seed: breeze.seed, max_new_tokens: breeze.max_new_tokens,
        timeout: breeze.timeout, auto_start: breeze.auto_start, presets_file: breeze.presets_file,
        enable: breeze.enable,
      }
      : null,
    providerTtsSettings: pick(astrbotConfig?.provider_tts_settings ?? {}, ['enable', 'provider_id', 'trigger_probability']),
    image: {
      pipeline: pick(imageConfig?.general ?? {}, ['help_t2i', 'merge_draw_to_chat_record']),
      request: pick(imageConfig?.request ?? {}, ['base_url', 'max_concurrent', 'max_queue_size', 'opus_free_mode', 'cloud_queue_enabled', 'cloud_queue_base_url', 'retry_times']),
      llm: pick(imageConfig?.llm ?? {}, ['generation_flow', 'v5_quality_preset', 'v5_undesired_content_preset', 'advanced_arg_generation_provider', 'advanced_prompt_mode', 'image_pipeline_timeout_seconds']),
      defaults: pick(imageConfig?.defaults ?? {}, ['model', 'size', 'steps', 'scale', 'sampler', 'noise_schedule']),
      permission: pick(imageConfig?.permission ?? {}, ['width_limit', 'height_limit', 'steps_limit']),
      quota: pick(imageConfig?.quota ?? {}, ['enable_quota']),
      companionPhoto: pick(companionConfig, [
        'photo_generation_backend', 'photo_generation_prompt_format', 'photo_generation_style',
        'photo_generation_allowed_scopes', 'photo_generation_private_owner_max_daily',
        'photo_generation_private_friend_max_daily', 'photo_generation_group_max_daily',
        'photo_generation_proactive_max_daily', 'natural_language_photo_generation_max_daily',
        'command_photo_generation_max_daily', 'natural_language_photo_generation_mode',
      ]),
    },
    screen: pick(screenConfig ?? {}, ['enabled', 'vision_provider_id', 'screen_recognition_mode', 'remote_mode', 'remote_ws_port', 'remote_screenshot_max_age', 'enable_privacy_guard', 'save_local', 'check_interval']),
    segmentation: pick(companionConfig, [
      'inbound_message_debounce_seconds', 'image_message_debounce_seconds',
      'segmented_proactive_component_order', 'segmented_proactive_voice_strategy',
      'segmented_proactive_image_strategy',
    ]),
  },
  secretsHandling: {
    // Counts only. Values are never copied into this file.
    opencodePlaintextKeyPresent: Boolean(Array.isArray(opencodeSource?.key) && opencodeSource.key[0]?.startsWith('oc_')),
    ollamaPlaceholderKey: ollamaSource?.key?.[0] === 'ollama',
    novelAiTokenPresent: Boolean(Array.isArray(imageConfig?.request?.tokens) && imageConfig.request.tokens[0]),
    screenRemoteTokenPresent: Boolean(screenConfig?.remote_auth_token),
    note: 'The old configuration stores provider keys in plaintext. This file records presence only; the migration reads nothing from these fields except the local backends.',
  },
  backends: {
    gateway: await probe('http://127.0.0.1:8139/health'),
    ollama: await probe('http://127.0.0.1:11434/api/tags'),
    breeze: await probe('http://127.0.0.1:8137/health'),
    novelai: await probe('https://image.novelai.net/', { method: 'GET' }),
  },
  gaps: [
    'Emoji/sticker cloud routing is documented as V4.1 but no dedicated provider field exists in the live companion config; the type-probe classifies pictures and the local caption provider serves ordinary pictures. Treated as config/document baseline, recorded as a partial source-level finding.',
    'The Breeze backend ignores `speed`; tempo is applied with FFmpeg. Any future backend that honours speed would need this seam revisited.',
    'Screen capture requires the separate screen client; this migration delivers frames only and never captures.',
    'NovelAI spend cannot be confirmed from the API response; Opus free mode is on.',
  ],
};

const file = path.join(OUT_DIR, 'baseline.json');
fs.writeFileSync(file, JSON.stringify(baseline, null, 2), 'utf8');
console.log(JSON.stringify({ file, backends: Object.fromEntries(Object.entries(baseline.backends).map(([key, value]) => [key, value.ok])) }, null, 2));
