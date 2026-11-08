/**
 * **自测的两块**：绊线端到端 + 异常路径（`--selftest` 用；生产运行不走这里）。
 *
 * 为什么不放在 `run.mjs` 里：它要起子进程、起临时假服务、跑两轮短语料——那是"测试的测试"，
 * 与运行器本身的职责（读配置、跑语料、出报告）不是一回事。混在一起会让 `run.mjs` 变成
 * 一个既跑生产又跑自检的文件，谁都不敢改。
 *
 * 这里同样**没有判定**：断言只看生产函数的返回值（解析档、错误码、绊线记录、退出码）。
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { CASES } from '../corpus.mjs'
import { ENV, readConfig } from './env.mjs'
import { startFakeServer } from './fake-server.mjs'
import { FAKE_GROUP_ID, createTripwirePlatform } from './port.mjs'
import { fakePresenceState, judgeEntries, runPresenceCycle, settingsOf } from './impl.mjs'
import { loadPersona } from './persona.mjs'
import { runCorpus } from './pipeline.mjs'

/**
 * **绊线端到端自测**：在**子进程**里重放一次会发消息的决策，并且**故意不给**影子闸门。
 *
 * 为什么要单独一个子进程：这个自测要证明的是"当发送路径真的被走到时，绊线会响、退出码是 1"。
 * 在主进程里让绊线响一次，会把整份报告变成 HARD FAIL——那正好验证不了正常路径。
 * 子进程用同一份代码、同一套端口，只换两个参数（`--selftest-trip`），所以它证明的是
 * **同一条发送路径**，不是另写的一段。
 *
 * @returns {Promise<{code: number, summary: string}>}
 */
export async function selftestTripSafety() {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), '--selftest-trip'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 120_000,
  })
  const stdout = String(child.stdout ?? '')
  const stderr = String(child.stderr ?? '')
  const line = [...stdout.split('\n'), ...stderr.split('\n')].map((item) => item.trim()).find((item) => item.startsWith('TRIP-SELFTEST')) ?? ''
  const code = typeof child.status === 'number' ? child.status : 2
  return { code, summary: line === '' ? '（子进程没有打印 TRIP-SELFTEST 行）' : line.replace('TRIP-SELFTEST ', '') }
}

/**
 * `--selftest-trip`：故意走一次"要发消息"的路径，确认**绊线拦得住**。
 *
 * 与主流程的唯一差别：`sendGate` 返回 `live`（线上真发的模式），端口仍是绊线。
 * 期望现象：`send` 里调 `platform.api.sendGroupMessage` → 抛错 → 这一轮记 `failed`，
 * 该条示例 HARD FAIL、退出码 1，并且**打印出来的原因里有 tripwire**。
 */
export async function runTripSelfTest() {
  const fake = await startFakeServer({ port: 0, mode: 'mixed' })
  try {
    const { config } = readConfig({
      [ENV.baseUrl]: fake.url,
      [ENV.model]: 'selftest-trip',
      [ENV.timeoutMs]: '5000',
    })
    const persona = await loadPersona({})
    const nowMs = Date.UTC(2026, 10, 8, 14, 0)
    const settingsValue = settingsOf()
    const background = [
      { messageId: 11, userId: 1, name: '甲', text: '周末有人去爬山吗', atMs: nowMs - 3_000 },
      { messageId: 12, userId: 2, name: '乙', text: '我去', atMs: nowMs - 2_000 },
    ]
    const tripwire = createTripwirePlatform({ label: 'trip-selftest' })
    const outcome = await runPresenceCycle(
      {
        groupId: FAKE_GROUP_ID,
        settings: settingsValue,
        state: fakePresenceState({ nowMs }),
        background: judgeEntries(background),
        sentLines: [],
        nowLabel: '22:00',
        persona: persona.snapshot,
      },
      {
        clock: { now: () => nowMs, date: () => new Date(nowMs), setTimeout: () => ({ cancel: () => {} }), setInterval: () => ({ cancel: () => {} }) },
        log: () => {},
        platform: () => tripwire.platform,
        complete: {
          // 假模型：直接给一个"要发"的决策（目标是真实存在的 12）。
          async complete() {
            return { kind: 'text', text: '{"action":"reply","targetMessageId":12,"text":"那就周末见","reason":"假的要发"}' }
          },
        },
        recordSent: async () => {},
        // **故意**返回 live：模拟"线上真发的模式"走到发送那一步。
        sendGate: () => 'live',
      },
    )
    const trips = tripwire.trips.length
    const hit = trips > 0 && outcome.kind === 'failed' && /tripwire/.test(String(outcome.detail ?? ''))
    console.log(
      'TRIP-SELFTEST '
      + (hit ? 'PASS' : 'FAIL')
      + ` · 绊线触发 ${String(trips)} 次 · 结局 ${outcome.kind} · 原因 ${String(outcome.detail ?? outcome.reason ?? '').slice(0, 60)}`,
    )
    return hit ? 1 : 0
  } finally {
    await fake.close()
  }
}


/**
 * `--selftest` 的断言（自测必须自己判自己，不能只打印一段好看的数字）。
 *
 * 四条：① 每条示例都走到了生产解析（有原始输出、有解析档）；② 绊线一次都没响；
 * ③ 报告三件套真的写出来了；④ 覆盖全部语料（除非用了 --case）。
 * 任何一条不成立，自测退出码 1——"跑完了"不等于"跑通了"。
 */
export function selftestChecksOf({ records, wanted, trips, files }) {
  const parsed = records.filter((record) => typeof record.rawOutput === 'string' && record.rawOutput !== '')
  const tiered = records.filter((record) => ['decision', 'silent', 'invalid'].includes(record.tier))
  const scenes = new Set(records.map((record) => record.sceneId))
  return [
    {
      name: '每条示例都走到了生产解析（有原始输出 + 解析档）',
      ok: tiered.length === records.length && parsed.length === records.length,
      detail: `${String(tiered.length)}/${String(records.length)} 次判断有解析档`,
    },
    { name: '绊线没有被触发（零 QQ 发送）', ok: trips.length === 0, detail: `触发 ${String(trips.length)} 次` },
    {
      name: '报告三件套都写出来了（report.json / report.md / cases.jsonl）',
      ok: Boolean(files.reportJson && files.reportMd && files.casesJsonl),
      detail: `${files.reportJson} · ${files.reportMd} · ${files.casesJsonl}`,
    },
    { name: '覆盖本次要跑的示例（默认全部语料）', ok: scenes.size === wanted.length, detail: `${String(scenes.size)} 条示例` },
  ]
}


/**
 * `--selftest` 的第二组断言：**异常路径要被记成异常码，而不是被吞掉**。
 *
 * 用两台本地假服务分别模拟两种真实会遇到的故障：
 *   - `unauthorized`（HTTP 401，鉴权配错）→ `errorCode: 'http-error'`；
 *   - `garbage`（HTTP 200 但不是 JSON，网关返回一段 HTML）→ `errorCode: 'bad-json'`。
 * 两者都必须让这一条记成 `failed / transport`，**不能**被当成"模型选择沉默"。
 */
export async function selftestErrorPaths({ config }) {
  const persona = await loadPersona({})
  const cases = CASES.slice(0, 2)
  const checks = []
  for (const [mode, expected] of [['unauthorized', 'http-error'], ['garbage', 'bad-json']]) {
    const server = await startFakeServer({ port: 0, mode })
    try {
      const result = await runCorpus({
        cases,
        config: { ...config, baseUrl: server.url, origin: server.origin, repeat: 1 },
        persona,
        channel: { mode: 'composed', detail: 'selftest' },
      })
      const codes = result.records.map((record) => record.errorCode)
      const executions = result.records.map((record) => record.execution)
      checks.push({
        name: `故障模式 ${mode} → errorCode=${expected}、不许记成沉默`,
        ok: codes.every((code) => code === expected) && executions.every((exec) => exec === 'failed') && result.trips.length === 0,
        detail: `errorCode ${codes.join('/')} · 结局 ${executions.join('/')} · 绊线 ${String(result.trips.length)}`,
      })
    } finally {
      await server.close()
    }
  }
  return checks
}