# 设置正确的环境变量, 开启梯子vpn的一个tun虚拟网卡, 相当于直接在国外了
# 清除环境变量
Remove-Item Env:\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue 
Remove-Item Env:\ANTHROPIC_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:\DOGE_API_KEY -ErrorAction SilentlyContinue
# 环境变量替换

$env:ANTHROPIC_BASE_URL = "https://api.v3.cm"
$env:DOGE_API_KEY = "sk-cmqdc6PcHNTnUBKd94605b78B06e439dAb81C52d9cCb02Ce"
$env:ANTHROPIC_MODEL = "gpt-5.3-codex"
$env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER = "openai"
