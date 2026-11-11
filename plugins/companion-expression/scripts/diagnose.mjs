#!/usr/bin/env node
/**
 * 表情包链路的**只读**诊断（不带宿主也能跑）。
 *
 * 回答四个问题，一句一行：
 *   1. 模块开没开、delivery 闸门开没开；
 *   2. 图库里有多少素材、多少已审核、多少待审/隔离；
 *   3. 主人私聊与主群**此刻**各有多少可用素材（同一套 `scopesFor` + 可见性硬门）；
 *   4. 最近一次候选为什么是空、最近一次发图的结果码与 `message_id`。
 *
 * 用法：
 *   node plugins/companion-expression/scripts/diagnose.mjs
 *   node plugins/companion-expression/scripts/diagnose.mjs --json
 *   node plugins/companion-expression/scripts/diagnose.mjs --dm 10001 --group 20002
 *
 * 只读：不写库、不下载、不调模型、不发图。输出里没有路径、URL、QQ 号明文与消息内容
 * （作用域本来就是加盐哈希，这里只给家族名）。
 */
import process from 'node:process';

const { createService } = await import('../src/index.mjs');

function parseArgs(argv) {
  const out = { json: false, dm: 0, group: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--dm') out.dm = Number(argv[++i]) || 0;
    else if (arg === '--group') out.group = Number(argv[++i]) || 0;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`未知参数：${arg}（可用：--json --dm <QQ号> --group <群号>）`);
  }
  return out;
}

/** 一条可读结论：把「能不能发」说成人话，而不是让人自己读一堆数字。 */
function verdictOf(report) {
  if (!report.module.enabled) return '模块已关闭（config 的 enabled=false）：四个 expression_* 工具都不存在。';
  if (!report.library.available) return '图库读不出来（数据库打不开）：这一轮既没有候选也不会发图。';
  if (report.library.assets === 0) return '图库是空的：先采集或被导入素材，否则 expression_candidates 只会回空。';
  if (!report.module.deliveryEnabled) return 'delivery.enabled 为 false：候选能查，但 expression_reply 一定被拒（闸门关着）。';
  const usable = report.targets.filter((t) => t.usableAssets > 0);
  if (usable.length === 0) return '这几个会话都没有可用素材：检查 capture.groups[].use / 审核态 / 可见性。';
  return `这些会话可以发：${usable.map((t) => `${t.kind}(${t.usableAssets})`).join('、')}。`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node plugins/companion-expression/scripts/diagnose.mjs [--json] [--dm <QQ号>] [--group <群号>]');
    process.exit(0);
  }
  const targets = [];
  if (args.dm > 0) targets.push({ kind: 'dm', chatId: args.dm });
  if (args.group > 0) targets.push({ kind: 'group', chatId: args.group });
  const service = createService({});
  if (service.ok === false) {
    console.log(`无法初始化表情模块：${service.reason}`);
    process.exit(1);
  }
  const report = service.diagnose({ targets });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('companion-expression — 只读诊断');
    console.log(`  delivery.enabled：${report.module.deliveryEnabled ? '开' : '关（不会真发图）'}`);
    console.log(`  采集：群=${report.module.captureGroups ? '开' : '关'}、主人私聊=${report.module.captureOwnerPrivate ? '开' : '关'}、跨房复用=${report.module.crossRoomReuse ? '开' : '关'}`);
    console.log(`  素材：${report.library.assets ?? '读不出来'}（已批准可见性 ${report.library.visibility.approved ?? '?'}、待审 ${report.library.visibility.review ?? '?'}、隔离 ${report.library.visibility.quarantined ?? '?'}）`);
    for (const target of report.targets) {
      console.log(`  ${target.kind} ${target.chatId}：可用素材 ${target.usableAssets}（作用域 ${target.usableScopes}）${target.reason ? `；原因码 ${target.reason}` : ''}`);
    }
    if (report.targets.length === 0) console.log('  （没有指定会话：用 --dm / --group 才会算可用素材）');
    console.log(`  最近一次候选：${report.lastCandidate === null ? '还没有调用过' : `${report.lastCandidate.reasonCode}（候选 ${report.lastCandidate.candidates} 个）`}`);
    console.log(`  最近一次发图：${report.lastReply === null ? '还没有调用过' : `${report.lastReply.reasonCode || 'ok'}；message_id=${report.lastReply.messageId ?? '（无回执 → 不算发过）'}`}`);
    console.log(`  采集计数：收到 ${report.ingest.observed} 条、入队 ${report.ingest.queued}、丢弃 ${report.ingest.dropped}`);
    console.log(`  结论：${verdictOf(report)}`);
  }
  service.close();
} catch (error) {
  console.error(`诊断失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
