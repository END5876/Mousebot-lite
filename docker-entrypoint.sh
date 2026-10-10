#!/bin/sh
# 以 root 啟動，只負責：①確保可寫目錄存在 ②把掛載的 Volume（常為 root 所有）交給 bot 帳號
# ③以 bot 帳號啟動 bgutil 與 Bot，並在它們結束時自動重啟。
#
# 正式版用 supervisord 做這件事；精簡版沒有 supervisord，這裡用同樣的規則實作：
#   - utils/processGuards.js 遇到 uncaughtException 會以 exit 1 結束，由下方迴圈 5 秒後重新拉起
#   - 啟動後 8 秒內就結束視為「啟動失敗」，連續 5 次就停止重試並讓容器結束
#     （對應正式版 supervisord 的 startsecs=8 / startretries=5，避免 Token 錯誤時無限重啟洗版）
#   - 容器收到 SIGTERM / SIGINT（docker stop）時轉給 Bot，等它正常關閉後再結束

set -u

mkdir -p /app/data
# chown 只動「不屬於 bot 的檔案」，Volume 很大時重啟也不會每次都全量改權限
find /app/data ! -user bot -exec chown bot:bot {} + 2>/dev/null || true

# 以 bot 帳號執行（setpriv 會 exec 成目標程式，PID 不變）
AS_BOT="setpriv --reuid=bot --regid=bot --init-groups --"
export HOME=/home/bot USER=bot

# ── bgutil PO Token Provider：掛掉 5 秒後自動重啟 ─────────
(
  while true; do
    $AS_BOT node /opt/bgutil/build/main.js
    echo "[entrypoint] bgutil 伺服器結束，5 秒後重啟" >&2
    sleep 5
  done
) &

# ── Bot ───────────────────────────────────────────────────
START_SECS=8
START_RETRIES=5

stopping=""
child=""
on_signal() {
  stopping=1
  [ -n "$child" ] && kill -TERM "$child" 2>/dev/null
}
trap on_signal TERM INT

fast_fails=0
while :; do
  started=$(date +%s)
  # 必須是「簡單命令 &」：$! 才會是 Bot 本身的 PID，SIGTERM 才送得到 Bot。
  # （包在函式或 subshell 裡放背景時，$! 是外層 subshell，訊號只會殺掉它，Bot 收不到）
  $AS_BOT node /app/index.js &
  child=$!
  wait "$child"
  status=$?

  if [ -n "$stopping" ]; then
    # wait 被訊號打斷時會提前返回，這裡等 Bot 真正關閉
    wait "$child" 2>/dev/null
    exit 0
  fi
  child=""

  if [ $(( $(date +%s) - started )) -lt "$START_SECS" ]; then
    fast_fails=$((fast_fails + 1))
  else
    fast_fails=0
  fi

  if [ "$fast_fails" -ge "$START_RETRIES" ]; then
    echo "[entrypoint] Bot 連續 ${START_RETRIES} 次在 ${START_SECS} 秒內結束（最後 exit ${status}），停止重試" >&2
    exit "$status"
  fi

  echo "[entrypoint] Bot 結束（exit ${status}），5 秒後重啟" >&2
  # 背景 sleep + wait：等待期間收到 docker stop 也能立刻結束
  sleep 5 &
  wait $!
  [ -n "$stopping" ] && exit 0
done
