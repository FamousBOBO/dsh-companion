/**
 * 语义卡分析：heuristics 为主，host-vision 只作为显式开启的可选增强。
 *
 * 为什么默认是 heuristics：设计文档 §5 要求「先跑起来、先可解释」，而视觉模型的调用是
 * **会花钱、会把图片发出本机**的动作。所以：
 *   - `analysis.mode='heuristics'`（默认）永远不碰网络；
 *   - `analysis.mode='host-vision'` 还要 `capture.cloudVision==='allow'` **且**调用方注入了
 *     `vision` 函数，三者缺一就退回 heuristics 并标 `reasonCode='vision-not-allowed'`；
 *   - 视觉调用失败也只退回去，不重试、不抛（一次失败的表情包不该拖垮一轮对话）。
 *
 * 明确不实现（`NOT_IMPLEMENTED`）：GIF 关键帧抽取、OCR、向量 embedding。
 * 这三样都要额外依赖或额外外部服务，本模块 0 新依赖，所以留成常量而不是"半成品代码"。
 *
 * 本模块是纯函数 + 一个可选的注入调用，没有 IO、没有时钟（时间由调用方传入）。
 *
 * 中文归一化（`analyzeWithHeuristics`）用 `synonyms.mjs` 那份**唯一**的词表：入库（本模块）
 * 与查询（`retrieval.mjs`）读的是同一个 `normalizeText()`，不许再各自维护一份中文近义表——
 * 曾经两套表导致「笑着答应、乖巧点头、轻松愉快」两边都抽不出 `agree`/`light`，只能比单字。
 * 英文线索仍由本文件的 `*_CUES` 表处理（共享表只收中文），两边取并集。
 */
import { normalizeText, AGGRESSIVE_CUES } from './synonyms.mjs';

/** 未实现的增强能力。UI 与文档据此如实标注「未实现」，不得暗示已支持。 */
export const NOT_IMPLEMENTED = Object.freeze({
  gifKeyframes: 'GIF 关键帧抽取未实现：只按首帧/静态字节判型，不做逐帧内容分析。',
  ocr: 'OCR 未实现：图上的文字不读取，ocr 恒为空串。',
  embedding: '向量检索未实现：只用 FTS5 + 结构化特征，不做 embedding 近邻。',
});

/** 私有/敏感图像的判定阈值：低于它就不入库，只进隔离区。 */
export const PRIVATE_IMAGE_THRESHOLD = 0.5;

/**
 * heuristics 语义卡的版本号。
 *
 * v2 起中文归一化交给 `synonyms.mjs`（与检索共用**唯一一份**词表）；v1 是每个文件各自
 * 维护一套中文近义的旧形态。视觉模型返回的卡有自己的版本号（见 `mergeVision`）。
 */
const DEFAULT_MODEL_VERSION = 'heuristics-v2';

/*
 * 英文线索表：共享表 `synonyms.mjs` 只收中文近义，英文仍由本文件的线索表负责。
 * 中文词条已全部移出这里 —— 同一批中文近义在仓库里只有 `synonyms.mjs` 一份，不许再抄一份。
 */
const INTENT_CUES = Object.freeze({
  greet: ['hi', 'hello', 'morning', 'night'],
  thanks: ['thanks', 'thank', 'thx'],
  apologize: ['sorry', 'oops'],
  comfort: ['hug', 'comfort'],
  laugh: ['lol', 'haha', 'lmao'],
  agree: ['agree', 'yes', 'ok'],
  refuse: ['no', 'nope', 'refuse'],
  tease: ['you wish', 'tease'],
  encourage: ['go', 'cheer', 'believe'],
});

const EMOTION_CUES = Object.freeze({
  joy: ['happy', 'joy', 'glad'],
  sadness: ['sad', 'upset'],
  anger: ['angry', 'mad'],
  fear: ['afraid', 'scared', 'nervous'],
  surprise: ['sure?', 'wow', 'shock', 'surprise'],
  affection: ['love', 'heart', 'adore'],
  tired: ['tired', 'sleepy', 'exhausted'],
  smug: ['smug', 'proud'],
});

const TONE_CUES = Object.freeze({
  playful: ['playful', 'fun'],
  warm: ['warm', 'gentle', 'soft'],
  cold: ['cold', 'dry'],
  formal: ['formal', 'official'],
  ironic: ['ironic', 'sarcasm'],
});

const RHETORIC_CUES = Object.freeze({
  pun: ['谐音', '双关', 'pun'],
  exaggeration: ['夸张', 'exaggerate', 'over the top'],
  repetition: ['重复', 'repeat', 'again and again'],
  contrast: ['反差', 'contrast'],
});

const SCENE_CUES = Object.freeze({
  morning: ['morning', 'breakfast'],
  night: ['night', 'midnight'],
  work: ['work', 'office', 'meeting'],
  study: ['study', 'exam'],
  meal: ['meal', 'food', 'lunch', 'dinner'],
  commute: ['commute', 'subway'],
  bedtime: ['bedtime', 'sleep'],
  comfort: ['comfort', 'low'],
});

/**
 * 旧表里**共享表还没覆盖**的中文线索，只为避免行为回退而暂时留在这里。
 * 这不是「第二份词表」：共享表已经覆盖的中文近义一条都不在这里（那些直接走
 * `synonyms.mjs`），这里每一条的归宿都是迁移进 `synonyms.mjs`，迁移完就从这里删掉。
 */
const LEGACY_RESIDUAL_CUES = Object.freeze({
  intents: Object.freeze({
    comfort: ['没事'],
    agree: ['对', '是的'],
    encourage: ['冲'],
  }),
  emotions: Object.freeze({
    fear: ['怕'],
    affection: ['爱', '亲亲'],
  }),
  tone: Object.freeze({
    playful: ['玩'],
    ironic: ['阴阳'],
  }),
  scenes: Object.freeze({
    morning: ['早安'],
    night: ['晚安'],
    meal: ['吃'],
    comfort: ['低谷', '难过', '安慰'],
  }),
});

/** 攻击性措辞按「一个词一个标签」摊平，复用 `matchCues` 的命中口径。 */
const CUES_BY_WORD = Object.freeze(Object.fromEntries(AGGRESSIVE_CUES.map(word => [word, [word]])));

/** 照片类线索（强）：命中就按私人图片处理。 */
const PHOTO_CUES = ['photo', '照片', '自拍', 'selfie', 'camera', '相机', '实拍'];
/** 截图类线索（强）：截图几乎一定是私人上下文，同样不进库。 */
const SCREENSHOT_CUES = ['截图', 'screenshot', 'screen shot', 'screencap'];
/** 更敏感的私人线索（强）。 */
const PRIVATE_CUES = ['私密', '隐私', '证件', '身份证', '护照', 'id card', 'passport', '裸'];
/** 表情类线索（用来把弱线索拉回「像表情包」）。 */
const STICKER_CUES = ['sticker', 'mface', 'marketface', 'emoji', '表情', 'sub_type_face'];

/**
 * 从一堆线索文本里找命中。
 * @returns {{hits: string[], score: number}}
 */
function matchCues(text, table) {
  const source = String(text ?? '').toLowerCase();
  const hits = [];
  for (const [label, cues] of Object.entries(table)) {
    if (cues.some(cue => source.includes(String(cue).toLowerCase()))) hits.push(label);
  }
  return { hits, score: hits.length };
}

/**
 * 粗略判断「这是不是一张私人照片/截图」。
 *
 * 只看**元数据线索**（来源类型、文件名提示、消息里的文字），不看图片内容——
 * 看内容要么花视觉调用（默认关掉），要么需要解码库（0 新依赖约束）。
 * 结论四分：`photo` / `screenshot` / `sticker` / `uncertain`；后两类按配置去 review 或隔离。
 * 判不准时**宁可多隔离**：`uncertain` 的默认去向是 review，可从配置改成 quarantine。
 *
 * @param {{fileNameHint?: string, summaryHint?: string, subType?: string, width?: number|null, height?: number|null, animated?: boolean}} input
 * @returns {{classification: 'photo'|'screenshot'|'sticker'|'uncertain', score: number, reasons: string[], source: 'heuristics'}}
 */
export function classifyPrivacy({ fileNameHint = '', summaryHint = '', subType = '', width = null, height = null, animated = false } = {}) {
  const text = `${String(fileNameHint)} ${String(summaryHint)} ${String(subType)}`.toLowerCase();
  const reasons = [];
  let score = 0;
  const has = cues => cues.some(cue => text.includes(cue));
  if (has(PRIVATE_CUES)) { score += 3; reasons.push('private-cue'); }
  if (has(PHOTO_CUES)) { score += 2; reasons.push('photo-cue'); }
  if (has(SCREENSHOT_CUES)) { score += 2; reasons.push('screenshot-cue'); }
  const sub = String(subType).toLowerCase();
  if (sub === 'flash' || sub === 'photo') { score += 1; reasons.push('sub-type'); }
  // 4:3 / 3:4 的「照片比例」只作为弱线索：表情包也常常是这个比例，单靠它不能定罪。
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    const ratio = Math.max(width, height) / Math.min(width, height);
    if (ratio >= 1.25 && ratio <= 1.45 && Math.max(width, height) >= 640) { score += 0.5; reasons.push('photo-aspect'); }
  }
  if (animated) reasons.push('animated');

  // 明确是「表情/贴纸」来源时，弱线索不该把它判成私人图片（否则整个功能被误杀）。
  if (has(STICKER_CUES) && score < 2) return { classification: 'sticker', score, reasons: [...reasons, 'sticker-hint'], source: 'heuristics' };
  if (score >= 3 || has(SCREENSHOT_CUES) || (has(PHOTO_CUES) && has(PRIVATE_CUES))) {
    return { classification: has(SCREENSHOT_CUES) ? 'screenshot' : 'photo', score, reasons, source: 'heuristics' };
  }
  if (score >= 2) return { classification: 'photo', score, reasons, source: 'heuristics' };
  if (score > 0) return { classification: 'uncertain', score, reasons, source: 'heuristics' };
  return { classification: 'sticker', score, reasons: ['no-photo-cue'], source: 'heuristics' };
}

/** 由分类结果决定入库去向：approved 之外的一律走审核态。 */
export function moderationFor({ classification, uncertainMode = 'review' } = {}) {
  if (classification === 'photo' || classification === 'screenshot') {
    return { moderation: 'quarantined', capture: false, reasonCode: 'private-image-quarantined', message: '看起来是照片/截图，按隐私规则进了隔离区，不参与检索与投递。' };
  }
  if (classification === 'sticker') {
    return { moderation: 'review', capture: true, reasonCode: '', message: '像表情包，进审核队列等待通过。' };
  }
  const quarantine = uncertainMode === 'quarantine';
  return {
    moderation: quarantine ? 'quarantined' : 'review',
    capture: !quarantine,
    reasonCode: quarantine ? 'uncertain-quarantined' : 'uncertain-review',
    message: quarantine ? '判不准的素材按配置进了隔离区。' : '判不准的素材按配置进了审核队列。',
  };
}

/**
 * 标签并集：按来源顺序去重（共享表的命中顺序在前，它按匹配权重排过序；英文线索表在后）。
 * 两个来源都是纯函数式的确定性输出，所以并集也确定，同一输入永远同一张卡。
 */
function unionLabels(primary, secondary) {
  return [...new Set([...primary, ...secondary])];
}

/**
 * heuristics 语义卡。所有字段都是确定性的，同一输入永远同一输出（便于测试与复现）。
 *
 * 标签来自**两条来源的并集**：
 *   1. `synonyms.mjs` 的 `normalizeText()`（中文近义 + 否定/转折规则 + 攻击性措辞，与检索共用）；
 *   2. 本文件的英文线索表与少量残留中文线索（共享表还没覆盖的那些）。
 *
 * `hint` 也会一起归一化：素材来源方给的提示语常常是中文（QQ 的表情名、文件名注释），
 * 只归一化 `literal` 会漏掉它们。
 *
 * @param {{literal?: string, hint?: string, animated?: boolean, kind?: string}} input
 */
export function analyzeWithHeuristics({ literal = '', hint = '', animated = false } = {}) {
  const text = `${String(literal)} ${String(hint)}`.trim();
  const normalized = normalizeText(text);
  const residual = family => (LEGACY_RESIDUAL_CUES[family] ?? {});
  const residualHits = family => matchCues(text, residual(family)).hits;

  const intents = unionLabels(normalized.intents, [...matchCues(text, INTENT_CUES).hits, ...residualHits('intents')]);
  const emotions = unionLabels(normalized.emotions, [...matchCues(text, EMOTION_CUES).hits, ...residualHits('emotions')]);
  const tone = unionLabels(normalized.tone, [...matchCues(text, TONE_CUES).hits, ...residualHits('tone')]);
  const rhetoric = unionLabels([], matchCues(text, RHETORIC_CUES).hits);
  // 场景 `comfort` 只在真的带低落信号时才算——与 `normalizeText()` 同一口径。
  const scenes = unionLabels(normalized.scenes, [...matchCues(text, SCENE_CUES).hits, ...residualHits('scenes')])
    .filter(scene => scene !== 'comfort' || emotions.includes('sadness') || emotions.includes('resignation'));
  // 攻击性措辞两边都算：共享表负责中文，这里再叠一遍英文线索表（同一口径，取较大值）。
  const aggressionHits = matchCues(text, CUES_BY_WORD).hits.length;
  const aggression = Math.max(normalized.aggression, aggressionHits > 0 ? Math.min(1, aggressionHits / 3) : 0);
  const avoidWhen = [];
  if (emotions.includes('anger') || aggression > 0) avoidWhen.push('serious-conflict', 'apology');
  if (emotions.includes('sadness')) avoidWhen.push('celebration');
  if (animated) avoidWhen.push('low-bandwidth');
  const evidence = intents.length + emotions.length + tone.length;
  const confidence = Math.min(0.9, 0.35 + evidence * 0.12);
  return {
    literal: String(literal ?? '').slice(0, 200),
    ocr: '',
    intents: [...new Set(intents)].slice(0, 8),
    emotions: [...new Set(emotions)].slice(0, 8),
    tone: [...new Set(tone)].slice(0, 6),
    rhetoric: [...new Set(rhetoric)].slice(0, 6),
    scenes: [...new Set(scenes)].slice(0, 8),
    avoidWhen: [...new Set(avoidWhen)].slice(0, 8),
    aggression,
    confidence: Number(confidence.toFixed(2)),
    mixed: normalized.mixed === true,
    modelVersion: DEFAULT_MODEL_VERSION,
    source: 'heuristics',
    notImplemented: NOT_IMPLEMENTED,
  };
}

/** 视觉模型返回的结构必须能被夹到同一形状；夹不动就用 heuristics 结果。 */
function mergeVision(heuristic, vision) {
  if (!vision || typeof vision !== 'object') return heuristic;
  const pickList = value => (Array.isArray(value) ? value.map(item => String(item).slice(0, 40)).slice(0, 8) : []);
  const merged = {
    ...heuristic,
    literal: String(vision.literal ?? heuristic.literal).slice(0, 200),
    intents: pickList(vision.intents).length ? pickList(vision.intents) : heuristic.intents,
    emotions: pickList(vision.emotions).length ? pickList(vision.emotions) : heuristic.emotions,
    tone: pickList(vision.tone).length ? pickList(vision.tone) : heuristic.tone,
    rhetoric: pickList(vision.rhetoric).length ? pickList(vision.rhetoric) : heuristic.rhetoric,
    scenes: pickList(vision.scenes).length ? pickList(vision.scenes) : heuristic.scenes,
    avoidWhen: pickList(vision.avoidWhen).length ? pickList(vision.avoidWhen) : heuristic.avoidWhen,
    aggression: Number.isFinite(Number(vision.aggression)) ? Math.min(1, Math.max(0, Number(vision.aggression))) : heuristic.aggression,
    confidence: Number.isFinite(Number(vision.confidence)) ? Math.min(1, Math.max(0, Number(vision.confidence))) : heuristic.confidence,
    modelVersion: String(vision.modelVersion ?? 'host-vision-v1').slice(0, 40),
    source: 'host-vision',
  };
  return merged;
}

/**
 * 分析入口。
 *
 * @param {{config: object, bytes?: Buffer, hint?: string, literal?: string, animated?: boolean,
 *   fileNameHint?: string, summaryHint?: string, subType?: string, width?: number|null, height?: number|null,
 *   vision?: Function|null, minConfidence?: number}} input
 * @returns {Promise<{card: object, privacy: object, moderation: object, modeUsed: string, reasonCode: string, warnings: string[]}>}
 */
export async function analyze(input = {}) {
  const config = input.config ?? {};
  const warnings = [];
  const mode = String(config?.analysis?.mode ?? 'heuristics');
  const cloudVision = String(config?.capture?.cloudVision ?? 'deny');
  const heuristic = analyzeWithHeuristics({ literal: input.literal ?? '', hint: input.hint ?? '', animated: input.animated === true });
  const privacy = classifyPrivacy({
    fileNameHint: input.fileNameHint ?? '', summaryHint: input.summaryHint ?? input.hint ?? '',
    subType: input.subType ?? '', width: input.width ?? null, height: input.height ?? null, animated: input.animated === true,
  });
  const moderation = moderationFor({ classification: privacy.classification, uncertainMode: config?.capture?.uncertain ?? 'review' });
  // 私人图片是硬线：无论视觉开关怎么配，都不把照片/截图的字节送出去。
  const privacyBlocked = privacy.classification === 'photo' || privacy.classification === 'screenshot';

  let card = heuristic;
  let modeUsed = 'heuristics';
  let reasonCode = '';
  if (mode === 'off') {
    reasonCode = 'analysis-off';
    modeUsed = 'off';
  } else if (mode === 'host-vision') {
    if (cloudVision !== 'allow') {
      reasonCode = 'vision-not-allowed';
      warnings.push('capture.cloudVision 不是 allow，本轮没有调用视觉模型，卡片来自 heuristics。');
    } else if (typeof input.vision !== 'function') {
      reasonCode = 'vision-not-injected';
      warnings.push('没有注入视觉函数，本轮没有调用视觉模型，卡片来自 heuristics。');
    } else if (privacyBlocked) {
      // 这张图被判为照片/截图：即使开了视觉也不送出去。这是隐私硬线，不是偏好。
      reasonCode = 'vision-blocked-by-privacy';
      warnings.push('这张图被判为私人图片/截图，按隐私规则不送视觉模型。');
    } else {
      try {
        const vision = await input.vision({
          bytes: input.bytes, hint: input.hint ?? '', mime: input.mime ?? '',
          // 视觉函数只给字节与提示，不给路径：它没有机会读整个磁盘。
          notImplemented: NOT_IMPLEMENTED,
        });
        card = mergeVision(heuristic, vision);
        modeUsed = 'host-vision';
      } catch (error) {
        reasonCode = 'vision-failed';
        warnings.push(`视觉调用失败，退回 heuristics：${String(error?.message ?? error).slice(0, 120)}`);
      }
    }
  }

  const minConfidence = Number(input.minConfidence ?? config?.analysis?.minConfidence ?? 0.55);
  return {
    card,
    privacy,
    moderation,
    modeUsed,
    reasonCode,
    confident: Number(card.confidence) >= minConfidence,
    warnings,
  };
}

/** 便捷包装：只想要卡时用它（视觉关闭路径完全同步语义，但仍返回 Promise 以便统一调用）。 */
export async function analyzeCard(options = {}) {
  const result = await analyze(options);
  return result.card;
}

export default {
  NOT_IMPLEMENTED, PRIVATE_IMAGE_THRESHOLD, classifyPrivacy, moderationFor,
  analyzeWithHeuristics, analyze, analyzeCard,
};
