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

/**
 * HTTP status vs body `ok`.
 *
 * They answer different questions and the tests assert them separately:
 *   - HTTP status: was the *request* acceptable? (JSON body, known provider,
 *     `confirm:true`, schema-valid config)
 *   - body `ok`: did the *operation* succeed? A provider that answers 401 makes
 *     the test action succeed with `ok:false` + `code: MEDIA_AUTH_FAILED`; the
 *     endpoint itself is fine (HTTP 200).
 */
const STATUS_BY_CODE = new Map([
  [Code.TOO_LARGE,413],
  [Code.UNSUPPORTED_TYPE,415],
  [Code.BAD_INPUT, 400],
  [Code.CONFIG_INVALID, 400],
  [Code.PROVIDER_UNKNOWN, 400],
  [Code.NOT_CONFIGURED, 400],
  [Code.DISABLED, 400],
  [Code.PROVIDER_NOT_IMPLEMENTED, 400],
  [Code.VISION_LOCKED, 400],
  [Code.PARAM_OUT_OF_RANGE, 400],
  [Code.DOWNLOAD_BLOCKED, 403],
]);

function statusForFailure(error) {
  const code = error?.code;
  return STATUS_BY_CODE.get(code) ?? 500;
}

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
      return json({ ok: false, error: failure }, statusForFailure(failure));
    }
  };

  return {
    [`POST ${API_PREFIX}/reference-audio`]: wrap(async request => {
      const id=new URL(request.url).searchParams.get('provider');
      const chunks=[];let size=0;
      for await (const chunk of request.body || []) {size+=chunk.length;if(size>16*1024*1024)return json({ok:false,error:{code:Code.TOO_LARGE,message:'参考音频需小于16MB'}},413);chunks.push(Buffer.from(chunk));}
      const result=await service.uploadReference({id,bytes:Buffer.concat(chunks)});
      return json(result);
    }),
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
      const kind = body.kind === 'tts' ? 'tts' : body.kind === 'image' ? 'image' : null;
      if (!kind) return json({ ok: false, error: { code: Code.BAD_INPUT, message: 'kind 必须是 image 或 tts' } }, 400);
      const id = String(body.id ?? '').trim();
      if (!id) return json({ ok: false, error: { code: Code.BAD_INPUT, message: '缺少 provider id' } }, 400);
      // 未知 provider 是请求错误（400），provider 自己失败是 body.ok=false（200）。
      const catalog = kind === 'image' ? service.status().catalog.image : service.status().catalog.tts;
      const canonical = kind === 'image'
        ? (id === 'openai' ? 'openai-compatible' : id)
        : (id === 'breeze-tts-2' ? 'breeze-tts2' : id);
      if (!catalog.some(item => item.id === canonical)) {
        return json({ ok: false, error: { code: Code.PROVIDER_UNKNOWN, message: `未知 provider：${id}` } }, 400);
      }
      const result = await service.testProvider({ kind, id: canonical });
      return json(result, 200);
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
        context: String(body.context ?? ''),
        signal: request.signal,
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
      const result = await service.synthesize({ text: String(body.text ?? ''), provider: body.provider ? String(body.provider) : null,context:String(body.context??''),instructions:String(body.instructions??''),signal:request.signal });
      return json(result, result.ok ? 200 : 400);
    }),
    // Vision is contract-only: every method on this path is a refusal, including
    // a hypothetical POST, so no UI bug can turn it into a working call.
    [`GET ${API_PREFIX}/vision`]: wrap(async () => json(service.inspectImage())),
    [`POST ${API_PREFIX}/vision`]: wrap(async () => json(service.inspectImage(), 400)),
  };
}

/**
 * Register on the host Connection.
 *
 * A composition without `connection` skips the API for now: the tools still
 * work, the page just has no backend yet. `connection` is provided
 * **asynchronously** by its own row, so "missing right now" does not mean
 * "missing forever" — the caller (`index.mjs`) retries through `ctx.inject`
 * when this returns `skipped: 'no-connection'`. Returning a typed result instead
 * of throwing keeps a missing service from aborting activation.
 *
 * Registration is idempotent per path: the host keys registrations by path, so
 * a second attempt overwrites instead of duplicating. One failing path must not
 * abort the rest, hence the per-path try/catch and the `failed` list.
 */
export async function registerMediaApi(ctx, service, { effect: wantEffect = true } = {}) {
  const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined;
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    return { registered: 0, skipped: 'no-connection', paths: [], failed: [] };
  }
  const handlers = createMediaHandlers(service);
  // `ctx.effect` ties the registration's lifetime to the plugin's fiber, which is the right
  // default — but it throws ("cannot create effect on inactive context") once apply has returned.
  // The late-registration poll runs exactly in that window, so it asks for a plain registration
  // instead of losing every route; the host still owns the registrations for the process lifetime.
  const effect = wantEffect && typeof ctx.effect === 'function' ? ctx.effect : runner => runner();
  const byPath = new Map();
  for (const key of Object.keys(handlers)) {
    const [method, path] = key.split(' ');
    const entry = byPath.get(path) ?? { path, methods: [], handlers: new Map() };
    entry.methods.push(method);
    entry.handlers.set(method, handlers[key]);
    byPath.set(path, entry);
  }
  let registered = 0;
  const failed = [];
  for (const entry of byPath.values()) {
    try {
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
        // No label argument: this Cordis build rejects `effect(cb, 'string')` with "Invalid effect".
      );
      registered += 1;
    } catch (error) {
      // 宿主按 path 去重：重复登记同一 path 会覆盖。这里的 catch 只是保证
      // "一条路由出问题"不会连带其它路由一起消失。
      failed.push({ path: entry.path, message: String(error?.message ?? error).slice(0, 200) });
    }
  }
  return { registered, paths: [...byPath.keys()], failed };
}
