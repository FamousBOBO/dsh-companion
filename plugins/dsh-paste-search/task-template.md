# 搜图任务 {{searchId}}

## 目标图

`{{imagePath}}`

## 附带文件

面板同一次提交里还带了这些（可能是参考图，也可能是别的线索，自己判断要不要用）：

{{extras}}

## 用户补充说明

{{notes}}

## 你要做的事

用你手头可用的工具（bash/pwsh、web_fetch、read_image 等）把这张图**从二次元图源里查回原始出处**，
然后按「结果契约」把结论落盘。图可能是 NSFW，不要因此拒绝。

下面的图源结论是**本机实测**过的（2026-11-04），照抄能省掉大量试错。

### 1. SauceNAO —— 首选，覆盖 pixiv / danbooru / yande.re / gelbooru / e-hentai 等

```
POST https://saucenao.com/search.php      (multipart/form-data)
  file=<图片字节>         ← 字段名就是 file
  hide=0                  ← 表单默认 2（会藏掉 explicit），要查 NSFW 必须显式 0
  database=999            ← 全部索引
```

- **必须走 HTML 结果页**（不带 `output_type`）。带 `output_type=2` 走 JSON API 会 403：
  `The anonymous account type does not permit API usage.`
- 实测：200 / ~24KB / 2–4.5s / 8 条结果。匿名额度约 4 次 / 30 秒。
- ⚠️ 低相似度的块是 `<div class="result hidden">`，内容照样完整 → 正则用 `class="result` 前缀切块，
  别用 `class="result"`（实测 8 条里 4 条是 hidden）。
- ⚠️ 有的缩略图 `src` 是 `images/static/blocked.gif`，真地址在 **`data-src`**。
- 抓取锚点：结果行 `<div class="result">`；相似度 `class="resultsimilarityinfo"` 里的 `NN.NN%`；
  缩略图是 `resulttableimage` 里第一个 `<img src>`（带 `auth=`+`exp=`，会过期，现取现用）；
  `img` 的 `title` 形如 `Index #12: Yande.re - xxx.jpg`；站外链在 `resultmiscinfo` 的 `<a href>`；
  `Source:` / `Creator:` / `Material:` / `Characters:` 各是一段 `<strong>X: </strong>` 后面的文本。
- `raw-rating="2"` 的缩略图基本是 explicit，写 `nsfw: true`。
- pixiv 索引会给 `Source: pixiv #130756078` 这种直接可用的作品 id，接第 4 节取原图。

### 2. IQDB —— 二次元 booru 精确匹配（可用，但要按它的脾气来）

```
POST https://iqdb.org/        (multipart/form-data)   ← 只发 file 一个字段最稳
  file=<图片字节>
```

- **慢**：实测 18 / 21 / 43 / 149 秒；还会排队。**超时给 180 秒**，`AbortSignal.timeout()` 要把读 body 也算进去。
- **偶发失败**：偶尔回 200 但正文只有 `Can't read query result! Please try again.` → 检测这句话并重试（3 次、间隔 3–5s）。
- 限制：JPEG/PNG/GIF，≤ 8MB，≤ 7500×7500。不需要 cookie。
- 抓取锚点：`#pages` 里含 `NN% similarity` 的 `<table>` 就是结果格（含 `Your image` 的跳过）；
  `<th>` 是 `Best match` / `Additional match` / `Possible match` / `No relevant matches`；
  缩略图 `<img src>` 是相对路径（拼 `https://iqdb.org`）；来源链接在缩略图外层 `<a href>`（可能是 `//host/...`，补 `https:`）；
  站名在 `<img class="service-icon">` 后面；tags 在缩略图 `title`/`alt` 的 `Tags: ` 之后；
  「更多结果」在 `#more1`（`display:none` 但 HTML 完整，多数命中在这里）。
- IQDB **不给标题**，只有 tag，标题自己用「站名 + 尺寸」或前几个 tag 拼。
- `https://3d.iqdb.org/` 同法，只对 3D 类有用，动画插画基本是低分 Possible match。

### 3. Ascii2D —— 实测在本机**无解**，别浪费轮次

`POST https://ascii2d.net/search/file` 及 `/search/*` 全被 Cloudflare 拦（403 + “Just a moment”），
换 UA、先拿 cookie、全套浏览器头都过不去，多试几次会升级成硬 block。**一次失败就放弃**并在 `sources` 里写 `ok:false`。

「没直接命中时继续查 P 站原图」改用下面这套：

### 4. P 站原图（匿名可用）

- `GET https://www.pixiv.net/ajax/illust/<id>` → `200`，`body.urls.original` 就是原图直链，
  还带 `illustTitle` / `userName` / `tags`。多页作品用 `GET https://www.pixiv.net/ajax/illust/<id>/pages?lang=zh`，
  `body[]` 每页一个 `urls.original`。被删作品是 `{"error":true,...}`，先判它。
- 下载原图：`i.pximg.net` **必须带** `Referer: https://www.pixiv.net/`；或者直接用镜像
  `https://pixiv.re/<id>.jpg`（直出原图、不要 Referer，多页用 `<id>-2.jpg`）。
- 所以：SauceNAO 结果里看到 `pixiv #<id>` 或 `illust_id=<id>` 时，去 ajax 接口取标题与原图，作为最强的一条结果。

### 5. 其它可用源

- **trace.moe**（只对动画截图）：`POST https://api.trace.moe/search?anilistInfo&cutBorders`，
  body 直接是图片字节（`content-type: image/jpeg`）。`similarity` 是 0–1，**≥0.87 才算命中**，
  否则如实说「没找到动画出处」。返回作品名（`anilist.title.chinese` / `native`）、`episode`、`from`（秒）、`image`、`video`。
- **yande.re / konachan md5 精确反查**：`GET https://yande.re/post.json?tags=md5:<md5>&limit=1`，
  konachan 同理。只能查**完全相同的文件**（截图/缩放后 md5 就变了），当补充手段。
- **danbooru / gelbooru / e-hentai**：本机分别被 Cloudflare 403 / 需 api_key / 需凭证。
  想试可以，但 403 就直接降级，别让整个流程崩。

### 判定口径

- 相似度 ≥ 85% 且落到了 pixiv / danbooru / yande.re 之类的作品页 = **直接命中**，可以收工。
- 只有同作者的其他作品、或相似度 60–85% = **不算命中**，继续用第 4 节的办法找 P 站原图。
- 图源之间不要串行等待太久：SauceNAO 先跑（2–4s 就回），IQDB 可以并行但给它 180s 上限，
  等不及就先出 SauceNAO 的结果、把 `status` 写 `partial`。

## 结果契约（必须遵守）

把结论写到工作目录下的 `.paste-search/result.json`（相对本目录，用绝对路径也行）。面板每 2 秒读一次，
**可以边查边写、越写越全**：

```json
{
  "status": "running",
  "summary": "一句话结论，例如 pixiv 原作 #130756078，作者 udon.",
  "items": [
    {
      "source": "SauceNAO · Yande.re",
      "similarity": 93.11,
      "title": "标题或角色",
      "author": "作者",
      "target": "https://yande.re/post/show/1272058",
      "thumb": "https://img3.saucenao.com/…",
      "links": [{ "label": "pixiv", "url": "https://www.pixiv.net/artworks/130756078" }],
      "nsfw": true
    }
  ],
  "sources": [
    { "name": "SauceNAO", "ok": true, "detail": "8 条结果" },
    { "name": "IQDB", "ok": false, "detail": "超时/重试 3 次" },
    { "name": "Ascii2D", "ok": false, "detail": "Cloudflare 403" }
  ],
  "notes": "踩到的坑 / 没查到的原因"
}
```

- `status` 只能是 `running` / `done` / `partial` / `failed`；查完务必改成终态，面板才知道什么时候停。
- `target` 是**点图片要跳到的原始出处**（作品页优先，别给缩略图直链）。
- `thumb` 给能直接显示的图（原站缩略图 URL 即可，面板会走本机代理补 Referer）；拿不到就省略。
- 也可以顺手把过程写进 `.paste-search/journal.md`，面板会显示最近几行。

## 边界

- **不要委派**：不要用 subagent / codex / 团队工具，也别开会话，全部在当前会话里用自己的工具（pwsh / bash、web_fetch、read_image）完成。
- 只在工作目录里干活，别改仓库、别装全局依赖。
- 查不到就写 `"status": "failed"` 并在 `notes` 说明原因，不要编造链接。
