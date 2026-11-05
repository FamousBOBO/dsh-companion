/**
 * 知识库评测语料（合成，可重放）。
 *
 * 每一份文档都有明确的小标题与少量专有名词——评测的是**检索**（能不能把问题
 * 带到正确的那一段），不是模型回答质量。问题刻意换一种说法，避免"原词照抄"
 * 把关键词检索的分数抬得虚高。
 */

export const DOCS = [
  {
    path: 'inbox/deploy.md',
    text: `# 部署手册

## 端口
服务默认监听 8080。改端口要编辑 /etc/dsh/env 里的 PORT，然后重启 dsh。

## 依赖
需要 Node 22 与 pnpm；系统自带的 Node 18 不要动。

## 目录
代码在 /srv/dsh，插件在 /srv/dsh/dsh-channel-qq，数据在 ~/.dsh。`,
  },
  {
    path: 'inbox/napcat.md',
    text: `# NapCat

## 登录
扫码登录后勾选自动登录，容器重启仍会保持。重新扫码需要重建容器。

## 端口
WebUI 监听 5099，noVNC 监听 6081，两个都只绑本机。`,
  },
  {
    path: 'inbox/backup.md',
    text: `# 备份

## 内容
备份 ~/.dsh 与工作区。知识库与记忆都在工作区 kb/ 和 knowledge/ 下。

## 恢复
先停 dsh，覆盖目录，再启动；配置覆盖层在 profiles/web/cordis.patch.yml。`,
  },
  {
    path: 'inbox/model.md',
    text: `# 模型

## 选择
群聊与私聊用同一个供应商。长文档要选窗口一百万以上的模型。

## 图片
多模态模型要在供应商配置里把 input 写成 text 和 image，否则收到的是图片占位。`,
  },
  {
    path: 'inbox/coffee.md',
    text: `# 咖啡

## 偏好
学弟喜欢冰美式，不加糖；主人喝拿铁，要热的。

## 器具
手冲壶在厨房第二个柜子，滤纸在抽屉最里面。`,
  },
  {
    path: 'inbox/git.md',
    text: `# 版本管理

## 提交
每完成一小步就提交，提交说明写清楚"为什么"，不是"改了什么"。

## 分支
重构在 refactor 分支上做，合并前跑 verify。`,
  },
  {
    path: 'inbox/session.md',
    text: `# 会话维护

## 换血
会话体积超过窗口的 85% 就换血；换血会清空历史并写入种子提示。

## 卡死
审批请求挂住回合超过十分钟由看门狗强制结束。`,
  },
  {
    path: 'inbox/food.md',
    text: `# 做饭

## 番茄炒蛋
先炒蛋盛出，再炒番茄，最后合在一起；糖放半勺。

## 米饭
米水比例一比一点二，泡二十分钟再煮。`,
  },
  {
    path: 'inbox/travel.md',
    text: `# 出行

## 高铁
提前四十分钟到站，身份证直接刷闸机。

## 行李
充电宝随身带，不能托运；液体每瓶不超过一百毫升。`,
  },
  {
    path: 'inbox/health.md',
    text: `# 健康

## 睡眠
固定起床时间比固定睡觉时间更重要；午睡不超过三十分钟。

## 运动
每周三次力量训练，每次四十分钟，动作质量优先于重量。`,
  },
]

export const QUESTIONS = [
  { q: '怎么改服务监听的端口？', path: 'inbox/deploy.md' },
  { q: '系统自带的 Node 18 能升级吗', path: 'inbox/deploy.md' },
  { q: '插件装在哪个目录', path: 'inbox/deploy.md' },
  { q: 'NapCat 重启后还要重新扫码吗', path: 'inbox/napcat.md' },
  { q: 'WebUI 的端口是多少', path: 'inbox/napcat.md' },
  { q: '备份要包含哪些目录', path: 'inbox/backup.md' },
  { q: '配置覆盖层文件在哪', path: 'inbox/backup.md' },
  { q: '为什么模型只收到图片占位', path: 'inbox/model.md' },
  { q: '学弟喜欢喝什么咖啡', path: 'inbox/coffee.md' },
  { q: '手冲壶放在哪里', path: 'inbox/coffee.md' },
  { q: '提交说明应该怎么写', path: 'inbox/git.md' },
  { q: '会话体积到多少要换血', path: 'inbox/session.md' },
  { q: '回合卡住多久会被强制结束', path: 'inbox/session.md' },
  { q: '番茄炒蛋先炒什么', path: 'inbox/food.md' },
  { q: '充电宝能托运吗', path: 'inbox/travel.md' },
  { q: '午睡建议睡多久', path: 'inbox/health.md' },
]
