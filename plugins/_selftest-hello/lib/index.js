// 注入器自检用最小插件：纯 ESM JS，不需要任何构建步骤。
// 用途：验证 dev_inject_plugin → 工具真注册 → dev_uninject_plugin 干净卸载。
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'injector-selftest-hello'
export const inject = ['tools']

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'selftest_hello',
          description: '注入器自检用的 echo 工具：回显一句话，证明运行时注入全链路通畅。',
          parameters: {
            text: { type: 'string', required: true, description: '要回显的文本' },
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
          },
          async execute(args) {
            return `injected-ok: ${String(args?.text ?? '')} @ ${new Date().toISOString()}`
          },
        }),
      ),
    'selftest-hello:tool',
  )
}
