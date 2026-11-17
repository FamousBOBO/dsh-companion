// 分段：把一条长回复拆成"像人连着说"的几条。
//
// 这件事在 QQ 那边已经做过一轮（`dsh-channel-qq/src/core/text/segment.ts`，P6h）。这里
// 按同一套判据重写一份纯函数，但**有两处刻意不同**，都不是随手改的：
//
//  1. **不做半角→全角标点转换。** QQ 那边会 `,`→`，`、`?`→`？`（QQ 的排版文化）。VoceChat
//     客户端是纯文本渲染，转换只会毁掉英文句子和 URL（`Hello, world` → `Hello， world`）。
//     真要保护也得像那边一样先给 URL 与代码块占位，而这里根本没有收益，所以不做。
//
//  2. **`maxSegments` 封顶时合并尾巴，不丢弃。** QQ 那边是 `.slice(0, maxSegments)`，
//     超出的内容直接不发。QQ 群聊里"别刷屏"是合理的取舍；VoceChat 是一对一，
//     把答复的最后一截悄悄吞掉是不可接受的。这里把超出的部分并进最后一段。
//
// 保留的部分（规则本身，不做改动）：
//   - 句末标点（`。！？…!?`）结束一段，但**受保护区域里不切**：代码块、`---`、各种成对
//     引号/括号/书名号里的标点不算边界（"《活着。很好哭》"不能被切开）；
//   - 连着的一串情绪标点（"！！！"、"……"）跟在同一段尾巴上；
//   - `style`：`natural` 跟标点走，`conservative` 把过短的相邻句粘起来，
//     `active` **换行也算句子边界**（人设常写"一行一句不带句号"，不认换行就等于没有分段）；
//   - 段内去重（同一句不重复发）。

const JUNK_PATTERNS = [
  /这些是重复发送的内容/i,
  /NO_REPLY/,
  /^Something went wrong while processing your request/i,
  /^Please try again, or use \/new to start a fresh session/i,
  /^.*terminated.*$/i,
  /未解析到有效文本内容/,
  /生成任务失败/,
];

/** 去掉"不是话"的部分：思考块、字数提示、自我提醒、传输错误噪声。 */
export function stripJunk(text) {
  let filtered = String(text ?? '');
  for (const pattern of JUNK_PATTERNS) filtered = filtered.replace(pattern, '');
  filtered = filtered.replace(/<思考>[\s\S]*?<\/思考>/g, '');
  filtered = filtered.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
  filtered = filtered.replace(/[（(][\d一二三四五六七八九十百千万]+字[）)]/g, '');
  return filtered.trim();
}

const ENDERS = new Set(['。', '！', '？', '…', '!', '?']);

/** 不该在内部切分的区域：代码块、破折号块、各种成对引号/括号、URL。 */
const PROTECTED = [
  /```[\s\S]*?```/g, /---[\s\S]*?---/g, /「[^」]*」/g, /《[^》]*》/g,
  /【[^【】]*】/g, /（[^（）]*）/g, /\([^()]*\)/g,
  /"[^"]*"/g, /“[^”]*”/g,
  // A URL's `?` and `!` are syntax, not tone: splitting there would cut the link in half and
  // also make the first half un-clickable. QQ protects URLs for the same reason (it protects them
  // while converting punctuation; here they must be protected while *splitting*).
  /https?:\/\/[^\s]+/g,
];

/** 按句末标点切段（受保护区域除外），并把连着的同类标点留在同一段尾巴上。 */
export function splitByEnders(body) {
  const ranges = [];
  for (const pattern of PROTECTED) {
    for (const match of String(body).matchAll(pattern)) {
      ranges.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    }
  }
  const isProtected = pos => ranges.some(r => pos >= r.start && pos < r.end);

  const segments = [];
  let current = '';
  const chars = Array.from(String(body));
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    current += char;
    if (ENDERS.has(char) && !isProtected(i)) {
      while (
        i + 1 < chars.length
        && (chars[i + 1] === '…' || chars[i + 1] === char || (char === '…' && chars[i + 1] === '。'))
      ) {
        i += 1;
        current += chars[i];
      }
      segments.push(current.trim());
      current = '';
    }
  }
  if (current.trim() !== '') segments.push(current.trim());
  return segments;
}

/** `conservative`：相邻的过短句粘成一条。句末标点在这里被去掉 —— 粘起来的两句用的是逗号，
 * 留着句号会变成「好。，行。」，是拼接的痕迹而不是语气。 */
function mergeTiny(segments, minLength) {
  const merged = [];
  for (const seg of segments) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && prev.length < minLength && seg.length < minLength) {
      merged[merged.length - 1] = `${prev.replace(/[。！？…]+$/u, '')}，${seg}`;
    } else {
      merged.push(seg);
    }
  }
  return merged;
}

function dedupe(segments) {
  const seen = new Set();
  const out = [];
  for (const seg of segments) {
    const key = seg.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(seg);
  }
  return out;
}

/** 封顶时**并尾巴**，不丢字（与 QQ 的 slice 有意不同，见文件头第 2 条）。 */
function capSegments(segments, maxSegments) {
  const cap = Number.isInteger(maxSegments) && maxSegments > 0 ? maxSegments : 0;
  if (cap === 0 || segments.length <= cap) return segments;
  if (cap === 1) return [segments.join('\n')];
  const head = segments.slice(0, cap - 1);
  const tail = segments.slice(cap - 1).join('\n');
  return [...head, tail];
}

/**
 * 分段入口：给一段文本与分段配置，返回**实际要发出去的几条**。
 *
 * 返回单元素数组 = 照旧发一条（开关关着、没有句末标点、或者本来就是一句话）。
 *
 * @param {string} text
 * @param {object} options
 * @param {boolean} [options.enabled=true]
 * @param {'natural'|'conservative'|'active'} [options.style='active']
 * @param {number} [options.minLength=8]
 * @param {number} [options.maxSegments=6]
 * @param {boolean} [options.removeTrailingPeriod=false]
 * @returns {string[]}
 */
export function segmentText(text, options = {}) {
  const enabled = options.enabled !== false;
  const style = options.style === 'conservative' || options.style === 'natural' ? options.style : 'active';
  const minLength = Number.isInteger(options.minLength) && options.minLength >= 0 ? options.minLength : 8;
  const maxSegments = Number.isInteger(options.maxSegments) && options.maxSegments > 0 ? options.maxSegments : 6;
  const removeTrailingPeriod = options.removeTrailingPeriod === true;

  const body = stripJunk(text);
  if (body === '') return [];
  if (!enabled) return [body];

  // `active` 认换行；另两种保持"整段当一句"，与 QQ 逐字节一致。
  //
  // **受保护区域必须先整体遮住再按换行切。** 否则一个代码块会被拆成四条消息
  // （"```js" / "const a = 1.5;" / "```"），围栏标记自成一条 —— 实测就是这个结果。
  // 遮罩用一个不可能出现在正文里的私用区字符，切完再还原。
  const units = style === 'active' ? lineUnits(body) : [body];
  const hasEnder = units.some(unit => [...unit].some(char => ENDERS.has(char)));
  if (!hasEnder && units.length <= 1) return [body];

  const cleaned = units
    .flatMap(unit => splitByEnders(unit))
    .map(seg => (removeTrailingPeriod ? seg.replace(/。+$/u, '') : seg))
    .filter(seg => seg !== '');
  const styled = style === 'conservative' ? mergeTiny(cleaned, minLength) : cleaned;
  return capSegments(dedupe(styled), maxSegments);
}

const MASK = '\uE000';
const MASK_END = '\uE001';

/**
 * Split on newlines, but never inside a protected region.
 *
 * A fenced block, a quoted line, or a URL survives as one unit even when it spans lines —
 * which is the whole point of protecting it.
 */
export function lineUnits(body) {
  const slots = [];
  let masked = String(body);
  for (const pattern of PROTECTED) {
    masked = masked.replace(pattern, match => {
      slots.push(match);
      return `${MASK}${slots.length - 1}${MASK_END}`;
    });
  }
  const units = masked
    .split(/\r?\n+/u)
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => line.replace(new RegExp(`${MASK}(\\d+)${MASK_END}`, 'g'), (_m, i) => slots[Number(i)] ?? ''))
    .map(line => line.trim())
    .filter(line => line !== '');
  return units;
}

export { ENDERS, JUNK_PATTERNS, PROTECTED };
