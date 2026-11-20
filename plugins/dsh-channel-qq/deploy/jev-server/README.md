# 本地 Jev 判断（`deploy/jev-server`）

群聊「该不该说话」原来由一个**生成式**模型回答：组一段提示词、给它 25 秒、拿回一段自由文本
再用宽松解析器猜它的意思。这条路有三个结构性问题——超时上限长、输出形状不可控、
每判一次花一次 provider 的钱。

这个目录放的是**换成本地打分器**之后要装的东西：一个 GGUF 权重、一个 `jev-score` 可执行文件、
一份 tokenizer。装完之后判断变成"九个是/否 + 一次短语选择"，本机实测 **236 ms / 零费用 / 零网络**。

---

## 它凭什么能替代生成

关键在于**不问生成式的问题**。同一批中文群聊夹具上的实测：

| 问法 | 结果 |
|---|---|
| 「她该怎么参与？」（一次五选一） | 4 个"不该说话"的场景判错 |
| 「**群里**有人在吵架吗」这类九个是/否 | 冲突/钱/注入三门 3/3 命中、零误报；46 条逐门标注 43/46 |

差别不在模型大小，在问法：问"**她**能不能插话"时它没有关于"她"的先验，一律退回
`false`（p 0.75–0.97，4/4）；问"**群里**发生了什么"是内容判断，它判得准。
于是这一层只**采集事实**，动作由一张确定性决策表算出来——可单测、可复现、改优先级不用重训。

动作 10/10、目标合法性 10/10、误报 0（实测口径见 `docs/groups/p10-jev-judge.md`）。

---

## 装什么

三样东西，来源不同、缺一不可：

| 文件 | 大小 | 作用 | 缺了会怎样 |
|---|---|---|---|
| `Jev-Style-0.8B-Decision-v3-Q4_K_M.gguf` | 495 MB | 打分模型本体 | 起不来（`model load failed`） |
| `readout_config.json` | 小 | 校准温度 + `yes`/`no`/`->` 的 token id | 槽位全偏，**不报错**、只给错答案 |
| `tokenizer/tokenizer.json` + `tokenizer_config.json` | 12 MB | 渲染器切 token | 渲染器装配失败 → 这一路不可用 |
| `jev-score.exe` + 同目录的 `llama.dll`/`ggml*.dll` | ~5 MB | 打分器（本仓库编译出来） | 起不来（`ENOENT` 或找不到 DLL） |

**`readout_config.json` 与 tokenizer 必须和权重同一次发布**。版本错配的后果不是崩溃，
而是"看起来合理但整体偏了"的概率——那是最难查的一种错。所以 `fetch-model.ps1` 会校验哈希。

---

## 装

```powershell
# 1. 取模型（含哈希校验；已在则只校验）
.\fetch-model.ps1 -Out D:\jev\model

# 2. 量显存，拿建议参数
.\probe-vram.ps1

# 3. 编译打分器（需要 MSVC + 已构建好的 llama.cpp）
.\build-scorer.ps1 -ModelDir D:\jev\model -LlamaBuild D:\llama.cpp\build

# 4. 冒烟：手动起一次，看 ready 行
D:\jev\model\bin\jev-score.exe --model D:\jev\model\Jev-Style-0.8B-Decision-v3-Q4_K_M.gguf `
  --n-ctx 2048 --n-ubatch 256 --ngl 99 --threads 6 --n-seq-max 4 --n-outputs-max 64
```

第 4 步应当先打印一行 `{"ready":true,...}` 然后等 stdin。`Ctrl+C` 退出。
**`ready` 行不到就不要再往下配**：后台只会显示"这一路不可用"，而原因藏在 stderr 里。

---

## 在后台配

侧栏 → QQ 连接 → 「群聊」页里的 **判断模型** 一段。四个必填：

| 字段 | 填什么 |
|---|---|
| `backend` | `jev-local` |
| `scorerPath` | 第 3 步产出的 `jev-score.exe` 绝对路径 |
| `modelPath` | `...\Jev-Style-0.8B-Decision-v3-Q4_K_M.gguf` |
| `tokenizerPath` | `...\tokenizer\tokenizer.json` |

其余按 `probe-vram.ps1` 的建议填。**三个路径留空 = 这一路不启用**（判断按"不可用"处理，
群里不说话）——空值不是"随便找个默认路径"，那是刻意的：仓库里写死某台机器的路径，
换台机器就是一句静默的 `ENOENT`。

### 切完之后先跑 shadow

`presence.mode` 改成 `shadow` 跑一天。这个模式**照常判断、只是不发**，结果写进
`<dataDir>/logs/presence-shadow.jsonl`。要看的是三件事：

1. **该说话的时候真的打算说**（`action` 不是 `silent`）；
2. **不该说话的时候真的没说**（吵架/谈钱那些场景没出现动作）；
3. `phraseMinProbability` 的门槛是不是把真正想说的话也拦掉了（短语概率在日志里）。

第三天再开 `live`。直接开 `live` 的问题不是"会说错话"，而是**你不知道它是凭什么说的**。

---

## 调什么

| 症状 | 先看 | 再改 |
|---|---|---|
| 完全不说话 | 后台"判断模型"页有没有"未配置"；启动日志里有没有 `judge:` 行 | 三个路径；`minFreeVramMb` 是否高于实际空闲 |
| 说话太少 | 影子日志里 `phrase-low-confidence` 的比例 | `phraseMinProbability` 从 0.30 降到 0.25（**这是没校准的阈值**） |
| 说话太多 | 影子日志里那些 `action` 的场景 | 优先查门：`casual`/`share` 关一门 |
| 第一次判断慢 1 秒 | 冷启动（打分器加载权重） | 无解，也不值得解：只有第一次 |
| 判断超时 | 显卡是否被别的程序占了 | `timeoutMs` 调大，或降 `contextSize` |

`contextSize` **不要往大改**。一次判断（15 条旁听 + 九门问句）约 300 token；本机实测
32768 → 2048 省 **786 MB 显存**，判决与延迟都不变。上游默认 32768 是给长文打分用的。

`nGpuLayers` **不要为了省内存改成 0**。实测 GPU 路线私有内存 100 MB、延迟 0.24 s；
CPU 路线 208 MB、1.55 s——CPU 又慢又费内存。显存不够时这条链路应当整条不可用，
而不是降级。

---

## 它不做什么

- **不生成文本。** 文案只能从短语库里**选**，所以不会突然说一句没人预料到的话；
  代价是"她说话有点套路"。四个场景库共 13 条，加句子要改
  `src/app/inbound/judge-gates.ts` 的 `PHRASE_BANKS`（并跑
  `test/judge-gates.test.ts`——它会钉住长度、`@`、CQ 码与"同场景不许重复"）。
- **不替人做判断。** 九门只回答"群里发生了什么"；动作由决策表算。
  见 `src/app/inbound/judge-gates.ts` 里 `ruleTable` 的顺序注释。
- **不碰发送。** 限频、模式闸门、回执校验与宿主模型那条**共用同一处**
  （`presence-send.ts`）。换后端不允许改发送行为。

---

## 卸载

1. 后台把 `judge.backend` 改回 `host`（立即生效，不需要重启）；
2. 删掉 `D:\jev`（模型与打分器）；
3. `npm run verify` 不需要重跑——但 `judge.*` 的默认值会留在配置里（无害）。

改回 `host` 之后行为与换之前逐字节一致：两条后端同时留在装配里，切换只改配置。
