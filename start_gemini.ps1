# 清除环境变量
Remove-Item Env:\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue 
Remove-Item Env:\ANTHROPIC_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:\DOGE_API_KEY -ErrorAction SilentlyContinue
# 环境替换
$env:ANTHROPIC_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai"
$env:DOGE_API_KEY = "AIzaSyCDeeldZ3YeTgrtOIP2BBKkioy8yxUQsjc"
$env:ANTHROPIC_MODEL = "gemini-2.5-flash"
$env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER = "openai"
