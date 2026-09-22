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
#
# 2026-09-22 修正（三个真实缺陷，全部坑「按 README 从零配置」的用户）：
# 1. 全新 clone 上必然中断：data/ 整目录被 gitignore，仓库里不存在，而
#    `nohup ... >> data/gateway.log` 打不开文件；开头 set -e 下重定向失败 →
#    构建完成后脚本立即退出，服务根本起不来，报错还不自解释。
#    → cd 之后先 `mkdir -p data`。
# 2. 配了 admin_key 的用户健康检查必失败（误报「启动失败」）：原检查打
#    /admin/api/stats，该端点受 X-Admin-Key 保护（adminapi/api.ts withAuth），
#    而 README 推荐的示例配置恰好 admin_key: "changeme" → curl -sf 收 401 判失败
#    → 循环 15 次后报「启动失败」并 tail 日志，其实进程早就起来了。
#    → 改打免鉴权的 GET /health 存活探针（gateway/proxy.ts handleHealth 专为此设）。
# 3. pkill 兜底会误杀其他项目：`pkill -f "cli.ts serve"` 会命中任何仓库里同命令行
#    的进程（别的项目也用 tsx 跑 cli.ts serve 就被连坐）；按端口 kill 同理，端口
#    若被无关应用占用也会被误杀。
#    → pkill 与端口两条路都先用 lsof 查进程 cwd，只有 cwd == 本仓库根才 kill；
#      端口被外来进程占用则不杀它，直接报错退出（提示 PID 与 POLYCODE_PORT）。
set -euo pipefail
cd "$(dirname "$0")"
# 仓库根绝对路径：下面所有「这个进程是不是本项目的」判断都拿它和 lsof 查到的 cwd 比
REPO_ROOT="$PWD"
# data/ 被 gitignore（SQLite 用量与日志落盘），全新 clone 里不存在；
# 不先建目录，nohup 的 >> data/gateway.log 重定向会因目录缺失而失败，
# 在 set -e 下让脚本在构建后静默退出
mkdir -p data

PORT="${POLYCODE_PORT:-3000}"

# 按端口找监听进程（比按命令行匹配可靠：命令行随启动方式变化）
port_pids() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

# 取进程的工作目录（lsof -Fn 输出 n 开头的行是路径）
proc_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true
}

# 该进程是否属于本项目：cwd 必须就是本仓库根（脚本已 cd 到这里）。
# 用于防止 pkill -f / 端口匹配把别的项目的同名进程连坐杀掉。
is_ours() {
  [ -n "$1" ] && [ "$(proc_cwd "$1")" = "$REPO_ROOT" ]
}

echo "==> 停止旧服务"
launchctl bootout "gui/$(id -u)/app.polycode.hub" 2>/dev/null || true
# 除端口占用者外，一并按命令行兜底清理（覆盖不同启动方式）。
# 不能直接 pkill -f：它会匹配「任何项目」里的同命令行进程，
# 所以用 pgrep 拿到 PID 后逐个校验 cwd，只杀确认属于本仓库的。
kill_matching_cmdline() {
  local pid
  for pid in $(pgrep -f "$1" 2>/dev/null || true); do
    if is_ours "$pid"; then
      kill "$pid" 2>/dev/null || true
    else
      echo "==> 跳过 PID $pid（命令行匹配「$1」但 cwd 非本项目，不动它）" >&2
    fi
  done
}
kill_matching_cmdline "polycode-hub.mjs serve"
kill_matching_cmdline "cli.ts serve"
# 端口占用者：cwd 是本项目才 kill；外来进程一律不杀，直接报错退出——
# 它没做错什么，杀掉会殃及用户机器上的其他服务
for pid in $(port_pids); do
  if is_ours "$pid"; then
    kill "$pid" 2>/dev/null || true
  else
    echo "==> 错误：端口 $PORT 被非本项目进程占用（PID: $pid, cwd: $(proc_cwd "$pid")）" >&2
    echo "    请检查 POLYCODE_PORT 是否与别的服务冲突，或释放端口 $PORT 后重试。" >&2
    exit 1
  fi
done
# 等端口真正释放（最多 10s）：端口没腾出来就起新进程，必然 EADDRINUSE
for i in {1..10}; do
  [ -z "$(port_pids)" ] && break
  sleep 1
done
if [ -n "$(port_pids)" ]; then
  for pid in $(port_pids); do
    if is_ours "$pid"; then
      echo "==> 端口 $PORT 仍被占用（PID: $pid），强制终止" >&2
      kill -9 "$pid" 2>/dev/null || true
    else
      echo "==> 错误：端口 $PORT 被非本项目进程占用（PID: $pid, cwd: $(proc_cwd "$pid")）" >&2
      echo "    请检查 POLYCODE_PORT 是否与别的服务冲突，或释放端口 $PORT 后重试。" >&2
      exit 1
    fi
  done
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
  # 打免鉴权的 GET /health 存活探针：/admin/api/stats 受 X-Admin-Key 保护，
  # README 示例配置 admin_key: "changeme" 的用户 curl -sf 必收 401，会误报「启动失败」
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/health"; then
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
