# 2026-11-18 生图链路：名字缺失、桌面端显示与媒体类型

三件事、三个根因，都在同一条「生成 → 投递 → 渲染」链路上。本文只写查证过程与修法，
不重复 `docs/35`（能力盘点）和 `docs/36`（投递打通）里已经记过的东西。

---

## 一、生图 prompt 里没有角色名字

### 现象

`companion_media_visual` 正确返回了身份：

```json
{"identity":"configured","name":"三月七",
 "identityClause":"March 7th from Honkai: Star Rail (Astral Express), shoulder-length pink hair, blue-to-pink gradient eyes, fair skin, slender build, a small camera often hanging around her neck"}
```

模型随后提交的 `prompt` 长 1153 字符，**名字出现 0 次**：

```text
A young woman with shoulder-length pink hair and blue-to-pink gradient eyes sits cross-legged
on the floor of a small warm train cabin at night, a photo album open across her knees. …
```

外观写得一丝不差，但"粉色短发 + 渐变眼睛 + 小相机"可以指向很多人。生成结果是一个
**像她的人**，不是她。而 `visual → draw → send` 每一步都返回 `ok:true`。

### 为什么之前没拦住

`companionPictureGate()` 只校验「身份数据可读 + 有英文外观描述」。它检查的是**驱动器**，
不是**产出**：模型读到了身份、也写足了外观，gate 就放行，至于正文里有没有把"这是谁"
写出来，从来没查过。

### 修法：补主体锚，而不是拒绝

在 `subject=companion` 分支里，组装 prompt 之后检查名字是否出现；没出现就补在最前面：

```text
March 7th from Honkai: Star Rail (Astral Express), A young woman with shoulder-length pink hair…
```

四个刻意的取舍：

| 取舍 | 理由 |
|---|---|
| **补，不拒** | 拒掉要多烧一轮模型往返；而名字只是主体指代，不含姿势/视角/衣物，不可能与构图冲突 |
| **补在最前面** | NAI 对前半段权重更高；主体指代本来就该在最前 |
| **只补名字 + 出处** | TOOL_GUIDE 与 gate 都写明"身份是参考事实，不是固定后缀"，整串追加会和模型自己的构图打架 |
| **回 `injectedName`** | 让调用方看得见自己漏了什么；`dryRun` 也回，所以「这次会不会靠系统补」可以先查 |

判定用的比较是**小写 + 去掉所有非字母数字**，于是 `March 7th` / `march7th` / `March7`
都算写过。严格相等会把"模型写了 march7th"误判成没写，那种误判比漏判更烦人。
名字短于 3 字符时不做子串匹配（`ai` 这种在任意英文句子里都会出现，等价于没检查）。

**只有中文名时不补。** `requireEnglish` 会逐字符检查正文，把 `三月七` 拼进去会让一次
本来完全正确的调用因为"系统补了个中文"而失败 —— 那种失败比缺名字更难查。这种情况改为
在响应里回 `nameWarning`，说明缺的是 `name.en`。

### 实测

同一句「画一张你自己，坐在窗边看书」，修完之后模型仍然没写名字（`/Testa|三月七|march7/`
在 prompt 里不匹配），但落库的 `input` 是：

```text
March 7th from Honkai: Star Rail (Astral Express), A young woman with shoulder-length pink hair…
```

`injectedName: "March 7th from Honkai: Star Rail (Astral Express)"`，`nameWarning: undefined`。

---

## 二、桌面端（exe / 网页）看不到图片

### 现象

同一张图：手机端正常显示，桌面端是**空气泡**（只有头像和时间，正文一个字都没有）。

### 排查到两个独立的原因

**原因 1：`properties.name` 缺失（决定"有没有气泡"）。**

网页端的文件气泡组件第一句就是：

```js
if (!content || !name) return null;   // name 来自 properties.name
```

`prepare` 时只传 `{content_type:"image/png"}` 不会写 `properties.name`，于是 web 端
`return null` —— 整条消息渲染成空白。手机端不校验 `name`，所以一直正常。

实测：在 `prepare` 里加 `filename` 之后，落库变成

```json
{"name":"vc-media-check.png","content_type":"image/png","width":832,"height":1216,"size":…}
```

传 `{name:…}` 没用，只有 `filename` 会写进 `properties.name`。

**原因 2：缩略图长边只有 480px（决定"清不清楚"）。**

桌面端**不加载原图**，加载的是 `?thumbnail=true` 那张。服务端把长边固定压到 480，
而气泡按 `min:200, max:480` 的盒子去撑满宽度，高 DPI 屏还要乘 `devicePixelRatio`。
用 headless Chrome 量出来的真实数字（`--force-device-scale-factor=2`）：

```json
{"dpr":2,"fileImgs":[{"thumb":true,"natural":"328x480","client":"328x480"}]}
```

一张 832×1216 的图，在 2× 屏上被 328×480 的位图撑满 —— 不放大就是糊的。
点开预览走的是 `data-origin`（原图），所以放大是清楚的。

### 修法

`properties.name`：`prepare` 的 body 带上 `filename`（`user-api.mjs` 的 `uploadFile`）。

缩略图：新增 `thumbnail.mjs#upgradeThumbnail()`，在**发送之前**用 ffmpeg 重做一张长边
1080 的 JPEG，覆盖服务端那份，并把 `.meta` 改成 `image/jpeg`（服务端照 meta 发
Content-Type，不改就是"头写 png、字节是 jpeg"）。

三条硬约束写在代码里：

1. **绝不抛。** 缩略图是锦上添花，换失败不该让一张已经发出去的图变成错误。
2. **只换得更好，不换得更差。** 原图比现有缩略图还小时（服务端会把 64×64 放大成
   480×480），按比例算目标是 64×64 —— 那等于把 480 换成 64，屏幕上一放反而更糊。
   这种情况返回 `not-sharper` 直接跳过。**这条是回填时踩出来的**：第一版没有它，
   把 9 张老图的缩略图全压成了 1×1（已恢复）。
3. **原子替换。** 先写临时文件再 rename，避免客户端正好读到半个文件。

实测（同一句话生图之后）：

```text
thumb JPEG {"w":739,"h":1080} 196731 字节     ← 升级后
orig  PNG  {"w":832,"h":1216} 1595029 字节
```

日志一行：`缩略图已升级：2026/11/18/4f50fc0d-… → 739×1080 jpeg 196731 字节`。

### 顺带查到的两件事

**服务端没有 SPA 回退。** `/chat`、`/chat/dm/4`、`/chat/channel/1` 全返回 9 字节的
`not found`；真实路径是 hash 路由 `/#/chat/dm/4`。写探测脚本时踩过一次，看到"页面里
0 张图"差点当成 bug。

**`/api/resource/file` 不需要鉴权。** 不带任何头、带假 token、带浏览器 UA 都返回 200
和完整字节。缩略图路径因此**不需要** cookie/token 就能访问 —— 这也意味着拿到
`file_path` 的任何人都能读图。本项目只在 127.0.0.1 上跑，但这是平台行为，记在这里。

---

## 三、TTS 语音是"文件卡片"而不是"语音条"

### 现象

桌面端语音消息显示成一张带波形条的文件卡片（有播放按钮、有文件名），不是手机端那种
紧凑的语音气泡。

### 根因

同一段 wav，两种消息类型在服务端都 200、落库的 `properties.content_type` 也一样，
但**网页端走两条完全不同的渲染分支**：

```js
case Py.audio: p = <Y file_path={c} />          // 语音气泡（波形 + 时长）
case Py.file:  p = <G … content={c} />          // 文件卡片（名字 + 大小 + 下载）
```

`vocechat/file` + `audio/wav` 落到 `Py.file`；只有 `vocechat/audio` 才走 `Py.audio`。

### 修法

`sendFile(target, path, {kind})`：`kind === 'audio'` 时用 `vocechat/audio`，其余用
`vocechat/file`。`vc_send_file` 从 `mimeOf()` 拿到的 `kind` 直接透传。

实测两条同源消息：

```text
mid=743  vocechat/file   audio/wav   ← 文件卡片
mid=744  vocechat/audio  audio/wav   ← 语音条
```

修完之后她自己发的那条（mid=801）是 `vocechat/audio`，桌面端渲染成语音条，时长 00:03。

---

## 四、为什么"分段/攒批"这条链路上没被这些问题挡住

因为它们是**分层的**，而这三处问题都在最外层：

- 攒批与分段（`docs/34`）只处理**文本**的时序，媒体消息直接 bypass；
- 投递打通（`docs/36`）只保证"字节到得了平台"，不保证"客户端渲染得出来"；
- 本文这三处都在"平台已经有了这条消息，但客户端选择怎么显示"这一层。

这也是为什么必须用**真实浏览器**去量，而不是只看 API 返回 200：API 从头到尾都是对的。

---

## 五、测试

| 套件 | 项数 | 覆盖 |
|---|---|---|
| `companion-media` | 183 | 新增 `prompt-name-anchor.test.mjs` 6 项 |
| `dsh-vocechat-adapter` | 185 | 新增 `thumbnail.test.mjs` 10 项 |
| `dsh-channel-vocechat` | 116 | `sendFile` 的 kind 参数 |

`prompt-name-anchor.test.mjs` 钉的是那次静默失败本身：

- 没写名字 → 补在最前，**原画面描述一字不改**（`assert.ok(sent.includes(prompt))`）
- 自己写了名字（三种写法）→ 一个字都不动，也不报 `injectedName`
- 只有中文名 → 不补中文（会破 `requireEnglish`），改为回 `nameWarning`
- `dryRun` 就把补齐后的 prompt 交出来，不必花钱才知道
- `subject` 不是 `companion` → 完全不碰 prompt

`thumbnail.test.mjs` 每条钉一个会让图片变形或损坏的具体坏结果：

- 缩放算错 → 图被拉伸（832×1216 → 739×1080，不是 1080×1080）
- 缩略图不存在却硬造 → 本来原图直出的小图反而变糊
- `.meta` 没跟着改 MIME → 头写 png、字节是 jpeg
- 换失败却抛错 → 一张清楚的图因为缩略图问题变成"发送失败"
- **原图比缩略图还小** → 拒绝（`not-sharper`），文件一个字节都不动

---

## 六、改动清单

| 文件 | 性质 |
|---|---|
| `plugins/companion-media/src/service.mjs` | `characterAnchor()`、`promptMentions()`、名字补锚、`injectedName`/`nameWarning` |
| `plugins/companion-media/index.mjs` | `draw` 的工具描述写明"正文必须写出角色名字" |
| `plugins/companion-media/TOOL_GUIDE.md` | 新增名字规则一节 |
| `plugins/dsh-vocechat-adapter/thumbnail.mjs` | 新增：缩略图升级（ffmpeg / 原图回退 / 只换更清晰） |
| `plugins/dsh-vocechat-adapter/index.mjs` | 发送前升级缩略图；`sendFile` 传 kind；计数与诊断 |
| `plugins/dsh-vocechat-adapter/cordis.patch.yml` | `media.thumbnail` 默认值 |
| `plugins/dsh-channel-vocechat/user-api.mjs` | `prepare` 带 `filename`；`sendFile` 支持 `vocechat/audio` |
| `plugins/dsh-channel-vocechat/port.mjs` | `sendFile` 增加 `kind` |
| `plugins/dsh-vocechat-adapter/scripts/measure-display.mjs` | 新增：用真实浏览器量「真实像素 vs 显示像素」 |
| `test/prompt-name-anchor.test.mjs` / `test/thumbnail.test.mjs` | 新增测试 |
