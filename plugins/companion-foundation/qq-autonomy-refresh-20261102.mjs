import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upgradeLiveQqSender } from './qq-conversation.mjs?v=sender-rebind-20261101';
import { resolveDataRoot } from './suite-paths.mjs';

// The policy text ships inside this package; the mount must not depend on where the
// repository sits, so it is resolved from this module's own directory.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const POLICY_FILE = path.join(MODULE_DIR, 'qq-autonomy-policy.txt');

// Diagnostics land in the suite data root (D2).
const dataRoot = resolveDataRoot({ moduleUrl: import.meta.url }).dataRoot;

export const name = 'companion-qq-sender-refresh';
export const inject = ['tools', 'agents'];

/** The owner's private QQ room id from the identity file ('' when it is not configured). */
function ownerRoomOf() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataRoot, 'home/companion/identity.json'), 'utf8'));
    const id = String(value?.owner?.id ?? '').trim();
    return id ? `qq-dm-${id}` : '';
  } catch { return ''; }
}

function writeReport(payload) {
  try {
    const file = path.join(dataRoot, 'logs/qq-sender-refresh.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
  } catch { /* diagnostics never break a mount */ }
}

export function apply(ctx) {
  const root = ctx.root;
  const agents = ctx.agents;
  const ownerRoom = ownerRoomOf();
  const mounted = new WeakSet();
  const refresh = agent => {
    const changed = upgradeLiveQqSender(root, agent);
    const sessionId = String(agent?.session?.id ?? agent?.id ?? '');
    if (ownerRoom && sessionId === ownerRoom && !mounted.has(agent)) {
      const prompt = agent.ctx?.systemPrompt ?? agent.ctx?.get?.('systemPrompt');
      if (!prompt?.section) throw Error('QQ autonomy: scoped system prompt unavailable');
      prompt.section({ name: 'companion:qq-autonomy-20261102', order: 145, interpolate: false,
        text: () => fs.readFileSync(POLICY_FILE, 'utf8') });
      mounted.add(agent);
      console.log('[qq-autonomy] policy mounted on the owner QQ session');
    }
    return changed;
  };
  const updated = [];
  for (const agent of agents.list()) if (refresh(agent)) updated.push(agent.id ?? agent.session?.id);
  ctx.on('agent/pre-step', async (event, next) => { refresh(event.agent); return next(); }, { prepend: true });
  writeReport({ at: new Date().toISOString(), ownerRoom: ownerRoom || null, updated, hookInstalled: true });
}
