#!/usr/bin/env node
/**
 * 会话换血：备份 → 停 dsh → 清空 QQ 会话历史 → 写续接种子 → 起 dsh。
 *
 * 为什么停服务：运行中的会话会把内存里的记录继续写回文件，不清干净就等于没清。
 * 为什么能在外面停服务：本脚本由 systemd 独立单元（`dsh-session-reset.service`）
 * 运行，**不在 dsh 的 cgroup 里**，所以 `systemctl stop dsh` 不会把自己一起杀掉
 * （「重启自己」这条坑见《阿衡机制清单》§2）。
 *
 * 用法：
 *   node deploy/session-reset.mjs            # 全部 qq-* 会话
 *   node deploy/session-reset.mjs qq-dm-1    # 指定会话
 *   node deploy/session-reset.mjs --dry-run  # 只打印计划
 *
 * 环境变量：
 *   DSH_HOME（默认 ~/.dsh）
 *   CHANNEL_QQ_SESSIONS_ROOT（默认 <DSH_HOME>/sessions）
 *   CHANNEL_QQ_RESET_LOG_DIR（默认 <DSH_HOME>/channel-qq/logs）
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const explicit = argv.filter((a) => !a.startsWith('--'))

const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const SESSIONS_ROOT = process.env.CHANNEL_QQ_SESSIONS_ROOT ?? path.join(HOME, 'sessions')
const LOG_DIR = process.env.CHANNEL_QQ_RESET_LOG_DIR ?? path.join(HOME, 'channel-qq', 'logs')
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
const LOG_FILE = path.join(LOG_DIR, `session-reset-${STAMP}.log`)
const BACKUP_ROOT = path.join(HOME, 'channel-qq', 'backups', `session-reset-${STAMP}`)

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`
  console.log(text)
  try { mkdirSync(LOG_DIR, { recursive: true }); appendFileSync(LOG_FILE, text + '\n') } catch { /* 日志失败不影响换血 */ }
}

/** 枚举所有工作区目录下的 qq-* 会话（只碰 QQ 的，不碰 web/自动化会话）。 */
function listQqSessions() {
  const out = []
  for (const layout of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!layout.isDirectory()) continue
    const layoutDir = path.join(SESSIONS_ROOT, layout.name)
    for (const entry of readdirSync(layoutDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('qq-')) continue
      out.push({ id: entry.name, dir: path.join(layoutDir, entry.name), layout: layout.name })
    }
  }
  return out
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function main() {
  if (!existsSync(SESSIONS_ROOT)) {
    log(`FATAL：会话根目录不存在 ${SESSIONS_ROOT}`)
    process.exit(2)
  }
  let sessions = listQqSessions()
  if (explicit.length > 0) {
    const want = new Set(explicit)
    sessions = sessions.filter((s) => want.has(s.id))
    const missing = [...want].filter((id) => !sessions.some((s) => s.id === id))
    if (missing.length > 0) log(`忽略不存在的会话：${missing.join(', ')}`)
  }
  if (sessions.length === 0) {
    log('没有需要换血的 QQ 会话')
    process.exit(0)
  }

  log(`计划：${sessions.length} 个会话 → ${sessions.map((s) => s.id).join(', ')}`)
  if (dryRun) { log('--dry-run：不执行'); return }

  // 1) 备份（先备后清：任何清空动作之前，历史已经在备份目录里）
  mkdirSync(BACKUP_ROOT, { recursive: true })
  for (const s of sessions) {
    const dest = path.join(BACKUP_ROOT, s.id)
    try {
      cpSync(s.dir, dest, { recursive: true })
      const cache = path.join(HOME, 'storages', 'session_projcache', 'sessions', `${s.id}.json`)
      if (existsSync(cache)) cpSync(cache, path.join(dest, 'projcache.json'))
      log(`备份 ${s.id} → ${dest}`)
    } catch (error) {
      log(`WARN：备份 ${s.id} 失败（继续）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 2) 停服务（本进程在独立 cgroup，不会被连坐）
  try {
    run('systemctl', ['stop', 'dsh'])
    log('dsh 已停止')
  } catch (error) {
    log(`FATAL：停止 dsh 失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  // 3) 清空历史 + 写种子；任何失败都要把服务拉回来
  try {
    const seeds = []
    for (const s of sessions) {
      for (const name of readdirSync(s.dir)) {
        if (name === 'session.v4.jsonl.zstd' || name === 'session.lock' || name === 'session.v3.jsonl.zstd') {
          rmSync(path.join(s.dir, name), { force: true })
        }
      }
      const cache = path.join(HOME, 'storages', 'session_projcache', 'sessions', `${s.id}.json`)
      if (existsSync(cache)) rmSync(cache, { force: true })
      const seed = {
        sessionId: s.id,
        createdAt: new Date().toISOString(),
        seed: [
          '【会话换血】上一段对话的上下文已经清空（历史已备份，可回滚）。',
          '人格与长期记忆没有变：仍按 AGENTS.md 的约定说话，长期记忆按需检索。',
          '如果主人问起，说明这次是定期换血；不需要主动补发长报告。',
        ].join('\n'),
      }
      const seedFile = path.join(HOME, 'channel-qq', `session-seed-${s.id}.json`)
      writeFileSync(seedFile, JSON.stringify(seed, null, 2))
      seeds.push(seedFile)
      log(`清空 + 种子 ${s.id} → ${seedFile}`)
    }
    log(`完成：${sessions.length} 个会话`)
  } catch (error) {
    log(`FATAL：清空过程中出错：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    try {
      run('systemctl', ['start', 'dsh'])
      log('dsh 已启动')
    } catch (error) {
      log(`FATAL：启动 dsh 失败：${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  }
  log(`备份目录：${BACKUP_ROOT}`)
  log(`回滚：cp -a ${BACKUP_ROOT}/<会话id>/. <会话目录>/ 然后 systemctl restart dsh`)
}

main()
