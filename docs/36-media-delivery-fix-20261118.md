# 2026-11-18 媒体投递修复：生成物真的能到对方手里了

`docs/35-media-capability-audit-20261118.md` 查出三类断裂（生成可用、投递全断、跨通道误投）。
本文是修复记录。**结论：三个方向都打通了，用真实平台往返验证过，不是只看测试通过。**

---

## 一、修了什么

| 层 | 原来 | 现在 |
|---|---|---|
| 传输 `user-api.mjs` | `send()` 白名单只有 `text/plain` / `text/markdown` | 加 `uploadFile` / `sendFile` / `downloadFile`，走 `vocechat/file` |
| 传输 `port.mjs` | 端口只暴露 `send` | 三个媒体动词，目标仍是 `{channel}|{user}` |
| 适配 `index.mjs` | 只有 `vc_message` | 新增 `vc_send_file`；入站媒体落盘并给出本地路径 |
| 适配 `index.mjs` | vc 会话里 28 个 `qq_*` 工具可见 | `tools.restrict({deny})` 挡掉 10 个发送器 |
| media `service.mjs` | handoff 写死 `qq_sticker` / `qq_voice` | `handoffFor(kind, sessionId)` 按通道决定 |
| media `service.mjs` | 群聊判据只有 `qq-group-` | 加上 `vc-chan-`（同一条隐私规则的第二个漏洞） |
| 配置 | `refAudioPath` 指向不存在的 `C:\Users\bobo\Documents\Bot\dsh-production\…` | 指向真实路径 `D:/DSH/dsh-production/data/media/references/march7_B.wav` |

---

## 二、实测证据

### 2.1 图片：发得出去，而且客户端认得出是图片

第一次实测（mid=696）落库成了 `application/octet-stream` —— 图片在客户端变成一个
"要下载的附件"。原因不在上传字节，在 `prepare`：

```text
POST /api/resource/file/prepare  {}                             → 记录 octet-stream
POST /api/resource/file/prepare  {"content_type":"image/png"}   → 记录 image/png + 宽高
```

同一个 64×64 PNG 两版都试过。修掉之后：

```json
{"mid":714,"content_type":"image/png",
 "properties":"{\"height\":64,\"content_type\":\"image/png\",\"size\":179,\"width\":64}"}
```

宽高是平台自己解出来的，说明它真的当图片处理了。

### 2.2 语音：发得出去

```json
{"mid":715,"content_type":"audio/wav","properties":"{\"size\":195526,\"content_type\":\"audio/wav\"}"}
{"mid":712,"content_type":"audio/wav","properties":"{\"size\":130504,\"content_type\":\"audio/wav\"}"}
```

`sent-log` 里同时带上了媒体元数据（这是本轮新加的字段）：

```json
{"kind":"sent","mid":714,"ok":true,"media":{"kind":"image","mime":"image/png","bytes":179,"path":"…"}}
{"kind":"sent","mid":715,"ok":true,"media":{"kind":"audio","mime":"audio/wav","bytes":195526,"path":"…"}}
```

### 2.3 收图：不再是"自己翻文件系统"

主人发一张图（mid=700），适配层现在会先落盘再交付：

```text
D:\DSH\dsh-production\data\home\vocechat-adapter\inbox\mid-700.png   179 字节
```

模型收到的提示词里直接带着本机路径：

```text
【VoceChat 入站】私聊（对方 uid=1）
mid=700 from_uid=1 type=vocechat/file

2026/11/18/<uuid>
本地文件：D:\…\inbox\mid-700.png
（image，179 字节；直接用文件工具读这个路径，不要去平台目录里找）
```

回复从「收到一个文件，说是图片 / 但我点开一看就是个 1×1 的小点」变成
「一块纯粉色的方块，64×64 / 所以这算双向都通了？」——
它真的看到了图，而且只用了 1 次文件读取，不是 6 次 pwsh + 1 次 grep。

### 2.4 跨通道误投：堵住了

`vc-dm-1` 的 `request/header` 从 131 个工具 / 28 个 `qq_*` 变成 122 个 / 18 个：

```text
[vocechat-adapter] 已隔离 10 个跨通道发送工具（vc-dm-1）：qq_message,qq_file,qq_sticker,qq_voice,qq_music,qq_image…
```

且 `vc_send_file` 出现在工具表里：

```text
vc_*: vc_message,vc_send_file
```

留下的 18 个 `qq_*` 都是读/记类（`qq_lookup`、`qq_rss`、`qq_memory` 那些）——
它们在 VoceChat 里查资料是有意义的，挡掉的只有**发送**类。

---

## 三、设计取舍（都不是随手定的）

**为什么 `vc_send_file` 的路径要在白名单内。** 用 `realpath` 比较，不用字符串前缀：
`workspace/../secrets` 在字符串上通得过、在真实路径上不通。默认白名单只有会话工作区
（`cwd`）+ 配置里额外列的目录。不放行整个 `data/`：那里有凭据、会话日志、别人的附件，
把它们发给对话对象是不可撤销的泄漏，而"多发一个目录"只要改一行配置。

**为什么认不出 MIME 就拒绝。** 退回 `application/octet-stream` 会让一张图变成附件下载 ——
看起来像失败又不是失败。宁可明确报"认不出这个扩展名"。

**为什么上传与发送拆成两步。** 上传失败（太大/读不到）与发送失败（房间不对/权限）
是两种完全不同的故障；合成一个 `sendMedia(bytes)` 之后调用方只能看到一个笼统的失败。

**为什么入站落盘按 mid 命名。** SSE 断线重连会重投同一段帧；名字稳定才让重投命中同一个
文件，而不是在 inbox 里堆一串同样内容的副本。

**为什么隔离是"挡发送、不挡读取"。** `qq_lookup` / `qq_rss` / `qq_memory` 在 VoceChat 会话里
依然有用；挡掉的是那 10 个会把消息发到 QQ 窗口的工具。逐个数会漏（合并面 `qq_sticker`
与旧名 `qq_send_image` 会同时存在），所以按前缀匹配，名单从 `tools.view()` 现取而不是写死。

**为什么 `handoffFor` 对未知通道给 `null` 而不是猜。** 猜错的代价是发到别人的窗口里，
而"回报路径让调用方决定"只是少一个便利。

---

## 四、顺带修的两处

**TTS 参考音频路径失效。** 配置指向 `C:\Users\bobo\Documents\Bot\dsh-production\…`，
那个目录**根本不存在**（是一台旧机器 / 旧布局的残留），而真实文件在
`D:\DSH\dsh-production\data\media\references\march7_B.wav`（986 KB）。修之前每次
`companion_media_speak` 都是 `MEDIA_BAD_INPUT: 参考音频读不到 ENOENT`。

**`vc-chan-*` 不在多人在场判据里。** `isGroupSession()` 只看 `qq-group-`，于是
VoceChat 频道读得到私聊衣柜。同一个隐私规则的第二个漏洞，一起补上。
`handoff` 的通道判定也用同一套前缀，两处不会漂。

---

## 五、测试

| 套件 | 项数 | 结果 |
|---|---|---|
| `dsh-channel-vocechat` | 116 | 全通过 |
| `dsh-vocechat-adapter` | 175 | 全通过（新增 `media.test.mjs` 10 项） |
| `companion-media` | 177 | 全通过（新增 `handoff-channel.test.mjs` 4 项） |

`media.test.mjs` 每条钉一个具体坏结果，不是返回值：

- MIME 认不出必须返回 null（调用方要拒绝而不是硬发）
- `workspace/../secrets` 必须被拒绝（字符串前缀会放过它）
- 空文件、超限、目录、不存在：四种都必须明确拒绝
- 入站按 mid 命名 → 重投命中同一个文件
- 写入失败返回原因而不是抛（一张图取不到不该让整批文字发不出去）

`handoff-channel.test.mjs` 钉的是那次事故本身：vc 会话拿到 vc 工具、qq 会话行为逐字不变、
未知通道不给工具名。

---

## 六、改动清单

| 文件 | 性质 |
|---|---|
| `plugins/dsh-channel-vocechat/user-api.mjs` | `uploadFile` / `sendFile` / `downloadFile` + `raw` 逃生口 |
| `plugins/dsh-channel-vocechat/port.mjs` | 三个媒体动词进端口契约 |
| `plugins/dsh-vocechat-adapter/media.mjs` | 新增：MIME 判定、realpath 边界、读取、入站落盘 |
| `plugins/dsh-vocechat-adapter/index.mjs` | `vc_send_file`、入站媒体落盘、跨通道工具隔离、提示词更新 |
| `plugins/dsh-vocechat-adapter/sent-log.mjs` | 记媒体元数据 |
| `plugins/dsh-vocechat-adapter/cordis.patch.yml` | `media` 段默认值 |
| `plugins/companion-media/src/service.mjs` | `handoffFor()`、`isMultiPartySession()` |
| `plugins/companion-media/TOOL_GUIDE.md` | handoff 改成按通道读 |
| `test/media.test.mjs` / `test/handoff-channel.test.mjs` | 新增测试 |
| `data/media/config.json` | `refAudioPath` 修正（本地配置，不入库） |
| `data/home/profiles/companion/cordis.patch.yml` | `media` 段（本地配置，不入库） |
