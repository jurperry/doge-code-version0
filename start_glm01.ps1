# 清除环境变量
Remove-Item Env:\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue 
Remove-Item Env:\ANTHROPIC_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:\DOGE_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:\CLAUDE_CODE_MODEL_CONTEXT_WINDOW -ErrorAction SilentlyContinue
Remove-Item Env:\CLAUDE_CODE_AUTO_COMPACT_WINDOW -ErrorAction SilentlyContinue
Remove-Item Env:\CLAUDE_AUTOCOMPACT_PCT_OVERRIDE -ErrorAction SilentlyContinue

# 环境替换
$env:ANTHROPIC_BASE_URL = " your-base-url"
# ANTHROPIC_AUTH_TOKEN与DOGE_API_KEY二者只能取其一
$env:ANTHROPIC_AUTH_TOKEN= "your-auth-token"
$env:DOGE_API_KEY = "your-api-key"
$env:ANTHROPIC_MODEL = "glm-5.1"
$env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER = "anthropic"

# 设置上下文窗口， 200k 上下文
$env:CLAUDE_CODE_MODEL_CONTEXT_WINDOW = "200000"
