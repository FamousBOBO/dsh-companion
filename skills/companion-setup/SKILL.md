---
name: companion-setup
description: 配置或迁移 DSH Companion、Bilibili、运动健康、NapCat 或 SnowLuma 时使用。先确认已有聊天记录与记忆，再询问扩展需求，复用用户已授权的服务，通过持久化终端管理本机长驻服务。
---

# DSH Companion 自配置

在仓库根执行命令。先读 AGENTS.md、docs/01-deployment.md、docs/03-modules-support-matrix.md，
以实际文件、宿主工具描述和 doctor 输出为准。已回答的问题不重复询问；用户明确指令优先。

## 先问，再配置

第一轮先问：是否已有 DSH、AstrBot 或其他助手的聊天记录与长期记忆？是否需要迁移或复用，
原部署与导出文件在哪里？说明会先备份、检查格式和用户身份绑定，再提供导入预览。

第二轮再问：需要 Bilibili、运动健康、QQ 等哪些能力？是否已经在 AstrBot 或其他部署中配置、
登录或运行？询问可复用的部署路径、服务地址以及对应账号，不要求用户把密钥粘贴到聊天。
先检查指定配置和端口，优先连接已有授权服务，避免重复登录或启动第二个采集器。

QQ 面板先确认 NapCat 或 SnowLuma 及地址，写入忽略的 data/home/companion/studio.webpanels.json。
探测到端口不能代替用户选择。启动命令、tokenFile 和页面 token 只保存在本机，不进 Git。

## 迁移记录与记忆

DSH Companion 导出使用 `npm run migrate -- export --out <目录>`；对导入包先执行
`npm run migrate -- check --from <目录>` 与 `npm run migrate -- import --from <目录> --dry-run`。
确认身份绑定后，按 docs/04-migration.md 选择 adopt 或隔离方式。不要重放旧提醒或补发历史消息。

AstrBot 等外部格式不能直接假装受 migrate 支持。先检查其实际存储格式与可用导出适配器，
准备可审阅的字段映射，保留原始记录和备份；用户确认后再导入。聊天原文与模型推断分开，
不把角色扮演、群聊或别人的资料混进主人的事实记忆。读取私密数据只限用户授权的迁移范围。

## 安装与扩展

按 AGENTS.md 执行 npm ci、build、doctor、setup；setup 保留已有配置。
修改 config/suite.json 中的模块开关后重新 setup，先检查生成差异与备份，再重启本套件。
本地 suite.json、persona.md、data/、登录缓存和任何凭据不得进入 Git。

Bilibili 按模块矩阵检查 dsh-bili-scroll 外部包是否存在；不能把不存在的插件报告为已安装。
已有 AstrBot 登录只在账号相同、格式兼容且得到授权时复用；不能整包复制未知凭据目录。
未配置时再按对应插件的登录流程操作。自动评论、发送和后台模型任务需用户明确启用。

运动健康使用随仓库的 companion-health 和 sidecars/huawei-health-cn、sidecars/huawei-band-ble。
先检查既有服务地址与健康端点，复用已运行的授权实例。需要新登录时读对应 README，使用
受支持的登录脚本；回调、token、健康明细不输出到聊天或日志。BLE 设备扫描与连接需用户授权。
区分云端健康同步和手环 BLE 实时心率，某一项成功不能代表另一项已可用。

## 持久化终端

检查宿主是否已启用实验性持久终端 bundle 及当前平台后端。缺少工具时先说明并通过本机
profile 启用，不伪造执行结果。按实际工具描述调用 terminal_open、terminal_send、terminal_read、
terminal_signal、terminal_close；Windows 使用 pwsh 后端，其他平台检查 bash 后端。

为长驻服务建立有名称的终端，先检查现有端口和进程，发送对应平台 README 中的启动命令，
读取输出直到健康检查就绪。保留终端供后续查看日志；服务未就绪不能报告成功。不要把凭据
作为命令参数或打印配置全文。重启只针对本次配置的服务，不按端口盲杀其他部署。

## 验证与交付

使用 doctor 和真实只读状态端点确认连接，再运行适用的离线测试。对外发送、真实评论、
计费生图和模型调用不能作为默认验证手段。报告已保存、需重启、离线验证、真实连接各自的
结果和限制。需重启的设置在重启前明确提示未生效，保留已有会话与服务，不覆盖用户资产。
