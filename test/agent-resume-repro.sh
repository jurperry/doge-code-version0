#!/usr/bin/env bash
# 代理 API 错误有界续跑端到端（0.2.125，需已重编 bundled exe）：
# 子代理首请求 400 非瞬态错误——旧代码直接判死代理；新代码剥错误尾巴
# 以既有对话续跑（前置原始 prompt），断言：Task 工具结果成功、mock 收到
# 续跑后的第三次请求、主对话正常收尾（无 API Error 顶到主线）。
# 用法：bash test/agent-resume-repro.sh [exePath]
set -u
cd "$(dirname "$0")/.."   # CLI 仓库根
ROOT="$(pwd)"
EXE="${1:-../doge-code-app/build/bin/doge.exe}"
PORT=$((RANDOM % 2000 + 9700))
SANDBOX="$ROOT/test/agent-resume-sandbox"
rm -rf "$SANDBOX" 2>/dev/null || true
mkdir -p "$SANDBOX/projects" "$SANDBOX/run"
SANDBOX_W=$(cygpath -w "$SANDBOX")

env MOCK_PORT=$PORT bun run test/agent-resume-mock.ts > "$SANDBOX/run/mock.log" 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null' EXIT
for _ in $(seq 1 50); do grep -q mockReady "$SANDBOX/run/mock.log" 2>/dev/null && break; sleep 0.1; done
grep -q mockReady "$SANDBOX/run/mock.log" || { echo "FAIL: mock 未启动"; exit 1; }

echo "请用 Task 工具派出一个 general-purpose 子代理去数到三" > "$SANDBOX/run/prompt.txt"
EXE_W=$(cygpath -w "$EXE")
bun run test/one-shot-driver.ts "$EXE_W" "$SANDBOX_W" "$PORT" "$(cygpath -w "$SANDBOX/run/prompt.txt")" 2>&1 | grep -v "^\[" | head -4

echo "== mock 调用日志 =="
grep -v mockReady "$SANDBOX/run/mock.log"
S="$SANDBOX/run/stream.ndjson"
echo "== stream 概览 =="
grep -n 'API Error' "$S" | head -3 | cut -c1-160
grep -n '代理完成' "$S" | head -2 | cut -c1-160
grep -n '"type":"result"' "$S" | head -1 | cut -c1-160

grep -q '"kind":"subagent-400"' "$SANDBOX/run/mock.log" && \
grep -q '"kind":"subagent-ok"' "$SANDBOX/run/mock.log" && \
grep -q '代理完成' "$S" && \
! grep -q '"is_error":true' "$S" && \
  echo "PASS agent-resume：子代理 400 后有界续跑成功，主线正常收尾" || { echo "FAIL agent-resume"; exit 1; }
