// 路由修正：让本通道的会话用**工作区守卫最终会用的那条路由**。
//
// 为什么需要这一步（2026-11-17 实测，`vc-chan-1` 会话第 2 轮）：
//
//   1. 我们按 `opencode-go/deepseek-v4.1-flash` 建会话 → 步准备把这一对固定下来。
//   2. 同一进程里的 `companion-foundation/workspace-context.mjs` 在 `agent/request` 瀑布里
//      按工作区把 provider 改成别名（本机是 `opencode-go-companion-256k`，256k 窗口）。
//   3. 宿主发现"步准备已固定 `opencode-go`，瀑布却提议别名"→ 直接判本轮失败：
//
//      agent "vc-chan-1": agent/request proposed "opencode-go-companion-256k/deepseek-v4.1-flash"
//      after step preparation fixed "opencode-go/deepseek-v4.1-flash"; use agent.model.select()
//
// 宿主给出的解法就是 `agent.model.select()`：**记录的选择优先于 AgentOptions**，所以只要我们在
// 交付消息之前把选择记成"瀑布最终会用的那一条"，两边就相等，冲突消失。
//
// 这里不猜别名，也不复制守卫的实现：守卫的映射写在一份有文档的配置里
// （`<dataRoot>/home/companion/workspace-context.json`），本模块照那份配置算出"我们这条 cwd
// 最终会是哪个 provider"。文件不存在或 `enabled:false` 时，映射恒等，什么也不改。
//
// 这条依赖是**显式的**：读的是配置数据，不是内部符号；守卫改语义时它会一起失效并在测试里被发现。

import fs from 'node:fs';
import path from 'node:path';

const CONFIG_RELATIVE = 'home/companion/workspace-context.json';

/** Same normalisation the guard uses, so two spellings of one directory compare equal. */
function normalized(value) {
  const text = String(value ?? '').trim();
  if (text === '') return '';
  let resolved = text;
  try { resolved = fs.realpathSync.native(text); } catch { /* not on disk yet */ }
  return path.win32.normalize(resolved).replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * Read the workspace guard's mapping. Missing/unreadable/disabled → `null` (identity mapping).
 *
 * @param {string} dataRoot suite data root (`.../data`)
 * @returns {{sourceProvider: string, aliasProvider: string, workspace: string}|null}
 */
export function readWorkspaceGuard(dataRoot) {
  const root = String(dataRoot ?? '').trim();
  if (!root) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(root, CONFIG_RELATIVE), 'utf8'));
  } catch {
    return null;
  }
  if (raw?.enabled !== true) return null;
  const source = String(raw?.sourceProvider ?? '').trim();
  const alias = String(raw?.aliasProvider ?? '').trim();
  if (!source || !alias || source === alias) return null;
  const workspace = String(raw?.workspace ?? '').trim();
  return {
    sourceProvider: source,
    aliasProvider: alias,
    // An empty workspace means the guard falls back to the suite's own workspace; we cannot
    // resolve that here, so treat "empty" as "no mapping" rather than guessing.
    workspace: workspace === '' ? '' : path.isAbsolute(workspace) ? workspace : path.resolve(root, workspace),
  };
}

/**
 * The provider our session will actually run under.
 *
 * Mirrors `workspaceRoute`: only the guard's own provider pair is rewritten, and only for the
 * guarded workspace. Everything else passes through untouched.
 *
 * @param {{provider: string, model: string}} route
 * @param {string} cwd
 * @param {object|null} guard result of `readWorkspaceGuard`
 */
export function effectiveRoute(route, cwd, guard) {
  if (!guard) return route;
  const provider = String(route?.provider ?? '').trim();
  if (provider !== guard.sourceProvider && provider !== guard.aliasProvider) return route;
  if (guard.workspace === '' || normalized(cwd) === '' || normalized(cwd) !== normalized(guard.workspace)) {
    return route;
  }
  return { ...route, provider: guard.aliasProvider };
}

export { CONFIG_RELATIVE };
