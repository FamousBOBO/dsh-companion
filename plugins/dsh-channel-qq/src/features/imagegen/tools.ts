/** 生图工具面：3 个工具（生成并发送 / 只生成保存 / 查看后端配置）。
 *
 * 这些 spec **逐字节**来自原来的 `src/imagegen.ts`——P4 的判据是工具名与参数
 * schema 一条都不许变（`test/golden/tools/other-tools.txt` 钉着这一点）。
 * 生图实现（provider）在 `adapters/providers/imagegen.ts`：调外部服务、落盘、
 * 返回 `ImageGenResult`；这里只管"模型怎么调用它"。
 *
 * 一个工具一个函数：单看一个工具时不必在长文件里找它的边界。
 */

import { registerSpecs, params, type ToolHost, type ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQChannelConfig } from '../../config.js'
import type { ChatPlatform } from '../../ports/platform.js'
import type { OutboundQueue } from '../../outbound.js'
import type { OneBotMessageSegment } from '../../types.js'
import { napcatFileArg } from '../../local-file.js'
import { generateImage, requireConfig, resolveOutDir, type ImageGenResult } from '../../adapters/providers/imagegen.js'

interface ImageTarget {
  isGroup: boolean
  id: number
}

/**
 * 解析发送目标：优先工具参数；**只有明确说"发群"时**才回落到配置的主群。
 *
 * 为什么不再无条件回落：模型在私聊里省略 target 时，旧逻辑会发进主群——
 * 私聊内容串到群里（2026-10-19 排查）。宁可报错让它补 target，也不猜。
 */
function resolveTarget(args: Record<string, unknown>, config: QQChannelConfig): ImageTarget {
  const raw = typeof args.target === 'number' ? args.target : Number.parseInt(String(args.target ?? ''), 10)
  const isGroup = args.isGroup !== false
  if (Number.isFinite(raw) && raw > 0) return { isGroup, id: raw }
  if (args.isGroup === true && config.primaryGroup !== null) return { isGroup: true, id: config.primaryGroup }
  throw new Error('没指定 target：请给出 target（群号或好友 QQ 号）并明确 isGroup。省略 target 只会在 isGroup=true 时回落到主群。')
}

/** 三个 spec 共享的接线：注册时构造一次，闭包写法与原来一致。 */
interface ImageGenToolDeps {
  config: QQChannelConfig
  platform: ChatPlatform
  out: OutboundQueue
  log: (line: string) => void
  /** 生图落盘目录，注册时解析一次（与原来相同）。 */
  outDir: string
  /** 配置里关掉生图时给出拒绝结果，否则 null。 */
  disabled: () => Record<string, unknown> | null
  /** 生成一张图：校验与落盘都在 provider 的 generateImage 里。 */
  runGenerate: (args: Record<string, unknown>) => Promise<ImageGenResult>
}

/** `qq_generate_image` — 按提示词生成一张 AI 图片并直接发到当前会话。 */
function qqGenerateImage(deps: ImageGenToolDeps): ToolSpec {
  const { config, platform, out, log, disabled, runGenerate } = deps
  return {
    name: 'qq_generate_image',
    description: '按提示词生成一张 AI 图片并直接发到当前会话。什么时候用：群里有人说"画一个/来张图/生成图片"时。**优先写英文提示词**，同一句话英文版细节更准、构图更稳（中文也能画，但常常偏抽象）；提示词里写清主体 + 风格 + 氛围（例："a fluffy orange cat sleeping on a windowsill, soft morning light, watercolor"）。想先看效果再决定发不发，改用 qq_generate_image_save。生图要 10~40 秒，别催。',
    parameters: params({
      prompt: { type: 'string', description: '绘图提示词，建议英文，写清主体/风格/氛围' },
      isGroup: { type: 'boolean', description: '发到群聊还是私聊，默认群聊' },
      target: { type: 'number', description: '群号或好友QQ号；省略时仅在 isGroup=true 下回落到主群（私聊请务必给出 target）' },
    }, ['prompt']),
    run: async (args) => {
      const off = disabled()
      if (off !== null) return off
      const target = resolveTarget(args, config)
      const result = await runGenerate(args)
      log(`imagegen: sending ${result.file} → ${target.isGroup ? 'group' : 'dm'} ${target.id}`)
      const message: OneBotMessageSegment[] = [{ type: 'image', data: { file: await napcatFileArg(result.file) } }]
      // out.push 会等限流队列的轮次，所以这里 await 得到真实发送结果。
      await out.push(() => platform.api.sendTo(target.isGroup, target.id, message))
      return { ok: true, result }
    },
  }
}

/** `qq_generate_image_save` — 只生成图片保存到磁盘，不发送。 */
function qqGenerateImageSave(deps: ImageGenToolDeps): ToolSpec {
  const { disabled, runGenerate } = deps
  return {
    name: 'qq_generate_image_save',
    description: '只生成图片保存到磁盘，不发送。什么时候用：你想先确认画得对不对、或者要拿文件路径去做别的事（比如拼进相册/给别的工具用）时。返回绝对路径，真要发出去再调 qq_generate_image 或让主控发。',
    parameters: params({
      prompt: { type: 'string', description: '绘图提示词，建议英文' },
    }, ['prompt']),
    run: async (args) => {
      const off = disabled()
      if (off !== null) return off
      const result = await runGenerate(args)
      return { ok: true, file: result.file, bytes: result.bytes, result, note: '已保存未发送，要发到群里就用 qq_generate_image。' }
    },
  }
}

/** `qq_imagegen_models` — 查当前生图后端（provider/model/分辨率）。 */
function qqImagegenModels(deps: ImageGenToolDeps): ToolSpec {
  const { config, outDir } = deps
  return {
    name: 'qq_imagegen_models',
    description: '查当前生图后端是什么（provider/model/分辨率）。什么时候用：生图失败想确认是不是后端配错了、或者学弟问"现在用哪个模型画图"时。',
    parameters: params({}),
    run: async () => {
      const imageGen = requireConfig(config)
      const note = imageGen.provider === 'pollinations'
        ? '当前走 pollinations 免 key 公开端点（本机 LLM 网关没有 /v1/images/generations，实测 404）。要换自建/中转端点，把 provider 改成 openai 并填 baseUrl + model。'
        : `当前走 OpenAI 兼容端点 ${imageGen.baseUrl ?? '(baseUrl 为空，会直接报错)'}，model=${imageGen.model}。`
      return {
        enabled: imageGen.enabled,
        provider: imageGen.provider,
        model: imageGen.model,
        baseUrl: imageGen.baseUrl,
        width: imageGen.width,
        height: imageGen.height,
        outDir,
        note,
      }
    },
  }
}

/** 注册生图工具。返回 disposer。 */
export function registerImageGenTools(
  ctx: ToolHost,
  config: QQChannelConfig,
  platform: ChatPlatform,
  out: OutboundQueue,
  log: (line: string) => void,
): () => void {
  log(`imagegen: tools loaded (client ${platform.isConnected() ? 'connected' : 'not connected yet'})`)
  const outDir = resolveOutDir(config)

  const disabled = (): Record<string, unknown> | null => (
    config.imageGen?.enabled === false ? { ok: false, note: '生图已在配置里关闭' } : null
  )
  const runGenerate = async (args: Record<string, unknown>): Promise<ImageGenResult> => {
    const prompt = String(args.prompt ?? '')
    if (prompt.trim() === '') throw new Error('prompt 不能为空，写上要画什么（建议英文提示词）。')
    return generateImage(prompt, { config: requireConfig(config), outDir, log })
  }

  const deps: ImageGenToolDeps = { config, platform, out, log, outDir, disabled, runGenerate }
  const specs: ToolSpec[] = [qqGenerateImage(deps), qqGenerateImageSave(deps), qqImagegenModels(deps)]
  return registerSpecs(ctx, specs, log, 'imagegen')
}
