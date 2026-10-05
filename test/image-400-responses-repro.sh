#!/usr/bin/env bash
# 图片 400 场景端到端（Responses 格式分支，0.2.126 三分支覆盖）：
#   reject：模型 Read 合法 PNG → 图片进上下文 → mock 回 400 [1210] 中文报文
#     ——断言 responsesCompat 的 APIError 修复后剥图重试生效（回合成功）。
#   corrupt：Read 损坏 PNG（IHDR 完好 IDAT 垃圾）——容器校验在工具层拒绝。
# 用法：bash test/image-400-responses-repro.sh [corrupt|reject] [exePath]
set -u
cd "$(dirname "$0")/.."   # CLI 仓库根
ROOT="$(pwd)"
MODE="${1:-reject}"
EXE="${2:-../doge-code-app/build/bin/doge.exe}"
PORT=$((RANDOM % 2000 + 9800))
SANDBOX="$ROOT/test/image-400-resp-sandbox"
rm -rf "$SANDBOX" 2>/dev/null || true
mkdir -p "$SANDBOX/projects" "$SANDBOX/run"
SANDBOX_W=$(cygpath -w "$SANDBOX")

if [ "$MODE" = "corrupt" ]; then
  bun -e "
    const b = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64')
    b.fill(7, 45)
    await Bun.write(process.argv[1], b)
  " "$SANDBOX_W\\shot.png"
else
  bun -e "await Bun.write(process.argv[1], Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64'))" "$SANDBOX_W\\shot.png"
fi

env MOCK_PORT=$PORT IMG_MODE=$MODE IMG_FILE="$SANDBOX_W\\shot.png" bun run test/image-400-responses-mock.ts > "$SANDBOX/run/mock.log" 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null' EXIT
for _ in $(seq 1 50); do grep -q mockReady "$SANDBOX/run/mock.log" 2>/dev/null && break; sleep 0.1; done
grep -q mockReady "$SANDBOX/run/mock.log" || { echo "FAIL: mock 未启动"; exit 1; }

echo "请用 Read 工具读取 $SANDBOX_W\\shot.png 并描述内容" > "$SANDBOX/run/prompt.txt"
EXE_W=$(cygpath -w "$EXE")
env API_PROVIDER=responses bun run test/one-shot-driver.ts "$EXE_W" "$SANDBOX_W" "$PORT" "$(cygpath -w "$SANDBOX/run/prompt.txt")" 2>&1 | grep -v "^\[" | head -4

echo "== mock 调用日志 =="
grep -v mockReady "$SANDBOX/run/mock.log"
S="$SANDBOX/run/stream.ndjson"
echo "== stream 概览 =="
grep -n 'API Error' "$S" | head -3 | cut -c1-160
grep -n 'appears corrupted' "$S" | head -2 | cut -c1-200
grep -n '"type":"result"' "$S" | head -1 | cut -c1-180

if [ "$MODE" = "corrupt" ]; then
  grep -q 'appears corrupted' "$S" && ! grep -q 'API Error' "$S" && \
  grep -q '"is_error":false' "$S" && echo "PASS responses-corrupt：容器校验拒绝损坏图，回合未被 400 打断" || { echo "FAIL responses-corrupt"; exit 1; }
else
  if grep -q 'API Error' "$S"; then echo "FAIL responses-reject：回合死于 API Error（responses 分支剥图重试未生效）"; exit 1; fi
  grep -q '"image-400"' "$SANDBOX/run/mock.log" && grep -q '"is_error":false' "$S" && \
    echo "PASS responses-reject：400 [1210] 触发剥图重试，回合成功收尾" || { echo "FAIL responses-reject：未见 400 或回合失败"; exit 1; }
fi
