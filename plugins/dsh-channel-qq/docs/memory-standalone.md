# 记忆库插件化：独立使用

`src/standalone-memory.ts` 把记忆核心（`core/memory` + `features/memory`）以普通工厂函数
暴露，让它在 cordis 插件宿主之外也能直接使用。

## 适用场景

- 把记忆能力接入**另一个宿主**（其他 bot 框架、自研 agent、CLI）；
- 在测试夹具里直接构造记忆库，不拉起整个 cordis 运行时；
- 把记忆库作为可复用子模块，供多个项目共享。

## 零框架依赖

只依赖：

- `node:fs` / `node:path` / `node:crypto`（Node 内置）
- 仓库内模块：`core/memory/*`、`features/memory/*`、`adapters/fs-store/*`、`ports/memory.ts`

不 import `@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm` 或任何宿主服务。

## 用法（Node 22+ ESM）

```ts
import { createMemoryV2 } from 'dsh-channel-qq/build/lib/standalone-memory.js'

const mem = await createMemoryV2({
  dshHome: process.env.DSH_HOME ?? `${os.homedir()}/.dsh`,
  workspacePath: '/path/to/workspace',
  log: (line) => console.log('[memory]', line),
  // 可选：双写旧 KnowledgeStore（entries.json），平滑迁移
  legacyWriter: { addMany: async (items) => items.length },
  // 可选：注入预算；不传用 core 默认值（0.35 / 8 条 / 600 字）
  budget: { threshold: 0.35, maxRecords: 8, maxChars: 600 },
})

// 每回合证据注入（组包前）
const evidence = await mem.evidence({ text: '今天想喝什么咖啡', room: 'qq-group-1000000003', isGroup: true })

// 主动写入 / 召回
await mem.memorize({ content: '用户喜欢黑咖啡不加糖', kind: 'preference', tags: ['咖啡'] })
const hits = await mem.recall({ query: '咖啡', limit: 5 })
```

## 行为约定

- 证据注入与插件一致：**排除 600 字原文块**（`tags: ['chunk']`），只给一句话事实；
- 日期渲染只到天（`YYYY-MM-DD`），与插件证据同口径；
- 不传 `embed` 时走关键词检索；向量路径需要自己实现 `EmbedPort`；
- 与插件共享同一套存储格式（`<workspace>/knowledge/records.jsonl`），可平滑互迁。

## 与插件主体的关系

插件主体仍走 cordis 装配；本入口是同一实现的第二种装配方式。新增功能只落在
`core/memory` / `features/memory` 时，两侧自动同时获得。
