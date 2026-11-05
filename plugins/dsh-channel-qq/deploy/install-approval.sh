#!/bin/bash
# 安装审批网关的系统侧部件（root）。
#
#   ./deploy/install-approval.sh            # 只装目录与 systemd 单元，不启用
#   ./deploy/install-approval.sh --enable   # 同时在 /etc/dsh/env 里打开 CHANNEL_QQ_APPROVAL=1
#
# 回滚：systemctl disable --now dsh-approval.path && rm /etc/systemd/system/dsh-approval.*
set -euo pipefail

DIR="${CHANNEL_QQ_APPROVAL_DIR:-/var/lib/dsh-approval}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "=== 目录：$DIR ==="
mkdir -p "$DIR"/{requests,queue,results}
chmod 700 "$DIR" "$DIR"/requests "$DIR"/queue "$DIR"/results
chown -R root:root "$DIR"

echo "=== systemd 单元 ==="
install -m 0644 "$HERE/systemd/dsh-approval.path" /etc/systemd/system/dsh-approval.path
install -m 0644 "$HERE/systemd/dsh-approval.service" /etc/systemd/system/dsh-approval.service
systemctl daemon-reload
systemctl enable --now dsh-approval.path
systemctl is-active dsh-approval.path

if [ "${1:-}" = "--enable" ]; then
  echo "=== 打开审批开关 ==="
  if grep -q '^CHANNEL_QQ_APPROVAL=' /etc/dsh/env 2>/dev/null; then
    sed -i 's/^CHANNEL_QQ_APPROVAL=.*/CHANNEL_QQ_APPROVAL=1/' /etc/dsh/env
  else
    printf '\n# 审批网关（IM 远程批准）：1 = 启用 /待批 /申请 /批准 /拒绝\nCHANNEL_QQ_APPROVAL=1\n' >> /etc/dsh/env
  fi
  grep '^CHANNEL_QQ_APPROVAL' /etc/dsh/env
  echo "重启 dsh 生效：systemctl restart dsh"
fi

echo "=== 目录结构 ==="
find "$DIR" -maxdepth 1 -type d -printf '%m %p\n'
