# 架构

## 分层

```
src/
  core/        纯逻辑。可重放：不读时钟、不掷随机、不碰宿主与网络。
  app/         应用层：入站流水线、组包、回合、策略。依赖端口，不认识宿主。
  features/    子插件。每个功能一个目录，自己装配、自己提供/消费服务。
  adapters/    外部世界的实现：OneBot、HTTP、文件、人格包、dsh 宿主。
  config/      配置 schema 与页面清单（后台 UI 的单一事实来源）。
  plugins/     组合根：解析配置、按段挂载子插件、热重载。
```

依赖方向只能**从上往下**（`plugins → features → app → core`），宿主包
（`@deepseek-ai/*`）只允许出现在 `adapters/`。这两条由 `npm run check:layers`
（R1–R8）机械校验，违反即失败。

## 一条消息的旅程

```
SnowLuma（OneBot v11 WS）
   │  event
   ▼
adapters/onebot        解析帧、心跳、重连
   ▼
app/inbound/pipeline   准入 → 管理员命令（不经模型）→ 解析 → 组包
   ▼
features/proactive?    群聊准入（planner）在这里决定"要不要说话"
   ▼
app/conversation/turns 攒批 / 安静窗口 / 概率门 → 提交给宿主 agent
   ▼
dsh agent（模型 + 工具）
   ▼
features/qq-tools      工具调用 → QQApi → SnowLuma
   ▼
app/outbound           分句、去重、速率限制、失败重试
```

## 几个关键决定

- **默认关**：每个改变行为的升级都带独立开关，关着时输出与旧版逐字节一致
  （`test/golden/**` 盯着）。这让"上线"可以一站一站来，也随时能回退。
- **配置三层**：内置默认 → `cordis.patch.yml`（部署）→ 后台覆盖（`admin-config.json`）。
  后一层永远赢，所以运维不必为了改一个值重启进程。
- **人格即数据**：面向模型的文案全部在 `assets/persona/`，代码只负责"什么时候拼哪一段"。
- **宿主隔离**：业务代码只认识 `src/ports/` 里的端口；换宿主/换协议只改 `adapters/`。
- **可重放**：`core/` 与 `app/` 不读时钟、不掷随机，测试因此可以逐字节比对。

## 往哪里加东西

| 想做的事 | 落在哪 |
|---|---|
| 新工具 | `src/features/<模块>/tools.ts`（走 `tool-kit` 注册） |
| 新配置项 | `src/config/sections/*.ts` + 页面归属 `src/config/pages.ts` |
| 新后台页面 | `src/admin/ui/pages/` + `ADMIN_PAGES` 一条 |
| 定时任务 | 事件书 `core/schedule/event-book.ts` 加一条（数据，不是代码） |
| 新平台/协议 | `src/adapters/` 加一个目录，实现 `ChatPlatform` 端口 |
