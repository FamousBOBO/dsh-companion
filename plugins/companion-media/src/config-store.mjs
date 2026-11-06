import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Code, mediaError } from './errors.mjs';
import { describeSecret, redactText } from './secrets.mjs';
import {
  DEFAULTS,
  IMAGE_PROVIDERS,
  SCHEMA_VERSION,
  TTS_PROVIDERS,
  migrateLegacyConfig,
  mergeConfig,
  normalizeConfig,
  validateConfig,
} from './schema.mjs';

/**
 * Reading and writing `<dataDir>/media/config.json`.
 *
 * The rules this file exists to enforce:
 *  - **atomic save**: temp file in the same directory, fsync, rename. A crash
 *    mid-write cannot leave a half-written config;
 *  - **secrets are never echoed**: `read()` returns a masked view, `readSecrets()`
 *    is the only in-process path to a plaintext key;
 *  - **an empty/masked key means "keep what is stored"**, so a form that renders
 *    `••••` and posts it back cannot wipe a working key;
 *  - **config lives outside the repository** (dataDir), never next to the source.
 */

export const CONFIG_RELATIVE_PATH = 'media/config.json';
export const BACKUP_SUFFIX = '.bak';

const SECRET_FIELDS = ['apiKey'];

/** Environment override for a key, e.g. `DSH_MEDIA_OPENAI_COMPATIBLE_API_KEY`. */
export function keyEnvName(scope) {
  return `DSH_MEDIA_${String(scope).replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_API_KEY`;
}

/** Legacy env names still honoured for one release (scope renames). */
export const LEGACY_ENV_ALIASES = Object.freeze({
  'openai-compatible': ['DSH_MEDIA_OPENAI_API_KEY'],
  'breeze-tts2': ['DSH_MEDIA_BREEZE_TTS_2_API_KEY'],
});

export function configFilePath(dataDir) {
  return path.join(dataDir, CONFIG_RELATIVE_PATH);
}

function readJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

/** Mask a config object for GET / UI: every secret becomes `{configured, mask}`. */
export function maskConfig(config, { env = process.env } = {}) {
  const copy = structuredClone(config ?? {});
  const maskSection = (section, scope) => {
    if (!section || typeof section !== 'object') return section;
    for (const field of SECRET_FIELDS) {
      if (field in section) {
        section[field] = describeSecret(section[field], { envVar: env ? keyEnvName(scope) : null });
      }
    }
    return section;
  };
  if (copy.vision) maskSection(copy.vision, 'vision');
  if (copy.image?.['openai-compatible']) maskSection(copy.image['openai-compatible'], 'openai-compatible');
  if (copy.image?.nai) maskSection(copy.image.nai, 'nai');
  for (const [id, section] of Object.entries(copy.tts?.providers ?? {})) maskSection(section, id);
  // Redact credential-shaped strings that survived under an innocent field name.
  return redactStrings(copy);
}

function redactStrings(value, depth = 0) {
  if (typeof value === 'string') return redactText(value);
  if (!value || typeof value !== 'object' || depth > 12) return value;
  if (Array.isArray(value)) return value.map(item => redactStrings(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = redactStrings(item, depth + 1);
  return out;
}

const MASKED_STRINGS = [/^\s*$/, /^\*+$/, /^[•…*]+$/, /…/, /^\[redacted\]$/];

/**
 * What a secret field in a patch means.
 *
 *   'keep'  — 空字符串 / 掩码字符串 / `{configured,mask}` 对象：保留已存的值
 *   'clear' — 显式的清除动作：`null` 或 `{clear:true}`
 *   'set'   — 任何其它值：写入新密钥
 *
 * "Empty means keep" is the default because a form that renders `••••` and
 * posts it back must not wipe a working key; clearing therefore has to be an
 * explicit action.
 */
export function secretIntent(value) {
  if (value === null) return 'clear';
  if (typeof value === 'object') return value?.clear === true ? 'clear' : 'keep';
  const text = String(value);
  if (!text.trim()) return 'keep';
  if (MASKED_STRINGS.some(pattern => pattern.test(text))) return 'keep';
  return 'set';
}

/**
 * Merge a patch onto the stored config, keeping stored secrets when the patch
 * carries an empty or masked placeholder.
 */
export function mergePreservingSecrets(stored, patch) {
  const incoming = structuredClone(patch ?? {});
  const apply = (target, source) => {
    for (const [key, value] of Object.entries(source ?? {})) {
      // Secrets first: a masked secret posted back is an OBJECT
      // (`{configured, mask}`), and it must never be merged as nested config.
      if (SECRET_FIELDS.includes(key)) {
        const intent = secretIntent(value);
        if (intent === 'keep') continue;
        target[key] = intent === 'clear' ? '' : String(value);
        continue;
      }
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        target[key] = apply(typeof target[key] === 'object' && target[key] !== null ? { ...target[key] } : {}, value);
        continue;
      }
      target[key] = value;
    }
    return target;
  };
  return apply(structuredClone(stored ?? {}), incoming);
}

/** Atomic write helper: same directory, fsync, rename. */
export function writeFileAtomic(file, contents, { mode = 0o600 } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const handle = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeFileSync(handle, contents, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(tmp, file);
  return file;
}

/**
 * The store.
 *
 * `read()` never throws: a missing or corrupt file degrades to defaults plus a
 * machine-readable diagnostic, because the plugin must still load and the UI
 * must still be able to show what is wrong.
 */
export function createConfigStore({ dataDir, env = process.env, now = () => new Date() } = {}) {
  if (!dataDir) throw new Error('createConfigStore needs dataDir');
  const file = configFilePath(dataDir);

  const readRaw = () => {
    try {
      return { raw: readJsonFile(file), exists: true };
    } catch (error) {
      if (error?.code === 'ENOENT') return { raw: null, exists: false };
      return { raw: null, exists: true, error: String(error?.message ?? error) };
    }
  };

  const load = () => {
    const { raw, exists, error } = readRaw();
    if (error) {
      return {
        config: normalizeConfig({}),
        exists: true,
        error,
        validation: { ok: false, errors: [{ path: '$', code: Code.CONFIG_INVALID, message: `配置文件无法解析：${error}` }], warnings: [] },
      };
    }
    if (!exists) {
      return { config: normalizeConfig({}), exists: false, error: null, validation: validateConfig(normalizeConfig({})) };
    }
    const legacy = Number(raw?.schemaVersion ?? 1) < SCHEMA_VERSION;
    const migrated = legacy ? migrateLegacyConfig(raw) : { config: normalizeConfig(raw), dropped: [], warnings: [] };
    return {
      config: migrated.config,
      exists: true,
      error: null,
      migrated: legacy,
      dropped: migrated.dropped,
      warnings: migrated.warnings,
      validation: validateConfig(migrated.config),
    };
  };

  return {
    file,
    dataDir,
    exists: () => fs.existsSync(file),
    load,
    /** Masked view for APIs and the page. */
    read() {
      const loaded = load();
      return {
        ...loaded,
        config: loaded.config,
        masked: maskConfig(loaded.config, { env, scopeOf: scope => scope }),
      };
    },
    /** The ONLY plaintext path. Adapters call this and must not keep the value. */
    secret(scope) {
      const { config } = load();
      const table = {
        vision: config.vision,
        'openai-compatible': config.image['openai-compatible'],
        nai: config.image.nai,
        ...Object.fromEntries(Object.entries(config.tts.providers).map(([id, section]) => [id, section])),
      };
      const section = table[scope];
      const stored = typeof section?.apiKey === 'string' ? section.apiKey.trim() : '';
      if (stored) return { value: stored, source: 'config' };
      const envVar = keyEnvName(scope);
      const fromEnv = typeof env?.[envVar] === 'string' ? env[envVar].trim() : '';
      if (fromEnv) return { value: fromEnv, source: 'env', envVar };
      for (const alias of LEGACY_ENV_ALIASES[scope] ?? []) {
        const legacy = typeof env?.[alias] === 'string' ? env[alias].trim() : '';
        if (legacy) return { value: legacy, source: 'env', envVar: alias };
      }
      return { value: '', source: 'none' };
    },
    /**
     * Save a patch. Validation runs on the merged result; nothing is written
     * when it fails, and the failure is typed per field so the UI can point at
     * the offending input.
     */
    save(patch, { reason = 'operator-save' } = {}) {
      const loaded = load();
      const merged = mergePreservingSecrets(loaded.config, patch ?? {});
      if(patch?.image?.nai?.presets) {
        if(patch.image.nai.qualityPreset===undefined)merged.image.nai.qualityPreset='legacy';
        if(patch.image.nai.negativePreset===undefined)merged.image.nai.negativePreset='legacy';
      }
      // vision is not writable at all
      const nextVision = { ...merged.vision, enabled: false };
      const next = normalizeConfig({ ...merged, vision: nextVision });
      next.schemaVersion = SCHEMA_VERSION;
      const validation = validateConfig(next);
      if (!validation.ok) {
        return {
          ok: false,
          saved: false,
          errors: validation.errors,
          warnings: validation.warnings,
          error: { code: validation.errors[0]?.code ?? Code.CONFIG_INVALID, message: validation.errors[0]?.message ?? '配置校验失败' },
        };
      }
      const body = `${JSON.stringify(next, null, 2)}\n`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (loaded.exists && fs.existsSync(file)) {
        try {
          fs.copyFileSync(file, `${file}${BACKUP_SUFFIX}`);
        } catch { /* a backup failure must not block a valid save */ }
      }
      writeFileAtomic(file, body);
      return {
        ok: true,
        saved: true,
        at: now().toISOString(),
        reason,
        warnings: validation.warnings,
        masked: maskConfig(next, { env }),
      };
    },
    /** Restore defaults (keeps no secrets). Used by tests and by "clear". */
    reset({ keepSecrets = false } = {}) {
      const loaded = load();
      const base = structuredClone(DEFAULTS);
      if (keepSecrets) {
        base.image['openai-compatible'].apiKey = loaded.config.image['openai-compatible'].apiKey;
        base.image.nai.apiKey = loaded.config.image.nai.apiKey;
        base.vision.apiKey = loaded.config.vision.apiKey;
        for (const [id, section] of Object.entries(base.tts.providers)) section.apiKey = loaded.config.tts.providers[id]?.apiKey ?? '';
      }
      writeFileAtomic(file, `${JSON.stringify(base, null, 2)}\n`);
      return { ok: true, masked: maskConfig(base, { env }) };
    },
    /** Reference data the page and the CLI both read. */
    catalog() {
      return {
        schemaVersion: SCHEMA_VERSION,
        imageProviders: Object.values(IMAGE_PROVIDERS).map(({ evidence, fieldLabels, requiredFields, ...rest }) => ({
          ...rest, evidence, fieldLabels, requiredFields,
        })),
        ttsProviders: Object.values(TTS_PROVIDERS).map(({ evidence, fieldLabels, requiredFields, ...rest }) => ({
          ...rest, evidence, fieldLabels, requiredFields,
        })),
      };
    },
    /** Merge helper exposed for the page's "reload shows the same values" test. */
    merge: (base, patch) => mergeConfig(base, patch),
  };
}
