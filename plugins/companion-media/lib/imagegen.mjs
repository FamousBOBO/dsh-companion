import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Code, mediaError, toFailure } from './errors.mjs';
import { dayKey, sha256Hex, stableJson } from './ids.mjs';
import { runProcess } from './exec.mjs';
import { managedPath } from './paths.mjs';

// The bridge always lives next to this package, never under the caller's data
// root: deriving it from `root` silently pointed at a directory that does not
// exist and turned every request into "no JSON".
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// NovelAI generation through the independent image_pipeline.
//
// The request encoder, the Opus-free size rules, the cloud-queue handshake and
// the V5 tag presets all stay in that package; this module owns what the
// companion adds: provenance, quotas, idempotency, refunds and the rule that a
// timeout is `unknown` rather than "try again and pay twice".
//
// Review round 1 fixed three accounting defects:
//   1. a caller-supplied scope could select an unknown bucket, and `quotaFor`
//      returned -1 for unknown buckets — one free string bypassed every quota;
//   2. a timeout refunded the quota even though the remote may have produced and
//      billed the picture, while the reply said `refunded: false`;
//   3. a retry after a failure ignored the stored job and kept writing to a job
//      id that was never recorded.

export const BRIDGE_RELATIVE_PATH = 'bridge/nai_generate.py';

export const QUOTA_SCOPES = Object.freeze(['private_owner', 'private_friend', 'group', 'proactive', 'natural_language']);

const SOURCE_TO_SCOPE = Object.freeze({
  user_request: 'private_owner',
  selfie: 'private_owner',
  outfit: 'private_owner',
  scene: 'private_owner',
  sticker: 'private_owner',
  proactive: 'proactive',
  natural_language: 'natural_language',
});

/**
 * Resolve the quota scope from trusted request attributes only.
 * An unknown source or scope is refused instead of silently becoming unlimited.
 */
export function resolveQuotaScope({ source = 'user_request', scope } = {}, knownScopes = QUOTA_SCOPES) {
  if (scope !== undefined && scope !== null && scope !== '') {
    if (!knownScopes.includes(scope)) throw mediaError(Code.BAD_INPUT, `unknown quota scope: ${scope}`);
    return scope;
  }
  const mapped = SOURCE_TO_SCOPE[source];
  if (!mapped) throw mediaError(Code.BAD_INPUT, `unknown image source: ${source}`);
  if (!knownScopes.includes(mapped)) throw mediaError(Code.BAD_INPUT, `source ${source} maps to an unknown scope`);
  return mapped;
}

/** `-1` unlimited, `0` disabled; anything else is a daily cap. Unknown scopes are refused. */
export function quotaFor(config, scope, knownScopes = QUOTA_SCOPES) {
  if (!knownScopes.includes(scope)) throw mediaError(Code.BAD_INPUT, `unknown quota scope: ${scope}`);
  const value = config.image.quotas?.[scope];
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return value;
}

export function buildImageParams({ prompt, negative = '', style = '', extraPrompt = '', outfit = '', size, steps, seed, scale, straightAlpha = false, model, sampler, noiseSchedule } = {}, config) {
  // Style composition mirrors the old request path:
  //   tag      = defaultPrompt + ", " + caller prompt (+ style/extra)
  //   negative = defaultNegative + ", " + caller negative
  //   artist   = rendered by the encoder as the caption prefix
  const styleConfig = config.image.style ?? {};
  const applies = styleConfig.applyDefaults !== false;
  const artist = applies ? String(styleConfig.artist ?? '').trim() : '';
  const presetTag = applies ? String(styleConfig.defaultPrompt ?? '').trim() : '';
  const presetNegative = applies ? String(styleConfig.defaultNegative ?? '').trim() : '';

  const tagParts = [presetTag, String(prompt ?? '').trim()];
  // The wardrobe is a real variable, not a suggestion: keep it next to the prompt
  // so the picture cannot drift to invented clothes.
  if (outfit && outfit.trim()) tagParts.push(`wearing ${outfit.trim()}`);
  if (style && style.trim()) tagParts.push(`(${style.trim()})`);
  if (extraPrompt && extraPrompt.trim()) tagParts.push(extraPrompt.trim());
  const tag = tagParts.filter(Boolean).join(', ');
  if (!String(prompt ?? '').trim()) throw mediaError(Code.BAD_INPUT, 'image prompt is empty');
  const params = {
    model: model ?? config.image.model,
    tag,
    size: size ?? config.image.size,
    steps: Number(steps ?? config.image.steps),
    scale: Number(scale ?? config.image.scale),
  };
  if (artist) params.artist = artist;
  const negativeParts = [presetNegative, negative.trim()].filter(Boolean);
  if (negativeParts.length) params.negative = negativeParts.join(', ');
  if (Number.isFinite(Number(seed)) && Number(seed) >= 0) params.seed = Number(seed);
  if (sampler) params.sampler = sampler;
  if (noiseSchedule) params.noise_schedule = noiseSchedule;
  if (straightAlpha) params.straight_alpha = true;
  return params;
}

/**
 * Build the JSON the bridge consumes. Kept separate so a dry-run and a real
 * request provably share one encoder path.
 */
export function buildBridgeRequest({ mode, params, config, out, timeoutSeconds }) {
  return {
    mode,
    imagePipelineRoot: config.image.imagePipelineRoot,
    configPath: config.image.configPath,
    params,
    // Always ask for the effective caption: the wardrobe and the quality preset are
    // injected by this layer, so the caller cannot otherwise see what NovelAI got.
    dumpCaption: config.image.returnCaption !== false,
    // The queue settings travel with every request so the media layer owns them;
    // the bridge applies them in memory and never rewrites the old AstrBot config.
    queue: config.image.queue,
    ...(out ? { out } : {}),
    ...(timeoutSeconds ? { timeoutSeconds } : {}),
  };
}

/** Codes that prove the request never reached the generator, so a refund is honest. */
const PRE_FLIGHT_CODES = new Set([Code.BAD_INPUT, Code.DISABLED, Code.QUOTA_DENIED, Code.QUOTA_EXHAUSTED]);

export function createImageService({
  config,
  ledger,
  log = () => {},
  run = runProcess,
  root,
  bridgePath,
  now = () => new Date().toISOString(),
} = {}) {
  const script = bridgePath ?? path.join(PLUGIN_ROOT, BRIDGE_RELATIVE_PATH);
  const inFlight = new Map();

  async function invoke(request, timeoutMs) {
    const python = config.image.pythonPath || 'python';
    const result = await run(python, [script], {
      input: Buffer.from(JSON.stringify(request), 'utf8'),
      timeoutMs: timeoutMs ?? config.image.timeoutMs,
    });
    if (result?.timedOut) {
      // The child was killed while the upstream may already be generating; the
      // outcome is unknown and must not be refunded or retried automatically.
      throw mediaError(Code.TIMEOUT, `image bridge exceeded ${timeoutMs ?? config.image.timeoutMs} ms; result unknown`);
    }
    const stdout = String(result.stdout ?? '').trim();
    const lastLine = stdout.split('\n').filter(Boolean).pop();
    if (!lastLine) {
      throw mediaError(Code.UNKNOWN_RESULT, `image bridge produced no output (exit ${result.code}): ${String(result.stderr ?? '').slice(0, 300)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      throw mediaError(Code.UNKNOWN_RESULT, `image bridge returned unparsable output: ${lastLine.slice(0, 200)}`);
    }
    return parsed;
  }

  async function preview({ prompt, source = 'user_request', channel, scope, style, negative, size, steps, seed, straightAlpha, outfit = '', extraPrompt = '' } = {}) {
    if (!config.image.enabled) return { ok: false, error: { code: Code.DISABLED, message: 'image generation is disabled' } };
    try {
      const quotaScope = resolveQuotaScope({ source, scope });
      const params = buildImageParams({ prompt, style, negative, extraPrompt, outfit, size, steps, seed, straightAlpha }, config);
      const response = await invoke(buildBridgeRequest({ mode: 'dry-run', params, config }), 60_000);
      if (!response.ok) return { ok: false, error: response.error ?? { code: Code.BACKEND_FAILED, message: 'dry-run failed' } };
      return {
        ok: true,
        dryRun: true,
        paramsDigest: response.paramsDigest,
        summary: response.summary,
        caption: response.caption ?? null,
        quota: { scope: quotaScope, limit: quotaFor(config, quotaScope), used: ledger.quotaUsed({ scope: quotaScope }) },
      };
    } catch (error) {
      return { ok: false, error: toFailure(error) };
    }
  }

  async function generate({
    prompt, source = 'user_request', channel, scope, style, negative, size, steps, seed,
    straightAlpha = false, idempotencyKey, dryRun = false, sessionId, date = dayKey(),
    // `outfit` is the wardrobe clause from index.mjs draw(). It used to be dropped
    // right here, which is why captions never carried clothes even though the
    // resolver reported success — keep it in every path below.
    outfit = '', extraPrompt = '',
  } = {}) {
    if (!config.image.enabled) return { ok: false, error: { code: Code.DISABLED, message: 'image generation is disabled' } };
    if (dryRun) return preview({ prompt, source, scope, style, negative, size, steps, seed, straightAlpha, outfit, extraPrompt });
    if (!config.image.allowRealGeneration) {
      const previewResult = await preview({ prompt, source, scope, style, negative, size, steps, seed, straightAlpha, outfit, extraPrompt });
      return { ...previewResult, realGeneration: false, error: previewResult.ok ? undefined : previewResult.error, note: 'allowRealGeneration is off; only a dry-run was produced' };
    }

    let params;
    let quotaScope;
    try {
      quotaScope = resolveQuotaScope({ source, scope });
      params = buildImageParams({ prompt, style, negative, extraPrompt, outfit, size, steps, seed, straightAlpha }, config);
    } catch (error) {
      return { ok: false, error: toFailure(error) };
    }
    const paramsDigest = sha256Hex(Buffer.from(stableJson(params)));
    const key = idempotencyKey ?? `image:${paramsDigest}`;

    // One request per key at a time; a concurrent duplicate waits for the result
    // instead of paying for a second generation.
    if (inFlight.has(key)) {
      const shared = await inFlight.get(key);
      return { ...shared, concurrent: true };
    }

    const limit = quotaFor(config, quotaScope);
    const existing = ledger.findJobByIdempotencyKey(key);
    if (existing) {
      if (existing.state === 'succeeded' && existing.artifactId) {
        const artifact = ledger.getArtifact(existing.artifactId);
        if (artifact) return { ok: true, artifact, replay: true, paramsDigest, quota: { scope: quotaScope, limit } };
      }
      if (existing.state === 'running' || existing.state === 'unknown') {
        return {
          ok: false,
          error: { code: Code.UNKNOWN_RESULT, message: `an earlier request with this key is ${existing.state}; it will not be replayed automatically` },
          paramsDigest,
          jobId: existing.jobId,
        };
      }
      // failed / cancelled: a retry is legitimate, but it must extend the same job
      // so the ledger keeps one history for one idempotency key.
      ledger.updateJob(existing.jobId, { state: 'running', attempts: (existing.attempts ?? 1) + 1, error: undefined, updatedAt: now() });
      const retried = runGeneration({ jobId: existing.jobId, key, params, paramsDigest, quotaScope, limit, date, source, sessionId });
      inFlight.set(key, retried);
      try {
        return await retried;
      } finally {
        inFlight.delete(key);
      }
    }

    const quota = ledger.consumeQuota({ scope: quotaScope, limit, date });
    if (!quota.allowed) {
      return {
        ok: false,
        error: { code: quota.reason === 'disabled' ? Code.QUOTA_DENIED : Code.QUOTA_EXHAUSTED, message: `quota for ${quotaScope} is ${quota.reason}` },
        paramsDigest,
        quota,
      };
    }

    const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const created = ledger.createJob({
      jobId, requestId: jobId, idempotencyKey: key, capability: 'image', sessionId,
      state: 'running', createdAt: now(), attempts: 1, paramsDigest, quotaScope, source,
    });
    if (!created.created) {
      // Lost a race with another writer: the stored job owns the key.
      ledger.refundQuota({ scope: quotaScope, date });
      return {
        ok: false,
        error: { code: Code.UNKNOWN_RESULT, message: `an earlier request with this key is ${created.job.state}; it will not be replayed automatically` },
        paramsDigest,
        jobId: created.job.jobId,
      };
    }

    const pending = runGeneration({ jobId: created.job.jobId, key, params, paramsDigest, quotaScope, limit, date, source, sessionId, charged: true });
    inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      inFlight.delete(key);
    }
  }

  async function runGeneration({ jobId, key, params, paramsDigest, quotaScope, limit, date, source, sessionId, charged = false }) {
    const startedAt = Date.now();
    const outDir = managedPath(root, 'artifacts/image');
    fs.mkdirSync(outDir, { recursive: true });
    const fileName = `nai-${paramsDigest.slice(0, 16)}-${Date.now().toString(36)}.png`;
    const outPath = path.join(outDir, fileName);
    let refunded = false;
    try {
      const response = await invoke(
        buildBridgeRequest({ mode: 'generate', params, config, out: outPath, timeoutSeconds: Math.round((config.image.timeoutMs ?? 240_000) / 1000) }),
        (config.image.timeoutMs ?? 240_000) + 15_000,
      );
      if (!response.ok) {
        const failure = response.error ?? { code: Code.BACKEND_FAILED, message: 'generation failed' };
        const unknown = failure.code === Code.TIMEOUT || failure.code === Code.UNKNOWN_RESULT;
        const refundable = charged && !unknown && !PRE_FLIGHT_CODES.has(failure.code);
        if (refundable) {
          ledger.refundQuota({ scope: quotaScope, date });
          refunded = true;
        }
        ledger.updateJob(jobId, { state: unknown ? 'unknown' : 'failed', error: failure, finishedAt: now(), refunded });
        log({ event: 'image.failed', jobId, code: failure.code, refunded, unknown });
        return {
          ok: false, error: failure, paramsDigest, jobId,
          quota: ledger.quotaUsed({ scope: quotaScope, date }),
          refunded,
        };
      }
      const bytes = fs.readFileSync(outPath);
      const digest = sha256Hex(bytes);
      const artifact = {
        artifactId: `art_${digest.slice(0, 24)}`,
        kind: 'image',
        path: path.relative(root, outPath).split(path.sep).join('/'),
        mime: 'image/png',
        bytes: bytes.length,
        sha256: digest,
        width: response.width ?? null,
        height: response.height ?? null,
        origin: 'novelai',
        jobId,
        createdAt: now(),
        meta: {
          model: response.summary?.model,
          steps: response.summary?.steps,
          scale: response.summary?.scale,
          sampler: response.summary?.sampler,
          seed: response.summary?.seed,
          alpha: Boolean(response.alpha),
          source,
          quotaScope,
        },
      };
      if (params.straight_alpha && !response.alpha) {
        // A white-background image is not a transparent sticker; keep the file
        // but say so, instead of silently treating it as usable for reactions.
        artifact.meta.alphaWarning = 'transparency was requested but the PNG has no alpha channel';
      }
      ledger.putArtifact(artifact);
      ledger.updateJob(jobId, { state: 'succeeded', artifactId: artifact.artifactId, finishedAt: now(), elapsedMs: Date.now() - startedAt, refunded: false });
      log({ event: 'image.ok', jobId, bytes: artifact.bytes, alpha: artifact.meta.alpha });
      return { ok: true, artifact, paramsDigest, jobId, caption: response.caption ?? null, quota: { scope: quotaScope, used: ledger.quotaUsed({ scope: quotaScope, date }), limit } };
    } catch (error) {
      const failure = toFailure(error);
      const unknown = failure.code === Code.TIMEOUT || failure.code === Code.UNKNOWN_RESULT || failure.code === Code.CANCELLED;
      if (charged && !unknown) {
        ledger.refundQuota({ scope: quotaScope, date });
        refunded = true;
      }
      ledger.updateJob(jobId, { state: unknown ? 'unknown' : 'failed', error: failure, finishedAt: now(), refunded });
      log({ event: 'image.failed', jobId, code: failure.code, refunded, unknown });
      return { ok: false, error: failure, paramsDigest, jobId, refunded, quota: ledger.quotaUsed({ scope: quotaScope, date }) };
    }
  }

  return {
    preview,
    generate,
    paramsFor: options => buildImageParams(options, config),
    ledger,
    config,
    quotaScopeFor: options => resolveQuotaScope(options),
  };
}
