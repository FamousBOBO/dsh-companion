/**
 * Package entry — a thin forwarder.
 *
 * Why this file exists: the preset patch mounts `plugins/companion-expression/index.mjs` (a `file://`
 * URL has to point at a real file at the package root, like every other module in this suite), while
 * the implementation lives under `src/` so it can be split per concern. `scripts/doctor.mjs` also
 * checks `<module>/index.mjs` as the entry, and `companion-media`/`companion-health` use the same
 * "root entry, real code inside" shape.
 *
 * No logic here on purpose: anything that needs explaining is in `src/index.mjs`, where it sits next
 * to the code it explains.
 */
export {
  name, inject, version, PORT_SYMBOL, MODULE_ENV,
  apply, createService, moduleGate, parametersToJsonSchema,
} from './src/index.mjs';

export { createService as createExpressionService } from './src/index.mjs';

export { default } from './src/index.mjs';
