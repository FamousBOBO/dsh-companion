/**
 * 整包导入的执行层：把「清单 + 压缩包字节」翻译成一串图库写入。
 *
 * 为什么和 `pack.mjs` 分开：`pack.mjs` 只做**纯校验**（清单长什么样才合法），这一层才真正
 * 调 `library.receive()` / `register()` / `upsertCard()` 并落盘。分开之后离线测试可以在
 * 临时目录 + `:memory:` 库里把整条导入路径跑一遍，而 CLI 脚本只负责读参数、打印和写证据。
 *
 * 一条**不可绕过**的边界：只用 library 的公开方法。直接写 SQL 会绕过 `APPROVALS` 的审核态
 * 校验，那正是审核态唯一的意义；而 `hardGate()`（retrieval.mjs）只放行 `approved`，
 * 所以导入时给的审核态必须是 `approved`，否则这张图入库了也永远发不出去。
 */
import { validateImage } from './security.mjs';
import { readZipEntries, extractZipFile } from './zip.mjs';
import { cardForEntry, reconcilePack } from './pack.mjs';
import { assetIdFor, sha256Of } from './library.mjs';

/**
 * 导入整包。
 *
 * @param {{
 *   library: object, zipBytes: Buffer|Uint8Array, pack: object,
 *   visibility: Array<{scope: string, approval: string, label?: string}>,
 *   maxBytes?: number, dryRun?: boolean,
 * }} options `library` 必须是 `library.mjs` 的句柄；`visibility` 至少要有一行。
 * @returns {{ok: boolean, reasonCode: string, message: string, rows: object[],
 *   imported: number, failed: number, skipped: string[], unlisted: string[]}}
 */
export function importPack({ library, zipBytes, pack, visibility = [], maxBytes = 10 * 1024 * 1024, dryRun = false } = {}) {
  if (!library || typeof library.receive !== 'function') {
    return failure('library-unavailable', '没有图库句柄。');
  }
  const rows = [];

  const listed = readZipEntries(zipBytes);
  const zipNames = listed.ok ? listed.entries.map(entry => entry.name) : [];
  const reconciled = reconcilePack({ pack, zipNames });
  const base = { skipped: reconciled.missing, unlisted: reconciled.extra };
  if (!reconciled.ok) return { ...failure(reconciled.reasonCode, reconciled.message), ...base, rows };

  const approved = visibility.filter(row => row && String(row.scope ?? '').trim());
  if (approved.length === 0) {
    return { ...failure('visibility-empty', '一个可见作用域都没有：这张图谁都看不见，不导。'), ...base, rows };
  }

  for (const item of reconciled.plan) {
    const entry = item.entry;
    const row = {
      file: entry.file, ok: false, reasonCode: '', assetId: null, sha256: null,
      deduped: false, createdFile: false, card: false, visibility: 0, source: false,
    };
    const extracted = extractZipFile(zipBytes, item.file);
    if (!extracted.ok) {
      row.reasonCode = extracted.reasonCode;
      rows.push(row);
      continue;
    }
    const checked = validateImage({ bytes: extracted.bytes, maxBytes });
    if (!checked.ok) {
      row.reasonCode = checked.reasonCode;
      rows.push(row);
      continue;
    }
    // dry-run 必须在**这一步之前**就掉头：`library.receive()` 会真的落文件、真的插一行素材。
    // 「预演」如果写了库，那它就不是预演 —— 用户以为只是看一眼，库却已经变了。
    if (dryRun) {
      row.assetId = assetIdFor(sha256Of(extracted.bytes));
      row.sha256 = sha256Of(extracted.bytes);
      row.deduped = library.getAsset(row.assetId) !== null;
      row.ok = true;
      rows.push(row);
      continue;
    }

    const received = library.receive({
      bytes: extracted.bytes,
      format: checked.format,
      width: checked.width,
      height: checked.height,
      // 命令行的导入是操作者显式的动作，不是「抓来的图」：审核态直接给 approved。
      // review 会让 retrieval.mjs 的硬门永远拒发，导了也用不了。
      moderationState: 'approved',
    });
    if (!received.ok) {
      row.reasonCode = received.reasonCode;
      rows.push(row);
      continue;
    }
    row.assetId = received.assetId;
    row.sha256 = received.sha256;
    row.deduped = received.deduped;
    row.createdFile = received.createdFile;
    row.ok = true;

    // 来源：这份图是**操作者**交进来的，不是从某个群的聊天里抓的。consentRef 写明来源，
    // 将来审计时「这图哪来的」必须答得出来；sourceMessageHash 由包名 + 文件名派生，
    // 保证重跑导入不会造出第二行来源（attachSource 的 ON CONFLICT 正好接住它）。
    const originScope = (approved.find(item2 => item2.scope.startsWith('owner_private:')) ?? approved[0]).scope;
    const registered = library.register({
      assetId: row.assetId,
      sources: [{
        originScope,
        sourceMessageHash: sha256Of(`${pack?.packId ?? ''}:${entry.file}`).slice(0, 32),
        senderHash: null,
        consentRef: `operator-import:${pack?.packId ?? ''}:${entry.file}`.slice(0, 120),
      }],
      visibility: approved.map(item2 => ({ scope: item2.scope, approval: item2.approval })),
    });
    if (!registered.ok) {
      row.ok = false;
      row.reasonCode = `register-${registered.reasonCode}`;
      rows.push(row);
      continue;
    }
    row.source = true;
    row.visibility = registered.visibility;

    const carded = library.upsertCard(row.assetId, cardForEntry(entry));
    row.card = carded.ok === true;
    if (!carded.ok) {
      row.ok = false;
      row.reasonCode = `card-${carded.reasonCode}`;
    }
    rows.push(row);
  }

  const imported = rows.filter(row => row.ok).length;
  const failed = rows.length - imported;
  return {
    ok: failed === 0,
    reasonCode: failed === 0 ? '' : 'rows-failed',
    message: failed === 0 ? '' : `${failed} 张没导成。`,
    rows, imported, failed, ...base,
  };
}

function failure(reasonCode, message) {
  return { ok: false, reasonCode, message, rows: [], imported: 0, failed: 0, skipped: [], unlisted: [] };
}

export default { importPack };
