#!/usr/bin/env node
/**
 * `npm run migrate -- <export|check|import> [flags]`
 *
 * Thin shell only: every decision (paths, backup, validation, exit codes) lives in
 * tools/migrate/cli.mjs, which also runs standalone as
 * `node tools/migrate/cli.mjs <export|check|import> ...`.
 *
 * Exit codes are the migration contract's, not this file's invention:
 *   0 success · 1 unexpected error · 2 validation failed · 3 operator decision needed
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, '..', 'tools', 'migrate', 'cli.mjs');

if (!fs.existsSync(cliPath)) {
  process.stderr.write(
    '迁移工具还没有安装完整：缺少 tools/migrate/cli.mjs。\n' +
      '如果你只是想部署套件，这条命令可以忽略；个人数据迁移属于可选流程，见 docs/04-migration.md。\n',
  );
  process.exitCode = 1;
} else {
  const { runMigrateCli } = await import(new URL('../tools/migrate/cli.mjs', import.meta.url).href);
  if (typeof runMigrateCli !== 'function') {
    process.stderr.write('tools/migrate/cli.mjs 没有导出 runMigrateCli()。\n');
    process.exitCode = 1;
  } else {
    process.exitCode = await runMigrateCli(process.argv.slice(2));
  }
}
