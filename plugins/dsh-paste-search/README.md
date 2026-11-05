# dsh-paste-search · 搜图入口

左侧栏的「搜图」入口。**插件本身不做搜图**：它只负责入口与工具，
真正的搜图实现交给一个新工作区里的**独立会话**，每次搜索一个会话。

- 包名 `@dsh-companion/paste-search`，版本 `0.2.1`（模块自身版本同样记在 `localVersion`）
- 许可证 MIT；无构建步骤（`index.js` / `client.js` 都是手写产物，直接可加载）
- 依赖 Node `>= 24`（套件统一口径）

## 自检（离线，不需要模型、不联网）

```bash
node plugins/dsh-paste-search/scripts/selftest-host.mjs            # 用内置 1×1 JPEG
node plugins/dsh-paste-search/scripts/selftest-host.mjs <图片路径>  # 或 PASTE_SEARCH_SAMPLE_IMAGE=…
```

它用一个假 ctx 跑真实代码：注册路由 → `POST /search` → 断言工作区落盘、附件写入、
`ctx.agents.create()` 起了会话、回合结束后会话被重命名 → `GET /search` 读回结果。
所有临时文件都在 `os.tmpdir()` 下，**不写仓库**。

## 面板

```
┌───────────────────────┬────────────────────────────────┐
│  目标图（粘贴/拖入/点选） │  搜索结果                      │
│                       │  缩略图网格 + 相似度 + 原始出处  │
├───────────────────────┤  点图 = 打开 target（作品页）    │
│  对话栏（补充说明）     │                                │
└───────────────────────┴────────────────────────────────┘
```

- 左上：目标图。支持 `Ctrl+V` 粘贴、拖入、点选；载入即自动开搜。
- 左下：对话栏。搜索进行中发的补充说明会 `followup` 进那个会话；没开始时则随本次搜索一起写进任务书。
- 右侧：结果卡片。点击缩略图打开 `target`；`nsfw: true` 的结果默认模糊，点一下再显示。

## 一次搜索发生了什么

1. `POST /api/dsh-paste-search/search` 收到 data URL，在
   `<默认工作目录>/paste-search-sessions/<时间戳>-<id>/` 建一个新工作区目录，
   把目标图存成 `input.<ext>`，任务书写到 `.paste-search/task.md`。
2. Host 用 `ctx.agents.create()` 起一个**新会话**（`meta.cwd` 指向该目录），
   并把一句话 prompt 交给它：「读任务书，然后查这张图」。
3. 那个会话里的 agent 用自己手头的工具（bash/pwsh、web_fetch、read_image…）
   去搜 SauceNAO / IQDB / trace.moe / Ascii2D / P 站原图，边查边把结论写进
   `.paste-search/result.json`（结果契约见任务书）。
4. 面板每 2 秒轮询 `GET /api/dsh-paste-search/search?id=`，把 `result.json`
   渲染成右侧的结果网格；点「打开会话」可跳到那个真实会话继续聊。

## HTTP 接口（本机、同源、走 Connection 的认证）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/dsh-paste-search/search` | 开一次搜索（body: `{ image: dataURL, notes }`） |
| GET | `/api/dsh-paste-search/search?id=` | 读状态 / 结果文件 / 过程日志 |
| POST | `/api/dsh-paste-search/note` | 把补充说明 `followup` 进该会话 |
| GET | `/api/dsh-paste-search/recent` | 最近 12 次搜索 |
| GET | `/api/dsh-paste-search/img?u=&r=` | 图片代理（i.pximg.net 等按 host 补 Referer） |

## 结果契约（`.paste-search/result.json`）

```json
{
  "status": "running | done | partial | failed",
  "summary": "一句话结论",
  "items": [
    { "source": "SauceNAO · Yande.re", "similarity": 93.11, "title": "", "author": "",
      "target": "https://…", "thumb": "https://…",
      "links": [{ "label": "pixiv", "url": "https://www.pixiv.net/artworks/…" }], "nsfw": false }
  ],
  "sources": [{ "name": "SauceNAO", "ok": true, "detail": "8 条结果" }],
  "notes": "踩到的坑"
}
```
