/**
 * 仅构建 client bundle 的 tsdown 配置（build.sh 用）。
 *
 * ── 为什么需要单独一份（2026-10-16）─────────────────────────────────────
 * 仓库有两套构建，产出**不同形态**的 lib/index.js，不可混用：
 *
 *   · `tsc`（scripts/build.sh）→ ~238 KB，**保留外部 import**，
 *     运行时从 node_modules 解析依赖。用于本地开发（junction 链着依赖）。
 *
 *   · `tsdown` 的 hostBundle（tsdown.config.ts）→ ~453 KB，
 *     把 @deepseek-ai/* 全部**打进单文件**（零外部依赖）。
 *     这是发布形态 —— prepare.mjs 在 npm/git 安装时跑的就是它，
 *     目的是「官方装配不装 peers 时也能加载」（见 tsdown.config.ts 注释）。
 *
 * ⚠️ 实测踩坑：build.sh 里若直接跑 `tsdown --config tsdown.config.ts`，
 * 它会**同时重建 host 与 client**，把 tsc 刚产出的 238KB 版本覆盖成 453KB
 * 打包版 —— 等于悄悄改变了本地 dev 构建的语义（部署到活跃路径后行为不同）。
 * 正解：build.sh 只用本配置构建 **client**，host 仍由 tsc 产出。
 * 发布形态仍由 prepare.mjs + tsdown.config.ts 负责，两条路径互不干扰。
 */
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@dsh-external/dsh-super-injector'

const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-runtime/client',
]

const clientBundle: UserConfig = {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default clientBundle
