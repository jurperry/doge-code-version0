# 清除环境变量
Remove-Item Env:\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue 
Remove-Item Env:\ANTHROPIC_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:\DOGE_API_KEY -ErrorAction SilentlyContinue
# 环境替换
$env:ANTHROPIC_BASE_URL = "https://api.siliconflow.cn"
$env:DOGE_API_KEY = "sk-kdhnqhsekhnrmhgatpbrssmimiywkmgvceouashaczysgvis"
$env:ANTHROPIC_MODEL = "Pro/zai-org/GLM-5"
$env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER = "openai"
