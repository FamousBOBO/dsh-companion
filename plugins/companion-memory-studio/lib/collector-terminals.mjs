import path from 'node:path';
import { ApiError } from './api-kernel.mjs';

const failures = {
  'collector-disabled': '请先启用该采集器。',
  'collector-config': '采集器的本机配置不完整，请检查 Python 路径和端口。',
  'collector-account': '找不到华为健康授权文件，请检查本机配置。',
  'collector-port-conflict': '两个采集器不能使用同一个端口。',
  'collector-port-occupied': '端口仍被占用，请检查现有进程。',
};

export async function collectorTerminals(request, kernel) {
  kernel.viewer(await kernel.internal());
  const home = path.resolve(process.env.DSH_HOME || path.join(kernel.root, 'home'));
  const controller = globalThis[Symbol.for('dsh-companion.health-collector-controllers')]?.get(home);
  if (request.method === 'GET' && !controller) return kernel.ok({ available: false, collectors: [] });
  if (!controller) return kernel.fail('collector-unavailable', 'DSH 未加载采集器持久终端。', { status: 409 });

  let key, action, enabled;
  if (request.method === 'POST') {
    const type = request.headers.get('content-type')?.split(';')[0].trim();
    const site = request.headers.get('sec-fetch-site');
    if (type !== 'application/json' || (site && site !== 'same-origin' && site !== 'none')) {
      return kernel.fail('denied', '请在陪伴空间内操作。', { status: 403 });
    }
    ({ key, action, enabled } = await kernel.body(request));
    if (!['cloud', 'ble'].includes(key) || !['start', 'restart', 'stop', 'set-enabled'].includes(action)
      || (action === 'set-enabled' && typeof enabled !== 'boolean')) {
      throw new ApiError('bad-request', '无效的采集器操作。', 400);
    }
  }

  try {
    return kernel.ok(action ? await controller.control(key, action, enabled) : await controller.status());
  } catch (error) {
    const code = Object.hasOwn(failures, error.message) ? error.message : 'collector-failed';
    return kernel.fail(code, failures[code] ?? '采集器操作失败，请查看 DSH 后台日志。', { status: code === 'collector-failed' ? 500 : 409 });
  }
}
