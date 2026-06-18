# CC-DOGE-Switch 设计文档

- 日期: 2026-06-18
- 状态: 已批准,待实现
- 产物位置: `E:\CC-DOGE-Switch\`

## 1. 背景与问题

Doge Code 通过 `start_*.ps1` 脚本切换 API 提供商。当前仓库内有 7 个脚本:

| 脚本 | 自定义名(拟) | 主模型 | provider | baseURL |
|------|--------------|--------|----------|---------|
| `start_deepseek.ps1` | DeepSeek | deepseek-v4-pro[1m] | openai | api.deepseek.com |
| `start_deepseek_ant.ps1` | DeepSeek-Anthropic | deepseek-v4-pro[1m] | anthropic | api.deepseek.com/anthropic |
| `start_glm.ps1` | GLM | glm-5.1 | anthropic | open.bigmodel.cn/api/anthropic |
| `start_glm01.ps1` | GLM01 | glm-5.1 | anthropic | aiproxy.xin/cosphere |
| `start_coding_plan.ps1` | Coding-Plan | glm-5.1 | anthropic | ark.cn-beijing.volces.com/api/coding |
| `start_opus.ps1` | Opus代理 | claude-opus-4-6[1m] | anthropic | code.ppchat.vip |
| `start_qwen.ps1` | Qwen | qwen3.7-max[1m] | anthropic | dashscope.aliyuncs.com/apps/anthropic |

每个脚本做两件事:
1. 清空再设置 14 个环境变量(进程级 `$env:`)
2. 调用 `sync_to_cti.ps1` 同步到 claude-to-im 的 `config.env`

脚本**只设变量**,不启动 CLI;用户随后在同一个 PowerShell 会话手动跑 `bun run dev` / `doge`。

痛点:
- 切换要记脚本名、要开 PowerShell
- 进程级变量只在当前会话生效,新开终端拿不到
- 参数硬编码在脚本里,改一个值要编辑 `.ps1`
- 无法一眼看到当前激活的是哪套配置、密钥是什么

## 2. 产品定位

CC-DOGE-Switch.exe 是一个 Windows GUI **配置启动器**,只做两件事:

1. **管理多份配置 profile**(增/删/改/复制/列表展示)
2. **点「启动」按钮**把选定 profile 写入**用户级环境变量**,使新开终端继承

明确**不做**:
- 不拉起 doge CLI(启动仍由用户手动在新终端跑)
- 不做 CTI 同步(那部分可后续按需加)
- 不改 doge 主项目代码

## 3. 技术栈

- **PowerShell 5.1 + Windows Forms(WinForms)**:Win11 自带 PS5.1 + .NET Framework,WinForms 可用,无需额外运行时。与本仓库现有 `start_*.ps1` 同语系,读写注册表环境变量零障碍。
- **ps2exe 打包**:把 `.ps1` 打包成单文件 `.exe`。打包时联网拉取 ps2exe(本机未安装)。

环境已验证:PowerShell 5.1.22621.3880、E 盘可写、`E:\CC-DOGE-Switch` 已建、ps2exe 未安装(打包时拉取)。

## 4. 目录布局

```
E:\CC-DOGE-Switch\
├── CC-DOGE-Switch.ps1      # 源码(WinForms GUI + 逻辑)
├── build.ps1               # 打包脚本(调 ps2exe 生成 exe)
├── CC-DOGE-Switch.exe      # 打包产物(双击运行)
├── profiles.json           # 配置持久化(运行时生成)
└── README.md               # 使用说明
```

全部集中在 `E:\CC-DOGE-Switch\`,与主项目解耦,独立维护。

## 5. 数据模型(profiles.json)

每份配置是一个对象,数组存放。字段对齐 7 个脚本的 14 个环境变量。

```jsonc
{
  "profiles": [
    {
      "customName": "DeepSeek",
      "mainModel": "deepseek-v4-pro[1m]",
      "ANTHROPIC_BASE_URL": "https://api.deepseek.com",
      "apiKeyField": "DOGE_API_KEY",
      "apiKeyValue": "sk-xxx",
      "ANTHROPIC_MODEL": "deepseek-v4-pro[1m]",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro[1m]",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-pro[1m]",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
      "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES": "effort,max_effort,thinking,adaptive_thinking",
      "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES": "effort,max_effort,thinking,adaptive_thinking",
      "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek-v4-pro[1m]",
      "CLAUDE_CODE_COMPATIBLE_API_PROVIDER": "openai",
      "CLAUDE_CODE_MODEL_CONTEXT_WINDOW": "1000000",
      "CLAUDE_CODE_EFFORT_LEVEL": "max",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
      "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK": "1"
    }
  ]
}
```

### 密钥二选一建模

`apiKeyField` + `apiKeyValue` 两字段表达「`DOGE_API_KEY` 与 `ANTHROPIC_AUTH_TOKEN` 二选一」:
- `apiKeyField` ∈ `{ "DOGE_API_KEY", "ANTHROPIC_AUTH_TOKEN" }`
- 启动时写 `apiKeyField` 指定的变量为 `apiKeyValue`,**另一个变量写空串清除**(对齐脚本:用了 AUTH_TOKEN 就清空 DOGE_API_KEY)

### 14 个环境变量清单

| # | 环境变量 | profile 字段 | 说明 |
|---|---------|-------------|------|
| 1 | ANTHROPIC_BASE_URL | ANTHROPIC_BASE_URL | API 端点 |
| 2 | DOGE_API_KEY / ANTHROPIC_AUTH_TOKEN | apiKeyField+apiKeyValue | 密钥二选一 |
| 3 | CLAUDE_CODE_COMPATIBLE_API_PROVIDER | CLAUDE_CODE_COMPATIBLE_API_PROVIDER | anthropic\|openai\|responses |
| 4 | ANTHROPIC_MODEL | ANTHROPIC_MODEL | 默认主模型 |
| 5 | CLAUDE_CODE_MODEL_CONTEXT_WINDOW | CLAUDE_CODE_MODEL_CONTEXT_WINDOW | 上下文窗口 |
| 6 | ANTHROPIC_DEFAULT_OPUS_MODEL | ANTHROPIC_DEFAULT_OPUS_MODEL | opus 档 |
| 7 | ANTHROPIC_DEFAULT_SONNET_MODEL | ANTHROPIC_DEFAULT_SONNET_MODEL | sonnet 档 |
| 8 | ANTHROPIC_DEFAULT_HAIKU_MODEL | ANTHROPIC_DEFAULT_HAIKU_MODEL | haiku 档 |
| 9 | ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES | 同名 | opus 能力声明 |
| 10 | ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES | 同名 | sonnet 能力声明 |
| 11 | CLAUDE_CODE_SUBAGENT_MODEL | CLAUDE_CODE_SUBAGENT_MODEL | 子智能体模型 |
| 12 | CLAUDE_CODE_EFFORT_LEVEL | CLAUDE_CODE_EFFORT_LEVEL | low\|medium\|high\|max |
| 13 | CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC | 同名 | 0\|1 |
| 14 | CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK | 同名 | 0\|1 |

## 6. 预置数据

首次启动(检测到 `profiles.json` 不存在)自动生成 7 份,从现有 7 个 `start_*.ps1` 提取参数。key/baseURL 直接从脚本读取硬编码进预置逻辑。

各脚本的密钥字段归属:
- DeepSeek / GLM / GLM01 → `DOGE_API_KEY`
- DeepSeek-Anthropic / Coding-Plan / Opus代理 / Qwen → `ANTHROPIC_AUTH_TOKEN`

(Coding-Plan 的脚本里设了 `ANTHROPIC_AUTH_TOKEN` + baseURL 是火山引擎 ark coding 端点,主模型 glm-5.1,但 sonnet 档用了 kimi-k2.6、subagent 用 deepseek-v4-flash —— 预置时按脚本原文逐字段提取。)

## 7. GUI 布局(WinForms)

```
┌─ CC-DOGE-Switch ─────────────────────────────────┐
│ [+ 新建] [编辑] [复制] [删除]        [刷新]        │  工具栏
├──────────────────────────────────────────────────┤
│ 配置列表 (ListView, 双列: 自定义名 | 主模型)        │
│ ┌──────────────┬──────────────────────┐          │
│ │ DeepSeek     │ deepseek-v4-pro[1m]  │ ◀ 选中   │
│ │ GLM          │ glm-5.1              │          │
│ │ Opus代理     │ claude-opus-4-6[1m]  │          │
│ │ ...          │ ...                  │          │
│ └──────────────┴──────────────────────┘          │
├──────────────────────────────────────────────────┤
│ 选中配置详情(只读预览,编辑在弹窗):                  │
│   BaseURL:  https://api.deepseek.com              │
│   Provider: openai    上下文: 1000000              │
│   Effort:   max        Key: ***...4ada            │
│   Opus/Sonnet/Haiku: ... / ... / ...              │
├──────────────────────────────────────────────────┤
│            [   启   动   ]                        │  显性启动按钮
│  状态: 当前未激活任何配置 / 已激活: DeepSeek        │
└──────────────────────────────────────────────────┘
```

- **列表 ListView**:双列(自定义名 | 主模型名),单击选中、双击编辑
- **工具栏**:新建、编辑、复制、删除、刷新
- **详情区**:选中后只读预览关键信息,密钥掩码(`***` + 后 4 位)
- **编辑/新建**:独立弹窗,全 14 字段表单;key 字段用 PasswordBox 掩码
- **启动按钮**:写用户级环境变量后弹提示
- **状态栏**:显示当前激活的 profile(读取注册表 `HKCU\Environment` 比对 mainModel + baseURL)

## 8. 「启动」动作的落地

点击启动 → 对选中 profile 执行:

### 步骤 1:清空全部 14 个变量(复刻脚本开头的 Remove-Item)

```powershell
$envVars = @(
  'ANTHROPIC_BASE_URL','DOGE_API_KEY','ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_COMPATIBLE_API_PROVIDER','ANTHROPIC_MODEL',
  'CLAUDE_CODE_MODEL_CONTEXT_WINDOW','CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES','ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_SUBAGENT_MODEL','CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC','CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK'
)
foreach ($n in $envVars) { [Environment]::SetEnvironmentVariable($n, $null, 'User') }
```

> 注意:清单含 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`(脚本开头也清它),共 16 个清理项。清理**只针对这批已知变量**,不动用户其他环境变量。`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 不在 profile 字段里(脚本里都是注释掉的),只参与清理。

### 步骤 2:写入选中 profile 的值

```powershell
[Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $profile.ANTHROPIC_BASE_URL, 'User')
[Environment]::SetEnvironmentVariable($profile.apiKeyField, $profile.apiKeyValue, 'User')
# ... 其余 12 个字段同理
```

### 步骤 3:广播 WM_SETTINGCHANGE

```powershell
# 通知资源管理器刷新,使新开终端立即继承(不广播则需注销重登)
Add-Type -Namespace Win32 -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
public const uint HWND_BROADCAST = 0xffff;
public const uint WM_SETTINGCHANGE = 0x001A;
public const uint SMTO_ABORTIFHUNG = 0x0002;
'@
[UIntPtr]$result = [UIntPtr]::Zero
[Win32.Native]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 1000, [ref]$result) | Out-Null
```

### 步骤 4:提示

弹消息框:「已激活 [DeepSeek]。请新开 PowerShell 终端运行 `doge` 或 `bun run dev`。」状态栏更新为「已激活: DeepSeek」。

**不拉起 CLI。**

## 9. 错误处理与边界

- **profiles.json 读写失败**:捕获异常,弹错误框,不崩溃;首次启动写失败则在 exe 同目录回退
- **ps2exe 打包失败**:build.ps1 报错并提示手动 `Install-Module ps2exe -Scope CurrentUser -Force`
- **注册表写失败**(权限不足):弹提示「需以当前用户身份运行,无法写入用户环境变量」
- **空配置列表**:禁用启动按钮,提示先新建
- **JSON 损坏**:备份为 `profiles.json.corrupt-时间戳`,重新生成预置 7 份
- **密钥安全**:profiles.json 明文存 key(与现有脚本明文一致,不引入额外加密);列表/详情掩码显示

## 10. 测试方案

1. **预置数据**:删 `profiles.json` → 启动 exe → 确认生成 7 份、内容与脚本一致
2. **启动落地**:选中 DeepSeek → 启动 → 新开 PowerShell → `echo $env:ANTHROPIC_BASE_URL` 确认 `https://api.deepseek.com`;`echo $env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER` 确认 `openai`
3. **切换清理**:激活 DeepSeek(有 effort=max + 两个开关=1)→ 激活 Qwen(无 effort、无开关)→ 新开终端确认 `CLAUDE_CODE_EFFORT_LEVEL` 已清空(不残留 max)、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 已清空
4. **增删改**:新建一份 → 重启 exe 确认持久化 → 编辑 → 删除 → 确认 profiles.json 同步
5. **打包产物**:跑 build.ps1 → 生成 exe → 双击运行确认 GUI 正常(打包后 exe 行为与 .ps1 一致)

## 11. 范围边界(YAGNI)

本轮**不做**:
- 拉起 doge CLI / 开终端
- CTI 同步(复刻 sync_to_cti.ps1)
- 配置导入导出
- 密钥加密
- 模型能力自动推导(全字段手填)
- 多机同步

这些留作后续评估。
