#!/bin/bash
# 安装"会话换血"定时任务（root）。每天 04:30 清空 QQ 会话上下文并重启 dsh。
#
#   ./deploy/install-session-reset.sh            # 只装单元，不启用定时器
#   ./deploy/install-session-reset.sh --enable   # 同时启用每日 04:30
#   ./deploy/install-session-reset.sh --run-now  # 立即跑一次（会停/起 dsh）
#
# 回滚：systemctl disable --now dsh-session-reset.timer
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${CHANNEL_QQ_ROOT:-/srv/dsh/dsh-channel-qq}"

install -m 0644 "$HERE/systemd/dsh-session-reset.service" /etc/systemd/system/dsh-session-reset.service
install -m 0644 "$HERE/systemd/dsh-session-reset.timer" /etc/systemd/system/dsh-session-reset.timer
sed -i "s#/srv/dsh/dsh-channel-qq#$ROOT#g" /etc/systemd/system/dsh-session-reset.service
systemctl daemon-reload
echo "单元已安装：dsh-session-reset.service / .timer"

if [ "${1:-}" = "--enable" ]; then
  systemctl enable --now dsh-session-reset.timer
  systemctl list-timers dsh-session-reset --no-pager || true
fi

if [ "${1:-}" = "--run-now" ]; then
  echo "立即执行一次换血（会停/起 dsh）…"
  systemctl start dsh-session-reset.service
  journalctl -u dsh-session-reset --since '2 min ago' --no-pager | tail -20
fi

echo "手动执行：systemctl start dsh-session-reset.service"
echo "只看计划：$ROOT/deploy/session-reset.mjs --dry-run"
