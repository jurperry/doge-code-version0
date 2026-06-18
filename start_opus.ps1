## 清除可能存在的旧环境变量
Remove-Item Env:\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
# 清空DOGE_API_KEY和ANTHROPIC_AUTH_TOKEN
Remove-Item Env:\DOGE_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:\ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
# 上下文窗口清空
Remove-Item Env:\CLAUDE_CODE_MODEL_CONTEXT_WINDOW -ErrorAction SilentlyContinue
Remove-Item Env:\CLAUDE_CODE_AUTO_COMPACT_WINDOW -ErrorAction SilentlyContinue
# 默认模型清空
Remove-Item Env:\ANTHROPIC_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:\ANTHROPIC_DEFAULT_OPUS_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:\ANTHROPIC_DEFAULT_SONNET_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:\ANTHROPIC_DEFAULT_HAIKU_MODEL -ErrorAction SilentlyContinue
# 子智能体模型清空
Remove-Item Env:\CLAUDE_CODE_SUBAGENT_MODEL -ErrorAction SilentlyContinue

# 环境替换
$env:ANTHROPIC_BASE_URL = "https://code.ppchat.vip"
# ANTHROPIC_AUTH_TOKEN与DOGE_API_KEY二者只能取其一
$env:ANTHROPIC_AUTH_TOKEN = "sk-wA8YA4ghVVAB90XMyMvetw4cEm6zNgeERMSGl7RpRdjzMdZG"
$env:DOGE_API_KEY = ""
$env:ANTHROPIC_MODEL = "claude-opus-4-6[1m]"
# 默认模型三种类型：opus、sonnet、haiku，分别对应不同的模型
$env:ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-6[1m]"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-6[1m]"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4-5-20251001"
# SUBAGENT_MODEL 为子智能体模型，默认值为 claude-opus-4-6
$env:CLAUDE_CODE_SUBAGENT_MODEL="claude-opus-4-6[1m]"
# 接入接口的类型: anthropic类型
$env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER = "anthropic"

# 思考等级, 默认值为 max
$env:CLAUDE_CODE_EFFORT_LEVEL="max"

# 设置上下文窗口(1M长上下文)
# 方案1：使用新的通用环境变量
$env:CLAUDE_CODE_MODEL_CONTEXT_WINDOW = "1000000"

# 方案2：使用原有的环境变量
# $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = "1000000"
# $env:CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = "70"

# 自动同步配置到 claude-to-im
$syncScript = Join-Path $PSScriptRoot "sync_to_cti.ps1"
if (Test-Path $syncScript) {
    Write-Host ""
    Write-Host "Syncing configuration to claude-to-im..." -ForegroundColor Cyan
    & $syncScript
}
