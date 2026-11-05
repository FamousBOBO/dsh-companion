/** 读一个 JSON 文件，坏了或不在就给兜底值。
 *
 * 单独一个文件是因为它有两个真实调用点、而且语义很具体：**读配置一类的文件时，
 * 坏文件不该让调用方崩**——它该拿到兜底值继续跑（那些文件可能被人在外面编辑过）。
 */

import { promises as fs } from 'node:fs'

/** 读一个 JSON 文件，或返回 `fallback`。 */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T
  } catch {
    return fallback
  }
}
