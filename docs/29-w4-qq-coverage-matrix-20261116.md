# W4 前置：QQ 字段覆盖率矩阵（2026-11-16）

- 计划：[ui-observability-unification-plan-20261116.md](ui-observability-unification-plan-20261116.md) §3 W4
- 输入：[G0 字段清单](25-g0-qq-field-catalog-20261116.tsv)（288 行）
- 输出：[覆盖率矩阵](29-w4-qq-coverage-matrix-20261116.tsv)（288 行 × 16 列）
- 本轮**只做审计**：没有关 8790、没有改 `admin.enabled`、没有重启、没有装隔离 Profile。

---

## 1. 矩阵的列含义

矩阵在 G0 的 12 列后追加 4 列，每一列都能直接回答一个 W4 问题：

| 列 | 回答什么 |
|---|---|
| `disposition` | 这类字段在 W4 里怎么处置（判据见 §2） |
| `hotEffect` | 改这一项要不要重启（沿用 schema 的 `hot` 标注，不自创） |
| `gateState` | 关闭 8790 的 Gate 里它算不算已覆盖（判据见 §4） |
| `requirement` | 这一项**具体要补什么**，写的是动作不是分类词 |

## 2. 处置分类（8 类，共 288）

| disposition | 数量 | 含义 |
|---|---|---|
| `studio-form-existing` | 116 | 已在聊天页表单里（W1 目录统一索引） |
| `studio-form` | 118 | 可在 Studio 加表单，走窄 service 保留 QQ 的 validate/CAS/hot/audit |
| `host-link` | 35 | 进程控制/后台作业：接宿主既有能力，**不复制端点** |
| `secret-write-only` | 7 | 只写 + 掩码 |
| `decide-then-retire-or-migrate` | 6 | 先决定"迁移还是废弃"，**不能悬空** |
| `listener-control` | 3 | 就是管理 listener 本身（`admin.enabled/host/port`），只读展示 |
| `read-only` | 2 | 诊断/统计，只读 |
| `documented-dormant` | 1 | schema 标了 dormant，UI 上要标明"存在但不生效" |

**判定优先级**：密钥 > 显式特例 > 已投影 > 页面级处置。密钥无条件只写，不能被页面级处置收走（计划 W4 第 3 条）。

## 3. Gate 状态分布

| gateState | 数量 | 含义 |
|---|---|---|
| `covered` | 116 | 已有表单 |
| `needs-form` | 118 | 缺表单（W4 主体工作量） |
| `needs-host-link` | 35 | 缺宿主能力链接 |
| `needs-mask-check` | 7 | 缺掩码验收（接口是否真的不回明文） |
| `covered-by-readonly` | 5 | 只读已覆盖（含 listener 自身三项） |
| `covered-by-disclosure` | 1 | 只要 UI 标明 dormant 即算覆盖 |
| **`blocking`** | **6** | **未达 Gate 的硬阻塞** |

## 4. 六个阻塞项（关停 8790 之前必须做完）

这六个都是 **Studio 显式移除、且现在任何 UI 都改不了**的 root 级字段。它们 `hot: live`（前四个）或 `hot: restart`（后两个），一旦 listener 关掉就**彻底无处可改**：

| 字段 | 标签 | 风险 |
|---|---|---|
| `primaryTalkValue` | 主群回复概率 | 与 `groups` 页的 `talkValue` 语义重叠；必须做出"主群覆盖入口"或"显式废弃"，二选一 |
| `rooms` | 按群覆盖 | 结构化 map，需要"按群增删"控件；单值表单做不了 |
| `agentPreset` | 人格预设 | 决定整条 prompt 组合，改完立刻影响行为 → 需要改前预演 + 改后可回滚 |
| `permissionPreset` | 权限预设 | 决定工具可见性；关 listener 后没有等价入口 = 工具策略锁死 |
| `groupAgentPreset` | 群聊人格预设 | 同上（群维度），需与 `agentPreset` 一致的预演/回滚 |
| `groupPermissionPreset` | 群聊权限预设 | 同上（群维度）；权限收紧比放宽更需要可审计 |

**判断**：这六个里有四个是"行为开关"而不是"参数"，把它们当普通文本字段塞进表单是错的——所以矩阵标 `blocking` 而不是 `needs-form`。W4 必须先做一次**显式取舍**（迁移成受控控件 / 标 deprecated 并从 resolve 链移除），再谈覆盖率 100%。

## 5. 8790 零字段页面的处置

G0 记录了 6 个 `adminPage` 有零 schema 字段的页面（overview / audit / backup / runtime / debug / providers）。矩阵里它们的处置：

| 页面 | 处置 | 理由 |
|---|---|---|
| overview | `read-only` | 状态总览，Studio 首页 + 诊断页已覆盖 |
| audit | `read-only` | 审计流，Studio 诊断事件页可承接 |
| backup | `host-link` | 备份是文件系统动作，应链接宿主既有能力 |
| runtime | `read-only` | 运行时状态，Studio「运行状态」页已覆盖 |
| debug | `read-only` | 调试开关，只读展示即够 |
| providers | `read-only` | 模型供应商列表，只读 |

`music` 页 35 个字段全部 `host-link`：点歌翻唱是**外部服务 + 进程**，Studio 只能显示"启停请求"与状态，不能复制一条命令执行路径。

## 6. 已做的两项前置修正

### 6.1 8790 的注释与生效值相反（G0 阻塞项 B2）

`profiles/companion/cordis.patch.yml:149-157` 的注释原写「它一直是关的：8790 没人监听」，而实际值 `enabled: true` + `port: 8790` 且实测有监听（pid 16328，`GET /` 返回 `<title>QQ 机器人管理后台</title>`）。

已就地更正为现场事实，并补了两条 W4 必须知道的信息：

- 口令来源实测是 **panel 文件**（`data/home/channel-qq/admin-password.json`，键 `format/N/r/p/salt/key/updatedAt`），不是旧注释说的「生成一次性口令写进启动日志」；env 与 generated 两档都没命中。
- 关停顺序写明：先做覆盖率 Gate 与回滚，再改 `enabled: false` 并重启确认端口释放。

改动只碰注释，**生效值一字未动**（已用 yaml 解析复核：`admin = {"enabled":true,"port":8790}`）。

### 6.2 覆盖率口径复核

G0 记的「111/288 已投影」用 `chat-settings.mjs` 的 allowlist 复算得到**同样结果**：`fieldRefs()` 288 条 → `allowed` 过滤后 111 条（`groups` 31 + `messages` 42 + `proactive` 38）。

矩阵里的 116 与 111 差 5 条，差的正是**页面级处置把它们升级成"已覆盖"的那几条**（`admin.enabled/host/port` 的只读展示、`maxMessageLength` 的 dormant 披露等）——矩阵记的是"在 Gate 意义上是否覆盖"，G0 记的是"是否在可写表单里"，两个口径不同，都在文档里写清了。

## 7. W4 剩余工作（本轮的产出只是前置）

按计划 §3 W4 的七步，本轮完成的是**第 1 步（覆盖率矩阵）**与第 7 步的准备（注释与回滚说明）。未做：

2. 选插件管理器支持的原生设置面板 API（窄 service）；
3. 秘密字段只写 + 掩码的表单改造与连接测试显式触发；
4. 每个页面的读/写/冲突/拒绝/重启提示集成测试；
5. 隔离 Profile 里令新 UI 全覆盖 + listener off，跑 host-load 与浏览器验收；
6. 生产迁移：备份非秘密覆盖文件与配置版本；
7. 关 listener 并证明端口释放，或回滚。

**关闭 Gate 现状**：`covered 116 / 288`，且有 **6 条 blocking**。按计划原文「未达 Gate 不关闭生产后台」，8790 现在**不具备关停条件**。本报告不放行关停。

## 8. 证据等级

| 结论 | 级别 |
|---|---|
| 288 字段的处置分类与 Gate 状态 | `static-audit`（由 G0 清单程序化派生，列数与每行 16 列已校验） |
| 111 条已投影字段的复算 | `offline-test`（用真实 `fieldRefs()` + `chat-settings` allowlist 跑出） |
| 8790 注释与生效值相反 | `live-observation`（端口探测 + profile 原文 + yaml 解析复核） |
| 445 行矩阵无列错位 | `static-audit`（0 行 16 列不一致） |

**明确未做：真实 Profile 切换、隔离宿主验收、监听器关停、任何写入 8790 配置的尝试。**
