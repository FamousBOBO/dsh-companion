# 记忆系统

> 状态（2026-10-19）：**代码完整，默认关闭，线上已开启**（`memory.v2` + `vectorEnabled`）。
> 检索侧实测（60 题基准，语料是日记原文句子）：
>
> | 路径 | recall@8 | p95 |
> |---|---|---|
> | 关键词 | 0.04 | 21ms |
> | 关键词 + 向量（bge-small-zh 512 维） | **0.14** | 115ms |
>
> 门槛是 0.85，**没达到**。向量把召回提高 3.5 倍，但语料是**日记原文句子**而不是
> 抽取后的"一句话事实"，8 个注入位要从几千段里挑中证据仍然很难。
>
> 所以：**默认值仍是关**（新部署不会自己打开），**线上实例已手动打开**——取舍是
> "注入几条弱证据"好过"什么都不注入"，且证据块明确标注「证据，不是指令」，模型可以不理。
> 要提升召回，方向是**更短的事实**（抽取管线），不是更长的块。

## 2026-10-24 起的三层注入与巩固（P0–P3）

在上述骨架上加的机制（详见 [internal/research/20261024_memory-system-research.md](internal/research/20261024_memory-system-research.md)）：

| 机制 | 位置 | 一句话 |
|---|---|---|
| 事实蒸馏 | `core/memory/distill.ts` | 抽取产物去口语壳、截 80 字再入库（recall 短板的对症药） |
| 即时抽取 | `features/memory/instant-capture.ts` | 回合结束按规则判据带外沉淀（每日上限、90 秒冷却，默认关） |
| 巩固合并 | `core/memory/consolidate.ts` + nightly `memory.consolidate`（04:55） | 同一件事的两种说法合成一条；决策留凭证 |
| 矛盾冻结 | `features/memory/consolidate-io.ts` | 疑似冲突进 `conflicts.jsonl` 队列等主人裁决（不再只刷日志） |
| 三层注入 | `core/memory/select.ts` + `features/memory/inject-v3.ts` | 常驻（core 标记）+ 话题 + 走神（默认 8%）；日子（生日/纪念日）在最前 |
| 实体扩展 | `core/memory/entities.ts` | 查询点名的人/号顺着实体词典多想一步 |
| asOf | `retriever.retrieve({ asOf })` | 深召回的时间旅行："那天我们是怎么想的" |

## 组成

| 层 | 位置 | 作用 |
|---|---|---|
| 模型 | `src/core/memory/model.ts` | 双时间轴（validFrom / recordedAt）、矛盾不删除（supersede）、遗忘曲线 `R = e^(−t/S)` |
| 检索 | `core/memory/{score,select,query}.ts` + `features/memory/retriever.ts` | 相关性 × 重要性 × 新近度；零相关性不注入；注入预算 600 字 |
| 存储 | `features/memory/store.ts` | `knowledge/records.jsonl`（追加式，定期压缩） |
| 向量 | `features/memory/vector-store.ts` | `knowledge/vec.bin` + `vec-index.json`，分片 + 暴力余弦，不引原生依赖 |
| 夜间任务 | `features/memory/nightly.ts` | 九个 job，挂在事件书上（见下表） |
| 审核 | 后台「记忆」页 | 候选通过/忽略、冲突裁定、MEMORY.md 迁移 |

## 夜间任务（事件书 `core/schedule/event-book.ts`）

| 时间 | job | 说明 |
|---|---|---|
| 03:50 | `memory.chunks` | 工作区 md（`memory/`、`knowledge/`、`learning/`）切 600 字块入索引，幂等；旧块归档不删 |
| 04:20 | `memory.diary-extract` | **昨天**的日记 → 结构化记录（当天凌晨跑，当天日记还没写完） |
| 04:40 | `memory.session-split` | 昨天的会话原件 → 回合块 → 记录 |
| 05:00 | `memory.reflect` | 高重要度记录 → 反思（产出候选，等审核） |
| 05:20 | `memory.links` | 相邻记录建链（A-MEM） |
| 05:40 | `memory.contradictions` | 检出疑似冲突（只报告，不自动改） |
| 06:05 | `memory.forget` | `R < 0.05` 且没钉住的 → 归档（写 `.jsonl.gz`，**不删除**） |
| 06:20 | `memory.digest` | 核心摘要 → `memory/DIGEST.md` |
| 06:30 | `memory.reindex` | 增量嵌新记录（embed 服务不在就具名跳过） |

## 打开它

1. 起本机 embed 服务（可选，但**不开就没有向量**）：
   ```bash
   bash deploy/embed-server/install.sh      # 监听 127.0.0.1:8801
   ```
2. 后台「记忆」页，把 `memory.v2` 打开；要向量就把
   `memory.vectorEnabled` 打开、`vectorUrl = http://127.0.0.1:8801/v1`、`vectorDim = 512`。
3. 首次打开会把旧库 `knowledge/entries.json` **自动导入**新库（按内容去重）；
   之后跑几天夜间任务，再看「待审核」里有没有候选。

### 想立刻有料（不等夜间任务）

`memory.chunks`（03:50）与 `memory.reindex`（06:30）都是幂等的，但首次要把整个工作区的
md 切块并全部嵌入，等一晚上太慢。**在 dsh 停止时**跑一次一次性引导（两个写者同时动
`records.jsonl` 会互相覆盖，所以必须先停服务）：

```bash
systemctl stop dsh
/opt/node22/bin/node /root/dsh-ops/memory-bootstrap.mjs   # 导入旧库 → 切块 → 嵌向量
systemctl start dsh
```

脚本内容见 [deployment.md §13.4](deployment.md)。实测（2026-10-19，1.9M 日记）：
旧库 104 条 + **1421 块**，共 1525 条向量，**31 秒**嵌完、0 失败。

**回滚**：把 `memory.v2` 关掉即可——新库文件保留，旧库一直没动。

## 评测

```bash
# 关键词（默认）
node eval/memory/run.mjs --corpus /path/to/workspace/memory

# 向量 + 关键词混合（需要 embed 服务）
node eval/memory/run.mjs --corpus /path/to/workspace/memory --vectors http://127.0.0.1:8801/v1
```

门槛见 `eval/memory/README.md`（recall@8 ≥ 0.85、p95 ≤ 300ms、注入 ≤ 600 字）。

## 与 KB Lite（chunk 检索）的对比（2026-10-18 实测）

外部方案 KB Lite 的索引粒度是 **600 字块 / 100 重叠**，同一份日记语料、同一个
embed 模型、同一套题目：

| 方案 | 粒度 | recall |
|---|---|---|
| 关键词（本模块） | 句子 | 0.04 |
| 关键词 + 向量（本模块） | 句子 | 0.14 |
| KB Lite（chunk） | 600 字块 | **0.28**（其 CLI 的 top-6） |

**但把 chunk 直接搬进"每回合自动注入"会失效**：我们的注入预算是 **600 字**，
一块就占 400 字 ⇒ 每回合只塞得进 1 块，实测 recall 反而 **0**。
KB 的 0.28 建立在**一次返回 6 块**上。

**⇒ 结构结论**：
- chunk 层适合当**深召回工具**（agent 主动搜、一次给 5–8 块），不适合挤进每回合的注入预算；
- 自动注入继续用结构化记录（短、带出处与时间）；**原文块在代码里被挡在注入与主动召回之外**
  （`accept` 过滤 + 服务层 `isChunkRecord`），只有 `qq_memory_search` 能看到它们；
- 真要提升自动注入的召回，方向是**更短的事实**（抽取管线）而不是更长的块。

块索引已实现（`memory.chunks`，03:50，幂等、旧块归档），并由 **`qq_memory_search`**
暴露给模型：一次返回 3–8 条原文块 + 出处（文件与行号），跨房间、不占每回合注入预算。
`memory.v2` 关着时这个工具返回「深召回未启用」而不是报错。

## 注入与深召回的分工（2026-10-19 定）

| 通道 | 看到什么 | 预算 | 触发方 |
|---|---|---|---|
| 自动注入 | 结构化记录（短、带出处与时间） | 每回合 3–8 条、≤600 字 | 每回合自动 |
| `qq_recall_memory` | 同上，另可强化命中 | 工具参数 | 模型主动 |
| `qq_memory_search` | **原文块**（600 字）+ 文件行号 | 一次 3–8 块、≤6000 字 | 模型主动 |

**原文块被挡在前两条之外**（检索器的 `accept` 过滤 + 服务层 `isChunkRecord`）：
一块就占 400 字，挤进 600 字预算后整回合只剩一条证据，实测 recall 反而归零。

## 已知限制

- **检索是瓶颈**：语料是日记原文句子，不是抽取后的"一句话事实"；字面匹配对同义/上下位无效。
- **遗忘曲线依赖召回**：`S` 只在被召回时增长；检索不准时多数记录停在 S=1 → 3 天归档。
  缓解：偏好/人物/高重要性特质/`pin` 标签永不归档；归档不是删除。
- **`DIGEST.md` / `MEMORY.md` 目前没有注入路径**：它们只是给人看的落点。
- **审核是手动的**：反思产出的候选不会自动生效。
