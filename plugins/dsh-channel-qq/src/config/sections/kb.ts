/** 知识库段：用户资料/网页/图片的摄取与检索（page: kb）。
 *
 * 与记忆、技能的分工：
 *   - 记忆 = 一句话事实（自动注入、会衰减）；
 *   - 知识库 = 用户给的原文（分块、带出处、按需检索）；
 *   - 技能 = 做事步骤（显式加载）。
 */

import { b, n, s, type FieldGroup } from '../dsl.js'

export interface KbConfig {
  /** 总开关：关掉后不扫描、不检索、工具返回「未启用」。 */
  enabled: boolean
  /** 要扫描的目录（工作区相对路径，逗号分隔）。 */
  dirs: string
  /** 单文件上限（字节）；超过跳过并在文档表里记原因。 */
  maxFileBytes: number
  /** docling-serve 地址（空 = 不解析 PDF/Office，只收文本格式）。 */
  doclingUrl: string
  /** 扫描间隔（分钟）；0 = 只手动触发。 */
  pollMinutes: number
  /** 每回合自动注入几块证据（0 = 不注入，只给工具）。 */
  injectTop: number
  /** 自动注入的字符上限。 */
  injectChars: number
  /** 向量相对关键词的权重（0 = 纯关键词）。 */
  vectorWeight: number
  /** 二阶重排权重（0 = 关；向量余弦 + 标题覆盖）。 */
  rerankWeight: number
  /** 允许把 URL 抓成 Markdown 入库（SSRF 守卫）。 */
  ingestUrls: boolean
  /** 集合 → 房间白名单（JSON；空 = 所有房间可见）。 */
  scopes: string
}

export const KB_GROUPS: FieldGroup[] = [
  {
    id: 'kb',
    label: '知识库',
    page: 'kb',
    fields: {
      enabled: b('启用知识库', true, {
        hot: 'reload',
        help: '关闭后不扫描目录、不提供检索工具；后台仍可查看已有文档。',
      }),
      dirs: s('扫描目录', 'inbox,downloads,kb/raw', {
        hot: 'reload',
        help: '工作区相对路径，逗号分隔。只有这些目录里的文件会被摄取。',
      }),
      maxFileBytes: n('单文件上限', 8 * 1024 * 1024, {
        hot: 'live', min: 64 * 1024, max: 64 * 1024 * 1024, unit: 'B', advanced: true,
        help: '超过就跳过并记录原因，避免一个大文件把摄取队列卡死。',
      }),
      doclingUrl: s('Docling 地址', '', {
        hot: 'live',
        help: 'docling-serve 的地址（如 http://127.0.0.1:5001）。留空 = 只解析 md/txt/html，'
          + 'PDF/Office/图片只登记不解析。',
      }),
      pollMinutes: n('扫描间隔', 10, {
        hot: 'live', min: 0, max: 1440, unit: '分钟',
        help: '定时扫描上面目录里的新增/变更文件；0 = 只靠后台手动触发。',
      }),
      injectTop: n('自动注入块数', 0, {
        hot: 'live', min: 0, max: 5,
        help: '每回合自动带几块知识库证据（0 = 不注入，模型需要时用 qq_kb 搜）。',
      }),
      injectChars: n('注入字符上限', 400, {
        hot: 'live', min: 100, max: 2000, unit: '字', advanced: true,
      }),
      vectorWeight: n('向量权重', 0.6, {
        hot: 'live', min: 0, max: 1, step: 0.05,
        help: '检索时向量相对关键词的权重（需要打开记忆的向量检索并配置 embed 服务）。',
      }),
      rerankWeight: n('二阶重排权重', 0, {
        hot: 'live', min: 0, max: 1, step: 0.05, advanced: true,
        help: '0 = 关。打开后按「向量余弦 + 标题覆盖」再排一次；关闭时排序不变。',
      }),
      ingestUrls: b('允许 URL 入库', false, {
        hot: 'live',
        help: '默认关。打开后后台知识库页可以把一个网页抓成 Markdown 入库（有 SSRF 守卫）。',
      }),
      scopes: s('集合可见范围', '', {
        hot: 'live', advanced: true,
        help: 'JSON：{"集合名": ["group-123","dm-456"]}；不在表里的集合所有房间可见。',
      }),
    },
  },
]
