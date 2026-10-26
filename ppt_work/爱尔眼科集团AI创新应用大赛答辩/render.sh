#!/bin/bash
# 稳定渲染全部页面为 PNG（带重试）
cd "$(dirname "$0")" || exit 1
export PATH="$PATH:/c/Users/X1 Yoga/.workbuddy/binaries/node/versions/22.22.2-6"
PY="C:/Users/X1 Yoga/.workbuddy/binaries/python/versions/3.13.12/python.exe"
S="C:/Users/X1 Yoga/.workbuddy/plugins/cache/workbuddy-builtin/workbuddy-pptx/5.8.3-wb.41334564.gdb0e9b51.h4da087921e4a/skills/workbuddy-pptx/scripts/edsdk.py"
SRC="build_13.pptx"
OUT="review"
mkdir -p "$OUT"
rm -f "$OUT"/s*.png

# 释放编辑器占用
"$PY" "$S" call get_pool_status 2>/dev/null | "$PY" -c "
import sys,json
try: d=json.load(sys.stdin)
except: sys.exit()
for e in d.get('open_editors',[]):
    if e['type']=='slide': print(e['file_id'])
" | while read fid; do "$PY" "$S" call close_file file_id=$fid force=true >/dev/null 2>&1; done

for i in $(seq 0 14); do
  n=$(printf "%02d" $((i+1)))
  ok=0
  for try in 1 2 3 4; do
    if slidep screenshot "$SRC" --page-index $i --out "$OUT/s$n.png" >/dev/null 2>&1 && [ -f "$OUT/s$n.png" ]; then
      echo "ok $n"; ok=1; break
    fi
    sleep 5
  done
  [ $ok -eq 0 ] && echo "FAIL $n"
done
ls "$OUT" | wc -l
