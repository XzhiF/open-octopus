#!/usr/bin/env bash
# 恢复演练 —— 「没演练过的备份不算备份」（P1 判据⑤）。
# 用法：  deploy/pg-restore-drill.sh [dump文件]   # 缺省取最新备份
# 校验：  逐表真实 count(*) + 全行内容 md5，原库 vs 恢复库必须逐位一致。
# 建议每日 cron： 15 3 * * * <abs>/deploy/pg-backup.sh && <abs>/deploy/pg-restore-drill.sh
set -euo pipefail

DEST_DIR="${OCTOPUS_PG_BACKUP_DIR:-$HOME/.octopus/backups}"
DUMP="${1:-$(ls -1t "$DEST_DIR"/octopus-*.dump 2>/dev/null | head -1)}"
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "no dump found in $DEST_DIR"; exit 1; }

DRILL_DB="octopus_drill_$(date +%s)"
echo "drill: restore $(basename "$DUMP") -> $DRILL_DB"

docker cp "$DUMP" octopus-pg:/tmp/drill.dump
trap 'docker exec octopus-pg psql -U octopus -d postgres -q -c "DROP DATABASE IF EXISTS $DRILL_DB" >/dev/null 2>&1; docker exec octopus-pg rm -f /tmp/drill.dump' EXIT

docker exec octopus-pg psql -U octopus -d postgres -q -c "CREATE DATABASE $DRILL_DB"
docker exec octopus-pg pg_restore -U octopus -d "$DRILL_DB" --no-owner /tmp/drill.dump

TABLES=$(docker exec octopus-pg psql -U octopus -d octopus -At \
  -c "select table_name from information_schema.tables
      where table_schema='public' and table_type='BASE TABLE' order by table_name")

if [ -z "$TABLES" ]; then
  echo "drill WARN: 原库 public 无表（P1 搬迁前属正常），仅验证了 dump 可恢复"
  exit 0
fi

FAILED=0
while IFS= read -r T; do
  # 全行内容指纹：按主键序拼行文本取 md5；无主键的表按 ctid 序（搬迁表必有 PK，防御起见）
  FP_SQL="select count(*)||'|'||md5(coalesce(string_agg(t::text, E'\n' order by t::text),'empty'))
          from (select * from \"${T}\") t"
  A=$(docker exec octopus-pg psql -U octopus -d octopus -At -c "$FP_SQL")
  B=$(docker exec octopus-pg psql -U octopus -d "$DRILL_DB" -At -c "$FP_SQL")
  if [ "$A" = "$B" ]; then
    echo "  ok   $T ($A)"
  else
    echo "  DIFF $T  src=[$A] restored=[$B]"; FAILED=1
  fi
done <<< "$TABLES"

if [ "$FAILED" = 1 ]; then
  echo "drill FAIL: 存在逐表指纹差异"; exit 1
fi
echo "drill PASS: $(echo "$TABLES" | wc -l | tr -d ' ') 张表行数与内容逐位一致"
