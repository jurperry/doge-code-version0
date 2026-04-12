# 清除可能存在的旧环境变量
Remove-Item Env:\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:\ANTHROPIC_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:\DOGE_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:\CLAUDE_CODE_MODEL_CONTEXT_WINDOW -ErrorAction SilentlyContinue
Remove-Item Env:\CLAUDE_CODE_AUTO_COMPACT_WINDOW -ErrorAction SilentlyContinue
Remove-Item Env:\CLAUDE_AUTOCOMPACT_PCT_OVERRIDE -ErrorAction SilentlyContinue

# 设置 DeepSeek API 环境变量
$env:ANTHROPIC_BASE_URL = "https://api.deepseek.com"
# ANTHROPIC_AUTH_TOKEN与DOGE_API_KEY二者只能取其一
$env:ANTHROPIC_AUTH_TOKEN="your-auth-token"
$env:DOGE_API_KEY = "your-api-key"
$env:ANTHROPIC_MODEL = "deepseek-chat"
$env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER = "openai"

# 设置上下文窗口（DeepSeek API 实际限制是 100k，虽然文档说 128k）
# 方案1：使用新的通用环境变量
$env:CLAUDE_CODE_MODEL_CONTEXT_WINDOW = "100000"

# 方案2：使用原有的环境变量
# $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = "100000"
# $env:CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = "70"