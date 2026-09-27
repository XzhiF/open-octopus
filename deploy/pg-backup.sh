#!/usr/bin/env bash
# P1 备份（R4 缓解：每日 pg_dump；cron 挂法见 pg-restore-drill.sh 头注）。
# 没演练过恢复的备份不算备份 —— 定期跑 deploy/pg-restore-drill.sh。
set -euo pipefail

DEST_DIR="${OCTOPUS_PG_BACKUP_DIR:-$HOME/.octopus/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$DEST_DIR/octopus-$STAMP.dump"
mkdir -p "$DEST_DIR"

docker exec -t octopus-pg pg_dump -U octopus -d octopus -Fc -f /tmp/backup.dump
docker cp octopus-pg:/tmp/backup.dump "$FILE"
docker exec octopus-pg rm -f /tmp/backup.dump

# 滚动保留 14 份
ls -1t "$DEST_DIR"/octopus-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f
echo "backup: $FILE ($(du -h "$FILE" | cut -f1))"
