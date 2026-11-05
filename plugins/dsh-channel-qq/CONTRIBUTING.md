# 贡献指南

## 开始之前

```bash
npm install
npm run verify   # 提交前必须全绿
```

`npm run verify` 依次跑：后台前端产物一致 → 脚本语法 → 类型检查 → 全部测试 →
分层规则（R1–R8）→ 体积棘轮。任何一步红了都不要提交。

## 几条硬规则

1. **默认关**：任何会改变线上行为的升级都必须带独立开关、默认关。关着时输出与旧版
   逐字节一致（`test/golden/**` 会盯着）。
2. **分层**：
   - `src/core/` 与 `src/app/` 可重放——**不读时钟、不掷随机、不 import 宿主包**；
     需要时间/随机一律从参数注入。
   - 宿主包（`@deepseek-ai/*`）的 import 只允许出现在 `src/adapters/`；
     新增要先改 `scripts/layers-baseline.json` 并说明理由。
   - 写文件一律走 `atomicWriteFile`（只有 `src/adapters/fs-store/` 可以直接 `writeFile`）。
3. **不新增运行时依赖**。可用：`silk-wasm`、`ws` 与 Node 内置模块。
4. **体积棘轮**：单文件 ≤400 行、单函数 ≤60 行，只减不增；不要用 `--update` 放水。
5. **配置**：新增配置项要同时给中文标签、默认值、生效方式；页面归属写进
   `src/config/pages.ts`。

## 测试

- 纯逻辑放 `test/` 顶层，文件头写清"这条测试防的是什么"。
- 需要真实协议的路径，优先用假件（`test/fakes/`）而不是起真服务。
- 界面改动跑 `npm run probe:admin`（headless Chrome，4 个宽度 × 26 个路由）。

## 提交信息

中文，一行标题 + 正文回答"为什么"（不是"改了什么"）。若行为有变化，写清
"关着开关时的行为"与"打开后的行为"。

## 许可

提交即表示同意以 [MIT](LICENSE) 发布你的贡献。
