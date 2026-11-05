/** 供应商请求头的两个内置预设（Claude Code / Codex CLI）与校验。
 *
 * 值的来源（都是可核实的原文，不是凭印象填的）：
 *   - Claude Code：`user-agent: claude-cli/<ver> (external, cli)`、`x-app: cli`、
 *     `anthropic-beta: claude-code-…` —— 开源实现 opencode-anthropic-oauth 的
 *     `src/oauth.ts`，以及 mindsdb/setfree 的适配器测试（逐字断言 `x-app == "cli"`、
 *     `anthropic-beta` 含 `claude-code-`）。
 *   - Codex CLI：`originator: codex_cli_rs` —— openai/codex 源码
 *     `codex-rs/login/src/auth/default_client.rs`（`DEFAULT_ORIGINATOR`）；
 *     `OpenAI-Beta: responses=experimental` —— AgentForge 的
 *     `OPENAI_CODEX_OAUTH_SPEC.md`。
 *
 * ⚠️ 宿主保留名：dsh 的 `requestHeaders()` 会把 `user-agent` 换成它自己的
 * `deepseek-harness/<ver>`（llm/src/attribution.ts），自定义值会被静默丢弃。
 * 所以两个预设都**不含** `user-agent`；只认 UA 的网关看到的是 harness 的身份。
 * 其余头（x-app / anthropic-beta / originator / OpenAI-Beta）正常透传。
 */

/** 宿主强制覆盖、自定义值会被丢弃的头（小写）。 */
export const RESERVED_HEADERS: readonly string[] = ['user-agent']

export interface HeaderPreset {
  id: string
  label: string
  /** 适配哪种协议（UI 选中时给出提示，不强制）。 */
  protocol: string
  headers: Record<string, string>
  note: string
}

export const HEADER_PRESETS: readonly HeaderPreset[] = [
  {
    id: 'claude-code',
    label: 'Claude Code (CC)',
    protocol: 'anthropic-messages',
    headers: {
      'x-app': 'cli',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05',
    },
    note: 'CC 真实还会发 user-agent: claude-cli/<ver> (external, cli)，但 dsh 保留该头、会被覆盖。',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    protocol: 'openai-responses',
    headers: {
      originator: 'codex_cli_rs',
      'OpenAI-Beta': 'responses=experimental',
    },
    note: 'Codex 真实还会发 user-agent: codex_cli_rs/<ver> (…)，同样被 dsh 覆盖。',
  },
]

const NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** 校验并规范化一组自定义头：名字是 token、值不含控制字符、不允许保留名。 */
export function normalizeHeaders(raw: unknown): Record<string, string> {
  if (raw === null || raw === undefined) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('请求头必须是「名字 → 值」的对象')
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(name).trim()
    if (!NAME_RE.test(key)) throw new Error(`请求头名字不合法：${key}`)
    if (RESERVED_HEADERS.includes(key.toLowerCase())) {
      throw new Error(`请求头 ${key} 由宿主接管（会被覆盖），不要填`)
    }
    const text = String(value ?? '')
    if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`请求头 ${key} 的值含控制字符`)
    if (text !== '') out[key] = text
  }
  return out
}

/** 按预设 id 取一份副本（未知 id 抛错，避免"点了没反应"）。 */
export function presetById(id: string): HeaderPreset {
  const found = HEADER_PRESETS.find((p) => p.id === id)
  if (found === undefined) throw new Error(`没有名为 ${id} 的请求头预设`)
  return { ...found, headers: { ...found.headers } }
}
