# 清除可能存在的旧环境变量
Remove-Item Env:\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:\ANTHROPIC_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:\DOGE_API_KEY -ErrorAction SilentlyContinue

# 设置 DeepSeek API 环境变量
$env:ANTHROPIC_BASE_URL = "https://api.deepseek.com"
$env:DOGE_API_KEY = "sk-25bb3b9f1a7f4002bfed437be7ce8ada"
$env:ANTHROPIC_MODEL = "deepseek-chat"
$env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER = "openai"
# 使用直接在dog-code目录下 .\start_env.ps1启动claudecode即可