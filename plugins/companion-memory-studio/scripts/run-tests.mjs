#!/usr/bin/env node
// 测试运行器：先把「数据根」指到临时目录，再交给 `node --test` 跑本包的用例。
//
// 为什么需要它：`server.mjs` 在**模块加载时**就把 `STUDIO_ROOT` 算成数据根
// （`resolveSuitePaths(...).dataRoot`），而健康桥接的 `resolveHealthService` 在解析失败时
// 会写一份诊断（`<dataRoot>/home/health/bridge-miss.json`）。测试里调用 `registerStudioApi`
// 就会走到那条路径——如果数据根还是仓库的真实目录，测试就跑进了产品数据目录。
//
// 做法与 foundation / health 一致：把 `DSH_COMPANION_DATA_DIR` 指到 `mkdtemp`，跑完删掉。
// 这样 `npm test` 既不写仓库，也不写用户数据；同一个临时根在两遍运行之间互不影响（幂等）。
//
// 用法：node scripts/run-tests.mjs   （也可以直接传额外参数给 node --test）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-studio-test-'));
const args = ['--test', 'test/*.test.mjs', ...process.argv.slice(2)];

let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不影响测试结论 */
  }
};

process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

const child = spawn(process.execPath, args, {
  cwd: root,
  // inherit：既保留真实终端输出，也不经过管道（沙箱里管道 stdio 会被拒）。
  stdio: 'inherit',
  env: { ...process.env, DSH_COMPANION_DATA_DIR: dataDir },
});

child.on('error', (error) => {
  cleanup();
  console.error(`无法启动 node --test：${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  cleanup();
  if (signal) {
    console.error(`测试进程被信号中断：${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
