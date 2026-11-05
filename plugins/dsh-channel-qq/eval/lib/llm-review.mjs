/**
 * 可选的「LLM 评审」钩子 —— **默认不跑**。
 *
 * 规则判定是主判据；这个钩子只在 `node eval/run.mjs --llm-review` 且配置了
 * 环境变量时启用，让一个模型对判失败/有争议的条目给"分数与理由"。它只产出
 * 意见文本，**不自动改任何东西**（07 §5.3 的约定）。
 *
 * 配置（任一缺省即视为未启用）：
 *   EVAL_LLM_BASE_URL   OpenAI 兼容端点，如 http://127.0.0.1:8000/v1
 *   EVAL_LLM_MODEL      模型名（缺省 "default"）
 *
 * 为什么默认不跑：评测底盘必须今天就能离线跑（QQ 掉线中），模型评审既慢又有
 * 网络依赖；主判据（规则）不能建立在它上面。
 */

/** 是否配置了 LLM 评审端点。 */
export function llmReviewConfigured(env = process.env) {
  return typeof env.EVAL_LLM_BASE_URL === 'string' && env.EVAL_LLM_BASE_URL.trim() !== ''
}

/**
 * 把失败条目交给模型评审。
 *
 * @returns {Promise<{skipped: boolean, reason?: string, model?: string, notes?: string, error?: string}>}
 *          永远不抛错——评审失败不该让评测本身失败。
 */
export async function reviewWithLlm({ failures, rubric, env = process.env, fetchImpl = globalThis.fetch }) {
  if (!llmReviewConfigured(env)) {
    return { skipped: true, reason: '未配置 EVAL_LLM_BASE_URL（默认不跑 LLM 评审）' }
  }
  if (failures.length === 0) {
    return { skipped: true, reason: '没有失败条目需要评审' }
  }
  const base = String(env.EVAL_LLM_BASE_URL).replace(/\/+$/, '')
  const model = typeof env.EVAL_LLM_MODEL === 'string' && env.EVAL_LLM_MODEL !== '' ? env.EVAL_LLM_MODEL : 'default'
  const prompt = [
    rubric ?? '下面是一份 QQ 机器人评测的失败条目。请给每条 0–10 的分数与一句理由，只输出评审意见，不要改写任何用例或规则。',
    JSON.stringify(failures.slice(0, 30), null, 2),
  ].join('\n\n')
  try {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) return { skipped: false, model, error: `HTTP ${res.status}` }
    const data = await res.json()
    const notes = data?.choices?.[0]?.message?.content ?? ''
    return { skipped: false, model, notes: String(notes).slice(0, 8000) }
  } catch (error) {
    return { skipped: false, model, error: error instanceof Error ? error.message : String(error) }
  }
}
