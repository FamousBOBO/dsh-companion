/** tools.v2（P6d）的入口：注册面、档位裁决、切换日说明。
 *
 * 面由 `qq-tools/register.ts` 在开关打开时装配；闸门的档位检查与切换日投递
 * 分别由 `plugin.ts` / `features/inbound` 接线。
 */

export { toolsV2Enabled, buildToolsV2Specs, registerMergedSurface } from './surface.js'
export { tierDenyFor, tierOfSession, type ToolTier } from './tiers.js'
export {
  announceToolsV2Switch, syncToolsRegion, writeToolsRegion, toolsSurfaceStatePath,
  listPersistedQqSessions, TOOLS_SURFACE_VERSION,
} from './notice.js'
export {
  MAPPING, MERGED_TOOL_NAMES, LEGACY_TOOL_NAMES, isLegacyToolName, isMergedToolName,
  faceOf, faceActions, describeFace, faceParameters, renderFaceList, renderMapping,
} from './mapping.js'
export type { Branch, Face } from './types.js'
