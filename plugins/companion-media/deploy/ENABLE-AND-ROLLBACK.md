# 挂载与启用步骤（companion-media）

本文件只描述**已经实现并验证**的步骤；每一步都标出证据等级。
"未验收"的步骤保留在这里，不要当成已完成。

## 0. 先决条件

| 项 | 值 | 说明 |
| --- | --- | --- |
| 插件目录 | `dsh-companion/plugins/companion-media/` | 纯 ESM，无构建步骤 |
| 配置 | `dsh-companion/home/media/config.json` | 缺失时按安全默认（全关）运行 |
| 受管目录 | `dsh-companion/home/media/`（`inbox/`、`artifacts/`、`state/ledger.json`） | 媒体产物与任务/回执账本 |
| 运行日志 | `dsh-companion/logs/media-migration/media-events.jsonl` | 只有 job id、路由、耗时、错误码，无正文 |
| Python | `C:/Python314/python.exe`（含 pydantic / httpx / jsonref） | 只用于生图桥 |
| FFmpeg | `ffmpeg` 在 PATH | 只用于 `atempo` 与 GIF 抽帧 |

## 1. 隔离检查（不碰桌面，不重启桌面）

```powershell
cd C:\Users\bobo\Documents\Bot\dsh-companion\plugins\companion-media
node --test "test/*.test.mjs"          # 52 项单元/mock
node scripts\verify-mount.mjs          # 假宿主挂载：5 个工具、能力全关、无凭据泄漏
node scripts\verify-mock-channel.mjs   # 文字+图片+表情+屏幕+语音+生图拼装+mock 回执
```

隔离预设模板：`plugins/companion-media/deploy/cordis.patch.media-check.yml`。
它把 foundation 与 companion-media 一起挂进 `companion-media-check` 预设，不接 QQ。
**尚未启动过**（启动需要另开一个 `DSH_PROFILE=media-check` 实例）；这条列在"未验收"。

## 2. 真实后端最小验收（已执行）

```powershell
# 需要 8139 协调器在线；首次请求会拉起 Ollama / Breeze，冷启动约 10–30 秒
node scripts\verify-backends.mjs vision   # 本地 nsfwvision
node scripts\verify-backends.mjs tts      # Breeze（march7_B / CFG3 / seed42 / speed0.9）
node scripts\verify-nai-real.mjs          # 生图 dry-run（不花钱）
node scripts\verify-nai-real.mjs --real   # 一次真实生图（会消耗 NovelAI 额度）
```

证据写到 `logs/media-migration/evidence/`，脚本自建临时 ledger 与产物目录，
不写生产 `home/media`，不碰记忆库。

## 3. 在真实桌面上挂载（需要重启桌面，未执行）

1. 备份并记录 hash（已做）：`logs/media-migration/backups/cordis.patch.yml.before-media-migration`，
   hash `D84CEF13043EC960`（前 16 位）。
2. 在 `home/profiles/desktop/cordis.patch.yml` 的 `preset-companion.plugins` 里，
   在 `companion-foundation` 之后插入：

   ```yaml
   - id: companion-media
     name: file:///C:/Users/bobo/Documents/Bot/dsh-companion/plugins/companion-media/index.mjs?media=1
   ```

3. 逐个打开能力（建议顺序：vision → speech → image），每次只改一个开关：

   ```json
   // home/media/config.json
   { "vision": { "enabled": true },
     "speech": { "enabled": true },
     "image":  { "enabled": true, "allowRealGeneration": false } }
   ```

   `allowRealGeneration` 保持 `false` 是**首次挂载**的安全默认；本机现行部署自 2026-10-30 起已置为 `true`（属主明确要求并承担额度）。判断当前值只看
   `home/media/config.json`，或运行 `node scripts/show-runtime-config.mjs`，不要以本文示例为准。

4. 重启桌面（`Start-Desktop.ps1`）。**不要**在用户正在对话时重启。
5. 挂载后先调用 `companion_media_status`，确认能力开关与后端地址，再谈真实使用。

## 4. 回滚

1. 从 `logs/media-migration/backups/cordis.patch.yml.before-media-migration` 恢复 profile 补丁
   （或删掉上面插入的三行），重启桌面。
2. **热关闭（无需重启，已实现并验证）**：把 `home/media/config.json` 里对应能力的 `enabled`
   改成 `false`，保存即可——插件在下一次调用前按文件 mtime 重载配置，
   下一次 `companion_media_status` 就会显示关闭，随后所有调用返回 `MEDIA_DISABLED`。
   注意：文件必须是合法 JSON；写坏的话插件会按安全默认（全关）运行。
3. 保留 `home/media/state/ledger.json` 与 `home/media/artifacts/` 以便对账；
   确认无用后再手工清理。**不要**删除记忆库或关闭 8139 协调服务。

## 5. 已知未验收项

- 桌面重启后的真实挂载（工具在真实宿主里出现、`ctx.attachments` 与 `ctx.llm` 正常）。
- 云 V4.1 识图与语音导演的真实宿主调用（本地脚本没有宿主 LLM 服务）。
- QQ 真实送达、屏幕真实采集、用户主观听感。
- NovelAI 计费（Opus 免费模式开着，API 不回传费用）。
- 真实媒体下载（含 `allowLocal` 本机源）——代码有 SSRF 防护与单测，但没有真实 QQ 媒体来源实测。

## 6. 复核状态（2026-10-28，Codex 第 1 轮）

Codex 判 FAIL，指出额度绕过、超时退款语义、幂等并发、下载解析校验等真缺陷；
处置记录见 `logs/media-migration/REVIEW-codex-round1.md`。修复后测试 66 项全绿，
但能力仍**全部关闭**，未真实挂载。启用前请按该文件 §5 做一次真实挂载冒烟。
