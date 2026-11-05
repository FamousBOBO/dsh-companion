/** Cross-platform path resolution for the harness home and session logs.
 *
 * Every module used to inline its own `process.env.DSH_HOME ?? <win32 literal>`
 * fallback, which silently produced unusable relative paths on a POSIX host.
 * They all resolve through here now.
 */

import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import { decodeZstdFrames, resolveZstd } from './adapters/session-log/zstd-frames.js'

/** The harness home: `$DSH_HOME`, else `<user home>/.dsh`. */
export function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv
  const home = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir()
  return path.join(home ?? '.', '.dsh')
}

/** The JSONL session-log root (the `session-persistence-jsonl` row's `root`). */
export function resolveSessionsRoot(): string {
  const fromEnv = process.env.DSH_SESSIONS_ROOT
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv
  return path.join(resolveDshHome(), 'sessions')
}

/**
 * Encode an arbitrary string as one filesystem-safe path segment.
 *
 * Mirror of the harness's own `encodeSegment` (`dsh-session-persistence-jsonl/
 * format`): safe code units stay literal, every other unit becomes `~XXXX`.
 * A session id is an unvalidated branded string, so this must match the
 * writer's encoding exactly or the lookup silently misses.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Build the per-project directory key for a workspace path.
 *
 * Mirror of the harness's `projectKey`: separators (`/`, `\`, `:`) collapse to a
 * single `-`, the whole slug is wrapped in `--…--`.
 * e.g. `/srv/dsh/workspace` → `--opt-dsh-workspace--`.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** One session's directory under the log root (`_no-cwd` when cwd is unknown). */
export function sessionDir(cwd: string | undefined, sessionId: string): string {
  const root = resolveSessionsRoot()
  const project = cwd === undefined || cwd === '' ? '_no-cwd' : projectKey(cwd)
  return path.join(root, project, encodeSegment(sessionId))
}

/** A committed session artifact, newest format generation first. */
function rankArtifact(name: string): number | null {
  const match = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(name)
  if (match === null) return null
  return match[1] === undefined ? 0 : Number(match[1])
}

/**
 * Read and decompress a session's log.
 *
 * The on-disk artifact name carries the Session format generation
 * (`session.v4.jsonl.zstd` today, `session.jsonl` for the original v0), so the
 * directory is scanned and the highest generation wins rather than pinning a
 * version this plugin would then have to chase on every harness release.
 *
 * **The `.zstd` files are multi-frame** (one frame per append), and
 * `zstdDecompressSync` silently returns only the first frame — which is the
 * session header, i.e. one line. `decodeZstdFrames` walks the frames instead;
 * see its module comment for the measured numbers.
 *
 * @param cwd - the agent workspace the session ran in (`undefined` → `_no-cwd`).
 * @param sessionId - the session id, e.g. `qq-group-1000000008`.
 * @returns the decoded JSONL text, or null when no readable log exists.
 */
export async function readSessionLog(cwd: string | undefined, sessionId: string): Promise<string | null> {
  const dir = sessionDir(cwd, sessionId)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return null
  }
  const artifacts = names
    .map((name) => ({ name, rank: rankArtifact(name) }))
    .filter((entry): entry is { name: string; rank: number } => entry.rank !== null)
    .sort((a, b) => b.rank - a.rank)
  if (artifacts.length === 0) return null
  const { name } = artifacts[0]!
  const file = path.join(dir, name)
  const raw = await fs.readFile(file)
  if (!name.endsWith('.zstd')) return raw.toString('utf8')
  return decodeZstdFrames(raw, resolveZstd()).text
}
