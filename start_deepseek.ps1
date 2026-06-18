# 清除可能存在的旧环境变量
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
# 禁用非必要流量
Remove-Item Env:\CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC -ErrorAction SilentlyContinue
# 禁用非流式回退
Remove-Item Env:\CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK -ErrorAction SilentlyContinue


# 设置 DeepSeek API 环境变量
$env:ANTHROPIC_BASE_URL = "https://api.deepseek.com"
# ANTHROPIC_AUTH_TOKEN与DOGE_API_KEY二者只能取其一
$env:DOGE_API_KEY = "sk-25bb3b9f1a7f4002bfed437be7ce8ada"
$env:ANTHROPIC_MODEL = "deepseek-v4-pro[1m]"
# 默认模型三种类型：opus、sonnet、haiku，分别对应不同的模型
$env:ANTHROPIC_DEFAULT_OPUS_MODEL="deepseek-v4-pro[1m]"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL="deepseek-v4-pro[1m]"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL="deepseek-v4-flash"
# 声明模型支持的能力（包括 max_effort）
$env:ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES="effort,max_effort,thinking,adaptive_thinking"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES="effort,max_effort,thinking,adaptive_thinking"
# SUBAGENT_MODEL 为子智能体模型，默认值为 deepseek-v4-pro[1m]
$env:CLAUDE_CODE_SUBAGENT_MODEL="deepseek-v4-pro[1m]"
# 禁用非必要流量
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
# 禁用非流式回退
$env:CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1
# 努力等级, 默认值为 max
$env:CLAUDE_CODE_EFFORT_LEVEL="max"
# 接入接口的类型: openai类型
$env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER = "openai"

# 设置上下文窗口(DeepSeek API 支持到了1M长上下文)
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

