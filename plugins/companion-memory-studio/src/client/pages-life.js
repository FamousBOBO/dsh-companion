// 生活与日程（page id: life）
//
// 契约：design/ui-redesign-20261030-shell-contract.md。
// 这一页只回答三件事：她现在在做什么、接下来还有什么、今天已经过去的段落是什么样。
// 数据全部来自 GET companion 的 life / sections.goals / sections.commitments；
// 锁定 / 解锁 / 跳过 走 POST plan-slot，只有运行库回了回执才刷新界面，绝不乐观更新。
// 技术字段（plan 版本、switches、receipts、slotId、状态说明）只出现在页尾的 ui.Diagnostic 里。
//
// 表达约定（2026-10-31 视觉返工）：
//   * 「现在」只有一行状态 + 有活动时才列活动行，解释性长句进分区 hint 或诊断；
//   * 状态词跟着分组走：接下来 = 计划中 / 已锁定；已结束 = 已结束 / 未完成；已跳过 = 已跳过；
//   * 过去的三组各自是一个 ui.Band，不再套三层标题。
(function (P) {
  const { h, ui } = P;

  P.css(`
    .cpxp-life-stack { display:flex; flex-direction:column; min-width:0; }
    .cpxp-life-status { display:inline; }
    .cpxp-life-state { display:flex; align-items:baseline; gap:var(--cpx-s2,8px); flex-wrap:wrap; margin:0; min-width:0; }
    .cpxp-life-note,
    .cpxp-life-empty { margin:0; max-width:72ch; color:var(--dsw-alias-label-secondary, inherit); font-size:var(--cpx-fs-small, 12.5px); line-height:1.7; overflow-wrap:anywhere; min-width:0; }
    .cpxp-life-title { font-weight:600; overflow-wrap:anywhere; min-width:0; }
    .cpxp-life-meta { display:inline-flex; align-items:baseline; flex-wrap:wrap; gap:0 var(--cpx-s1,4px); max-width:100%; min-width:0; color:var(--dsw-alias-label-secondary, inherit); font-size:var(--cpx-fs-small, 12.5px); line-height:1.6; overflow-wrap:anywhere; }
    .cpxp-life-wrap { overflow-wrap:anywhere; word-break:normal; white-space:normal; }
    .cpxp-life-range { display:inline-flex; align-items:baseline; gap:var(--cpx-s1,4px); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .cpxp-life-side { display:inline-flex; align-items:center; gap:var(--cpx-s2,8px); flex-wrap:wrap; min-width:0; }
    .cpxp-life-actions { display:inline-flex; align-items:center; gap:var(--cpx-s1,4px); flex-wrap:wrap; min-width:0; }
    .cpxp-life-acts { display:flex; flex-direction:column; gap:var(--cpx-s3,12px); margin:var(--cpx-s1,4px) 0 0; min-width:0; }
    .cpxp-life-act { display:flex; flex-direction:column; gap:var(--cpx-s1,4px); min-width:0; }
    .cpxp-life-act-head { display:flex; align-items:baseline; gap:var(--cpx-s2,8px); flex-wrap:wrap; min-width:0; }
    .cpxp-life-meter { max-width:360px; min-width:140px; margin-top:var(--cpx-s1,4px); }
    .cpxp-life-subhead { margin:var(--cpx-s3,12px) 0 0; color:var(--dsw-alias-label-secondary, inherit); font-size:var(--cpx-fs-small, 12.5px); font-weight:600; letter-spacing:.3px; }
    .cpxp-life-diag-block { display:flex; flex-direction:column; gap:var(--cpx-s2,8px); min-width:0; }
    @media (max-width:720px) {
      .cpxp-life-meter { max-width:none; }
      .cpxp-life-actions { justify-content:flex-end; }
    }
  `);

  // ---------------------------------------------------------------------------
  // 词表：数据库里的英文枚举在页面上一律翻成中文，认不出来的原样显示，不猜。
  // ---------------------------------------------------------------------------

  const DASH = '—';

  const STATE_LABEL = {
    running: '正在做',
    resting: '休息中',
    upcoming: '还有安排',
    'today-done': '今天已结束',
    // 计划排完了、今天还没结束：这既不是「今天已结束」，也不是「还有安排」。
    'plan-exhausted': '计划已排完',
    'no-plan': '今天还没有安排',
    'no-autonomy': '自主规划未启用',
  };

  // 长解释只进诊断；正文和分区 hint 保持一句话。
  const STATE_EXPLAIN = {
    running: '运行库报告了进行中的活动，只有 actual_tool_activity 才算真实活动。',
    resting: '这一段排的是休息，不需要产出。',
    upcoming: '后面的时间段还没有发生，可以锁定或跳过其中一段。',
    'today-done': '今天不再有接下来的时间段，已经过去的都在下面。',
    'plan-exhausted': '这一版计划排的时段都已经过去，但今天还没结束；规划侧没有补充新的时段。',
    'no-plan': '自主规划开关是开的，但今天还没有生成计划；下一次规划之后才会有安排。',
    'no-autonomy': '自主规划开关是关的，所以今天不会有时间段（开关在运行库配置里，不在这一页改）。',
  };

  const KIND_LABEL = { activity: '活动', open: '自由安排', rest: '休息' };
  const ACTIVITY_LABEL = { read: '阅读', explore: '探索', write: '创作', bilibili: '刷 B 站' };
  // 经历投影里的 kind（活动的种类，不是时段的种类）。
  const EXPERIENCE_KIND = ACTIVITY_LABEL;
  const STATUS_LABEL = { planned: '待开始', started: '进行中', running: '进行中', paused: '暂停', done: '已完成', skipped: '已跳过' };
  const GOAL_STATUS_LABEL = { proposed: '刚提出', accepted: '已接受', running: '进行中', paused: '暂停', completed: '已完成', cancelled: '已取消' };
  const COMMITMENT_STATUS_LABEL = { open: '还没做', closed: '已完成' };

  const ACTION_LABEL = { lock: '锁定', unlock: '解锁', skip: '跳过' };
  const ACTION_HINT = {
    lock: '锁住这一段：之后的重新规划不会改动它',
    unlock: '解锁这一段：重新规划时可以再调整',
    skip: '跳过这一段：今天不再安排它',
  };
  const ACTION_REASON = {
    lock: '用户在「生活与日程」页锁定这一段',
    unlock: '用户在「生活与日程」页解锁这一段',
    skip: '用户在「生活与日程」页跳过这一段',
  };

  // 未知值显示破折号，不显示 0。
  const text = (value) => (value === null || value === undefined || value === '' ? DASH : String(value));
  const onOff = (value) => (value === true ? '已启用' : value === false ? '未启用' : DASH);
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  // 槽没有标题时给一句人话，不要把空字符串渲染成空白条目。
  const slotTitle = (slot) => (slot && slot.title ? String(slot.title) : '（这一段没有标题）');

  function minutesOf(slot) {
    const value = slot && slot.minutes;
    if (!finite(value)) return DASH;
    if (value <= 0) return '不足 1 分钟';
    return `${value} 分钟`;
  }

  function kindOf(slot) {
    if (!slot) return DASH;
    if (slot.kind === 'activity') return ACTIVITY_LABEL[slot.activity] || (slot.activity ? String(slot.activity) : KIND_LABEL.activity);
    return KIND_LABEL[slot.kind] || text(slot.kind);
  }

  // 时间区间统一走 P.fmt.range（同日省略日期、跨日带日期）；认不出就显示破折号。
  function rangeLabel(slot) {
    const start = slot ? Number(slot.startAt) : NaN;
    const end = slot ? Number(slot.endAt) : NaN;
    if (!finite(start) || !finite(end)) return DASH;
    return P.fmt.range(start, end);
  }

  // 状态词跟着**结果**走，不跟数据库的行状态走：运行库把一段做完之后行状态仍可能是
  // `started`，只看 status 就会把有 finish 回执的一段显示成「未完成」（生产事故）。
  // 结果词表来自 life payload 的 `outcome`，这里只做兜底翻译。
  const OUTCOME_BADGE = {
    completed: { text: '已完成', tone: 'ok' },
    'rest-ended': { text: '已结束（休息）', tone: 'neutral' },
    review: { text: '待复核', tone: 'warn' },
    missed: { text: '未完成', tone: 'warn' },
    skipped: { text: '已跳过', tone: 'warn' },
    upcoming: { text: '计划中', tone: 'neutral' },
  };

  function groupBadge(group, slot) {
    const outcome = slot && typeof slot.outcome === 'string' ? slot.outcome : '';
    if (group === 'next') {
      return outcome === 'skipped'
        ? OUTCOME_BADGE.skipped
        : { text: '计划中', tone: 'neutral' };
    }
    // 窗口内还没结束、而且活动正在跑：这说明的是「进行中」，不是「未完成」。
    if (outcome === 'upcoming' && slot && (slot.live === 'running' || slot.live === 'paused')) {
      return { text: '进行中', tone: 'brand' };
    }
    if (OUTCOME_BADGE[outcome]) return OUTCOME_BADGE[outcome];
    // 旧 payload 没有 outcome 时的兜底：只有 done 才算结束，其余也不谎称未完成。
    const status = slot && slot.status;
    if (status === 'done') return { text: '已结束', tone: 'ok' };
    if (status === 'skipped') return { text: '已跳过', tone: 'warn' };
    return { text: '未完成', tone: 'warn' };
  }

  // ---------------------------------------------------------------------------
  // 小部件
  // ---------------------------------------------------------------------------

  function TimeRange({ slot }) {
    const start = slot ? Number(slot.startAt) : NaN;
    const end = slot ? Number(slot.endAt) : NaN;
    if (!finite(start) || !finite(end)) return h('span', { className: 'cpxp-life-range' }, DASH);
    return h('span', {
      className: 'cpxp-life-range',
      title: `${P.fmt.dateTime(start)} – ${P.fmt.dateTime(end)}`,
    }, P.fmt.range(start, end));
  }

  // 时间区间 · 类型 · 时长；状态交给徽标，不在这里重复。
  function SlotMeta({ slot }) {
    const round = slot.bilibiliRound;
    const result = round && ({ completed: '轮次已结束', failed: '轮次失败', unknown: '轮次结果未知', 'quota-exhausted': '今日额度已用完' })[round.status];
    return h('span', { className: 'cpxp-life-meta' },
      h(TimeRange, { slot }),
      ' · ',
      kindOf(slot),
      ' · ',
      minutesOf(slot),
      result ? ` · ${result} · 确认消费 ${round.watched} 条` : null);
  }

  // 自主排的时段是她自己的安排，不是用户约定的日程；「已约好」只属于 H1 那几项。
  const isSelf = (slot) => !slot || slot.origin === 'self' || slot.origin === undefined;

  function SlotRow({ slot, badge, note }) {
    const locked = Boolean(slot && slot.locked);
    const self = isSelf(slot);
    const hasSide = Boolean(badge) || locked || self || Boolean(note);
    return h(ui.Row, {
      title: slotTitle(slot),
      meta: h(SlotMeta, { slot }),
      side: hasSide
        ? h('span', { className: 'cpxp-life-side' },
          badge ? h(ui.Badge, { tone: badge.tone }, badge.text) : null,
          self ? h(ui.Badge, { tone: 'neutral' }, '自主') : null,
          locked ? h(ui.Badge, { tone: 'warn' }, '已锁定') : null,
          note ? h('span', { className: 'cpxp-life-meta' }, note) : null)
        : undefined,
      ariaLabel: `${badge ? badge.text : '安排'}：${slotTitle(slot)}，${self ? '她自己的安排，' : ''}${kindOf(slot)}，${minutesOf(slot)}，${rangeLabel(slot)}${locked ? '，已锁定' : ''}`,
    });
  }

  function NextRow({ slot, busy, planEnabled, disabledReason, onAction }) {
    const controls = Array.isArray(slot && slot.controls) ? slot.controls : [];
    const actions = controls.map((action) => h(ui.Button, {
      key: action,
      size: 'sm',
      variant: 'ghost',
      loading: Boolean(busy) && busy.slotId === slot.slotId && busy.action === action,
      disabled: Boolean(busy) || !planEnabled,
      title: planEnabled ? ACTION_HINT[action] : disabledReason,
      onClick: () => { if (typeof onAction === 'function') onAction(slot, action); },
    }, ACTION_LABEL[action] || action));
    return h(ui.Row, {
      title: slotTitle(slot),
      meta: h(SlotMeta, { slot }),
      side: h('span', { className: 'cpxp-life-side' },
        h(ui.Badge, { tone: 'neutral' }, '计划中'),
        h(ui.Badge, { tone: 'neutral' }, '自主'),
        slot.locked ? h(ui.Badge, { tone: 'warn' }, '已锁定') : null,
        actions.length
          ? h('span', { className: 'cpxp-life-actions', role: 'group', 'aria-label': `调整「${slotTitle(slot)}」` }, actions)
          : null),
      ariaLabel: `接下来的安排：${slotTitle(slot)}，${kindOf(slot)}，${minutesOf(slot)}，${rangeLabel(slot)}${slot.locked ? '，已锁定' : ''}`,
    });
  }

  function ActivityItem({ activity }) {
    // 只有 actual_tool_activity 才叫真实活动；其余一律按模拟/假设标注。
    const real = activity.reality === 'actual_tool_activity';
    const consumed = finite(activity.consumed) ? activity.consumed : null;
    const total = finite(activity.total) && activity.total > 0 ? activity.total : null;
    const updatedAt = activity.updatedAt;
    return h('div', { className: 'cpxp-life-act', role: 'listitem' },
      h('div', { className: 'cpxp-life-act-head' },
        h(ui.Badge, { tone: real ? 'ok' : 'warn' }, real ? '真实活动' : '模拟/假设'),
        h('span', { className: 'cpxp-life-title' }, ACTIVITY_LABEL[activity.kind] || text(activity.kind)),
        activity.target ? h('span', { className: 'cpxp-life-meta cpxp-life-wrap' }, activity.target) : null,
        h('span', { className: 'cpxp-life-meta' },
          text(STATUS_LABEL[activity.status] || activity.status),
          ' · 更新 ',
          finite(updatedAt) ? h(ui.Timestamp, { at: updatedAt }) : DASH)),
      consumed !== null && total !== null
        ? h('div', { className: 'cpxp-life-meter' },
          h(ui.Meter, {
            value: consumed,
            max: total,
            label: `进度 ${P.fmt.number(consumed)} / ${P.fmt.number(total)}`,
            tone: real ? 'ok' : 'warn',
          }))
        : h('p', { className: 'cpxp-life-note' }, `进度：${DASH}`));
  }

  function GoalRow({ goal }) {
    const status = String(goal.status || '');
    const hasDeadline = goal.deadline_at !== null && goal.deadline_at !== undefined && finite(Number(goal.deadline_at));
    const deadline = hasDeadline ? Number(goal.deadline_at) : null;
    const closed = status === 'completed' || status === 'cancelled';
    const overdue = hasDeadline && !closed && deadline <= Date.now();
    const tone = status === 'completed' ? 'ok' : overdue ? 'danger' : status === 'paused' ? 'warn' : status === 'cancelled' ? 'neutral' : 'brand';
    return h(ui.Row, {
      title: text(goal.title) === DASH ? '（这个目标没有标题）' : goal.title,
      meta: h('span', { className: 'cpxp-life-meta cpxp-life-wrap' },
        h(ui.Badge, { tone }, GOAL_STATUS_LABEL[status] || text(status)),
        overdue ? h(ui.Badge, { tone: 'danger' }, '已过期') : null,
        h('span', { className: 'cpxp-life-wrap' }, ' 下一步：', goal.next_step ? goal.next_step : `还没有写下${DASH}`),
        h('span', { className: 'cpxp-life-wrap' }, ' · 等待：', goal.waiting_on ? goal.waiting_on : '没有在等什么')),
      side: h('span', { className: 'cpxp-life-side' },
        h('span', { className: 'cpxp-life-meta' }, '截止 '),
        hasDeadline ? h(ui.Timestamp, { at: deadline }) : '没有截止时间'),
      ariaLabel: `目标：${text(goal.title)}，${GOAL_STATUS_LABEL[status] || '状态未知'}${overdue ? '，已过期' : ''}`,
    });
  }

  function CommitmentRow({ commitment }) {
    const status = String(commitment.status || '');
    const hasDue = commitment.due_at !== null && commitment.due_at !== undefined && finite(Number(commitment.due_at));
    const due = hasDue ? Number(commitment.due_at) : null;
    const overdue = hasDue && status === 'open' && due <= Date.now();
    return h(ui.Row, {
      title: text(commitment.body) === DASH ? '（这条承诺没有写内容）' : commitment.body,
      meta: h('span', { className: 'cpxp-life-meta' },
        h(ui.Badge, { tone: status === 'closed' ? 'ok' : overdue ? 'danger' : 'neutral' }, COMMITMENT_STATUS_LABEL[status] || text(status)),
        overdue ? h(ui.Badge, { tone: 'danger' }, '已到期') : null),
      side: h('span', { className: 'cpxp-life-side' },
        h('span', { className: 'cpxp-life-meta' }, '到期 '),
        hasDue ? h(ui.Timestamp, { at: due }) : '没有到期时间'),
      ariaLabel: `承诺：${text(commitment.body)}，${COMMITMENT_STATUS_LABEL[status] || '状态未知'}${overdue ? '，已到期' : ''}`,
    });
  }

  // ---------------------------------------------------------------------------
  // 分区
  // ---------------------------------------------------------------------------

  function BandNow({ life }) {
    const current = life.current || {};
    const slot = current.slot || null;
    const activities = Array.isArray(current.activities) ? current.activities : [];
    const interests = Array.isArray(life.interests) ? life.interests : [];
    const next = Array.isArray(life.next) ? life.next : [];
    const state = typeof life.state === 'string' ? life.state : '';
    const upcoming = next[0] || null;
    // 没有当前段落时只留一行：要么说下一段在什么时候，要么说今天没有更多安排。
    const quiet = upcoming
      ? `现在没有进行中的段落；下一段 ${P.fmt.range(upcoming.startAt, upcoming.endAt)}。`
      : state === 'today-done'
        ? '今天没有更多安排了。'
        : '现在没有进行中的段落。';
    return h(ui.Band, {
      title: '现在',
      info: '进行中的活动来自运行库回执；计划只是打算，没有回执的事不会被当成已经发生。',
      flush: true,
    },
    h('div', { className: 'cpxp-life-state' },
      h(ui.StateLine, { state: P.lifeTone(state), text: STATE_LABEL[state] || '状态未知' })),
    slot ? h(SlotRow, { key: 'current', slot }) : h('p', { className: 'cpxp-life-empty' }, quiet),
    activities.length
      ? h('div', { className: 'cpxp-life-acts', role: 'list', 'aria-label': '进行中的活动' },
        activities.map((activity, index) => h(ActivityItem, {
          key: activity.activityId || `act:${index}`,
          activity,
        })))
      : null,
    interests.length
      ? h('p', { className: 'cpxp-life-note' },
        '她最近想做的事：',
        interests.map((item) => text(item.title)).join('、'))
      : null);
  }

  function BandNext({ life, busy, onAction, notice }) {
    const plan = life.plan || null;
    const next = Array.isArray(life.next) ? life.next : [];
    const state = typeof life.state === 'string' ? life.state : '';
    const planEnabled = !(life.planControls && life.planControls.enabled === false);
    const hint = plan && plan.summary ? plan.summary : '';
    // 计划排完但今天还没结束，与「今天已结束」是两件事；空状态必须说真话。
    const reason = typeof life.reason === 'string' && life.reason ? life.reason : '';
    return h(ui.Band, {
      title: '接下来',
      hint,
      info: '锁定后重新规划不会改动这一段，跳过会把它标记为已跳过；两者都要运行库回了回执才算生效，历史段落不能改。',
    },
      notice || null,
      planEnabled ? null : h('p', { className: 'cpxp-life-note' }, '自主规划关着，按钮暂不生效。'),
      next.length
        ? h(ui.List, { label: '接下来的安排列表' }, next.map((slot, index) => h(NextRow, {
          key: slot.slotId || `${slot.startAt}:${index}`,
          slot,
          busy,
          planEnabled,
          disabledReason: '自主规划关着，暂时不能调整',
          onAction,
        })))
        : (state === 'no-autonomy'
          ? h(ui.Empty, { title: '她今天没有自己排日程', hint: reason || '自主规划关着。' })
          : state === 'plan-exhausted'
            ? h(ui.Empty, { title: '计划已经排完，今天还没结束', hint: reason || '剩下的时间没有新安排。' })
            : state === 'today-done'
              ? h(ui.Empty, { title: '今天的安排都结束了', hint: reason || '已经过去的都在下面。' })
              : plan
                ? h(ui.Empty, { title: '今天没有更多安排了', hint: reason || '剩下的时间可以留白。' })
                : h(ui.Empty, { title: '今天还没有日程', hint: reason || '规划开着，还没生成计划。' })));
  }

  // 全天时段：整份计划的时段表。`next` 为空时它仍然在——计划不会因为「没有下一段」而从
  // 页面上消失，用户可以自己看到今天到底排了什么、每一段是什么结果。
  const PLAN_STATUS_LABEL = { committed: '已提交', empty: '空计划', superseded: '已被取代' };

  function BandToday({ life }) {
    const today = Array.isArray(life.today) ? life.today : [];
    const plan = life.plan || null;
    const planStatus = typeof life.planStatus === 'string' && life.planStatus
      ? life.planStatus
      : (plan && plan.status ? String(plan.status) : '');
    if (!plan && !today.length) return null;
    const statusText = PLAN_STATUS_LABEL[planStatus] || (planStatus || DASH);
    return h(ui.Band, {
      title: '全天时段',
      hint: plan ? `第 ${text(plan.version)} 版计划（${statusText}）：${today.length} 段` : '',
      info: '这些时段是她自己排的，不是用户约定的日程；「已约好」只属于约定项。',
      flush: true,
    },
    today.length
      ? h(ui.List, { label: '全天时段列表' }, today.map((slot, index) => h(SlotRow, {
        key: slot.slotId || `${slot.startAt}:${index}`,
        slot,
        badge: groupBadge('today', slot),
      })))
      : h('p', { className: 'cpxp-life-empty' }, '这一版计划没有时段。'));
  }
  // 过去的三组各自成段：不再套「今天已经过去的」再套三个小标题。
  function pastRows(list, group) {
    return list.map((slot, index) => h(SlotRow, {
      key: slot.slotId || `${slot.startAt}:${index}`,
      slot,
      badge: groupBadge(group, slot),
    }));
  }

  function BandEnded({ life }) {
    // 已经在「已跳过」里出现过的段落不再重复列一次；只在这一组里出现的跳过段仍然列出，
    // 徽标写「已跳过」，不会被悄悄吞掉。
    const skipped = Array.isArray(life.skipped) ? life.skipped : [];
    const listedElsewhere = new Set(skipped.map((slot) => slot && slot.slotId));
    const ended = (Array.isArray(life.ended) ? life.ended : [])
      .filter((slot) => !(slot && slot.status === 'skipped' && listedElsewhere.has(slot.slotId)));
    return h(ui.Band, { title: '今天已结束' },
      ended.length
        ? h(ui.List, { label: '今天已结束的安排列表' }, pastRows(ended, 'ended'))
        : h('p', { className: 'cpxp-life-empty' }, '今天还没有结束任何一段。'));
  }

  function BandPending({ life }) {
    const pending = Array.isArray(life.pending) ? life.pending : [];
    return h(ui.Band, { title: '未完成待续' },
      pending.length
        ? h(ui.List, { label: '未完成待续的安排列表' }, pastRows(pending, 'pending'))
        : h('p', { className: 'cpxp-life-empty' }, '没有漏掉的段落。'));
  }

  function BandSkipped({ life }) {
    const skipped = Array.isArray(life.skipped) ? life.skipped : [];
    return h(ui.Band, { title: '已跳过' },
      skipped.length
        ? h(ui.List, { label: '已跳过的安排列表' }, pastRows(skipped, 'skipped'))
        : h('p', { className: 'cpxp-life-empty' }, '今天没有跳过任何安排。'));
  }

  /**
   * 最近经历（P2.5-2 E7）：**只读投影**，不是权威状态。
   *
   * 三件事仍然要在，但不占正文：① 标题里写"只读投影"；② "不是权威状态"的解释收进 ⓘ；
   * ③ 空的时候说"暂无经历"，而不是留一块空白（空白读不出"确实没发生"还是"页面坏了"）。
   */
  function BandExperience({ experience }) {
    const view = experience && typeof experience === 'object' ? experience : null;
    const items = view && Array.isArray(view.items) ? view.items : [];
    const info = view && view.note
      ? String(view.note)
      : '只读投影：由活动与回执派生，不是权威状态（权威是事件书与 runner）。';
    const bandProps = { title: '最近经历（只读投影）', info };
    if (!items.length) {
      return h(ui.Band, bandProps,
        h(ui.Empty, { title: '暂无经历', hint: '还没有已经结束的活动。' }));
    }
    return h(ui.Band, bandProps,
      h(ui.List, { label: '最近经历列表' }, items.map((item, index) => h('li', {
        key: item.activityId || `experience:${index}`,
        className: 'cpxp-life-row',
      },
      h('div', { className: 'cpxp-life-row-main' },
        h(ui.Badge, { tone: item.tone || 'neutral' }, item.resultLabel || text(item.result)),
        h('span', { className: 'cpxp-life-title' }, EXPERIENCE_KIND[item.kind] || text(item.kind)),
        item.target ? h('span', { className: 'cpxp-life-meta' }, item.target) : null,
        item.simulated ? h(ui.Badge, { tone: 'warn' }, '模拟/假设') : null),
      h('div', { className: 'cpxp-life-row-side' },
        h('span', { className: 'cpxp-life-meta' }, item.source ? `来源 ${item.source}` : '来源未知'),
        finite(item.at) ? h(ui.Timestamp, { at: item.at }) : h('span', { className: 'cpxp-life-meta' }, DASH))))));
  }

  function BandGoals({ goals, unavailable }) {
    const list = Array.isArray(goals) ? goals : [];
    if (unavailable.indexOf('goals') >= 0) {
      return h(ui.Band, { title: '目标' },
        h(ui.Empty, { title: '这个运行库还没有目标表' }));
    }
    return h(ui.Band, { title: '目标' },
      list.length
        ? h(ui.List, { label: '目标列表' }, list.map((goal, index) => h(GoalRow, {
          key: goal.goal_id || `goal:${index}`,
          goal,
        })))
        : h(ui.Empty, { title: '还没有目标记录', hint: '她接受目标后才会出现在这里。' }));
  }

  function BandCommitments({ commitments, unavailable }) {
    const list = Array.isArray(commitments) ? commitments : [];
    if (unavailable.indexOf('commitments') >= 0) {
      return h(ui.Band, { title: '承诺' },
        h(ui.Empty, { title: '这个运行库还没有承诺表' }));
    }
    return h(ui.Band, { title: '承诺', info: '这一页只读：关闭承诺走运行库事件，不在这里改。' },
      list.length
        ? h(ui.List, { label: '承诺列表' }, list.map((commitment, index) => h(CommitmentRow, {
          key: commitment.commitment_id || `commitment:${index}`,
          commitment,
        })))
        : h(ui.Empty, { title: '还没有承诺记录', hint: '有明确约定后才会出现在这里。' }));
  }

  function LifeDiagnostic({ life, unavailable }) {
    const plan = life.plan || null;
    const switches = life.switches || {};
    const planControls = life.planControls || {};
    const receipts = Array.isArray(life.receipts) ? life.receipts : [];
    const state = typeof life.state === 'string' ? life.state : '';
    const groups = [
      ['current', life.current && life.current.slot ? [life.current.slot] : []],
      ['next', Array.isArray(life.next) ? life.next : []],
      ['pending', Array.isArray(life.pending) ? life.pending : []],
      ['ended', Array.isArray(life.ended) ? life.ended : []],
      ['skipped', Array.isArray(life.skipped) ? life.skipped : []],
    ];
    const slots = [];
    groups.forEach(([group, list]) => {
      list.forEach((slot) => {
        slots.push({
          group,
          slotId: slot.slotId,
          planId: plan ? plan.planId : undefined,
          startAt: slot.startAt,
          endAt: slot.endAt,
          kind: slot.kind,
          activity: slot.activity,
          status: slot.status,
          outcome: slot.outcome,
          locked: slot.locked,
          flexibility: slot.flexibility,
          controls: slot.controls,
          minutes: slot.minutes,
        });
      });
    });
    return h(ui.Diagnostic, {
      title: '高级诊断',
      hint: '计划版本、开关、回执与槽 ID 原样保留。',
    },
    h(ui.KeyValue, {
      items: [
        { k: '状态说明', v: STATE_EXPLAIN[state] || DASH, breakable: true },
        { k: '计划编号', v: plan ? plan.planId : DASH, mono: true, breakable: true },
        { k: '计划版本', v: plan ? `第 ${text(plan.version)} 版` : DASH },
        { k: '计划状态', v: plan ? (plan.status || life.planStatus || DASH) : DASH },
        { k: '今天时段', v: `${P.fmt.number(Array.isArray(life.today) ? life.today.length : 0)} 段` },
        { k: '状态原因', v: life.reason ? String(life.reason).slice(0, 200) : DASH, breakable: true },
        { k: '计划日期', v: plan ? text(plan.day) : DASH },
        { k: '自主规划', v: onOff(switches.planning) },
        { k: '活动开关', v: onOff(switches.activities) },
        { k: '分享开关', v: onOff(switches.share) },
        { k: '分享候选', v: life.share ? `${P.fmt.number(life.share.pending)} 条待处理` : DASH },
        { k: '计划控制', v: planControls.enabled === true ? `可用（${(planControls.actions || []).join(' / ')}）` : '不可用' },
        { k: '不可用分类', v: unavailable.length ? unavailable.join('、') : '无' },
      ],
    }),
    h('div', { className: 'cpxp-life-diag-block' },
      h('p', { className: 'cpxp-life-subhead' }, '计划原样'),
      h(ui.Pre, null, plan ? JSON.stringify(plan, null, 2) : '（没有计划）'),
      h('p', { className: 'cpxp-life-subhead' }, '回执原样'),
      h(ui.Pre, null, JSON.stringify(receipts, null, 2)),
      h('p', { className: 'cpxp-life-subhead' }, '槽（技术字段）'),
      h(ui.Pre, null, JSON.stringify(slots, null, 2)),
      h('p', { className: 'cpxp-life-subhead' }, '进行中活动（技术字段）'),
      h(ui.Pre, null, JSON.stringify((life.current && life.current.activities) || [], null, 2))));
  }

  // ---------------------------------------------------------------------------
  // 页面
  // ---------------------------------------------------------------------------

  function OwnerHealthStatus() {
    const query = P.useApi(P.readPrivateHealthStatus, []);
    const source = query.data?.source;
    const freshness = source?.freshness;
    const label = ({ fresh: '数据较新', delayed: '同步延迟', stale: '数据已过期', no_data: '暂无样本', error: '读取异常' })[freshness?.status];
    return h(ui.Callout, { title: '主人健康 · 私有状态', tone: query.error ? 'warn' : 'neutral' },
      query.loading && !source ? '正在读取'
        : query.error || !source ? '健康来源暂不可用'
          : h('span', null, source.displayName || '健康来源', ' · ', label || '新鲜度未知',
            freshness?.newestSampleAt ? h('span', null, ' · 最新样本 ', h(ui.Timestamp, { at: freshness.newestSampleAt })) : null));
  }

  function LifePage() {
    const query = P.useApi(() => P.api.get('companion'), []);
    const [busy, setBusy] = P.useState(null);
    const [failure, setFailure] = P.useState(null);

    const data = query.data || null;
    const life = data && data.life ? data.life : null;
    const sections = (data && data.sections) || {};
    const runtime = (data && data.runtime) || {};
    const unavailable = Array.isArray(data && data.unavailable) ? data.unavailable : [];
    const loadingFirst = query.loading && !data;

    // 提示走外壳的全局通知（P.notice）；提示失败不影响写入结果本身。
    const notify = (message, tone) => {
      try {
        if (typeof P.notice === 'function') P.notice(message, tone);
        else if (typeof P.toastOnce === 'function') P.toastOnce(message, tone);
      } catch { /* 通知只是提示，失败不影响写入结果 */ }
    };

    // 写入：只有运行库真的回了回执才刷新界面；请求在飞的时候所有槽操作按钮都禁用。
    const runAction = (slot, action) => {
      if (!slot || !slot.slotId || busy) return;
      const actionLabel = ACTION_LABEL[action] || action;
      if (action === 'skip' && !P.confirm(`确定跳过「${slot.title || '这一段'}」吗？跳过之后今天不会再安排它。`)) return;
      setFailure(null);
      setBusy({ slotId: slot.slotId, action });
      P.api.post('plan-slot', {
        slotId: slot.slotId,
        action,
        reason: ACTION_REASON[action] || '',
      }).then((receipt) => {
        const confirmed = receipt && receipt.slotId === slot.slotId;
        notify(`${actionLabel}${confirmed ? '成功，运行库已确认' : '已提交'}`, 'ok');
        query.reload();
      }).catch((error) => {
        const message = typeof P.failText === 'function'
          ? P.failText(error, '运行库拒绝了这次操作。')
          : (error && error.message ? String(error.message) : '请求失败，运行库没有给出原因。');
        notify(`${actionLabel}失败 — ${message}`, 'danger');
        setFailure({ slot, action, message });
      }).then(() => setBusy(null), () => setBusy(null));
    };

    const failureNotice = failure
      ? h(ui.Callout, {
        tone: 'danger',
        title: `${ACTION_LABEL[failure.action] || failure.action}没有成功`,
        action: h(ui.Button, {
          variant: 'ghost',
          size: 'sm',
          onClick: () => runAction(failure.slot, failure.action),
        }, '重试'),
      },
      h('p', { className: 'cpxp-life-note' }, `运行库拒绝了这次操作：${failure.message}`),
      h('p', { className: 'cpxp-life-note' }, '这一段没有改变。'))
      : null;

    const runtimeNote = runtime.available === false
      ? h(ui.Callout, { tone: 'warn', title: '本地运行库不可用' },
        h('p', { className: 'cpxp-life-note' }, '日程、目标与承诺都可能是空的。'))
      : null;

    const statusLine = h('span', { className: 'cpxp-life-status' },
      '数据观测 ',
      data && data.observedAt ? h(ui.Timestamp, { at: data.observedAt }) : DASH,
      ' · ',
      runtime.available === true ? '运行库可用' : runtime.available === false ? '运行库不可用' : '运行库状态未知',
      h(ui.Info, { text: '时间统一按 Asia/Shanghai 显示；「数据观测」是这一次读取的时刻。' }));

    const body = loadingFirst
      ? h(ui.Skeleton, { rows: 6 })
      : query.error
        ? h(ui.ErrorBox, { error: query.error, onRetry: query.reload })
        : !data
          ? h(ui.Empty, { title: '没有读到陪伴数据', hint: '点页头的刷新再试一次。' })
          : life
            ? h('div', { className: 'cpxp-life-stack' },
              runtimeNote,
              h(BandNow, { life }),
              h(BandNext, { life, busy, onAction: runAction, notice: failureNotice }),
              h(BandToday, { life }),
              typeof P.readPrivateHealthStatus === 'function' ? h(OwnerHealthStatus) : null,
              h(BandExperience, { experience: life.experience }),
              h(BandEnded, { life }),
              h(BandPending, { life }),
              h(BandSkipped, { life }),
              h(BandGoals, { goals: sections.goals, unavailable }),
              h(BandCommitments, { commitments: sections.commitments, unavailable }),
              h(LifeDiagnostic, { life, unavailable }))
            : h('div', { className: 'cpxp-life-stack' },
              runtimeNote,
              h(ui.Callout, { tone: 'warn', title: '这一版运行库还没有「生活」视图' }),
              h(BandExperience, { experience: null }),
              h(BandGoals, { goals: sections.goals, unavailable }),
              h(BandCommitments, { commitments: sections.commitments, unavailable }),
              h(ui.Diagnostic, { title: '高级诊断', hint: '技术字段放这里。' },
                h(ui.KeyValue, {
                  items: [
                    { k: 'life 字段', v: '缺失', mono: true },
                    { k: '不可用分类', v: unavailable.length ? unavailable.join('、') : '无' },
                  ],
                })));

    return h(ui.Page, {
      title: '生活与日程',
      lead: '她今天的安排与已经过去的段落。',
      actions: [
        h(ui.Button, {
          key: 'refresh',
          variant: 'primary',
          onClick: query.reload,
          loading: query.loading,
          disabled: loadingFirst,
        }, '刷新'),
      ],
      status: statusLine,
    }, body);
  }

  P.registerPage({ id: 'life', label: '生活与日程', order: 20, component: LifePage });
})(P);
