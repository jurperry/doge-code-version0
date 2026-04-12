# 设置正确的环境变量, 开启梯子vpn的一个tun虚拟网卡, 相当于直接在国外了
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
$env:ANTHROPIC_AUTH_TOKEN= "your-auth-token"
$env:DOGE_API_KEY = "your-api-key"
$env:ANTHROPIC_MODEL = "gpt-5.4-pro-2026-03-05"
$env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER = "responses"
