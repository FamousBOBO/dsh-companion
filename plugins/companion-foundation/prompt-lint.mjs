/**
 * Prompt Engine — 文风检测（§12）。
 *
 * 依据 `PROMPT-ENGINE-CONTRACT.md` §2.6。纯函数：不读文件、不写文件、不改写文本、
 * 不调用模型。输出**只有统计数字与理由码**，绝不回传任何原文片段。
 *
 * 第一期只检测：结果只进诊断，不参与生成，也不阻断任何回复。
 */

/** 阈值：超过才算"超标"。集中在这里，改阈值只改这一处。 */
export const LINT_THRESHOLDS = Object.freeze({
  /** 对偶模板「不是X，而是Y」「不像X，更像Y」：>= 3 次算超标。 */
  contrastiveTemplates: 3,
  /** 比喻模板「像是/仿佛/似乎」：>= 4 次算超标。 */
  simileTemplates: 4,
  /** 填充词「微微/一瞬/一拍/轻轻/缓缓」合计 >= 5 次算超标。 */
  fillerMotifs: 5,
  /** 抽象比喻（眼神/声音/空气 + 抽象形容）：>= 3 次算超标。 */
  abstractMetaphors: 3,
  /** 动作后解释情绪（"说完，他有些…"）：>= 3 次算超标。 */
  emotionExplanations: 3,
  /** 连续并列短句（一句里 3 个以上顿号并列）：>= 3 处算超标。 */
  parallelRuns: 3,
  /** 段落结尾强行总结（"总之/说到底/或许这就是"）：>= 2 次算超标。 */
  summaryEndings: 2,
  /** 同一转折/连接词（"其实/然而/而/不过"）重复：>= 4 次算超标。 */
  connectiveRepeats: 4,
  /** 复述用户原话：只统计"你刚才说/你的意思是"这类引述框架，>= 1 次记一条。 */
  echoUser: 1,
  /** 机械肯定开头（"确实/的确/你说得对"开头）：>= 3 次算超标。 */
  mechanicalAffirm: 3,
  /** 普通聊天档**不检测**白描：白描只在叙事档才是规范，检测它只会制造误报。 */
  narrativeOnlyFindings: Object.freeze(['over-explained-action']),
});

const ALL_PROFILES = Object.freeze(['chat', 'companion', 'implicit-roleplay', 'roleplay-narrative', 'task']);
const NARRATIVE_PROFILES = new Set(['implicit-roleplay', 'roleplay-narrative']);

function countMatches(text, pattern) {
  const matches = text.match(pattern);
  return Array.isArray(matches) ? matches.length : 0;
}

function splitSentences(text) {
  return text
    .split(/[。！？!?；;\n]+/)
    .map(part => part.trim())
    .filter(Boolean);
}

/**
 * 检测一段回复的文风。
 *
 * @param {unknown} text 回复正文
 * @param {{profile?: string, mode?: string, operators?: object}} [options]
 * @returns {{
 *   chars: number, profile: string,
 *   counts: Record<string, number>,
 *   findings: Array<{code: string, count: number}>,
 *   ok: boolean,
 * }}
 */
export function lintText(text, { profile = 'chat', mode = '', operators = null } = {}) {
  const body = typeof text === 'string' ? text : '';
  const safeProfile = ALL_PROFILES.includes(profile) ? profile : 'chat';
  const safeMode = typeof mode === 'string' && mode ? mode : (safeProfile === 'task' ? 'task' : safeProfile === 'companion' ? 'companion' : safeProfile.startsWith('roleplay') || safeProfile === 'implicit-roleplay' ? 'roleplay' : 'chat');
  const sentences = splitSentences(body);
  const isNarrative = NARRATIVE_PROFILES.has(safeProfile);

  // 1. 对偶模板：不是X，而是Y / 不像X，更像Y / 与其…不如…
  const contrastiveTemplates =
    countMatches(body, /不是[^。！？\n]{1,24}[，,]\s*而是/g)
    + countMatches(body, /不像[^。！？\n]{1,24}[，,]\s*更像/g)
    + countMatches(body, /与其[^。！？\n]{1,24}[，,]\s*不如/g);

  // 2. 比喻模板：像是 / 仿佛 / 好似
  const simileTemplates = countMatches(body, /(像是|仿佛|好似|宛如)/g);

  // 3. 填充词：微微/一瞬/一拍/轻轻/缓缓/悄然
  const fillerMotifs = countMatches(body, /(微微|一瞬|一拍|轻轻|缓缓|悄然)/g);

  // 4. 抽象比喻：眼神/声音/空气/目光 + 抽象形容
  const abstractMetaphors = countMatches(body, /(眼神|目光|声音|空气|气氛|沉默)[^。！？\n]{0,8}(几分|有些|某种|一丝|说不清|化不开|复杂|柔软|锋利|沉)/g);

  // 5. 动作后解释情绪：说完/笑着/伸手 + 他/她 + 有些/似乎/好像
  const emotionExplanations = countMatches(body, /(说完|说罢|笑着|低声|抬头|伸手|转身)[^。！？\n]{0,12}(有些|似乎|好像|带着几?分)/g);

  // 6. 连续并列短句：一句里 3 个以上顿号
  const parallelRuns = sentences.filter(sentence => countMatches(sentence, /、/g) >= 3).length;

  // 7. 段落结尾强行总结
  const summaryEndings = countMatches(body, /(总之|说到底|归根结底|或许这就是|这就是所谓|不管怎样，)/g);

  // 8. 固定转折词重复：取出现最多的那一个
  const connectives = ['其实', '然而', '不过', '所以说', '换句话说'];
  const connectiveCounts = connectives.map(word => countMatches(body, new RegExp(word, 'g')));
  const connectiveRepeats = connectiveCounts.length ? Math.max(...connectiveCounts) : 0;

  // 9. 复述用户原话的框架（只在 chat/companion 档算问题）
  const echoUser = countMatches(body, /(你刚才说|你说的是|你的意思是|就像你说的|你提到)/g);

  // 10. 机械肯定开头（"确实…""你说得对…"）
  const mechanicalAffirm = sentences.filter(sentence => /^(确实|的确|你说得对|没错|是的[，,])/.test(sentence)).length;

  // 11. 过度解释动作（只在叙事档才有意义：动作后面跟解释性旁白）
  const overExplainedAction = isNarrative
    ? countMatches(body, /[^。！？\n]{0,10}(这个动作|这样做|的用意|意思是|像是在暗示|仿佛在说)/g)
    : 0;

  const counts = {
    sentences: sentences.length,
    contrastiveTemplates,
    simileTemplates,
    fillerMotifs,
    abstractMetaphors,
    emotionExplanations,
    parallelRuns,
    summaryEndings,
    connectiveRepeats,
    echoUser,
    mechanicalAffirm,
    overExplainedAction,
  };

  const findings = [];
  const flag = (code, count, threshold) => {
    if (count >= threshold) findings.push({ code, count });
  };
  flag('contrastive-template', contrastiveTemplates, LINT_THRESHOLDS.contrastiveTemplates);
  flag('simile-template', simileTemplates, LINT_THRESHOLDS.simileTemplates);
  flag('filler-motif', fillerMotifs, LINT_THRESHOLDS.fillerMotifs);
  flag('abstract-metaphor', abstractMetaphors, LINT_THRESHOLDS.abstractMetaphors);
  flag('emotion-explanation', emotionExplanations, LINT_THRESHOLDS.emotionExplanations);
  flag('parallel-clauses', parallelRuns, LINT_THRESHOLDS.parallelRuns);
  flag('summary-ending', summaryEndings, LINT_THRESHOLDS.summaryEndings);
  flag('connective-repeat', connectiveRepeats, LINT_THRESHOLDS.connectiveRepeats);
  flag('mechanical-affirm', mechanicalAffirm, LINT_THRESHOLDS.mechanicalAffirm);
  // 复述用户原话与过度解释动作只在"聊天/陪伴"档算问题；叙事档的旁白不复述用户。
  if (safeProfile === 'chat' || safeProfile === 'companion') flag('echo-user', echoUser, LINT_THRESHOLDS.echoUser);
  if (isNarrative) flag('over-explained-action', overExplainedAction, 1);

  return {
    chars: body.length,
    profile: safeProfile,
    counts,
    findings: findings.slice(0, 10),
    ok: findings.length === 0,
  };
}

export default { lintText, LINT_THRESHOLDS };
