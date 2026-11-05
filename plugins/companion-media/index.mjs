import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIG_RELATIVE_PATH, loadConfig, sanitizedConfig } from './config.mjs';
import { Code, toFailure } from './lib/errors.mjs';
import { createLedger } from './lib/store.mjs';
import { normalizeMediaInput, writeManaged, extractGifFrames } from './lib/media.mjs';
import { createVisionService } from './lib/vision.mjs';
import { createSpeechService, createAutoVoiceService } from './lib/speech.mjs';
import { createImageService } from './lib/imagegen.mjs';
import { createCoordinator } from './lib/coordinator.mjs';
import { composeImageTags, translateImagePrompt } from './lib/imageprompt.mjs';
import { resolveOutfit } from './lib/wardrobe.mjs';
import { createScreenService, screenCapabilities, readScreenFixture, evaluateFrame, resolveFrameSource, FRAME_PORT_NAME, MODE_LIVE } from './lib/screen.mjs';
import { createMediaHost, resolveAttachments } from './lib/host-llm.mjs';
import { createTurnAggregator } from './lib/batching.mjs';
import { createDeliveryService, planDelivery } from './lib/delivery.mjs';
import { managedPath, MANAGED_DIR } from './lib/paths.mjs';
import { runProcess } from './lib/exec.mjs';

// companion-media: the shared media layer for the independent DSH companion.
//
// Mount order matters: the service is built first and the tools are registered
// last, so a failure in registration cannot leave a half-registered surface.
// Nothing in `apply` may throw: a broken media plugin must degrade to "media is
// unavailable", never to "the companion preset does not load".
//
// Review round 1 changed two structural things:
//   * the configuration is re-read when the file changes, so the documented
//     "flip the switch to disable" kill switch actually works without a restart;
//   * every artifact and ledger write happens under `home/media`, matching the
//     contract instead of a sibling `media/` directory.

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.');
const COMPANION_ROOT = path.resolve(PLUGIN_ROOT, '../..');

// The host compiles an author-facing property map into raw JSON Schema through
// `defineTool`. Passing that map straight to `ctx.tools.register` ships
// `{prompt: {...}}` as `parameters`, and the provider rejects the whole request
// with `schema must be a JSON Schema of 'type: "object"', got 'type: null'`
// (observed on the live QQ turn, 2026-10-28 21:03). Use the host helper when it
// is reachable and fall back to the identical shape otherwise.
const runtimeRoot = process.env.DSH_COMPANION_MODULE_ROOT;
let defineTool = null;
if (runtimeRoot) {
  try {
    const module = await import(pathToFileURL(path.join(runtimeRoot, '@deepseek-ai/dsh-tools/lib/index.js')).href);
    defineTool = module.defineTool ?? null;
  } catch {
    defineTool = null;
  }
}

/**
 * Add the absolute path of a produced artifact plus a ready-to-use channel
 * handoff. The artifact path is relative to the companion root, but a session's
 * working root is `<companion>/workspace`, so a model asked to "resolve it to an
 * absolute path" cannot do so reliably — it silently built a wrong path and the
 * follow-up send failed. Computing it here removes that guess.
 */
export function withArtifactLocation(result, handoff) {
  if (!result || result.ok !== true || !result.artifact?.path) return result;
  const absolutePath = path.resolve(COMPANION_ROOT, String(result.artifact.path));
  let fileExists = false;
  try {
    fileExists = fs.statSync(absolutePath).isFile();
  } catch {
    fileExists = false;
  }
  return {
    ...result,
    artifact: { ...result.artifact, absolutePath, fileExists },
    ...(handoff
      ? {
          handoff: {
            tool: handoff.tool,
            action: handoff.action,
            file: absolutePath,
            ready: fileExists,
            // Synthesis/generation alone is not delivery: the model stopped after
            // this tool and never called the channel, so the user heard nothing.
            delivered: false,
            mustSend: `call ${handoff.tool} action=${handoff.action} with file=${absolutePath} now; producing the file is not delivering it`,
            note: 'isGroup 与 target 由当前会话填写；媒体层只产出文件，不发送',
          },
        }
      : {}),
  };
}

/** Same projection the host performs for an implicit property map. */
export function parametersToJsonSchema(spec = {}) {
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(spec)) {
    if (!value || typeof value !== 'object') continue;
    const { required: isRequired, ...rest } = value;
    properties[key] = rest;
    if (isRequired) required.push(key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

export const name = 'companion-media';
export const inject = ['tools'];

const shared = new Map();

export function sharedMediaFor(root) {
  return shared.get(path.resolve(root)) ?? null;
}

export function shareMedia(root, service) {
  const key = path.resolve(root);
  const existing = shared.get(key);
  if (existing) return existing;
  shared.set(key, service);
  return service;
}

function appendJsonl(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
  } catch { /* diagnostics never break a turn */ }
}

function readOwner(companionRoot) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(companionRoot, 'home/companion/identity.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (!value?.owner?.id) return null;
    return { userId: value.owner.id, displayName: value.owner.displayName, persona: value.persona };
  } catch {
    return null;
  }
}

/** Only these roots may be read as a picture source; the model cannot name any path. */
function allowedInboxRoots(companionRoot) {
  return [
    managedPath(companionRoot, 'inbox'),
    path.join(PLUGIN_ROOT, 'test/fixtures'),
  ].map(item => path.resolve(item));
}

function readAllowedSource(companionRoot, candidate) {
  const absolute = path.resolve(companionRoot, candidate);
  const permitted = allowedInboxRoots(companionRoot).some(base => absolute === base || absolute.startsWith(`${base}${path.sep}`));
  if (!permitted) {
    const error = new Error('media source must live under home/media/inbox or the plugin fixtures');
    error.code = Code.DOWNLOAD_BLOCKED;
    throw error;
  }
  // Resolve symlinks/junctions before the containment check so a link cannot
  // point outside the permitted roots.
  let real;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    throw Object.assign(new Error('media source does not exist'), { code: Code.NOT_FOUND });
  }
  const realPermitted = allowedInboxRoots(companionRoot).some(base => {
    try {
      const realBase = fs.realpathSync(base);
      return real === realBase || real.startsWith(`${realBase}${path.sep}`);
    } catch {
      return false;
    }
  });
  if (!realPermitted) {
    throw Object.assign(new Error('media source escapes the permitted roots through a link'), { code: Code.PATH_ESCAPE });
  }
  return { bytes: fs.readFileSync(real), filename: path.basename(real) };
}

function fileStamp(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

export function mountMedia(ctx, { companionRoot = COMPANION_ROOT, dataRoot = null, run = runProcess, deliveryChannel = null, frameSource = null } = {}) {
  const mediaRoot = dataRoot ?? companionRoot;
  const configFile = path.join(companionRoot, CONFIG_RELATIVE_PATH);
  const logFile = path.join(companionRoot, 'logs/media-migration/media-events.jsonl');
  const log = entry => appendJsonl(logFile, { at: new Date().toISOString(), ...entry });

  let stamp = fileStamp(configFile);
  let loaded = loadConfig(companionRoot);
  const ledger = createLedger({
    root: path.join(mediaRoot, MANAGED_DIR),
    file: 'state/ledger.json',
    maxCacheItems: loaded.config.vision.cacheMaxItems,
  });

  const hostServiceAvailable = () => {
    try {
      return typeof ctx.get === 'function' ? Boolean(ctx.get('llm')?.prepareCall) : Boolean(ctx.llm?.prepareCall);
    } catch {
      return false;
    }
  };
  let hostPromise = null;
  const host = {
    available: hostServiceAvailable,
    async completeText(options) {
      const instance = await (hostPromise ??= createMediaHost(ctx, { attachments: resolveAttachments(ctx), describe: 'companion-media' }));
      return instance.completeText(options);
    },
    async inspectImages(options) {
      const instance = await (hostPromise ??= createMediaHost(ctx, { attachments: resolveAttachments(ctx), describe: 'companion-media' }));
      return instance.inspectImages(options);
    },
    describe() { return { available: hostServiceAvailable(), hasAttachments: Boolean(resolveAttachments(ctx)) }; },
  };

  /**
   * The delivery channel is **injected**, never imported (CONTRACT §5/§6.7).
   *
   * Resolution order, re-read on every call so a hot-reloaded provider is picked up:
   *   1. a mount option (`options.deliveryChannel`) — used by tests and by a host that wires
   *      the channel itself;
   *   2. the host service `companionDeliveryChannel` — what the QQ channel publishes once it
   *      has a live sender (OneBot `send_private_msg` / the desktop session).
   *
   * With neither, `channelWired` is false and real modes fail closed instead of pretending.
   */
  const resolveDeliveryChannel = () => {
    try {
      if (deliveryChannel && typeof deliveryChannel.send === 'function') return deliveryChannel;
      const provided = typeof ctx.get === 'function' ? ctx.get('companionDeliveryChannel') : null;
      return provided && typeof provided.send === 'function' ? provided : null;
    } catch {
      return null;
    }
  };

  const delivery = createDeliveryService({
    ledger,
    log,
    mode: loaded.config.delivery.mode,
    modeProvider: () => loaded.config.delivery.mode,
    channelProvider: resolveDeliveryChannel,
  });

  /**
   * The screen frame source is **injected** too (CONTRACT §5: this layer never
   * captures). Resolution order, re-read on every call so a late publish wins:
   *   1. the mount option (`frameSource`) — tests, and a host that wires it itself;
   *   2. the host service `companionScreenFrame` — what the desktop or channel
   *      publishes when it is allowed to hold a capture capability.
   * With neither, a live screen request fails with `MEDIA_DISABLED` +
   * `frame-source-unavailable`; nothing is ever fabricated or captured here.
   */
  const frameSourceProvider = () => {
    if (frameSource) return resolveFrameSource(frameSource);
    let published = null;
    try {
      published = typeof ctx?.get === 'function' ? ctx.get(FRAME_PORT_NAME) : null;
    } catch {
      published = null;
    }
    return resolveFrameSource(published);
  };

  let graph = null;
  const buildGraph = current => {
    const config = current.config;
    const aggregator = createTurnAggregator({
      trailingWindowMs: config.delivery.trailingWindowMs,
      maxWaitMs: config.delivery.maxWaitMs,
      imageWindowMs: config.delivery.imageWindowMs,
    });
    const vision = createVisionService({ config, ledger, log, host, run, extractFrames: extractGifFrames, root: mediaRoot });
    const speech = createSpeechService({ config, ledger, log, host, run, root: mediaRoot });
    // Auto voice: a persisted clock + a oice_only plan. It decides and synthesizes; it never sends.
    const autoVoice = createAutoVoiceService({ config, speech, root: mediaRoot, log });
    const image = createImageService({ config, ledger, log, run, root: mediaRoot });
    const screen = createScreenService({ config, vision, log, root: PLUGIN_ROOT, frameSource: frameSourceProvider });
    const runtime = createCoordinator({ config, log });
    return { config, configPath: current.source, missing: current.missing, aggregator, vision, speech, autoVoice, image, screen, runtime };
  };
  graph = buildGraph(loaded);

  /** Re-read the config file when it changed; returns the current graph. */
  const refresh = () => {
    const next = fileStamp(configFile);
    if (next !== stamp) {
      const previous = graph.config;
      loaded = loadConfig(companionRoot);
      graph = buildGraph(loaded);
      stamp = next;
      log({
        event: 'config-reloaded',
        capabilities: {
          vision: graph.config.vision.enabled, speech: graph.config.speech.enabled,
          image: graph.config.image.enabled, screen: graph.config.screen.enabled,
        },
        changed: previous ? true : false,
      });
    }
    return graph;
  };

  const requireSession = sessionId => {
    if (!sessionId || typeof sessionId !== 'string') {
      throw Object.assign(new Error('a runtime session is required for media work'), { code: Code.BAD_INPUT });
    }
    return sessionId;
  };

  const service = {
    version: '0.1.0',
    get config() { return refresh().config; },
    get configPath() { return graph.configPath; },
    get missingConfig() { return graph.missing; },
    ledger,
    delivery,
    root: companionRoot,
    dataRoot: mediaRoot,
    refresh,
    host: () => host.describe(),

    status() {
      const current = refresh();
      const config = current.config;
      const deliveryStatus = delivery.status();
      // Computed once: which frame origin is accepted right now, and whether a host
      // frame port is actually wired. Diagnostics must not imply the screen works.
      const screenBase = screenCapabilities(config, { frameSource: frameSourceProvider() });
      // The frame really travels on the vision cloud route (`config.vision.cloud`,
      // see lib/vision.mjs visionRouteFor('screen')), NOT on `screen.cloud`. Saying
      // "sent to <screen.cloud>" would name the wrong destination, so report both and
      // flag it when they differ.
      const screenRoute = current.vision.routeFor?.('screen') ?? null;
      const screenStatus = screenRoute
        ? {
            ...screenBase,
            route: { provider: screenRoute.provider, model: screenRoute.model, from: 'vision.cloud' },
            egress: { ...screenBase.egress, to: `${screenRoute.provider}/${screenRoute.model}` },
            ...(config.screen.cloud.provider !== screenRoute.provider || config.screen.cloud.model !== screenRoute.model
              ? { routeNote: `screen.cloud (${config.screen.cloud.provider}/${config.screen.cloud.model}) is descriptive only; the frame goes to vision.cloud` }
              : {}),
          }
        : screenBase;
      return {
        version: '0.1.0',
        root: companionRoot,
        dataRoot: mediaRoot,
        configPath: current.configPath,
        configMissing: current.missing,
        capabilities: {
          vision: {
            enabled: config.vision.enabled,
            localModel: config.vision.local.model,
            localBaseUrl: config.vision.local.baseUrl,
            cloud: `${config.vision.cloud.provider}/${config.vision.cloud.model}`,
            cacheItems: ledger.cacheSize(),
          },
          speech: {
            enabled: config.speech.enabled,
            baseUrl: config.speech.backend.baseUrl,
            voice: config.speech.backend.voice,
            speed: config.speech.backend.speed,
            cfgScale: config.speech.backend.cfgScale,
            seed: config.speech.backend.seed,
            auto: config.speech.auto.enabled,
            // Additive: the boolean above stays for compatibility; the real clock
            // (last attempt, next eligible moment, failure streak) lives here.
            autoVoice: current.autoVoice.status(),
            director: config.speech.director.enabled,
            // Enabled only means "the layer will synthesize". Delivery is reported separately
            // (`capabilities.delivery`), so a summary cannot turn "no channel wiring" into
            // "the voice is broken".
            deliversToChannel: deliveryStatus.channelWired === true,
          },
          image: {
            enabled: config.image.enabled,
            realGeneration: config.image.allowRealGeneration,
            model: config.image.model,
            flow: config.image.generationFlow,
            quotas: config.image.quotas,
            deliversToChannel: deliveryStatus.channelWired === true,
          },
          screen: screenStatus,
          // Delivery is the only place that can prove arrival. `channelWired` is computed from
          // the injected channel, never assumed: a real mode without a channel is a fault, and a
          // mock mode is "plans only", not "delivery is broken".
          delivery: delivery.status(),
        },
        // One-line facts a model can quote without re-interpreting flags.
        facts: [
          `识图：${config.vision.enabled ? '开' : '关'}（普通图走本地 ${config.vision.local.model}，表情/屏幕走云 ${config.vision.cloud.model}）`,
          `语音：${config.speech.enabled ? '能合成' : '关'}；合成产物是本地 WAV，本层不负责发到 QQ`,
          `生图：${config.image.enabled ? (config.image.allowRealGeneration ? '可真生成' : '仅 dry-run（未开真实生成）') : '关'}`,
          `屏幕：${screenStatus.enabled ? '开' : '关'}（mode=${screenStatus.mode}，本轮接受=${screenStatus.accepts}，帧来源=${screenStatus.frameSource.present ? screenStatus.frameSource.name : '未接线 frame-source-unavailable'}）；本层从不截图；帧会整帧送云 ${screenStatus.egress.to}`,
          `发送：${deliveryStatus.channelWired ? `通道已接线（${deliveryStatus.mode}）` : `通道未接线（mode=${deliveryStatus.mode}，只出计划不发送）`}`,
        ],
        host: host.describe(),
        ledger: ledger.summary(),
        jobs: ledger.listJobs(5).map(job => ({ jobId: job.jobId, capability: job.capability, state: job.state, createdAt: job.createdAt, error: job.error?.code })),
        artifacts: ledger.listArtifacts(5).map(item => ({ artifactId: item.artifactId, kind: item.kind, origin: item.origin, bytes: item.bytes, durationSeconds: item.durationSeconds })),
        config: sanitizedConfig(config),
      };
    },

    async inspectImage({ source, path: candidate, bytes, filename, kind, prompt, sessionId, capturedAt, screenFrame = false, expectedSessionId } = {}) {
      const current = refresh();
      const config = current.config;
      current.runtime.touch();
      try {
        if (!config.vision.enabled) return { ok: false, error: { code: Code.DISABLED, message: 'vision is disabled' } };
        requireSession(sessionId);
        const owner = readOwner(companionRoot);
        if (!owner) return { ok: false, error: { code: Code.BAD_INPUT, message: 'companion identity is not configured' } };
        let payload = bytes;
        let name = filename ?? '';
        if (!payload && candidate) {
          const read = readAllowedSource(companionRoot, candidate);
          payload = read.bytes;
          name = name || read.filename;
        }
        if (!payload?.length) return { ok: false, error: { code: Code.BAD_INPUT, message: 'media bytes are required' } };

        if (screenFrame) {
          // The screen kill switch gates this path too. Before, a caller that set
          // `screenFrame: true` still reached the cloud image route while
          // `screen.enabled` was false — the frame left the machine with the
          // switch visibly off.
          if (!config.screen.enabled) return { ok: false, error: { code: Code.DISABLED, message: 'screen input is disabled' } };
          if (!capturedAt) return { ok: false, error: { code: Code.STALE_FRAME, message: 'a screen frame needs its capture time' } };
          const verdict = evaluateFrame({
            capturedAt,
            frameSessionId: undefined,
            expectedSessionId: expectedSessionId ?? sessionId,
            maxAgeSeconds: config.screen.maxAgeSeconds,
          });
          if (!verdict.usable) return { ok: false, error: { code: verdict.code, message: verdict.reason } };
          const media = normalizeMediaInput({ bytes: payload, filename: `screen_${name || 'frame.png'}`, kindHint: 'screen', capturedAt }, { limits: config.limits, sessionId, owner, source: 'screen' });
          const relative = writeManaged(mediaRoot, `${MANAGED_DIR}/inbox/screen`, payload, `${media.sha256.slice(0, 16)}-${name || 'frame.png'}`);
          // One inspection path for every origin: this goes through the screen
          // service, so the same freshness/session/audit rules apply.
          return current.screen.inspect({
            frame: { ...media, bytes: payload, mime: media.mime, format: media.format, capturedAt, ref: relative },
            sessionId,
            expectedSessionId: expectedSessionId ?? sessionId,
            prompt: prompt ?? config.screen.prompt,
            origin: 'external',
          });
        }

        const media = normalizeMediaInput({ bytes: payload, filename: name, kindHint: kind, capturedAt }, { limits: config.limits, sessionId, owner, source: source ?? 'desktop' });
        const relative = writeManaged(mediaRoot, `${MANAGED_DIR}/inbox`, payload, `${media.sha256.slice(0, 16)}-${name || 'image.png'}`);
        return current.vision.inspect({ media: { ...media, ref: relative }, bytes: payload, prompt });
      } catch (error) {
        return { ok: false, error: toFailure(error) };
      }
    },

    async speak({ text, emotion, instructions, context, sessionId } = {}) {
      const current = refresh();
      try {
        requireSession(sessionId);
        current.runtime.touch();
        return withArtifactLocation(await current.speech.synthesize({ text, emotion, instructions, context, sessionId }), {
          tool: 'qq_voice', action: 'send_file',
        });
      } catch (error) {
        return { ok: false, error: toFailure(error) };
      }
    },

    /**
     * Auto voice for one finished reply: probability + interval decide, the local Breeze
     * backend synthesizes, and the result carries a `voice_only` plan.
     *
     * `delivered` is always false — the channel still has to send and confirm, and this layer
     * refuses to pretend otherwise. A failed synthesis returns `spoke:false`; it never degrades
     * into "send the text instead", because that would be a different message than the one the
     * decision authorised.
     */
    async autoSpeak(options = {}) {
      const current = refresh();
      try {
        requireSession(options?.sessionId);
        current.runtime.touch();
        return withArtifactLocation(await current.autoVoice.maybeSpeak(options), {
          tool: 'qq_voice', action: 'send_file',
        });
      } catch (error) {
        return { ok: false, spoke: false, error: toFailure(error) };
      }
    },

    async draw(options = {}) {
      const current = refresh();
      try {
        if (!current.config.image.enabled) return { ok: false, error: { code: Code.DISABLED, message: 'image generation is disabled' } };
        const request = { ...options };
        let translation = null;
        if (current.config.image.translatePrompt?.enabled !== false) {
          translation = await translateImagePrompt({
            host, request: request.prompt, style: request.style, config: current.config, log,
          });
          if (translation.translated) {
            request.prompt = translation.prompt;
            request.style = translation.style;
          }
        }
        // The wardrobe is the authority on clothes. An explicit `outfit` argument
        // wins (the user asked for a change); otherwise today's real outfit is
        // appended, because leaving it to the model produced invented clothing.
        let outfitInfo = null;
        const explicitOutfit = typeof request.outfit === 'string' ? request.outfit.trim() : '';
        if (explicitOutfit) {
          outfitInfo = { source: 'parameter', clause: explicitOutfit, injected: true };
        } else {
          const resolved = await resolveOutfit({ root: companionRoot, prompt: request.prompt });
          if (resolved?.ok) {
            outfitInfo = resolved;
            if (resolved.injected) request.outfit = resolved.clause;
          } else {
            outfitInfo = { source: 'none', clause: '', injected: false, reason: resolved?.reason ?? 'unavailable' };
            log({ event: 'image.outfit.unavailable', reason: outfitInfo.reason });
          }
        }
        let tagComposition = null;
        if (request.composeTags) {
          tagComposition = await composeImageTags({
            host, request: request.prompt, context: request.context ?? '', config: current.config, log,
          });
          request.prompt = tagComposition.tag;
          if (!request.negative && tagComposition.negative) request.negative = tagComposition.negative;
        }
        const result = await current.image.generate(request);
        const located = withArtifactLocation(result, { tool: 'qq_sticker', action: 'send' });
        return {
          ...located,
          ...(tagComposition ? { tagComposition: { composed: tagComposition.composed, reason: tagComposition.reason } } : {}),
          // Surface the hop: a Chinese prompt is translated before encoding, and a
          // failure to translate must not look like the prompt was used as-is.
          ...(translation ? { promptTranslation: { translated: translation.translated, reason: translation.reason } } : {}),
          // Which clothes actually went into the caption, and where they came from.
          ...(outfitInfo ? { outfit: { source: outfitInfo.source, injected: outfitInfo.injected, items: outfitInfo.items ?? [], date: outfitInfo.date ?? null, reason: outfitInfo.reason ?? null, clause: outfitInfo.clause ?? '' } } : {}),
        };
      } catch (error) {
        return { ok: false, error: toFailure(error) };
      }
    },

    /**
     * Inspect a screen frame. Three origins, and the config decides which one is
     * allowed (`screen.mode`):
     *   fixture name given  → `test/fixtures/screen/<name>`, mode must not be 'live'
     *   no fixture, live    → ask the injected host frame port, mode must be 'live'
     *   (external bytes)    → `inspectImage({ screenFrame: true })`, see above
     * Absent port or wrong mode is a typed refusal, never a fabricated frame.
     */
    async screenInspect({ fixture, sessionId, capturedAt, prompt, expectedSessionId } = {}) {
      const current = refresh();
      const config = current.config;
      current.runtime.touch();
      try {
        if (!config.screen.enabled) return { ok: false, error: { code: Code.DISABLED, message: 'screen input is disabled' } };
        requireSession(sessionId);
        const owner = readOwner(companionRoot);
        if (!owner) return { ok: false, error: { code: Code.BAD_INPUT, message: 'companion identity is not configured' } };

        if (!fixture) {
          // Live path: the host owns capture. A missing port answers
          // `MEDIA_DISABLED` / `frame-source-unavailable`, and nothing is sent.
          // `accept` normalizes the delivered frame here, so size/type limits, the
          // owner and the managed copy use exactly the same rules as every other
          // media input. The host's own filename is deliberately dropped: the
          // managed copy is named from the content digest, so a private file name
          // never reaches the ledger, the log or the cloud request.
          return await current.screen.capture({
            sessionId,
            expectedSessionId: expectedSessionId ?? sessionId,
            prompt,
            accept: frame => {
              const media = normalizeMediaInput(
                { bytes: frame.bytes, filename: 'screen_frame.png', kindHint: 'screen', capturedAt: frame.capturedAt },
                { limits: config.limits, sessionId, owner, source: 'screen' },
              );
              const relative = writeManaged(mediaRoot, `${MANAGED_DIR}/inbox/screen`, frame.bytes, `${media.sha256.slice(0, 16)}-frame.png`);
              return {
                bytes: frame.bytes,
                mime: media.mime,
                format: media.format,
                sha256: media.sha256,
                capturedAt: frame.capturedAt,
                sessionId: frame.sessionId,
                owner: media.owner,
                ref: relative,
              };
            },
          });
        }

        if (config.screen.mode === MODE_LIVE) {
          return {
            ok: false,
            error: { code: Code.DISABLED, reason: 'mode-live', message: "screen.mode is 'live'; fixture frames are refused while live capture is selected" },
          };
        }
        if (!capturedAt) return { ok: false, error: { code: Code.STALE_FRAME, message: 'a screen frame needs its capture time' } };
        const frame = readScreenFixture(PLUGIN_ROOT, fixture);
        const verdict = evaluateFrame({ capturedAt, expectedSessionId: expectedSessionId ?? sessionId, maxAgeSeconds: config.screen.maxAgeSeconds });
        if (!verdict.usable) return { ok: false, error: { code: verdict.code, message: verdict.reason } };
        const media = normalizeMediaInput(
          { bytes: frame.bytes, filename: `screen_${fixture}`, kindHint: 'screen', capturedAt },
          { limits: config.limits, sessionId, owner, source: 'screen' },
        );
        const relative = writeManaged(mediaRoot, `${MANAGED_DIR}/inbox/screen`, frame.bytes, `${media.sha256.slice(0, 16)}-${path.basename(fixture)}`);
        return await current.screen.inspect({
          frame: { ...media, bytes: frame.bytes, mime: frame.mime, format: frame.format, capturedAt, ref: relative },
          sessionId,
          expectedSessionId: expectedSessionId ?? sessionId,
          prompt: prompt ?? config.screen.prompt,
          origin: 'fixture',
        });
      } catch (error) {
        return { ok: false, error: toFailure(error) };
      }
    },

    plan(options) {
      const config = refresh().config;
      return planDelivery({ ...options, order: config.delivery.order, mode: config.delivery.mode });
    },
    recordDelivery(options) { return delivery.record(options); },
    /**
     * Real delivery (CONTRACT §5 `desktop`/`onebot`): execute the ordered plan through the
     * injected channel, one receipt per step, stop at the first non-confirmation.
     *
     * Refusals are typed, never optimistic: `delivery-mock` (this deployment plans only) and
     * `channel-unavailable` (no channel wired). A caller must not read `ok:true` from `plan()`
     * as "it was sent" — only this method's `state === 'confirmed'` with a
     * `platformMessageId` is delivery.
     */
    async deliver(options = {}) {
      const config = refresh().config;
      try {
        return await delivery.deliver({ ...options, order: config.delivery.order });
      } catch (error) {
        return { ok: false, code: error?.code ?? 'deliver-failed', steps: [], receipts: [], message: String(error?.message ?? error) };
      }
    },
    /**
     * Drive the shared GPU coordinator: warm one backend, release everything, or
     * report state. Warming sends the smallest real request so the weights are
     * genuinely resident; the coordinator still refuses to run both backends at
     * once, and this layer serialises its own calls on top of that.
     */
    async warm({ target } = {}) {
      const current = refresh();
      try {
        if (target === 'vision' && !current.config.vision.enabled) {
          return { ok: false, error: { code: Code.DISABLED, message: 'vision is disabled' } };
        }
        if (target === 'voice' && !current.config.speech.enabled) {
          return { ok: false, error: { code: Code.DISABLED, message: 'speech is disabled' } };
        }
        return await current.runtime.warm({ target });
      } catch (error) {
        return { ok: false, error: toFailure(error) };
      }
    },
    async releaseWeights() {
      const current = refresh();
      try {
        return await current.runtime.release();
      } catch (error) {
        return { ok: false, error: toFailure(error) };
      }
    },
    async runtimeStatus() {
      const current = refresh();
      try {
        return await current.runtime.status();
      } catch (error) {
        return { ok: false, error: toFailure(error) };
      }
    },
    getJob(jobId) { return ledger.getJob(jobId); },
    cancelJob(jobId) {
      const job = ledger.getJob(jobId);
      if (!job) return { ok: false, error: { code: Code.NOT_FOUND, message: 'no such job' } };
      if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return { ok: true, job };
      const updated = ledger.updateJob(jobId, { cancelRequested: true, state: job.state === 'running' ? 'running' : 'cancelled' });
      return { ok: true, job: updated };
    },
  };

  // Contract names (CONTRACT.md §4) mapped onto the shorter internal verbs.
  service.synthesizeSpeech = options => service.speak(options);
  service.generateImage = options => service.draw(options);
  service.prepareDelivery = options => service.plan(options);

  return shareMedia(companionRoot, service);
}

function registerTools(ctx, service) {
  const register = (toolName, description, parameters, execute, kind = 'read') => {
    const definition = {
      name: toolName,
      description,
      parameters,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (args, exec) => JSON.stringify(await execute(args ?? {}, exec)),
      presentCall: () => ({ card: 'generic', title: toolName, kind }),
    };
    const tool = typeof defineTool === 'function' ? defineTool(definition) : definition;
    // Never hand a bare property map to the registry: without a compiled
    // `{type:'object', properties, required}` the provider rejects every request
    // that lists this tool.
    if (typeof defineTool !== 'function') tool.parameters = parametersToJsonSchema(parameters);
    ctx.tools.register(tool);
  };

  const sessionOf = exec => exec?.agent?.session?.id;

  register('companion_media_status',
    'Read the media layer status: which capabilities are on, the configured backends, quotas, the ledger counts and the last few jobs. Contains no picture description and no credential. Configuration changes on disk are picked up on the next call.',
    {}, async () => service.status());

  register('companion_media_inspect',
    'Inspect one picture through the shared vision layer. Ordinary pictures stay on the local model; stickers and screen frames use the image-capable cloud route. Accepts a path inside home/media/inbox (relative to the companion root) or a fixture under plugins/companion-media/test/fixtures (for example test/fixtures/vision/sample-a.png). Screen frames: with screen=true and no path, the host frame source is asked for a live frame, and the answer is MEDIA_DISABLED plus reason=frame-source-unavailable when this build has no frame source wired (this layer never captures the screen). With screen=true and a fixture name, only the fixture demo runs, and screen.mode must not be live. A frame is refused when it is stale, has no capture time, or belongs to another session. Never guesses content when the model fails.',
    {
      path: { type: 'string', description: 'Path inside home/media/inbox (relative to the companion root) or a screen fixture name. Omit with screen=true to ask the host frame source for a live frame.' },
      screen: { type: 'boolean', description: 'Treat the input as a screen frame: the cloud route is used and the frame must carry a fresh capture time.' },
      kind: { type: 'string', enum: ['image', 'sticker'], description: 'Explicit kind when the file name cannot tell.' },
      prompt: { type: 'string', description: 'Optional extra instruction for this inspection.' },
      capturedAt: { type: 'string', description: 'ISO capture time for a screen frame you supply yourself; required to prove the frame is fresh. Ignored for host-delivered frames, whose capture time comes from the host.' },
    },
    async (args, exec) => {
      const sessionId = sessionOf(exec);
      if (args.screen) return service.screenInspect({ fixture: args.path, sessionId, capturedAt: args.capturedAt, prompt: args.prompt });
      return service.inspectImage({
        path: args.path, kind: args.kind, prompt: args.prompt, sessionId,
        capturedAt: args.capturedAt,
      });
    });

  register('companion_media_speak',
    '用 Breeze TTS 2 将台词合成为语音，适用于语音回复、朗读或角色对白。采用官方 Voice Direction 用法：保留已配置参考音色，用自然语言指导本句的语气、情绪、节奏和表达方式。text 只放实际要说的台词；instructions 单独描述怎样说，例如“像在安慰对方，声音轻柔，前半句平稳，最后一句稍作停顿后认真说完”。只表达笑意时写进 instructions；确实需要发出声音才在 text 中加入中文 [笑]/[咳嗽]/[清嗓子]/[叹气] 或英文 (laugh)/(cough)/(clears throat)/(sigh)。有 instructions 时直接使用；省略时由语音导演结合 context 指导，失败则按原台词和情绪预设合成。返回 artifact.absolutePath 与 handoff.file（都已是绝对路径，无需自己拼接），生成不代表发送；发 QQ 语音直接把 handoff.file 传给 qq_voice action=send_file，并按当前会话填写 isGroup 和 target。',
    {
      text: { type: 'string', required: true, description: '要实际朗读的完整台词，保留原意与标点，不放表演说明、Markdown 或 JSON。按需要使用官方声音事件，例如“[笑] 这次真的成功啦。”；[开心] 等已识别情绪标签只会被本地程序移除并选用预设，不是官方声音事件。' },
      emotion: { type: 'string', description: '可选的本地情绪预设：自然、开心、委屈、生气；默认自然。这是本地快捷选项，细致表演请用 instructions 的自然语言描述。' },
      instructions: { type: 'string', description: '可选的自然语言表演指令，填写后跳过语音导演。像指导配音演员一样简洁描述本句语气、情绪、语速、停顿或重音；与台词语言一致，保持参考音色，不重新设计说话人，不改写台词。不填写模型/CFG/seed 等参数。耳语示例：“像靠近对方轻声说悄悄话，音量轻柔，吐字清楚，短句间留一点空隙。”' },
      context: { type: 'string', description: '可选的简短对话背景，供语音导演理解说话意图、对象和情绪；不会作为台词朗读。已有明确 instructions 时可省略。' },
    },
    async (args, exec) => service.speak({ ...args, sessionId: sessionOf(exec) }), 'write');

  register('companion_media_draw',
    '通过独立 NovelAI 管线生成一张图片，默认模型为 V5 full，适用于画图、自拍、换装、场景或表情图请求。**prompt 必须直接写成英文**（NovelAI 的 caption 只按英文训练，中文进去等于噪声；工具内的翻译只是兜底，不要把写中文再指望翻译当成用法），用英文自然语言完整句子，不要求拼 Danbooru 标签或权重语法；英文写不出的细节就用最直白的词描述可见元素，不要退回中文。角色一致性约束：当用户说“你”“自拍”“给我看看你”或要求三月七的换装、生活照、表情图时，主体必须是《崩坏：星穹铁道》的三月七，英文写作 "March 7th from Honkai: Star Rail, pink hair, blue-to-pink gradient eyes"，不能只写 "a girl"，也不能把眼睛简化成纯蓝色。外貌以当前 PERSONA.md 为准，发型与配饰细节承接本轮已确认的状态；**衣着不由你写**——工具会自动把衣柜变量里今天真实穿的那套（含鞋与配饰）补进 caption，所以 prompt 里只写场景、动作、表情、镜头、光线和画风，**不要描述衣服**，否则会和衣柜打架；只有用户明确要求换装时才用 `outfit` 参数写这套新衣，并先调 `companion_outfit_set` 更新衣柜。日常默认休闲可爱、脖子挂拍立得（casual cute outfit, Polaroid camera hanging around her neck），仙舟剑术造型才用汉服与双剑。连续图片保留未被修改的外貌、衣着与场景细节；当前台词的情绪落实为可见表情，不把性格或身世大段抄进画面描述。只画风景、物品或用户明确指定的其他角色时，不强行加入三月七；多人时把三月七与其他人的外貌、动作、位置分开写清。把最重要的主体与画面要求放在最前面，再具体描述外貌、服装、动作、人物关系与位置、场景、景别/视角、光线和画风；只写本张图需要的细节，避免重复或互相矛盾。默认省略 composeTags（或设 false），英文自然语言直接传入生图后端；只有明确需要现有标签转换流程时才设 true。配置未开启真实生成时只返回 dry-run，不能宣称图片已生成。真实生成成功返回 artifact.absolutePath 与 handoff.file（都已是绝对路径），本工具不发送；需要发 QQ 时把 handoff.file 交给当前会话对应的通道图片发送工具。额度 -1 为不限、0 为禁用；超时或结果未知时先查 companion_media_job，不盲目重试。发到 QQ 的图片段具体用 qq_sticker action=send（file 传绝对路径，isGroup=false，target=QQ 号）：它发的是原生 image 段，对方看到的是照片；qq_file action=send_private 是文件上传，对方收到的是附件，看起来像文件而不是照片。',
    {
      prompt: { type: 'string', required: true, description: '英文画面描述，必须是英文（NovelAI 只读英文 caption），用完整句子，主体和关键要求在前。**只写场景、动作、表情、镜头、光线、画风，不要写衣服**——衣着由衣柜变量自动补进 caption（见 outfit 参数）。说明可见内容及构图，不写聊天回复或生成过程。例如："March 7th from Honkai: Star Rail, pink hair, blue-to-pink gradient eyes, sitting by the train window at dusk and smiling at the camera. Eye-level half-body shot, snowy mountains outside, warm carriage light on her face, delicate anime illustration style." 多人时写清每人的外貌、动作与相对位置；不要用一串逗号标签代替句子；不要写中文。' },
      source: { type: 'string', enum: ['user_request', 'selfie', 'outfit', 'scene', 'sticker', 'proactive', 'natural_language'], description: '图片用途，用于额度归类：普通用户请求 user_request、自拍 selfie、换装 outfit、场景 scene、表情 sticker、主动配图 proactive；默认 user_request。natural_language 是额度类别，不是切换提示词格式的开关；所有类别的 prompt 都用英文自然语言。' },
      style: { type: 'string', description: '可选的补充画风描述，同样用英文，例如 "soft watercolor illustration, visible paper texture"；通常直接写进 prompt 即可，避免重复或冲突。' },
      outfit: { type: 'string', description: '可选。留空最省事：工具会自动把衣柜里今天真实穿的那套（含鞋和配饰）补进 caption，不会让模型自己编衣服。只有当用户明确要求换装、或本次就是特殊造型（如仙舟剑术造型的汉服双剑）时，才用英文在这里写这套衣服；同时应先调 companion_outfit_set 更新衣柜，避免下次出图又回到旧衣服。' },
      composeTags: { type: 'boolean', description: '默认省略或 false：英文自然语言 prompt 直接提交后端。仅明确需要标签转换时设 true，由独立模型将英文自然语言转成 NovelAI 标签；转换失败回退原 prompt。无论此值如何，调用方都用英文自然语言写 prompt。' },
      context: { type: 'string', description: '仅在 composeTags=true 时供标签转换模型理解的简短对话背景，可写中文。默认直传时不读取此字段，必须把本张图所需的角色外貌、服装和场景信息用英文写进 prompt。' },
      dryRun: { type: 'boolean', description: 'true 只编码并校验生图参数，不调用 NovelAI 生成；false 仍受真实生成配置开关限制。dry-run 成功不代表已产出图片。' },
    },
    async (args, exec) => service.draw({ ...args, sessionId: sessionOf(exec) }), 'write');

  register('companion_media_warm',
    '按需拉起或卸载本地 GPU 后端（语音 / 识图共用一台显卡，不能同时加载）。action=warm 会向 8139 协调器发一个最小真实请求把权重真正读进显存，返回耗时与切换来源；action=release 立即释放，包括内存里的模型；action=status 只读，返回当前 active、是否 busy、距离空闲自动卸载还有多少秒。默认空闲 300 秒自动卸载，任何识图/语音调用都会重置倒计时。同一时刻只允许一个后端：先加载 A 再加载 B 会自动切走 A，但两个请求不会并行；已有加载进行中时再调会返回 MEDIA_BACKEND_BUSY。',
    {
      action: { type: 'string', enum: ['warm', 'release', 'status'], description: 'warm=拉起并预热，release=立即卸载，status=只读查看；默认 warm。' },
      target: { type: 'string', enum: ['voice', 'vision'], description: 'warm 时必填：voice=本地 Breeze 语音，vision=本地识图模型（屏幕帧也走这条）。' },
    },
    async (args) => {
      const action = args.action ?? 'warm';
      if (action === 'status') return service.runtimeStatus();
      if (action === 'release') return service.releaseWeights();
      return service.warm({ target: args.target });
    }, 'write');

  register('companion_media_job',
    'Read media jobs, generated artifacts and delivery receipts. Delivery receipts say what the channel actually reported: an absent confirmation stays unknown.',
    { jobId: { type: 'string' }, limit: { type: 'integer' } },
    async args => ({
      job: args.jobId ? service.getJob(args.jobId) : undefined,
      jobs: service.ledger.listJobs(args.limit ?? 10),
      artifacts: service.ledger.listArtifacts(args.limit ?? 10),
      receipts: service.ledger.listReceipts(args.limit ?? 10),
    }));
}

export function apply(ctx) {
  try {
    const service = mountMedia(ctx);
    registerTools(ctx, service);
    appendJsonl(path.join(COMPANION_ROOT, 'logs/media-migration/media-events.jsonl'), {
      at: new Date().toISOString(),
      event: 'mounted',
      // The pid distinguishes the desktop host from a local mount-check script,
      // which otherwise look identical in this log.
      pid: process.pid,
      capabilities: {
        vision: service.config.vision.enabled,
        speech: service.config.speech.enabled,
        image: service.config.image.enabled,
        screen: service.config.screen.enabled,
      },
    });
    return service;
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    appendJsonl(path.join(COMPANION_ROOT, 'logs/media-migration/media-events.jsonl'), { at: new Date().toISOString(), event: 'mount-failed', message: message.slice(0, 400) });
    return { error: message };
  }
}
