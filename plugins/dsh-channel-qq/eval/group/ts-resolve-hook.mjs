/**
 * 解析钩子：把 TypeScript 源码里写死的 `./x.js` 说明符映射到同名的 `./x.ts`。
 *
 * 只在 adapter 直接加载 `src/` 下的 .ts（没有构建产物时的退路）时用到；
 * 加载 `build/lib` 的 .js 时这条钩子一次都不会命中。
 *
 * 为什么需要它：仓库的 TS 源码按 NodeNext 规则写 `./group-persona.js`（编译产物名），
 * Node 24 的类型剥离能直接跑 .ts，但**不会**替你做 .js → .ts 的文件名映射。
 */

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    if (!specifier.endsWith('.js')) throw error
    if (!(context.parentURL ?? '').endsWith('.ts')) throw error
    return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
  }
}
