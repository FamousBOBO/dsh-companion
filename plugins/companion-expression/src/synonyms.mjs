/**
 * 本地近义表达表：**查询与素材描述共用的唯一一份**。
 *
 * 为什么单独成模块：检索曾经有两条互不相干的「理解」路径 —— `analyzer.mjs` 用一张英文标签表
 * 给入库素材打意图/情绪，`retrieval.mjs` 又只拿草稿做字符重合。于是「笑着答应、乖巧点头、
 * 轻松愉快」这种自然中文，两边一个标签都抽不出来：素材卡片没有 `agree`/`light`，
 * 查询也没有，最后只能比「点」「头」「松」这种偶然字符，0.30 分止步。
 *
 * 本表的纪律（与任务书一致，且每条都有 `test/synonyms.test.mjs` 钉住）：
 *   1. **只有一份表**：`analyzeWithHeuristics()`（入库）与 `contextFromDraft()`（查询）都调它。
 *   2. **近似不等于合并**：`乖巧` 只说明语气/卖萌，**不**自动等于「同意」；`笑` 的否定形式
 *      （`别笑了`、`笑不出来`）先由 `SURFACE_RULES` 处理，不能因为字里有「笑」就归成发笑。
 *   3. **允许混合信号**：`好气又好笑` 同时留下 anger 与 laugh（`mixed: true`），后续排序不会
 *      因为「相反情绪」把整条判掉。
 *   4. 纯函数、无 IO、无时钟、无随机数：同一输入永远同一输出，便于复现与测试。
 *
 * 词条形如 `{ id, family, category, terms[] }`；`TERM_HINTS` 给少数词条补充「顺带表达的
 * 语气/情绪」（例如 `好呀` 同时是轻松语气），这样卡片描述里的「好呀」也能对上「轻松」查询。
 */

/** 家族：与语义卡字段一一对应，排序层按家族分开比。 */
export const FAMILIES = Object.freeze(['intent', 'emotion', 'tone', 'scene']);

/** 类别（任务书里那 8 类的本地名字），只用于诊断与报告，不参与打分。 */
export const CATEGORIES = Object.freeze({
  agree: '认同、应答',
  refuse: '拒绝',
  thanks: '致谢',
  apologize: '道歉',
  comfort: '亲昵与安慰',
  laugh: '发笑',
  tease: '调侃与嘲讽',
  encourage: '鼓励',
  greet: '打招呼',
  stop: '制止',
  wait: '等待',
  hunger: '饿',
  joy: '开心',
  sadness: '低落',
  anger: '生气',
  fear: '害怕',
  surprise: '惊讶',
  affection: '亲昵',
  tired: '疲惫',
  smug: '得意',
  confused: '困惑',
  awkward: '尴尬',
  resignation: '无奈',
  playful: '顽皮',
  light: '轻松',
  warm: '温柔',
  cold: '冷淡',
  formal: '正式',
  ironic: '反讽',
  cute: '卖萌',
  serious: '严肃',
});

/**
 * 词表。`terms` 里可以写字符串，也可以写 `{t, w}`（`w` 是弱词权重，默认 1）。
 * 中文按「最长优先 + 跨度占位」匹配，`笑` 这种单字只在 `WEAK_TERMS` 里出现。
 */
export const LEXICON = Object.freeze([
  // ── 意图：认同、应答 ──────────────────────────────────────────────────────
  { id: 'agree', family: 'intent', category: 'agree', terms: [
    '答应', '点头', '好呀', '好的', '好滴', '好哒', '好嘞', '收到', '嗯嗯', '嗯呢',
    '没问题', '同意', '赞同', '可以的', '行吧', '成交', 'yes', 'okay', 'ok', 'sure',
  ] },
  { id: 'refuse', family: 'intent', category: 'refuse', terms: ['拒绝', '不要', '不行', '不可以', '不干', '免了', '算了', 'no', 'nope', 'refuse'] },
  { id: 'thanks', family: 'intent', category: 'thanks', terms: ['谢谢', '感谢', '多谢', '谢啦', 'thx', 'thanks', 'thank'] },
  { id: 'apologize', family: 'intent', category: 'apologize', terms: ['对不起', '抱歉', '不好意思', '我的错', '我错了', 'sorry', 'oops'] },
  { id: 'comfort', family: 'intent', category: 'comfort', terms: ['抱抱', '贴贴', '蹭蹭', '亲亲', '安慰', '别难过', '没事的', '有我呢', '辛苦了', '心疼', '摸摸头', 'hug', 'comfort'] },
  { id: 'laugh', family: 'intent', category: 'laugh', terms: ['哈哈', '笑死', '好笑', '大笑', '偷笑', '憋笑', '发笑', '笑疯', '嘿嘿', '嘻嘻', 'lol', 'haha', 'lmao'] },
  { id: 'tease', family: 'intent', category: 'tease', terms: ['调侃', '坏笑', '逗你', '笨蛋', '阴阳怪气', '阴阳', '嘲讽', '讽刺', '嘲', '蛐蛐', 'tease', 'you wish'] },
  { id: 'encourage', family: 'intent', category: 'encourage', terms: ['加油', '你可以的', '你可以', '冲鸭', '冲啊', '你最棒', '奥利给', '撑住', 'cheer', 'believe'] },
  { id: 'greet', family: 'intent', category: 'greet', terms: ['你好', '早上好', '早安', '晚安', '哈喽', '嗨', 'hello', 'hi', 'morning', 'hey'] },
  { id: 'stop', family: 'intent', category: 'stop', terms: ['别闹', '别笑', '住手', '住口', '打住', '停止', '停一下', '冷静', '别吵'] },
  { id: 'wait', family: 'intent', category: 'wait', terms: ['稍等', '等一下', '等等', '加载中', '缓冲', '思考中', '正在想', '马上来', '排队', 'loading', 'wait'] },
  { id: 'hunger', family: 'intent', category: 'hunger', terms: ['饿了', '好饿', '馋了', '干饭', '吃饭了', 'hunger'] },

  // ── 情绪 ─────────────────────────────────────────────────────────────────
  { id: 'joy', family: 'emotion', category: 'joy', terms: ['开心', '高兴', '快乐', '愉快', '乐呵', '笑嘻嘻', '笑眯眯', '美滋滋', '欢喜', 'happy', 'joy', 'glad'] },
  { id: 'sadness', family: 'emotion', category: 'sadness', terms: ['难过', '伤心', '委屈', '低落', '想哭', '大哭', '哭了', '流泪', '悲伤', '心酸', '呜呜', '泪目', 'sad', 'upset'] },
  { id: 'anger', family: 'emotion', category: 'anger', terms: ['生气', '愤怒', '火大', '气死', '好气', '气人', '恼火', '暴怒', 'angry', 'mad'] },
  { id: 'fear', family: 'emotion', category: 'fear', terms: ['害怕', '紧张', '怕怕', '慌了', '不安', '瑟瑟发抖', 'afraid', 'scared', 'nervous'] },
  { id: 'surprise', family: 'emotion', category: 'surprise', terms: ['惊讶', '震惊', '惊了', '我惊', '没想到', '目瞪口呆', 'wow', 'shock', 'surprise'] },
  { id: 'affection', family: 'emotion', category: 'affection', terms: ['喜欢', '爱了', '么么', '心动', '想你了', 'love', 'adore', 'heart'] },
  { id: 'tired', family: 'emotion', category: 'tired', terms: ['疲惫', '好困', '没精神', '睡不醒', '打哈欠', 'tired', 'sleepy', 'exhausted', { t: '累', w: 0.8 }, { t: '困', w: 0.8 }, { t: '乏', w: 0.6 }] },
  { id: 'smug', family: 'emotion', category: 'smug', terms: ['得意', '骄傲', '自豪', '厉害吧', '拿捏', 'smug', 'proud'] },
  { id: 'confused', family: 'emotion', category: 'confused', terms: ['看不懂', '疑惑', '迷茫', '困惑', '问号', '没懂', '蒙了', '脑子转不过来', '想不明白', '什么意思', 'confused'] },
  { id: 'awkward', family: 'emotion', category: 'awkward', terms: ['尴尬', '汗颜', '社死', '挠头', '窘迫', '难为情', '尬', 'awkward'] },
  { id: 'resignation', family: 'emotion', category: 'resignation', terms: ['无奈', '无语', '摆烂', '躺平', '叹气', '认命', '心累', '服了', '麻了', '没辙', 'resignation'] },

  // ── 语气 ─────────────────────────────────────────────────────────────────
  { id: 'playful', family: 'tone', category: 'playful', terms: ['调皮', '坏笑', '哼哼', '嬉皮笑脸', '逗', 'playful', 'fun'] },
  { id: 'light', family: 'tone', category: 'light', terms: ['轻松', '笑着', '说笑', '愉快', '笑眯眯', '笑嘻嘻', '随性', 'light', 'casual'] },
  { id: 'warm', family: 'tone', category: 'warm', terms: ['温柔', '贴心', '心疼', '辛苦了', '抱抱', '暖', 'warm', 'gentle', 'soft'] },
  { id: 'cold', family: 'tone', category: 'cold', terms: ['冷淡', '敷衍', '爱搭不理', 'cold', 'dry'] },
  { id: 'formal', family: 'tone', category: 'formal', terms: ['正式', '公文', '官方', 'formal', 'official'] },
  { id: 'ironic', family: 'tone', category: 'ironic', terms: ['反讽', '阴阳', '阴阳怪气', '阴阳人', '呵呵', '嘲讽', 'ironic', 'sarcasm'] },
  { id: 'cute', family: 'tone', category: 'cute', terms: ['乖巧', '可爱', '卖萌', '眨眼', '探头', '萌萌', '呆萌', '摇尾巴', 'cute'] },
  { id: 'serious', family: 'tone', category: 'serious', terms: ['严肃', '认真', '正经', 'serious'] },

  // ── 场景 ─────────────────────────────────────────────────────────────────
  { id: 'morning', family: 'scene', category: 'greet', terms: ['早上', '早晨', '上班前', '早餐', 'breakfast'] },
  { id: 'night', family: 'scene', category: 'greet', terms: ['晚上', '深夜', '夜里', 'midnight'] },
  { id: 'work', family: 'scene', category: 'formal', terms: ['工作', '上班', '开会', '打工', '加班', 'office', 'work', 'meeting'] },
  { id: 'study', family: 'scene', category: 'formal', terms: ['学习', '考试', '作业', '复习', 'study', 'exam'] },
  { id: 'meal', family: 'scene', category: 'hunger', terms: ['外卖', '吃饭', '餐', 'meal', 'food', 'lunch', 'dinner'] },
  { id: 'commute', family: 'scene', category: 'formal', terms: ['通勤', '路上', '地铁', 'commute', 'subway'] },
  { id: 'bedtime', family: 'scene', category: 'tired', terms: ['睡前', '睡觉', '就寝', 'bedtime', 'sleep'] },
  { id: 'comfort', family: 'scene', category: 'comfort', terms: ['低谷', '难过', 'comfort', 'low'] },
]);

/**
 * 「顺带表达」表：少数词条不只是它自己的家族，还会指向另一种家族的标签。
 * 例：`好呀` 是同意，同时也带一点轻松语气与亲昵；`笑嘻嘻` 是发笑，同时也轻松。
 * 这些提示量都是 1 档（非 0.5 弱档）——它们是人写表时的判断，不是统计出来的。
 */
export const TERM_HINTS = Object.freeze({
  答应: { tone: ['light'] },
  点头: { tone: ['light'] },
  好呀: { tone: ['light'], emotion: ['affection'] },
  好的: { tone: ['light'] },
  好滴: { tone: ['light'] },
  好哒: { tone: ['light', 'cute'] },
  收到: { tone: ['light'] },
  嗯嗯: { tone: ['light', 'cute'] },
  没问题: { tone: ['light'] },
  笑嘻嘻: { tone: ['light'] },
  笑眯眯: { tone: ['light'] },
  轻松: { emotion: ['joy'] },
  愉快: { tone: ['light'] },
  豁达: { tone: ['light'] },
  抱抱: { tone: ['warm'] },
  贴贴: { tone: ['warm', 'cute'] },
  亲亲: { tone: ['warm'] },
  辛苦了: { tone: ['warm'] },
  心疼: { tone: ['warm'] },
  乖巧: { tone: ['cute'] },
});

/** 弱词（单字或歧义大）：只给 0.6–0.8 分，避免「行了」「中」这种噪声带偏。 */
export const WEAK_TERMS = Object.freeze(['累', '困', '乏', '尬', '逗', '暖', '嘲', '餐']);

/** 攻击性措辞：只用于 `aggression` 与 `avoidWhen`，不进意图/情绪标签。 */
export const AGGRESSIVE_CUES = Object.freeze(['滚', '去死', '傻逼', '垃圾', '废物', 'fuck', 'shit', 'idiot', 'damn']);

/**
 * 否定与转折规则：**先于词表**执行。
 *
 * 这是「别笑了 / 笑不出来」不被归成「发笑」的唯一实现点；新增这类规则只加在这里，
 * 不要在词表里塞 `不笑`，那会把「笑不出来」也当成「笑」。
 */
export const SURFACE_RULES = Object.freeze([
  {
    name: 'laugh-not-able',
    note: '笑不出来 = 低落/无奈，不是发笑',
    pattern: /笑不出来|笑不出|笑不动|笑不活/,
    suppress: ['laugh'],
    add: [{ id: 'resignation', family: 'emotion', weight: 0.9 }, { id: 'sadness', family: 'emotion', weight: 0.6 }],
  },
  {
    name: 'laugh-stop',
    note: '别笑了 / 不要闹了 = 制止 + 无奈，不是发笑',
    pattern: /(别|不要|不准|不许|甭|少|停止|住口)[^，,。！？!?]{0,3}(笑|乐|哈哈|闹|嘻嘻|贫)/,
    suppress: ['laugh'],
    add: [{ id: 'stop', family: 'intent', weight: 1 }, { id: 'resignation', family: 'emotion', weight: 0.6 }],
  },
  {
    name: 'cry-and-laugh',
    note: '哭笑不得 = 混合信号，保留无奈/低落/发笑',
    pattern: /哭笑不得|又哭又笑/,
    mixed: true,
    add: [
      { id: 'resignation', family: 'emotion', weight: 0.8 },
      { id: 'sadness', family: 'emotion', weight: 0.6 },
      { id: 'laugh', family: 'intent', weight: 0.5 },
    ],
  },
  {
    name: 'angry-and-laugh',
    note: '好气又好笑 = 混合信号，保留生气与发笑',
    pattern: /好气又好笑|又气又笑|气笑了/,
    mixed: true,
    add: [{ id: 'anger', family: 'emotion', weight: 0.9 }, { id: 'laugh', family: 'intent', weight: 0.8 }],
  },
]);

/** 相反表达对（无序）：命中即「冲突」，排序层据此排除，而不是靠字符重合挑到反义素材。 */
export const CONFLICTS = Object.freeze([
  ['agree', 'refuse'],
  ['joy', 'sadness'],
  ['joy', 'resignation'],
  ['laugh', 'sadness'],
  ['comfort', 'tease'],
  ['comfort', 'anger'],
  ['agree', 'anger'],
  ['light', 'serious'],
  ['cute', 'cold'],
]);

/** 情绪相近表（非相反）。用于「情绪是否相近」的部分得分，而不是把两者当同一个。 */
export const EMOTION_SIMILARITY = Object.freeze([
  ['joy', 'affection', 0.7],
  ['sadness', 'resignation', 0.8],
  ['confused', 'awkward', 0.7],
  ['tired', 'resignation', 0.6],
  ['surprise', 'confused', 0.5],
  ['anger', 'smug', 0.3],
  ['fear', 'surprise', 0.4],
]);

/** 语气相近表：轻松与顽皮/温柔兼容，冷淡与反讽兼容。 */
export const TONE_SIMILARITY = Object.freeze([
  ['light', 'playful', 0.8],
  ['light', 'warm', 0.8],
  ['warm', 'cute', 0.7],
  ['playful', 'cute', 0.8],
  ['cold', 'formal', 0.6],
  ['ironic', 'cold', 0.5],
  ['serious', 'formal', 0.7],
]);

/** 展开口径：只展开到**同类别**的其它写法，绝不跨类别（否则「笑不出来」会展开出「哈哈」）。 */
export const EXPANSION_LIMIT = 6;

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

function plain(term) {
  return typeof term === 'string' ? { t: term, w: 1 } : { t: String(term.t ?? ''), w: Number(term.w ?? 1) };
}

/** 所有词条摊平后按长度降序（最长优先匹配，避免 `好呀` 被 `好` 抢先）。 */
const FLAT_TERMS = (() => {
  const out = [];
  for (const entry of LEXICON) {
    for (const raw of entry.terms) {
      const term = plain(raw);
      if (!term.t) continue;
      out.push({ t: term.t, w: term.w, id: entry.id, family: entry.family, category: entry.category });
    }
  }
  out.sort((a, b) => b.t.length - a.t.length || a.t.localeCompare(b.t));
  return Object.freeze(out);
})();

/** 词条文本 → 词条（按首次出现顺序，便于诊断与稳定输出）。 */
function collectHits(source) {
  const consumed = new Array(source.length).fill(false);
  const hits = [];
  for (const term of FLAT_TERMS) {
    const needle = term.t.toLowerCase();
    let from = 0;
    while (needle.length > 0) {
      const at = source.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length;
      let taken = false;
      for (let i = at; i < end; i += 1) if (consumed[i]) { taken = true; break; }
      if (!taken) {
        for (let i = at; i < end; i += 1) consumed[i] = true;
        hits.push({ ...term, at });
      }
      from = at + 1;
    }
  }
  return hits;
}

function addLabel(map, id, weight) {
  if (!id) return;
  const current = map.get(id);
  if (current === undefined || current < weight) map.set(id, weight);
}

function sortedIds(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
}

/**
 * 把一段自然语言归一化成标签集合。
 *
 * @param {string} text 查询草稿或素材描述（literal / label / ocr）
 * @returns {{
 *   intents: string[], emotions: string[], tone: string[], scenes: string[],
 *   labels: string[], aggression: number, avoidWhen: string[], mixed: boolean,
 *   matched: Array<{term: string, id: string, family: string, category: string}>,
 *   suppressed: Array<{id: string, rule: string}>,
 *   categories: string[], hasSignal: boolean,
 * }}
 */
export function normalizeText(text = '') {
  const raw = String(text ?? '').slice(0, 4000);
  const source = raw.toLowerCase();
  const intentMap = new Map();
  const emotionMap = new Map();
  const toneMap = new Map();
  const sceneMap = new Map();
  const matched = [];
  const suppressed = [];
  const categories = [];
  let mixed = false;

  // 1) 否定/转折规则先做：它决定「这个词到底还算不算」。
  for (const rule of SURFACE_RULES) {
    if (!rule.pattern.test(source)) continue;
    for (const id of rule.suppress ?? []) suppressed.push({ id, rule: rule.name });
    for (const item of rule.add ?? []) {
      const target = item.family === 'emotion' ? emotionMap
        : item.family === 'tone' ? toneMap
          : item.family === 'scene' ? sceneMap : intentMap;
      addLabel(target, item.id, Number(item.weight ?? 1));
      matched.push({ term: `[${rule.name}]`, id: item.id, family: item.family, category: rule.note });
    }
    if (rule.mixed === true) mixed = true;
    categories.push(rule.note);
  }

  // 2) 词表匹配（最长优先 + 跨度占位）。被 suppress 的 id 整族剔除。
  for (const hit of collectHits(source)) {
    if (suppressed.some(row => row.id === hit.id)) continue;
    const target = hit.family === 'emotion' ? emotionMap
      : hit.family === 'tone' ? toneMap
        : hit.family === 'scene' ? sceneMap : intentMap;
    addLabel(target, hit.id, hit.w);
    matched.push({ term: hit.t, id: hit.id, family: hit.family, category: hit.category });
    // 3) 「顺带表达」：同一份表里维护，不另写一套。
    const hints = TERM_HINTS[hit.t];
    if (hints) {
      for (const id of hints.emotion ?? []) addLabel(emotionMap, id, hit.w);
      for (const id of hints.tone ?? []) addLabel(toneMap, id, hit.w);
    }
  }

  // 4) 攻击性措辞：只影响 aggression 与 avoidWhen。
  const aggressionHits = AGGRESSIVE_CUES.filter(cue => source.includes(cue.toLowerCase())).length;
  const aggression = aggressionHits > 0 ? Math.min(1, aggressionHits / 3) : 0;

  const intents = sortedIds(intentMap);
  const emotions = sortedIds(emotionMap);
  const tone = sortedIds(toneMap);
  let scenes = sortedIds(sceneMap);

  // 场景 `comfort` 只在真的带低落信号时才算（与旧 analyzer 的口径一致）。
  if (!emotions.includes('sadness') && !emotions.includes('resignation')) {
    scenes = scenes.filter(scene => scene !== 'comfort');
  }

  // 混合信号：两个相反情绪同时出现，说明用户在表达复杂语气，不该被「相反硬门」判掉。
  if (!mixed && emotions.length >= 2) {
    mixed = conflictsBetween(emotions, emotions).length > 0;
  }

  const avoidWhen = [];
  if (emotions.includes('anger') || aggression > 0) avoidWhen.push('serious-conflict', 'apology');
  if (emotions.includes('sadness')) avoidWhen.push('celebration');

  const labels = [...intents, ...emotions, ...tone, ...scenes];
  return {
    intents, emotions, tone, scenes, labels, aggression,
    avoidWhen: [...new Set(avoidWhen)],
    mixed,
    matched,
    suppressed,
    categories: [...new Set(categories.filter(category => category && String(category).length <= 40))],
    hasSignal: labels.length > 0,
  };
}

/** 两个标签集合里命中的相反对（无序、去重）。 */
export function conflictsBetween(a = [], b = []) {
  const left = new Set(Array.isArray(a) ? a : []);
  const right = new Set(Array.isArray(b) ? b : []);
  const pairs = [];
  for (const [x, y] of CONFLICTS) {
    if ((left.has(x) && right.has(y)) || (left.has(y) && right.has(x))) pairs.push([x, y]);
  }
  return pairs;
}

/** 相近分：`wanted` 里每个标签若命中 exact 记 1，否则取最相近的 similarity。 */
export function gradedOverlap(wanted, have, similarity = []) {
  const want = wanted instanceof Set ? wanted : new Set(Array.isArray(wanted) ? wanted : []);
  if (want.size === 0) return null;
  const got = have instanceof Set ? have : new Set(Array.isArray(have) ? have : []);
  let sum = 0;
  for (const id of want) {
    if (got.has(id)) { sum += 1; continue; }
    let near = 0;
    for (const [x, y, value] of similarity) {
      if ((x === id && got.has(y)) || (y === id && got.has(x))) near = Math.max(near, Number(value) || 0);
    }
    sum += near;
  }
  return Math.min(1, sum / want.size);
}

/**
 * 召回的近义展开：只展开到同一 `category` 的其它写法，并跳过会造成相反误解的词。
 * 返回纯字符串列表（供 FTS 复用），不含 id。
 */
export function expandTerms(normalized, { limit = EXPANSION_LIMIT } = {}) {
  const wanted = new Set(normalized?.labels ?? []);
  if (wanted.size === 0) return [];
  const blocked = new Set();
  for (const [x, y] of CONFLICTS) {
    if (wanted.has(x)) blocked.add(y);
    if (wanted.has(y)) blocked.add(x);
  }
  const out = [];
  for (const entry of LEXICON) {
    if (!wanted.has(entry.id) || blocked.has(entry.id)) continue;
    for (const raw of entry.terms) {
      const term = plain(raw);
      if (term.w < 0.9) continue;
      out.push(term.t);
      if (out.length >= Math.max(0, Number(limit) || EXPANSION_LIMIT)) return [...new Set(out)];
    }
  }
  return [...new Set(out)];
}

/** 该文本是否只是标点/空白（空查询不该算出任何分数）。 */
export function isBlank(text) {
  return !CJK.test(String(text ?? '')) && !/[A-Za-z0-9]/.test(String(text ?? ''));
}

export default {
  FAMILIES, CATEGORIES, LEXICON, TERM_HINTS, WEAK_TERMS, AGGRESSIVE_CUES, SURFACE_RULES,
  CONFLICTS, EMOTION_SIMILARITY, TONE_SIMILARITY, EXPANSION_LIMIT,
  normalizeText, conflictsBetween, gradedOverlap, expandTerms, isBlank,
};
