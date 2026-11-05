/** 审批网关的核心判定（纯函数）：命令归一化、风险分级、一次性令牌。
 *
 * 设计来自《阿衡机制清单》§1 与《IM Bot 特权命令远程批准方案》，原则一句话：
 * **判断风险由 agent 负责，放行与否由系统负责**。所以这里只有纯计算——
 * 不读时钟、不掷随机、不碰磁盘；request/approve/consume 的输入（id、token、now）
 * 全部由调用方注入，因此可重放、可逐条单测（R8）。
 *
 * 四级：
 *   L0 只读，直接做        —— 查看、搜索、读取
 *   L1 有副作用，先备份再动 —— 工作区内写文件、提交、打包
 *   L2 必须持一次性令牌     —— 重启服务、装包、发布、改系统文件
 *   L3 永不执行            —— 抹盘、关机、清空防火墙/系统等不可恢复动作
 *
 * 令牌三元组：**请求号 + 过期时刻 + 命令哈希**，exec 时三样全核；批准的是"那条
 * 字面命令"，改一个字（归一化后）授权就作废。
 */

export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3'

export interface RiskVerdict {
  readonly level: RiskLevel
  readonly reason: string
}

/**
 * 归一化：把变形还原成"真正会执行的那条命令"，再压空白。
 *
 * 要挡住的是这几种：`rm -r''f`（引号拼接）、`rm${IFS}-rf`（变量展开切词）、
 * `rm -r\
 * f`（反斜杠续行）、`sudo rm -rf`（提权前缀）。还原后同罪——批准看的是还原结果。
 */
export function normalizeCommand(raw: string): string {
  let out = String(raw)
  // 反斜杠续行：`\<换行>` 在 shell 里等于没有。
  out = out.replace(/\\\r?\n/g, '')
  // 空引号拼接：`-r''f` / `-r""f` / `-r''''f`
  out = out.replace(/''(?=\S)|""(?=\S)/g, '')
  // 去掉成对引号本身（保留内容），但不动引号里的空白——先记下占位再还原。
  out = out.replace(/'([^']*)'/g, (_m, inner: string) => inner.replace(/ /g, '\u0000'))
  out = out.replace(/"([^"]*)"/g, (_m, inner: string) => inner.replace(/ /g, '\u0000'))
  // ${IFS} / $IFS 是切词符，等价于空格。
  out = out.replace(/\$\{?IFS\}?/g, ' ')
  // 长选项与短选项等价：`rm --recursive --force /` 就是 `rm -r -f /`。
  // 不归一的话分级表只认短选项，L3 会被判成 L0 直接执行（2026-10-19 排查）。
  out = out.replace(/--recursive\b/g, '-r').replace(/--force\b/g, '-f')
  // 命令前的反斜杠只是转义，不改变执行哪条命令：`\rm` 仍然是 `rm`。
  out = out.replace(/^\s*\\(?=[A-Za-z])/, '')
  // 提权与环境前缀对"这条命令做什么"没有影响。
  out = out.replace(/^\s*(?:sudo|doas)\s+/, '')
  out = out.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')
  // 空白归一。
  out = out.replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim()
  return out.replace(/\u0000/g, ' ')
}

const L3: ReadonlyArray<readonly [RegExp, string]> = [
  [/\brm\s+(?:-[A-Za-z]*[rf][A-Za-z]*\s+)+(?:\/(?:\s|$)|\/\*|\/(?:etc|usr|opt|var|root|home|boot)(?:\/|\s|$))/, '递归删除系统目录'],
  [/\bmkfs(?:\.\w+)?\b/, '格式化文件系统'],
  [/\bdd\b[^|;]*\bof=\/dev\/(?:sd|nvme|vd|hd)/, '直接写块设备'],
  [/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'fork 炸弹'],
  [/\b(?:shutdown|reboot|poweroff|halt)\b/, '关机/重启整机'],
  [/\bsystemctl\s+(?:stop|disable|mask)\s+(?:ssh|sshd|docker|1panel|network|networking)\b/, '停用关键系统服务'],
  [/\bdocker\s+(?:system\s+)?prune\b/, '批量清理 Docker 资源'],
  [/\bdocker\s+volume\s+(?:rm|prune)\b/, '删除 Docker 数据卷'],
  [/\biptables\s+-F\b/, '清空防火墙规则'],
  [/\b(?:userdel|passwd)\b/, '删除用户/改密码'],
  [/chmod\s+(?:-R\s+)?777\s+\/(?:\s|$)/, '把根目录改成全局可写'],
]

const L2: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsystemctl\s+(?:restart|stop|start|reload|enable|disable)\b/, '改服务状态'],
  [/\bdocker\s+(?:restart|stop|start|rm|run|kill|compose\s+(?:up|down|restart))\b/, '改容器状态'],
  [/\b(?:apt|apt-get|yum|dnf|apk)\s+(?:install|remove|purge|upgrade|update)\b/, '安装/卸载系统包'],
  [/\bnpm\s+(?:i|install|uninstall|remove)\s+(?:-g|--global)\b/, '全局安装 npm 包'],
  [/\bgit\s+push\b/, '推送远端'],
  [/\bdeploy\/release\.mjs\b/, '发布/回滚插件'],
  [/\brm\s+-[A-Za-z]*[rf]/, '删除文件'],
  [/\b(?:cp|mv|install)\b[^|;]*\s\/(?:etc|usr|opt|var|root|boot)\//, '改系统目录文件'],
  [/\b(?:chmod|chown)\b[^|;]*\s\/(?:etc|usr|opt|var|root|boot)\b/, '改系统文件权限'],
  [/\bcrontab\b/, '改定时任务'],
  [/\bsysctl\b/, '改内核参数'],
  [/>\s*\/(?:etc|usr|opt|var|root|boot)\//, '写系统目录'],
]

const L1: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bgit\s+(?:commit|add|checkout|reset|stash|merge|rebase)\b/, '改版本库状态'],
  [/\bnode\s+(?:scripts|deploy)\//, '跑工程脚本'],
  [/\b(?:npm|pnpm)\s+(?:run\s+)?(?:build|test|verify|eval|audit)\b/, '跑构建/测试'],
  [/\b(?:tar|zip|unzip|gzip)\b/, '打包/解包'],
  [/\b(?:cp|mv|mkdir|touch)\b/, '工作区文件操作'],
]

function firstMatch(rules: ReadonlyArray<readonly [RegExp, string]>, text: string): string | null {
  for (const [re, why] of rules) if (re.test(text)) return why
  return null
}

/** 分级：返回级别与具名理由（日志与回执都靠它回答"为什么拦/为什么放"）。 */
export function classify(raw: string): RiskVerdict {
  const text = normalizeCommand(raw)
  const l3 = firstMatch(L3, text)
  if (l3 !== null) return { level: 'L3', reason: l3 }
  const l2 = firstMatch(L2, text)
  if (l2 !== null) return { level: 'L2', reason: l2 }
  const l1 = firstMatch(L1, text)
  if (l1 !== null) return { level: 'L1', reason: l1 }
  return { level: 'L0', reason: '只读或未识别的安全动作' }
}

/** 命令哈希（基于归一化结果：改一个字符授权即失效）。 */
export function commandHash(raw: string, digest: (text: string) => string): string {
  return digest(normalizeCommand(raw))
}

export type RequestStatus = 'pending' | 'approved' | 'consumed' | 'denied'

export interface ApprovalRequest {
  readonly id: string
  /** 归一化后的命令原文（批准的就是这一条）。 */
  readonly command: string
  readonly hash: string
  readonly level: RiskLevel
  readonly reason: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly status: RequestStatus
  /** 谁申请的 / 谁批准或拒绝的（审计用；缺省表示未记录）。 */
  readonly requestedBy?: string
  readonly approvedBy?: string
  readonly deniedBy?: string
  /** 一次性令牌（approve 时写入；consume 后清空）。 */
  readonly token?: string
  readonly tokenExpiresAt?: number
}

export interface CreateOptions {
  readonly id: string
  readonly now: number
  readonly digest: (text: string) => string
  /** 申请有效期（默认 30 分钟）。 */
  readonly ttlMs?: number
  /** 申请人标识（如 `dm-1000000002`）。 */
  readonly requestedBy?: string
}

const DEFAULT_TTL_MS = 30 * 60_000

/** 新建一条申请。L3 直接拒绝创建（永不执行，连申请都不给）。 */
export function createRequest(raw: string, opts: CreateOptions): ApprovalRequest {
  const verdict = classify(raw)
  if (verdict.level === 'L3') throw new Error(`L3 永不执行：${verdict.reason}`)
  const command = normalizeCommand(raw)
  return {
    id: opts.id,
    command,
    hash: commandHash(raw, opts.digest),
    level: verdict.level,
    reason: verdict.reason,
    createdAt: opts.now,
    expiresAt: opts.now + (opts.ttlMs ?? DEFAULT_TTL_MS),
    status: 'pending',
    ...(opts.requestedBy === undefined ? {} : { requestedBy: opts.requestedBy }),
  }
}

/** 批准：写入一次性令牌（默认 10 分钟有效）。已批准/已执行的不能再批。 */
export function approveRequest(req: ApprovalRequest, token: string, now: number, ttlMs = 10 * 60_000, by?: string): ApprovalRequest {
  if (req.status !== 'pending') throw new Error(`请求 ${req.id} 当前是 ${req.status}，不能再批准`)
  if (now > req.expiresAt) throw new Error(`请求 ${req.id} 已过期`)
  return { ...req, status: 'approved', token, tokenExpiresAt: now + ttlMs, ...(by === undefined ? {} : { approvedBy: by }) }
}

export function denyRequest(req: ApprovalRequest, by?: string): ApprovalRequest {
  if (req.status !== 'pending') throw new Error(`请求 ${req.id} 当前是 ${req.status}，不能拒绝`)
  return { ...req, status: 'denied', ...(by === undefined ? {} : { deniedBy: by }) }
}

export type ConsumeFailure = 'not-approved' | 'bad-token' | 'token-expired' | 'hash-mismatch' | 'consumed' | 'request-expired'
export type ConsumeResult = { readonly ok: true; readonly request: ApprovalRequest } | { readonly ok: false; readonly reason: ConsumeFailure }

/**
 * 执行前核验：状态、令牌、有效期、命令哈希，全对才算数。
 *
 * `raw` 是 agent 此刻真的要执行的那条命令——必须与申请时归一化后的原文一致，
 * 否则授权作废（防"批了 A、执行 B"）。
 */
export function consumeRequest(req: ApprovalRequest, token: string, raw: string, now: number, digest: (text: string) => string): ConsumeResult {
  if (req.status === 'consumed') return { ok: false, reason: 'consumed' }
  if (req.status !== 'approved') return { ok: false, reason: 'not-approved' }
  if (req.token === undefined || req.token !== token) return { ok: false, reason: 'bad-token' }
  if (now > req.expiresAt) return { ok: false, reason: 'request-expired' }
  if (req.tokenExpiresAt !== undefined && now > req.tokenExpiresAt) return { ok: false, reason: 'token-expired' }
  if (commandHash(raw, digest) !== req.hash) return { ok: false, reason: 'hash-mismatch' }
  return { ok: true, request: { ...req, status: 'consumed', token: undefined, tokenExpiresAt: undefined } }
}
