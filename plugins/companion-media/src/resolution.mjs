/**
 * Resolution maths: explicit sizes, auto resolution, and validation.
 *
 * Rule agreed in the plan: a value that is out of the backend's declared range
 * is an ERROR, never a silent clamp. `preview()` runs the same function the
 * adapter runs, so what the page shows is what will be sent.
 */

/** Declared capability envelope for NovelAI image models (documented in README). */
export const NAI_SIZE_RULES = Object.freeze({
  multipleOf: 64,
  minEdge: 256,
  maxEdge: 2048,
  maxPixels: 3_000_000,
});

/** Aspect presets offered by the page (width : height). */
export const ASPECTS = Object.freeze({
  square: [1, 1],
  portrait: [2, 3],
  landscape: [3, 2],
  portrait43: [3, 4],
  landscape43: [4, 3],
  wide: [16, 9],
});

/** Parse a `WIDTHxHEIGHT` string; returns null when it is not that shape. */
export function parseSize(value) {
  const match = /^\s*(\d{2,5})\s*[x×]\s*(\d{2,5})\s*$/i.exec(String(value ?? ''));
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height, pixels: width * height };
}

export function formatSize({ width, height }) {
  return `${width}x${height}`;
}

const roundTo = (value, step) => Math.max(step, Math.round(value / step) * step);

/**
 * Auto resolution: spread `targetPixels` over the requested aspect ratio, then
 * snap to the backend grid.
 *
 * The snapping is part of the *computation*, not a post-hoc correction: the
 * preview shows the snapped value, and validation below still has the final say.
 * If the snapped value breaks the envelope the caller gets a typed error naming
 * the offending bound — it is not quietly reduced to fit.
 */
export function autoResolution({ aspect = 'portrait', targetPixels = 1_011_712, rules = NAI_SIZE_RULES } = {}) {
  const ratio = ASPECTS[aspect];
  if (!ratio) {
    return { ok: false, code: 'MEDIA_BAD_INPUT', message: `unknown aspect "${aspect}"; expected one of ${Object.keys(ASPECTS).join('/')}` };
  }
  const target = Number(targetPixels);
  if (!Number.isFinite(target) || target <= 0) {
    return { ok: false, code: 'MEDIA_BAD_INPUT', message: 'targetPixels must be a positive number' };
  }
  const [rw, rh] = ratio;
  const unit = Math.sqrt(target / (rw * rh));
  const width = roundTo(rw * unit, rules.multipleOf);
  const height = roundTo(rh * unit, rules.multipleOf);
  const verdict = validateResolution({ width, height, rules });
  if (verdict.ok) return { ok: true, width, height, pixels: width * height, aspect, targetPixels };
  return { ok: false, ...verdict, width, height, pixels: width * height, aspect, targetPixels };
}

/** Check one resolution against the declared envelope; no clamping. */
export function validateResolution({ width, height, rules = NAI_SIZE_RULES } = {}) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    return { code: 'MEDIA_BAD_INPUT', message: `resolution must be two positive integers, got ${width}x${height}` };
  }
  if (w % rules.multipleOf !== 0 || h % rules.multipleOf !== 0) {
    return {
      code: 'MEDIA_PARAM_OUT_OF_RANGE',
      message: `${w}x${h} is not a multiple of ${rules.multipleOf}; NovelAI models need both edges on the ${rules.multipleOf}px grid`,
    };
  }
  const shortEdge = Math.min(w, h);
  const longEdge = Math.max(w, h);
  if (shortEdge < rules.minEdge) {
    return { code: 'MEDIA_PARAM_OUT_OF_RANGE', message: `short edge ${shortEdge}px is below the declared minimum ${rules.minEdge}px` };
  }
  if (longEdge > rules.maxEdge) {
    return { code: 'MEDIA_PARAM_OUT_OF_RANGE', message: `long edge ${longEdge}px exceeds the declared maximum ${rules.maxEdge}px` };
  }
  if (w * h > rules.maxPixels) {
    return {
      code: 'MEDIA_PARAM_OUT_OF_RANGE',
      message: `${w}x${h} = ${w * h}px exceeds the declared maximum ${rules.maxPixels}px; lower the target resolution instead of expecting a silent resize`,
    };
  }
  return { ok: true, width: w, height: h, pixels: w * h };
}

/**
 * The page's "自动分辨率预览".
 *
 * `mode: 'auto'` computes from aspect+targetPixels; `mode: 'fixed'` validates a
 * literal size. Either way the answer carries every intermediate value so the
 * UI can show, not guess.
 */
export function previewResolution({ mode = 'fixed', size = '', aspect = 'portrait', targetPixels = 1_011_712, rules = NAI_SIZE_RULES } = {}) {
  if (mode === 'auto') {
    const auto = autoResolution({ aspect, targetPixels, rules });
    return {
      mode,
      ok: auto.ok === true,
      size: auto.ok === true ? formatSize(auto) : null,
      width: auto.width ?? null,
      height: auto.height ?? null,
      pixels: auto.pixels ?? null,
      aspect,
      targetPixels,
      rules,
      ...(auto.ok === true ? {} : { error: { code: auto.code ?? 'MEDIA_PARAM_OUT_OF_RANGE', message: auto.message } }),
    };
  }
  const parsed = parseSize(size);
  if (!parsed) {
    return {
      mode,
      ok: false,
      size: String(size ?? ''),
      rules,
      error: { code: 'MEDIA_BAD_INPUT', message: `size must look like 832x1216, got "${size}"` },
    };
  }
  const verdict = validateResolution({ width: parsed.width, height: parsed.height, rules });
  return {
    mode,
    ok: verdict.ok === true,
    size: formatSize(parsed),
    width: parsed.width,
    height: parsed.height,
    pixels: parsed.pixels,
    aspect: null,
    targetPixels: null,
    rules,
    ...(verdict.ok === true ? {} : { error: { code: verdict.code, message: verdict.message } }),
  };
}
