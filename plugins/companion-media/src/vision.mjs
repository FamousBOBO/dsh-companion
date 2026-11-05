import { Code } from './errors.mjs';

/**
 * The vision contract — and nothing else.
 *
 * The plan is explicit: 识图默认关闭，且「工具、页面按钮、自动流程都不能」绕过。
 * So this module has no network code, no provider, and no path to call one. It
 * exposes the *shape* a future implementation must satisfy plus a refusal used
 * by every entry point.
 *
 * There is deliberately no `inspect()` tool registration in this plugin: the
 * only way to reach vision is through this refusal.
 */

export const VISION_STATUS = 'reserved-disabled';

export function visionContract(config = {}) {
  return {
    status: VISION_STATUS,
    enabled: false,
    // `locked` is what the UI shows and what validation enforces; it is not a
    // user-settable switch.
    locked: true,
    label: '识图（预留，当前关闭）',
    note: '本期只保留合同：配置项可保存，但工具、页面按钮和任何自动流程都不能发起识图调用。启用实现需单独阶段审批。',
    config: {
      baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
      model: typeof config.model === 'string' ? config.model : '',
      timeoutMs: config.timeoutMs ?? null,
      apiKeyConfigured: Boolean(String(config.apiKey ?? '').trim()),
    },
    future: {
      kind: 'vision.inspect',
      input: { source: 'local-file | bytes', prompt: 'string', maxChars: 'number' },
      output: { text: 'string', model: 'string', width: 'number', height: 'number' },
      constraints: [
        '只允许合成测试图与用户明确授权的图片',
        '不得把个人图片写入仓库或日志',
        '响应体与图像字节上限沿用 media.limits',
        '失败返回错误码，不得猜测画面内容',
      ],
    },
  };
}

/** Every vision entry point answers this. There is no other path. */
export function visionRefusal() {
  return {
    ok: false,
    error: {
      code: Code.DISABLED,
      message: '识图本期只保留合同（默认关闭且不可绕过），没有任何工具或接口能发起识图调用',
    },
    contract: visionContract(),
  };
}
