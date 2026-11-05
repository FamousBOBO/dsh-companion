#!/usr/bin/env node
/**
 * Migration CLI for the DSH Companion suite.
 *
 * Contract (docs/04-migration.md, TEAM-BRIEF D7):
 *   - `npm run migrate -- export|check|import ...`
 *   - stdout carries exactly one JSON document; human progress goes to stderr;
 *   - exit codes: 0 ok · 1 unexpected error · 2 validation failed · 3 operator
 *     decision required (target busy, identity conflict, output dir not empty).
 *
 * This module is importable (`runMigrateCli`) and also runnable directly
 * (`node tools/migrate/cli.mjs ...`). `scripts/migrate.mjs` is a three-line shim.
 */
import { pathToFileURL } from 'node:url';

import { runCheck } from './check.mjs';
import { runExport } from './export.mjs';
import { runImport } from './import.mjs';
import { sqliteStatus } from './sqlite.mjs';

export const EXIT = { ok: 0, error: 1, invalid: 2, refused: 3 };

const USAGE = `DSH Companion — 个人数据迁移

用法：
  npm run migrate -- export [--out <目录>] [--domains memory,runtime,identity,reminders,health,qq]
  npm run migrate -- check  --from <迁移包目录>
  npm run migrate -- import --from <迁移包目录> [--identity adopt|quarantine] [--yes] [--dry-run]
  npm run migrate -- help

说明：
  * 凭据、登录缓存、宿主会话、媒体产物永不导出（无开关）。
  * export 默认导出 ${'memory, runtime, identity, reminders, health, qq'}；
    memory-wiki 需显式 --domains 追加。
  * check 只读，不写任何东西。
  * import 会先做完整备份，失败即中止；import 拒绝在宿主运行时覆盖数据。
  * stdout 只有一个 JSON 文档；进度信息走 stderr。`;

const COMMANDS = new Set(['export', 'check', 'import', 'help']);

/**
 * @param {string[]} argv
 * @returns {{command:string, help:boolean, out?:string, from?:string, domains?:string, identity?:string, yes:boolean, dryRun:boolean, errors:string[]}}
 */
export function parseArgs(argv = []) {
  const args = { command: '', help: false, yes: false, dryRun: false, errors: [] };
  const list = [...argv];
  while (list.length) {
    const token = list.shift();
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (!token.startsWith('-')) {
      if (!args.command) {
        args.command = token;
        if (!COMMANDS.has(token)) args.errors.push(`未知子命令：${token}`);
      } else {
        args.errors.push(`多余的参数：${token}`);
      }
      continue;
    }
    const [flag, inline] = token.includes('=') ? token.split(/=(.*)/s) : [token, undefined];
    const takeValue = () => {
      if (inline !== undefined) return inline;
      const next = list.shift();
      if (next === undefined || next.startsWith('-')) {
        args.errors.push(`${flag} 需要一个值`);
        return undefined;
      }
      return next;
    };
    switch (flag) {
      case '--out': args.out = takeValue(); break;
      case '--from': args.from = takeValue(); break;
      case '--domains': args.domains = takeValue(); break;
      case '--identity': {
        const value = takeValue();
        if (value && !['adopt', 'quarantine'].includes(value)) {
          args.errors.push(`--identity 只接受 adopt 或 quarantine（收到 ${value}）`);
        } else {
          args.identity = value;
        }
        break;
      }
      case '--yes': args.yes = true; break;
      case '--dry-run': args.dryRun = true; break;
      default: args.errors.push(`未知选项：${flag}`);
    }
  }
  return args;
}

function writeJsonLine(out, value) {
  out(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Run one CLI invocation.
 * @param {string[]} argv arguments after `npm run migrate --` (or `node cli.mjs`)
 * @param {{stdout?:Function, stderr?:Function, env?:object}} [io]
 * @returns {Promise<number>} process exit code
 */
export async function runMigrateCli(argv = [], io = {}) {
  const out = io.stdout ?? ((text) => process.stdout.write(text));
  const err = io.stderr ?? ((text) => process.stderr.write(text));
  const context = { ...io, env: io.env ?? process.env };
  const args = parseArgs(argv);

  if (args.help || args.command === 'help' || (!args.command && !args.errors.length)) {
    err(`${USAGE}\n`);
    writeJsonLine(out, {
      schemaVersion: 1,
      command: 'help',
      ok: true,
      usage: USAGE,
      sqlite: await sqliteStatus(),
    });
    return args.command || args.help ? EXIT.ok : EXIT.invalid;
  }

  if (args.errors.length) {
    writeJsonLine(out, {
      schemaVersion: 1,
      command: args.command || 'unknown',
      ok: false,
      error: { code: 'bad-arguments', message: args.errors.join('；') },
      usage: USAGE,
    });
    err(`${args.errors.join('\n')}\n\n${USAGE}\n`);
    return EXIT.invalid;
  }

  try {
    if (args.command === 'export') {
      const { code, payload } = await runExport(args, context);
      writeJsonLine(out, payload);
      if (!payload.ok) err(`${payload.error?.message ?? '导出失败'}\n`);
      return code;
    }
    if (args.command === 'check') {
      const { code, payload } = await runCheck(args, context);
      writeJsonLine(out, payload);
      if (payload.ok) err('预检通过。\n');
      else err(`${payload.error?.message ?? payload.problems?.[0]?.message ?? '预检未通过'}\n`);
      return code;
    }
    if (args.command === 'import') {
      const { code, payload } = await runImport(args, context);
      writeJsonLine(out, payload);
      if (payload.ok) {
        err(`导入完成：${payload.imported?.length ?? 0} 个文件；备份在 ${payload.backup?.dir ?? '(无)'}。\n`);
        for (const step of payload.nextSteps ?? []) err(`  - ${step}\n`);
      } else {
        err(`${payload.error?.message ?? '导入失败'}\n`);
      }
      return code;
    }
    writeJsonLine(out, {
      schemaVersion: 1,
      command: args.command,
      ok: false,
      error: { code: 'unknown-command', message: `未知子命令：${args.command}` },
      usage: USAGE,
    });
    return EXIT.invalid;
  } catch (error) {
    writeJsonLine(out, {
      schemaVersion: 1,
      command: args.command || 'unknown',
      ok: false,
      error: { code: 'unexpected-error', message: error?.message ?? String(error), stack: error?.stack ?? '' },
    });
    err(`未预期错误：${error?.stack ?? error}\n`);
    return EXIT.error;
  }
}

const invokedDirectly = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await runMigrateCli(process.argv.slice(2));
}

export default { runMigrateCli, parseArgs, EXIT, USAGE };
