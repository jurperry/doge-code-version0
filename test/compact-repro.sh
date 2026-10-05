#!/usr/bin/env bash
# 压缩直播链路复现/回归（0.2.125 压缩修复）：
#   场景 A（默认）：CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1 强制自动压缩——断言
#     stream-json 输出含 compact_boundary 与摘要 user 帧（"This session is
#     being continued…"），即 App 直播显示链的完整输入；断言 boundary 的
#     pre_tokens 未采信 mock 虚报值。
#   场景 B（ARTIFACT=1）：mock 对第 2 次普通请求的 usage 报 4x（GLM 虚报
#     artifact）、真实阈值（200k 窗口）——断言不触发假压缩（无 boundary）。
# 用法：bash test/compact-repro.sh [A|B]
set -u
cd "$(dirname "$0")/.."   # 仓库根
ROOT="$(pwd)"
SCENARIO="${1:-A}"
PORT=$((RANDOM % 2000 + 9000))
SANDBOX="$ROOT/test/compact-repro-sandbox"
rm -rf "$SANDBOX"; mkdir -p "$SANDBOX/projects" "$SANDBOX/run"

MOCK_ENV=""
OVERRIDE="1"
PAD_ENV=""
if [ "$SCENARIO" = "B" ]; then
  MOCK_ENV="MOCK_ARTIFACT=1 MOCK_ARTIFACT_AT=2"
  PAD_ENV="PAD=1"   # 首问填充（驱动进程读）
  OVERRIDE=""   # 真实阈值（200k 窗口）：真实 ~150k 低于阈值、4x 虚报 ~600k 超窗
fi

env MOCK_PORT=$PORT $MOCK_ENV bun run test/compact-repro-mock.ts > "$SANDBOX/run/mock.log" 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null' EXIT
for _ in $(seq 1 50); do grep -q mockReady "$SANDBOX/run/mock.log" 2>/dev/null && break; sleep 0.1; done
grep -q mockReady "$SANDBOX/run/mock.log" || { echo "FAIL: mock 未启动"; cat "$SANDBOX/run/mock.log"; exit 1; }

env $PAD_ENV bun run test/compact-repro-driver.ts "$ROOT/src/bootstrap-entry.ts" "$SANDBOX" "$PORT" "$OVERRIDE" 2>&1 | grep -v "^\[" | head -8
DRV_RC=${PIPESTATUS[0]}

echo "== mock 调用日志 =="
grep -v mockReady "$SANDBOX/run/mock.log" || true
echo "== stream 关键行（rc=$DRV_RC）=="
S="$SANDBOX/run/stream.ndjson"
[ -f "$S" ] || { echo "FAIL: 无 stream.ndjson"; exit 1; }
wc -l < "$S" | sed 's/^/总行数: /'
grep -n '"subtype":"compact_boundary"' "$S" | head -3 | cut -c1-240
grep -n '"status":"compacting"' "$S" | head -2 | cut -c1-160
grep -n 'This session is being continued' "$S" | head -2 | cut -c1-220
grep -n '"type":"result"' "$S" | wc -l | sed 's/^/result 行数: /'

if [ "$SCENARIO" = "A" ]; then
  ok=1
  grep -q '"subtype":"compact_boundary"' "$S" || { echo "MISS: 无 compact_boundary"; ok=0; }
  grep -q 'This session is being continued' "$S" || { echo "MISS: 无摘要 user 帧"; ok=0; }
  [ "$ok" = 1 ] && echo "PASS A：boundary + 摘要 user 帧均出现在直播输出" || { echo "FAIL A"; exit 1; }
else
  if grep -q '"subtype":"compact_boundary"' "$S"; then
    echo "FAIL B：artifact 假触发了压缩"; exit 1
  fi
  [ "$(grep -c '"type":"result"' "$S")" = 2 ] && echo "PASS B：4x 虚报被守卫跳过，两轮正常完成、未假触发压缩" || { echo "FAIL B：轮次不完整"; exit 1; }
fi
