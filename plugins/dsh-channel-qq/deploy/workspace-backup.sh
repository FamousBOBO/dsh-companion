#!/usr/bin/env bash
# ============================================================================
# 工作区每日备份 —— 人格数据与知识库是**不可再生**的，必须每天有一份
#
# 哪些东西值得备份（判据：丢了就得靠人重写）：
#   AGENTS.md      行为约定，她与学弟长期磨出来的
#   MEMORY.md      长期记忆的可见面（P6e 之后还会多一份结构化记忆）
#   knowledge/     知识库条目
#   persona/       人格包（含后台可编辑的文案）
#
# 哪些**不**备份：会话日志（几十 MB、可再生且已有自带 zstd 压缩）、
# emoji 表情包目录（几百 MB、从群里偷回来的，丢了可以再偷）、
# scheduler-state / sent-log（状态，丢了最坏情况是重复发一次）。
#
# 保留 14 天，每天一份；文件名带日期，写入用临时文件 + mv（不会留半截文件）。
#
# 手动执行：/usr/local/bin/workspace-backup.sh
# 查看结果：tail -20 /var/log/dsh-workspace-backup.log
# 恢复：  tar -xzf /srv/dsh/backups/workspace/<日期>.tar.gz -C <目标目录>
# ============================================================================
set -uo pipefail

WORKSPACE="${DSH_WORKSPACE:-/path/to/workspace}"
DEST="${BACKUP_DEST:-/srv/dsh/backups/workspace}"
KEEP_DAYS=14
LOG=/var/log/dsh-workspace-backup.log
STAMP="$(date '+%Y-%m-%d %H:%M:%S%z')"

log() { printf '[%s] %s\n' "$STAMP" "$*" >>"$LOG"; }

mkdir -p "$DEST" || { log "!! 建不出备份目录 $DEST"; exit 1; }

if [ ! -d "$WORKSPACE" ]; then
  # 工作区不存在时要**失败退出**：静默成功会让人以为"每天都在备份"。
  log "!! 工作区不存在：$WORKSPACE（本次不备份）"
  exit 1
fi

# 只挑存在的目标：新工作区可能还没有 persona/，那不是错误。
TARGETS=()
for name in AGENTS.md MEMORY.md knowledge persona; do
  [ -e "$WORKSPACE/$name" ] && TARGETS+=("$name")
done
if [ "${#TARGETS[@]}" -eq 0 ]; then
  log "!! $WORKSPACE 里没有任何待备份目标（AGENTS.md / MEMORY.md / knowledge / persona）"
  exit 1
fi

DAY="$(date '+%Y-%m-%d')"
OUT="$DEST/$DAY.tar.gz"
TMP="$OUT.tmp"

log "=== 备份开始：${TARGETS[*]} ==="
if ! tar -czf "$TMP" -C "$WORKSPACE" "${TARGETS[@]}" 2>>"$LOG"; then
  log "!! tar 失败，删除半截文件"
  rm -f "$TMP"
  exit 1
fi

# 写完先验一遍再改名：读不回来的备份比没有备份更危险（会让人放心地删源）。
if ! tar -tzf "$TMP" >/dev/null 2>&1; then
  log "!! 备份文件损坏（tar -tzf 失败），删除"
  rm -f "$TMP"
  exit 1
fi
mv "$TMP" "$OUT"
# 标准 `sha256sum -c` 格式（一行 `<hash>  <路径>`）：这样验收一条命令就够
# `sha256sum -c /srv/dsh/backups/workspace/2026-10-16.tar.gz.sha256`。
(cd "$DEST" && sha256sum "$DAY.tar.gz" > "$DAY.tar.gz.sha256")

size_kb=$(( $(stat -c%s "$OUT") / 1024 ))
files=$(tar -tzf "$OUT" | wc -l)
log "=== 备份完成：$OUT（${size_kb}KB / ${files} 个条目）==="

# 清理超龄备份（连同校验文件）
deleted=0
while IFS= read -r old; do
  rm -f "$old" "$old.sha256"
  deleted=$((deleted + 1))
done < <(find "$DEST" -maxdepth 1 -name '*.tar.gz' -type f -mtime "+${KEEP_DAYS}" | sort)
[ "$deleted" -gt 0 ] && log "清理超龄备份 ${deleted} 份（保留 ${KEEP_DAYS} 天）"

exit 0
