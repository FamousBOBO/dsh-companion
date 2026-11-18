# `companionVoceChat` 端口契约

> 版本：`@dsh-companion/channel-vocechat` 0.1.0
> 这份文件是**适配层（`dsh-vocechat-adapter` / `companion-foundation`）对接的唯一依据**。
> 契约变了就是破坏性变更；只在插件里加东西不算。

---

## 1. 发布名与形态

```js
// 发布名
'companionVoceChat'

// 形态（与 health-service-ref / port-publish 同一套约定）
{ service, ready() }
```

**这是兄弟 cordis 行之间唯一的通道。** `ctx.get('companionVoceChat')` 从兄弟行看不到
（Cordis 把 `provide` 限定在提供者的子树里）——2026-11-04 的健康服务事故就是这一条。

三条路径的优先级见 `publish.mjs`；消费侧用
`companion-foundation/port-publish.mjs` 的 `resolveCompanionService`，传 `accept` 做形状校验：

```js
import { resolveCompanionService } from '../companion-foundation/port-publish.mjs'

const port = resolveCompanionService({
  name: 'companionVoceChat',
  root: dataRoot,   // 裸 dataRoot（.../data），不是 data/home，不是套件根
  context: () => ctx,
  accept: v => typeof v?.send === 'function' && typeof v?.subscribe === 'function',
})
```

### root 必须对齐

两侧拼出的 key 字符串必须**完全一致**，否则发布成功但没人读得到——静默失败。

| 侧 | 计算方式 | 本机取值 |
|---|---|---|
| 插件（发布） | `DSH_COMPANION_DATA_DIR` → 回落 `dirname(DSH_HOME)` | `D:\DSH\dsh-production\data` |
| 消费（解析） | `dirname(realpath(host.dshHome))` | `D:\DSH\dsh-production\data` |

运行时核对：`port.info().paths` 与 `describeKeys(root)` 都在 `diag/mount.json` 里留了记录。

---

## 2. `send(target, text, contentType?)`

**唯一的写入口。**

```js
await port.send({ channel: 1 }, '你好')
await port.send({ user: 1 }, '你好', 'text/markdown')
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `target` | `{channel: number}` \| `{user: number}` | **判别式对象，不是 `isGroup` 布尔**。id 是 1 基（gid 1 是第一个频道，uid 1 是第一个用户），0 被拒 |
| `text` | `string` | 原文。空白串被拒（`empty-text`） |
| `contentType` | `'text/plain'` \| `'text/markdown'` | 默认 `text/plain`。其他值本地拒（`unsupported-content-type`），不发请求 |

**返回** `Promise<{mid: number|null}>` —— 平台返回的消息 id；平台答 200 但无 body 时是 `null`。

### 为什么是对象不是布尔

QQ 侧是 `sendTo(isGroup, target)`，靠三元判断区分；把群号发进私聊是那一层的经典错误。
对象形式让两种情形在类型上不可混淆。

### 错误码（稳定，不用解析英文）

| code | 触发 | 该不该重试 |
|---|---|---|
| `not-configured` | baseUrl 或 key 未配置 | 否，配置问题 |
| `bad-target` | target 形状/取值不对 | 否，调用方 bug |
| `empty-text` | 文本空白 | 否，调用方 bug |
| `unsupported-content-type` | 非 plain/markdown | 否，调用方 bug |
| `unauthorized` | 401/403，key 失效 | 否，重试更糟 |
| `payload` | 400 | 否 |
| `too-large` | 413 | 否 |
| `rate-limited` | 429 | 是，退避 |
| `server` | 5xx | 是，退避 |
| `network` / `timeout` | 连接失败 / 超时 | 是 |

---

## 3. `subscribe(handler)`

**订阅回调，不是事件总线。**

```js
const off = port.subscribe(async event => { /* 驱动回合 */ })
off()   // 幂等
```

`event` 形状（`normalize.mjs` 产出）：

```ts
interface InboundEvent {
  mid: number                                  // 平台消息 id，也是幂等键
  fromUid: number
  target: { channel: number } | { user: number }
  content: string                              // 原文，最多 64 KiB
  contentType: string                          // 实测 'text/plain'；保留原值
  detailType: string                           // 实测 'normal'
  createdAt: number | null                     // 平台毫秒；坏值 → null，不伪造
  kind: string                                 // 实测 'chat'，原样保留
  receivedAt: number                           // 本地观测到的时间
}
```

### 调度语义（契约的一部分，不是实现细节）

| 行为 | 保证 |
|---|---|
| 顺序 | 按注册顺序**串行**调用，不并发 |
| 隔离 | 一个 handler 抛错**不影响**其余；错误进 `gap.jsonl` 的 `subscriber-failed` |
| 光标 | **所有** handler 都有机会之后才 `setCursor(mid)`；中途崩溃 → 下次启动重放该事件（at-least-once） |
| 时机 | 在 HTTP 200 **之后**才派发。平台不被回合循环拖住 |
| 重复 | `mid` 已在日志里的不会再派发（`claim` 挡住） |

**handler 必须幂等。**「至少一次」意味着崩溃前最后一次派发会重来。

---

## 4. `channels()`

`GET /api/bot` 的直传。返回该 Bot 所在频道的数组。非数组响应抛 `bad-response`
（不是返回 `[]`：`[]` 会让适配层以为「这个 Bot 不在任何频道」，而真相是「我们没看懂答案」）。

---

## 5. `status()`

一次无副作用的往返。**永不抛。**

```js
{ ok: true,  state: 'ok',        outbound: {...}, inbound: {...}, reasons: [], checkedAt }
{ ok: false, state: 'degraded',  ... reasons: ['outbound:network', 'webhook-not-listening'] }
{ ok: false, state: 'disabled',  ... reasons: ['disabled'] }
```

`ok` 要求**出站可达 且 入站正在监听且路径令牌存在**。只有一半算 `degraded` 并点名原因——
「绑了端口」不等于「平台配了回调」，这个探针不假装知道后者。

---

## 6. `info()`

运营事实。**不含凭据、不含正文、不含 webhook 路径。**

```js
{
  botUid, baseHost, keyed,          // keyed 是布尔，不是 key 本身
  webhook: { listening, bind, port, pathSet, maxBodyBytes, allowedSources, counters },
  subscribers, queueDepth, cursor, seen,
  paths: { events, gaps }           // 文件路径是运营信息
}
```

`pathSet` 是 `true/false`，**永远不是路径本身** —— webhook 令牌是凭据。

`counters` 字段：`probes / accepted / duplicates / rejectedToken / rejectedSource /
rejectedTooLarge / rejectedShape / persistFailures / gaps / startedAt`。

---

## 7. 明确**没有**的能力

不是遗漏，是平台不给：

| 能力 | 实测结果 |
|---|---|
| `getMessage(mid)` | Bot Key 读不到任何单条消息 |
| `getHistory(gid/uid)` | `/api/group/1/history` 401、`/api/user/1/history` 401、`/api/bot/history/*` 404 |
| `deleteMessage(mid)` | `DELETE /api/message/{mid}` 401 |
| `getUser(uid)` | `GET /api/user/{uid}` 401 |
| `getGroup(gid)` | `GET /api/group/{gid}` 401 |
| 富媒体发送 | 图片/文件/JSON 全 415，只有 plain 与 markdown |

写进契约只会让适配层误以为能用，然后失败在离家很远的地方。

**后果（适配层必须接受）**：

- 上下文只能来自 `events.jsonl` + DSH 会话历史，不能回查平台
- 发送者只能显示 `uid:<n>`，拿不到昵称与头像
- 发出后**无法更正**（平台不投递编辑/删除事件）

---

## 8. 与适配层的分工

| 能力 | 归属 |
|---|---|
| Bot API 客户端 / webhook server / 事件归一化 / 落盘 / 幂等 / 发布端口 / 健康探针 | **本插件** |
| 房间键 `vc-chan-*` `vc-dm-*` / 门控 / 会话创建恢复 / 回合驱动 / 取回复 / 发送决策 / 队列 / sent-log / 人格 / 工具面 | **陪伴插件** |

判据一句话：**插件回答「VoceChat 能做什么」，陪伴插件回答「我们用它做什么」。**

---

## 9. 安装这一行需要的改动

跨插件点只有一处 —— `plugins/companion-foundation/service-bridge.mjs` 的 `names` 白名单：

```js
const names = new Set([
  'companionAgenda',
  'companionContactShare',
  'companionGroupMemory',
  'companionGroupPersona',
  'companionHealth',
  'companionVoceChat',   // ← 新增
]);
```

不改它，**第三条通道（service bridge）** 会抛 `invalid-companion-port`。
process registry 那两条照常工作，但既然三条要一致，就一起补。
