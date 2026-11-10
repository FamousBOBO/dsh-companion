// 群聊可见人格快照端口（P0-A，实施计划 §4.1）。
//
// 为什么需要这个文件：群聊是**公开场合**。群人格提示词（plugins/companion-group）现在只会说
// 「具体身份、性格与说话风格以人格文件为准」，模型在群里其实看不到人格文件，于是它要么敷衍，
// 要么编造。这个端口把人格文件里**本来就公开的那几段**整理成结构化快照，交给群聊通道使用：
// QQ 插件的自主接话走的是一次**纯补全**（没有会话、没有系统提示词、没有工具面），除了这条缝
// 它拿不到任何角色信息（`dsh-channel-qq/src/adapters/dsh-host/group-persona.ts` 是消费端）。
//
// 三条硬规则（写在这里就是评审判据，改动前先读）：
//
//   1. 只从人格文件派生。唯一输入是 `suite-paths.mjs` 解析出来的人格文档
//      （config/persona.md → config/persona.example.md → workspace/PERSONA.md）。本模块
//      **不打开**记忆库、不读私聊会话、不读 identity.json 里的主人 QQ 号/称呼。原因：群成员
//      不是同一个人，一旦把私聊记忆带进群里，泄露是**不可撤回**的（对方已经看到了），
//      而「以后注意」这种补救不存在。宁可群里少知道一点。
//
//   2. 只白名单抽取，绝不整份转储。人格文件里同时写着「记忆里希望保留什么」这类**私聊**
//      用途的小节；把整份 markdown 塞进快照就等于把它们也公开了。所以这里维护的是一份
//      「哪些标题可能公开」的小清单：命中就抽，没命中就留空（空串/空数组），**不猜、不编、
//      不补默认人设**。每个字段还有字数上限，整份快照另有 1600 字总上限：群聊提示词里塞进
//      几千字的人格只会把这一轮真正要说的话挤掉。
//
//   3. 发布方式沿用仓库既有两种做法，不发明第三种：
//        a. `ctx.provide('companionGroupPersona', port)` —— cordis 契约；
//        b. process 级 Symbol 注册表 `Symbol.for('dsh.companion.ports.v1')`（与
//           health-service-ref.mjs **同一个** symbol、同一个 Map、同一种 `{service, ready()}` 值形状），
//           键是**裸 dataRoot**；
//        c. service-bridge（模块级 + canonical home 键，名字已加白名单）。
//      为什么不能只做 a：`companion-foundation` 与 `dsh-channel-qq` 在合成里是**兄弟行**，
//      `ctx.get()` 跨不过去。2026-11-04 的健康服务就是这么在生产里「配置正确但整条功能不生效」的。
//      root 必须是 dataRoot（`resolveDataRoot(...).dataRoot`），不是 suiteRoot、不是 `data/home`：
//      消费端用 `dirname(realpathSync(host.dshHome))` 算键，两边对不上就是**静默**失效。
//
// 边界取舍（评审会问，先写清楚）：本模块**不对正文做关键词过滤**。
//
// 它靠两件**结构性**的事挡住私聊内容：① 来源——只读人格文件，绝不打开记忆库、私聊会话、
// identity.json；② **标题**级白名单 + 否决——私聊/记忆类小节从标题起就不会被抽取
// （「## 私聊里才可以说的事」「## 记忆里希望保留什么」「## 和主人的共同经历」）。
// 没有采用「把正文里出现『主人』『密码』的词删掉」这种做法，因为那既拦不住（换个说法照样泄露，
// 见 test 里「边界取舍的另一半」用例），又会误伤正常人格用词（「不替主人做决定」是边界本身）。
//
// 因此本模块**能**保证的是：快照的内容不来自记忆库、不来自私聊会话，也不来自标题标明私事的小节。
// 它**不能**保证的是：用户把私事写进了被抽取的小节正文（例如在「## 身份」里写主人家密码）时，
// 那段文字不会进快照——那是用户自己写进人格文件、而同一个文件本来就整份进私聊系统提示词的内容，
// 本模块不假装能替他判断语义。这条边界由 group-persona.test.mjs 的两个方向共同固定：
// 「私聊/记忆小节不进快照」与「被抽取小节里的同一个词原样保留」。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createServiceBridge } from './service-bridge.mjs';

/** 端口名。与既有 `companionMemory` / `companionAgenda` 同一套命名：一个服务一个驼峰名。 */
export const GROUP_PERSONA_SERVICE_NAME = 'companionGroupPersona';
/**
 * process 级注册表的 Symbol 键，与 health-service-ref.mjs **同一个** `Symbol.for`。
 *
 * `Symbol.for` 是全局符号表里的同一个键：两个模块各写一次也拿到同一个 Map，这正是跨插件行
 * 可靠的原因（模块标识可能因为 specifier 写法、junction、preset realm 而不同，`process`
 * 不会）。消费端契约就是 `Map<dataRoot, { service, ready() }>`，所以这里**用裸 dataRoot 作键**，
 * 与健康服务一模一样；同时另写一份「服务名\u0000root」的复合键（见 registryKeysOf），
 * 这样即使裸键被别的服务占着，本模块自己的解析仍然找得到端口。
 */
export const GROUP_PERSONA_PORT_SYMBOL = Symbol.for('dsh.companion.ports.v1');

/** 字段上限。数字写在一处，测试与实现读同一份，改小改大都不会两边打架。 */
export const GROUP_PERSONA_LIMITS = Object.freeze({
  identity: 200,
  personality: 400,
  speakingStyle: 400,
  emotionalState: 120,
  listItem: 80,
  listItems: 8,
  total: 1600,
  /** 人格文件最多读这么多字符：再大也不进群聊，防止误指向一个大文件把提示词撑爆。 */
  maxChars: 200_000,
});

/**
 * 标题级的**负向**守卫：标题里带这些词的小节，哪怕别名命中也不抽。
 *
 * 为什么白名单还不够：`事实` `经历` 这类别名足够常见，而「## 主人不愿公开的事实」
 * 「## 和主人的共同经历」也会**包含**它们——这正是最不该进群聊的内容。所以在别名之外
 * 再加一道只看标题的否决：标题本身就是「这一节是不是私事」的元信息，读它不违反「不读记忆库/
 * 不读私聊会话」。代价是会误杀「## 和主人的互动边界」这种合法小节（结果是留空）——
 * 留空的代价是群里少知道一点，误放进去的代价是不可撤回，两害相权取留空。
 */
const PRIVATE_TITLE_MARKERS = Object.freeze(['私聊', '私人', '隐私', '内部', '秘密', '记忆', '主人', '不公开', '别告诉']);

/**
 * 标题白名单。顺序 = 契约里的字段顺序，也是总预算的消耗顺序。
 *
 * `aliases` 是**包含匹配**（标题里出现别名即可，例如「身份设定」命中「身份」）。别名词必须
 * 足够具体：`设定` `状态` 这种词会把「## 私聊设定」也吸进来，等于偷偷解除了规则 2，所以
 * 宁可不支持它们。一个标题只认领一个字段（先到先得），避免「性格与说话风格」同时填两栏。
 */
const FIELD_SPECS = Object.freeze([
  { key: 'identity', aliases: ['身份', '你是谁', '自我介绍'] },
  { key: 'personality', aliases: ['性格', '个性', '性情', '脾气'] },
  { key: 'speakingStyle', aliases: ['说话风格', '语言风格', '表达风格', '说话方式', '语气', '口吻'] },
  { key: 'interests', aliases: ['兴趣', '爱好', '喜欢的东西'] },
  { key: 'knownExperiences', aliases: ['经历', '共同经历', '往事', '可以讲的故事'] },
  { key: 'emotionalState', aliases: ['情绪', '心情', '可公开的状态'] },
  { key: 'publicFacts', aliases: ['公开事实', '可公开的事实', '事实', '公开信息'] },
  { key: 'interactionBoundaries', aliases: ['边界', '互动边界', '限制', '底线', '不能做的事'] },
]);

/**
 * 来源标签：只写**相对于套件根**的稳定拼写，绝不写绝对路径。
 *
 * 理由：快照会被注入群聊提示词，而 Windows 的绝对路径形如 `C:\Users\<用户名>\…`，那等于
 * 把主人的用户名带进公开群。标签只需要让排查的人知道「人格来自哪一份」，不需要知道盘符。
 */
const SOURCE_LABELS = Object.freeze({
  config: 'config/persona.md',
  template: 'config/persona.example.md',
  legacy: 'workspace/PERSONA.md',
  missing: 'persona.md',
});

/**
 * @typedef {object} GroupPersonaSnapshot
 * @property {string} version 人格文件内容的短哈希：改一个字就变，用于热更新与排查。
 * @property {string} personaId 来自 identity / suite.json。
 * @property {string} identity 角色是谁（≤200 字）。
 * @property {string} personality 稳定性格（≤400 字）。
 * @property {string} speakingStyle 用词/句长/口语程度（≤400 字）。
 * @property {string[]} interests ≤8 条，每条 ≤80 字。
 * @property {string[]} knownExperiences ≤8 条，允许在群里使用的真实经历。
 * @property {string} [emotionalState] 可公开的轻量状态（≤120 字；缺省就不带这个键）。
 * @property {string[]} publicFacts ≤8 条，允许公开的事实。
 * @property {string[]} interactionBoundaries ≤8 条。
 * @property {string} source 来源标签（例如 `config/persona.md`）。
 * @property {true} publicOnly 明确声明这是「群聊可见字段」，不是私聊上下文。
 */

function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex');
}

/** 短版本号：8 位十六进制，与 autonomy-materials.mjs 里 `persona.version` 的格式一致。 */
function shortHash(text) {
  return sha256(text).slice(0, 8);
}

/**
 * 按**字符**（码点）截断，而不是按 UTF-16 单元。
 *
 * 理由：中文正则在 BMP 里没问题，但人格文件里常夹 emoji；`String#slice` 会把代理对劈成两半，
 * 结果是快照里出现一个 U+FFFD 一样的残字。上限本来就是为了「够用且不撑爆提示词」，
 * 少一两个字符没有代价。
 */
function clampChars(text, cap) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= cap) return chars.join('');
  return chars.slice(0, cap).join('');
}

/** 标题识别。只认 ATX 标题：比 setext 常见，也比「碰巧一行加粗」更不容易误判。 */
function headingOf(line) {
  const match = /^ {0,3}(#{1,6})[ \t]+(.*\S)[ \t]*$/.exec(line);
  if (!match) return null;
  return { level: match[1].length, title: match[2].trim() };
}

/** 标题归一化：去掉空白、标点、装饰符号，统一小写，这样「## 说话风格：」与「## 说话风格」等价。 */
function normalizeTitle(title) {
  return String(title ?? '')
    .replace(/[\s*_`"'「」『』【】《》()（）:：、，。,.!！?？\-—~～/]+/g, '')
    .toLowerCase();
}

/**
 * 切成小节：每个标题开启一节，直到下一个标题（不按层级嵌套）。
 *
 * 为什么不做层级嵌套：人格文件是给人看的散文，不是 AST。按文档顺序切段既符合直觉，也保证
 * 「## 私聊里才可以说的事」下面无论写几层 `###`，都只会留在**它自己这一节**里，不会被
 * 某个被白名单命中的父标题顺手带进快照。
 *
 * @param {string} markdown
 * @returns {{level: number, title: string, normalized: string, lines: string[]}[]}
 */
function sectionsOf(markdown) {
  const sections = [];
  let current = null;
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const heading = headingOf(line);
    if (heading) {
      current = { level: heading.level, title: heading.title, normalized: normalizeTitle(heading.title), lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return sections;
}

/** 正文行去掉列表符号、引用符号、行内代码与加粗标记，保留本来要读的文字。 */
function cleanLine(line) {
  return String(line ?? '')
    .replace(/^\s{0,3}>\s?/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}

/**
 * 未填的模板行不是内容。`config/persona.example.md` 里写着
 * 「你和用户的关系：用户设定为 ______。」，如果原样抽进快照，模型会把这条**填空题**当成设定
 * 继续往下编（或者照着念一串下划线）。所以：整行都是占位符号 ⇒ 丢弃；行**内含**一段
 * 3 个以上的下划线（半角/全角都算）⇒ 判定为「用户还没填」，整行丢弃。
 *
 * 注意这条规则判的是**结构**（有没有留空），不是正文语义：见文件头「不做关键词过滤」的取舍。
 * 删掉的是「留空这件事」，不是「某个词」。
 */
function isPlaceholder(text) {
  if (!text) return true;
  if (/^[\s_\-—=~.。·]+$/.test(text)) return true;
  return /_{2,}|＿{2,}/.test(text);
}

/** 一段正文 → 清洗后的非空行。 */
function bodyLines(section) {
  const out = [];
  for (const line of section?.lines ?? []) {
    const text = cleanLine(line);
    if (isPlaceholder(text)) continue;
    out.push(text);
  }
  return out;
}

function matchesAlias(spec, normalizedTitle) {
  if (!normalizedTitle) return false;
  if (PRIVATE_TITLE_MARKERS.some(marker => normalizedTitle.includes(normalizeTitle(marker)))) return false;
  return spec.aliases.some(alias => normalizedTitle.includes(normalizeTitle(alias)));
}

/**
 * 纯函数：markdown → 群聊可见快照。抽不到就留空，绝不编造，也绝不整份转储。
 *
 * @param {string} markdown 人格文件原文
 * @param {{personaId?: string, source?: string, version?: string}} [meta]
 *   `source` 是**来源标签**（`config/persona.md`），不是路径；`version` 省略时按原文算。
 * @returns {GroupPersonaSnapshot|null} 空文件返回 null（「没有人格」必须可区分于「人格为空串」）
 */
export function buildGroupPersonaSnapshot(markdown, { personaId = '', source = 'persona.md', version = '' } = {}) {
  const raw = String(markdown ?? '');
  if (!raw.trim()) return null;
  const limitText = clampChars(raw, GROUP_PERSONA_LIMITS.maxChars);
  const sections = sectionsOf(limitText);

  // 一个标题只认领一个字段：先到先得，且同一字段只取第一个命中的小节。
  const claimed = new Map();
  const taken = new Set();
  for (const section of sections) {
    for (const spec of FIELD_SPECS) {
      if (taken.has(spec.key)) continue;
      if (!matchesAlias(spec, section.normalized)) continue;
      claimed.set(spec.key, section);
      taken.add(spec.key);
      break;
    }
  }
  const bodyOf = key => bodyLines(claimed.get(key));

  // 总预算按契约字段顺序消耗：后面的小节被挤掉时是**整段留空**，而不是每段都被切一半——
  // 半句话比没有更危险（模型会把半句当完整设定继续编）。
  let used = 0;
  const remaining = () => GROUP_PERSONA_LIMITS.total - used;
  const takeText = (text, cap) => {
    if (remaining() <= 0) return '';
    const piece = clampChars(text, Math.min(cap, remaining()));
    used += Array.from(piece).length;
    return piece;
  };
  const takeList = items => {
    const out = [];
    for (const item of items) {
      if (out.length >= GROUP_PERSONA_LIMITS.listItems || remaining() <= 0) break;
      const piece = clampChars(item, Math.min(GROUP_PERSONA_LIMITS.listItem, remaining()));
      if (!piece.trim()) break;
      out.push(piece);
      used += Array.from(piece).length;
    }
    return out;
  };

  const identity = takeText(bodyOf('identity').join('\n'), GROUP_PERSONA_LIMITS.identity);
  const personality = takeText(bodyOf('personality').join('\n'), GROUP_PERSONA_LIMITS.personality);
  const speakingStyle = takeText(bodyOf('speakingStyle').join('\n'), GROUP_PERSONA_LIMITS.speakingStyle);
  const interests = takeList(bodyOf('interests'));
  const knownExperiences = takeList(bodyOf('knownExperiences'));
  const emotionalState = takeText(bodyOf('emotionalState').join('\n'), GROUP_PERSONA_LIMITS.emotionalState);
  const publicFacts = takeList(bodyOf('publicFacts'));
  const interactionBoundaries = takeList(bodyOf('interactionBoundaries'));

  return Object.freeze({
    version: String(version || shortHash(raw)),
    personaId: String(personaId ?? ''),
    identity,
    personality,
    speakingStyle,
    interests: Object.freeze(interests),
    knownExperiences: Object.freeze(knownExperiences),
    // 可选的轻量状态：没有就不带这个键，「有字段但是空」会让下游误以为「现在心情是空的」。
    ...(emotionalState ? { emotionalState } : {}),
    publicFacts: Object.freeze(publicFacts),
    interactionBoundaries: Object.freeze(interactionBoundaries),
    source: String(source || 'persona.md'),
    publicOnly: true,
  });
}

/** 来源标签：`config` → `config/persona.md`。未知来源退回中性标签，绝不回绝对路径。 */
export function personaSourceLabel(source) {
  return SOURCE_LABELS[String(source ?? '').trim()] ?? SOURCE_LABELS.missing;
}

/**
 * 建端口。
 *
 * @param {{root?: string, suitePaths?: object|null, personaFile?: string, personaId?: string,
 *          source?: string}} [options] `root` 是陪伴**数据根**（与 index.mjs 的 mountCompanion 一致）；
 *   `suitePaths` 是 `resolveSuitePaths()` 的结果。两者都给时 suitePaths 优先：人格文件只从
 *   一处解析，系统提示词与群聊快照才不会互相打架。
 */
export function createGroupPersonaPort({ root = '', suitePaths = null, personaFile = '', personaId = '', source = '' } = {}) {
  const explicitFile = String(personaFile ?? '').trim();

  const target = () => {
    if (explicitFile) {
      return { file: path.resolve(explicitFile), label: personaSourceLabel(source || 'config'), id: String(personaId ?? '') };
    }
    if (suitePaths && typeof suitePaths === 'object') {
      return {
        file: suitePaths.personaFile ? String(suitePaths.personaFile) : null,
        label: personaSourceLabel(suitePaths.personaSource),
        id: String(suitePaths.personaId ?? personaId ?? ''),
      };
    }
    // 裸挂载（embedder / 单测直接给一个数据目录）沿用历史布局，与 index.mjs 的兜底一致。
    const base = path.resolve(String(root || '.'));
    return { file: path.join(base, 'workspace/PERSONA.md'), label: SOURCE_LABELS.legacy, id: String(personaId ?? '') };
  };

  /**
   * 读一次人格文件并建快照。每次 get()/describe() 都调用它，所以人格文件改了下一次调用就能看到。
   * @returns {GroupPersonaSnapshot|null}
   */
  const snapshotNow = () => {
    try {
      const resolved = target();
      if (!resolved.file) return null;
      const raw = fs.readFileSync(resolved.file, 'utf8');
      if (!raw.trim()) return null;
      return buildGroupPersonaSnapshot(raw, {
        personaId: resolved.id,
        source: resolved.label,
        // 哈希用**完整原文**：哪怕只改了上限之外的一个字，version 也要变，否则排查时会以为
        // 「文件没保存成功」。
        version: shortHash(raw),
      });
    } catch {
      return null;
    }
  };

  return {
    /**
     * 群聊可见的人格快照；没有人格文件就返回 null。
     *
     * 同步、绝不抛：调用方是群聊每轮的消息路径，一次 fs 异常不能变成「这个群不回话」。
     * 每次调用都重新读文件（不做 mtime 缓存）：人格文件通常只有几 KB，读一次比一次缓存失效
     * 判断更便宜，而且 version 与实际内容永远一致——热更新的正确性比这点 IO 重要。
     *
     * @returns {GroupPersonaSnapshot|null}
     */
    get() {
      return snapshotNow();
    },

    /**
     * 诊断用的元信息（不含正文）。
     *
     * 为什么要有：群聊侧说「人格没拿到」时，排查需要区分三种完全不同的情况——没有人格文件、
     * 文件在但抽不出正文、文件正常只是消费端没解析到端口。只回 version/source/chars 三个数，
     * 不把正文带进诊断日志：日志是本地文件，但按「宁可少记」的原则处理。
     *
     * @returns {{version: string, source: string, chars: number, personaId: string}}
     */
    describe() {
      const snapshot = snapshotNow();
      if (!snapshot) return { version: '', source: '', chars: 0, personaId: '' };
      const structured = [
        snapshot.identity, snapshot.personality, snapshot.speakingStyle,
        snapshot.emotionalState ?? '',
        ...snapshot.interests, ...snapshot.knownExperiences,
        ...snapshot.publicFacts, ...snapshot.interactionBoundaries,
      ];
      return {
        version: snapshot.version,
        source: snapshot.source,
        chars: structured.reduce((sum, item) => sum + Array.from(item).length, 0),
        personaId: snapshot.personaId,
      };
    },
  };
}

/**
 * root 的几种等价拼写。
 *
 * 为什么不是一个字符串就够了：消费端（QQ 插件行）用 `dirname(realpathSync(host.dshHome))` 算这个
 * 键，而本模块拿到的是 `resolveDataRoot()` 的 `path.resolve` 结果。在 Windows 上两者可能只差大小写
 * （`realpathSync.native` 返回盘上真实大小写，`path.resolve` 不会改），也可能差一个 junction。
 * 键拼写不同 ⇒ 注册表命中不了 ⇒ 群里拿不到人格，且**看起来一切正常**。所以发布与解析都过一遍
 * 这份有界清单：原样、绝对化、小写（仅 win32）、以及它们的 realpath 版本。清单里的字符串都是
 * **同一个** root，不是模糊匹配。
 */
function keyVariants(root) {
  const raw = String(root ?? '');
  const variants = new Set([raw]);
  let absolute = '';
  try { absolute = path.resolve(raw); } catch { absolute = ''; }
  if (absolute) {
    variants.add(absolute);
    if (process.platform === 'win32') variants.add(absolute.toLowerCase());
    try {
      const real = fs.realpathSync.native(absolute);
      variants.add(real);
      if (process.platform === 'win32') variants.add(real.toLowerCase());
    } catch { /* 目录可能还不存在（首次挂载）；字面拼写已经够用 */ }
  }
  return [...variants].filter(Boolean);
}

/**
 * 注册表键。
 *
 * 首个键是**裸 root**：消费端契约就是这么写的（`Map<dataRoot, { service, ready }>`），
 * 与 health-service-ref.mjs 完全一致 —— 同一个 `Symbol.for`、同一个 Map、同一种值形状。
 * 其余键是「服务名\u0000root」的复合拼写：万一同进程里还有别的服务也用裸 root 发布，
 * 复合键这一份不会被顶掉，本模块自己的解析照样能用。
 *
 * 已知冲突（必须写出来，不能靠运气）：未加载健康服务时，`companion-health` 也用**裸
 * dataRoot** 发布它的服务；两者写同一个键，后挂载的会覆盖先挂载的。所以发布时对裸键做
 * 「不覆盖别人的服务」检查（见 publishGroupPersonaService）：键被占就不写，只写复合键并打日志。
 * 宁可群里这次拿不到人格，也不能把健康服务从注册表里顶掉——那会让心率读数、pulse、care 一起失效。
 */
function registryKeysOf(root) {
  const variants = keyVariants(root);
  return {
    // 消费端读的那一份：裸 dataRoot。每一种拼写都要过「不覆盖别人的服务」检查。
    bare: variants,
    // 本模块自己读的那一份：带名字前缀，永远不会和别人撞。
    scoped: variants.map(variant => `${GROUP_PERSONA_SERVICE_NAME}\u0000${variant}`),
  };
}

/**
 * 给**消费端**的一组注册表键，按建议顺序试。
 *
 * 为什么消费端不能只试裸 dataRoot：这个键在同进程里已经不是本模块独占的了。
 * `companion-health` 也用裸 dataRoot 发布它的服务（`publishHealthService(root, …)`），
 * 而注册表是「一个键一条记录」。两个服务谁后发布谁占住，先来的那条会被顶掉——
 * 表现是「群聊人格时有时无」或者「健康读数时有时无」，取决于挂载顺序，且完全静默。
 *
 * 所以本模块**总是**额外写一份「`companionGroupPersona\u0000<dataRoot>`」的复合键，
 * 那份键不会被任何人撞。消费端按 [前几个复合键, …, 裸键] 的顺序试，就既兼容既有约定，
 * 又不会因为健康服务先挂载而拿不到人格。
 *
 * @param {string} root 陪伴数据根（dataRoot）
 * @returns {string[]} 键，按建议尝试顺序
 */
export function groupPersonaRegistryKeys(root) {
  const { bare, scoped } = registryKeysOf(root);
  return [...scoped, ...bare];
}

/** process 级注册表（懒创建：另一个模块可能已经建好了同一个 Map）。 */
function portRegistry() {
  const holder = process;
  if (!holder[GROUP_PERSONA_PORT_SYMBOL] || typeof holder[GROUP_PERSONA_PORT_SYMBOL] !== 'object') {
    holder[GROUP_PERSONA_PORT_SYMBOL] = new Map();
  }
  return holder[GROUP_PERSONA_PORT_SYMBOL];
}

/** 结构校验：拿到的东西必须真有 get()。名字撞车时宁可当没有，也不要交给下游一个错对象。 */
function isPort(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.get === 'function';
}

/**
 * 发布端口。返回释放函数（可重复调用）。
 *
 * 三路都发，任何一路失败都不影响另外两路，也都不抛：发布会话里的某个 host API 不存在是
 * 正常情况，不该把整个插件挂载搞崩——但少了哪一路必须能在日志里看见。
 *
 * @param ctx Cordis 上下文（可以为空：单测/裸挂载时只有注册表与 bridge）
 * @param {{get: Function}} port
 * @param {{root?: string, log?: (message: string) => void}} [options]
 * @returns {() => void}
 */
export function publishGroupPersonaPort(ctx, port, { root = '', log = null } = {}) {
  if (!isPort(port)) return () => {};
  const say = message => {
    if (typeof log !== 'function') return;
    try { log(message); } catch { /* 日志永远不能弄挂发布 */ }
  };

  // 1. cordis 契约。名字被别的服务占着时拒绝覆盖：覆盖别人的服务比「这次没发出去」更难查。
  try {
    const existing = ctx && typeof ctx.get === 'function' ? ctx.get(GROUP_PERSONA_SERVICE_NAME) : undefined;
    if (existing && existing !== port) {
      say(`ctx.provide skipped: ${GROUP_PERSONA_SERVICE_NAME} is already taken by another service`);
    } else if (ctx && typeof ctx.provide === 'function') {
      ctx.provide(GROUP_PERSONA_SERVICE_NAME, port);
      const readBack = typeof ctx.get === 'function' ? ctx.get(GROUP_PERSONA_SERVICE_NAME) : undefined;
      if (readBack !== port) say('ctx.provide returned without a verified read-back (sibling rows may need the bridge)');
    } else {
      say('ctx.provide is absent; relying on the process registry and the bridge');
    }
  } catch (error) {
    say(`ctx.provide threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 2 + 3. 注册表与 bridge 交给 publishGroupPersonaService，一处实现、两个入口共用，
  // 免得「走 ctx 的那条路」和「走注册表的那条路」在键拼写这类细节上慢慢漂移。
  const releaseService = publishGroupPersonaService(root, port, { log: say });
  return () => {
    try { releaseService(); } catch { /* 释放必须幂等且不抛 */ }
  };
}

/**
 * 发布服务的正式入口：`publishGroupPersonaService(root, service)`。
 *
 * 与 `publishHealthService(root, service, …)` 同名同形，也与消费端约定的一致：
 *   · 注册表键是**裸 root**（必须是 dataRoot，见下），值是 `{ service, ready() }`；
 *   · 同一个 `Symbol.for('dsh.companion.ports.v1')`，不新开键；
 *   · 同时走 service-bridge（名字已在白名单里）。
 *
 * root 必须传 **dataRoot**（`resolveDataRoot({moduleUrl: import.meta.url}).dataRoot`），
 * 不是 suiteRoot、不是 `data/home`。理由：消费端（QQ 插件行）用的是
 * `dirname(realpathSync(host.dshHome))`，指向的正是 data 根；两边键不同就等于没发布，
 * 而且失败是静默的。
 *
 * @param {string} root 陪伴数据根
 * @param {{get: () => GroupPersonaSnapshot|null, describe?: () => object}} service
 * @param {{ready?: () => boolean, log?: (message: string) => void}} [options] `log` 用来把
 *   「裸键被别的服务占着」这类**静默失败**变成一行可查的日志。
 * @returns {() => void} 幂等释放函数
 */
export function publishGroupPersonaService(root, service, { ready = () => true, log = null } = {}) {
  if (!isPort(service)) return () => {};
  const say = message => {
    if (typeof log !== 'function') return;
    try { log(message); } catch { /* 日志永远不能弄挂发布 */ }
  };
  let released = false;
  const releases = [];
  try {
    const registry = portRegistry();
    const { bare, scoped } = registryKeysOf(root);
    for (const key of bare) {
      const occupant = registry.get(key);
      // 同一个键上已经有别人的服务（最可能是 companion-health）时**不写**：宁可本模块这次
      // 靠复合键活着，也不能把健康那条记录顶掉。覆盖是静默的，事后几乎查不出来。
      if (occupant && occupant.service !== service) {
        say(`registry key ${key} is already held by another service; keeping it and publishing under the scoped key only`);
        continue;
      }
      registry.set(key, { service, ready });
      releases.push(() => { try { registry.delete(key); } catch { /* 已经没了 */ } });
    }
    // 复合键总是写：裸键被占时，本模块自己的 resolve 仍然能靠这一份找到服务。
    for (const key of scoped) {
      registry.set(key, { service, ready });
      releases.push(() => { try { registry.delete(key); } catch { /* 已经没了 */ } });
    }
  } catch { /* 注册表不可用时只剩 bridge */ }
  try {
    releases.push(createServiceBridge(root).publish(GROUP_PERSONA_SERVICE_NAME, service, { ready }));
  } catch { /* 注册表已经兜住了 */ }
  return () => {
    if (released) return;
    released = true;
    for (const release of releases) {
      try { release(); } catch { /* 释放必须幂等且不抛 */ }
    }
  };
}

/**
 * 从**兄弟插件行**解析端口。顺序与 health-service-ref.mjs 一致，最确定的先试：
 *   1. `ctx.get(name)` —— 消费者确实是提供者的子行时才成立；
 *   2. process 级注册表；
 *   3. service-bridge。
 * 三路都没有就返回 null（调用方据此如实说「群聊没有拿到人格快照」，而不是编一个人设）。
 *
 * @param ctx Cordis 上下文（可为 null）
 * @param {string} [root] 陪伴数据根，与发布方必须一致
 * @returns {{get: () => GroupPersonaSnapshot|null}|null}
 */
export function resolveGroupPersonaPort(ctx, root = '') {
  try {
    const local = ctx && typeof ctx.get === 'function' ? ctx.get(GROUP_PERSONA_SERVICE_NAME) : undefined;
    if (isPort(local)) return local;
  } catch { /* 落到下一路 */ }
  // 复合键优先：裸键可能被 companion-health 占着（值形状完全一致，就是没有 get()），
  // 所以这里不是「取第一条命中的键」，而是「取第一条真的像人格端口的记录」。
  try {
    const registry = portRegistry();
    for (const key of groupPersonaRegistryKeys(root)) {
      const entry = registry.get(key);
      if (!entry) continue;
      let usable = false;
      try { usable = entry.ready() !== false; } catch { usable = false; }
      if (usable && isPort(entry.service)) return entry.service;
    }
  } catch { /* 落到下一路 */ }
  try {
    const viaBridge = createServiceBridge(root).resolve(GROUP_PERSONA_SERVICE_NAME);
    if (isPort(viaBridge)) return viaBridge;
  } catch { /* 没有就是没有 */ }
  return null;
}

export default {
  GROUP_PERSONA_SERVICE_NAME,
  GROUP_PERSONA_PORT_SYMBOL,
  GROUP_PERSONA_LIMITS,
  buildGroupPersonaSnapshot,
  createGroupPersonaPort,
  publishGroupPersonaPort,
  publishGroupPersonaService,
  resolveGroupPersonaPort,
  groupPersonaRegistryKeys,
  personaSourceLabel,
};
