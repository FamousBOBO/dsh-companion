(function (P) {
  const { h, ui } = P;

  P.css(`
    .cpxp-home-next { display: flex; flex-direction: column; gap: 2px; }
    .cpxp-home-next-row { display: flex; align-items: baseline; gap: 12px; padding: 10px 8px; border-top: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 70%, transparent); width: 100%; border-left: 0; border-right: 0; border-bottom: 0; background: transparent; color: inherit; font: inherit; text-align: left; border-radius: var(--cpx-r-sm); }
    .cpxp-home-next-row:first-child { border-top: 0; }
    .cpxp-home-next-row[data-clickable="true"] { cursor: pointer; }
    .cpxp-home-next-row[data-clickable="true"]:hover { background: var(--dsw-alias-bg-layer-2); }
    .cpxp-home-when { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); font-size: 12.5px; white-space: nowrap; flex: none; min-width: 92px; }
    .cpxp-home-what { min-width: 0; flex: 1; overflow-wrap: anywhere; }
    .cpxp-home-sub { color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
    .cpxp-home-events { display: flex; flex-direction: column; min-width: 0; }
    .cpxp-home-event { display: flex; flex-direction: column; gap: 2px; padding: 10px 0; border-top: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 70%, transparent); min-width: 0; }
    .cpxp-home-event:first-child { border-top: 0; }
    .cpxp-home-event-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; min-width: 0; }
    .cpxp-home-event-at { color: var(--dsw-alias-label-secondary); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; flex: none; }
    .cpxp-home-event-source { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.6; white-space: nowrap; flex: none; padding: 0 7px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 80%, transparent); }
    .cpxp-home-event-source[data-source="user"] { color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 42%, transparent); }
    .cpxp-home-event-source[data-source="assistant"] { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 42%, transparent); }
    .cpxp-home-event-source[data-source="tool"] { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 42%, transparent); }
    .cpxp-home-event-source[data-source="system"] { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
    .cpxp-home-event-source[data-raw="true"] { font-size: 11px; }
    .cpxp-home-event-text { flex: 1; min-width: 0; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .cpxp-home-event-tech { min-width: 0; }
    .cpxp-home-event-tech .cpx-diag { border-top: 0; padding-top: 2px; }
    .cpxp-home-event-raw { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; white-space: pre-wrap; }
    .cpxp-home-event-meta { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 1.6; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
    .cpxp-home-aside-action { border: 0; background: transparent; color: var(--dsw-alias-brand-primary); font: inherit; font-size: 13px; cursor: pointer; padding: 4px 0; text-align: left; text-decoration: underline; align-self: flex-start; }
    .cpxp-home-links { display: flex; flex-wrap: wrap; gap: 8px; }
    .cpxp-home-now { margin: 0; font-size: 15px; overflow-wrap: anywhere; }
    .cpxp-home-vitals { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--cpx-s3, 12px); min-width: 0; }
    .cpxp-home-vital-fresh { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; margin-top: 6px; }
    .cpxp-home-vital-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 1.7; overflow-wrap: anywhere; max-width: 72ch; }
    @media (max-width: 760px) { .cpxp-home-vitals { grid-template-columns: 1fr; } }
  `);

  const ACTIVITY_LABEL = { read: '阅读', explore: '探索', write: '创作' };
  const SLOT_KIND = { activity: '活动', rest: '休息' };
  const STATE_SENTENCE = {
    running: '正在做一件事',
    resting: '在休息',
    upcoming: '还有安排',
    'today-done': '今天的安排都过去了',
    'no-plan': '今天还没有安排',
    'no-autonomy': '自主规划未启用',
  };
  // 解释类文案只留在悬停 ⓘ 里（2026-11-04 文案规则）：对象内部只写事实、数字与状态词。
  const HOME_INFO = '只读：不会替你发消息，也不会替她做决定。';
  const HERO_INFO = '读不到只说明这一页没拿到数据，不等于她没有安排；计划只是打算，没有回执的事不算已经做过；标了模拟/假设的活动不是真实发生的；闲置是允许的状态。';

  const clock = (value) => P.fmt.clock(value);

  // ---------------------------------------------------------------------------
  // 「最近一起经历的事」的来源投影
  //
  // GET timeline?limit=6 的 items[] 只给截断正文（preview ≤ 160 字）。它可能是
  // QQ 路由抬头、长链接、命令参数、JSON 片段或代码围栏。首页只需要「谁、做了
  // 什么」一句话：来源标签写死成中文（你 / 她 / 工具 / 对话 / 导入 / 系统 …），
  // 正文按规则收成人话；完整原文与 sessionId / seq / type 只进每行的
  // ui.Diagnostic（默认折叠）。工具来源的行不写「你说」「她记得」这类事实句。
  // ---------------------------------------------------------------------------

  const SUMMARY_LIMIT = 60;
  const CJK = /[\u4e00-\u9fff]/u;
  const TOOL_TYPE = /(?:tool|command|shell|exec|terminal|\bcmd\b)/iu;
  const OPERATION_TYPE = /(?:tool|command|shell|exec|terminal|\bcmd\b|system|runtime|heartbeat)/iu;
  const TYPE_LABEL = {
    transcript: '对话', conversation: '对话', dialog: '对话', dialogue: '对话', chat: '对话',
    desktop_conversation: '对话',
    import: '导入', imported: '导入', astrbot_import: '导入', migration: '导入',
    system: '系统', runtime: '系统', heartbeat: '系统',
    desktop_fact: '事实', fact: '事实', memory: '记忆', memory_event: '记忆',
    note: '笔记', manual: '手工记录', extracted: '抽取', wiki: 'Wiki', event: '事件',
  };
  const ROLE_LABEL = { user: '你', assistant: '她', imported: '导入', system: '系统', runtime: '系统', tool: '工具' };
  const ACTION_LABEL = {
    探索: '检索', 检索: '检索', 搜索: '检索', 读取: '读取', 查看: '读取',
    写入: '写入', 保存: '写入', 执行: '执行', 生成: '生成',
  };
  const ACTION_HINTS = [
    { verb: '检索', pattern: /(?:https?:\/\/|search|query|grep|fetch|browse|检索|搜索|探索)/iu },
    { verb: '读取', pattern: /(?:read\b|cat\b|open\b|读取|查看|打开)/iu },
    { verb: '写入', pattern: /(?:write|edit|patch|save|写入|保存|创建|修改)/iu },
    { verb: '生成', pattern: /(?:generate|image|draw|生图|绘图|生成)/iu },
    { verb: '执行', pattern: /(?:exec|shell|command|terminal|run\b|npm|pnpm|node\s|git\s|运行|执行|命令)/iu },
  ];
  // 摘要里会出现的固定占位：同一种连写多次时合并成一次。
  const MASK_TOKENS = ['（标识已隐去）', '（号码已隐去）', '（哈希已隐去）', '（结构化片段已略）', '（英文片段已略）'];

  /** 来源标签：对话/工具/导入/系统都写中文；认不出的 type 原样显示但更小。 */
  function sourceOf(event) {
    const role = String((event && event.role) || '');
    const type = String((event && event.type) || '');
    if (role === 'user') return { key: 'user', label: '你' };
    if (role === 'assistant') return { key: 'assistant', label: '她' };
    if (TOOL_TYPE.test(type) || role === 'tool') return { key: 'tool', label: '工具' };
    const key = OPERATION_TYPE.test(type) || OPERATION_TYPE.test(role) ? 'system' : 'other';
    const mapped = type ? (TYPE_LABEL[type] || TYPE_LABEL[type.toLowerCase()]) : '';
    if (mapped) return { key, label: mapped };
    if (type) return { key, label: type, raw: true };
    if (role) return { key, label: ROLE_LABEL[role] || role, raw: !ROLE_LABEL[role] };
    return { key: 'other', label: '记录' };
  }

  /** 链接只留「域名/…」：读得懂来源，又不把整串 URL 铺在首页。 */
  function hostOf(url) {
    const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/iu.exec(String(url ?? ''));
    if (!match) return '链接已隐去';
    return `${match[1].replace(/^www\./iu, '').toLowerCase()}/…`;
  }

  /** 长路径缩成文件名；两级以内的相对路径本来就短，保持原样。 */
  function shortenPath(match) {
    const parts = String(match).split(/[\\/]+/u).filter(Boolean);
    return parts.length > 2 ? `…/${parts[parts.length - 1]}` : match;
  }

  /**
   * 找出一对配对的 `{}` / `[]` 区间（简易计数即可，preview 只有 160 字）。
   * 外层区间先出现，切掉整段就等于把嵌套的键值对一起收掉。
   */
  function braceSpans(text) {
    const spans = [];
    const pairs = { '{': '}', '[': ']' };
    for (let start = 0; start < text.length; start += 1) {
      const open = text[start];
      const close = pairs[open];
      if (!close) continue;
      let depth = 0;
      let end = -1;
      for (let cursor = start; cursor < text.length; cursor += 1) {
        if (text[cursor] === open) depth += 1;
        else if (text[cursor] === close) {
          depth -= 1;
          if (depth === 0) { end = cursor; break; }
        }
      }
      if (end > start) spans.push({ start, end });
    }
    return spans;
  }

  const looksStructured = (chunk) => /"[^"\n]{0,40}"\s*:/u.test(chunk) || /^\s*\[[^\[\]]*\d/u.test(chunk);

  /** 整段 JSON / 数组（带 "key": 且 ≥ 40 字）收成一句占位。 */
  function stripJson(text) {
    const spans = braceSpans(text);
    if (!spans.length) return text;
    let output = '';
    let cursor = 0;
    for (const span of spans) {
      if (span.start < cursor) continue;
      const chunk = text.slice(span.start, span.end + 1);
      if (chunk.length < 40 || !looksStructured(chunk)) continue;
      output += `${text.slice(cursor, span.start)} （结构化片段已略） `;
      cursor = span.end + 1;
    }
    return `${output}${text.slice(cursor)}`;
  }

  /** 一句人话：去掉代码、JSON、链接原文、命令参数与哈希，保留中文句子。 */
  function cleanPreview(raw) {
    let text = String(raw ?? '').replace(/\r\n?/gu, '\n');
    // 代码围栏、行内反引号、Markdown 结构符号
    text = text.replace(/```[\s\S]*?(?:```|$)/gu, ' ');
    text = text.replace(/`+/gu, '');
    text = text.replace(/^\s{0,3}#{1,6}\s+/gmu, ' ');
    text = text.replace(/^\s{0,3}[-*+]\s+/gmu, ' ');
    text = text.replace(/^\s{0,3}\d+[.)]\s+/gmu, ' ');
    text = text.replace(/\*\*([^*]+)\*\*/gu, '$1');
    // HTML 标签（含宿主注入的 <untrusted …> 包裹；预览被截断时可能只有半个标签）
    text = text.replace(/<\/?[a-zA-Z][^>]{0,200}>/gu, ' ');
    text = text.replace(/<\/?[^>]{0,200}$/u, ' ');
    // 现有脱敏：会话定位标识
    text = text.replace(/(?:room|target|channel|session|thread|guild)=\S+/giu, '（标识已隐去）');
    // 结构化片段：整段 JSON / 数组略过，残留的短片段再收一次
    text = stripJson(text);
    text = text.replace(/[{[][^[\]{}\n]{0,40}[}\]]/gu, (chunk) => (looksStructured(chunk) ? ' ' : chunk));
    text = text.replace(/[{[][^[\]{}\n]*$/u, (chunk) => (looksStructured(chunk) ? ' ' : chunk));
    text = text.replace(/\[[^\[\]]{40,}\]/gu, ' （结构化片段已略） ');
    // 链接只留域名
    text = text.replace(/\bhttps?:\/\/[^\s，。；、）】」》"'<>]+/giu, (url) => hostOf(url));
    text = text.replace(
      /(^|[^\w.@/-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|cn|net|org|io|dev|ai|co|me|app|sh|xyz|wiki|top))(\/[^\s，。；、）】」》"'<>]*)?/giu,
      (match, lead, domain) => `${lead}${hostOf(`https://${domain}`)}`,
    );
    // 命令与参数：--flag=value、ENV=value、key=value 一律去掉
    text = text.replace(/(^|[^\w.\-])(?:--?[a-zA-Z][\w-]*)(?:=\S+)?/gu, (match, lead) => lead);
    text = text.replace(/(^|[^\w.\-])([A-Z][A-Z0-9_]{2,})=\S+/gu, (match, lead) => lead);
    text = text.replace(/(^|[^\w.\-])([a-zA-Z][\w.-]{0,24})=(?:"[^"]*"|\S*)/gu, (match, lead) => lead);
    // 长路径只留文件名
    text = text.replace(/(?:[A-Za-z]:[\\/]|[\\/])?(?:[\w.@+-]+[\\/])+[\w.@+-]+/gu, (match) => shortenPath(match));
    // 连续十六进制（≥ 12 位，至少含一个字母）当成哈希隐去
    text = text.replace(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/giu, '（哈希已隐去）');
    // 聊天抬头：「2026-10-31 00:31 昵称(123456) 编号 [@咱]：正文」只留正文
    text = text.replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}[^\n：:]{0,80}[：:]/gu, (match) => (
      /[#[(（]|\bQQ\b/iu.test(match) ? ' ' : match));
    // 宿主抬头与方括号标签（【QQ路由】、[当前消息 · 需要回应]）
    text = text.replace(/【[^】]{0,16}(?:路由|元数据|系统提示|指令|metadata|header)[^】]*】/giu, ' ');
    text = text.replace(/\[[^\[\]\n]{0,30}\]/gu, ' ');
    // 六位以上的数字串当号码隐去；文件名里的日期（x-20261030.json）保留可读性
    text = text.replace(/([-_/])?(\d{6,})(\.[a-z0-9]{1,8})?/giu, (match, lead, digits, ext) => (
      lead && ext ? match : `${lead || ''}（号码已隐去）`));
    // 中英混排时长英文提示词不铺在首页（生图记录常见）
    if (CJK.test(text)) {
      text = text.replace(/[A-Za-z0-9][A-Za-z0-9 ,.:;'"()_\-\\/]{39,}/gu, (run) => {
        if (CJK.test(run)) return run;
        return (run.match(/,/gu) || []).length >= 3 ? '（英文片段已略）' : run;
      });
    }
    // 占位前的孤零零标点收掉（冒号紧贴占位时保留，读起来仍是「标签：略」）
    text = text.replace(/[，、；,;]\s*(?=（(?:英文片段已略|结构化片段已略)）)/gu, ' ');
    // 哈希前的英文标签同样多余
    text = text.replace(/\b(?:hash|sha1|sha256|md5|fingerprint)\b\s*(?=（哈希已隐去）)/giu, '');
    // 同一种占位连写只留一次
    for (const token of MASK_TOKENS) {
      text = text.replace(new RegExp(`${token}(?:\\s*${token})+`, 'gu'), token);
    }
    text = text.replace(/[ \t]+/gu, ' ').replace(/\s*\n\s*/gu, ' ').trim();
    // 日志自带的截断省略号不必叠在首页上
    text = text.replace(/[.．。]{0,3}(?:…|\.\.\.)+\s*$/u, '').trim();
    // 预览被截断时可能剩下半个 JSON：从第一个残留括号处截掉，别留半截键值对
    const stray = text.search(/[{}[\]]/u);
    if (stray >= 0) text = text.slice(0, stray).trim();
    // 截断留下的单个汉字不成句，收掉
    text = text.replace(/[\s，、；：][\u4e00-\u9fff]\s*$/u, '').trim();
    text = text.replace(/^[，。；、：,;:.·\-\s]+/u, '').replace(/[，、；：,;:]+$/u, '');
    // 开头只剩占位时直接去掉，正文才是要读的部分
    return text.replace(/^(?:（[^）]{1,12}已隐去）|（[^）]{1,12}已略）)[\s，、；:：]*/u, '');
  }

  /** 动作词：工具/系统来源的行用它开头，避免被读成"用户做了这件事"。 */
  function actionOf(raw, cleaned) {
    const text = String(cleaned || '');
    const lead = /(?:^|[\s；，])(探索|检索|搜索|读取|查看|写入|保存|执行|生成)\s*[:：]\s*/u.exec(text);
    if (lead) {
      const rest = `${text.slice(0, lead.index)} ${text.slice(lead.index + lead[0].length)}`;
      return { verb: ACTION_LABEL[lead[1]] || '执行', hadLead: true, body: rest.replace(/\s+/gu, ' ').trim() };
    }
    const source = String(raw || '');
    for (const hint of ACTION_HINTS) {
      if (hint.pattern.test(source)) return { verb: hint.verb, hadLead: false, body: text };
    }
    return { verb: '', hadLead: false, body: text };
  }

  /** 按字数（不是码元）截断，优先在标点处收尾。 */
  function clip(text, limit) {
    const chars = Array.from(String(text ?? ''));
    if (chars.length <= limit) return chars.join('');
    const head = chars.slice(0, limit).join('');
    const cut = Math.max(
      head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('，'),
      head.lastIndexOf('、'), head.lastIndexOf('：'), head.lastIndexOf(' '),
    );
    const kept = cut >= Math.floor(limit / 2) ? head.slice(0, cut) : head;
    // 收尾只剩「来源」「其中」这类标签时也一起收掉，别留半句话
    const tidied = kept
      .replace(/[\s，、；：,;:]+$/u, '')
      .replace(/[\s，、；：,;:（(]*(?:来源|来自|文件|路径|链接|地址|详情|其中|以及|与|和|见)$/u, '');
    return `${tidied}…`;
  }

  /** 一条事件的完整投影：来源标签 + 一句摘要；原文只留在 raw 里给诊断用。 */
  function projectEvent(event) {
    const raw = String((event && event.preview) || '');
    const cleaned = cleanPreview(raw);
    const source = sourceOf(event);
    const action = actionOf(raw, cleaned);
    const conversational = source.key === 'user' || source.key === 'assistant';
    const operation = source.key === 'tool' || source.key === 'system' || (!conversational && action.hadLead);
    let summary = (conversational && action.hadLead ? cleaned : action.body).replace(/\s+/gu, ' ').trim();
    // 正文自己已经以动作词开头时不再叠一个动词（「读取 已读取 1 个文件」读着别扭）
    const alreadyVerbed = /^(?:已)?(?:检索|搜索|读取|查看|写入|保存|执行|运行|生成)/u.test(summary);
    if (!summary) {
      summary = '（这条记录没有可读正文，展开原始记录可看）';
    } else if (operation && !alreadyVerbed) {
      summary = `${action.verb || (source.key === 'tool' ? '工具执行了' : '系统记录了')} ${summary}`;
    }
    return { source, summary: clip(summary, SUMMARY_LIMIT), raw };
  }

  function activityLabel(value) {
    return ACTIVITY_LABEL[value] || SLOT_KIND[value] || (value ? String(value) : '安排');
  }

  /** One honest sentence about where she is right now. */
  function describeNow(life) {
    if (!life) {
      return {
        headline: '还没读到她的生活状态',
        note: '',
        tone: 'idle',
      };
    }
    const current = life.current && life.current.slot ? life.current.slot : null;
    const running = life.current && Array.isArray(life.current.activities) ? life.current.activities : [];
    const next = Array.isArray(life.next) && life.next.length ? life.next[0] : null;
    if (running.length) {
      const item = running[0];
      const real = item.reality === 'actual_tool_activity';
      return {
        headline: `正在${activityLabel(item.kind)}`,
        note: `${item.target || '一段正在进行的事'}${real ? '' : '（模拟/假设）'}`,
        tone: real ? 'live' : 'warn',
      };
    }
    if (life.state === 'running' && current) {
      return { headline: `正在${activityLabel(current.activity || current.kind)}`, note: current.title || '', tone: 'live' };
    }
    if (life.state === 'resting') {
      return {
        headline: '在休息',
        note: next ? `下一段在 ${clock(next.startAt)}，${next.title || activityLabel(next.activity)}` : '今天不打算再安排什么了。',
        tone: 'ok',
      };
    }
    if (next) {
      return {
        headline: `接下来 ${clock(next.startAt)}`,
        note: `${next.title || activityLabel(next.activity)} · ${next.minutes || 0} 分钟`,
        tone: 'idle',
      };
    }
    if (life.state === 'today-done') {
      return { headline: '今天的安排都过去了', note: '', tone: 'ok' };
    }
    if (life.state === 'no-autonomy') {
      return { headline: '自主规划未启用', note: '可在设置里打开', tone: 'warn' };
    }
    return { headline: '今天还没有安排', note: '', tone: 'idle' };
  }

  function SlotRow({ slot, onClick }) {
    const kindTone = slot.kind === 'rest' ? 'neutral' : 'brand';
    return h('button', {
      type: 'button',
      className: 'cpxp-home-next-row',
      'data-clickable': onClick ? 'true' : 'false',
      onClick,
      'aria-label': `${P.fmt.range(slot.startAt, slot.endAt)} ${slot.title || activityLabel(slot.activity)}`,
    },
    h('span', { className: 'cpxp-home-when' }, P.fmt.range(slot.startAt, slot.endAt)),
    h('span', { className: 'cpxp-home-what' },
      h('span', null, slot.title || activityLabel(slot.activity)),
      h('span', { className: 'cpxp-home-sub' }, ` · ${activityLabel(slot.activity)}`),
      slot.minutes ? h('span', { className: 'cpxp-home-sub' }, ` · ${slot.minutes} 分钟`) : null,
      slot.locked ? h('span', null, ' ', h(ui.Badge, { tone: 'warn' }, '已锁定')) : null),
    h('span', { className: 'cpxp-home-sub' }, h(ui.Badge, { tone: kindTone }, SLOT_KIND[slot.kind] || slot.kind || '安排')));
  }

  function EventLine({ event }) {
    const view = projectEvent(event);
    const type = String(event.type || '');
    const role = String(event.role || '');
    const seq = event.seq === null || event.seq === undefined || event.seq === '' ? '—' : String(event.seq);
    const sessionId = String(event.sessionId || '');
    return h('div', { className: 'cpxp-home-event' },
      h('div', { className: 'cpxp-home-event-head' },
        h('span', { className: 'cpxp-home-event-at' }, P.fmt.relative(event.at)),
        h('span', {
          className: 'cpxp-home-event-source',
          'data-source': view.source.key,
          'data-raw': view.source.raw ? 'true' : undefined,
          title: `来源：${view.source.label}`,
        }, view.source.label),
        h('span', { className: 'cpxp-home-event-text' }, view.summary)),
      h('div', { className: 'cpxp-home-event-tech' },
        h(ui.Diagnostic, { title: '原始记录（技术字段）' },
          h('p', { className: 'cpxp-home-event-raw' }, view.raw || '（这条记录的预览是空的）'),
          h('p', { className: 'cpxp-home-event-meta' },
            `type：${type || '—'} · role：${role || '—'} · seq：${seq} · sessionId：${sessionId || '—'}`))));
  }

  function heroNode(now, life, observedAt) {
    return h('section', { className: 'cpx-hero', 'data-cpx': 'home-scene' },
      h('div', { className: 'cpx-scene' },
        h('span', { className: 'cpx-scene-sky', 'aria-hidden': 'true' }),
        h('span', { className: 'cpx-scene-floor', 'aria-hidden': 'true' }),
        h('span', { className: 'cpx-scene-mark', 'aria-hidden': 'true' }, h(ui.Icon, { name: 'snow', size: 30 })),
        h('span', { className: 'cpx-scene-window', 'aria-hidden': 'true' }),
        h('span', { className: 'cpx-scene-desk', 'aria-hidden': 'true' }),
        h('span', { className: 'cpx-scene-lamp', 'aria-hidden': 'true' }),
        h('h2', { className: 'cpx-scene-state' }, now.headline),
        now.note ? h('p', { className: 'cpx-scene-note' }, now.note) : null,
        h('p', { className: 'cpx-scene-meta' },
          h(ui.StateLine, { state: now.tone, text: life ? (STATE_SENTENCE[life.state] || '状态未知') : '状态未读到' }),
          observedAt ? h(ui.Timestamp, { at: observedAt, prefix: '数据时间' }) : null,
          life && life.switches ? h('span', null, life.switches.planning ? '自主规划已开启' : '自主规划关闭') : null,
          h(ui.Info, { text: HERO_INFO, label: '这里怎么读' }))));
  }

  function nextBandNode(life, next) {
    const emptyTitle = life ? '今天没有更多安排了' : '暂时读不到日程';
    const emptyHint = life ? '' : '稍后刷新看看。';
    return h(ui.Band, {
      title: '接下来的安排',
      hint: '还没开始的事',
      info: '计划不等于已经发生；自主规划关闭时她不会自己生成日程（可在设置里打开）。',
      actions: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => P.nav.go('life') }, '生活与日程'),
    },
    next.length
      ? h('div', { className: 'cpxp-home-next' }, next.map((slot, index) => h(SlotRow, {
        key: slot.slotId || index,
        slot,
        onClick: () => P.nav.go('life'),
      })))
      : h(ui.Empty, { title: emptyTitle, hint: emptyHint, compact: true }));
  }

  function recentBandNode(events, data) {
    const emptyHint = data && data.missing.includes('最近记录')
      ? '时间线接口这次没读到，可以到时间线页重试。'
      : '新对话会先在本机留证。';
    return h(ui.Band, {
      title: '最近一起经历的事',
      hint: '',
      info: '来自本地留存记录的短摘要；链接、命令与代码已收成一句话，原文在每行的折叠里。对话留存不等于自动确认事实。',
      actions: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => P.nav.go('timeline') }, '完整时间线'),
    },
    events.length
      ? h('div', { className: 'cpxp-home-events' }, events.map((event, index) => h(EventLine, { key: `${event.at}-${index}`, event })))
      : h(ui.Empty, { title: '还没有共同记录', hint: emptyHint, compact: true }));
  }

  function pendingBandNode(pendingReview, pendingSlots, pendingShare) {
    const rows = [];
    if (pendingReview) {
      rows.push(h(ui.Row, {
        key: 'review',
        title: `${pendingReview} 条记忆候选等待核对`,
        meta: '通过后进入长期记忆',
        side: '审核',
        onClick: () => P.nav.go('review'),
      }));
    }
    if (pendingSlots) {
      rows.push(h(ui.Row, {
        key: 'slots',
        title: `${pendingSlots} 段计划还没走完`,
        meta: '到时间还没回执，可以跳过',
        side: '生活与日程',
        onClick: () => P.nav.go('life'),
      }));
    }
    if (pendingShare) {
      rows.push(h(ui.Row, {
        key: 'share',
        title: `${pendingShare} 条分享候选等她处理`,
        meta: '分享开关关闭时不会发出去',
        side: '连接与工具',
        onClick: () => P.nav.go('connections'),
      }));
    }
    return h(ui.Band, {
      title: '需要你确认的事',
      hint: '',
      info: '只来自真实的待核对队列与未完成计划，没有演示数字；驳回会撤回但保留证据。',
    },
    rows.length
      ? h(ui.List, { label: '待确认事项' }, rows)
      : h(ui.Empty, {
        title: '现在没有需要你确认的事',
        hint: pendingReview === null ? '待核对接口这次没读到，可以先当作未知。' : '有候选时这里会出现入口。',
        compact: true,
      }));
  }

  // ---------------------------------------------------------------------------
  // 「今天的活动与睡眠」（健康半）
  //
  // 数据只走 /api/companion-health/{today,sleep}。健康路由挂在另一个前缀下，外壳的
  // P.api 只认 api/companion-memory/，所以这里照抄 core.js 同一套信封解包（同源 cookie
  // 鉴权、no-store、{ok,data,error}），不读也不传任何 token。
  // 读不到就说读不到：缺测一律写「无可用记录」，绝不用 0 步 / 0 小时占位。
  // ---------------------------------------------------------------------------
  const HEALTH_FRESH_LABEL = { fresh: '新鲜', delayed: '有延迟', stale: '已过期', unknown: '时间未知' };
  const HEALTH_FRESH_TONE = { fresh: 'ok', delayed: 'warn', stale: 'danger', unknown: 'idle' };
  // 产品参数（不是医学阈值）：只用来判断"这条读数多久以前采的"。
  const HEALTH_FRESH_RULES = { freshMinutes: 120, delayedMinutes: 1440 };

  function healthGet(path, params) {
    let url;
    try {
      url = new URL(`api/companion-health/${path}`, document.baseURI).href;
    } catch {
      url = `/api/companion-health/${path}`;
    }
    const search = params
      ? Object.keys(params)
        .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
        .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
        .join('&')
      : '';
    const target = search ? `${url}${url.indexOf('?') >= 0 ? '&' : '?'}${search}` : url;
    return fetch(target, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    }).then(
      (response) => response.json().then(
        (body) => {
          if (!body || body.ok !== true) {
            const error = (body && body.error) || {};
            throw new P.ApiError(error.message || `健康接口请求失败（HTTP ${response.status}）。`, response.status, error.code || 'unknown');
          }
          const data = body.data;
          // §11：只读查询自己失败也走 {ok:false, code, message}，套在信封的 data 里。
          if (data && typeof data === 'object' && !Array.isArray(data) && data.ok === false) {
            throw new P.ApiError(data.message || '健康服务没有给出原因。', response.status, data.code || 'unknown');
          }
          return data;
        },
        () => { throw new P.ApiError(`健康接口返回不是 JSON（HTTP ${response.status}）。`, response.status, 'bad-response'); },
      ),
      () => { throw new P.ApiError('无法连接宿主（桌面可能已关闭）。', 0, 'network'); },
    );
  }

  const healthUnavailable = (error) => Boolean(error) && (
    String(error.code || '') === 'health-unavailable'
    || String(error.code || '') === 'health-db-unavailable'
    || Number(error.status) === 404
  );

  const healthFinite = (value) => typeof value === 'number' && Number.isFinite(value);

  function healthDuration(minutes) {
    if (!healthFinite(minutes) || minutes < 0) return '无可用记录';
    const total = Math.round(minutes);
    if (total < 60) return `${total} 分钟`;
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  }

  function healthFreshness(at, nowMs) {
    if (!at) return { status: 'unknown', label: HEALTH_FRESH_LABEL.unknown };
    const parsed = typeof at === 'number' ? at : Date.parse(String(at));
    if (!Number.isFinite(parsed)) return { status: 'unknown', label: HEALTH_FRESH_LABEL.unknown };
    const ageMinutes = Math.max(0, Math.round((nowMs - parsed) / 60000));
    const status = ageMinutes <= HEALTH_FRESH_RULES.freshMinutes
      ? 'fresh'
      : ageMinutes <= HEALTH_FRESH_RULES.delayedMinutes ? 'delayed' : 'stale';
    return { status, label: HEALTH_FRESH_LABEL[status] };
  }

  function healthFreshChip(at, nowMs) {
    const fresh = healthFreshness(at, nowMs);
    return h('span', { className: 'cpxp-home-vital-fresh', title: `freshness=${fresh.status}` },
      h(ui.StateLine, { state: HEALTH_FRESH_TONE[fresh.status], text: fresh.label }),
      at ? h(ui.Timestamp, { at, prefix: '样本' }) : h('span', { className: 'cpxp-home-vital-note' }, '样本时间未提供'));
  }

  /** 最近一夜主睡眠：午睡不算，按日期倒序取第一条。 */
  function latestMainSleep(sleep) {
    const sessions = sleep && Array.isArray(sleep.sessions) ? sleep.sessions.filter(Boolean) : [];
    const mains = sessions.filter((session) => !session.isNap);
    if (!mains.length) return null;
    return mains.slice().sort((left, right) => {
      const at = (session) => {
        const start = session.startAt ? Date.parse(String(session.startAt)) : NaN;
        if (Number.isFinite(start)) return start;
        const day = session.sleepDate ? Date.parse(`${session.sleepDate}T00:00:00+08:00`) : NaN;
        return Number.isFinite(day) ? day : 0;
      };
      return at(right) - at(left);
    })[0];
  }

  function healthBandNode(health) {
    const nowMs = Date.now();
    const today = health && health.today ? health.today : null;
    const sleep = health && health.sleep ? health.sleep : null;

    if (health && health.unavailable) {
      return h(ui.Band, {
        title: '今天的活动与睡眠',
        hint: '',
        info: '来自华为运动健康（CN 云）；面板没有拿到 /api/companion-health 服务（health-unavailable），现在不编造任何读数。',
        actions: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => P.nav.go('health') }, '健康与睡眠'),
      }, h(ui.Empty, {
        title: '健康数据未接入',
        hint: '接入后这里会出现今日步数与最近睡眠。',
        compact: true,
      }));
    }

    const activity = today && today.activity ? today.activity : null;
    const metrics = today && today.metrics ? today.metrics : {};
    const intensity = metrics.intensity || null;
    const steps = activity && healthFinite(activity.steps) ? `${Math.round(activity.steps)} 步` : '无可用记录';
    const stepsHint = activity
      ? [
        healthFinite(activity.distanceM) ? (activity.distanceM >= 1000 ? `${(activity.distanceM / 1000).toFixed(2)} 公里` : `${Math.round(activity.distanceM)} 米`) : null,
        healthFinite(activity.kcal) ? `${Math.round(activity.kcal)} 千卡` : null,
        intensity && healthFinite(intensity.moderateHighMinutes) ? `中高强度 ${Math.round(intensity.moderateHighMinutes)} 分钟` : null,
      ].filter(Boolean).join(' · ') || '来源没有给今天的活动明细'
      : (today ? '来源今天没有回传活动读数' : '今天的接口这次没读到');

    const mainSleep = latestMainSleep(sleep);
    const availability = sleep && sleep.availability ? sleep.availability : (today && today.sleep ? today.sleep.availability : null);
    const sleepValue = mainSleep
      ? healthDuration(mainSleep.asleepMinutes)
      : availability === 'awaiting_first_night' ? '等待首夜' : '无可用记录';
    const sleepHint = mainSleep
      ? [
        mainSleep.sleepDate || null,
        mainSleep.startAt && mainSleep.endAt ? P.fmt.range(mainSleep.startAt, mainSleep.endAt) : '来源只给了总时长',
        mainSleep.status === 'aggregate_only' ? '只有聚合时长' : null,
      ].filter(Boolean).join(' · ')
      : availability === 'awaiting_first_night'
        ? '睡眠会话 — 等待首夜华为云记录'
        : (sleep ? '来源这段时间没有睡眠记录' : '睡眠接口这次没读到');

    const sleepSample = mainSleep && mainSleep.endAt ? mainSleep.endAt : null;

    return h(ui.Band, {
      title: '今天的活动与睡眠',
      hint: '',
      info: '来自华为运动健康（CN 云），设备上报的指标；缺测写「无可用记录」，不补 0；新鲜度是产品参数，不是医学结论；只来自云端最后一次上传，来源没给的部分保持空白。',
      actions: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => P.nav.go('health') }, '健康与睡眠'),
    }, [
      h('div', { key: 'vitals', className: 'cpxp-home-vitals' },
        h('div', null,
          h(ui.Stat, { label: '今日步数', value: steps, hint: stepsHint }),
          h('div', { className: 'cpxp-home-vital-fresh' },
            healthFreshChip(activity ? activity.observedAt || null : null, nowMs))),
        h('div', null,
          h(ui.Stat, { label: '最近睡眠', value: sleepValue, hint: sleepHint }),
          h('div', { className: 'cpxp-home-vital-fresh' },
            healthFreshChip(sleepSample, nowMs)))),
      health && health.error
        ? h('p', { key: 'err', className: 'cpxp-home-vital-note' },
          `有一项没读到：${P.failText(health.error, '健康服务没有返回数据。')}`)
        : null,
    ]);
  }

  function asideNode({ now, life, counts, pendingReview, pendingShare, observedAt, data }) {
    const backToChat = () => {
      if (!P.nav.openPanel('conversation')) P.notice('宿主导航暂时不可用。', 'warn');
    };
    return h(P.Fragment, null,
      h('section', { className: 'cpx-aside-section' },
        h('h3', { className: 'cpx-aside-title' }, '现在'),
        h('p', { className: 'cpxp-home-now' }, now.headline),
        h('p', { className: 'cpx-aside-line' },
          h('span', { className: 'cpx-muted' }, '记忆'),
          h('strong', null, counts ? P.fmt.number(counts.memories) : '—')),
        h('p', { className: 'cpx-aside-line' },
          h('span', { className: 'cpx-muted' }, '待核对'),
          h('strong', null, counts ? P.fmt.number(counts.pending) : (pendingReview === null ? '—' : pendingReview))),
        h('p', { className: 'cpx-aside-line' },
          h('span', { className: 'cpx-muted' }, '记录'),
          h('strong', null, counts ? P.fmt.number(counts.events) : '—')),
        h('button', { type: 'button', className: 'cpxp-home-aside-action', onClick: () => P.nav.go('vault') }, '打开记忆库')),

      h('section', { className: 'cpx-aside-section' },
        h('h3', { className: 'cpx-aside-title' }, '她的生活'),
        h('p', { className: 'cpx-aside-line' },
          h('span', { className: 'cpx-muted' }, '自主规划'),
          h('strong', null, life && life.switches ? (life.switches.planning ? '已开启' : '关闭') : '—')),
        h('p', { className: 'cpx-aside-line' },
          h('span', { className: 'cpx-muted' }, '真实活动'),
          h('strong', null, life && life.switches ? (life.switches.activities ? '已开启' : '关闭') : '—')),
        h('p', { className: 'cpx-aside-line' },
          h('span', { className: 'cpx-muted' }, '分享候选'),
          h('strong', null, pendingShare === null ? '—' : pendingShare)),
        h('button', { type: 'button', className: 'cpxp-home-aside-action', onClick: () => P.nav.go('life') }, '今天的时间线')),

      h('section', { className: 'cpx-aside-section' },
        h('h3', { className: 'cpx-aside-title' }, '回到开发'),
        h('div', { className: 'cpxp-home-links' },
          h(ui.Button, { size: 'sm', onClick: backToChat }, '回到聊天'),
          h(ui.Button, { size: 'sm', onClick: () => P.nav.go('workspace') }, '工作区'),
          h(ui.Button, { size: 'sm', onClick: () => P.nav.go('connections') }, '连接与工具'),
          h(ui.Button, { size: 'sm', onClick: () => P.nav.go('settings') }, '设置'))),

      h('section', { className: 'cpx-aside-section' },
        h('h3', { className: 'cpx-aside-title' }, '数据说明'),
        h('p', { className: 'cpx-muted' }, observedAt ? h(ui.Timestamp, { at: observedAt, prefix: '观测于' }) : '还没有观测时间'),
        data && data.missing.length
          ? h(ui.Callout, { tone: 'warn', title: '这一页有没读到的部分' },
            h('span', null, `未读到：${data.missing.join('、')}。`))
          : h('p', { className: 'cpx-muted' }, '数字口径',
            h(ui.Info, { text: '数字来自本机记忆库；未知一律显示「—」，不用 0 占位。', label: '数字口径' }))));
  }

  function Home() {
    const health = P.useLiveHealth();
    const query = P.useApi(() => Promise.allSettled([
      P.api.get('companion'),
      P.api.get('summary'),
      P.api.get('reviews'),
      P.api.get('timeline', { limit: 6 }),
      healthGet('today'),
      healthGet('sleep', { days: 7 }),
    ]).then((results) => {
      const [companion, summary, reviews, timeline, healthToday, healthSleep] = results;
      if (companion.status === 'rejected') throw companion.reason;
      // 健康半没挂上 ≠ 读错了：服务缺失是正常状态，不该混进「这一页有没读到的部分」。
      const healthErrors = [healthToday, healthSleep]
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      const healthUnavailableAll = healthErrors.length > 0 && healthErrors.every(healthUnavailable);
      return {
        companion: companion.value,
        summary: summary.status === 'fulfilled' ? summary.value : null,
        reviews: reviews.status === 'fulfilled' ? reviews.value : null,
        timeline: timeline.status === 'fulfilled' ? timeline.value : null,
        health: {
          today: healthToday.status === 'fulfilled' ? healthToday.value : null,
          sleep: healthSleep.status === 'fulfilled' ? healthSleep.value : null,
          unavailable: healthUnavailableAll,
          error: healthErrors.length && !healthUnavailableAll ? healthErrors[0] : null,
        },
        missing: [
          summary.status === 'rejected' ? '记忆计数' : null,
          reviews.status === 'rejected' ? '待核对列表' : null,
          timeline.status === 'rejected' ? '最近记录' : null,
          healthErrors.length && !healthUnavailableAll ? '身体数据' : null,
        ].filter(Boolean),
      };
    }), []);

    const data = query.data || null;
    const companion = data ? data.companion : null;
    const life = companion ? companion.life : null;
    const pendingReview = data && data.reviews && Array.isArray(data.reviews.pending) ? data.reviews.pending.length : null;
    const pendingSlots = life && Array.isArray(life.pending) ? life.pending.length : null;
    const pendingShare = life && life.share && typeof life.share.pending === 'number' ? life.share.pending : null;
    const now = describeNow(life);
    const next = life && Array.isArray(life.next) ? life.next.slice(0, 4) : [];
    const events = data && data.timeline && Array.isArray(data.timeline.items) ? data.timeline.items.slice(0, 4) : [];
    const counts = data && data.summary ? data.summary.counts : null;
    const runtime = companion ? companion.runtime : null;
    const observedAt = companion ? companion.observedAt : null;

    const page = {
      title: '陪伴首页',
      lead: '她现在在做什么，和还没说完的事',
      info: HOME_INFO,
      status: h(P.Fragment, null,
        h(ui.StateLine, { state: P.lifeTone(life && life.state), text: life ? (STATE_SENTENCE[life.state] || '状态未知') : '尚未读到状态' }),
        observedAt ? h(ui.Timestamp, { at: observedAt, prefix: '观测于' }) : null,
        runtime && runtime.available === false ? h(ui.Badge, { tone: 'warn' }, '运行库未连接') : null),
      actions: h(ui.Button, { variant: 'primary', onClick: query.reload, loading: query.loading }, '刷新状态'),
    };

    if (query.loading && !data) {
      return h(ui.Page, page, h(ui.Skeleton, { rows: 4 }));
    }
    if (query.error) {
      return h(ui.Page, page,
        h(ui.ErrorBox, { error: query.error, onRetry: query.reload }),
        h(ui.Callout, { tone: 'info', title: '这一页读到什么就展示什么' },
          h('span', null, '记忆与生活数据来自本机认知运行库',
            h(ui.Info, { text: '接口失败时只显示这里的错误，不会编造状态。', label: '失败时怎么显示' }))));
    }

    const main = h(P.Fragment, null,
      heroNode(now, life, observedAt),
      h(ui.Band, {
        title: '状态',
        info: '每 20 秒自动探测一次；点任意一项跳到对应页面。失败只写「读不到」，不用 0 或绿色代替未知。',
        actions: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => P.nav.go('overview') }, '运行状态'),
      }, h(ui.HealthStrip, {
        items: health.items,
        at: health.at,
        now: health.now,
        loading: health.loading,
        paused: health.paused,
        onRefresh: health.refresh,
        onTogglePause: health.togglePaused,
        onOpen: (item) => { if (item && item.page) P.nav.go(item.page); },
        compact: true,
      })),
      healthBandNode(data ? data.health : null),
      nextBandNode(life, next),
      recentBandNode(events, data),
      pendingBandNode(pendingReview, pendingSlots, pendingShare));

    const aside = asideNode({ now, life, counts, pendingReview, pendingShare, observedAt, data });

    return h(ui.Page, page, h(ui.Split, { main, aside }));
  }

  P.registerPage({ id: 'home', label: '陪伴首页', order: 0, component: Home });
})(P);
