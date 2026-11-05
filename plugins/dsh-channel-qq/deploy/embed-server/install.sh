#!/bin/bash
# 安装本机 embed 服务（root）。幂等：重复跑只会重启服务。
#
#   ./deploy/embed-server/install.sh [--model BAAI/bge-small-zh-v1.5]
#
# 依赖：python3（系统自带）。pip 由 get-pip.py 引导，**不装任何系统包**。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${CHANNEL_QQ_ROOT:-/srv/dsh/dsh-channel-qq}"
VENV=/srv/dsh-embed/venv
MODEL="BAAI/bge-small-zh-v1.5"
while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    *) echo "未知参数 $1"; exit 2 ;;
  esac
done

echo "=== venv（$VENV）==="
if [ ! -x "$VENV/bin/python" ]; then
  mkdir -p /srv/dsh-embed
  python3 -m venv --without-pip "$VENV"
  curl -sS -m 60 https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py
  "$VENV/bin/python" /tmp/get-pip.py -q
fi

echo "=== fastembed ==="
"$VENV/bin/pip" install -q --upgrade fastembed

# 模型：优先 ModelScope 镜像（Qdrant 发布的 ONNX 包）。HF 在国内往往不可达，
# 而 hf-mirror.com 会 308 跳回 huggingface.co（2026-10-20 实测）。已有就跳过。
MODEL_DIR=/srv/dsh-embed/models/bge-small-zh-v1.5
mkdir -p "$MODEL_DIR"
if [ ! -s "$MODEL_DIR/model_optimized.onnx" ]; then
  echo "=== 模型（ModelScope: Qdrant/bge-small-zh-v1.5）==="
  for f in config.json model_optimized.onnx ort_config.json special_tokens_map.json            tokenizer.json tokenizer_config.json vocab.txt configuration.json; do
    echo "  - $f"
    curl -fsSL --retry 2 -m 900 -o "$MODEL_DIR/$f"       "https://modelscope.cn/api/v1/models/Qdrant/bge-small-zh-v1.5/repo?Revision=master&FilePath=$f"
  done
fi

echo "=== systemd 单元 ==="
sed "s#/srv/dsh/dsh-channel-qq#$ROOT#g" "$HERE/dsh-embed.service" > /etc/systemd/system/dsh-embed.service
systemctl daemon-reload
systemctl enable --now dsh-embed.service
sleep 3
systemctl is-active dsh-embed.service

echo "=== 自检 ==="
curl -s -m 30 http://127.0.0.1:8801/health || true
echo
echo "接下来：在后台「记忆」相关配置里打开 memory.vectorEnabled，把 vectorUrl 设为"
echo "  http://127.0.0.1:8801/v1    vectorDim 设为 512"
