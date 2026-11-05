/**
 * 类型补充声明（shim）。
 *
 * 背景：`@deepseek-ai/cordis-plugin-loader` 与 `@deepseek-ai/dsh-system-prompt`
 * 的 npm 发布物**不含 .d.ts**（已核实：app 与隔离 checkout 里 d.ts 数均为 0），
 * 而本插件只把它们当**结构化类型**用（`import type`，不取运行时值）。
 * 于是 tsc 报 TS7016（隐式 any）。
 *
 * 策略：声明为**宽松接口**——足以消除 TS7016，同时不试图精确建模上游形状
 * （精确建模会牵出上游内部类型，反而把本插件与上游实现细节耦合）。
 * 本插件对这些对象只做动态访问（entries()/internal/import/create/parent…），
 * 运行期由 loader 保证形状。
 *
 * ⚠️ 若上游将来补发正式 .d.ts，本文件应删除（正式类型优先）。
 */

declare module '@deepseek-ai/cordis-plugin-loader' {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  export default interface Loader {
    entries(): any
    create(options: any): any
    import(specifier: string, parent?: any): any
    internal?: any
    [key: string]: any
  }
}

declare module '@deepseek-ai/dsh-system-prompt' {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  export default interface SystemPrompt {
    [key: string]: any
  }
}
