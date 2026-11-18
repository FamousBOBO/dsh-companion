# 2026-11-18 VoceChat 能收不能发：refresh_token 单链轮换的缓存陷阱

一次完整的故障修复记录：**出站认证死掉导致回复全部停在本地**，根因是插件把单链轮换的
refresh_token 缓存在内存里；修法是「被拒就重读权威源再试一次」，不是「失效就重新登录」。
同轮还补上了 VoceChat 会话在侧栏里的标题与工作区归属，让它和 QQ 通道长得一样。

证据级别：本机部署 + 真实回合 + 真实平台 API 验证（见第四节「实测证据」）。

---

## 一、故障现象

主人连发几条私聊，`data/home/vocechat-adapter/sent-log.jsonl` 里连续 8 条出站失败：

```json
{"at":1794982457790,"kind":"sent","room":"vc-dm-1","target":{"user":1},"mid":null,
 "phase":"final","ok":false,"chars":1,"preview":"？","error":"续期失败 401"}
{"at":1794982493664,"kind":"sent","room":"vc-dm-1","target":{"user":1},"mid":null,
 "phase":"final","ok":false,"chars":17,"preview":"这边好像发不出去了，你等一下我看看","error":"续期失败 401"}
```

同时期宿主的 SSE 日志只有这四个字母，查不出原因：

```text
[channel-vocechat] [vocechat-sse] threw → retry in 30s
[channel-vocechat] [vocechat-sse] threw → retry in 30s
```

关键判据：**入站是好的**。`events.jsonl` 里有新事件、`vc-dm-1` 会话正常起回合、
`回合收尾 … calledTool=true committed=true`。坏的只有出站 —— 模型说了话，`vc_message`
也被调用了，但那条 HTTP 发不出去。

---

## 二、根因

VoceChat 的 refresh_token 是**单链轮换**：每次 `POST /api/token/renew` 都返回新的一代，
并把新值写回数据库的 `refresh_token` 表（唯一键 `(uid, device)`）。

实测（真实 0.5.40，非模拟）：

| 试法 | 结果 |
|---|---|
| 库里的根 → renew | 200（得到 gen1） |
| gen1 → renew | 200（得到 gen2） |
| gen2 → renew | 200（得到 gen3） |
| **再用 gen2** | **200**（上一代还在宽限期） |
| **再用 gen1** | **401**（两代以前立即失效） |
| 之后再拿库里的根 | 401 |

也就是说：**链只能往后走，往前两代就死。**

而插件的行为是「首次读源、之后用内存缓存」：

```js
// auth.mjs（修复前）
async function loadRefreshToken() {
  if (refreshToken) return refreshToken;   // ← 一旦有缓存就永不再读源
  ...
}
```

`persistRefreshToken()` 只在配了 `credentialFile` 时才回写，而这个部署的 `credentialFile`
是空的（权威在数据库），所以轮换出来的新值连盘都没落。

于是只要有**任何第三方**把同一条链往前推两代 —— 验证脚本、`/api/token/renew` 的手工探测、
手机重新登录 —— 插件缓存的那份就永久 401。它还会一直重试，但每次发的都是同一个死值。

这不是理论风险：`docs/06-troubleshooting.md` 记的 2026-11-17 事故，是同一个机制把主人手机
挤下线。区别只是那次受害者是手机，这次是插件自己。

---

## 三、修法

**不重新登录。** 拿任何其他 uid=4 的行去 renew 会把那个客户端挤掉（11-17 事故的成因）。
数据库里 `device='dsh-companion'` 那一行才是本插件自己的权威值，重新读一次就拿到当前有效的一代。

`plugins/dsh-channel-vocechat/auth.mjs`：

- `renewAttempt(fromSource)` —— 一次续期尝试，`fromSource` 仅用于日志区分第几次。
- `renewOnce()` —— 只在 `AuthError.code === 'refresh-token-rejected'` 且配了源时：
  清空缓存 → 重读 `credentialFile` / `dbFile` → `renewAttempt(true)`。
- **只重试一次。** 网络错误和 5xx 重读源没有意义；无限重试会把一次明确的失败变成一把锁。
- `stats.sourceReloads` 计数，让「重读了几次」可观测。

`plugins/dsh-channel-vocechat/sse.mjs`：把裸的 `threw` 换成带原因的日志。原来 401 / 网络断开 /
续期失败在日志里长得一模一样，这次故障就是被那四个字母盖住的。

---

## 四、实测证据

### 4.1 重读路径确实被走到

故意用外部脚本把 `dsh-companion` 这条链推两代，再把 access token 放到过期，然后发一条私聊：

```text
[channel-vocechat] [vocechat-auth] 缓存的 refresh_token 被拒（401）→ 重新读源后再试一次
[channel-vocechat] [vocechat-auth] 用刚读到的 refresh_token 重试续期
[channel-vocechat] [vocechat-auth] renewed (expired_in=300s, valid until 2026-11-18T07:29:03.727Z)
```

自动恢复，无需人工干预，无需重启宿主。

### 4.2 出站恢复后积压的回复全部补发

```json
{"room":"vc-dm-1","mid":610,"ok":true,"preview":"收到啦～"}
{"room":"vc-dm-1","mid":611,"ok":true,"preview":"刚才那一小时我这边发送失败，一直提示 401，不是你那边的问题"}
{"room":"vc-dm-1","mid":624,"ok":true,"preview":"你要再测一轮的话，我还能当一次仪表盘"}
{"room":"vc-dm-1","mid":628,"ok":true,"preview":"所以应该没问题喽"}
```

### 4.3 测试

`plugins/dsh-channel-vocechat/test/auth-reload.test.mjs`（新增 3 条）用一个**按真实单链语义**
工作的假服务器：只接受最新一代和它上一代，任何更旧的返回 401。

- 缓存被拒 → 重读库 → 第二次尝试用的是库里的值 → 成功，`sourceReloads === 1`；
- 库里那一行也死了 → 只发**两次**请求就抛 `refresh-token-rejected`，不循环；
- 没配源时 401 立即报出，不假装能重试。

---

## 五、顺带修好：侧栏里「没有会话窗口」

主人问的是「为什么 VoceChat 没有像 QQ 那样的会话窗口」。机制其实一样（房间键 → DSH 会话：
`vc-dm-<uid>` / `vc-chan-<gid>`，QQ 是 `qq-dm-<号>`），差的是两件**显示层**的事：

| | QQ 通道 | VoceChat 适配层（修复前） |
|---|---|---|
| 会话标题 | 建会话时写 `QQ 私聊1429709395` | 不写 → 侧栏只显示内部键 `vc-dm-1` |
| 工作区归属 | `reattachAll()` 启动时把 `qq-*` 挂回工作区 | 不挂 → 只能落到「未分组」 |

补法：

- `plugins/dsh-vocechat-adapter/workspace.mjs`（新增）：`listStoredSessions()` 扫
  `<home>/sessions/*/vc-*`；`attachToWorkspace()` 调
  `workspaceRegistry.create(cwd).attachSession(id)`。**永不抛** —— 归属失败只影响分组。
- `sessions.mjs`：`nameIt()` **只在会话还没有标题时**写（判据 `titles.get(session) === undefined`）。
  不用「与目标不同就改名」，因为 `vc-chan-1` 上那个「VoceChat 生产入站验证」是人工起的，
  比大小会把它盖掉，而且每来一条消息都可能重写。
- `index.mjs`：`inject` 加 `sessionTitle`、`workspaceRegistry`；启动时扫一遍已落盘会话
  （对齐 QQ 的 `reattachAll`，否则没发过消息的旧会话永远是孤儿）。

实测：

```text
[vocechat-adapter] 工作区归属：2/2 个 vc 会话已登记

工作区 三月七陪伴 → vc-dm-1, vc-chan-1, qq-dm-1429709395

vc-dm-1.json    VoceChat 私聊1
vc-chan-1.json  VoceChat 生产入站验证   ← 人工标题，未被覆盖
qq-dm-1429709395.json  QQ 私聊1429709395
```

**为什么 reply 一定要走 `vc_message`：** 适配层不代发（`index.mjs` 顶部的「不代发」纪律）。
模型答在本地时，`turn-stopping` / `agent/status:idle` 会注入一次纠正；再不调用就记
`undelivered`。「没反应」必须能在 `sent-log.jsonl` 里查到，不能是沉默。

---

## 六、踩过的坑（留给下次）

- **不要**用「清缓存再重试」当万能修法：数据库只被服务端更新，反复重读当前行是安全的
  （对同一行重复 renew 都返回 200），但**网络错误时重读毫无意义**，所以要按错误码分支。
- **不要**为了修复去拿另一台设备的 refresh_token：那会把那台设备挤下线。
- `node:sqlite` 的 SQL 字符串里表名/列名不要用双引号：`type="table"` 会变成
  `no such column: "table"`。
- 容器日志按 `Substring(0, 160)` 截断时先判 `Length`，ANSI 去色后的短行会抛
  `Index and length must refer to a location within the string`。
- 生产宿主的调试 RPC 端点不叫 `sessions.list`；`/api/<method>` 一律 404 时先确认方法名，
  别把它当成认证失败。

---

## 七、改动清单

| 文件 | 性质 |
|---|---|
| `plugins/dsh-channel-vocechat/auth.mjs` | 401 时重读源再试一次（`renewOnce` / `renewAttempt`） |
| `plugins/dsh-channel-vocechat/sse.mjs` | `threw` 带出真实原因 |
| `plugins/dsh-channel-vocechat/test/auth-reload.test.mjs` | 新增：单链语义下的重读与不循环 |
| `plugins/dsh-vocechat-adapter/workspace.mjs` | 新增：会话 ↔ 工作区归属 |
| `plugins/dsh-vocechat-adapter/sessions.mjs` | 补标题（只补空缺）、补归属（每会话每进程一次） |
| `plugins/dsh-vocechat-adapter/index.mjs` | 注入两个显示层服务、启动扫盘登记 |
| `plugins/dsh-vocechat-adapter/test/title.test.mjs` | 新增：不覆盖人工标题、失败不挡回合 |
| `plugins/dsh-vocechat-adapter/test/workspace.test.mjs` | 新增：命名空间隔离、realpath 不一致只报告 |

测试：`channel-vocechat` 116 项、`vocechat-adapter` 135 项，全部通过。
