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

# 环境替换
$env:ANTHROPIC_BASE_URL = "https://opencode.ai/zen/go"
# ANTHROPIC_AUTH_TOKEN与DOGE_API_KEY二者只能取其一
$env:DOGE_API_KEY = "sk-BzCNgsphDGJQm1lIdOUZCDnINk6FNFGSaC4JxilULtWBZ7JYjqcRsbCJ8i304iJe"
$env:ANTHROPIC_MODEL = "glm-5.2[1m]"
# 默认模型三种类型：opus、sonnet、haiku，分别对应不同的模型
$env:ANTHROPIC_DEFAULT_OPUS_MODEL="glm-5.2[1m]"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL="glm-5.2[1m]"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL="deepseek-v4-pro"
# 声明模型支持的能力（包括 max_effort）
$env:ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES="effort,max_effort,thinking,adaptive_thinking"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES="effort,max_effort,thinking,adaptive_thinking"
# SUBAGENT_MODEL 为子智能体模型
$env:CLAUDE_CODE_SUBAGENT_MODEL="glm-5.2[1m]"
$env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER = "openai"

# 设置上下文窗口， 1M 上下文窗口
$env:CLAUDE_CODE_MODEL_CONTEXT_WINDOW = "1000000"

# 自动同步配置到 claude-to-im
$syncScript = Join-Path $PSScriptRoot "sync_to_cti.ps1"
if (Test-Path $syncScript) {
    Write-Host ""
    Write-Host "Syncing configuration to claude-to-im..." -ForegroundColor Cyan
    & $syncScript
}