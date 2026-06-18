# CC-DOGE-Switch 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Windows GUI 配置启动器 `CC-DOGE-Switch.exe`,管理多份 doge API 配置,点「启动」把选定配置写入用户级环境变量,替代现有 7 个 `start_*.ps1` 脚本。

**Architecture:** PowerShell 5.1 + Windows Forms 单文件 GUI。配置持久化为 `E:\CC-DOGE-Switch\profiles.json`,首次启动预置 7 份对应现有脚本的配置。启动动作 = 清空全部相关环境变量 + 写入选中 profile 的 14 个变量 + 广播 `WM_SETTINGCHANGE`。用 ps2exe 打包成 exe。

**Tech Stack:** PowerShell 5.1、Windows Forms(.NET Framework)、System.Web.Extensions(JSON)、ps2exe(打包)。

**产物目录:** `E:\CC-DOGE-Switch\`(`CC-DOGE-Switch.ps1`、`build.ps1`、`CC-DOGE-Switch.exe`、`profiles.json`、`README.md`)

**Spec:** `docs/superpowers/specs/2026-06-18-cc-doge-switch-design.md`

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `E:\CC-DOGE-Switch\CC-DOGE-Switch.ps1` | 主程序:WinForms GUI + 配置读写 + 启动写环境变量 + 预置数据 |
| `E:\CC-DOGE-Switch\build.ps1` | 打包脚本:检查/拉取 ps2exe,调用 Invoke-PS2EXE 生成 exe |
| `E:\CC-DOGE-Switch\README.md` | 使用说明:目录、打包、使用、字段对照表 |
| `E:\CC-DOGE-Switch\profiles.json` | 运行时生成,持久化配置(不在源码里) |

主程序 `CC-DOGE-Switch.ps1` 内部按职责分区(单文件,避免 ps2exe 多文件打包复杂度):
1. **常量区**:路径、14 变量清单、清理清单(16 项,含 AUTO_COMPACT_WINDOW)
2. **预置数据区**:7 份 profile 的硬编码 hashtable(从 start_*.ps1 提取)
3. **JSON 读写区**:Load-Profiles / Save-Profiles / Init-Profiles(首次预置)
4. **环境变量写入区**:Clear-EnvVars / Set-EnvVarsFromProfile / Broadcast-SettingChange / Get-ActiveProfile
5. **GUI 区**:主窗体、列表、工具栏、详情区、编辑弹窗、启动按钮、状态栏
6. **入口**:加载配置 → 构建窗体 → [System.Windows.Forms.Application]::Run()

---

## 预置数据(7 份 profile 精确值)

以下 hashtable 数组是预置数据的唯一来源,逐字段从 7 个 `start_*.ps1` 提取。**空字符串 `""` 表示该脚本未设置此变量**(启动时写空串 = 清除)。

```
DeepSeek          start_deepseek.ps1        key=DOGE_API_KEY
DeepSeek-Anthropic start_deepseek_ant.ps1  key=ANTHROPIC_AUTH_TOKEN
GLM               start_glm.ps1            key=DOGE_API_KEY
GLM01             start_glm01.ps1          key=ANTHROPIC_AUTH_TOKEN  (无 ANTHROPIC_MODEL)
Coding-Plan       start_coding_plan.ps1    key=ANTHROPIC_AUTH_TOKEN  (sonnet=kimi-k2.6, subagent=deepseek-v4-flash)
Opus代理           start_opus.ps1          key=ANTHROPIC_AUTH_TOKEN  (无能力声明/无开关)
Qwen              start_qwen.ps1           key=ANTHROPIC_AUTH_TOKEN  (无能力声明/无开关)
```

---

## Task 1: 创建目录骨架与主程序框架

**Files:**
- Create: `E:\CC-DOGE-Switch\CC-DOGE-Switch.ps1`

- [ ] **Step 1: 写主程序框架(常量 + 入口,GUI 先放占位空窗体验证可运行)**

写入 `E:\CC-DOGE-Switch\CC-DOGE-Switch.ps1`:

```powershell
# CC-DOGE-Switch.ps1 — Doge Code API 配置启动器
# PowerShell 5.1 + Windows Forms
# 管理 profiles.json,点启动写入用户级环境变量。不拉起 CLI。

# ===== 常量区 =====
$script:AppDir     = 'E:\CC-DOGE-Switch'
$script:ConfigPath = Join-Path $script:AppDir 'profiles.json'

# profile 里直接承载的环境变量字段(启动时逐个写入)
$script:ProfileFields = @(
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_COMPATIBLE_API_PROVIDER',
  'CLAUDE_CODE_MODEL_CONTEXT_WINDOW',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK'
)

# 启动前要清空的环境变量清单(16 项,含脚本开头清理的 AUTO_COMPACT_WINDOW)
$script:ClearVars = @(
  'ANTHROPIC_BASE_URL',
  'DOGE_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_MODEL_CONTEXT_WINDOW',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_COMPATIBLE_API_PROVIDER'
)

# ===== 入口 =====
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'CC-DOGE-Switch'
$form.Size = New-Object System.Drawing.Size(640, 480)
$form.StartPosition = 'CenterScreen'

[System.Windows.Forms.Application]::Run($form)
```

- [ ] **Step 2: 运行验证空窗体能弹出**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File E:\CC-DOGE-Switch\CC-DOGE-Switch.ps1`
Expected: 弹出一个标题为 "CC-DOGE-Switch" 的空窗体(640×480),手动关闭后命令返回。无报错。

- [ ] **Step 3: Commit**

```bash
cd /e/ClaudeCode/doge-code
git add -f E:/CC-DOGE-Switch/CC-DOGE-Switch.ps1
git commit -m "feat(cc-doge-switch): 主程序框架与常量定义"
```

> 注:`E:\CC-DOGE-Switch\` 在主项目 `.gitignore` 外,但路径在仓库外。用 `git add -f` 强制纳入跟踪(项目是记录这些工具源码的单一事实源)。后续 exe 产物不纳入 git(二进制)。

---

## Task 2: 预置数据(7 份 profile)

**Files:**
- Modify: `E:\CC-DOGE-Switch\CC-DOGE-Switch.ps1`(在常量区后、入口前插入预置数据区)

- [ ] **Step 1: 在常量区之后插入预置数据函数**

在 `$script:ClearVars = @(...)` 块之后、`Add-Type -AssemblyName System.Windows.Forms` 之前,插入:

```powershell
# ===== 预置数据区(7 份,从 start_*.ps1 精确提取)=====
# 空字符串 = 该脚本未设此变量(启动时写空串=清除)
# apiKeyField: 'DOGE_API_KEY' 或 'ANTHROPIC_AUTH_TOKEN',二选一
function Get-DefaultProfiles {
  return @(
    # 1. DeepSeek — start_deepseek.ps1 (openai 格式)
    [ordered]@{
      customName = 'DeepSeek'
      mainModel  = 'deepseek-v4-pro[1m]'
      apiKeyField = 'DOGE_API_KEY'
      apiKeyValue = 'sk-25bb3b9f1a7f4002bfed437be7ce8ada'
      ANTHROPIC_BASE_URL = 'https://api.deepseek.com'
      ANTHROPIC_MODEL = 'deepseek-v4-pro[1m]'
      ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek-v4-pro[1m]'
      ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro[1m]'
      ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash'
      ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'effort,max_effort,thinking,adaptive_thinking'
      ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = 'effort,max_effort,thinking,adaptive_thinking'
      CLAUDE_CODE_SUBAGENT_MODEL = 'deepseek-v4-pro[1m]'
      CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'openai'
      CLAUDE_CODE_MODEL_CONTEXT_WINDOW = '1000000'
      CLAUDE_CODE_EFFORT_LEVEL = 'max'
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = '1'
    },
    # 2. DeepSeek-Anthropic — start_deepseek_ant.ps1 (anthropic 格式)
    [ordered]@{
      customName = 'DeepSeek-Anthropic'
      mainModel  = 'deepseek-v4-pro[1m]'
      apiKeyField = 'ANTHROPIC_AUTH_TOKEN'
      apiKeyValue = 'sk-25bb3b9f1a7f4002bfed437be7ce8ada'
      ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
      ANTHROPIC_MODEL = 'deepseek-v4-pro[1m]'
      ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek-v4-pro[1m]'
      ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro[1m]'
      ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash'
      ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'effort,max_effort,thinking,adaptive_thinking'
      ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = 'effort,max_effort,thinking,adaptive_thinking'
      CLAUDE_CODE_SUBAGENT_MODEL = 'deepseek-v4-pro[1m]'
      CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'anthropic'
      CLAUDE_CODE_MODEL_CONTEXT_WINDOW = '1000000'
      CLAUDE_CODE_EFFORT_LEVEL = 'max'
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = '1'
    },
    # 3. GLM — start_glm.ps1 (DOGE_API_KEY)
    [ordered]@{
      customName = 'GLM'
      mainModel  = 'glm-5.1'
      apiKeyField = 'DOGE_API_KEY'
      apiKeyValue = '5ce48e6875884b0093768f89d770f983.LnpXlUUmgBBgvsvR'
      ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic'
      ANTHROPIC_MODEL = 'glm-5.1'
      ANTHROPIC_DEFAULT_OPUS_MODEL = 'glm-5.1'
      ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-5'
      ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-4.7'
      ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'effort,max_effort,thinking,adaptive_thinking'
      ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = 'effort,max_effort,thinking,adaptive_thinking'
      CLAUDE_CODE_SUBAGENT_MODEL = 'glm-5.1'
      CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'anthropic'
      CLAUDE_CODE_MODEL_CONTEXT_WINDOW = '200000'
      CLAUDE_CODE_EFFORT_LEVEL = ''
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = ''
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = ''
    },
    # 4. GLM01 — start_glm01.ps1 (ANTHROPIC_AUTH_TOKEN; 脚本未设 ANTHROPIC_MODEL)
    [ordered]@{
      customName = 'GLM01'
      mainModel  = 'glm-5.1'
      apiKeyField = 'ANTHROPIC_AUTH_TOKEN'
      apiKeyValue = 'sk-n3nRZmRspiFyp64gqHNHhedAqfFwjaZjbC9uddF5XlZLiVWx'
      ANTHROPIC_BASE_URL = 'https://aiproxy.xin/cosphere'
      ANTHROPIC_MODEL = ''
      ANTHROPIC_DEFAULT_OPUS_MODEL = 'glm-5.1'
      ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-5'
      ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-4.7'
      ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'effort,max_effort,thinking,adaptive_thinking'
      ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = 'effort,max_effort,thinking,adaptive_thinking'
      CLAUDE_CODE_SUBAGENT_MODEL = 'glm-5.1'
      CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'anthropic'
      CLAUDE_CODE_MODEL_CONTEXT_WINDOW = '200000'
      CLAUDE_CODE_EFFORT_LEVEL = ''
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = ''
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = ''
    },
    # 5. Coding-Plan — start_coding_plan.ps1 (sonnet=kimi-k2.6, subagent=deepseek-v4-flash)
    [ordered]@{
      customName = 'Coding-Plan'
      mainModel  = 'glm-5.1'
      apiKeyField = 'ANTHROPIC_AUTH_TOKEN'
      apiKeyValue = 'REDACTED_VOLCENGINE_KEY'
      ANTHROPIC_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding'
      ANTHROPIC_MODEL = 'glm-5.1'
      ANTHROPIC_DEFAULT_OPUS_MODEL = 'glm-5.1'
      ANTHROPIC_DEFAULT_SONNET_MODEL = 'kimi-k2.6[1m]'
      ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash'
      ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'effort,max_effort,thinking,adaptive_thinking'
      ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = 'effort,max_effort,thinking,adaptive_thinking'
      CLAUDE_CODE_SUBAGENT_MODEL = 'deepseek-v4-flash'
      CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'anthropic'
      CLAUDE_CODE_MODEL_CONTEXT_WINDOW = '200000'
      CLAUDE_CODE_EFFORT_LEVEL = 'max'
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = '1'
    },
    # 6. Opus代理 — start_opus.ps1 (无能力声明/无开关)
    [ordered]@{
      customName = 'Opus代理'
      mainModel  = 'claude-opus-4-6[1m]'
      apiKeyField = 'ANTHROPIC_AUTH_TOKEN'
      apiKeyValue = 'sk-wA8YA4ghVVAB90XMyMvetw4cEm6zNgeERMSGl7RpRdjzMdZG'
      ANTHROPIC_BASE_URL = 'https://code.ppchat.vip'
      ANTHROPIC_MODEL = 'claude-opus-4-6[1m]'
      ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-4-6[1m]'
      ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-4-6[1m]'
      ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5-20251001'
      ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = ''
      ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = ''
      CLAUDE_CODE_SUBAGENT_MODEL = 'claude-opus-4-6[1m]'
      CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'anthropic'
      CLAUDE_CODE_MODEL_CONTEXT_WINDOW = '1000000'
      CLAUDE_CODE_EFFORT_LEVEL = 'max'
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = ''
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = ''
    },
    # 7. Qwen — start_qwen.ps1 (无能力声明/无开关)
    [ordered]@{
      customName = 'Qwen'
      mainModel  = 'qwen3.7-max[1m]'
      apiKeyField = 'ANTHROPIC_AUTH_TOKEN'
      apiKeyValue = 'sk-6cb204a75c20467c9e6338dc297d4bb1'
      ANTHROPIC_BASE_URL = 'https://dashscope.aliyuncs.com/apps/anthropic'
      ANTHROPIC_MODEL = 'qwen3.7-max[1m]'
      ANTHROPIC_DEFAULT_OPUS_MODEL = 'qwen3.7-max[1m]'
      ANTHROPIC_DEFAULT_SONNET_MODEL = 'qwen3.7-max[1m]'
      ANTHROPIC_DEFAULT_HAIKU_MODEL = 'qwen3.6-flash'
      ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = ''
      ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = ''
      CLAUDE_CODE_SUBAGENT_MODEL = 'qwen3.7-max[1m]'
      CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'anthropic'
      CLAUDE_CODE_MODEL_CONTEXT_WINDOW = '1000000'
      CLAUDE_CODE_EFFORT_LEVEL = 'max'
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = ''
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = ''
    }
  )
}
```

- [ ] **Step 2: 运行验证函数可调用且返回 7 项**

Run:
```bash
powershell -NoProfile -ExecutionPolicy Bypass -Command "& { . E:\CC-DOGE-Switch\CC-DOGE-Switch.ps1 } 2>&1 | Out-Null; (Get-DefaultProfiles).Count"
```
> 注:dot-source 会触发末尾 `Application::Run` 弹窗,不方便测。改用下面的隔离测试。
Run(隔离测试,不触发 GUI):
```bash
powershell -NoProfile -ExecutionPolicy Bypass -Command "& { \$ErrorActionPreference='Stop'; \$f='E:\CC-DOGE-Switch\CC-DOGE-Switch.ps1'; \$src=Get-Content \$f -Raw; \$idx=\$src.IndexOf('function Get-DefaultProfiles'); \$end=\$src.IndexOf('# ===== 入口 ====='); \$func=\$src.Substring(\$idx, \$end-\$idx); \$sb=[ScriptBlock]::Create(\$func); & \$sb | Out-Null; (Get-DefaultProfiles).Count }"
```
Expected: `7`

- [ ] **Step 3: Commit**

```bash
git add -f E:/CC-DOGE-Switch/CC-DOGE-Switch.ps1
git commit -m "feat(cc-doge-switch): 预置 7 份 profile(从 start_*.ps1 提取)"
```

---

## Task 3: JSON 读写(配置持久化)

**Files:**
- Modify: `E:\CC-DOGE-Switch\CC-DOGE-Switch.ps1`(在预置数据区后插入 JSON 读写区)

- [ ] **Step 1: 插入 Load-Profiles / Save-Profiles / Init-Profiles**

在 `Get-DefaultProfiles` 函数之后、`# ===== 入口 =====` 之前,插入:

```powershell
# ===== JSON 读写区 =====
# 用 System.Web.Extensions 的 JavaScriptSerializer 做 hashtable<->JSON
$script:JsonSerializer = $null
function Get-JsonSerializer {
  if ($null -eq $script:JsonSerializer) {
    Add-Type -AssemblyName System.Web.Extensions
    $script:JsonSerializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $script:JsonSerializer.MaxJsonLength = [int]::MaxValue
  }
  return $script:JsonSerializer
}

# 把 hashtable 的值统一为字符串(避免写 JSON 时数字 1 变成无引号 1)
function Convert-ProfileToStrings {
  param([hashtable]$Profile)
  $out = [ordered]@{}
  foreach ($k in $Profile.Keys) {
    $v = $Profile[$k]
    $out[$k] = if ($null -eq $v) { '' } else { [string]$v }
  }
  return $out
}

function Load-Profiles {
  if (-not (Test-Path $script:ConfigPath)) { return $null }
  try {
    $raw = Get-Content $script:ConfigPath -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    $ser = Get-JsonSerializer
    $obj = $ser.DeserializeObject($raw)
    # JavaScriptSerializer 把 {} 解析成 hashtable,把 [] 解析成 object[]
    $list = @()
    if ($obj -is [System.Collections.IDictionary] -and $obj.Contains('profiles')) {
      $list = @($obj['profiles'])
    }
    $result = @()
    foreach ($p in $list) {
      $h = [ordered]@{}
      foreach ($k in $p.Keys) { $h[$k] = [string]$p[$k] }
      $result += ,$h
    }
    return $result
  } catch {
    # JSON 损坏:备份并返回 $null(触发重新预置)
    $backup = $script:ConfigPath + ".corrupt-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    try { Copy-Item $script:ConfigPath $backup -Force } catch {}
    return $null
  }
}

function Save-Profiles {
  param([array]$Profiles)
  try {
    if (-not (Test-Path $script:AppDir)) { New-Item -ItemType Directory -Force -Path $script:AppDir | Out-Null }
    $cleaned = @()
    foreach ($p in $Profiles) { $cleaned += ,(Convert-ProfileToStrings -Profile $p) }
    $wrap = @{ profiles = $cleaned }
    $ser = Get-JsonSerializer
    $json = $ser.Serialize($wrap)
    # 简单缩进:在 },{ 之类换行(可读性,非必须)
    [System.IO.File]::WriteAllText($script:ConfigPath, $json, [System.Text.UTF8Encoding]::new($false))
    return $true
  } catch {
    [System.Windows.Forms.MessageBox]::Show(
      "保存配置失败: $($_.Exception.Message)",
      'CC-DOGE-Switch', 'OK', 'Error') | Out-Null
    return $false
  }
}

function Init-Profiles {
  # 返回当前应使用的 profiles 数组;首次运行或损坏时生成预置
  $profiles = Load-Profiles
  if ($null -eq $profiles -or $profiles.Count -eq 0) {
    $profiles = Get-DefaultProfiles
    Save-Profiles -Profiles $profiles | Out-Null
  }
  return $profiles
}
```

- [ ] **Step 2: 隔离测试 Load/Save/Init(用临时路径,不污染真实配置)**

Run:
```bash
powershell -NoProfile -ExecutionPolicy Bypass -Command "& {
  \$ErrorActionPreference='Stop'
  \$f='E:\CC-DOGE-Switch\CC-DOGE-Switch.ps1'
  \$src=Get-Content \$f -Raw
  \$start=\$src.IndexOf('function Get-JsonSerializer')
  \$end=\$src.IndexOf('# ===== 入口 =====')
  \$funcs=\$src.Substring(\$start, \$end-\$start)
  # 替换真实路径为临时路径做隔离测试
  \$funcs=\$funcs.Replace(\"\`$script:AppDir     = 'E:\CC-DOGE-Switch'\",\"\`$script:AppDir     = 'E:\CC-DOGE-Switch\_test_tmp'\")
  \$funcs=\$funcs -replace \"\\\`\\\$script:ConfigPath = Join-Path \\\`\\\$script:AppDir 'profiles.json'\",\"\`$script:ConfigPath='E:\CC-DOGE-Switch\_test_tmp\profiles.json'\"
  # 先建临时区常量
  \$consts=@'
\$script:AppDir='E:\CC-DOGE-Switch\_test_tmp'
\$script:ConfigPath='E:\CC-DOGE-Switch\_test_tmp\profiles.json'
\$script:ProfileFields=@()
\$script:ClearVars=@()
'@
  \$sb=[ScriptBlock]::Create(\$consts + \"`n\" + \$funcs)
  & \$sb | Out-Null
  if (Test-Path 'E:\CC-DOGE-Switch\_test_tmp') { Remove-Item 'E:\CC-DOGE-Switch\_test_tmp' -Recurse -Force }
  \$p = Init-Profiles
  Write-Host \"Init count: \$(\$p.Count)\"
  Write-Host \"File exists: \$(Test-Path \$script:ConfigPath)\"
  Write-Host \"First name: \$(\$p[0].customName)\"
  \$p2 = Load-Profiles
  Write-Host \"Reload count: \$(\$p2.Count)\"
  Write-Host \"Reload first mainModel: \$(\$p2[0].mainModel)\"
  Remove-Item 'E:\CC-DOGE-Switch\_test_tmp' -Recurse -Force
}"
```
Expected:
```
Init count: 7
File exists: True
First name: DeepSeek
Reload count: 7
Reload first mainModel: deepseek-v4-pro[1m]
```

- [ ] **Step 3: Commit**

```bash
git add -f E:/CC-DOGE-Switch/CC-DOGE-Switch.ps1
git commit -m "feat(cc-doge-switch): JSON 读写与首次预置逻辑"
```

---

## Task 4: 环境变量写入(清理 + 写值 + 广播 + 查激活)

**Files:**
- Modify: `E:\CC-DOGE-Switch\CC-DOGE-Switch.ps1`(在 JSON 读写区后插入环境变量写入区)

- [ ] **Step 1: 插入 Clear-EnvVars / Set-EnvVarsFromProfile / Broadcast-SettingChange / Get-ActiveProfile**

在 `Init-Profiles` 函数之后、`# ===== 入口 =====` 之前,插入:

```powershell
# ===== 环境变量写入区 =====
# 广播 WM_SETTINGCHANGE,让资源管理器/新终端立即感知用户级环境变量变更
function Broadcast-SettingChange {
  try {
    if (-not ('Win32.Native' -as [type])) {
      Add-Type -Namespace Win32 -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    }
    $result = [UIntPtr]::Zero
    [Win32.Native]::SendMessageTimeout(
      [IntPtr]0xffff,            # HWND_BROADCAST
      0x001A,                     # WM_SETTINGCHANGE
      [UIntPtr]::Zero,
      'Environment',
      2,                          # SMTO_ABORTIFHUNG
      1000,
      [ref]$result) | Out-Null
  } catch {
    # 广播失败不致命;新终端仍可通过重新登录拿到变量
  }
}

# 清空全部相关环境变量(写 $null = 删除用户级变量)
function Clear-EnvVars {
  foreach ($name in $script:ClearVars) {
    try { [Environment]::SetEnvironmentVariable($name, $null, 'User') } catch {}
  }
}

# 写入选中 profile 的全部变量
function Set-EnvVarsFromProfile {
  param([hashtable]$Profile)
  foreach ($field in $script:ProfileFields) {
    $val = $Profile[$field]
    if ($null -eq $val) { $val = '' }
    try { [Environment]::SetEnvironmentVariable($field, [string]$val, 'User') } catch {}
  }
  # 密钥二选一:写 apiKeyField 指定的,另一个清空
  $keyField = $Profile['apiKeyField']
  $keyValue = $Profile['apiKeyValue']
  if ($null -eq $keyValue) { $keyValue = '' }
  try {
    [Environment]::SetEnvironmentVariable($keyField, [string]$keyValue, 'User')
    $other = if ($keyField -eq 'DOGE_API_KEY') { 'ANTHROPIC_AUTH_TOKEN' } else { 'DOGE_API_KEY' }
    [Environment]::SetEnvironmentVariable($other, $null, 'User')
  } catch {}
}

# 启动主流程:清理 → 写值 → 广播。返回 $true/$false
function Invoke-Activate {
  param([hashtable]$Profile)
  try {
    Clear-EnvVars
    Set-EnvVarsFromProfile -Profile $Profile
    Broadcast-SettingChange
    return $true
  } catch {
    [System.Windows.Forms.MessageBox]::Show(
      "写入用户环境变量失败: $($_.Exception.Message)",
      'CC-DOGE-Switch', 'OK', 'Error') | Out-Null
    return $false
  }
}

# 读取当前用户级环境变量,比对找出已激活的 profile;返回 customName 或 $null
function Get-ActiveProfile {
  param([array]$Profiles)
  $curBase   = [string][Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL', 'User')
  $curModel  = [string][Environment]::GetEnvironmentVariable('ANTHROPIC_MODEL', 'User')
  $curKey    = [string][Environment]::GetEnvironmentVariable('DOGE_API_KEY', 'User')
  $curToken  = [string][Environment]::GetEnvironmentVariable('ANTHROPIC_AUTH_TOKEN', 'User')
  foreach ($p in $Profiles) {
    # GLM01 的 ANTHROPIC_MODEL 为空,改用 baseURL + key 匹配
    $baseMatch = ($curBase -eq $p.ANTHROPIC_BASE_URL)
    $keyMatch  = if ($p.apiKeyField -eq 'DOGE_API_KEY') { ($curKey -eq $p.apiKeyValue) } else { ($curToken -eq $p.apiKeyValue) }
    $modelMatch = if ([string]::IsNullOrEmpty($p.ANTHROPIC_MODEL)) { $true } else { ($curModel -eq $p.ANTHROPIC_MODEL) }
    if ($baseMatch -and $keyMatch -and $modelMatch) { return $p.customName }
  }
  return $null
}
```

- [ ] **Step 2: 隔离测试 Invoke-Activate 与 Get-ActiveProfile(用一份测试 profile,测后还原)**

Run:
```bash
powershell -NoProfile -ExecutionPolicy Bypass -Command "& {
  \$ErrorActionPreference='Stop'
  \$f='E:\CC-DOGE-Switch\CC-DOGE-Switch.ps1'
  \$src=Get-Content \$f -Raw
  \$start=\$src.IndexOf('function Broadcast-SettingChange')
  \$end=\$src.IndexOf('# ===== 入口 =====')
  \$funcs=\$src.Substring(\$start, \$end-\$start)
  \$consts=@'
\$script:AppDir='E:\CC-DOGE-Switch'
\$script:ConfigPath='E:\CC-DOGE-Switch\profiles.json'
\$script:ProfileFields=@('ANTHROPIC_BASE_URL','ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES','ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES','CLAUDE_CODE_SUBAGENT_MODEL','CLAUDE_CODE_COMPATIBLE_API_PROVIDER','CLAUDE_CODE_MODEL_CONTEXT_WINDOW','CLAUDE_CODE_EFFORT_LEVEL','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC','CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK')
\$script:ClearVars=@('ANTHROPIC_BASE_URL','DOGE_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_MODEL_CONTEXT_WINDOW','CLAUDE_CODE_AUTO_COMPACT_WINDOW','ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES','ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES','CLAUDE_CODE_SUBAGENT_MODEL','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC','CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK','CLAUDE_CODE_EFFORT_LEVEL','CLAUDE_CODE_COMPATIBLE_API_PROVIDER')
Add-Type -AssemblyName System.Windows.Forms
'@
  \$sb=[ScriptBlock]::Create(\$consts + \"`n\" + \$funcs)
  & \$sb | Out-Null
  # 备份当前用户级相关变量,测后还原
  \$backup=@{}
  foreach(\$n in \$script:ClearVars){ \$backup[\$n]=[Environment]::GetEnvironmentVariable(\$n,'User') }
  \$test=[ordered]@{ customName='TEST_PROBE'; mainModel='test-model'; apiKeyField='DOGE_API_KEY'; apiKeyValue='sk-testprobe'; ANTHROPIC_BASE_URL='https://testprobe.example'; ANTHROPIC_MODEL='test-model'; ANTHROPIC_DEFAULT_OPUS_MODEL=''; ANTHROPIC_DEFAULT_SONNET_MODEL=''; ANTHROPIC_DEFAULT_HAIKU_MODEL=''; ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES=''; ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES=''; CLAUDE_CODE_SUBAGENT_MODEL=''; CLAUDE_CODE_COMPATIBLE_API_PROVIDER='openai'; CLAUDE_CODE_MODEL_CONTEXT_WINDOW=''; CLAUDE_CODE_EFFORT_LEVEL='max'; CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1'; CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK='1' }
  \$ok = Invoke-Activate -Profile \$test
  Write-Host \"Activate ok: \$ok\"
  Write-Host \"Base: \$([Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL','User'))\"
  Write-Host \"Effort: \$([Environment]::GetEnvironmentVariable('CLAUDE_CODE_EFFORT_LEVEL','User'))\"
  Write-Host \"Traffic: \$([Environment]::GetEnvironmentVariable('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC','User'))\"
  \$active = Get-ActiveProfile -Profiles @(\$test)
  Write-Host \"Active match: \$active\"
  # 还原
  foreach(\$n in \$script:ClearVars){ [Environment]::SetEnvironmentVariable(\$n, \$backup[\$n], 'User') }
  Write-Host \"Restored base to: \$([Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL','User'))\"
}"
```
Expected:
```
Activate ok: True
Base: https://testprobe.example
Effort: max
Traffic: 1
Active match: TEST_PROBE
Restored base to: <原值或空>
```

- [ ] **Step 3: Commit**

```bash
git add -f E:/CC-DOGE-Switch/CC-DOGE-Switch.ps1
git commit -m "feat(cc-doge-switch): 环境变量写入/清理/广播/查激活"
```

---

## Task 5: GUI — 主窗体 + 列表 + 详情区 + 状态栏

**Files:**
- Modify: `E:\CC-DOGE-Switch\CC-DOGE-Switch.ps1`(替换入口区为完整 GUI 构建代码)

- [ ] **Step 1: 在环境变量写入区之后、入口之前,插入 GUI 辅助函数**

在 `Get-ActiveProfile` 函数之后、`# ===== 入口 =====` 之前,插入:

```powershell
# ===== GUI 辅助区 =====
# 密钥掩码:*** + 后 4 位
function Get-MaskedKey {
  param([string]$Key)
  if ([string]::IsNullOrEmpty($Key)) { return '(未设置)' }
  if ($Key.Length -le 4) { return '***' }
  return '***' + $Key.Substring($Key.Length - 4)
}

# 详情区文本:选中 profile 的只读预览
function Get-DetailText {
  param([hashtable]$P)
  if ($null -eq $P) { return '请选择一个配置。' }
  $lines = @()
  $lines += "自定义名:  $($P.customName)"
  $lines += "主模型:    $($P.mainModel)"
  $lines += "BaseURL:   $($P.ANTHROPIC_BASE_URL)"
  $lines += "Provider:  $($P.CLAUDE_CODE_COMPATIBLE_API_PROVIDER)"
  $lines += "上下文:    $($P.CLAUDE_CODE_MODEL_CONTEXT_WINDOW)"
  $lines += "Effort:    $(if([string]::IsNullOrEmpty($P.CLAUDE_CODE_EFFORT_LEVEL)){'(空)'}else{$P.CLAUDE_CODE_EFFORT_LEVEL})"
  $lines += "Key:       $(Get-MaskedKey -Key $P.apiKeyValue)  [$($P.apiKeyField)]"
  $lines += "Opus:      $($P.ANTHROPIC_DEFAULT_OPUS_MODEL)"
  $lines += "Sonnet:    $($P.ANTHROPIC_DEFAULT_SONNET_MODEL)"
  $lines += "Haiku:     $($P.ANTHROPIC_DEFAULT_HAIKU_MODEL)"
  $lines += "Subagent:  $($P.CLAUDE_CODE_SUBAGENT_MODEL)"
  $lines += "能力声明:  $(if([string]::IsNullOrEmpty($P.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES)){'(空)'}else{$P.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES})"
  $lines += "禁非必要流量: $(if([string]::IsNullOrEmpty($P.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)){'(空)'}else{$P.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC})"
  $lines += "禁非流式回退: $(if([string]::IsNullOrEmpty($P.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK)){'(空)'}else{$P.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK})"
  return ($lines -join "`r`n")
}
```

- [ ] **Step 2: 替换入口区为完整主窗体构建**

把文件末尾从 `# ===== 入口 =====` 开始到结尾的整段替换为:

```powershell
# ===== 入口 / GUI 构建 =====
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:Profiles = Init-Profiles

$form = New-Object System.Windows.Forms.Form
$form.Text = 'CC-DOGE-Switch — Doge Code 配置启动器'
$form.Size = New-Object System.Drawing.Size(720, 600)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

# --- 工具栏 ---
$toolBar = New-Object System.Windows.Forms.Panel
$toolBar.Location = New-Object System.Drawing.Point(0, 0)
$toolBar.Size = New-Object System.Drawing.Size(720, 40)
$toolBar.Dock = 'Top'
$form.Controls.Add($toolBar)

$btnNew = New-Object System.Windows.Forms.Button
$btnNew.Text = '+ 新建'
$btnNew.Location = New-Object System.Drawing.Point(10, 8)
$btnNew.Size = New-Object System.Drawing.Size(80, 26)
$toolBar.Controls.Add($btnNew)

$btnEdit = New-Object System.Windows.Forms.Button
$btnEdit.Text = '编辑'
$btnEdit.Location = New-Object System.Drawing.Point(96, 8)
$btnEdit.Size = New-Object System.Drawing.Size(70, 26)
$toolBar.Controls.Add($btnEdit)

$btnDup = New-Object System.Windows.Forms.Button
$btnDup.Text = '复制'
$btnDup.Location = New-Object System.Drawing.Point(172, 8)
$btnDup.Size = New-Object System.Drawing.Size(70, 26)
$toolBar.Controls.Add($btnDup)

$btnDel = New-Object System.Windows.Forms.Button
$btnDel.Text = '删除'
$btnDel.Location = New-Object System.Drawing.Point(248, 8)
$btnDel.Size = New-Object System.Drawing.Size(70, 26)
$toolBar.Controls.Add($btnDel)

$btnRefresh = New-Object System.Windows.Forms.Button
$btnRefresh.Text = '刷新'
$btnRefresh.Location = New-Object System.Drawing.Point(640, 8)
$btnRefresh.Size = New-Object System.Drawing.Size(70, 26)
$toolBar.Controls.Add($btnRefresh)

# --- 列表 ListView(双列)---
$listView = New-Object System.Windows.Forms.ListView
$listView.Location = New-Object System.Drawing.Point(10, 44)
$listView.Size = New-Object System.Drawing.Size(700, 220)
$listView.View = 'Details'
$listView.FullRowSelect = $true
$listView.HideSelection = $false
$listView.MultiSelect = $false
$listView.Columns.Add('自定义名', 220) | Out-Null
$listView.Columns.Add('主模型', 460) | Out-Null
$form.Controls.Add($listView)

# --- 详情区 ---
$detailBox = New-Object System.Windows.Forms.TextBox
$detailBox.Location = New-Object System.Drawing.Point(10, 270)
$detailBox.Size = New-Object System.Drawing.Size(700, 180)
$detailBox.Multiline = $true
$detailBox.ReadOnly = $true
$detailBox.ScrollBars = 'Vertical'
$detailBox.Font = New-Object System.Drawing.Font('Consolas', 9)
$detailBox.Text = '请选择一个配置。'
$form.Controls.Add($detailBox)

# --- 启动按钮 ---
$btnActivate = New-Object System.Windows.Forms.Button
$btnActivate.Text = '启  动'
$btnActivate.Location = New-Object System.Drawing.Point(280, 460)
$btnActivate.Size = New-Object System.Drawing.Size(160, 40)
$btnActivate.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, 'Bold')
$form.Controls.Add($btnActivate)

# --- 状态栏 ---
$statusBar = New-Object System.Windows.Forms.StatusStrip
$statusLabel = New-Object System.Windows.Forms.ToolStripStatusLabel
$statusBar.Items.Add($statusLabel) | Out-Null
$form.Controls.Add($statusBar)

# ===== 列表刷新逻辑 =====
function Refresh-List {
  $listView.Items.Clear()
  foreach ($p in $script:Profiles) {
    $item = New-Object System.Windows.Forms.ListViewItem($p.customName)
    $item.SubItems.Add($p.mainModel) | Out-Null
    $item.Tag = $p
    $listView.Items.Add($item) | Out-Null
  }
  $active = Get-ActiveProfile -Profiles $script:Profiles
  if ($active) { $statusLabel.Text = "已激活: $active" } else { $statusLabel.Text = '当前未激活任何配置' }
  $detailBox.Text = '请选择一个配置。'
}

function Get-SelectedProfile {
  if ($listView.SelectedItems.Count -eq 0) { return $null }
  return $listView.SelectedItems[0].Tag
}

# ===== 事件绑定(编辑/新建弹窗在 Task 6 接入)=====
$listView.add_SelectedIndexChanged({
  $p = Get-SelectedProfile
  $detailBox.Text = Get-DetailText -P $p
})

$listView.add_DoubleClick({
  # 双击编辑(Task 6 实现后启用)
  if ($null -ne (Get-SelectedProfile)) { $btnEdit.PerformClick() }
})

$btnActivate.add_Click({
  $p = Get-SelectedProfile
  if ($null -eq $p) {
    [System.Windows.Forms.MessageBox]::Show('请先选择一个配置。', 'CC-DOGE-Switch', 'OK', 'Warning') | Out-Null
    return
  }
  $ok = Invoke-Activate -Profile $p
  if ($ok) {
    Refresh-List
    [System.Windows.Forms.MessageBox]::Show(
      "已激活 [$($p.customName)]。`r`n`r`n请新开 PowerShell 终端运行 doge 或 bun run dev。`r`n(已写入用户级环境变量,新终端自动继承)",
      'CC-DOGE-Switch', 'OK', 'Information') | Out-Null
  }
})

$btnRefresh.add_Click({ Refresh-List })

# 新建/编辑/复制/删除 在 Task 6 实现;先占位提示
$btnNew.add_Click({ [System.Windows.Forms.MessageBox]::Show('编辑弹窗待实现(Task 6)。', 'CC-DOGE-Switch', 'OK', 'Information') | Out-Null })
$btnEdit.add_Click({ if($null -eq (Get-SelectedProfile)){return}; [System.Windows.Forms.MessageBox]::Show('编辑弹窗待实现(Task 6)。', 'CC-DOGE-Switch', 'OK', 'Information') | Out-Null })
$btnDup.add_Click({ if($null -eq (Get-SelectedProfile)){return}; [System.Windows.Forms.MessageBox]::Show('复制待实现(Task 6)。', 'CC-DOGE-Switch', 'OK', 'Information') | Out-Null })
$btnDel.add_Click({ if($null -eq (Get-SelectedProfile)){return}; [System.Windows.Forms.MessageBox]::Show('删除待实现(Task 6)。', 'CC-DOGE-Switch', 'OK', 'Information') | Out-Null })

Refresh-List
[System.Windows.Forms.Application]::Run($form)
```

- [ ] **Step 3: 运行验证 GUI 渲染(列表有 7 项、详情区、启动按钮、状态栏)**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File E:\CC-DOGE-Switch\CC-DOGE-Switch.ps1`
Expected:
- 窗体标题 "CC-DOGE-Switch — Doge Code 配置启动器"
- 工具栏 5 个按钮(新建/编辑/复制/删除/刷新)
- 列表 7 行(DeepSeek / DeepSeek-Anthropic / GLM / GLM01 / Coding-Plan / Opus代理 / Qwen)双列显示
- 选中一行 → 详情区显示该 profile 的掩码 key + 各字段
- 状态栏显示 "当前未激活任何配置"(或当前实际激活项)
- 点"新建"弹占位提示
- 手动关闭后命令返回,无报错

- [ ] **Step 4: Commit**

```bash
git add -f E:/CC-DOGE-Switch/CC-DOGE-Switch.ps1
git commit -m "feat(cc-doge-switch): 主窗体 GUI(列表/详情/启动/状态栏)"
```

---

## Task 6: 编辑弹窗(新建/编辑/复制/删除)

**Files:**
- Modify: `E:\CC-DOGE-Switch\CC-DOGE-Switch.ps1`(替换 Task 5 里的占位事件,新增编辑弹窗函数)

- [ ] **Step 1: 在 GUI 辅助区(Get-DetailText 之后)插入编辑弹窗函数**

在 `Get-DetailText` 函数之后插入:

```powershell
# 编辑弹窗:返回填充好的 hashtable,或 $null(取消)
# -Mode 'new' | 'edit' | 'dup'
function Show-EditDialog {
  param([hashtable]$Base, [string]$Mode)

  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = if ($Mode -eq 'new') { '新建配置' } elseif ($Mode -eq 'dup') { '复制配置' } else { '编辑配置' }
  $dlg.Size = New-Object System.Drawing.Size(560, 720)
  $dlg.StartPosition = 'CenterParent'
  $dlg.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $dlg.FormBorderStyle = 'FixedDialog'
  $dlg.MaximizeBox = $false
  $dlg.MinimizeBox = $false

  $fields = [ordered]@{
    customName      = '自定义名(列表显示)'
    mainModel       = '主模型名(列表显示)'
    ANTHROPIC_BASE_URL = 'BaseURL'
    apiKeyField     = '密钥字段(DOGE_API_KEY 或 ANTHROPIC_AUTH_TOKEN)'
    apiKeyValue     = '密钥值'
    ANTHROPIC_MODEL = 'ANTHROPIC_MODEL'
    ANTHROPIC_DEFAULT_OPUS_MODEL = 'OPUS 模型'
    ANTHROPIC_DEFAULT_SONNET_MODEL = 'SONNET 模型'
    ANTHROPIC_DEFAULT_HAIKU_MODEL = 'HAIKU 模型'
    ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'OPUS 能力声明'
    ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = 'SONNET 能力声明'
    CLAUDE_CODE_SUBAGENT_MODEL = '子智能体模型'
    CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'Provider(anthropic/openai/responses)'
    CLAUDE_CODE_MODEL_CONTEXT_WINDOW = '上下文窗口'
    CLAUDE_CODE_EFFORT_LEVEL = 'Effort(low/medium/high/max,留空=不清除)'
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '禁非必要流量(0/1,留空=不清除)'
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = '禁非流式回退(0/1,留空=不清除)'
  }

  $inputs = [ordered]@{}
  $y = 12
  foreach ($k in $fields.Keys) {
    $lbl = New-Object System.Windows.Forms.Label
    $lbl.Text = $fields[$k]
    $lbl.Location = New-Object System.Drawing.Point(16, $y)
    $lbl.Size = New-Object System.Drawing.Size(520, 18)
    $dlg.Controls.Add($lbl)

    $tb = New-Object System.Windows.Forms.TextBox
    $tb.Location = New-Object System.Drawing.Point(16, $y + 20)
    $tb.Size = New-Object System.Drawing.Size(520, 24)
    # 初始值
    $initVal = ''
    if ($null -ne $Base -and $Base.Contains($k)) { $initVal = [string]$Base[$k] }
    if ($Mode -eq 'new' -and $k -eq 'apiKeyField') { $initVal = 'DOGE_API_KEY' }
    if ($Mode -eq 'new' -and $k -eq 'CLAUDE_CODE_COMPATIBLE_API_PROVIDER') { $initVal = 'anthropic' }
    $tb.Text = $initVal
    if ($k -eq 'apiKeyValue') { $tb.UseSystemPasswordChar = $true }
    $dlg.Controls.Add($tb)
    $inputs[$k] = $tb
    $y += 50
  }

  $btnOK = New-Object System.Windows.Forms.Button
  $btnOK.Text = '保存'
  $btnOK.Location = New-Object System.Drawing.Point(360, $y + 4)
  $btnOK.Size = New-Object System.Drawing.Size(80, 30)
  $btnOK.DialogResult = 'OK'
  $dlg.Controls.Add($btnOK)

  $btnCancel = New-Object System.Windows.Forms.Button
  $btnCancel.Text = '取消'
  $btnCancel.Location = New-Object System.Drawing.Point(456, $y + 4)
  $btnCancel.Size = New-Object System.Drawing.Size(80, 30)
  $btnCancel.DialogResult = 'Cancel'
  $dlg.Controls.Add($btnCancel)

  $dlg.AcceptButton = $btnOK
  $dlg.CancelButton = $btnCancel

  if ($dlg.ShowDialog() -ne 'OK') { $dlg.Dispose(); return $null }

  $result = [ordered]@{}
  foreach ($k in $inputs.Keys) {
    $result[$k] = $inputs[$k].Text
  }
  $dlg.Dispose()
  return $result
}

# 复制一份 profile(hashtable 深拷贝),复制时 customName 追加 " 副本"
function Copy-Profile {
  param([hashtable]$P)
  $copy = [ordered]@{}
  foreach ($k in $P.Keys) { $copy[$k] = $P[$k] }
  $copy['customName'] = "$($P.customName) 副本"
  return $copy
}
```

- [ ] **Step 2: 替换 Task 5 里的占位事件为真实逻辑**

把 Task 5 中这 4 行占位事件:

```powershell
$btnNew.add_Click({ [System.Windows.Forms.MessageBox]::Show('编辑弹窗待实现(Task 6)。', 'CC-DOGE-Switch', 'OK', 'Information') | Out-Null })
$btnEdit.add_Click({ if($null -eq (Get-SelectedProfile)){return}; [System.Windows.Forms.MessageBox]::Show('编辑弹窗待实现(Task 6)。', 'CC-DOGE-Switch', 'OK', 'Information') | Out-Null })
$btnDup.add_Click({ if($null -eq (Get-SelectedProfile)){return}; [System.Windows.Forms.MessageBox]::Show('复制待实现(Task 6)。', 'CC-DOGE-Switch', 'OK', 'Information') | Out-Null })
$btnDel.add_Click({ if($null -eq (Get-SelectedProfile)){return}; [System.Windows.Forms.MessageBox]::Show('删除待实现(Task 6)。', 'CC-DOGE-Switch', 'OK', 'Information') | Out-Null })
```

替换为:

```powershell
$btnNew.add_Click({
  $result = Show-EditDialog -Base $null -Mode 'new'
  if ($null -ne $result) {
    if ([string]::IsNullOrWhiteSpace($result.customName)) {
      [System.Windows.Forms.MessageBox]::Show('自定义名不能为空。', 'CC-DOGE-Switch', 'OK', 'Warning') | Out-Null
      return
    }
    $script:Profiles += ,$result
    if (Save-Profiles -Profiles $script:Profiles) { Refresh-List }
  }
})

$btnEdit.add_Click({
  $sel = Get-SelectedProfile
  if ($null -eq $sel) { return }
  $idx = $listView.SelectedItems[0].Index
  $result = Show-EditDialog -Base $sel -Mode 'edit'
  if ($null -ne $result) {
    if ([string]::IsNullOrWhiteSpace($result.customName)) {
      [System.Windows.Forms.MessageBox]::Show('自定义名不能为空。', 'CC-DOGE-Switch', 'OK', 'Warning') | Out-Null
      return
    }
    $script:Profiles[$idx] = $result
    if (Save-Profiles -Profiles $script:Profiles) { Refresh-List }
  }
})

$btnDup.add_Click({
  $sel = Get-SelectedProfile
  if ($null -eq $sel) { return }
  $copy = Copy-Profile -P $sel
  $result = Show-EditDialog -Base $copy -Mode 'dup'
  if ($null -ne $result) {
    if ([string]::IsNullOrWhiteSpace($result.customName)) {
      [System.Windows.Forms.MessageBox]::Show('自定义名不能为空。', 'CC-DOGE-Switch', 'OK', 'Warning') | Out-Null
      return
    }
    $script:Profiles += ,$result
    if (Save-Profiles -Profiles $script:Profiles) { Refresh-List }
  }
})

$btnDel.add_Click({
  $sel = Get-SelectedProfile
  if ($null -eq $sel) { return }
  $idx = $listView.SelectedItems[0].Index
  $r = [System.Windows.Forms.MessageBox]::Show(
    "确认删除配置 [$($sel.customName)] 吗?", 'CC-DOGE-Switch',
    'YesNo', 'Question')
  if ($r -eq 'Yes') {
    $newList = @()
    for ($i = 0; $i -lt $script:Profiles.Count; $i++) { if ($i -ne $idx) { $newList += ,$script:Profiles[$i] } }
    $script:Profiles = $newList
    if (Save-Profiles -Profiles $script:Profiles) { Refresh-List }
  }
})
```

- [ ] **Step 3: 运行验证增删改**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File E:\CC-DOGE-Switch\CC-DOGE-Switch.ps1`
Expected(手动操作):
- 点「+ 新建」→ 弹出编辑窗,17 个字段,密钥字段默认 DOGE_API_KEY、Provider 默认 anthropic,密钥值框掩码 → 填 customName="测试项" → 保存 → 列表多一行"测试项" → 关窗重启 exe → "测试项"仍在(持久化)
- 选中"测试项" → 点「编辑」→ 弹窗预填该 profile 值 → 改 mainModel → 保存 → 详情区更新
- 选中"测试项" → 点「复制」→ 弹窗预填且 customName="测试项 副本" → 保存 → 列表多一行
- 选中副本 → 点「删除」→ 确认 → 列表移除该行
- 关窗,检查 `E:\CC-DOGE-Switch\profiles.json` 存在且内容为剩余 profile 数组

- [ ] **Step 4: Commit**

```bash
git add -f E:/CC-DOGE-Switch/CC-DOGE-Switch.ps1
git commit -m "feat(cc-doge-switch): 编辑弹窗与增删改复制"
```

---

## Task 7: 打包脚本 build.ps1(ps2exe)

**Files:**
- Create: `E:\CC-DOGE-Switch\build.ps1`

- [ ] **Step 1: 写打包脚本**

写入 `E:\CC-DOGE-Switch\build.ps1`:

```powershell
# build.ps1 — 用 ps2exe 把 CC-DOGE-Switch.ps1 打包成 exe
# 需 PowerShell 5.1(Win11 自带)。自动拉取 ps2exe。

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $here 'CC-DOGE-Switch.ps1'
$out = Join-Path $here 'CC-DOGE-Switch.exe'

if (-not (Test-Path $src)) {
  Write-Host "Error: 找不到源码 $src" -ForegroundColor Red
  exit 1
}

# 1. 确保 ps2exe 可用:优先用已装模块,否则下载单文件版
$ps2exeReady = $false
if (Get-Module -ListAvailable ps2exe) {
  $ps2exeReady = $true
} else {
  Write-Host "ps2exe 未安装,尝试在线拉取..." -ForegroundColor Cyan
  $dl = Join-Path $here 'ps2exe.ps1'
  try {
    # ps2exe 官方仓库单文件入口
    Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/MS-Linux/ps2exe/master/ps2exe.ps1' -OutFile $dl -UseBasicParsing
    if (Test-Path $dl) { $ps2exeReady = $true }
  } catch {
    Write-Host "在线拉取失败: $($_.Exception.Message)" -ForegroundColor Yellow
  }
  if (-not $ps2exeReady) {
    Write-Host "自动拉取失败,请手动执行: Install-Module ps2exe -Scope CurrentUser -Force" -ForegroundColor Red
    exit 1
  }
}

# 2. 调用 ps2exe
Write-Host "打包中: $src -> $out" -ForegroundColor Cyan
if (Get-Module -ListAvailable ps2exe) {
  Invoke-PS2EXE -InputFile $src -OutputFile $out -NoConsole:$false -Title 'CC-DOGE-Switch' -NoOutput
} else {
  $ps2exeScript = Join-Path $here 'ps2exe.ps1'
  & $ps2exeScript -InputFile $src -OutputFile $out -NoConsole:$false -Title 'CC-DOGE-Switch' -NoOutput
}

if (Test-Path $out) {
  Write-Host "✓ 打包成功: $out" -ForegroundColor Green
} else {
  Write-Host "✗ 打包失败,未生成 exe" -ForegroundColor Red
  exit 1
}
```

- [ ] **Step 2: 运行打包(联网拉 ps2exe,生成 exe)**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File E:\CC-DOGE-Switch\build.ps1`
Expected:
- 若 ps2exe 已装:直接 "打包中..." → "✓ 打包成功: E:\CC-DOGE-Switch\CC-DOGE-Switch.exe"
- 若未装:打印 "ps2exe 未安装,尝试在线拉取..." → 下载 ps2exe.ps1 → 打包 → 成功
- `Test-Path E:\CC-DOGE-Switch\CC-DOGE-Switch.exe` 为 True
- 若在线拉取 URL 失效(404),改用备选:`https://raw.githubusercontent.com/MS-Linux/ps2exe/main/ps2exe.ps1` 或 `Install-Module ps2exe -Scope CurrentUser -Force`(手动,见 Step 1 的报错提示)。**这是本任务最可能踩的坑**,失败时先试备选 URL,再试 Install-Module。

- [ ] **Step 3: 双击 exe 验证 GUI 与 .ps1 一致**

双击 `E:\CC-DOGE-Switch\CC-DOGE-Switch.exe`(或在终端 `& E:\CC-DOGE-Switch\CC-DOGE-Switch.exe`)
Expected: 与 Task 5/6 Step 3 完全一致 —— 标题、7 项列表、详情、增删改、启动按钮全可用。ps2exe 打包后行为与源 .ps1 一致。

- [ ] **Step 4: Commit**

```bash
git add -f E:/CC-DOGE-Switch/build.ps1
git commit -m "feat(cc-doge-switch): ps2exe 打包脚本 build.ps1"
```

> exe 产物不纳入 git(二进制,且每次打包可能微变)。README 会说明如何重新打包。

---

## Task 8: README 使用说明

**Files:**
- Create: `E:\CC-DOGE-Switch\README.md`

- [ ] **Step 1: 写 README**

写入 `E:\CC-DOGE-Switch\README.md`:

````markdown
# CC-DOGE-Switch

Doge Code API 配置启动器(Windows GUI)。管理多份 doge API 配置,点「启动」把选定配置写入用户级环境变量,替代 `start_*.ps1` 脚本。

## 目录

```
E:\CC-DOGE-Switch\
├── CC-DOGE-Switch.ps1   # 源码(PowerShell + WinForms)
├── build.ps1            # 打包脚本(生成 exe)
├── CC-DOGE-Switch.exe   # 打包产物(双击运行,需重新打包时跑 build.ps1)
├── profiles.json        # 配置持久化(运行时自动生成)
└── README.md
```

## 使用

### 直接跑源码
```
powershell -NoProfile -ExecutionPolicy Bypass -File E:\CC-DOGE-Switch\CC-DOGE-Switch.ps1
```

### 跑 exe
双击 `CC-DOGE-Switch.exe`,或在终端 `& E:\CC-DOGE-Switch\CC-DOGE-Switch.exe`。

### 打包
```
powershell -NoProfile -ExecutionPolicy Bypass -File E:\CC-DOGE-Switch\build.ps1
```
首次会自动拉取 ps2exe。拉取失败时手动:`Install-Module ps2exe -Scope CurrentUser -Force`。

## 操作

1. **列表**:显示所有配置的自定义名 + 主模型名,单击选中,双击编辑
2. **新建/编辑/复制/删除**:工具栏按钮,弹出表单填写全字段
3. **启动**:选中一份配置,点「启动」按钮 → 写入用户级环境变量 → 弹提示
4. 启动后**新开** PowerShell 终端,运行 `doge` 或 `bun run dev` 即用该配置
   (已写入用户级环境变量,新终端自动继承;已开的旧终端不会变)

## 预置配置(首次启动自动生成 7 份)

| 名称 | 主模型 | Provider | BaseURL | 密钥字段 |
|------|--------|----------|---------|---------|
| DeepSeek | deepseek-v4-pro[1m] | openai | api.deepseek.com | DOGE_API_KEY |
| DeepSeek-Anthropic | deepseek-v4-pro[1m] | anthropic | api.deepseek.com/anthropic | ANTHROPIC_AUTH_TOKEN |
| GLM | glm-5.1 | anthropic | open.bigmodel.cn/api/anthropic | DOGE_API_KEY |
| GLM01 | glm-5.1 | anthropic | aiproxy.xin/cosphere | ANTHROPIC_AUTH_TOKEN |
| Coding-Plan | glm-5.1 | anthropic | ark.cn-beijing.volces.com/api/coding | ANTHROPIC_AUTH_TOKEN |
| Opus代理 | claude-opus-4-6[1m] | anthropic | code.ppchat.vip | ANTHROPIC_AUTH_TOKEN |
| Qwen | qwen3.7-max[1m] | anthropic | dashscope.aliyuncs.com/apps/anthropic | ANTHROPIC_AUTH_TOKEN |

值从仓库内 `start_*.ps1` 提取。

## 字段对照(14 个环境变量)

| profile 字段 | 环境变量 | 说明 |
|--------------|---------|------|
| ANTHROPIC_BASE_URL | ANTHROPIC_BASE_URL | API 端点 |
| apiKeyField + apiKeyValue | DOGE_API_KEY / ANTHROPIC_AUTH_TOKEN | 密钥二选一 |
| CLAUDE_CODE_COMPATIBLE_API_PROVIDER | 同名 | anthropic/openai/responses |
| ANTHROPIC_MODEL | 同名 | 默认主模型 |
| CLAUDE_CODE_MODEL_CONTEXT_WINDOW | 同名 | 上下文窗口 |
| ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL | 同名 | 三档模型 |
| ANTHROPIC_DEFAULT_OPUS/SONNET_MODEL_SUPPORTED_CAPABILITIES | 同名 | 能力声明 |
| CLAUDE_CODE_SUBAGENT_MODEL | 同名 | 子智能体模型 |
| CLAUDE_CODE_EFFORT_LEVEL | 同名 | low/medium/high/max |
| CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC | 同名 | 0/1 |
| CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK | 同名 | 0/1 |

> 表单里某字段留空 = 启动时写空串 = 清除该环境变量(对齐脚本开头的 `Remove-Item`)。

## 安全提示

- `profiles.json` 明文存储密钥,与原 `start_*.ps1` 脚本一致。请勿将该文件提交到公共仓库或分享。
- 列表与详情区对密钥做掩码显示(`***` + 后 4 位)。

## 不做什么(YAGNI)

- 不拉起 doge CLI(启动仍由用户手动在新终端跑)
- 不做 claude-to-im 同步
- 不加密密钥
````

- [ ] **Step 2: Commit**

```bash
git add -f E:/CC-DOGE-Switch/README.md
git commit -m "docs(cc-doge-switch): 使用说明 README"
```

---

## Task 9: 端到端验收测试

**Files:**
- 无新文件;验证已有产物

- [ ] **Step 1: 预置数据验收**

删掉 `profiles.json`(若存在),跑 exe(源码或 exe 皆可),确认生成 7 份且内容与 spec 第 6 节表格一致。
Run:
```bash
rm -f /e/CC-DOGE-Switch/profiles.json
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content E:\CC-DOGE-Switch\profiles.json -Raw | ConvertFrom-Json | Select-Object -ExpandProperty profiles | Measure-Object | Select-Object -ExpandProperty Count"
```
> 注:profiles.json 由 exe/ps1 启动时生成。需先启动一次 exe 让它写文件,再读。
启动 exe → 关闭 → Run:
```bash
powershell -NoProfile -Command "(Get-Content E:\CC-DOGE-Switch\profiles.json -Raw | ConvertFrom-Json).profiles.Count"
```
Expected: `7`

- [ ] **Step 2: 启动落地验收**

在 exe 里选中 "DeepSeek" → 点「启动」→ 确认弹提示。新开一个 PowerShell 终端(不是 exe 自身进程):
Run:
```bash
powershell -NoProfile -Command "Write-Host \"BASE=$env:ANTHROPIC_BASE_URL\"; Write-Host \"PROVIDER=$env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER\"; Write-Host \"EFFORT=$env:CLAUDE_CODE_EFFORT_LEVEL\"; Write-Host \"KEY=$($env:DOGE_API_KEY.Substring([Math]::Max(0,$env:DOGE_API_KEY.Length-4)))\""
```
> 注:必须在新开的终端里跑(用户级变量需新进程继承)。当前 Claude 会话的终端是已开的,不会自动变 —— 需用户另开终端验证,或由测试脚本显式起子进程读取。
Expected: `BASE=https://api.deepseek.com`、`PROVIDER=openai`、`EFFORT=max`、`KEY=4ada`

- [ ] **Step 3: 切换清理验收**

在 exe 里选中 "Qwen" → 点「启动」。新开终端:
Expected: `BASE=https://dashscope.aliyuncs.com/apps/anthropic`、`PROVIDER=anthropic`、`EFFORT=`(空,Qwen 脚本未设 effort,已被清理,不残留 max)、`TRAFFIC=`(空,被清理)、key 为 `ANTHROPIC_AUTH_TOKEN=...bb1`

- [ ] **Step 4: 增删改持久化验收**

exe 里「+ 新建」→ 填 customName="验收项"、mainModel="test"、其余任意 → 保存 → 关闭 exe → 重开 → 确认"验收项"仍在 → 编辑改名 → 删除 → 确认列表与 profiles.json 同步。

- [ ] **Step 5: 打包产物一致性验收**

跑 `build.ps1` 重新打包 → 双击 exe → 确认 GUI 与源码运行版本行为完全一致(列表、详情、启动、增删改)。

- [ ] **Step 6: 还原测试副作用**

测试期间若激活了 TEST_PROBE 或改动,选中一份真实配置(如 DeepSeek)启动一次,或手动清空用户级变量:
```bash
powershell -NoProfile -Command "foreach(\$n in 'ANTHROPIC_BASE_URL','DOGE_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_COMPATIBLE_API_PROVIDER','CLAUDE_CODE_MODEL_CONTEXT_WINDOW','CLAUDE_CODE_EFFORT_LEVEL','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC','CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK','ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES','ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES','CLAUDE_CODE_SUBAGENT_MODEL','CLAUDE_CODE_AUTO_COMPACT_WINDOW'){ [Environment]::SetEnvironmentVariable(\$n,\$null,'User') }"
```
> 这一步可选 —— 若用户希望保留某配置激活,跳过即可。

- [ ] **Step 7: 最终 Commit(若有改动)**

```bash
git add -A
git commit -m "test(cc-doge-switch): 端到端验收通过" --allow-empty
```

---

## 自审

**Spec 覆盖**:
- §2 产品定位(管理+启动)→ Task 5/6(管理 GUI)+ Task 4(启动逻辑)✓
- §3 技术栈(PowerShell+WinForms+ps2exe)→ Task 1-7(源码)+ Task 7(打包)✓
- §4 目录布局 → Task 1/7/8 ✓
- §5 数据模型(14 字段 + 密钥二选一)→ Task 2 预置数据 + Task 4 Set-EnvVarsFromProfile + Task 6 编辑弹窗 ✓
- §6 预置 7 份 → Task 2 ✓
- §7 GUI 布局 → Task 5(列表/详情/启动/状态栏)+ Task 6(编辑弹窗)✓
- §8 启动落地(清理16项+写值+广播)→ Task 4 ✓
- §9 错误处理 → Task 3(JSON 损坏备份、保存失败弹框)+ Task 4(写失败弹框)+ Task 5(空选择提示)✓
- §10 测试方案 → Task 9 端到端 ✓
- §11 YAGNI(不做 CLI/CTI/加密)→ 全程未涉及 ✓

**占位符扫描**:无 TBD/TODO;Task 5 占位事件在 Task 6 Step 2 明确替换为真实逻辑(已给出替换前后代码)。✓

**类型一致性**:`$script:Profiles`(全局数组)、`Get-SelectedProfile`(返回 hashtable)、`Show-EditDialog`(返回 ordered hashtable 或 null)、`Invoke-Activate`(返回 bool)跨任务命名一致。`Get-DefaultProfiles` 返回 `[ordered]@{}` 数组,`Save-Profiles` 用 `Convert-ProfileToStrings` 统一字符串,`Load-Profiles` 重建为 ordered hashtable —— 闭环一致。✓

**已知风险**:Task 7 在线拉 ps2exe 的 URL 可能失效,已在 Step 2 给出备选 URL 与 Install-Module 降级方案。Task 4 测试会真实改写用户级环境变量,Step 2 有备份/还原逻辑,Task 9 Step 6 给出清理命令。
