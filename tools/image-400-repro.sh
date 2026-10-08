#!/usr/bin/env bash
# 图片 400 场景端到端（0.2.125 工作流容错，需已重编的 bundled exe）：
#   corrupt：模型被引导 Read 一个损坏 PNG（真实事故形态：IHDR 完好、
#     IDAT/IEND 垃圾填充，PowerShell 重定向破坏类）——断言容器校验拒绝
#     （工具错误文本、图片不进上下文、API 侧无 400），回合正常完成。
#   reject：模型 Read 合法 PNG，图片进上下文后 mock 回 400 [1210]
#     「图片输入格式/解析错误」——断言剥图重试生效：回合不死于 API Error、
#     mock 收到剥图后的第三次请求、最终 result 成功。
# 用法：bash tools/image-400-repro.sh [corrupt|reject] [exePath]
set -u
cd "$(dirname "$0")/.."   # CLI 仓库根
ROOT="$(pwd)"
MODE="${1:-reject}"
EXE="${2:-../doge-code-app/build/bin/doge.exe}"
PORT=$((RANDOM % 2000 + 9500))
SANDBOX="$ROOT/test/image-400-sandbox"
rm -rf "$SANDBOX" 2>/dev/null || true
mkdir -p "$SANDBOX/projects" "$SANDBOX/run"
# git-bash 的 /e/... 路径 Bun 与 Windows exe 都解析不了——传参一律转 Windows 式
SANDBOX_W=$(cygpath -w "$SANDBOX")

if [ "$MODE" = "corrupt" ]; then
  # 真实事故形态：IHDR 完好、IDAT 损坏（旧 overDim 拦不住、resize 解码
  # 失败的裸透传漏洞只有容器校验能拦）
  bun -e "
    const b = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64')
    b.fill(7, 45)
    await Bun.write(process.argv[1], b)
  " "$SANDBOX_W\\shot.png"
else
  bun -e "await Bun.write(process.argv[1], Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64'))" "$SANDBOX_W\\shot.png"
fi

env MOCK_PORT=$PORT IMG_MODE=$MODE IMG_FILE="$SANDBOX_W\\shot.png" bun run tools/image-400-mock.ts > "$SANDBOX/run/mock.log" 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null' EXIT
for _ in $(seq 1 50); do grep -q mockReady "$SANDBOX/run/mock.log" 2>/dev/null && break; sleep 0.1; done
grep -q mockReady "$SANDBOX/run/mock.log" || { echo "FAIL: mock 未启动"; exit 1; }

echo "请用 Read 工具读取 $SANDBOX_W\\shot.png 并描述内容" > "$SANDBOX/run/prompt.txt"
EXE_W=$(cygpath -w "$EXE")
bun run tools/one-shot-driver.ts "$EXE_W" "$SANDBOX_W" "$PORT" "$(cygpath -w "$SANDBOX/run/prompt.txt")" 2>&1 | grep -v "^\[" | head -4

echo "== mock 调用日志 =="
grep -v mockReady "$SANDBOX/run/mock.log"
S="$SANDBOX/run/stream.ndjson"
echo "== stream 概览 =="
grep -n 'API Error' "$S" | head -3 | cut -c1-160
grep -n 'appears corrupted' "$S" | head -2 | cut -c1-220
grep -n '"type":"result"' "$S" | head -1 | cut -c1-200

if [ "$MODE" = "corrupt" ]; then
  grep -q 'appears corrupted' "$S" && ! grep -q 'API Error' "$S" && \
  grep -q '"is_error":false' "$S" && echo "PASS corrupt：容器校验拒绝损坏图，回合未被 400 打断" || { echo "FAIL corrupt"; exit 1; }
else
  if grep -q 'API Error' "$S"; then echo "FAIL reject：回合死于 API Error（剥图重试未生效）"; exit 1; fi
  grep -q '"image-400"' "$SANDBOX/run/mock.log" && grep -q '"is_error":false' "$S" && \
    echo "PASS reject：400 [1210] 触发剥图重试，回合成功收尾" || { echo "FAIL reject：未见 400 或回合失败"; exit 1; }
fi
