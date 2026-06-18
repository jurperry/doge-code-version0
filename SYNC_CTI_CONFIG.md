# Claude-to-IM 配置自动同步

## 问题

每次切换模型（运行不同的 `start_*.ps1` 脚本）后，需要手动修改 `~/.claude-to-im/config.env` 来同步 API 配置，否则 claude-to-im 会继续使用旧的配置。

## 解决方案

使用 `sync_to_cti.ps1` 脚本自动同步当前环境变量到 `~/.claude-to-im/config.env`。

## 使用方法

### 方法 1：自动同步（推荐）

`start_deepseek.ps1` 已经集成了自动同步功能，运行后会自动更新 claude-to-im 配置：

```powershell
# 运行启动脚本（会自动同步）
.\start_deepseek.ps1

# 重启 claude-to-im 应用新配置
doge
/claude-to-im restart
```

### 方法 2：手动同步

如果其他 `start_*.ps1` 脚本还没有集成自动同步，可以手动运行：

```powershell
# 1. 运行启动脚本
.\start_opus.ps1

# 2. 手动同步配置
.\sync_to_cti.ps1

# 3. 重启 claude-to-im
doge
/claude-to-im restart
```

## 同步的参数

脚本会同步以下环境变量到 `config.env`：

| 环境变量 | 说明 | 示例 |
|---------|------|------|
| `ANTHROPIC_BASE_URL` | API 端点 | `https://api.deepseek.com` |
| `DOGE_API_KEY` | API 密钥（优先） | `sk-xxx` |
| `ANTHROPIC_AUTH_TOKEN` | API 密钥（备选） | `sk-xxx` |
| `ANTHROPIC_MODEL` | 模型名称 | `deepseek-v4-pro` |
| `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` | API 格式 | `openai` 或 `anthropic` |
| `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` | 上下文窗口 | `1000000` |
| `CTI_DEFAULT_MODEL` | claude-to-im 默认模型 | 自动设置为 `ANTHROPIC_MODEL` |

## 不需要同步的参数

以下参数是 Doge Code 主程序专用的，**不需要**同步到 claude-to-im：

- `ANTHROPIC_DEFAULT_OPUS_MODEL` / `SONNET` / `HAIKU` - 模型层级配置
- `ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES` - 模型能力声明
- `CLAUDE_CODE_SUBAGENT_MODEL` - 子智能体模型
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` - 流量控制
- `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` - 流式回退
- `CLAUDE_CODE_EFFORT_LEVEL` - 努力等级
- `CLAUDE_CODE_USE_FOUNDRY` / `BEDROCK` / `VERTEX` - 平台标志

## 为其他启动脚本添加自动同步

如果你想为其他 `start_*.ps1` 脚本添加自动同步功能，在脚本末尾添加：

```powershell
# 自动同步配置到 claude-to-im
$syncScript = Join-Path $PSScriptRoot "sync_to_cti.ps1"
if (Test-Path $syncScript) {
    Write-Host ""
    Write-Host "Syncing configuration to claude-to-im..." -ForegroundColor Cyan
    & $syncScript
}
```

## 验证同步结果

同步后，检查配置是否正确：

```powershell
# 查看 config.env
cat ~/.claude-to-im/config.env

# 或者在 Doge Code 中
doge
/claude-to-im logs
```

日志中应该显示正确的 provider 和 baseURL：

```
[SIMPLE] API key exists: true, baseURL: https://api.deepseek.com, provider: openai
[SIMPLE] Using OpenAI-compatible API with tools
```

## 故障排除

### 问题：同步后 claude-to-im 仍使用旧配置

**解决**：必须重启 claude-to-im 守护进程才能应用新配置

```powershell
doge
/claude-to-im restart
```

### 问题：sync_to_cti.ps1 报错 "config.env not found"

**解决**：确保 claude-to-im 已安装并初始化

```powershell
doge
/claude-to-im start
```

### 问题：同步后仍然报 404 或 400 错误

**解决**：检查以下几点：

1. **API 格式匹配**：
   - DeepSeek OpenAI 格式：`ANTHROPIC_BASE_URL=https://api.deepseek.com` + `CLAUDE_CODE_COMPATIBLE_API_PROVIDER=openai`
   - DeepSeek Anthropic 格式：`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` + `CLAUDE_CODE_COMPATIBLE_API_PROVIDER=anthropic`

2. **API 密钥正确**：
   ```powershell
   echo $env:DOGE_API_KEY
   ```

3. **查看详细日志**：
   ```powershell
   doge
   /claude-to-im logs 100
   ```

## 相关文档

- `debug_updates.md` - 第十八章：claude-to-im 多provider支持与 DeepSeek reasoning_content 修复
- `start_deepseek.ps1` - DeepSeek 启动脚本（已集成自动同步）
- `~/.claude-to-im/config.env` - claude-to-im 配置文件
