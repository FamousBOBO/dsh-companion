/** 字节的本地存取：收件箱与宿主的本机文件。
 *
 * 只有两件事，但两件都是 IO，而 `app/` 不许碰 IO（R8）：
 *
 *   1. **写收件箱** —— 群友发的文件落到 `<工作区>/inbox/`，让 agent 能用文件工具处理；
 *   2. **读本机文件** —— NapCat 说"这张图就在这台机器上的某个路径"，那条兜底路。
 *
 * 为什么收成一个端口而不是两个：它们服务的是同一件事（"把外面的字节搬进来"），
 * 而且都由同一个适配器实现（知道工作区在哪、怎么原子写）。
 *
 * 只有类型，没有实现；实现见 `adapters/fs-store/blob-store.ts`。
 */

export interface InboxWrite {
  /** 原始文件名（适配器负责清洗掉路径分隔符一类的危险字符）。 */
  readonly name: string
  readonly bytes: Uint8Array
  /** 加在文件名前缀的时间戳（毫秒）。 */
  readonly nowMs: number
}

export interface BlobStore {
  /** 把一份字节写进工作区收件箱，返回落盘后的绝对路径。 */
  writeInbox(input: InboxWrite): Promise<string>
  /** 读一个本机绝对路径；读不到返回 null（调用方按"这条兜底走不通"处理）。 */
  readLocal(file: string): Promise<Uint8Array | null>
}
