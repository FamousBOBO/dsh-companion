# Runtime 测试约定

## 硬规矩：用桩 dispatcher 的测试，一律不许断言持久化状态

`dispatch` 是运行时里**唯一**把事件写进数据库的通道（`domain_events`、`p2_activity_receipts`、
消费水位……都由它落盘）。所以：

> **桩只能证明"被调用了什么"，不能证明"库里有什么"。**

任何断言"表里有 / 没有某行"的测试（`effects()`、`effectRecords()`、`activityReceipts`、
`p2_share_candidates` 之外的派生表……），**必须先确认那张表有人写**。如果测试用的是桩 dispatcher，
就只能断言返回值、调用次数、抛出的错误码 —— **不能**断言数据库状态。

正确写法（真 dispatcher）：

```js
import { dispatchEvent } from '../lib/events.mjs';
import { applyActivityEvent } from '../lib/activities.mjs';

const dispatch = event => dispatchEvent(db, event, {
  handlers: { autonomy: applyActivityEvent },
  generation: 'gen-1',
});
```

## 为什么写这条

`round3-a1-port-shape.test.mjs` 曾经用桩 dispatcher 断言 `effects()` 里"应该有 unknown 记录"，
于是 `phases` 永远是 `[]` —— 那条测试连续三轮被当成**产品 P1 缺陷**（"无答案不重试没实现"），
有人还为此写了两次"修复"。真实原因只是桩不写库。

这条假缺陷的代价 = 三轮排查 + 一段死代码 + 一次"绿但坏"。所以它从"教训"升级成**规矩**。

## 第二条：调试探针不许进源码

要打点就用**临时分支或本地脚本**。曾经在 `failStart` 里留过一行 `noteError(...)`，而它内部又被
`try { ... } catch { }` 包着 —— `ReferenceError` 被吞掉，测试全绿，真实错误被藏起来。

## 第三条：空 catch 是溶剂

`catch { /* 忽略 */ }` 会把 **`ReferenceError` 一起吞掉**，而这类错误恰恰是"代码路径根本没跑"的
唯一线索。第五轮复审那次：`claimKey` 在事务回调里声明、在回调外使用 ⇒ `ReferenceError` ⇒ 被一句
空 catch 变成"就保持 pending 吧"，于是**去重 claim 永远不结算**，而且所有测试都是绿的。

规则：**catch 里必须留下可观测的痕迹**（`noteError(code, message)`，或至少写进返回值）。
确实要忽略的，注释里写清"忽略的是什么、为什么安全"。

## 第四条：读库前先确认 API 名字 —— 静默读空比抛错难查十倍

同一个教训踩过两次：

- `MemoryDatabase` 暴露的是 `_get(sql, params)`（数组参数），写成 `db.get(sql, id)` 会**静默返回空**；
- 运行时库的 `readRow()` 用 `{}` 表示"没有这一行"，于是 `reauditState?.foreign ?? 0` 把"从未审计"
  显示成了 `0 / measured`。

两者都不会抛错：一个是方法不存在被 `?.` 吞掉，一个是"有对象但字段为空"。所以：

1. 断言前先**打印一次**你读到的原始行（探针留在本地脚本里，不进源码）；
2. 区分"**没有这一行**"与"**这一行是 0**"—— `null` 与 `0` 在诊断里有完全不同的含义；
3. 读库失败或缺失时返回 `null`，**不要**用 `0` 兜底。

## 第五条：不许断言源码文本 —— 那是"连假绿都算不上"

2026-11-02 在 `dsh-channel-qq` 抓到一条（`R11-7`）：

```ts
const src = fs.readFileSync('src/features/reminders/tools.ts', 'utf8')
assert.ok(src.includes('ok: false, error: why'), '失败要带原因')
```

**它根本不跑被测代码。** 把变量名从 `why` 改成 `error.message` 就红了，而行为完全没变；
反过来，真把错误处理写坏了、只要那行字符串还在，它**照样绿**。

"假绿测试"至少还在执行被测代码，只是断言太松；这一类**被测对象就不是行为**，所以它既不能
发现 bug，也会对无关的重构误报。

**规矩**：测试里出现 `readFileSync` 读 `src/`、或用 `includes`/`match` 匹配实现文本（函数名、
变量名、注释、日志字面量），一律改成行为测试——装真的依赖、制造真故障、断言真结果。

**唯一例外**：断言**用户可见的契约文本**（例如快照里的日志文案）是可以的，但那时被测对象是
"输出"，不是"源码"。区别在于：你读的是 `src/` 下的文件，还是被测代码产出的东西。

正确的改法（同一条 `R11-7`）：

```ts
// 装一个"写盘必失败"的真 store，调工具，断言它真的回了 ok:false 且带原因
io.replaceSerialized = async () => { throw storeFault('PERSIST_FAILED', 'write', 'disk full') }
const result = await call('qq_remind', { ... })
assert.equal(result.ok, false)
assert.equal(typeof result.error, 'string')
assert.match(result.error, /disk full|没有执行|写入被拒/)
assert.equal(store.list(10).length, 0, '内存里一条都不许留')
```
