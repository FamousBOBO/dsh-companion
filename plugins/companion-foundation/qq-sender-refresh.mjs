import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { upgradeLiveQqSender } from './qq-conversation.mjs?v=sender-rebind-20261101';
import { resolveDataRoot } from './suite-paths.mjs';

const moduleRoot = process.env.DSH_COMPANION_MODULE_ROOT;
if (!moduleRoot) throw new Error('DSH_COMPANION_MODULE_ROOT is not set; the QQ sender refresh needs the host module root.');
const { Service } = await import(pathToFileURL(path.join(moduleRoot, '@deepseek-ai/cordis/lib/index.js')).href);

// Diagnostics land in the suite data root (D2), never in the source checkout.
const dataRoot = resolveDataRoot({ moduleUrl: import.meta.url }).dataRoot;

function writeReport(payload) {
  try {
    const file = path.join(dataRoot, 'logs/qq-sender-refresh.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
  } catch { /* diagnostics never break a mount */ }
}

export default class QqSenderRefresh extends Service {
  static inject = ['tools', 'agents'];
  constructor(ctx) { super(ctx, 'companionQqSenderRefresh'); }
  *[Service.init]() {
    const root = this.ctx.root;
    const agents = this.ctx.agents;
    const refresh = agent => upgradeLiveQqSender(root, agent);
    const updated = [];
    for (const agent of agents.list()) if (refresh(agent)) updated.push(agent.id ?? agent.session?.id);
    this.ctx.on('agent/pre-step', async (event, next) => { refresh(event.agent); return next(); }, { prepend: true });
    writeReport({ at: new Date().toISOString(), updated, hookInstalled: true });
  }
}
