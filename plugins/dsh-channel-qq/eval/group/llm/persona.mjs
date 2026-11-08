/**
 * **人格快照**：评测里必须用线上那一份人格，而不是评测自己编一段"她是谁"。
 *
 * 两个模块都来自生产代码，谁也不重写：
 *   1. `plugins/companion-foundation/group-persona.mjs` 的 `buildGroupPersonaSnapshot()`
 *      —— 人格文件（markdown）→ 群聊可见快照（标题白名单、字数上限、私聊小节否决）；
 *   2. `build/lib/app/inbound/group-persona.js` 的 `normalizePersonaSnapshot()`
 *      —— 跨插件边界的结构归一化（线上消费端就是这么拿的）。
 *
 * 为什么不在评测里各写一半：人格快照直接决定"她像不像同一个人"。评测自己拼一段人格，
 * 测出来的就只是"评测写的那段人格下模型怎么说话"——那不是线上表现。
 *
 * 文件解析顺序与套件一致（`config/persona.md` → `config/persona.example.md` →
 * `data/workspace/PERSONA.md`）；一个都找不到就返回 `null` 并在报告里明说"人格快照不可用"，
 * 与线上 `DEGRADED_PERSONA_LINES` 的口径一致（不假装读过人格）。
 */

import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 套件根（本文件位于 <root>/plugins/dsh-channel-qq/eval/group/llm/）。 */
export const SUITE_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))

/** 与 `suite-paths.mjs` 同序的候选（只读，缺了就是缺了）。 */
const CANDIDATES = Object.freeze([
  { rel: 'config/persona.md', label: 'config/persona.md' },
  { rel: 'config/persona.example.md', label: 'config/persona.example.md' },
  { rel: 'data/workspace/PERSONA.md', label: 'workspace/PERSONA.md' },
])

/** 加载生产模块：先 tsc 产物，再退到 TS 源码（与 `eval/group/adapter.mjs` 同一套退路）。 */
async function loadNormalizer() {
  for (const specifier of [
    '../../../build/lib/app/inbound/group-persona.js',
    '../../../lib/app/inbound/group-persona.js',
  ]) {
    try {
      return { module: await import(specifier), specifier }
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    }
  }
  // 没有任何构建产物：直接跑 src 下的 .ts（Node 24 类型剥离 + 仓库既有的解析钩子）。
  const { register } = await import('node:module')
  register('../ts-resolve-hook.mjs', import.meta.url)
  const url = new URL('../../../src/app/inbound/group-persona.ts', import.meta.url).href
  return { module: await import(url), specifier: url }
}

/** foundation 的快照抽取器（纯函数、零 I/O）。 */
async function loadBuilder() {
  const url = pathToFileURL(path.join(SUITE_ROOT, 'plugins/companion-foundation/group-persona.mjs')).href
  return await import(url)
}

/**
 * 读人格并建快照。
 *
 * @param {object} [options]
 * @param {string} [options.personaFile] 显式指定（CLI `--persona-file`）；给了就不再按候选找
 * @param {string} [options.personaId] 记忆作用域/预设 id（报告里只记"有没有"，不记值）
 * @returns {Promise<{snapshot: object|null, file: string, source: string, version: string, degraded: boolean, note: string}>}
 */
export async function loadPersona({ personaFile = '', personaId = '' } = {}) {
  const chosen = personaFile !== ''
    ? { file: path.resolve(personaFile), label: path.basename(personaFile) }
    : CANDIDATES.map((item) => ({ file: path.join(SUITE_ROOT, item.rel), label: item.label }))
      .find((item) => existsSync(item.file))
  if (chosen === undefined) {
    return {
      snapshot: null,
      file: '',
      source: 'persona.md',
      version: '',
      degraded: true,
      note: '没有找到人格文件（config/persona.md / config/persona.example.md / data/workspace/PERSONA.md 都不存在）',
    }
  }
  let markdown = ''
  try {
    markdown = readFileSync(chosen.file, 'utf8')
  } catch (error) {
    return {
      snapshot: null,
      file: chosen.label,
      source: 'persona.md',
      version: '',
      degraded: true,
      note: `人格文件读不出来（${chosen.label}）：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const [{ buildGroupPersonaSnapshot }, normalizer] = await Promise.all([loadBuilder(), loadNormalizer()])
  const raw = buildGroupPersonaSnapshot(markdown, { personaId, source: chosen.label })
  const snapshot = normalizer.module.normalizePersonaSnapshot(raw)
  return {
    snapshot,
    file: chosen.label,
    source: snapshot?.source ?? chosen.label,
    version: snapshot?.version ?? '',
    degraded: snapshot === null,
    note: snapshot === null ? '人格文件读到了，但抽不出任何群聊可见字段（快照为空）' : '',
    /** 归一化器来自哪一份（报告里写清楚"用的是线上的哪一段代码"）。 */
    normalizer: normalizer.specifier,
  }
}

/** 报告里用的人格摘要：**只记版本与来源**，不记正文（正文可能含用户自己写的事实）。 */
export function personaSummary(persona) {
  return {
    available: persona.snapshot !== null,
    version: persona.version,
    source: persona.source,
    file: persona.file,
    degraded: persona.degraded,
    note: persona.note,
  }
}
