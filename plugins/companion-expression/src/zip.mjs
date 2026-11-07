/**
 * 只读 zip 解析与单条目解压：整个模块只依赖 `node:zlib`（用 `inflateRawSync`），不碰 fs、不发网络请求。
 *
 * 为什么自己写而不是引依赖：这里只在解包用户给的表情包压缩包时需要「列条目 + 取单个文件」，
 * 完全不需要写 zip；多引一个第三方解析器，就多一份上游代码与本仓库供应链的攻击面。
 *
 * 安全取向是「整包拒收」，不是「跳过坏条目」：
 *   - 条目名只要出现 `..` 段、绝对路径、盘符/冒号、反斜杠、NUL 或控制字符，整包返回
 *     `zip-name-forbidden`。静默跳过会把「这个包里混了坏名字」这件事藏起来，调用方会误以为
 *     拿到的是干净包；整包拒收强迫调用方显式处理。
 *   - 所有上限（条目数、单条声明大小、总量、名字长度）都在解压**之前**按中央目录的声明值检查；
 *     解压之后再用实际字节数复核——声明撒谎不能赢。
 *   - 取数据只看中央目录的 local header offset 与大小，不跟本地头的文件名走：本地头是攻击者
 *     更容易单独改写的字段，而中央目录才是 `readZipEntries` 报告给调用方的那份事实。
 *
 * 支持范围：单卷、非加密、method 0（stored）/ method 8（deflate）的普通 zip。
 * zip64、加密、分卷一律按原因码拒绝，不猜、不降级。
 *
 * 原因码：
 *   zip-input-not-bytes / zip-not-archive / zip-truncated / zip-central-directory-missing /
 *   zip-corrupt / zip64-unsupported / zip-encrypted / zip-multidisk / zip-method-unsupported /
 *   zip-name-forbidden / zip-name-too-long / zip-too-many-entries / zip-entry-too-large /
 *   zip-total-too-large / zip-entry-missing / zip-size-mismatch
 */
import { inflateRawSync } from 'node:zlib';

/**
 * 硬上限：条目数 500、单条 8 MiB、整包声明总量 64 MiB、名字 240 字节。
 * 数值是「表情包压缩包」这个用途的现实上限：超过它的包不该在内存里被信任。
 *
 * @type {Readonly<{maxEntries: number, maxEntryBytes: number, maxTotalBytes: number, maxNameBytes: number}>}
 */
export const ZIP_LIMITS = Object.freeze({
  maxEntries: 500,
  maxEntryBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxNameBytes: 240,
});

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;
const EOCD_MIN_BYTES = 22;
/* EOCD 最长 22 字节 + 最多 65535 字节注释；向前扫这么多字节就够。 */
const EOCD_SEARCH_BYTES = 65_557;
const LOCAL_HEADER_MIN_BYTES = 30;
const CENTRAL_HEADER_MIN_BYTES = 46;
const MAX_UINT32 = 0xffff_ffff;
const MAX_UINT16 = 0xffff;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/* 通用位标记：bit0 加密、bit6 强加密、bit11 名字是 UTF-8。 */
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8_NAME = 0x0800;

/** 用来「像不像 zip」的粗判：有本地头签名说明大概率是截断，而不是垃圾。 */
const LOCAL_SIG_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** 统一的失败形状：调用方只看 reasonCode，不用解析中文文案。 */
function fail(reasonCode, message) {
  return { ok: false, reasonCode, message };
}

/** 只接受 Buffer / Uint8Array；其余类型不猜、不转字符串。 */
function bytesOf(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) {
    /* 这是同一块内存的视图，不复制大数组；本模块只读，不会改动它。 */
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  return null;
}

/**
 * 合并调用方覆盖的上限：只允许收紧，不允许放宽。
 * 大于默认值、负数、非安全整数一律回落默认——安全上限不能被一个参数随手关掉。
 */
function limitsOf(options) {
  const source = options && typeof options === 'object' ? options : {};
  const pick = (key) => {
    const value = source[key];
    if (Number.isSafeInteger(value) && value >= 0 && value <= ZIP_LIMITS[key]) return value;
    return ZIP_LIMITS[key];
  };
  return {
    maxEntries: pick('maxEntries'),
    maxEntryBytes: pick('maxEntryBytes'),
    maxTotalBytes: pick('maxTotalBytes'),
    maxNameBytes: pick('maxNameBytes'),
  };
}

/**
 * 从末尾往前找 EOCD 签名。只在最后 65557 字节里找（这是 zip 规范允许的最大尾巴）。
 * 注释里也可能正好有这四个字节，所以优先选「注释长度正好接到缓冲区末尾」的那个候选；
 * 没有这样的候选时退回第一个命中的（宁可后续按注释越界拒收，也不直接当成没有 EOCD）。
 * @param {Buffer} buffer
 * @returns {number} EOCD 的偏移，找不到返回 -1
 */
function findEocd(buffer) {
  const lowest = Math.max(0, buffer.length - EOCD_SEARCH_BYTES);
  let fallback = -1;
  for (let offset = buffer.length - EOCD_MIN_BYTES; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== SIG_EOCD) continue;
    if (fallback < 0) fallback = offset;
    /* 注释长度字段在偏移 +20；只有它能正好接到文件末尾，这个候选才可能是真的 EOCD。 */
    if (offset + EOCD_MIN_BYTES + buffer.readUInt16LE(offset + 20) === buffer.length) return offset;
  }
  return fallback;
}

/**
 * 解码条目名。
 * bit11 置位表示 UTF-8（现代工具都这么写）；没置位时规范要求 CP437。这里对 CP437 退化成
 * latin1：高位字符可能显示错，但 ASCII 段（`/`、`\`、`..`、控制字符）原样保留，
 * 路径判定不会因为解码方式被放宽——宁可名字难看，也不让危险名字漏过去。
 * @param {Buffer} rawName
 * @param {number} flags
 * @returns {string}
 */
function decodeEntryName(rawName, flags) {
  if ((flags & FLAG_UTF8_NAME) !== 0) return rawName.toString('utf8');
  return rawName.toString('latin1');
}

/**
 * 条目名是否危险。命中任意一条就算危险，整包拒收。
 * 注意冒号单独禁：Windows 上 `C:` 是盘符前缀，`name:stream` 是 NTFS 数据流，
 * 两类都不该出现在一个只读解包器里。
 * @param {string} name
 * @returns {boolean}
 */
function isForbiddenName(name) {
  if (name.includes('\\')) return true;
  if (name.startsWith('/')) return true;
  if (name.includes(':') || name.includes('\0')) return true;
  for (const char of name) {
    const code = char.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  for (const segment of name.split('/')) {
    if (segment === '..') return true;
  }
  return false;
}

/** 中央目录条目的 extra 字段里出现 zip64（0x0001）就视为 zip64，不尝试解析它的内容。 */
function hasZip64Extra(buffer, start, length) {
  const end = start + length;
  let cursor = start;
  while (cursor + 4 <= end) {
    const id = buffer.readUInt16LE(cursor);
    const size = buffer.readUInt16LE(cursor + 2);
    if (id === ZIP64_EXTRA_ID) return true;
    cursor += 4 + size;
  }
  return false;
}

/**
 * 解析整包结构并做全部声明级检查。内部条目带 localOffset 与 flags，供解压使用；
 * 对外的 readZipEntries 只暴露四项。
 * @param {Buffer} buffer
 * @param {{maxEntries: number, maxEntryBytes: number, maxTotalBytes: number, maxNameBytes: number}} limits
 */
function parseArchive(buffer, limits) {
  if (buffer.length < EOCD_MIN_BYTES) {
    return fail('zip-not-archive', '字节数少于 22，连 EOCD 都放不下，不是 zip。');
  }
  const eocd = findEocd(buffer);
  if (eocd < 0) {
    /* 没有 EOCD 时再分两类：有本地头签名 → 尾巴被截掉的 zip；否则就是普通垃圾字节。 */
    if (buffer.includes(LOCAL_SIG_BYTES)) {
      return fail('zip-truncated', '找不到 EOCD，但存在本地文件头：压缩包像是被截断了。');
    }
    return fail('zip-not-archive', '找不到 EOCD 签名，这不是 zip 压缩包。');
  }

  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const commentLength = buffer.readUInt16LE(eocd + 20);

  /* 分卷先判：盘号不为 0 或「本盘条目数」与总数不一致，都说明数据散在别的文件里。 */
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    return fail('zip-multidisk', '分卷压缩包不支持：缺少其它分卷的数据。');
  }
  /* zip64 有专门的定位记录；字段饱和也是 zip64 的信号。两种都拒，不猜。 */
  if (eocd >= 20 && buffer.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) {
    return fail('zip64-unsupported', 'zip64 压缩包不支持：字段是 64 位，本模块只处理普通 zip。');
  }
  if (totalEntries === MAX_UINT16 || centralSize === MAX_UINT32 || centralOffset === MAX_UINT32) {
    return fail('zip64-unsupported', 'EOCD 字段饱和（0xFFFF/0xFFFFFFFF），zip64 压缩包不支持。');
  }
  if (eocd + EOCD_MIN_BYTES + commentLength > buffer.length) {
    return fail('zip-truncated', 'EOCD 声明的注释长度超出缓冲区，压缩包不完整。');
  }
  if (totalEntries > limits.maxEntries) {
    return fail('zip-too-many-entries', `中央目录声明 ${totalEntries} 个条目，超过上限 ${limits.maxEntries}。`);
  }
  if (centralOffset + centralSize > buffer.length) {
    return fail('zip-truncated', '中央目录声明的范围超出缓冲区。');
  }
  if (totalEntries > 0 && centralSize < totalEntries * CENTRAL_HEADER_MIN_BYTES) {
    /* 每条至少 46 字节；小于这个数说明中央目录声明本身是假的。 */
    return fail('zip-central-directory-missing', '中央目录小到放不下声明的条目数。');
  }

  const entries = [];
  const centralEnd = centralOffset + centralSize;
  let totalBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + CENTRAL_HEADER_MIN_BYTES > centralEnd || cursor + CENTRAL_HEADER_MIN_BYTES > buffer.length) {
      return fail('zip-central-directory-missing', `第 ${index} 个中央目录条目被截断。`);
    }
    if (buffer.readUInt32LE(cursor) !== SIG_CENTRAL) {
      /* 中央目录签名不对：这份「目录」根本不可信，绝不按它的说法去找数据。 */
      return fail('zip-central-directory-missing', `第 ${index} 个中央目录条目缺少签名（0x02014b50）。`);
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const entryCommentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + CENTRAL_HEADER_MIN_BYTES;
    const nameEnd = nameStart + nameLength;
    const entryEnd = nameEnd + extraLength + entryCommentLength;
    if (nameEnd > buffer.length || entryEnd > buffer.length || entryEnd > centralEnd) {
      return fail('zip-central-directory-missing', '中央目录条目的名字/扩展字段越界。');
    }

    if (hasZip64Extra(buffer, nameEnd, extraLength)
      || compressedSize === MAX_UINT32 || size === MAX_UINT32 || localOffset === MAX_UINT32) {
      return fail('zip64-unsupported', `条目 "${index}" 使用 zip64 字段，不支持。`);
    }
    /* bit0 加密、bit6 强加密：没有口令，连名字都不该往下用。 */
    if ((flags & FLAG_ENCRYPTED) !== 0 || (flags & FLAG_STRONG_ENCRYPTION) !== 0) {
      return fail('zip-encrypted', '条目已加密，不支持：没有口令，也不会去猜。');
    }

    const rawName = buffer.subarray(nameStart, nameEnd);
    const name = decodeEntryName(rawName, flags);
    if (isForbiddenName(name)) {
      /* 整包拒收（不是跳过这一条）：调用方必须知道这个包里有危险名字。 */
      return fail('zip-name-forbidden', `条目名 "${name}" 含穿越段/绝对路径/盘符/反斜杠/控制字符，整包拒收。`);
    }
    if (rawName.length > limits.maxNameBytes) {
      return fail('zip-name-too-long', `条目名 ${rawName.length} 字节，超过上限 ${limits.maxNameBytes}。`);
    }
    /* 声明大小先卡：这两项审的是中央目录自己写的数，还没解压。 */
    if (size > limits.maxEntryBytes) {
      return fail('zip-entry-too-large', `条目 "${name}" 声明 ${size} 字节，超过单条上限 ${limits.maxEntryBytes}。`);
    }
    totalBytes += size;
    if (totalBytes > limits.maxTotalBytes) {
      return fail('zip-total-too-large', `声明总量超过上限 ${limits.maxTotalBytes}。`);
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      return fail('zip-method-unsupported', `条目 "${name}" 的压缩方法 ${method} 不受支持（只支持 0/8）。`);
    }

    entries.push({ name, method, compressedSize, size, flags, localOffset });
    cursor = entryEnd;
  }
  return { ok: true, entries };
}

/**
 * 读取单个条目的字节。
 * 只信中央目录给的 localOffset / compressedSize；本地头只用来校验签名，并按它自己写的
 * name/extra 长度跳过变长字段——绝不跟着本地头的文件名去找数据。
 * @param {Buffer} buffer
 * @param {{name: string, method: number, compressedSize: number, size: number, flags: number, localOffset: number}} entry
 * @param {{maxEntryBytes: number}} limits
 */
function extractEntry(buffer, entry, limits) {
  const offset = entry.localOffset;
  if (offset + LOCAL_HEADER_MIN_BYTES > buffer.length) {
    return fail('zip-truncated', `条目 "${entry.name}" 的本地头偏移超出缓冲区。`);
  }
  if (buffer.readUInt32LE(offset) !== SIG_LOCAL) {
    return fail('zip-corrupt', `条目 "${entry.name}" 的本地头签名不符（应为 0x04034b50）。`);
  }
  /* 本地头的 name/extra 长度可能与中央目录不同（两者可被分别改写），按本地头自己写的跳。 */
  const localNameLength = buffer.readUInt16LE(offset + 26);
  const localExtraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + LOCAL_HEADER_MIN_BYTES + localNameLength + localExtraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart > buffer.length || dataEnd > buffer.length) {
    return fail('zip-truncated', `条目 "${entry.name}" 的数据范围超出缓冲区。`);
  }
  const payload = buffer.subarray(dataStart, dataEnd);

  if (entry.method === METHOD_STORED) {
    /* stored 的「压缩后大小」必须等于声明大小，否则是撒谎的头。 */
    if (payload.length !== entry.size) {
      return fail('zip-size-mismatch', `条目 "${entry.name}" 实际 ${payload.length} 字节，与声明 ${entry.size} 不符。`);
    }
    return { ok: true, name: entry.name, bytes: Buffer.from(payload) };
  }

  let inflated;
  try {
    /* 上限只给「声明大小 + 1」：多出来的那 1 字节用来证明它超了，而不是先解出 8 MiB 再说。 */
    inflated = inflateRawSync(payload, { maxOutputLength: entry.size + 1 });
  } catch (error) {
    if (error && error.code === 'ERR_BUFFER_TOO_LARGE') {
      return fail('zip-size-mismatch', `条目 "${entry.name}" 解压后超过声明大小 ${entry.size}，拒绝相信这个头。`);
    }
    return fail('zip-corrupt', `条目 "${entry.name}" 的 deflate 数据无法解压。`);
  }
  /* 解压后再用实际长度复核：与声明不符就拒，宁可失败也不交出一份来路不明的字节。 */
  if (inflated.length !== entry.size) {
    return fail('zip-size-mismatch', `条目 "${entry.name}" 实际解压 ${inflated.length} 字节，与声明 ${entry.size} 不符。`);
  }
  if (inflated.length > limits.maxEntryBytes) {
    return fail('zip-entry-too-large', `条目 "${entry.name}" 解压后 ${inflated.length} 字节，超过单条上限。`);
  }
  return { ok: true, name: entry.name, bytes: Buffer.from(inflated) };
}

/**
 * 列出压缩包里的条目（只读，不解压数据）。
 *
 * 对任意输入都不抛异常：截断/垃圾/空缓冲区统一返回 `{ok:false, reasonCode}`。
 * 声明级上限在这里就生效（条目数、声明单条大小、声明总量、名字长度），坏名字整包拒收。
 *
 * @param {Buffer|Uint8Array} bytes 压缩包字节
 * @param {{maxEntries?: number, maxEntryBytes?: number, maxTotalBytes?: number, maxNameBytes?: number}} [options]
 *   覆盖默认上限（只能收紧，不会放宽：非法值回落默认）
 * @returns {{ok: true, entries: Array<{name: string, method: number, compressedSize: number, size: number}>}
 *   | {ok: false, reasonCode: string, message: string}}
 */
export function readZipEntries(bytes, options = {}) {
  try {
    const buffer = bytesOf(bytes);
    if (!buffer) return fail('zip-input-not-bytes', '输入不是 Buffer/Uint8Array。');
    const parsed = parseArchive(buffer, limitsOf(options));
    if (!parsed.ok) return fail(parsed.reasonCode, parsed.message);
    return {
      ok: true,
      entries: parsed.entries.map(({ name, method, compressedSize, size }) => ({ name, method, compressedSize, size })),
    };
  } catch (error) {
    /* 兜底：任何意料之外的解析异常都收敛成结构化失败，而不是把异常抛给调用方。 */
    return fail('zip-corrupt', `解析 zip 时出现意外错误：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 按条目名解压出一份字节（只读，不落盘）。
 *
 * 名字必须在中央目录里精确匹配（区分大小写）；整包只要有一个危险名字，本函数同样拒收。
 * 返回的 `bytes` 是从输入复制出来的一份 Buffer，调用方可以随意处置。
 *
 * @param {Buffer|Uint8Array} bytes 压缩包字节
 * @param {string} name 中央目录里的条目名
 * @param {{maxEntries?: number, maxEntryBytes?: number, maxTotalBytes?: number, maxNameBytes?: number}} [options]
 * @returns {{ok: true, name: string, bytes: Buffer} | {ok: false, reasonCode: string, message: string}}
 */
export function extractZipFile(bytes, name, options = {}) {
  try {
    const buffer = bytesOf(bytes);
    if (!buffer) return fail('zip-input-not-bytes', '输入不是 Buffer/Uint8Array。');
    if (typeof name !== 'string') return fail('zip-entry-missing', '条目名必须是字符串。');
    const limits = limitsOf(options);
    const parsed = parseArchive(buffer, limits);
    if (!parsed.ok) return fail(parsed.reasonCode, parsed.message);
    const entry = parsed.entries.find((row) => row.name === name);
    if (!entry) return fail('zip-entry-missing', `中央目录里没有名为 "${name}" 的条目。`);
    return extractEntry(buffer, entry, limits);
  } catch (error) {
    return fail('zip-corrupt', `解压 zip 时出现意外错误：${error instanceof Error ? error.message : String(error)}`);
  }
}

export default { ZIP_LIMITS, readZipEntries, extractZipFile };
