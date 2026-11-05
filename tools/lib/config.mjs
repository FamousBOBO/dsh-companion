/**
 * Suite-level configuration.
 *
 * `config/suite.json` is local and git-ignored. `config/suite.example.json` is the
 * committed template. Loading never fails because a value is missing: every field
 * has a documented default, and optional modules default to OFF.
 *
 * Precedence (highest first): environment variable > config/suite.json > template default.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SUITE_PATHS, dataPaths } from './paths.mjs';

/** Environment overrides, so CI and one-off runs never need to edit a tracked file. */
const ENV_MAP = {
  DSH_COMPANION_DATA_DIR: (v) => ({ dataDir: v }),
  DSH_COMPANION_PROFILE: (v) => ({ 'dsh.profile': v }),
  DSH_COMPANION_HOST_EXE: (v) => ({ 'dsh.executable': v }),
  DSH_COMPANION_MODULE_ROOT: (v) => ({ 'dsh.moduleRoot': v }),
  DSH_COMPANION_MODULE: (v) => ({ 'modules.core': v !== '0' }),
};

export const MODULE_KEYS = [
  'core',
  'memoryStudio',
  'qq',
  'bilibili',
  'health',
  'media',
  'pasteSearch',
  'superInjector',
];

/** Every optional module is disabled until the operator turns it on. */
export const SAFE_DEFAULTS = {
  version: 1,
  dataDir: '',
  dsh: {
    executable: '',
    moduleRoot: '',
    profile: 'companion',
    permissionMode: 'workspace-write',
    tempDir: '',
    startTimeoutMs: 120000,
  },
  modules: {
    core: true,
    memoryStudio: true,
    qq: false,
    bilibili: false,
    health: false,
    media: false,
    pasteSearch: false,
    superInjector: false,
  },
  services: {
    onebot: { url: '', accessToken: '', selfId: 0 },
    health: { sidecarUrl: '' },
    media: { baseUrl: '', apiKeyEnv: '' },
  },
  safety: {
    // Anything that can spend money or reach another human stays off by default.
    autoSend: false,
    autoComment: false,
    backgroundModelTasks: false,
    healthCollection: false,
    billingApis: false,
  },
};

function deepMerge(base, override) {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (typeof base !== 'object' || typeof override !== 'object') return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

function readJson(file, { required = false } = {}) {
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`missing required file: ${file}`);
    return null;
  }
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
}

function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Load the effective suite configuration.
 * @returns {{config: object, sources: string[], dataPaths: object, configFile: string}}
 */
export function loadConfig({ env = process.env } = {}) {
  const template = readJson(SUITE_PATHS.configExample) || {};
  const local = readJson(SUITE_PATHS.configFile); // optional
  let config = deepMerge(deepMerge(SAFE_DEFAULTS, template), local);

  const sources = [SUITE_PATHS.configExample];
  if (local) sources.push(SUITE_PATHS.configFile);

  for (const [name, apply] of Object.entries(ENV_MAP)) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    for (const [key, value] of Object.entries(apply(raw))) setPath(config, key, value);
    sources.push(name);
  }

  const dataDir = config.dataDir && String(config.dataDir).trim()
    ? path.resolve(SUITE_PATHS.root, config.dataDir)
    : path.join(SUITE_PATHS.root, 'data');

  return {
    config,
    sources,
    configFile: SUITE_PATHS.configFile,
    dataPaths: dataPaths(dataDir),
  };
}

/** Merge writes into config/suite.json without dropping keys this tool does not know about. */
export function writeConfigPatch(patch, { target = SUITE_PATHS.configFile } = {}) {
  const existing = readJson(target) || {};
  const merged = deepMerge(existing, patch);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
  return merged;
}

/** Effective module enablement, with the core module always on. */
export function enabledModules(config) {
  const modules = { ...SAFE_DEFAULTS.modules, ...(config.modules || {}) };
  modules.core = true;
  return modules;
}

export default { loadConfig, writeConfigPatch, enabledModules, SAFE_DEFAULTS, MODULE_KEYS };
