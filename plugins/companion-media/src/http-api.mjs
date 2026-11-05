import { Code, toFailure } from './errors.mjs';
import { mediaPageDescriptor } from './ui-page.mjs';

/**
 * Host HTTP API for the media capability page.
 *
 * Registered on the host's authenticated Connection service (same mechanism the
 * memory studio uses), so every route is reachable only from the local,
 * already-authenticated DSH shell. No CORS header is sent, and cross-site
 * `Origin` values are refused outright — a browser page from another origin can
 * never drive a billable generation.
 */

export const API_PREFIX = '/api/companion-media';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

function originAllowed(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // same-origin fetch from the shell sends no Origin on GET
  return LOCAL_ORIGIN.test(origin);
}

async function readJson(request) {
  try {
    const text = await request.text();
    if (!text.trim()) return {};
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Build the route table. Exported separately from the registration so tests can
 * drive the handlers without a host.
 */
export function createMediaHandlers(service) {
  const wrap = handler => async request => {
    try {
      if (!originAllowed(request)) {
        return json({ ok: false, error: { code: Code.DOWNLOAD_BLOCKED, message: '跨站请求被拒绝' } }, 403);
      }
      return await handler(request);
    } catch (error) {
      const failure = toFailure(error);
      return json({ ok: false, error: failure }, 500);
    }
  };

  return {
    [`GET ${API_PREFIX}/status`]: wrap(async () => json({ ok: true, ...service.status() })),
    [`GET ${API_PREFIX}/config`]: wrap(async () => json(service.readConfig())),
    [`POST ${API_PREFIX}/config`]: wrap(async request => {
      const body = await readJson(request);
      if (body === null) return json({ ok: false, error: { code: Code.BAD_INPUT, message: '请求体不是 JSON' } }, 400);
      const result = service.saveConfig(body.patch ?? body);
      return json(result, result.ok ? 200 : 400);
    }),
    [`POST ${API_PREFIX}/test`]: wrap(async request => {
      const body = await readJson(request);
      if (body === null) return json({ ok: false, error: { code: Code.BAD_INPUT, message: '请求体不是 JSON' } }, 400);
      const kind = body.kind === 'tts' ? 'tts' : 'image';
      const id = String(body.id ?? '').trim();
      if (!id) return json({ ok: false, error: { code: Code.BAD_INPUT, message: '缺少 provider id' } }, 400);
      const result = await service.testProvider({ kind, id });
      return json(result, result.ok ? 200 : 200);
    }),
    [`GET ${API_PREFIX}/page`]: wrap(async () => json({ ok: true, page: mediaPageDescriptor(service.status()) })),
    [`GET ${API_PREFIX}/preview`]: wrap(async request => {
      const url = new URL(request.url);
      return json({
        ok: true,
        ...service.preview({
          mode: url.searchParams.get('mode') === 'auto' ? 'auto' : 'fixed',
          size: url.searchParams.get('size') ?? '',
          aspect: url.searchParams.get('aspect') ?? 'portrait',
          targetPixels: Number(url.searchParams.get('targetPixels') ?? 1_011_712),
          model: url.searchParams.get('model') ?? 'nai-diffusion-4-5-full',
        }),
      });
    }),
    [`GET ${API_PREFIX}/jobs`]: wrap(async request => {
      const url = new URL(request.url);
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 10) || 10));
      return json({ ok: true, ...service.jobs(limit) });
    }),
    /**
     * Billable generation. Two independent gates: `confirm:true` (the human
     * pressed the button) and the config's own `image.enabled` + provider
     * switch. Neither auto-retry nor a bare API call can spend money.
     */
    [`POST ${API_PREFIX}/image`]: wrap(async request => {
      const body = await readJson(request);
      if (body === null) return json({ ok: false, error: { code: Code.BAD_INPUT, message: '请求体不是 JSON' } }, 400);
      if (body.confirm !== true) {
        return json(
          { ok: false, error: { code: Code.DISABLED, message: '生成图片会消耗额度：请求必须带 confirm:true（由页面按钮或操作者显式确认）' } },
          400,
        );
      }
      const result = await service.generateImage({
        prompt: String(body.prompt ?? ''),
        negative: String(body.negative ?? ''),
        dryRun: body.dryRun === true,
      });
      return json(result, result.ok ? 200 : 400);
    }),
    [`POST ${API_PREFIX}/speech`]: wrap(async request => {
      const body = await readJson(request);
      if (body === null) return json({ ok: false, error: { code: Code.BAD_INPUT, message: '请求体不是 JSON' } }, 400);
      if (body.confirm !== true) {
        return json({ ok: false, error: { code: Code.DISABLED, message: '合成语音可能计费：请求必须带 confirm:true' } }, 400);
      }
      const result = await service.synthesize({ text: String(body.text ?? ''), provider: body.provider ? String(body.provider) : null });
      return json(result, result.ok ? 200 : 400);
    }),
    // Vision is contract-only: every method on this path is a refusal, including
    // a hypothetical POST, so no UI bug can turn it into a working call.
    [`GET ${API_PREFIX}/vision`]: wrap(async () => json(service.inspectImage())),
    [`POST ${API_PREFIX}/vision`]: wrap(async () => json(service.inspectImage(), 400)),
  };
}

/**
 * Register on the host Connection. A composition without `connection` simply
 * skips the API: the tools still work, the page just has no backend.
 */
export async function registerMediaApi(ctx, service) {
  const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined;
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    return { registered: 0, skipped: 'no-connection' };
  }
  const handlers = createMediaHandlers(service);
  const effect = typeof ctx.effect === 'function' ? ctx.effect : runner => runner();
  const byPath = new Map();
  for (const key of Object.keys(handlers)) {
    const [method, path] = key.split(' ');
    const entry = byPath.get(path) ?? { path, methods: [], handlers: new Map() };
    entry.methods.push(method);
    entry.handlers.set(method, handlers[key]);
    byPath.set(path, entry);
  }
  let registered = 0;
  for (const entry of byPath.values()) {
    effect(
      () => connection.fetch.register({
        path: entry.path,
        methods: entry.methods,
        requestBody: 'buffered',
        fetch: request => {
          const handler = entry.handlers.get(request.method);
          if (!handler) {
            return json({ ok: false, error: { code: Code.BAD_INPUT, message: `该路径只支持 ${entry.methods.join(' / ')}` } }, 405);
          }
          return handler(request);
        },
      }),
      `companion-media: ${entry.path}`,
    );
    registered += 1;
  }
  return { registered, paths: [...byPath.keys()] };
}
