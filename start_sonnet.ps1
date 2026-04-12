# 对于claude-code而言也是可以直接使用滴
# 清除环境变量
Remove-Item Env:\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue 
Remove-Item Env:\ANTHROPIC_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:\DOGE_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:\CLAUDE_CODE_MODEL_CONTEXT_WINDOW -ErrorAction SilentlyContinue
Remove-Item Env:\CLAUDE_CODE_AUTO_COMPACT_WINDOW -ErrorAction SilentlyContinue
Remove-Item Env:\CLAUDE_AUTOCOMPACT_PCT_OVERRIDE -ErrorAction SilentlyContinue

# 环境替换
$env:ANTHROPIC_BASE_URL = "https://api.v3.cm"
# ANTHROPIC_AUTH_TOKEN与DOGE_API_KEY二者只能取其一
$env:ANTHROPIC_AUTH_TOKEN=""
$env:DOGE_API_KEY = "sk-cmqdc6PcHNTnUBKd94605b78B06e439dAb81C52d9cCb02Ce"
$env:ANTHROPIC_MODEL = "claude-sonnet-4-6"
$env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER = "anthropic"

