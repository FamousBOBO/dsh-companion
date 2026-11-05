#!/usr/bin/env node
/**
 * 审批执行器：由 systemd path 单元在检测到 `queue/*.req` 时以 root 运行。
 *
 * 为什么必须是独立单元而不是在 dsh 里直接跑：被批准的命令经常是"重启 dsh"。
 * 如果它在 dsh 的进程树里执行，`systemctl restart dsh` 会连执行者一起杀掉
 * （KillMode=control-group），服务停在中途起不来。独立 unit = 独立 cgroup。
 *
 * 用法：node approve-exec.mjs [--dry-run]
 * 目录：CHANNEL_QQ_APPROVAL_DIR，默认 /var/lib/dsh-approval
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dryRun = process.argv.includes('--dry-run')

const store = await import(new URL('../build/lib/features/approval/store.js', import.meta.url).href)
const dir = store.approvalDir()
const queueDir = path.join(dir, 'queue')

/** 跑一条命令；超时 5 分钟，输出截断到 64KB（回执只发摘要）。 */
function run(command) {
  return new Promise((resolve) => {
    execFile('bash', ['-lc', command], {
      cwd: '/',
      timeout: 5 * 60_000,
      maxBuffer: 64 * 1024,
      env: { ...process.env, HOME: '/root' },
    }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        exitCode: error === null ? 0 : (typeof error.code === 'number' ? error.code : null),
        output: `${stdout}${stderr}`.trim(),
      })
    })
  })
}

const names = await fs.readdir(queueDir).catch(() => [])
const pending = names.filter((n) => n.endsWith('.req'))
if (pending.length === 0) {
  console.log('approval-exec: 没有待执行请求')
  process.exit(0)
}

for (const name of pending) {
  const id = name.slice(0, -4)
  const reqFile = path.join(dir, 'requests', `${id}.json`)
  let request
  try {
    request = JSON.parse(await fs.readFile(reqFile, 'utf-8'))
  } catch {
    await fs.unlink(path.join(queueDir, name)).catch(() => {})
    console.error(`approval-exec: 找不到请求 ${id} 的 JSON，丢弃队列标记`)
    continue
  }

  // 核验：状态 / 令牌 / 有效期 / 命令哈希（命令以请求里归一化后的原文为准）。
  const verdict = await store.consumeById(id, request.command, dir)
  if (!verdict.ok) {
    console.error(`approval-exec: 拒绝执行 ${id}（${verdict.reason}）`)
    await store.writeResult({
      id, command: request.command, ok: false, exitCode: null,
      output: `核验失败：${verdict.reason}`, finishedAt: Date.now(),
    }, dir)
    await fs.unlink(path.join(queueDir, name)).catch(() => {})
    continue
  }

  if (dryRun) {
    console.log(`[dry-run] 将执行 ${id}: ${request.command}`)
    continue
  }

  console.log(`approval-exec: 执行 ${id}: ${request.command}`)
  const result = await run(request.command)
  await store.writeResult({
    id, command: request.command, ok: result.ok, exitCode: result.exitCode,
    output: result.output.slice(-4000), finishedAt: Date.now(),
  }, dir)
  await fs.unlink(path.join(queueDir, name)).catch(() => {})
  console.log(`approval-exec: ${id} ${result.ok ? '成功' : `失败（exit ${result.exitCode}）`}`)
}
