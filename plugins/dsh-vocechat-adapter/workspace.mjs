// 会话的「归属」：这条 vc 会话属于哪个工作区。
//
// 为什么必须有这一层（2026-11-18，对照 QQ 通道实测）：
//
//   QQ 那条通道做了两件本层原来没做的事 —— 建会话时写标题（`QQ 私聊1429709395`），
//   以及把会话**挂进工作区**（`reattachAll()` 每次启动扫一遍 `qq-*` 再 `attachSession`）。
//   缺了第二件的直接后果：`vc-dm-1` / `vc-chan-1` 不属于任何工作区，侧栏里只能落到
//   「未分组」，而且只显示内部键，看上去像"没有会话窗口"。工作区归属是持久化的显示结构，
//   不是聊天能力，所以补它不会改变任何消息路径。
//
// 两条实测约束：
//
//   1. `attachSession` 会拿会话头里的 `cwd` 与工作区路径做 **realpath 比较**，不一致就抛。
//      所以只能挂到 `cwd` 对应的那个工作区 —— 不能随便挑一个"更好看的"分组。
//   2. 重复挂载不报错（内部按 `sessionIds.includes` 短路），但 `workspaces.create()` 对已存在
//      目录是复用的，所以这条路可以每次启动都走一遍。

import fs from 'node:fs';
import path from 'node:path';

// 与 `room.mjs` 同一个形状。这里不 import 它，是为了让归属层能独立重放（room.mjs 是纯函数，
// 但归属只需要"这是不是我的房间"这一个判断，重复一个正则比耦合两个模块更省事）。
const ROOM_PATTERN = /^vc-(?:([a-z0-9-]{1,16})-)?(chan|dm)-(\d+)$/;

/** 会话 id 是不是本通道的（带命名空间时**只认自己的**命名空间）。 */
function isOurs(name, namespace) {
  const match = ROOM_PATTERN.exec(String(name ?? ''));
  if (!match) return false;
  const ns = String(namespace ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16);
  return (match[1] ?? '') === ns;
}

/**
 * 已落盘的 vc 会话 id 列表。
 *
 * 目录形状由宿主决定：`<home>/sessions/<project-dir>/<sessionId>/`。这里只认目录名，
 * 不读会话内容 —— 归属只需要 id。
 */
export function listStoredSessions({ homeDir, namespace = '' } = {}) {
  const root = path.join(String(homeDir ?? ''), 'sessions');
  const found = [];
  let projects = [];
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { return found; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(root, project.name);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory() && isOurs(entry.name, namespace)) found.push(entry.name);
    }
  }
  return found;
}

/**
 * 把一条会话挂到 `cwd` 对应的工作区。
 *
 * 绝不抛：归属失败只意味着侧栏分组不对，消息该照发。返回 `{attached, reason}` 供日志使用。
 *
 * @param {object} input
 * @param {object|null} input.registry `ctx.workspaceRegistry`（可缺席）
 * @param {string} input.cwd          工作区目录，必须与会话头里的 cwd 是同一个
 * @param {string} input.sessionId
 */
export async function attachToWorkspace({ registry, cwd, sessionId, log = null } = {}) {
  const say = line => { if (typeof log === 'function') { try { log(line); } catch { /* */ } } };
  if (!registry || typeof registry.create !== 'function') return { attached: false, reason: 'no-registry' };
  const dir = String(cwd ?? '').trim();
  const id = String(sessionId ?? '').trim();
  if (!dir || !id) return { attached: false, reason: 'missing-input' };
  try {
    const workspace = await registry.create(dir);
    if (workspace && typeof workspace.attachSession === 'function') await workspace.attachSession(id);
    return { attached: true, reason: 'ok' };
  } catch (error) {
    const text = String(error?.message ?? error);
    // 「已经在里面」不是失败：`attachSession` 本身幂等，抛这个只可能来自别处的重复登记。
    if (/already exists/i.test(text)) return { attached: true, reason: 'already' };
    say(`挂工作区失败 ${id}：${text.slice(0, 160)}`);
    return { attached: false, reason: text.slice(0, 160) };
  }
}
