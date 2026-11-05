/** 指标样本仓库（C1/C2）：内存里保留最近 5000 条，定期整份原子写回。
 *
 * 为什么不逐条 append：仓库的硬规则是"写文件一律走 atomicWriteFile"。回合频率
 * 很低（人聊天），整份写 5000 条也只有几百 KB；30 秒合并一次足够。
 */

import { JsonStore } from '../../adapters/fs-store/json-store.js'
import type { MetricSample } from '../../core/metrics/aggregate.js'

/** 保留上限：超出丢最旧的。 */
export const MAX_METRIC_SAMPLES = 5_000

function isSample(value: unknown): value is MetricSample {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.at === 'number'
    && typeof record.room === 'string'
    && typeof record.ms === 'number'
    && typeof record.ok === 'boolean'
    && typeof record.input === 'number'
    && typeof record.output === 'number'
    && typeof record.cacheRead === 'number'
    && typeof record.cacheWrite === 'number'
}

export class MetricsStore {
  private readonly store: JsonStore<MetricSample[]>
  private samples: MetricSample[] = []
  private dirty = false

  constructor(file: string, log: (line: string) => void) {
    this.store = new JsonStore<MetricSample[]>(file, {
      log,
      validate: (value): value is MetricSample[] => Array.isArray(value) && value.every(isSample),
    })
  }

  /** 读盘；坏文件退回空库（指标是观测数据，绝不拦启动）。 */
  async load(): Promise<void> {
    const parsed = await this.store.load([])
    this.samples = parsed.filter(isSample).slice(-MAX_METRIC_SAMPLES)
    this.dirty = false
  }

  list(): readonly MetricSample[] {
    return this.samples
  }

  add(sample: MetricSample): void {
    this.samples.push(sample)
    if (this.samples.length > MAX_METRIC_SAMPLES) {
      this.samples.splice(0, this.samples.length - MAX_METRIC_SAMPLES)
    }
    this.dirty = true
  }

  /** 有变化才写；失败只记日志（下一次 flush 会重试整份）。 */
  async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    await this.store.save(this.samples)
  }
}
