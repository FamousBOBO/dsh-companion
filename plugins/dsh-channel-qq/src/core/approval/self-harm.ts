/** 会把自己弄断的命令：拦下来，改走审批（由独立 cgroup 的执行器跑）。
 *
 * 为什么需要：dsh 以 root 跑，agent 手里有 shell。`systemctl restart dsh` 在
 * **自己的 cgroup 里**执行会被 systemd 连坐杀掉（KillMode=control-group），
 * 于是"重启"变成"停在中途起不来"；发布脚本、重启容器、关机同理。
 *
 * 处理方式不是"允许它跑"，而是**让模型改道**：把命令作为审批申请发出去，
 * 主人在 QQ 私聊回一句「批准」，再由 `dsh-approval.service`（独立单元）执行。
 *
 * 只拦**确实会断自己/断整机**的那几类；普通的 `rm`/`apt` 等仍走 L2 审批，
 * 不在这里一刀切。
 */

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsystemctl\s+(?:restart|stop|reload|kill)\s+(?:dsh|docker)\b/, '重启/停止 dsh 或 docker 会把你自己的进程一起杀掉'],
  [/\bsystemctl\s+daemon-reload\b/, 'daemon-reload 之后通常紧跟重启，属于同一类操作'],
  [/\b(?:deploy\/)?release\.mjs\s+(?:install|rollback)\b/, '发布/回滚会重启 dsh，当前回合会中断'],
  [/\bpkill\b[^|;]*(?:dsh|node)\b/, '按名字杀进程会连自己一起杀'],
  [/\bkillall\b\s+(?:node|dsh)\b/, '按名字杀进程会连自己一起杀'],
  [/\b(?:shutdown|reboot|poweroff|halt)\b/, '关机/重启整机会断开所有服务'],
  [/\bdocker\s+(?:restart|stop|rm)\s+napcat\b/, '重启 napcat 容器会让 QQ 掉线并要求重新扫码'],
  [/\bdocker\s+compose\s+(?:down|restart)\b/, 'compose down 会停掉容器（含 napcat）'],
]

/**
 * 判断这条命令是否会把自己/整机弄断；返回**给人看的原因**，不会断则 null。
 *
 * 只做保守匹配：宁可漏掉（交给 L2 审批），也不要把普通命令误拦成"必须审批"。
 */
export function selfHarmReason(command: string): string | null {
  const text = String(command ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return null
  for (const [pattern, reason] of RULES) if (pattern.test(text)) return reason
  return null
}

/** 拦下时给模型的话（把"别做"换成"怎么做"）。 */
export function selfHarmHint(command: string, reason: string): string {
  const one = command.replace(/\s+/g, ' ').trim()
  return [
    `这条命令会把你自己的进程一起杀掉，所以不能在当前回合里直接执行（${reason}）。`,
    '改走审批：给主人发私聊「申请 ' + one + '」，主人回「批准 appr-…」之后，',
    '由独立的 systemd 单元（dsh-approval.service）在另一个 cgroup 里执行；',
    '执行期间当前会话会断开，这是预期行为——重启完成后会自动重连。',
  ].join('')
}

/** 从工具调用里认出"要执行的命令"：终端的 text / shell 的 command 都算。 */
function commandOf(name: string, args: unknown): string | null {
  if (!/(?:^|_)(?:terminal_send|bash|shell|exec)(?:$|_)/.test(name)) return null
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  for (const key of ['text', 'command', 'cmd', 'script']) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

/**
 * 工具调用层面的入口：命中就返回**给模型看的拒绝文案**，否则 null。
 *
 * 抽到这里是为了让 `register.ts` 只剩一行调用（那份文件贴着 400 行硬上限）。
 */
export function selfHarmGuard(name: string, args: unknown): string | null {
  const command = commandOf(name, args)
  if (command === null) return null
  const reason = selfHarmReason(command)
  return reason === null ? null : selfHarmHint(command, reason)
}
