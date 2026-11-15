/** 群聊点歌的**第二本账**：按「群 + 点歌人 + 自然日」计数，独立于 channel-qq 的
 * `song.dailyUserCap`。
 *
 * 为什么要有第二本：`song.dailyUserCap` 是**全局**口径（私聊与群聊共用一份），而群聊是
 * 公共场合——一次点歌要跑两三分钟 RVC 推理、吃满显卡，串行队列只有 8 格。一个人在群里
 * 连点两首就会把整个队列占满，主人自己的私聊点歌只能排队。所以群聊这一层单独限：
 *
 *   1. **必须给 `requesterId`**。缺了就算不出"谁点的"，一律拒绝（fail closed），
 *      不静默退化成"不限额"；
 *   2. **每人每天每群**有独立上限（默认 1 首，比 `dailyUserCap` 的 2 首更严）；
 *   3. 日键按 `Asia/Shanghai` 算（与点歌自己的日上限同一个时区口径，不跟随宿主 TZ）。
 *
 * **计数发生在放行那一刻，不是任务成功之后。** 这条判据是刻意的：guard 是同步的，没有
 * 可靠的方式在"执行完之后"再回写；而放行即等于占掉队列里的一格（与 `quota.ts` 的
 * "排队中也算一格"同一口径）。代价是「点了一首但 B站没搜到」也会消耗一格——那是最坏的
 * 情况也只是让人等一天，比"额度永不生效"安全得多。要当场清零：
 * `COMPANION_GROUP_SONG_DAILY_CAP=0`（不限额），或删掉 `home/group-song-quota.json`。
 *
 * 存储是**一份小 JSON**（`home/group-song-quota.json`），同步读写：guard 必须同步返回。
 * 文件坏了 / 读不出来 → 视为"今天还没点过"而不是拒绝服务（额度的用途是限成本，不是
 * 安全边界；真正的安全边界是 `requesterId` 必须在场与下面的键白名单）。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 群聊点歌的日上限时区。与 `features/song/day.ts` 同一个常量值，各写一份（不跨插件 import）。 */
const GROUP_SONG_TIMEZONE = 'Asia/Shanghai';

/** 默认每人每天每群几首。1 比 `song.dailyUserCap` 的 2 更严：群聊是公共场合。 */
export const DEFAULT_GROUP_SONG_DAILY_CAP = 1;

/** 环境变量：非负整数覆盖默认上限；`0` = 不限额（`requesterId` 仍然必填）。 */
export const GROUP_SONG_CAP_ENV = 'COMPANION_GROUP_SONG_DAILY_CAP';

/** 存储文件名（相对 companion data root）。 */
export const GROUP_SONG_QUOTA_FILE = path.join('home', 'group-song-quota.json');

/** `nowMs` 在 `Asia/Shanghai` 的日键（`YYYY-MM-DD`）；时区不可用时返回 `null`。 */
export function groupSongDayKey(nowMs, timeZone = GROUP_SONG_TIMEZONE) {
  if (!Number.isFinite(nowMs)) return null;
  try {
    const format = new Intl.DateTimeFormat('en-CA', {
      timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    let year = '';
    let month = '';
    let day = '';
    for (const part of format.formatToParts(new Date(nowMs))) {
      if (part.type === 'year') year = part.value;
      else if (part.type === 'month') month = part.value;
      else if (part.type === 'day') day = part.value;
    }
    if (year === '' || month === '' || day === '') return null;
    return `${year}-${month}-${day}`;
  } catch {
    return null;
  }
}

/** 把环境变量读成上限；认不出就用默认值（`0` 是合法值，表示不限额）。 */
export function capFromEnv(env = process.env) {
  const raw = String(env?.[GROUP_SONG_CAP_ENV] ?? '').trim();
  if (raw === '') return DEFAULT_GROUP_SONG_DAILY_CAP;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_GROUP_SONG_DAILY_CAP;
  return parsed;
}

/** 计数键：群号与点歌人都必须是正整数，否则不算（调用方在此之前已经拒过）。 */
function keyOf(group, requesterId) {
  return `${String(group)}:${String(requesterId)}`;
}

/**
 * 建一本群聊点歌账。
 *
 * @param {object} input
 * @param {string} input.file   存储文件绝对路径
 * @param {number} [input.cap]  每人每天每群上限（`0` = 不限额）
 * @param {() => number} [input.now] 时钟（测试注入）
 * @param {(line: string) => void} [input.log]
 */
export function createGroupSongQuota({ file, cap = DEFAULT_GROUP_SONG_DAILY_CAP, now = () => Date.now(), log = () => {} } = {}) {
  if (typeof file !== 'string' || file.trim() === '') throw new Error('群聊点歌账需要存储文件路径');

  /** 读一次（坏文件按空账本处理；跨日自动归零）。 */
  function read() {
    const day = groupSongDayKey(now());
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      parsed = null;
    }
    const counts = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && parsed.counts && typeof parsed.counts === 'object' && !Array.isArray(parsed.counts)
      ? parsed.counts : {};
    const storedDay = parsed && typeof parsed.day === 'string' ? parsed.day : null;
    // 日键算不出来 = 时钟坏了。额度是成本控制，这里按"今天还没点过"放行，
    // 与 `quota.ts` 的同一条取舍一致（那边也是算不出日键就不判）。
    if (day === null || storedDay !== day) return { day, counts: {} };
    return { day, counts };
  }

  function write(state) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 原子替换：半截文件会让下一次读取把今天已用的额度当成 0。
      const temporary = `${file}.${String(process.pid)}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, day: state.day, counts: state.counts }), 'utf8');
      fs.renameSync(temporary, file);
    } catch (error) {
      log(`song-quota: 写入失败（额度本回合不落盘）：${error?.message ?? error}`);
    }
  }

  return {
    /** 当前上限（`0` = 不限额）。 */
    get cap() { return cap; },

    /**
     * 这一位还能不能在**这个群**点歌。
     *
     * @returns {{ ok: true, used: number, cap: number } | { ok: false, code: string, used: number, cap: number, message: string }}
     */
    check({ group, requesterId }) {
      const state = read();
      const used = Number(state.counts[keyOf(group, requesterId)] ?? 0) || 0;
      if (!(cap > 0)) return { ok: true, used, cap };
      if (used < cap) return { ok: true, used, cap };
      return {
        ok: false,
        code: 'group-song-daily-cap',
        used,
        cap,
        message: `在这个群今天已经点过 ${String(used)} 首了（每人每天 ${String(cap)} 首，${GROUP_SONG_TIMEZONE} 自然日）`,
      };
    },

    /** 记一格（放行那一刻调用，见文件头"计数发生在放行那一刻"）。 */
    record({ group, requesterId }) {
      const state = read();
      const key = keyOf(group, requesterId);
      const used = (Number(state.counts[key] ?? 0) || 0) + 1;
      state.counts[key] = used;
      write({ day: state.day, counts: state.counts });
      return used;
    },

    /** 只读快照（诊断用）。 */
    snapshot() {
      return read();
    },
  };
}

/** 受这本账管的工具。群里只有"受理一首歌"是计费+吃显卡的外发动作。 */
export const GROUP_SONG_GUARDED_TOOLS = Object.freeze(['qq_song_cover']);

/**
 * 群聊点歌闸门：`requesterId` 必填 + 每人每天每群上限。
 *
 * **同步**返回（宿主 `tools.guard` 是同步单调闸门），所以额度本也用同步读写。
 * 判据顺序刻意是"先要人、再看额度"：拒绝文案必须指出缺的是什么，模型才知道怎么补。
 *
 * @param {{agent?: unknown, name?: string, arguments?: unknown}} exec 工具调用
 * @param {object} options
 * @param {ReturnType<typeof createGroupSongQuota>} options.quota 额度本
 * @param {(agent: unknown) => number|false|null} options.groupOf 与 `core.mjs::groupIdOf` 同一个判据
 * @returns {string|undefined} 拒绝原因；`undefined` = 放行（放行时已记账）
 */
export function groupSongQuotaDenial(exec, { quota, groupOf } = {}) {
  const name = exec?.name;
  if (!GROUP_SONG_GUARDED_TOOLS.includes(name)) return undefined;
  // 不是群会话 → 不管（私聊仍走 `song.dailyUserCap`，那是另一本账）。
  const group = typeof groupOf === 'function' ? groupOf(exec?.agent) : null;
  if (group === null) return undefined;
  // `groupIdOf` 返回 `false` 表示"看着像群会话但群号非法"，`0`/缺省表示未就绪——
  // 这两种都交回给 `core.mjs` 的 `groupToolDenial` 去拒，这里不重复给文案。
  if (!group || group === false) return undefined;

  const raw = exec?.arguments;
  let args;
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw); } catch { return '群聊工具参数无效。'; }
  } else {
    args = raw;
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return '群聊工具参数无效。';
  }

  const requester = args.requesterId;
  // 群里的点歌人只能由模型从渲染文本行读出（宿主没把发送者注进工具上下文），所以这里
  // 只能校验"给了一个看起来合法的号"。它的用途是**算额度**，不是授权——授权仍由
  // `core/trust.ts` 与群边界判。
  if (typeof requester !== 'number' || !Number.isSafeInteger(requester) || requester <= 0) {
    return '群里点歌要说明是谁点的：给 requesterId 填这条消息发送者的 QQ 号（缺了就算不了每人每天几首）。';
  }

  const verdict = quota.check({ group, requesterId: requester });
  if (!verdict.ok) return verdict.message;
  quota.record({ group, requesterId: requester });
  return undefined;
}
