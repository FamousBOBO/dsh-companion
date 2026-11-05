# 自主跟进（qq_followup）

自己想到“晚点关心吃饭、跟进进展”时，保存联系目的。到点结合最新对话选择发送、完成、无需再问或延后。用户明确要求的定时通知继续使用 qq_remind。

## 工具用法

创建：qq_followup(action=add, purpose="如果午饭还没有聊到，关心一下是否吃饭", at="2026-11-03T13:10:00+08:00", expiresAt="2026-11-03T14:00:00+08:00")。

正常聊天看到目的完成或已聊过时，先从当前上下文或 list 取得 id/version，再 resolve(id, expectedVersion, outcome=fulfilled/dismiss, evidenceIds=["qq:真实消息号"])。cancel 和 reschedule 也需要当前 expectedVersion。工具仅接受当前主人私聊，由宿主绑定收件人；不能传入任意 target 或伪造 explicit 授权。

fulfilled 是“有证据确认目的完成”，dismiss 是“没有必要再问”。图片占位符不是吃过饭的证据。无法确认时保留或延后，不编造完成。

## 运行行为

- 支持现有 turn + draftModel=false，无需打开全局 direct 草稿。
- 先走既有廉价门控，再进行有预算、超时限制的复核，最后复查版本、房间历史和发送权限。
- fulfilled/dismiss 不创建发送回合、不扣发送配额、不增加未回复计数。真正模型调用仍计入模型预算。
- 每个意图最多两次到期复核，相隔至少五分钟；最多五个活动意图，精确目的去重在同一事务内执行。
- 使用 contact.adaptiveFollowUp 开关；关闭会在最后发送检查再次拦截。旧提醒、旧普通候选保持原行为。
- role/context/history 都是资料；模型只提供决策建议，代码负责身份、证据存在性、版本、配额和最终授权。语义判断仍可能不确定，缺上下文或坏输出会延后，不退回固定文案发送。

## 验证与发布

新增24条回归覆盖真实 worker/sender、实际工具注册、上下文读取与同窗复核；用假模型/平台和临时账本，不发真实QQ。

npm run verify 运行类型、全量测试、admin/语法/分层/体量检查。候选构建与被测JS需逐文件一致。源码由 <repo> 的 codex/adaptive-followup 分支管理；home、workspace、日志、数据库、凭据及 build 不入Git。

回滚时先停用或退役新意图，再切旧构建；不回写旧账本覆盖运行态。不要把本功能的模型回归通过当作已完成真实模型与QQ投递验收。
