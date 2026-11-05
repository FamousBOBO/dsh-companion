#!/bin/bash
# 部署 NapCatQQ（OneBot v11 协议端）
#  - 只监听 127.0.0.1，不对外暴露
#  - token 随机生成并持久化，绝不使用镜像默认口令
set -euo pipefail

ROOT=/opt/napcat
mkdir -p "$ROOT/data/qq" "$ROOT/data/config" "$ROOT/data/plugins"

# ── token（只生成一次）────────────────────────────────────────────────
if [ ! -f /root/.napcat-webui-token ]; then
  openssl rand -hex 24 > /root/.napcat-webui-token
fi
if [ ! -f /root/.onebot-token ]; then
  openssl rand -hex 24 > /root/.onebot-token
fi
chmod 600 /root/.napcat-webui-token /root/.onebot-token
WEBUI_TOKEN=$(cat /root/.napcat-webui-token)
ONEBOT_TOKEN=$(cat /root/.onebot-token)

# ── compose 文件 ──────────────────────────────────────────────────────
cat > "$ROOT/compose.yaml" <<EOF
services:
  napcat:
    image: mlikiowa/napcat-docker:v4.15.0
    container_name: napcat
    restart: unless-stopped
    environment:
      MODE: ws
      WEBUI_TOKEN: '${WEBUI_TOKEN}'
    ports:
      - "127.0.0.1:6099:6099"
      - "127.0.0.1:3001:3001"
    volumes:
      - ./data/qq:/app/.config/QQ
      - ./data/config:/app/napcat/config
      - ./data/plugins:/app/napcat/plugins
EOF

cd "$ROOT"

echo "=== 启动 NapCat ==="
if docker compose version >/dev/null 2>&1; then
  docker compose up -d
else
  echo "docker compose 插件不可用，回退 docker run"
  docker rm -f napcat >/dev/null 2>&1 || true
  docker run -d --name napcat --restart unless-stopped \
    -e MODE=ws -e WEBUI_TOKEN="$WEBUI_TOKEN" \
    -p 127.0.0.1:6099:6099 -p 127.0.0.1:3001:3001 \
    -v "$ROOT/data/qq:/app/.config/QQ" \
    -v "$ROOT/data/config:/app/napcat/config" \
    -v "$ROOT/data/plugins:/app/napcat/plugins" \
    mlikiowa/napcat-docker:v4.15.0
fi

echo "=== 容器状态 ==="
docker ps --filter name=napcat --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

echo "=== 等待 20 秒后取日志 ==="
sleep 20
docker logs --tail 40 napcat 2>&1

echo "=== 端口 ==="
ss -tlnp | grep -E ':(6099|3001)\b' || echo "(端口尚未监听)"

echo "=== TOKENS (仅本次输出，请记录) ==="
echo "WEBUI_TOKEN=$WEBUI_TOKEN"
echo "ONEBOT_TOKEN=$ONEBOT_TOKEN"
