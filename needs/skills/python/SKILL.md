# Python Environment Executor

## When to use
当用户需要在指定 Python 环境中运行本地 .py 文件时使用。

## Core Principles
- **优先自动化，保留手动控制**
- **Windows 兼容优先**
- **避免无效重试，快速失败并引导用户**

## Execution Flow

### Step 1: 询问环境管理方式（单选）
> “请选择 Python 环境管理方式：  
> 1. Conda（推荐）  
> 2. Pyenv  
> 3. 虚拟环境（venv/virtualenv）  
> 4. 系统 Python  
> 5. 手动指定解释器路径”

### Step 2: 智能列举 + 容错
- **Conda**: 使用 `conda info --envs` 获取完整路径列表（含 base），解析出 `<name>` 和 `<path>`
- **若命令失败** → 直接提示：“无法自动获取环境列表，请手动输入环境名称或完整路径”
- **venv**: 提示用户输入虚拟环境根目录（如 `./venv` 或 `E:\myenv`）

### Step 3: 安全执行（关键改进）
- **Conda 环境** → 使用 **`conda run -n <name> python <script>`**  
  （✅ 支持非交互式，无需 activate）
- **venv 环境** → 构造完整解释器路径：`<venv>/Scripts/python.exe`（Windows）或 `<venv>/bin/python`（Unix）
- **系统/手动路径** → 直接调用 `python <script>` 或 `<custom_path> <script>`

### Step 4: 执行反馈
- 显示：使用的解释器路径、Python 版本、脚本输出
- 捕获标准输出与错误，结构化呈现

## Error Handling
- 任何命令失败 → 立即停止自动流程，转为**手动模式**
- 提供明确指令：“请提供 conda 环境名 或 Python 解释器完整路径”

## Example Trigger
`/python E:\project\main.py`