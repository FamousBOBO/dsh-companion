// 陪伴空间 · 设置搜索路由（W1-3 / W1-4）。
//
// 这一层只做三件事：把两个**已有**权威来源投影成目录、跑一次搜索、把结果带回深链。
// 它不写任何配置，也不返回 secret 明文——搜索结果是目录元信息，不是配置值。
//
// 深链约定（前端 W1-4 的聚焦目标）：
//   `qq:<page>`      → 该字段落在 QQ 后台的哪一页（已投影到聊天页的字段则在 Studio 聊天页聚焦）
//   `studio:settings` → 本包设置页，按 `path` 聚焦控件
// 前端据此把 `path` 作为要聚焦的控件键。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { catalogFromQQ, catalogFromStudio, searchCatalog, CATALOG_META_KEYS } from './settings-catalog.mjs';
import { readClientFields } from './client-fields.mjs';
import { ApiError, clampInt, textValue } from './api-kernel.mjs';
// 密钥文件的位置与"有没有配置"的判据只认 companion-memory 的那一套实现，
// 目录不复制第二份路径常量（见下方 secretSetOf 的注释）。
import * as configModule from '../../companion-memory/config.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
};

/**
 * 把嵌套对象摊成 dot-path 集合（数组整体算一个叶子：它没有"逐字段合并"这回事）。
 */
export function walkDotPaths(value, prefix, out) {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) { if (prefix) out.add(prefix); return; }
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) walkDotPaths(child, next, out);
    else out.add(next);
  }
}

/**
 * QQ 配置的两层 dot-path 集合：patch 层（cordis 行的 config）与 override 层
 * （`home/channel-qq/admin-config.json`）。
 *
 * 只用来判 `status`（configured / default），**不参与任何合并**——合并的唯一权威仍然是
 * QQ 插件自己的 `resolveConfig()`。patch 层需要 yaml；解析器拿不到就返回 null，
 * 目录会把状态退回「只看 override」，绝不假装 patch 层是空的（那会把已配置的字段报成 default）。
 */
export function qqLayerPaths(root, suiteRoot) {
  const home = path.join(root, 'home');
  const override = readJson(path.join(home, 'channel-qq', 'admin-config.json'));
  const overridePaths = new Set();
  walkDotPaths(override, '', overridePaths);

  if (!suiteRoot) return { overridePaths, patchPaths: null };
  const YAML = loadYaml();
  if (!YAML) return { overridePaths, patchPaths: null };

  const patchPaths = new Set();
  const suite = readJson(path.join(suiteRoot, 'config', 'suite.json'));
  const files = [
    path.join(suiteRoot, 'config', 'profile', 'companion.patch.yml'),
    path.join(home, 'profiles', String(suite?.dsh?.profile ?? 'companion'), 'cordis.patch.yml'),
  ];
  let parsedAny = false;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      const rows = YAML.parse(fs.readFileSync(file, 'utf8'), { logLevel: 'silent' }) ?? [];
      for (const row of Array.isArray(rows) ? rows : []) {
        if (row?.id === 'channel-qq' && row.config) {
          walkDotPaths(row.config, '', patchPaths);
          parsedAny = true;
        }
      }
    } catch { /* 这一层解析失败：不往里加东西，也不谎称它为空 */ }
  }
  return { overridePaths, patchPaths: parsedAny ? patchPaths : null };
}

/** yaml 在套件根没有，但在宿主 module root 里（生产就是这么解析的，见 serve.mjs）。 */
function loadYaml() {
  try { return createRequire(import.meta.url)('yaml'); } catch { /* 继续尝试宿主 module root */ }
  const moduleRoot = String(process.env.DSH_COMPANION_MODULE_ROOT ?? '').trim();
  if (!moduleRoot) return null;
  try { return createRequire(path.join(moduleRoot, '_settings-catalog.cjs'))('yaml'); } catch { return null; }
}

/** Studio 侧的层信息：`memory.config.json` 里实际存在的键。 */
export function studioLayerPaths(root) {
  const config = readJson(path.join(root, 'home', 'companion', 'memory.config.json'));
  const paths = new Set();
  walkDotPaths(config, '', paths);
  return paths;
}

/**
 * 密钥是否已配置（只读"有没有"，不读值）。
 *
 * 与 `read.mjs` 的 `secretsFlag()` 同一套权威：`loadConfig()` 给磁盘配置，
 * `readRemoteModels()` 给密钥文件（`home/companion/remote-models.json`）。
 * 这里**不**自己拼路径，否则密钥文件的真实位置会多出第二份说法。
 */
function secretSetOf(root) {
  try {
    const { loadConfig, readRemoteModels, REMOTE_MODELS_FILE } = configModule;
    const { config, file } = loadConfig(root, { env: {} });
    let secrets = { embedding: { apiKey: '' }, rerank: { apiKey: '' } };
    if (file) {
      try { secrets = readRemoteModels(path.join(path.dirname(file), REMOTE_MODELS_FILE)); } catch { /* 密钥文件不可读 = 未配置 */ }
    }
    const set = (key) => Boolean(String(config?.[key]?.apiKey ?? '').trim() || String(secrets?.[key]?.apiKey ?? '').trim());
    return { embeddingApiKey: set('embedding'), rerankApiKey: set('rerank') };
  } catch {
    // 拿不到权威就读不到「有没有」——回空对象，目录会把状态标 secret-unset 而不是猜。
    return {};
  }
}

/** 是否装载了 QQ 插件（决定 `available`，不猜运行态）。 */
function qqModuleAvailable(suiteRoot) {
  if (!suiteRoot) return false;
  try {
    return Boolean(readJson(path.join(suiteRoot, 'plugins', 'dsh-channel-qq', 'package.json'))?.name);
  } catch { return false; }
}

/**
 * `GET /api/companion-memory/settings-catalog?q=&limit=&kind=`
 *
 * `kind`：`all`（默认）| `qq` | `studio`。返回的每条都是计划 W1-2 的固定元信息 + 深链定位，
 * **不含 secret 明文值**。某个来源不可用时如实列进 `catalog.sources`，不静默降级成空目录。
 */
export async function settingsCatalog(request, kernel) {
  kernel.viewer(await kernel.internal());
  const query = kernel.query(request);
  const rawQuery = textValue(query.get('q'), 120);
  const limit = clampInt(query.get('limit'), 1, 200, 40);
  const kind = textValue(query.get('kind'), 12) || 'all';

  const root = String(kernel.root ?? '');
  if (!root) throw new ApiError('internal', '数据根不可用。', 500);

  const entries = [];
  const sources = [];
  const suiteRoot = suiteRootOf(root);

  // QQ 侧：schema 是唯一权威；这里只读它的元数据。
  if (kind === 'all' || kind === 'qq') {
    let refs = null;
    try {
      const mod = await import('../../dsh-channel-qq/build/lib/config/meta.js');
      refs = mod.fieldRefs();
    } catch { refs = null; }
    if (refs === null) {
      sources.push({ source: 'qq-schema', status: 'unavailable', reason: 'qq-build-missing' });
    } else {
      const layers = qqLayerPaths(root, suiteRoot);
      entries.push(...catalogFromQQ(refs, {
        overridePaths: layers.overridePaths,
        patchPaths: layers.patchPaths,
        moduleAvailable: qqModuleAvailable(suiteRoot),
      }));
      sources.push({
        source: 'qq-schema',
        status: 'loaded',
        fields: refs.length,
        layers: {
          override: layers.overridePaths.size,
          patch: layers.patchPaths ? layers.patchPaths.size : null,
        },
      });
    }
  }

  // Studio 侧：SETTINGS_SPEC / SECRET_SPEC 是写入权威，客户端 FIELDS 提供渲染元数据。
  if (kind === 'all' || kind === 'studio') {
    let spec = null;
    let secretSpec = null;
    try {
      const write = await import('./write.mjs');
      spec = write.SETTINGS_SPEC;
      secretSpec = write.SECRET_SPEC;
    } catch { spec = null; }
    if (!spec || !secretSpec) {
      sources.push({ source: 'studio-spec', status: 'unavailable', reason: 'spec-not-exported' });
    } else {
      const client = readClientFields(PACKAGE_ROOT);
      entries.push(...catalogFromStudio(spec, secretSpec, client.fields, {
        overridePaths: studioLayerPaths(root),
        secretSet: secretSetOf(root),
        secretLabels: client.secretLabels,
      }));
      sources.push({
        source: 'studio-spec',
        status: 'loaded',
        fields: Object.keys(spec).length + Object.keys(secretSpec).length,
      });
    }
  }

  if (!entries.length) {
    throw new ApiError('bad-request', '没有任何可用的字段目录来源：先完成宿主安装与插件构建。', 400);
  }

  const result = searchCatalog(entries, rawQuery, { limit });
  return kernel.ok({
    catalog: {
      metaKeys: [...CATALOG_META_KEYS],
      sources,
      totalFields: entries.filter((entry) => entry.status !== 'unavailable').length,
    },
    ...result,
  });
}

/** 套件根：数据根是 `<suiteRoot>/data`；取不到就返回 null（相关状态会退成 unknown）。 */
export function suiteRootOf(root) {
  const env = String(process.env.DSH_COMPANION_SUITE_ROOT ?? '').trim();
  if (env) return path.resolve(env);
  const candidate = path.resolve(root, '..');
  try {
    if (readJson(path.join(candidate, 'package.json'))?.name === 'dsh-companion-suite') return candidate;
  } catch { /* 不是套件根 */ }
  return null;
}
