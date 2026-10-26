#!/bin/bash
# 安全插页：始终写入全新副本，规避文件占用锁
# 用法: ./add.sh <slide文件路径> <page_index>
export PATH="$PATH:/c/Users/X1 Yoga/.workbuddy/binaries/node/versions/22.22.2-6"
PY="C:/Users/X1 Yoga/.workbuddy/binaries/python/versions/3.13.12/python.exe"
cd "$(dirname "$0")" || exit 1
DSL="$1"
IDX="$2"
STATE=".state"
CUR=$(cat $STATE 2>/dev/null || echo "答辩_v2.pptx")

# 生成一个从未存在过的新文件名
N=$(( $(cat .ver 2>/dev/null || echo 2) + 1 ))
echo $N > .ver
NEW="build_${N}.pptx"
cp "$CUR" "$NEW"

for i in 1 2 3; do
  OUT=$(slidep upsert-dsl "$NEW" --dsl-file "$DSL" --page-index "$IDX" 2>&1 | grep -E '^\{' | tail -1)
  case "$OUT" in
    *'"ok":true'*) echo "INSERT_OK -> $NEW"; echo "$NEW" > $STATE; break;;
    *) echo "  retry $i: $(echo "$OUT" | head -c 90)"; sleep 4;;
  esac
  [ $i -eq 3 ] && { echo "INSERT_FAILED"; exit 1; }
done

for i in 1 2; do
  LINT=$(slidep lint "$NEW" --dsl-file "$DSL" --page-index "$IDX" --visual 2>&1 | grep -E '^\{' | tail -1)
  case "$LINT" in
    *'"diagnostics":[]'*) echo "LINT_OK"; break;;
    *'visual-unavailable'*) echo "LINT_DEGRADED"; break;;
    *) echo "  lint: $(echo "$LINT" | head -c 400)"; sleep 4;;
  esac
done

# 清理旧副本（保留最近 2 个）
ls -t build_*.pptx 2>/dev/null | tail -n +3 | while read f; do rm -f "$f"; done
