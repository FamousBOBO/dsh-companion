# 2026-11-18 媒体能力检查（VoceChat 通道）

检查范围：生图、语音、识图、图片/文件收发，以及它们在 VoceChat 通道上是否**真的能到达对方**。
方法：读代码 + 查运行期配置与后端可达性 + **真实平台往返**（不是只看测试通过）。

结论一句话：**生成能力是好的，投递能力是错的。** 三个 provider 全部就绪，但 VoceChat 通道上
没有任何一条能把生成物发出去的路；模型手里拿着的是 QQ 的发送工具。

---

## 一、能力矩阵

| 能力 | 生成 | 投递到 VoceChat | 说明 |
|---|---|---|---|
| 生图（NovelAI） | ✅ `test-ok` | ❌ | 输出文件有了，但唯一可用的发送工具是 `qq_sticker` |
| 语音（Breeze TTS 2） | ✅ `test-ok` | ❌ | 同上，`qq_voice` |
| 识图（vision） | ⛔ 合同锁定 | — | `status: reserved-disabled`，`locked: true`，没有工具也没有接口 |
| 收图 | ⚠️ 能收到元数据 | — | 图片正文进不了模型，只有一串路径 |
| 发图 / 发文件 | ✅ 平台支持 | ❌ 传输层白名单挡着 | `send()` 只接受 `text/plain` / `text/markdown` |

---

## 二、生成侧：三项检查，两项可用

`GET /api/companion-media/status` 的实际返回：

```text
image  enabled=true  provider=nai
  openai-compatible: unconfigured (missing baseUrl/apiKey/model)
  nai:               test-ok  key=config  endpoint=official: POST {baseUrl}/ai/generate-image
tts    enabled=true  provider=breeze-tts2
  breeze-tts2:       test-ok  (GET /health 成功)
  gpt-sovits / drama3 / fish-audio: unconfigured
  index-tts:         not-connected（许可与接口契约都不可核实，已明确不实现）
vision status=reserved-disabled  locked=true
```

后端依赖逐个落地：

```text
C:/Python314/python.exe                                            存在
C:/Users/bobo/Documents/Bot/astrbot/.../image_pipeline              存在
C:/Users/bobo/Documents/Bot/runtime/gpu_model_gateway.py            存在
C:/Users/bobo/Documents/Bot/breeze-tts2/march7-emotion-presets.json 存在
```

作业账本（`data/home/media/state/ledger.json`）62 条、57 个产物：

```text
image:succeeded   43      speech:succeeded  14
image:failed       0      speech:failed      3
vision:succeeded   1      vision:failed      1
```

最近一次生图 `2026-11-17T18:50:36Z`，`nai-diffusion-5-full`，1,419,618 字节，13.8 秒。
分辨率预览也正常：`832x1216`，`pixels=1011712`，`multipleOf=64`。

**生成侧没有问题。**

不过有一处状态与实现对不上，值得记一笔：`data/home/media/config.json` 里
`"delivery": {"mode": "mock", ...}`，但 `delivery` 这个词在 `plugins/companion-media`
的代码里**一次都没被读过**（`config.delivery` 零命中）。这是个死键 —— 它看起来像一个
"投递模式开关"，实际上不控制任何东西。

---

## 三、投递侧：三个断点，这是真问题

### 3.1 `handoff` 硬编码了 QQ 工具

`src/service.mjs` 生成成功后返回的投递指令是写死的：

```js
handoff: {
  tool: 'qq_sticker', action: 'send_image', file: artifact.absolutePath,
  mustSend: `调用 qq_sticker action=send_image 并传 file=${artifact.absolutePath}`,
}
// 语音同理：tool: 'qq_voice', action: 'send_file'
```

它**完全不区分当前是哪个通道**（`vocechat` / `vc_` / `channel` 在 media 插件里零命中）。
在 VoceChat 会话里，模型照着这条指令就会去调 QQ 的工具。

### 3.2 QQ 工具在 VoceChat 会话里可见 —— 而且真的会发到 QQ

从 `vc-dm-1` 的会话日志里取出最后一次 `request/header`，工具总数 131：

```text
qq_*            28 个（qq_sticker, qq_voice, qq_image, qq_file, qq_message …）
vc_*             1 个（vc_message）
companion_media* 5 个（draw / speak / visual / status / job）
```

`qq_sticker action=send_image` 的参数是 `isGroup` + `target` + `file`，而
`assertTargetAllowed()` 对私聊只放行 `config.admins[0]`：

```ts
const master = config.admins[0]   // → 1429709395
if (master !== undefined && Number(args.target) !== master && !config.admins.includes(...)) throw
```

也就是说：**在 VoceChat 私聊里画一张图，模型"正确地"调用 `qq_sticker`，图会被发到
主人 QQ 的 1429709395 私聊**，VoceChat 这边什么都没有。这是一个跨通道误投，不是"发不出去"——
更糟，因为它是静默成功的。

### 3.3 传输层白名单把媒体挡在门外

`plugins/dsh-channel-vocechat/user-api.mjs`：

```js
const ACCEPTED = new Set(['text/plain', 'text/markdown']);
if (!ACCEPTED.has(contentType)) {
  throw new VoceChatApiError('unsupported-content-type', '只接受 text/plain 与 text/markdown，…')
}
```

`vc_message` 的参数也只有 `action` / `text` / `phase`，没有文件通道。

---

## 四、但平台本身完全支持 —— 已实测打通

这点必须查清，否则"加投递"就变成了猜。直接对 0.5.40 打：

### 4.1 上传契约（三步）

```text
POST /api/resource/file/prepare        body {} 或 {"content_type":"image/png"}
  → 200 "<file_id>"（纯 UUID 字符串，不是 JSON 对象）

POST /api/resource/file/upload         multipart/form-data
  chunk_data    = 文件字节（必填，缺了报 field `chunk_data` is required）
  chunk_is_last = "true"
  file_id       = 上一步的 UUID  ← **必须在表单里，放 query 会 400**
  → 200 {"hash":"…","image_properties":{"height":1,"width":1},"path":"2026/11/18/<uuid>","size":70}
```

踩过的坑，逐条都是实测：

- `content-type: image/png` 直接 POST 字节 → `415`（不接受裸字节）
- `file_id` 放 query string → `400`（空 body，无提示）
- `file` 字段名 → `400 parse multipart error: field chunk_data is required`
- `prepare` 不带 `content-type` 头 → `400 the client request does not include the Content-Type header`

### 4.2 发消息契约

```text
POST /api/user/{uid}/send     content-type: vocechat/file     body: {"path":"2026/11/18/<uuid>"}
  → 200 <mid>
```

图片走这条路进 `files` 表：

```json
{"mid":689,"from_uid":4,"gid":-1,"content_type":"image/png",
 "content":"2026/11/18/d26feac8-…","properties":{"content_type":"image/png","width":1,"height":1,"size":70}}
```

音频同样可行（实测 `audio/wav`，`{"content_type":"audio/wav","size":44}`）。

顺带确认：`image/png` 当 `content-type` 直接发是 **415**，`text/markdown` 里塞
`![](...)` 只会变成一段带链接的文本 —— 客户端不把它当图片。唯一正确形态是
`vocechat/file` + `{"path": …}`。

### 4.3 文件下载

```text
GET /api/resource/file?file_path=<urlencoded path>   → 200 <原始字节>
GET /api/resource/file?path=<…>                      → 400 failed to parse parameter `file_path`
```

参数名是 `file_path`，不是 `path`。

---

## 五、收图：能收到，但模型只拿到一串路径

主人从 uid=1 发一张图（mid=690）后，落到模型眼前的是这样一条**纯文本**：

```text
【VoceChat 入站】私聊（对方 uid=1）
mid=690 from_uid=1 type=vocechat/file

2026/11/18/cc108f6f-9af5-427b-9a2f-50e6d0505148
```

模型没有图像输入，只能自己去找。实际那一轮它调了 **6 次 `pwsh` + 1 次 `grep`**，
最后才在 `D:\DSH\vocechat\vocechat-data\upload\file\2026\11\18\` 找到 70 字节的文件，
回复是「收到一个文件，说是图片 / 但我点开一看就是个 1×1 的小点，70 字节… / 你这是在测我能不能收图吧」。

也就是说：

- 收图**是通的**（事件、落盘、回合都对）
- 但识别靠"翻文件系统"，不是靠能力
- `vision` 模块是**合同锁定**的：`status: reserved-disabled`、`locked: true`，
  `vision.mjs` 里没有任何网络代码，每个入口都返回同一句拒绝

文件在磁盘上的位置是确定的：`<vocechat-data>/upload/file/<content 字段>`，
旁边有 `<uuid>.meta`（`{"content_type":"image/png","filename":null}`）。
这条映射关系稳定，可以直接用，不需要猜。

---

## 六、要补什么（按优先级）

1. **把 handoff 变成通道感知的。** `companion-media` 现在不知道自己在哪个通道；
   最小改法是让它接受调用方的通道标识，返回 `handoff.channel` 与对应的工具名，
   VoceChat 会话就指向新的 `vc_send_file` 而不是 `qq_sticker`。
2. **给 VoceChat 加一个媒体发送工具。** 传输层 `send()` 的白名单要放开到
   `vocechat/file`，锚点是上面实测出的 prepare → upload → send 三步；
   路径边界沿用 media 已有的 `channelBoundary`（`<dataRoot>/workspace` 之内）。
3. **隔离夸通道工具。** `vc-*` 会话里看得见 28 个 `qq_*` 工具是上面那次误投的根因。
   QQ 通道已经有一套 `tool-visibility` 探测（`src/adapters/dsh-host/tool-visibility.ts`），
   同样的问题在 VoceChat 侧没有对应机制。
4. **收图要么明确"不支持"，要么接进模型。** 现在这种"给个路径让它自己翻"的行为
   每次都花掉 6–10 个工具调用，而且结论依赖它有没有猜对目录。
   本地视觉后端（`nsfwvision-v3:q5`）的配置指向 `127.0.0.1:8139/ollama/v1`，
   实测该模型**未安装**（`model 'nsfwvision-v3:q5' not found`，`/ollama/api/tags` 返回空列表），
   所以即便放开合同也暂时没有可用的识别后端。
5. **`delivery.mode: "mock"` 这个死键要么接上要么删掉。** 它现在只制造误解。

---

## 七、这次检查**没有**改动任何代码

只做读取与真实往返验证。上面第 4.1 / 4.2 节产生的 5 条测试消息
（mid 684–689、694）都是发往主人自己的 uid=1 私聊，内容是一个 1×1 PNG 和一个 44 字节 WAV。
