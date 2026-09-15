#!/bin/zsh
# polycode-hub 一键更新：停旧服务 → 前端构建 → 起新服务 → 健康检查。
# 用法：在仓库根直接 ./update.sh
#
# 2026-09-15 修正（真实缺陷）：旧版用 `pkill -f "polycode-hub.mjs serve"` 停服务，
# 但实际进程命令行是 `tsx server/src/cli.ts serve`（bin 只是转调 tsx），模式永远
# 匹配不到 → 旧进程占着端口不放，新进程 EADDRINUSE 静默死掉，而健康检查却因为
# 旧进程还活着而报「已启动」。结果：构建成功、脚本报成功，页面却一直是旧代码
# （用户实测「改完看不到变化」）。
# 现在改为：按端口精确找占用进程并终止，且健康检查前先确认端口已释放。
set -euo pipefail
cd "$(dirname "$0")"

PORT="${POLYCODE_PORT:-3000}"

# 按端口找监听进程（比按命令行匹配可靠：命令行随启动方式变化）
port_pids() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

echo "==> 停止旧服务"
launchctl bootout "gui/$(id -u)/app.polycode.hub" 2>/dev/null || true
# 除端口占用者外，一并按命令行兜底清理（覆盖不同启动方式）
pkill -f "polycode-hub.mjs serve" 2>/dev/null || true
pkill -f "cli.ts serve" 2>/dev/null || true
for pid in $(port_pids); do
  kill "$pid" 2>/dev/null || true
done
# 等端口真正释放（最多 10s）：端口没腾出来就起新进程，必然 EADDRINUSE
for i in {1..10}; do
  [ -z "$(port_pids)" ] && break
  sleep 1
done
if [ -n "$(port_pids)" ]; then
  echo "==> 端口 $PORT 仍被占用（PID: $(port_pids)），强制终止" >&2
  for pid in $(port_pids); do kill -9 "$pid" 2>/dev/null || true; done
  sleep 1
fi

echo "==> 前端构建"
(cd web && npm run build)

echo "==> 启动服务"
nohup node bin/polycode-hub.mjs serve --port "$PORT" >> data/gateway.log 2>&1 &
NEW_PID=$!

echo "==> 健康检查"
for i in {1..15}; do
  sleep 1
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/admin/api/stats"; then
    # 关键：确认在跑的就是刚拉起的那个进程，而不是没死透的旧进程
    if [ -n "$(port_pids)" ] && [ "$(port_pids | tr '\n' ' ')" != "$(echo "$NEW_PID" | tr '\n' ' ')" ]; then
      echo "==> 警告：端口 $PORT 由 PID $(port_pids) 占用（本次拉起的是 $NEW_PID）" >&2
      echo "    服务可达，但可能不是本次构建的代码。" >&2
    fi
    echo "==> 已启动: http://127.0.0.1:$PORT/admin/ (PID ${NEW_PID})"
    exit 0
  fi
done
echo "==> 启动失败，看日志: data/gateway.log" >&2
tail -20 data/gateway.log >&2
exit 1
