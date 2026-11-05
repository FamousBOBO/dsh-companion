/** 知识库的端口：工具、后台、入站组包只认这张面，不认 `features/kb/*` 的实现。 */

import type { KbChunk, KbCollection, KbDocument, KbHit } from '../core/kb/model.js'

/** 一轮扫描的进度（后台轮询显示）。 */
export interface KbIngestStatus {
  readonly running: boolean
  readonly total: number
  readonly done: number
  readonly current: string
  readonly added: number
  readonly updated: number
  readonly skipped: number
  readonly failed: number
  readonly removed: number
  readonly startedAt: number
  readonly finishedAt: number
  readonly note: string
}

export interface KbStats {
  readonly enabled: boolean
  readonly docs: number
  readonly activeDocs: number
  readonly chunks: number
  readonly activeChunks: number
  readonly bytes: number
  readonly collections: number
  readonly vectors: number
  readonly ingest: KbIngestStatus
}

export interface KbCatalog {
  readonly collections: Array<{ name: string; docs: number }>
  readonly documents: Array<{ id: string; title: string; path: string }>
}

/** 知识库服务（`features/kb` 提供）。 */
export interface KbService {
  search(query: string, room: string | null, limit?: number, collection?: string): Promise<KbHit[]>
  catalog(room: string | null): KbCatalog
  /** 每回合自动注入的证据块（空串 = 不注入）。 */
  evidence(input: { readonly text: string; readonly room: string | null }): Promise<string>
  stats(): KbStats
  ingest(force?: boolean): Promise<KbIngestStatus>
  reindexVectors(): Promise<{ embedded: number; failed: number; total: number; skipped: boolean }>
  remove(id: string): Promise<boolean>
  restore(id: string): Promise<boolean>
  preview(id: string): { doc: KbDocument; chunks: KbChunk[] } | null
  documents(): KbDocument[]
  collections(): KbCollection[]
}

/** 入站组包用的窄接口（只要证据块）。 */
export type KbEvidence = (input: {
  readonly text: string
  readonly room: string | null
}) => Promise<string>
