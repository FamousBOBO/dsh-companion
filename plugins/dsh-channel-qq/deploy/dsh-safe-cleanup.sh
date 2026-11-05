#!/usr/bin/env bash
# ============================================================================
# dsh 服务器每周安全清理
#
# 设计原则：只回收"可再生"资源，绝不触碰 镜像 / 容器 / 数据卷 / 业务数据。
#   安全：docker builder prune(限龄)  docker image prune(仅悬空)  journalctl vacuum
#         apt-get clean(仅 .deb 缓存)  /tmp 限龄清理  npm/pnpm 缓存  dsh 日志截断
#   禁做：docker system prune -a / docker volume prune / rm -rf 业务目录
#
# 手动执行：/usr/local/bin/dsh-safe-cleanup.sh
# 查看结果：tail -50 /var/log/dsh-safe-cleanup.log
# ============================================================================
set -uo pipefail

LOG=/var/log/dsh-safe-cleanup.log
STAMP="$(date '+%Y-%m-%d %H:%M:%S%z')"
KEEP_CACHE_HOURS=168   # docker 构建缓存保留最近 7 天
KEEP_JOURNAL_DAYS=14   # systemd journal 保留 14 天
KEEP_TMP_DAYS=7        # /tmp /var/tmp 保留 7 天
LOG_MAX_BYTES=$((50 * 1024 * 1024))  # dsh channel 日志超 50MB 截断

log() { printf '[%s] %s\n' "$STAMP" "$*" >>"$LOG"; }

before_kb="$(df -k --output=avail / | tail -1 | tr -d ' ')"
log "=== 清理开始（可用 ${before_kb}KB）==="

# 1) docker 构建缓存：只删 7 天前的；正在使用的层不会被删
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  log "[docker] builder prune --filter until=${KEEP_CACHE_HOURS}h"
  docker builder prune -af --filter "until=${KEEP_CACHE_HOURS}h" >>"$LOG" 2>&1
  # 2) 仅清理悬空镜像 <none>；绝不用 -a，否则会删掉用于回滚的旧 tag
  log "[docker] image prune（仅悬空镜像）"
  docker image prune -f >>"$LOG" 2>&1
else
  log "[docker] 跳过（docker 不可用）"
fi

# 3) systemd journal 日志
if command -v journalctl >/dev/null 2>&1; then
  log "[systemd] journalctl --vacuum-time=${KEEP_JOURNAL_DAYS}d"
  journalctl --vacuum-time="${KEEP_JOURNAL_DAYS}d" >>"$LOG" 2>&1
fi

# 4) apt 包缓存（只删 .deb 缓存，不动已安装软件）
log "[apt] clean"
apt-get clean >>"$LOG" 2>&1

# 5) /tmp 与 /var/tmp：只删 7 天以上未访问的，跳过 systemd 私有目录
log "[fs] 清理 ${KEEP_TMP_DAYS} 天未访问的 /tmp /var/tmp"
find /tmp /var/tmp -mindepth 1 -xdev -atime "+${KEEP_TMP_DAYS}" \
  -not -path '/tmp/systemd-private-*' -not -path '/var/tmp/systemd-private-*' \
  -exec rm -rf {} + >>"$LOG" 2>&1 || true

# 6) 包管理器缓存
if command -v npm >/dev/null 2>&1; then
  log "[npm] cache clean"
  npm cache clean --force >>"$LOG" 2>&1 || true
fi
if [ -x /opt/node22/bin/pnpm ]; then
  log "[pnpm] store prune"
  PATH="/opt/node22/bin:$PATH" pnpm store prune >>"$LOG" 2>&1 || true
fi

# 7) dsh channel 日志截断（保留最后 2000 行）
for f in ~/.dsh/channel-qq.log; do
  if [ -f "$f" ]; then
    size="$(stat -c%s "$f" 2>/dev/null || echo 0)"
    if [ "$size" -gt "$LOG_MAX_BYTES" ]; then
      log "[log] 截断 $f（${size}B > ${LOG_MAX_BYTES}B）"
      tail -n 2000 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    fi
  fi
done

# 8) 清理本脚本自己的历史日志（保留最近 5000 行）
if [ -f "$LOG" ] && [ "$(wc -l <"$LOG")" -gt 5000 ]; then
  tail -n 5000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

after_kb="$(df -k --output=avail / | tail -1 | tr -d ' ')"
freed_mb=$(( (after_kb - before_kb) / 1024 ))
log "=== 清理结束：回收 ${freed_mb}MB，可用 $(( after_kb / 1024 ))MB ==="
