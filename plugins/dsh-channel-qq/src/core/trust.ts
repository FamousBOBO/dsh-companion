/** 信任分级（P6c）：一回合的操作权限只由**发送者 QQ 号**决定，不由消息文字决定。
 *
 * 四个档位来自 05 §5：master（`admins[0]` 的 QQ 号，铁证）/ admin（其余 admins）/
 * member（其他一切人）/ system（我们自己发起的回合——现有定时任务是事件书 P6f 的
 * 化身）。身份判据只有一条：拿 sender_id 比对 `config.admins`；"我是管理员"这类
 * 文字声明永远不算（02 §2 的"认 ID 不认人"）。
 *
 * **污点合并**：一回合的包里只要出现过 member 的消息，整回合信任就降为 member
 * ——哪怕是主人 @ 了机器人、同一批里也有群友说话（CaMeL / Design Patterns 的
 * "不可信数据不能决定高危动作"）。合并实现为"取最低者"，顺序是
 * member < system < admin < master（system 比 member 多一份工作区写权限，见
 * `app/policy/tool-policy.ts` 的放行表）。
 *
 * 纯逻辑、零 IO、零时钟（R8）：`TurnTrustLedger` 只是一张 Map，时间与随机都不碰。
 */

/** 四档信任。语义与列顺序见 `内部文档模块详细设计.md` §5。 */
export type Trust = 'master' | 'admin' | 'member' | 'system'

/** 档位高低（只用于"取最低者"的合并；不是权限大小的全序）。 */
const RANK: Record<Trust, number> = { member: 0, system: 1, admin: 2, master: 3 }

/**
 * 由发送者 QQ 号判身份。
 *
 * master = `admins[0]`；admin = `admins` 里其余的人；其余一律 member。名单为空
 * （还没配管理员）时任何人都是 member——这正是我们要的保守方向。
 */
export function trustOfSender(senderId: number, admins: readonly number[]): Trust {
  if (admins.length > 0 && senderId === admins[0]) return 'master'
  if (admins.includes(senderId)) return 'admin'
  return 'member'
}

/** 污点合并：取更低的一档（member 会污染任何高信赖回合，反之不会）。 */
export function lowestTrust(a: Trust, b: Trust): Trust {
  return RANK[a] <= RANK[b] ? a : b
}

/**
 * 每回合信任账本：按**会话 id** 记账，工具闸门在执行那一刻按 `exec.agent.id` 查。
 *
 * 两步写：
 *   - `stage`   组包时预登记"这一包里出现过的发送者"的最低档（污点）；
 *   - `commit`  回合真正提交（`TurnLauncher.submit`）时把"发起人档位"与预登记
 *               的污点合并后落账。
 *
 * 为什么两步：包的内容与发起人是在不同地方算出来的——包的低档只有组包器知道，
 * 发起人只有回合发起方知道，两者必须在**提交这一刻**合流，早一刻晚一刻都会算错。
 * 读不到任何记账时（比如宿主直接替我们跑了一轮）由查询方按 member 兜底——账本
 * 本身不做兜底，它只回答"记过没有"。
 */
export class TurnTrustLedger {
  private readonly committed = new Map<string, Trust>()
  private readonly staged = new Map<string, Trust>()

  /** 组包时预登记本包污点（重复 stage 取更低者）。`null` = 这包里没认出发送者。 */
  stage(sessionId: string, taint: Trust | null): void {
    if (taint === null) return
    const prev = this.staged.get(sessionId)
    this.staged.set(sessionId, prev === undefined ? taint : lowestTrust(prev, taint))
  }

  /**
   * 回合提交：合并发起人档位与预登记污点、清空预登记、落账。
   *
   * `ignoreStaged` 给后台注入用（按 master 处理、不看包内容）——预登记仍会被清掉，
   * 否则它会漏进下一个回合。
   */
  commit(sessionId: string, base: Trust, ignoreStaged = false): Trust {
    const staged = this.staged.get(sessionId)
    this.staged.delete(sessionId)
    const trust = ignoreStaged || staged === undefined ? base : lowestTrust(base, staged)
    this.committed.set(sessionId, trust)
    return trust
  }

  /** 本回合（最近一次 commit）这一会话的信任；从没提交过时 undefined。 */
  get(sessionId: string): Trust | undefined {
    return this.committed.get(sessionId)
  }
}

/**
 * 一包文本里出现过的发送者（行标里的 `(QQ号)`）的最低档；一个都没认出来时 null。
 *
 * 从**组包结果**里认（而不是从事件流里攒）：这样"包里出现过 member 的消息"的口径
 * 与包的实际内容完全一致——被 requireMention 丢掉的消息不会污染整回合，引用里带
 * 出来的别人的话会（那正是"包里有 member 的发言"）。昵称或引用正文里伪造的数字
 * 只会**多**认出发送者，方向是收紧而不是放宽。
 */
export function taintOfText(text: string, admins: readonly number[]): Trust | null {
  let taint: Trust | null = null
  for (const match of text.matchAll(/[(（](\d{5,12})[)）]/g)) {
    const trust = trustOfSender(Number(match[1]), admins)
    taint = taint === null ? trust : lowestTrust(taint, trust)
  }
  return taint
}

/** 全局账本单例：入站侧（组包 + 提交）写、工具闸门按会话 id 读；接线共享的就是这一份。 */
export const turnTrust = new TurnTrustLedger()
