# companion-runtime（`@dsh-companion/runtime`）

陪伴套件的**认知运行时**：日程（agenda / CAS / 恢复）、心跳结算、目标与承诺、判断（beliefs）、
工作记忆、P2 规划与活动、事件书与出站队列。数据在 `<dataRoot>/home/companion/companion-runtime.db`
（SQLite，`node:sqlite`），**必须 Node ≥ 24**。

## 与别的模块的关系

- 由 `companion-foundation` 通过 `mountRuntime(ctx, root)` 挂载，`root` 是套件数据根；
  也可以作为独立插件挂载，此时 `apply()` 用 `suite-paths.mjs` 解析数据根（D2）。
- 记忆写入走出站队列（`memory_outbox`）交给 `companion-memory`，运行时不直接开记忆库。
- 不发消息：分享候选只进账本，真正发送属于 QQ 通道。

## 默认状态

所有「自己会动」的能力默认关闭，由 `<dataRoot>/home/companion/runtime.config.json` 打开：
`agenda.enabled`、`heartbeat.enabled`、`p2.planning.enabled`、`p2.activities.enabled`。
配置缺失 = 全部关闭，不发起任何后台模型请求。

## 入口

- `index.mjs`：`apply(ctx)` / `mountRuntime(ctx, root, ports)`。
- `lib/scope.mjs`：作用域（`u:<userId>|p:<personaId>|w:<worldId>`）；默认人格 id 由
  `DSH_COMPANION_PERSONA_ID` 覆盖，缺省 `bot`。身份只由宿主绑定的 binding 传入，绝不从文本推断。

## 测试

```bash
node --test "test/*.test.mjs"
```

全部离线：临时目录建库、无网络、无宿主依赖。
