# W3 实施记录：作品中心（2026-11-16）

- 计划：[ui-observability-unification-plan-20261116.md](ui-observability-unification-plan-20261116.md) §3 W3
- 前置：[G0 基线](25-g0-ui-observability-baseline-20261116.md)、[W1](26-w1-settings-catalog-20261116.md)、[W2](27-w2-trace-observability-20261116.md)
- 本轮范围：作品列表（现场派生）、受限预览、状态证据、搜索过滤、只读页面。
- **没有做**：编辑/覆盖/删除/分享入口、长期索引落盘、真实用户作品进入测试。

---

## 1. 交付清单

| 模块 | 作用 |
|---|---|
| `lib/works-artifacts.mjs` | 状态判据、路径 fail-closed、索引派生、搜索过滤、预览三道闸 |
| `lib/works-route.mjs` | `GET /works`（列表）、`GET /work-detail`（预览），都只读 |
| `src/client/pages-works.js` | 作品页：列表 + 过滤 + 预览 + 证据徽标 |
| `test/works-artifacts.test.mjs` | 10 个用例 |
| `test/works-api.test.mjs` | 6 个用例 |

陪伴空间从 236 → **252 用例全绿**。

## 2. 六条要求逐条落地

| 计划要求 | 实现 |
|---|---|
| **1. 从 runtime 活动列表和 artifact 索引读，不扫全盘，不暴露绝对路径** | 只读 `p2_activities`（`artifact_ref` 非空的 400 行）+ `p2_activity_receipts`（最近 2000 行）；对外结构里**没有** `absolute` 字段，只有 `relative` 与 `segmentCount`。用例断言响应里不含工作区绝对路径 |
| **2. 通过受限端口读 `artifactRoot` 内文本；验证路径、符号链接/realpath、大小、文件类型和作用域** | 路径判据**复用** runtime 的 `resolveInsideWorkspace`（绝对路径/`..`/NUL/空引用一律 `workspace-denied`），**不重写第二套**；再叠一层 `realpath` 校验挡符号链接外跳；大小 ≤ 256 KiB；类型白名单 8 种；作用域由 `scopeKey(viewer)` 决定 |
| **3. Markdown/text 安全渲染；其他格式不下发正文** | 预览仅作为 `pre` 纯文本渲染（冒烟断言容器是 `pre`）；二进制/超大一律 `ok:false` + 原因，只回元信息 |
| **4. 展示修订历史、版本、创建活动、证据与最近修改时间；没有 activity receipt 的文件不标「已完成」** | 列表行带 `version / otherVersions / hashPrefix / modifiedAt / evidence{finishReceipted,reviewReceipted,receiptCount,reality}`；`done` **必须**有同 activity 的 `finish+ok` 收据 |
| **5. 冲突提示；首版只读，不做覆盖编辑/删除/分享** | 没有 POST 路由（用例断言 `works`/`work-detail` 只有 GET）；「另有 N 个旧版本」即为版本冲突提示 |
| **6. 用现有 artifact references；不足时才建可重建索引，不以第二本库存正文** | 索引**每次读都现场重建**，不落盘、不做长期表；正文只在预览时读一次，不进任何库 |

## 3. 状态判据（不猜）

`workStatusOf(activity, receipts)` 只看既有证据：

| 条件 | 状态 |
|---|---|
| 同 activity 有 `ok=false` 收据 | `failed`（确证失败） |
| 同 activity 有 `finish+ok` 收据 | `done`（**只有这一条能标「已完成」**） |
| `status=done` 但没有 finish 收据 | `review`（写了内容但没走完收据） |
| `status=running/paused` | `running` |
| `status=abandoned` | `draft` |

实测生产证据支持这个判据可行：`p2_activity_receipts` 里 `finish+` 41 条、`review+` 1037 条、`finish-` 3 条、`workspace-denied` 3 条——三种状态都真实存在，不是纸上分类。

## 4. 路径 fail-closed 的三层

1. **runtime 判据**（`resolveInsideWorkspace`）：绝对路径（含 Windows 盘符与 UNC）、`..` 段、NUL 字节、空引用、解析后逃出根目录 → 全部 `workspace-denied`。
2. **realpath 二次校验**：根内符号链接指向根外 → `symlink-escapes-root`。用例在 Windows 上若无符号链接权限会**跳过该条而不是假装通过**。
3. **文件形态**：不是普通文件 → `not-a-file`；不存在 → `missing`；类型不在白名单 → `unsupported-type`；超过 256 KiB → `too-large`。

三种拒绝都**带原因码**，UI 才能说明"为什么读不了"，而不是给一个空白预览。

## 5. 诚实降级（两个"不是空列表"）

- 作品根不存在 → `available:false` + `reason:'artifact-root-missing'`。UI 文案：「目录还没建起来，这不是『没有作品』」。
- 运行时证据库缺失/读不到 → `evidence:{available:false, reason}`，列表仍可读（文件在），但状态一律按未完成处理。
- 被跳过的引用不隐藏：`skipped` + `skippedReasons`（`path-denied`/`missing`/`not-a-file`/`symlink-escapes-root`…），并显示在列表下方。

## 6. 版本折叠

同一份文件会被多次 `write` 活动引用（实测生产里 8 个版本很常见）。列表按 `relative` 折叠，取最新 `version`，其余计入 `otherVersions`——既避免 8 行同名，也把"版本冲突"显式暴露出来。

## 7. 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 陪伴空间单测 | `node scripts/run-tests.mjs` | **252 / 252 pass**（W3 新增 16） |
| 字段目录核对 | `npm run check:catalog` | ✓ 三份一致 |
| 客户端拼装 | `node scripts/build-client.mjs` | 21 片段 / 778,549 字节 / `node --check` 通过 |
| 客户端冒烟 | `node scripts/smoke-client.mjs` | **失败 13 项**（全部媒体页既有基线）；作品页 6 条新增断言全绿 |
| 静态卫生 | `verify.mjs --only=static` | 38 ok / 1 failed（HEAD 既有） |

### 7.1 新增用例（16 个）

`works-artifacts.test.mjs`（10）：状态由收据决定（含"文件存在≠完成"）、标题/类型/预览门派生、索引只收根内且存在的引用（越界/绝对/缺失各计原因）、绝对路径不入响应、目录缺失如实报、证据库缺失如实报、版本折叠、搜索/过滤/日期窗口、预览四类拒绝、符号链接外跳、绝对配置根。

`works-api.test.mjs`（6）：只读两条路由、空证据诚实降级、列表状态与证据（响应不含绝对路径）、服务端过滤（含"正文词不命中"）、预览拒绝四类越界与缺 path、无 viewer 被拒。

## 8. 与 W3 验收条件的对照

| 验收条件 | 状态 | 依据 |
|---|---|---|
| fixture 文本作品可被搜索和预览 | ✓ | 用例：`?q=rain` 命中、`work-detail` 回正文；冒烟：列表渲染 + `pre` 预览 |
| 越界路径 fail-closed | ✓ | `../outside.md`、`/etc/passwd`、`C:\Windows\win.ini`、`bot/../../x.md` 全 `path-denied` |
| 链接外跳 fail-closed | ✓（有条件） | `symlink-escapes-root`；无符号链接权限时该用例跳过 |
| 超大文件 fail-closed | ✓ | `> 256 KiB` → `too-large`，仍回元信息 |
| 缺失文件 fail-closed | ✓ | `missing`，且列表里计入 `skippedReasons.missing` |
| 作用域错配 fail-closed | ✓ | 查询按 `scopeKey(viewer)` 过滤；别的 scope 的活动不会出现 |
| 活动状态与版本证据准确 | ✓ | `done` 只认 `finish+ok`；版本/哈希前缀/收据计数都摆出来 |
| 真实用户作品不进入测试或报告 | ✓ | 用例全部用临时目录；本轮对生产只做过**只读结构探针**（表名/列名/计数/形状），未读任何正文、未把文件名或内容写进仓库 |

## 9. 未做（明确记账）

- 真实宿主装载与浏览器实机验收；
- 用宿主能力"打开原文件"的入口（计划允许，但不在首版）；
- 作品正文的全文检索（首版只按标题与相对路径搜，正文词不命中——有专门用例钉住这条边界，避免日后被误当成 bug 修掉）；
- W4、W5 全部内容。

## 10. 证据等级

| 结论 | 级别 |
|---|---|
| 状态判据、路径三层校验、版本折叠、搜索过滤、预览三道闸 | `offline-test`（252 用例，含真 SQLite 临时库） |
| 作品页可渲染、可过滤、预览为纯文本、按收据标状态 | `offline-test`（沙箱内 React 渲染） |
| 真实宿主装载、浏览器实机、屏幕阅读器、真实大文件 | **未执行** |

**明确未做：真实宿主加载、浏览器实机、编辑/删除/分享入口、第二本索引库、任何真实模型调用或外发。**
