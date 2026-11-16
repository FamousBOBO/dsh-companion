// 陪伴空间 · 作品中心的两个只读入口（W3）。
//
//   GET /works?q=&type=&status=&from=&to=
//       列表：现场派生（每次读都从既有证据重建），不落盘索引。
//   GET /work-detail?path=<relative>
//       预览：文本、按 256 KiB 截断上限判定；越界/符号链接/二进制/超大一律 fail-closed。
//
// 两者都是**只读**：没有 POST，也不接受绝对路径参数。

import { buildWorksIndex, filterWorks, readWorkPreview, WORK_STATUSES } from './works-artifacts.mjs';
import { scopeKey } from '../../companion-runtime/lib/scope.mjs';

/** 列表。 */
export async function worksIndex(request, kernel) {
  const viewer = kernel.viewer(await kernel.internal());
  const url = new URL(request.url);
  const scope = scopeKey(viewer);
  const index = buildWorksIndex({ root: kernel.root, scope });
  if (!index.available) {
    // 目录本身不存在：如实说是"还没建起来"，不是"没有作品"。
    return kernel.ok({
      available: false,
      reason: index.reason,
      root: index.root,
      evidence: index.evidence,
      total: 0,
      items: [],
      filters: {},
      skipped: 0,
      skippedReasons: {},
      observedAt: new Date().toISOString(),
    });
  }
  const filters = {
    q: String(url.searchParams.get('q') ?? '').slice(0, 120),
    type: String(url.searchParams.get('type') ?? '').slice(0, 12),
    status: String(url.searchParams.get('status') ?? '').slice(0, 12),
    from: String(url.searchParams.get('from') ?? '').slice(0, 32),
    to: String(url.searchParams.get('to') ?? '').slice(0, 32),
  };
  if (filters.status && !WORK_STATUSES.includes(filters.status)) filters.status = '';
  const matched = filterWorks(index.items, filters);
  return kernel.ok({
    available: true,
    reason: '',
    root: index.root,
    evidence: index.evidence,
    total: matched.length,
    // `total` 是全量命中数，`items` 是这一页；前端要显示"还有多少没显示"。
    items: matched.slice(0, 100),
    filters,
    skipped: index.skipped,
    skippedReasons: index.skippedReasons,
    statuses: WORK_STATUSES,
    observedAt: new Date().toISOString(),
  });
}

/** 预览。 */
export async function workDetail(request, kernel) {
  const viewer = kernel.viewer(await kernel.internal());
  const url = new URL(request.url);
  const relative = String(url.searchParams.get('path') ?? '').slice(0, 200);
  if (!relative) {
    return kernel.ok({ ok: false, reason: 'path-required', meta: null, observedAt: new Date().toISOString() });
  }
  const scope = scopeKey(viewer);
  const result = readWorkPreview({ root: kernel.root, scope, relative });
  return kernel.ok({ ...result, observedAt: new Date().toISOString() });
}
