# 06 · 故障排查

> 顺序永远是：**`npm run doctor` → 本文对应症状 → `<dataDir>/logs/` 本次日志**。
> 不要先删配置、重建数据「碰运气」。

## 0. 三层定位法

| 层 | 反问 | 怎么确认 |
|---|---|---|
| 环境层 | Node 够不够？宿主在哪？路径对不对？ | `node --version`、`npm run doctor` |
| 配置层 | 该开的开了没？该填的填了没？两份真相？ | `config/suite.json` + 模块 `*.config.json`（`docs/02` §7） |
| 模块层 | 模块加载了吗？服务注册了吗？外部服务通吗？ | 本次启动日志 + 模块 `CONTRACT.md` |

**先分清「没配置」「配置了但不通」「通了但没生效」**——三者处理完全不同（`docs/02` §6）。

## 1. 安装与构建

| 症状 | 判断 | 处理 |
|---|---|---|
| `EBADENGINE` / `SyntaxError: Cannot find module 'node:sqlite'` | Node < 24 | 装 Node 24（`docs/01` §1.1）。Node 22 需 `--experimental-sqlite`，不要指望它 |
| `npm ci` 报锁文件不存在 | 副本不完整 | 要完整的 `package-lock.json`；别用 `npm install` 顶替（不可复现） |
| `npm ci` 在 Windows 报 `EPERM` | 目录被占用 / 同步盘 | 关掉编辑器与 OneDrive 同步后重试，或换到本地普通目录 |
| `npm run build` 报类型错误 | 代码或依赖版本不一致 | 确认 `npm ci` 真的按锁文件装了；不要改 `tsconfig` 绕过 |
| 构建成功但 `doctor` 说某模块入口缺失 | `main` 指向的产物没生成 | 看该模块构建脚本输出；`bash` 脚本在 Windows 上缺失时属构建脚本问题（应为跨平台 node 脚本） |
| 构建脚本要 `bash` / `pwsh` | 脚本不跨平台 | 记为已知问题；Windows 上可用 Git Bash 临时顶替，但这不是发布形态 |

## 2. 宿主与启动

| 症状 | 判断 | 处理 |
|---|---|---|
| `doctor`：`未检测到 DSH 宿主` | 装的是非标准路径，或没装 | 在 `config/suite.json` 写 `dsh.executable` + `dsh.moduleRoot`（`docs/01` §5.2）。`doctor` 会打印它试过的路径 |
| `doctor`：`宿主 X 低于最低支持版本 0.2.0` | 宿主太旧 | 升级 DSH 桌面版 |
| `doctor`：`宿主 X 高于已验证版本…未实测` | 不阻断 | 可以继续，但把它记录下来；出问题优先怀疑版本差异 |
| `npm run start` 起不来，日志里 `EADDRINUSE` | 端口被占（旧进程没退） | `npm run stop`；确认没有同 profile 的进程残留 |
| 启动后马上退出 | profile 合成失败 / 插件加载异常 | 看本次启动日志的第一段错误；常见是「服务提供者与消费者不在同一 isolate realm」 |
| 界面能开但对话报错 | 模型未登录 / provider 未配置 | 在桌面里登录或配模型；套件**不复制**任何旧环境凭据 |
| 起了两个环境（旧 DSH + 套件） | profile / user-data 混用 | 套件必须用独立 `DSH_HOME` + 独立 `desktop-data` + 独立 profile，不要共用 |

## 3. 记忆

| 症状 | 判断 | 处理 |
|---|---|---|
| 说「记住：…」之后另开会话问不出来 | 常见原因：`backend` 仍是 `legacy`、或提炼被关、或命中覆盖闸门 | 1) 看 `memory.config.json` 的 `backend` 是否为 `sqlite`；2) `extraction.enabled`（默认 false，需要时才开）；3) 无关问题**本来就不该**注入旧记忆（`coverageFloor` 闸门设计如此） |
| 明显无关的旧记忆被注入 | `coverageFloor` 太小 | 调大到 0.2~0.3 试；改动后重启 |
| 检索「没有语义联想」 | 默认 embedding 是 `hash-bigram-256`（字面特征哈希），**不是**神经向量 | 要语义召回必须自配 `embedding.provider=remote` + `baseUrl` + 密钥；只打开 `semanticEnabled` 不会有向量 |
| 记忆库文件很大 / 变慢 | 正常增长 + WAL | 检查 `<dataDir>/backups/` 是否堆积；不要随手 `VACUUM`，用备份机制 |
| `node:sqlite` 报「已降级」 | 运行时不支持 | 换 Node 24。降级后没有长期记忆 |

## 4. QQ 通道

| 症状 | 判断 | 处理 |
|---|---|---|
| 消息不响应 | 未配置服务地址 / 白名单没含你 / 群需要 @ | 1) `services.onebot.url` 是否填了；2) `access.allowUsers` / `allowGroups`；3) `requireMention` 是否 true（群默认只回 @） |
| 一启动就疯狂重连 | 地址填了但服务不在 | 这是「配置了但连不上」，不是「未配置」。先确认 NapCat 在线；连续重试属于已知风险，建议先配好服务再开通道 |
| 发出去但对方没收到 | 平台接受 ≠ 送达 | `confirmed` 只表示平台接受了这条消息；没有回执能力的通道只能停在 `submitted` |
| 回合卡住不动 | 无人值守 + 审批型权限 | 通道的 `permissionPreset` 若是需要审批的预设，没人能点「允许」；按 `docs/02` §3.5 处理 |
| 重复发同一条 | 去重键丢失 / 热重载后发送器未重绑 | 看通道日志与 contact 账本；不要靠「再发一次」验证 |

## 5. 健康与 BLE

| 症状 | 判断 | 处理 |
|---|---|---|
| 健康一直「不可用」 | sidecar 没起 / 未授权 | 起 sidecar（默认 `127.0.0.1:8765`）；到 Studio 确认授权（授权表才是权威，改 config 不生效） |
| **华为健康「没有数据」，但 sidecar 起得来** | **最常见原因：你没有自备上游检出** | 上游协议实现（`client.py` 等 4 个复制件）**因许可未核实已从本仓库移除**。设 `HUAWEI_UPSTREAM_PKG` 指向你自己的上游 `huawei_health` 检出（`docs/03` §1.2）。没有它时自检脚本会以退出码 3 说明「原件不在」——这是「未配置」，不是「坏了」 |
| 华为健康登录后仍无数据 | 账号授权过期 / 上游版本不匹配你的 App | 重新走一次人工登录；核对上游检出的版本（见 sidecar 的 `PROTOCOL-FREEZE.md`） |
| BLE 心率完全没有数字 | 与华为云端通道是**两条独立链路** | BLE 不需要上游检出（原创实现）；按下面两条排查 |
| 扫不到心率设备 | **最常见原因：手环没开「心率广播」** | 先在设备上打开广播；「扫不到」不等于「设备不支持」 |
| 有设备但没读数 | sidecar 是懒模式（不扫描、不自动连） | 必须显式触发：`companion_pulse action=start`（唯一的扫描入口） |
| 读数一会儿就消失 | 会话跟随设备 | 关掉/走远广播约 30 秒后会话自己收口，这是设计 |
| HRV 一直是 `null` | 手环不广播 RR 间期 | 不编造数据；要 RR 得用胸带（如 Polar H10） |
| 群里看不到健康数据 | 隐私强制 | `privacy.exposeToGroup` / `exposeToBili` 只能是 false，这是校验强制的 |

## 6. 媒体

| 症状 | 判断 | 处理 |
|---|---|---|
| 生图/语音失败但界面显示「成功」 | 不允许 | 状态口径：`unknown` 不等于成功（超时/被 kill 记 `unknown`，不重试、不退款） |
| 改配置不生效 | 不是所有模块都热重载 | `companion-media` 按 mtime 热重载；其它模块要重启 |
| 识图被人用工具绕过 | 不应发生 | 识图默认关闭且工具/自动流程都不能绕过开关；若真能绕过，是缺陷，请上报 |

## 7. 迁移（`npm run migrate`）

| 症状 | 处理 |
|---|---|
| `exit 2` + `checksum-mismatch` | 包损坏；重新导出，别手改包 |
| `exit 2` + `version-incompatible` | 包比本机新；先升级本机，**不支持降级导入** |
| `exit 3` + `host-running` | `npm run stop` 后再试；停写检测是启发式的，多等几秒或确认进程已退 |
| `exit 3` + `identity-undecided` | 决定 `--identity adopt` 或 `quarantine`（`docs/04` §7.1） |
| `exit 1` + `backup-failed` | 备份写不进去；**此时没有任何数据被改**，处理权限/空间后重试 |
| 导入后记忆「在但不出来」 | 人格 id 映射问题：看 `personaMapping.targets[]`；或身份为 `quarantine`（隔离数据不注入） |
| 导入后收到旧提醒 | 不应发生（导入的提醒都置 `fired+paused`）；若发生，先看 `notReplayed[]` 与提醒文件 |

## 8. 汇报问题时请附上

1. `npm run doctor` 的**完整输出**（含版本号与兼容性结论）。
2. 出问题那一次的 `npm run start` 日志**路径**与关键片段（不要贴整份，注意里面有个人数据）。
3. 复现步骤：哪一步、什么命令、期望什么、实际什么。
4. 涉及迁移时：`check` 的 stdout JSON（其中 `source.identityFingerprint` 是哈希，可安全贴；**不要贴**迁移包内容）。

> 贴日志前先自己扫一遍：正文、QQ 号、路径里的用户名都可能是个人数据。
