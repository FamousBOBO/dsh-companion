/** 宿主（cordis / dsh）的假件，供组件级测试使用。
 *
 * 为什么要有它：`ConversationBridge` 只经由 `ctx` 拿到宿主能力（agents、
 * agentPresets、agentDefaultModel、permissionPresets、sessionTitle、
 * workspaceRegistry、attachments），所以只要把这七个服务换成假的，整条
 * 入站 → 组包 → 投递的路径就能在没有宿主、没有网络、没有 QQ 的情况下跑起来。
 * 这也是 P3 拆 `bridge.ts` 时"行为不变"的证明手段。
 *
 * 记录下来的东西：每个会话收到过的消息（`followup` / `inject` / `steer` 分开记，
 * 因为"唤醒"和"只进上下文"是两种不同行为）、以及每个会话的 create/resume 次数。
 */

import type { Context } from '@deepseek-ai/cordis'

/** 一次投递给 agent 的调用。 */
export interface DeliveredMessage {
  /** 会话 id（`qq-<key>`）。 */
  sessionId: string
  /** 走的是哪条通道。 */
  how: 'followup' | 'inject' | 'steer'
  /** 消息对象原样保留，断言用 `textOf()` 取正文。 */
  message: unknown
}

/** `createUserMessage()` 的产物形状（只取我们要断言的部分）。 */
interface ContentBlock {
  type?: string
  text?: string
}

/**
 * 从投递的消息里取出文本正文。
 *
 * `createUserMessage` 的输出结构由宿主决定，测试不该把它当成契约的一部分，
 * 所以这里做兼容读取：`content` 可以是字符串，也可以是 `{type:'text',text}` 数组。
 */
export function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
  }
  return ''
}

/** 投递的消息里带了几张图（`{type:'image'}` 块的数量）。 */
export function imageCountOf(message: unknown): number {
  const content = (message as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return 0
  return (content as ContentBlock[]).filter((b) => b?.type === 'image').length
}

export interface FakeHostOptions {
  /** `ctx.agentDefaultModel.currentSelection()` 的返回值。 */
  selection?: { provider: string; model: string }
  /** 让 `ctx.agents.create()` 抛这个错（用来测 create→resume 的自愈路径）。 */
  createError?: string
  /** 模拟"这个会话在宿主里还活着"：`agents.get()` 返回它。 */
  liveSessions?: string[]
  /** 工作区根的返回路径（默认 `/tmp/golden-ws`）。 */
  workspacePath?: string
  /**
   * create/resume 返回的句柄上有没有 `dispose`。
   *
   * 默认 `false`：宿主的 `agents.get()` 就是给一个**裸** Agent，释放能力归创建者。
   * 置 `true` 用来测"这个会话是我们建的、能拆"的那条分支。
   */
  canDispose?: boolean
  /** `workspace.attachSession()` 抛这个错（模拟"已经挂过了"）。 */
  attachError?: string
}

/** 一个功能足够、行为可预测的假宿主。 */
export class FakeHost {
  /** 按会话分组的投递记录，按发生顺序。 */
  readonly delivered = new Map<string, DeliveredMessage[]>()
  /** 每个会话 `agents.create()` 被调了几次。 */
  readonly creates = new Map<string, number>()
  /** 每个会话 `permissionPresets.set()` 收到过的档位。 */
  readonly permissions: Array<{ session: unknown; id: string }> = []
  /** 每个会话 `sessionTitle.rename()` 收到过的标题。 */
  readonly titles: Array<{ session: unknown; title: string }> = []
  /** agent 上下文上注册过的事件名（用来确认监听器确实装上了）。 */
  readonly agentListeners: string[] = []
  /** 工作区 attachSession 收到过的会话 id。 */
  readonly attached: string[] = []
  /** 被 dispose 过的会话 id。 */
  readonly disposed: string[] = []
  /** 全部日志行（按调用顺序）。 */
  readonly logs: string[] = []

  private readonly options: Required<FakeHostOptions>
  private created = 0

  constructor(options: FakeHostOptions = {}) {
    this.options = {
      selection: options.selection ?? { provider: 'fake-provider', model: 'fake-model' },
      createError: options.createError ?? '',
      liveSessions: options.liveSessions ?? [],
      workspacePath: options.workspacePath ?? '/tmp/golden-ws',
      canDispose: options.canDispose ?? false,
      attachError: options.attachError ?? '',
    }
  }

  /**
   * 某个会话收到的全部投递。
   *
   * 键既可以是会话 id（`qq-group-123`），也可以是房间键（`group-123`）——
   * 内部一律按会话 id 记，这里做一次归一，免得调用方记错前缀得到"空数组"
   * 这种看起来像"没投递"的假阴性。
   */
  messagesFor(key: string): DeliveredMessage[] {
    const sessionId = key.startsWith('qq-') ? key : `qq-${key}`
    return this.delivered.get(sessionId) ?? []
  }

  /** 某个会话最后一次投递的正文（最常见的断言入口）。 */
  lastTextFor(key: string): string {
    const list = this.messagesFor(key)
    return list.length === 0 ? '' : textOf(list[list.length - 1]!.message)
  }

  /** 某个会话最后一次投递走的通道。 */
  lastHowFor(key: string): string | undefined {
    const list = this.messagesFor(key)
    return list.length === 0 ? undefined : list[list.length - 1]!.how
  }

  /** 造一个能骗过 `ConversationBridge` 的 `Context`。 */
  context(): Context {
    const self = this
    return {
      agents: {
        get(sessionId: string) {
          if (!self.options.liveSessions.includes(String(sessionId))) return undefined
          return { session: { id: String(sessionId) }, ctx: self.agentContext(), followup: () => {} }
        },
        async create(options: { sessionId: string; setup?: (c: Context) => Promise<void> }) {
          const sessionId = String(options.sessionId)
          if (self.options.createError !== '') throw new Error(self.options.createError)
          self.created += 1
          self.creates.set(sessionId, (self.creates.get(sessionId) ?? 0) + 1)
          if (options.setup !== undefined) await options.setup(self.agentContext())
          return self.handle(sessionId)
        },
        async resume(options: { resumeSessionId: string; setup?: (c: Context) => Promise<void> }) {
          const sessionId = String(options.resumeSessionId)
          if (options.setup !== undefined) await options.setup(self.agentContext())
          return self.handle(sessionId)
        },
      },
      agentPresets: {
        async resolve(id: string) { return { id } },
        async mount() { return undefined },
      },
      agentDefaultModel: {
        currentSelection() { return { ...self.options.selection } },
      },
      permissionPresets: {
        set(session: unknown, id: string) { self.permissions.push({ session, id }) },
      },
      sessionTitle: {
        rename(session: unknown, title: string) { self.titles.push({ session, title }) },
      },
      workspaceRegistry: {
        async create(path: string) {
          return {
            path,
            async attachSession(sessionId: unknown) {
              if (self.options.attachError !== '') throw new Error(self.options.attachError)
              self.attached.push(String(sessionId))
            },
          }
        },
      },
      attachments: {
        async saveImage(input: { name?: string }) { return { id: `attachment:${input.name ?? 'x'}` } },
      },
    } as unknown as Context
  }

  /** 一个 agent 平面上下文：只需要 `on()` 能装监听器（`attachTurnWatch` 用）。 */
  private agentContext(): Context {
    const self = this
    return {
      on(event: string) { self.agentListeners.push(event); return () => {} },
    } as unknown as Context
  }

  /** create/resume 的返回形状；`canDispose` 决定有没有释放能力。 */
  private handle(sessionId: string): Record<string, unknown> {
    const agent = this.agent(sessionId)
    if (!this.options.canDispose) return { agent }
    const self = this
    return {
      agent,
      async dispose() { self.disposed.push(sessionId) },
    }
  }

  private agent(sessionId: string): Record<string, unknown> {
    const self = this
    const record = (how: DeliveredMessage['how'], message: unknown): void => {
      const list = self.delivered.get(sessionId) ?? []
      list.push({ sessionId, how, message })
      self.delivered.set(sessionId, list)
    }
    return {
      session: { id: sessionId },
      status: 'idle',
      followup(message: unknown) { record('followup', message) },
      inject(message: unknown) { record('inject', message) },
      steer(message: unknown) { record('steer', message) },
    }
  }
}

/**
 * 一个只会回预置数据的 `OneBotClient`。
 *
 * **它必须和真实现一样 resolve `payload.data`**（见 `onebot.ts:124`）：真客户端在
 * `status==='ok' || retcode===0` 时把 data 掏出来给调用方。假件原来返回整个信封，
 * 于是 `api.getGroupInfo()` 拿到的是 `{status, retcode, data}`——工具里读
 * `gi.group_name` 永远读不到，测试会以为"群里发不出去"。这类假件与真件的偏差比
 * 代码 bug 更难查，所以这里按真契约来。
 */
export function fakeClient(responses: Record<string, unknown> = {}): {
  selfId: number
  call(action: string, params?: Record<string, unknown>, timeout?: number): Promise<unknown>
  /** 取一条历史消息（引用回复要用）。缺了它，引用路径会在黄金测试里**静默失败**。 */
  getMessage(messageId: number): Promise<Record<string, unknown>>
  calls: Array<{ action: string; params: Record<string, unknown> }>
} {
  const calls: Array<{ action: string; params: Record<string, unknown> }> = []
  return {
    selfId: 10000,
    calls,
    async getMessage(messageId: number) {
      calls.push({ action: 'get_msg', params: { message_id: messageId } })
      return {
        message_id: messageId,
        sender: { user_id: 10001, nickname: '主人' },
        raw_message: '原来那条报错在这里',
        message: [{ type: 'text', data: { text: '原来那条报错在这里' } }],
      }
    },
    async call(action: string, params: Record<string, unknown> = {}) {
      calls.push({ action, params })
      return responses[action] ?? {}
    },
  }
}

/**
 * 一个只把发送动作直接执行掉的出站队列（限速/重试不参与黄金测试）。
 *
 * **`pending()` 是队列契约的唯一观测点**：`push` 时 +1、任务结束（**成功或失败**）时 -1。
 * 失败路径不释放计数 ⇒ 计数只增不减 ⇒ "队列永久泄漏"，而症状只有一句"尾段失败"日志。
 */
export function fakeOut(): {
  push<T>(fn: () => Promise<T>): Promise<T>
  calls: Array<() => Promise<unknown>>
  pending(): number
} {
  const calls: Array<() => Promise<unknown>> = []
  let outstanding = 0
  return {
    calls,
    pending: () => outstanding,
    async push<T>(fn: () => Promise<T>): Promise<T> {
      calls.push(fn as () => Promise<unknown>)
      outstanding += 1
      try {
        return await fn()
      } finally {
        // **必须在 finally**：尾段失败也要释放，否则失败一次漏一个计数。
        outstanding -= 1
      }
    },
  }
}

/**
 * 一个"已连上"的平台端口。
 *
 * 生图与 RSS 的注册函数在**注册时**就问平台连没连上（只为打一行日志），
 * 所以快照工具面时必须给它们一个真端口形状——`fakeClient()` 是传输层，
 * 没有 `isConnected()`，拿它顶替会在注册那一刻就抛。
 */
export function fakePlatform(client = fakeClient()): {
  api: unknown
  selfId: number | null
  isConnected(): boolean
} {
  return { api: client, selfId: client.selfId, isConnected: () => true }
}

/** 收集工具注册：把 `ctx.tools.register()` 收到的定义按顺序记下来。 */
export function toolRecorder(): {
  ctx: Context
  definitions: Array<Record<string, unknown>>
} {
  const definitions: Array<Record<string, unknown>> = []
  const ctx = {
    tools: {
      register(definition: Record<string, unknown>) {
        definitions.push(definition)
        return () => {}
      },
    },
  } as unknown as Context
  return { ctx, definitions }
}
