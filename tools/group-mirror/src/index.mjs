/**
 * 镜像进程的入口。
 *
 * 用法（**默认不启动任何东西**）：
 *   node tools/group-mirror/src/index.mjs --config <mirror.json> [--check]
 *
 * `--check` 只做配置校验并打印脱敏后的装配结果，不监听端口、不发起连接。
 * 这一点很重要：验收"配置对不对"不该顺带把网络打开。
 *
 * 三个令牌/地址全部来自环境变量或本机配置文件（都 gitignore），
 * 命令行参数里**不出现**任何令牌。
 */

import fs from 'node:fs'
import path from 'node:path'

import { MirrorConfigError, normalizeMirrorConfig } from './config.mjs'
import { createMirror } from './mirror.mjs'

/** 读 JSON 配置；文件不存在时返回空对象（让默认值生效，然后由校验决定能不能跑）。 */
function readConfigFile(file) {
  if (!file) return {}
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new MirrorConfigError('bad-file', '读不了配置文件 ' + file + '：' + error.message)
  }
}

function parseArgs(argv) {
  const out = { configFile: '', check: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--config') { out.configFile = argv[i + 1] ?? ''; i += 1 }
    else if (arg === '--check') out.check = true
  }
  return out
}

/** 脱敏回显：只显示"有没有"和"多长"，不回显任何令牌或对方令牌。 */
export function describeConfig(config) {
  return {
    enabled: config.enabled,
    sourceUrl: config.sourceUrl === '' ? '(未设置)' : new URL(config.sourceUrl).origin + new URL(config.sourceUrl).pathname,
    sourceTokenEnv: config.sourceTokenEnv,
    sourceTokenSet: config.secrets.sourceToken !== '',
    allowedGroups: config.allowedGroups.slice(),
    fakeOneBot: config.fakeOneBotHost + ':' + config.fakeOneBotPort,
    fakeOneBotTokenEnv: config.fakeOneBotTokenEnv,
    fakeTokenSet: config.secrets.fakeToken !== '',
    tokensDistinct: config.secrets.sourceToken !== config.secrets.fakeToken,
    maxQueueEntries: config.maxQueueEntries,
    collectBody: config.collectBody,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let config;
  try {
    config = normalizeMirrorConfig(readConfigFile(args.configFile));
  } catch (error) {
    if (error instanceof MirrorConfigError) {
      process.stderr.write('[mirror] 配置被拒绝（' + error.reason + '）：' + error.message + '\n');
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  process.stdout.write('[mirror] 配置：' + JSON.stringify(describeConfig(config), null, 2) + '\n');
  if (args.check) {
    process.stdout.write('[mirror] --check：未监听端口、未发起连接。\n');
    return;
  }
  if (!config.enabled) {
    process.stdout.write('[mirror] enabled=false：不启动（这是默认值）。\n');
    return;
  }

  const log = (line) => process.stdout.write(line + '\n');
  const mirror = createMirror({ config, log });
  const stop = async (signal) => {
    process.stdout.write('[mirror] 收到 ' + signal + '，停止中…\n');
    await mirror.stop();
    process.stdout.write('[mirror] 最终统计：' + JSON.stringify(mirror.report()) + '\n');
    process.exit(0);
  };
  process.on('SIGINT', () => { void stop('SIGINT') });
  process.on('SIGTERM', () => { void stop('SIGTERM') });

  await mirror.start();
  process.stdout.write('[mirror] 已启动。丢最旧上限 ' + config.maxQueueEntries + ' 条，白名单 ' + (config.allowedGroups.length === 0 ? '(空 = 不转发任何群)' : config.allowedGroups.length + ' 个群') + '\n');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write('[mirror] 失败：' + (error instanceof Error ? error.stack : String(error)) + '\n');
    process.exitCode = 1;
  });
}
