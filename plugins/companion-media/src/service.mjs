import { storeReference } from './reference-audio.mjs';
import { prepareImagePrompt } from './image-pipeline.mjs';
import { directSpeech } from './director.mjs';
import { resolveNaiPrompt } from './official-prompts.mjs';
import { resolveGenerationSection } from './generation-presets.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { Code, MediaError, toFailure } from './errors.mjs';
import { createNet } from './net.mjs';
import { createConfigStore, writeFileAtomic } from './config-store.mjs';
import { createLedger, digestOf, resolveArtifactRoot, writeArtifact } from './ledger.mjs';
import { IMAGE_PROVIDERS, TTS_PROVIDERS, canonicalImageProvider, canonicalTtsProvider, imageSection, normalizeConfig, ttsSection, validateConfig } from './schema.mjs';
import { presetFamilyFor, resolvePreset } from './presets.mjs';
import { previewResolution } from './resolution.mjs';
import { imageAdapter, ttsAdapter, adapterCatalog } from './adapters/registry.mjs';
import { visionContract, visionRefusal } from './vision.mjs';
import { readSuiteConfig, resolvePersonaId } from './persona.mjs';
import { redactText } from './secrets.mjs';

/**
 * The media service — the single business facade.
 *
 * Everything the tools, the HTTP API and the page call goes through here, so
 * there is exactly one place that decides:
 *   - may this call happen at all (enabled? configured? provider connected?);
 *   - how the request budget and byte caps are applied;
 *   - what a failure looks like (typed code, never a fabricated success).
 *
 * Status vocabulary (used verbatim by the UI and the reports):
 *   disabled        功能关闭
 *   unconfigured    未配置（缺必填项 / 未选 provider）
 *   not-connected   尚未接入（协议证据不足，不可启用）
 *   saved-untested  已保存、未测试
 *   test-ok         测试通过（detail 里写明到哪一级）
 *   test-failed     测试失败
 */

export const STATE = Object.freeze({
  DISABLED: 'disabled',
  UNCONFIGURED: 'unconfigured',
  NOT_CONNECTED: 'not-connected',
  SAVED_UNTESTED: 'saved-untested',
  TEST_OK: 'test-ok',
  TEST_FAILED: 'test-failed',
});

function missingFields(record, section) {
  return (record.requiredFields ?? []).filter(field => {
    const value = section?.[field];
    return typeof value !== 'string' || !value.trim();
  });
}

export function createMediaService({
  dataDir,
  env = process.env,
  now = () => new Date(),
  fetchImpl = globalThis.fetch,
  log = null,
  suiteRoot = null,
  testStoreFile = null,
  host = null,
} = {}) {
  if (!dataDir) throw new Error('createMediaService needs a dataDir');
  const store = createConfigStore({ dataDir, env, now });
  const ledger = createLedger({ dataDir, now });
  const net = createNet({ fetchImpl, now: () => now().getTime() });
  const testsFile = testStoreFile ?? path.join(dataDir, 'media', 'state', 'tests.json');

  const readTests = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(testsFile, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };
  let testResults = readTests();
  const persistTests = () => {
    try {
      writeFileAtomic(testsFile, `${JSON.stringify(testResults, null, 2)}\n`);
    } catch { /* diagnostics only */ }
  };

  const note = entry => {
    if (typeof log !== 'function') return;
    try { log(entry); } catch { /* logging never breaks a call */ }
  };

  const keyFor = scope => store.secret(scope);

  /**
   * How the management API registration went.
   *
   * `connection` is provided asynchronously by the host, so the plugin may
   * activate before it exists. When that happens the routes are registered later
   * through `ctx.inject`; this state records both attempts so `status()` (and
   * `/page`) can tell a caller *why* an endpoint is unreachable.
   */
  let httpState = {
    registered: 0,
    skipped: 'not-attempted',
    how: null,
    at: null,
    paths: [],
    failed: [],
    lastError: null,
  };
  const httpStateSnapshot = () => ({ ...httpState, paths: [...httpState.paths] });
  const noteHttpState = patch => {
    httpState = { ...httpState, ...patch, at: now().toISOString() };
    return httpStateSnapshot();
  };

  /**
   * Where deliverables land, and the boundary the channel enforces.
   *
   * Media writes only inside its own artifact root (default
   * `<dataDir>/workspace/media`); the chat channel reads only inside
   * `<dataRoot>/workspace` or `<dshHome>/channel-qq`. Keeping the asymmetry —
   * media writes one directory, channel reads a boundary — is deliberate: the
   * plugin never gains the right to name an arbitrary path.
   */
  function artifactLocation(config) {
    const resolved = resolveArtifactRoot(dataDir, config);
    return {
      artifactRoot: resolved.root,
      artifactRootSource: resolved.source,
      channelBoundary: [path.join(dataDir, 'workspace'), '<dshHome>/channel-qq'],
      channelBoundaryNote:
        '交付给通道的文件必须位于 <dataRoot>/workspace 或 <dshHome>/channel-qq 之内；越界会被通道拒绝（outside-boundary）',
    };
  }

  function sectionOf(config, kind, id) {
    return kind === 'image' ? imageSection(config, id) : ttsSection(config, id);
  }

  function recordOf(kind, id) {
    const key = kind === 'image' ? canonicalImageProvider(id) : canonicalTtsProvider(id);
    return kind === 'image' ? IMAGE_PROVIDERS[key] : TTS_PROVIDERS[key];
  }

  const canonicalId = (kind, id) => (kind === 'image' ? canonicalImageProvider(id) : canonicalTtsProvider(id));

  /** One provider's state, computed — never stored as "connected". */
  function providerStatus(kind, id, config) {
    const record = recordOf(kind, id);
    if (!record) return { id, state: STATE.NOT_CONNECTED, reason: '未知 provider' };
    const section = sectionOf(config, kind, id);
    const featureOn = kind === 'image'
      ? config.image.enabled === true && config.image.provider === id
      : config.tts.enabled === true && config.tts.provider === id && section.enabled === true;
    const missing = missingFields(record, section);
    const key = keyFor(id);
    const last = testResults[`${kind}:${id}`] ?? null;

    if (record.status !== 'connected') {
      return {
        id,
        label: record.label,
        state: STATE.NOT_CONNECTED,
        reason: record.reason,
        evidence: record.evidence,
        enabled: false,
      };
    }
    if (!featureOn && missing.length > 0) {
      return { id, label: record.label, state: STATE.UNCONFIGURED, missing, enabled: false, key: { configured: key.value !== '' } };
    }
    if (!featureOn) {
      return { id, label: record.label, state: STATE.DISABLED, missing, enabled: false, key: { configured: key.value !== '' } };
    }
    if (missing.length > 0) {
      return { id, label: record.label, state: STATE.UNCONFIGURED, missing, enabled: true, key: { configured: key.value !== '' } };
    }
    const base = {
      id,
      label: record.label,
      enabled: true,
      missing: [],
      key: { configured: key.value !== '', source: key.source, ...(key.envVar ? { envVar: key.envVar } : {}) },
      endpoint: record.endpoint,
      evidence: record.evidence,
    };
    if (!last) return { ...base, state: STATE.SAVED_UNTESTED, note: '配置已保存但从未测试；这不代表远端可用' };
    if (last.ok) {
      return { ...base, state: STATE.TEST_OK, level: last.level, detail: last.detail, testedAt: last.at, note: last.detail };
    }
    return { ...base, state: STATE.TEST_FAILED, code: last.code, detail: last.detail, testedAt: last.at };
  }

  function status() {
    const loaded = store.read();
    const config = loaded.config;
    const persona = resolvePersonaId({ env, suiteConfig: readSuiteConfig(suiteRoot) });
    return {
      version: '0.1.0',
      dataDir,
      configFile: store.file,
      configExists: loaded.exists,
      configError: loaded.error ?? null,
      migrated: loaded.migrated ?? false,
      persona,
      enabled: config.enabled,
      processing: { model: 'DSH default', hostAvailable: host?.available?.() === true, image: config.image.pipeline, speech: config.tts.director },
      states: {
        vision: visionContract(config.vision),
        image: {
          enabled: config.image.enabled,
          provider: config.image.provider,
          providers: Object.keys(IMAGE_PROVIDERS).map(id => providerStatus('image', id, config)),
          // Explicit, so a caller cannot mistake "enabled" for "will retry".
          retryPolicy: 'never-auto',
        },
        tts: {
          enabled: config.tts.enabled,
          provider: config.tts.provider,
          providers: Object.keys(TTS_PROVIDERS).map(id => providerStatus('tts', id, config)),
        },
      },
      limits: config.limits,
      paths: artifactLocation(config),
      catalog: adapterCatalog(),
      validation: loaded.validation,
      ledger: ledger.summary(),
      facts: [
        `识图：关闭（合同保留，不可绕过）`,
        `生图：${config.image.enabled ? `开（${config.image.provider}）` : '关'}；失败不自动重试`,
        `TTS：${config.tts.enabled ? `开（${config.tts.provider}）` : '关'}；只产出文件，不发送`,
      ],
      config: loaded.masked,
      // 管理 API 的注册结果：宿主里的「模块已启用但 API 没起来」与「模块未启用」
      // 只能靠这个区分（HTTP 404 本身说明不了是哪种）。
      http: httpStateSnapshot(),
    };
  }

  function readConfig() {
    const loaded = store.read();
    return {
      ok: true,
      configFile: store.file,
      exists: loaded.exists,
      config: loaded.masked,
      validation: loaded.validation,
      paths: artifactLocation(loaded.config),
      states: status().states,
      warnings: loaded.warnings ?? [],
      dropped: loaded.dropped ?? [],
      catalog: adapterCatalog(),
      persona: resolvePersonaId({ env }),
    };
  }

  function saveConfig(patch, { reason = 'operator-save' } = {}) {
    const result = store.save(patch, { reason });
    note({ event: 'config-save', ok: result.ok, reason });
    if (!result.ok) return result;
    return { ...result, config: result.masked, states: status().states };
  }

  async function testProvider({ kind, id }) {
    if (kind !== 'image' && kind !== 'tts') throw new MediaError(Code.BAD_INPUT, 'kind 必须是 image 或 tts');
    const providerId = canonicalId(kind, id);
    const record = recordOf(kind, providerId);
    if (!record) throw new MediaError(Code.PROVIDER_UNKNOWN, `未知 provider：${id}`);
    const { config } = store.load();
    const section = sectionOf(config, kind, providerId);
    const adapter = kind === 'image' ? imageAdapter(providerId) : ttsAdapter(providerId);
    const key = keyFor(providerId).value;
    let result;
    try {
      result = await adapter.test({ section, config, key, net, limits: config.limits });
    } catch (error) {
      result = { ok: false, code: error?.code ?? Code.UNKNOWN, detail: String(error?.message ?? error).slice(0, 300) };
    }
    testResults[`${kind}:${providerId}`] = {
      ok: result.ok === true,
      level: result.level ?? 'none',
      detail: redactText(result.detail ?? ''),
      code: result.code ?? null,
      at: now().toISOString(),
    };
    persistTests();
    note({ event: 'provider-test', kind, id: providerId, ok: result.ok === true, code: result.code ?? null });
    return {
      ok: result.ok === true,
      kind,
      id: providerId,
      status: result.ok === true ? STATE.TEST_OK : STATE.TEST_FAILED,
      level: result.level ?? 'none',
      detail: result.detail ?? '',
      ...(result.code ? { code: result.code } : {}),
      ...(result.models ? { models: result.models } : {}),
      note: '测试通过只证明这一级证据（见 level）；不等于端到端生成/投递可用',
      states: status().states,
    };
  }

  /** Wrapper that enforces the request budget on top of the provider timeout. */
  function budgetFor(limits, timeoutMs) {
    const cap = Math.max(1, Math.min(Number(timeoutMs ?? limits.requestBudgetMs), limits.requestBudgetMs));
    return cap;
  }

  async function generateImage({ prompt, negative = '', context = '', dryRun = false, sessionId = null, signal = null } = {}) {
    const loaded = store.load();
    const config = loaded.config;
    if (!config.enabled) return { ok: false, error: { code: Code.DISABLED, message: '媒体插件已停用' } };
    if (!config.image.enabled) return { ok: false, error: { code: Code.DISABLED, message: '生图已关闭（计费能力默认关闭）' } };
    const id = config.image.provider;
    if (id === 'none') return { ok: false, error: { code: Code.NOT_CONFIGURED, message: '未选择生图 provider' } };
    const validation = validateConfig(config);
    if (!validation.ok) {
      return { ok: false, error: { code: validation.errors[0].code, message: validation.errors[0].message }, errors: validation.errors };
    }
    const section = id === 'nai' ? resolveGenerationSection(imageSection(config, id)) : { ...imageSection(config, id) };
    const record = recordOf('image', id);

    if (dryRun) {
      const dry = { ok: true, dryRun: true, provider: id, wouldSend: '不发起任何网络请求' };
      if (id === 'nai') {
        const preset = resolveNaiPrompt(section,{prompt,negative});
        dry.preset = { family: preset.family, applied: preset.applyDefaults, positive: preset.positive, negative: preset.negative, warnings: preset.warnings };
        dry.resolution = previewResolution({ mode: 'fixed', size: `${section.width}x${section.height}` });
        dry.transport = section.transport;
      } else {
        dry.size = section.size;
        dry.model = section.model;
      }
      dry.processing = { enabled: config.image.pipeline.enabled, mode: config.image.pipeline.mode, model: 'DSH default', invoked: false };
      return dry;
    }

    const job = ledger.createJob({
      kind: 'image',
      provider: id,
      model: String(section.model ?? ''),
      requestDigest: digestOf(`${id}:${prompt}`),
    });
    const timeoutMs = budgetFor(config.limits, section.timeoutMs);
    try {
      if(typeof prompt!=='string'||!prompt.trim()||prompt.length>config.limits.maxTextChars||typeof negative!=='string'||negative.length>config.limits.maxTextChars)throw new MediaError(Code.BAD_INPUT,'提示词为空或超过长度上限');
      const budgetSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(config.limits.requestBudgetMs)]):AbortSignal.timeout(config.limits.requestBudgetMs);
      budgetSignal.throwIfAborted();
      const prepared=id==='nai'?await prepareImagePrompt({host,prompt,negative,context,config,sessionId,signal:budgetSignal,log:note}):{prompt,negative,processing:{used:false,reason:'not-nai'}};
      budgetSignal.throwIfAborted();
      const adapter = imageAdapter(id);
      const result = await adapter.generate({
        section: { ...section, timeoutMs },
        limits: config.limits,
        key: keyFor(id).value,
        net,
        prompt: prepared.prompt,
        negative: prepared.negative,
        signal: budgetSignal,
      });
      const artifact = writeArtifact({ root: artifactLocation(config).artifactRoot, kind: 'image', bytes: result.bytes, extension: result.extension });
      const meta = {
        artifactId: artifact.artifactId,
        kind: 'image',
        absolutePath: artifact.absolutePath,
        bytes: artifact.bytes,
        mime: result.mime,
        width: result.width ?? null,
        height: result.height ?? null,
        provider: id,
        model: result.meta?.model ?? section.model ?? '',
        seed: result.meta?.seed ?? null,
        sha256: artifact.sha256,
      };
      ledger.putArtifact({ ...meta, sessionId });
      ledger.finishJob(job.jobId, { state: 'succeeded', artifactId: artifact.artifactId, bytes: artifact.bytes });
      note({ event: 'image-generated', provider: id, bytes: artifact.bytes, jobId: job.jobId });
      return {
        ok: true,
        jobId: job.jobId,
        provider: id,
        artifact: meta,
        // Producing a file is not delivering it; the channel still has to send.
        handoff: {
          tool: 'qq_sticker',
          action: 'send',
          file: artifact.absolutePath,
          mime: result.mime,
          bytes: artifact.bytes,
          provider: id,
          model: result.meta?.model ?? section.model ?? '',
          ready: true,
          delivered: false,
          mustSend: `调用 qq_sticker action=send 并传 file=${artifact.absolutePath}`,
        },
        meta: result.meta ?? {},
        processing: prepared.processing,
      };
    } catch (error) {
      const failure = toFailure(error);
      ledger.finishJob(job.jobId, { state: 'failed', error: failure });
      note({ event: 'image-failed', provider: id, code: failure.code, jobId: job.jobId });
      return { ok: false, jobId: job.jobId, error: failure, retried: false };
    }
  }

  async function synthesize({ text, provider = null, sessionId = null, context = '', instructions = '', signal = null } = {}) {
    const loaded = store.load();
    const config = loaded.config;
    if (!config.enabled) return { ok: false, error: { code: Code.DISABLED, message: '媒体插件已停用' } };
    if (!config.tts.enabled) return { ok: false, error: { code: Code.DISABLED, message: 'TTS 已关闭（默认关闭）' } };
    const id = canonicalTtsProvider(provider || config.tts.provider);
    if (id === 'none') return { ok: false, error: { code: Code.NOT_CONFIGURED, message: '未选择 TTS provider' } };
    const record = recordOf('tts', id);
    if (!record) return { ok: false, error: { code: Code.PROVIDER_UNKNOWN, message: `未知 TTS provider：${id}` } };
    if (record.status !== 'connected') {
      return { ok: false, error: { code: Code.PROVIDER_NOT_IMPLEMENTED, message: `${record.label} 尚未接入：${record.reason}` } };
    }
    const section = { ...ttsSection(config, id) };
    if (section.enabled !== true) return { ok: false, error: { code: Code.DISABLED, message: `${record.label} 未启用` } };
    const validation = validateConfig({ ...config, tts: { ...config.tts, provider: id } });
    if (!validation.ok) {
      return { ok: false, error: { code: validation.errors[0].code, message: validation.errors[0].message }, errors: validation.errors };
    }

    const job = ledger.createJob({ kind: 'speech', provider: id, model: String(section.model ?? ''), requestDigest: digestOf(`${id}:${text}`) });
    const timeoutMs = budgetFor(config.limits, section.timeoutMs);
    try {
      if(typeof text!=='string'||!text.trim()||text.length>config.limits.maxTextChars)throw new MediaError(Code.BAD_INPUT,'台词为空或超过长度上限');
      if(typeof instructions!=='string'||instructions.length>4000)throw new MediaError(Code.BAD_INPUT,'表演指令超过长度上限');
      const budgetSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(config.limits.requestBudgetMs)]):AbortSignal.timeout(config.limits.requestBudgetMs);
      budgetSignal.throwIfAborted();
      const directed=id==='breeze-tts2'?await directSpeech({host,text,context,sessionId,config,signal:budgetSignal,log:note}):{used:false,reason:'provider-not-supported'};
      budgetSignal.throwIfAborted();
      const adapter = ttsAdapter(id);
      const result = await adapter.generate({
        section: { ...section, timeoutMs },
        limits: config.limits,
        key: keyFor(id).value,
        net,
        text: directed.used ? directed.input : text,
        instruction: directed.used ? directed.instructions : instructions || section.instruction || '',
        signal: budgetSignal,
      });
      const artifact = writeArtifact({ root: artifactLocation(config).artifactRoot, kind: 'speech', bytes: result.bytes, extension: result.extension });
      const meta = {
        artifactId: artifact.artifactId,
        kind: 'speech',
        absolutePath: artifact.absolutePath,
        bytes: artifact.bytes,
        mime: result.mime,
        durationSeconds: result.durationSeconds ?? null,
        provider: id,
        model: result.meta?.model ?? section.model ?? '',
        voice: result.meta?.voice ?? result.meta?.referenceId ?? '',
        sha256: artifact.sha256,
      };
      ledger.putArtifact({ ...meta, sessionId });
      ledger.finishJob(job.jobId, { state: 'succeeded', artifactId: artifact.artifactId, bytes: artifact.bytes });
      note({ event: 'speech-synthesized', provider: id, bytes: artifact.bytes, jobId: job.jobId });
      return {
        ok: true,
        jobId: job.jobId,
        provider: id,
        artifact: meta,
        director: { used: directed.used, ...(directed.reason ? { reason: directed.reason } : {}) },
        handoff: {
          tool: 'qq_voice',
          action: 'send_file',
          file: artifact.absolutePath,
          mime: result.mime,
          bytes: artifact.bytes,
          durationSeconds: result.durationSeconds ?? null,
          provider: id,
          model: result.meta?.model ?? section.model ?? '',
          voice: result.meta?.voice ?? result.meta?.referenceId ?? '',
          ready: true,
          delivered: false,
          mustSend: `调用 qq_voice action=send_file 并传 file=${artifact.absolutePath}`,
        },
      };
    } catch (error) {
      const failure = toFailure(error);
      ledger.finishJob(job.jobId, { state: 'failed', error: failure });
      note({ event: 'speech-failed', provider: id, code: failure.code, jobId: job.jobId });
      return { ok: false, jobId: job.jobId, error: failure };
    }
  }

  function preview({ mode = 'fixed', size = '', aspect = 'portrait', targetPixels = 1_011_712, model = 'nai-diffusion-4-5-full' } = {}) {
    return {
      ok: true,
      model,
      family: presetFamilyFor(model),
      resolution: previewResolution({ mode, size, aspect, targetPixels }),
    };
  }

  return {
    version: '0.1.0',
    dataDir,
    store,
    ledger,
    net,
    status,
    readConfig,
    saveConfig,
    uploadReference: async ({id,bytes}) => storeReference({dataDir,id,bytes,section:ttsSection(store.load().config,id),net,key:keyFor(id).value}),
    testProvider,
    generateImage,
    synthesize,
    preview,
    httpState: httpStateSnapshot,
    noteHttpState,
    vision: visionContract,
    inspectImage: visionRefusal,
    jobs: (limit = 10) => ({ jobs: ledger.listJobs(limit), artifacts: ledger.listArtifacts(limit) }),
    getJob: jobId => ledger.getJob(jobId),
    // Exposed for tests and for the offline page preview.
    normalize: raw => normalizeConfig(raw),
  };
}
