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
 */

/** 未实现的增强能力。UI 与文档据此如实标注「未实现」，不得暗示已支持。 */
export const NOT_IMPLEMENTED = Object.freeze({
  gifKeyframes: 'GIF 关键帧抽取未实现：只按首帧/静态字节判型，不做逐帧内容分析。',
  ocr: 'OCR 未实现：图上的文字不读取，ocr 恒为空串。',
  embedding: '向量检索未实现：只用 FTS5 + 结构化特征，不做 embedding 近邻。',
});

/** 私有/敏感图像的判定阈值：低于它就不入库，只进隔离区。 */
export const PRIVATE_IMAGE_THRESHOLD = 0.5;

/** 视觉结果与 heuristics 的置信度下限（与 config.analysis.minConfidence 对齐后取大者）。 */
const DEFAULT_MODEL_VERSION = 'heuristics-v1';

const INTENT_CUES = Object.freeze({
  greet: ['你好', '早上好', '晚安', 'hi', 'hello', 'morning', 'night'],
  thanks: ['谢谢', '感谢', '多谢', 'thanks', 'thank', 'thx'],
  apologize: ['对不起', '抱歉', '不好意思', 'sorry', 'oops'],
  comfort: ['抱抱', '安慰', '没事', '别难过', 'hug', 'comfort'],
  laugh: ['哈哈', '笑死', '嘿嘿', 'lol', 'haha', 'lmao'],
  agree: ['同意', '赞同', '对', '是的', 'agree', 'yes', 'ok'],
  refuse: ['不要', '拒绝', '算了', 'no', 'nope', 'refuse'],
  tease: ['调侃', '坏笑', '笨蛋', 'you wish', 'tease'],
  encourage: ['加油', '你可以', '冲', 'go', 'cheer', 'believe'],
});

const EMOTION_CUES = Object.freeze({
  joy: ['开心', '高兴', '快乐', 'happy', 'joy', 'glad'],
  sadness: ['难过', '伤心', '委屈', 'sad', 'upset'],
  anger: ['生气', '愤怒', '火大', 'angry', 'mad'],
  fear: ['害怕', '紧张', '怕', 'afraid', 'scared', 'nervous'],
  surprise: ['惊讶', '震惊', 'sure?', 'wow', 'shock', 'surprise'],
  affection: ['喜欢', '爱', '亲亲', 'love', 'heart', 'adore'],
  tired: ['累', '困', '疲惫', 'tired', 'sleepy', 'exhausted'],
  smug: ['得意', '骄傲', 'smug', 'proud'],
});

const TONE_CUES = Object.freeze({
  playful: ['玩', '逗', '调皮', 'playful', 'fun'],
  warm: ['温柔', '暖', '贴心', 'warm', 'gentle', 'soft'],
  cold: ['冷淡', '敷衍', 'cold', 'dry'],
  formal: ['正式', '公文', 'formal', 'official'],
  ironic: ['反讽', '阴阳', 'ironic', 'sarcasm'],
});

const RHETORIC_CUES = Object.freeze({
  pun: ['谐音', '双关', 'pun'],
  exaggeration: ['夸张', 'exaggerate', 'over the top'],
  repetition: ['重复', 'repeat', 'again and again'],
  contrast: ['反差', 'contrast'],
});

const SCENE_CUES = Object.freeze({
  morning: ['早上', '早安', 'morning', 'breakfast'],
  night: ['晚上', '深夜', '晚安', 'night', 'midnight'],
  work: ['上班', '工作', '开会', 'work', 'office', 'meeting'],
  study: ['学习', '考试', '作业', 'study', 'exam'],
  meal: ['吃饭', '外卖', '吃', 'meal', 'food', 'lunch', 'dinner'],
  commute: ['通勤', '路上', '地铁', 'commute', 'subway'],
  bedtime: ['睡前', '睡觉', 'bedtime', 'sleep'],
  comfort: ['低谷', '难过', '安慰', 'comfort', 'low'],
});

const AGGRESSIVE_CUES = ['滚', '去死', '傻逼', '垃圾', '废物', 'fuck', 'shit', 'idiot', 'damn'];

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
 * heuristics 语义卡。所有字段都是确定性的，同一输入永远同一输出（便于测试与复现）。
 * @param {{literal?: string, hint?: string, animated?: boolean, kind?: string}} input
 */
export function analyzeWithHeuristics({ literal = '', hint = '', animated = false } = {}) {
  const text = `${String(literal)} ${String(hint)}`.trim();
  const intents = matchCues(text, INTENT_CUES).hits;
  const emotions = matchCues(text, EMOTION_CUES).hits;
  const tone = matchCues(text, TONE_CUES).hits;
  const rhetoric = matchCues(text, RHETORIC_CUES).hits;
  const scenes = matchCues(text, SCENE_CUES).hits.filter(scene => scene !== 'comfort' || emotions.includes('sadness'));
  const aggression = matchCues(text, Object.fromEntries(AGGRESSIVE_CUES.map(word => [word, [word]]))).hits;
  const avoidWhen = [];
  if (emotions.includes('anger') || aggression.length > 0) avoidWhen.push('serious-conflict', 'apology');
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
    aggression: aggression.length > 0 ? Math.min(1, aggression.length / 3) : 0,
    confidence: Number(confidence.toFixed(2)),
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
