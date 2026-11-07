#!/usr/bin/env node
/**
 * 整包导入表情包（zip + 手工语义卡清单）。
 *
 * 为什么要这个脚本：图库的唯一写入口是 `library.receive()`，它只认字节、格式和审核态；
 * 语义卡（`literal` / `intents` / `emotions` / `scenes` / `avoidWhen`）是人写的判断，
 * 不是能从 PNG 字节里算出来的东西（`analyzer.mjs` 明说 OCR 与向量检索未实现）。
 * 所以「把一个表情包导入成真正能用的图库」= 操作者给清单 + 压缩包给字节，两样对上号。
 *
 * 真正写库的逻辑在 `src/pack-import.mjs`（可被离线测试覆盖）；本脚本只负责读参数、
 * 决定可见作用域、打印结果、写证据文件。
 *
 * 用法：
 *   node plugins/companion-expression/scripts/import-pack.mjs \
 *     --pack plugins/companion-expression/packs/qq-232180.json \
 *     --zip "C:/Users/bobo/Documents/Bot/QQ-232180.zip" \
 *     [--owner 1429709395] [--group 145326153] [--no-owner] [--dry-run] [--json]
 *
 * 默认给**主人私聊**一行 `approved` 可见性；群默认沿用 `home/expression/config.json` 里
 * `capture.groups[].use === true` 的那些群，也可以用 `--group a,b` 显式指定。
 * 一个可见作用域都没有时脚本拒绝运行：一张谁都看不见的图入库等于没导入。
 *
 * 退出码：0 全部成功；1 有条目失败；2 参数/清单/压缩包层面的整体失败（一张都没导）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expressionPaths } from '../src/paths.mjs';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.mjs';
import { openExpressionDb } from '../src/db.mjs';
import { createLibrary } from '../src/library.mjs';
import { privateScope, groupScope } from '../src/scopes.mjs';
import { readZipEntries } from '../src/zip.mjs';
import { validatePackManifest } from '../src/pack.mjs';
import { importPack } from '../src/pack-import.mjs';
import { readOwner } from '../src/host-wiring.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

/**
 * 极简参数解析：`--key=value` 与 `--key value` 两种写法都认，`--flag` 当布尔。
 * 不引第三方：这个脚本只跑在操作者本机，参数形态就这么几种。
 */
function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const text = String(argv[index]);
    if (!text.startsWith('--')) continue;
    const body = text.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) { values.set(body.slice(0, eq), body.slice(eq + 1)); continue; }
    // 下一条不是 -- 开头，就把它当这个键的值（`--zip <路径>` 的自然写法）。
    const next = argv[index + 1] === undefined ? '' : String(argv[index + 1]);
    if (next && !next.startsWith('--')) { values.set(body, next); index += 1; continue; }
    flags.add(body);
  }
  return { flags, values };
}

function note(text) {
  console.log(`[import-pack] ${text}`);
}

const args = parseArgs(process.argv.slice(2));
const packArg = args.values.get('pack');
const zipArg = args.values.get('zip');
if (!packArg || !zipArg) {
  console.error('用法：node plugins/companion-expression/scripts/import-pack.mjs --pack <清单.json> --zip <压缩包.zip> [--dry-run]');
  process.exit(2);
}
const dryRun = args.flags.has('dry-run');
const asJson = args.flags.has('json');

/* ── 1. 清单与压缩包 ─────────────────────────────────────────────── */
const packFile = path.isAbsolute(packArg) ? packArg : path.resolve(repoRoot, packArg);
const zipFile = path.isAbsolute(zipArg) ? zipArg : path.resolve(repoRoot, zipArg);

let manifestRaw;
try {
  manifestRaw = JSON.parse(fs.readFileSync(packFile, 'utf8').replace(/^\uFEFF/, ''));
} catch (error) {
  console.error(`[import-pack] 读不出清单 ${packFile}：${String(error?.message ?? error).slice(0, 160)}`);
  process.exit(2);
}
const validated = validatePackManifest(manifestRaw);
if (!validated.ok) {
  console.error(`[import-pack] 清单不合法（${validated.reasonCode}）：${validated.message}`);
  process.exit(2);
}
const { pack, warnings: manifestWarnings } = validated;

let zipBytes;
try {
  zipBytes = fs.readFileSync(zipFile);
} catch (error) {
  console.error(`[import-pack] 读不出压缩包 ${zipFile}：${String(error?.message ?? error).slice(0, 160)}`);
  process.exit(2);
}
const listed = readZipEntries(zipBytes);
if (!listed.ok) {
  console.error(`[import-pack] 压缩包不能解析（${listed.reasonCode}）：${listed.message}`);
  process.exit(2);
}

/* ── 2. 活配置 + 库 ─────────────────────────────────────────────── */
const paths = expressionPaths({ moduleUrl: import.meta.url });
// 不直接无条件调 `loadConfig()`：它在文件缺失时会**写一份默认配置**。导入的职责是往图库加
// 素材，不是替主人决定配置长什么样 —— 所以只读已有文件，缺了就退回默认值（只影响读上限）。
let effective = DEFAULT_CONFIG;
const configSource = fs.existsSync(paths.configFile) ? paths.configFile : null;
if (configSource) effective = loadConfig({ file: paths.configFile, dataRoot: paths.dataRoot }).config ?? DEFAULT_CONFIG;
const maxBytes = Number(effective?.capture?.maxDownloadBytes ?? DEFAULT_CONFIG.capture.maxDownloadBytes);

const db = openExpressionDb({ file: paths.dbFile });
const library = createLibrary({ db, assetsDir: paths.assets });

/** 盐只读；没有盐说明这个库从没被插件打开过 —— 让宿主先跑一次，而不是这里自己生成。 */
const salt = db.meta('scope_salt');
if (!salt) {
  db.close();
  console.error(`[import-pack] 库里的 meta.scope_salt 是空的（${paths.dbFile}）：先让宿主把表情包模块跑起来一次，再导入。`);
  process.exit(2);
}

const owner = readOwner({ dataRoot: paths.dataRoot });
const ownerId = String(args.values.get('owner') ?? owner?.id ?? '').trim();

const visibility = [];
if (!args.flags.has('no-owner')) {
  if (!ownerId) {
    db.close();
    console.error('[import-pack] 认不出主人 QQ 号（identity.json 里没有 owner.id，也没给 --owner）。');
    process.exit(2);
  }
  visibility.push({
    scope: privateScope({ kind: 'owner_private', chatId: ownerId, salt }),
    approval: 'approved',
    label: `主人私聊（${ownerId}）`,
  });
}
const groupArg = args.values.get('group');
const groupIds = groupArg
  ? groupArg.split(',').map(text => String(Number(String(text).trim()))).filter(text => text !== '0' && text !== '')
  : (effective?.capture?.groups ?? []).filter(row => row.use === true).map(row => String(Number(row.chatId)));
for (const id of groupIds) {
  visibility.push({ scope: groupScope(id), approval: 'approved', label: `群 ${id}` });
}
if (visibility.length === 0) {
  db.close();
  console.error('[import-pack] 一个可见作用域都没有（--no-owner 且没有任何群）：这张图谁都看不见，不导。');
  process.exit(2);
}

note(`库：${paths.dbFile}`);
note(`配置：${configSource ?? '（没有配置文件，按默认值读上限）'}`);
note(`清单：${packFile}（${pack.entries.length} 条，packId=${pack.packId}）`);
note(`压缩包：${zipFile}（${listed.entries.length} 个条目）`);
note(`可见作用域：${visibility.map(row => row.label).join('、')}`);
if (effective?.capture?.groupEnabled !== true && groupIds.length > 0) {
  note('提示：config.capture.groupEnabled 不是 true，群作用域现在不会被群会话认作可用；可见性行照写，等主人把群开关打开就生效。');
}
for (const warning of manifestWarnings) note(`清单提示：${warning}`);

/* ── 3. 导入 ────────────────────────────────────────────────────── */
const result = importPack({ library, zipBytes, pack, visibility, maxBytes, dryRun });
if (result.skipped.length) note(`清单写了但包里没有（跳过）：${result.skipped.join('、')}`);
if (result.unlisted.length) note(`包里有但清单没写（不导）：${result.unlisted.join('、')}`);

const stats = library.stats();
const summary = {
  ok: result.ok,
  dryRun,
  packId: pack.packId,
  at: new Date().toISOString(),
  zip: zipFile,
  manifest: packFile,
  visibility: visibility.map(row => ({ scope: row.scope, label: row.label, approval: row.approval })),
  imported: result.imported,
  failed: result.failed,
  skipped: result.skipped,
  unlisted: result.unlisted,
  library: stats,
  rows: result.rows,
};

if (!asJson) {
  console.log('\n文件名'.padEnd(22) + ' 结果');
  for (const row of result.rows) {
    const verdict = row.ok
      ? `${row.assetId}${row.deduped ? '（已存在，补卡）' : ''} sha=${String(row.sha256).slice(0, 10)}… 可见性 ${row.visibility} 行 卡 ${row.card ? '有' : '无'}`
      : `失败 ${row.reasonCode}`;
    console.log(`${row.file.padEnd(22)} ${verdict}`);
  }
  console.log(`\n成功 ${result.imported} / ${result.rows.length}；图库现在：素材 ${stats.assets}、来源 ${stats.sources}、卡 ${stats.cards}、approved 可见性 ${stats.approvals}`);
  if (dryRun) console.log('（--dry-run：没有写库，也没有落文件。）');
  else if (!result.ok) console.log(`整体结果：有 ${result.failed} 张失败（${result.reasonCode}）。`);
}

const evidenceFile = path.join(paths.dataRoot, 'logs', `expression-import-${pack.packId}.json`);
fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
fs.writeFileSync(evidenceFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
if (!asJson) console.log(`证据：${evidenceFile}`);

db.close();
process.exit(result.ok ? 0 : 1);
