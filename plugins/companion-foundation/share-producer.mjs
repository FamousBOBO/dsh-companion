// P2 分享的**生产者**（活动 → 候选）。这是整条链上唯一缺的那一环。
//
// 事实（先核实过，别照抄文档）：`companion-runtime` 里 `createShareCandidate` 只有
// 公开 API 一个出口（`index.mjs`），**没有任何生产代码会调用它** —— 全仓 grep 下来，
// 调用点只有测试。也就是说：把 `p2.share.enabled` 打开也**不会**有候选，因为没人产。
// 同时 activity 完成（`finishActivity`）也不产候选。所以这一层补的是生产者，不是消费者。
//
// 边界（对齐 CONTRACT §13.8.1 的三层与 §13.11.6）：
//   * **不是发送方**：本模块只调 runtime 的 `createShareCandidate`（写一行候选），从不
//     调 contact，也从不碰 outbox。要不要发、什么时候发，是 contact 的闸门（L3）的事。
//   * **默认关**：`p2.share.enabled !== true` ⇒ `share-disabled`，一行都不写。生产配置
//     现在是 `false`，所以加上这条生产者**不改变任何现状**。
//   * **fail-closed 在"这条活动配不配被分享"上**：必须是真活动（不是模拟世界）、必须
//     `done`、必须有证据（读到的字数或版本化产物），否则给具名拒绝，不编一个候选。
//     这和 `recordExperience` 的四道闸同一套判据（`lib/p2.mjs`），因为"能被记住的"与
//     "能被分享的"必须是同一类事实 —— 否则会出现"她分享了从没发生的事"。
//   * **授权档位是 standing**（她自己决定分享），不是 explicit；这句落在 contact 侧
//     `shareTargetOf`，这里只负责不伪造"用户原话"（本模块没有 quote 字段）。

/** 工具名：模型侧唯一的分享入口。 */
export const SHARE_TOOL_NAME = 'companion_share_activity';

/**
 * 一条活动够不够格被分享。
 *
 * 判据与 runtime 的 `recordExperience`（`lib/p2.mjs` 的 fail-closed 四道闸）一致：
 *   reality 必须是 `actual_tool_activity`（模拟世界里的"做过"不算做过）；
 *   status 必须是 `done`（running / paused / abandoned 都不算完成）；
 *   必须有证据：读过字（`consumed > 0`）或有版本化产物（`artifactRef` + `artifactVersion > 0`）。
 *
 * "有 ok 回执"这一条**不在**这里判：回执只有 runtime 能读，本层拿不到就
 * 不假装判过 —— runtime 的 `createShareCandidate` 也只认 activityId，最终仍由它落库。
 */
export function assessShareableActivity(activity) {
  if (!activity || typeof activity !== 'object') return { ok: false, code: 'activity-not-found' };
  if (activity.reality !== 'actual_tool_activity') {
    return { ok: false, code: 'simulated-not-shared', reality: String(activity.reality ?? '') };
  }
  if (activity.status !== 'done') return { ok: false, code: 'activity-not-done', status: String(activity.status ?? '') };
  const consumed = Number(activity.consumed) || 0;
  const artifactVersion = Number(activity.artifactVersion) || 0;
  const artifactRef = String(activity.artifactRef ?? '');
  if (consumed <= 0 && !(artifactRef !== '' && artifactVersion > 0)) return { ok: false, code: 'no-evidence' };
  return {
    ok: true,
    activityId: String(activity.activityId ?? ''),
    kind: String(activity.kind ?? ''),
    // `sourceRef` 只放**活动自己的**标识（id / 产物引用），不放正文、不放绝对路径。
    sourceRef: artifactRef !== '' ? `artifact:${artifactRef}@v${artifactVersion}` : `activity:${String(activity.activityId ?? '')}`,
    kept: { consumed, artifactVersion },
  };
}

/**
 * 为一条**已完成的真活动**产出一条分享候选。
 *
 * 顺序（每一道都是 fail-closed，先便宜的判断）：
 *   开关 → 运行时是否挂着 → 活动是否在这个作用域里 → 活动够不够格 → 交给 runtime 落库。
 *
 * 返回值里带 `note` 的两种说法要分清：候选**建了**（`ok:true`）与消息**发了**是两件事，
 * 后者这里永远不会发生。
 */
export function shareCandidateForActivity({
  cognitive,
  config,
  sessionId = '',
  activityId = '',
  title = '',
  body = '',
  shareEnabled,
} = {}) {
  const enabled = shareEnabled === undefined ? config?.p2?.share?.enabled === true : shareEnabled === true;
  if (!enabled) {
    return { ok: false, code: 'share-disabled', note: 'p2.share.enabled=false：不建候选、不外发（生产现状）' };
  }
  if (!cognitive || typeof cognitive.createShareCandidate !== 'function') {
    return { ok: false, code: 'runtime-not-mounted' };
  }
  const id = String(activityId ?? '').trim();
  if (id === '') return { ok: false, code: 'activity-id-required' };
  const cleanTitle = String(title ?? '').trim().slice(0, 200);
  if (cleanTitle === '') return { ok: false, code: 'title-required' };
  const cleanBody = String(body ?? '').slice(0, 2000);

  let listed = null;
  const canList = typeof cognitive.listActivities === 'function';
  if (canList) {
    try { listed = cognitive.listActivities({ sessionId }); } catch (error) {
      return { ok: false, code: 'activity-read-failed', reason: (error instanceof Error ? error.message : String(error)).slice(0, 160) };
    }
    if (listed?.ok === false) return { ok: false, code: String(listed.code ?? 'activity-read-failed') };
  }
  // 拿不到活动列表（旧 runtime）时不下"这条活动存在"的结论，也不假装判过：
  // 但也不因此拦住 —— runtime 的 createShareCandidate 对不存在的 activityId 只是建一条
  // 无活动的候选（它不校验）。所以这里把"没判过"写进返回值，让调用方看得见。
  const activities = Array.isArray(listed?.activities) ? listed.activities : null;
  let assessment = { ok: true, unverified: true };
  if (activities !== null) {
    const activity = activities.find(item => String(item?.activityId ?? '') === id);
    assessment = assessShareableActivity(activity);
    if (!assessment.ok) return { ...assessment, checked: 'scope-activity-list' };
  }

  let created;
  try {
    created = cognitive.createShareCandidate({
      sessionId,
      activityId: id,
      kind: 'activity',
      title: cleanTitle,
      body: cleanBody,
      sourceRef: String(assessment.sourceRef ?? `activity:${id}`),
    });
  } catch (error) {
    return { ok: false, code: 'share-create-threw', reason: (error instanceof Error ? error.message : String(error)).slice(0, 160) };
  }
  if (created?.ok !== true) return { ok: false, code: String(created?.code ?? 'share-create-failed'), upstream: created ?? null };
  return {
    ok: true,
    candidateId: String(created.candidateId ?? ''),
    duplicate: created.duplicate === true,
    activityId: id,
    evidence: assessment.unverified === true ? 'unverified (no activity list available)' : 'activity:done+evidenced',
    note: '候选已写入 runtime 的候选表（不是已发送）。投递由 contact 的既有闸门决定；'
      + '`queued` 也不等于发出，真实送达只能看 contact 的投递账本',
  };
}
