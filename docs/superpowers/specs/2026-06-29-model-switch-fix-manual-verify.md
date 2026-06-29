# 模型切换错位修复 — 手动验证脚本

- **配套 design**：`2026-06-29-model-switch-fix-design.md`
- **目的**：在自动化测试之外，从用户视角逐步走完两条切换路径，确认状态栏 ≡ 实际请求模型，且兜底切换的原子性成立。

---

## 前置准备

1. 确认当前在 `feat/model-switch-fix` 分支，代码已实施完毕。
2. 备份 `~/.doge/.credentials.json`（脚本会写入 / 后续可能切只读）。
3. 在 `~/.doge/.credentials.json` 的 `customApiEndpoint.modelProfiles[]` 至少有两个 profile：
   - **qwen-max-profile**：`model = qwen3.7-max`，`defaultOpusModel = qwen3.7-max`，`defaultSonnetModel = qwen3-plus`，`defaultHaikuModel = qwen3-flash` —— **三 tier 全配置**。
   - **deepseek-profile**：`model = deepseek-chat`，`defaultOpusModel`/`defaultSonnetModel`/`defaultHaikuModel` **全部留空** —— **三 tier 全留空**。

---

## 步骤

### 1. 启动 doge

```sh
bun run dev --debug=model-switch,api
```

**期望**：状态栏第二行显示 `qwen3.7-max ...`（假设上次会话以 qwen 收尾；若不同，先 `/model` 切到 qwen-max-profile 再继续）。

### 2. /model → haiku

**操作**：输入 `/model haiku` 或在面板选 Haiku。

**期望**：状态栏显示 `qwen3-flash ...`（qwen profile 的 defaultHaikuModel）。

### 3. /model → default

**操作**：输入 `/model default` 或在面板选 Default。

**期望**：状态栏回到 `qwen3.7-max ...`。

### 4. /model → deepseek-profile（兜底切换）

**操作**：在 `/model` 面板选择 deepseek-profile 这一项。

**期望**：
- 状态栏**立刻**显示 `deepseek-chat ...`，不出现一帧 qwen 残留。
- debug 日志 `~/.doge/debug/<sessionId>.txt` 中应看到一行 `model-switch | phase=success profile=deepseek-chat`。

### 5. /model → haiku（关键回归点）

**操作**：deepseek-profile 三 tier 全留空，输入 `/model haiku`。

**期望**：状态栏显示 `deepseek-chat ...`（因为新 profile 无 haiku 覆盖，`getDefaultHaikuModel()` fallback 到 `ANTHROPIC_MODEL`）。

**反例**（未修复前的现象）：状态栏显示 `qwen3-flash` 或其他 qwen 残留——本步骤就是检测它消失。

### 6. 切回 qwen-max-profile → /model → haiku（正向路径未破）

**操作**：先 `/model` 选 qwen-max-profile，再 `/model haiku`。

**期望**：状态栏回到 `qwen3-flash`。证明白名单清理没有连累正向路径。

### 7. 实际请求一致性

**操作**：在第 5 步状态下（deepseek-chat + alias=haiku），发一条短消息（如"hi"）。

**期望**：debug 日志中实际发起的 API 请求 `model` 字段 === 状态栏第二行显示的模型 ID。逐字比对，不允许任何差异。

### 8. 磁盘只读回滚验证

**操作（Windows PowerShell）**：

```powershell
$cred = "$env:USERPROFILE\.doge\.credentials.json"
attrib +R $cred
```

然后 `/model` 切到任一其他 profile。

**期望**：
- toast 显示 `Model switch failed at persist: ...`
- 状态栏保持原 profile 不变。
- env 中 `ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_*` 全部保持切换前值（用 debug log 中的 `envBefore` / `envAfter` 比对）。

**清理**：

```powershell
attrib -R $cred
```

### 9. /clear 无回归

**操作**：第 7 步后 `/clear`，再 `/resume` 看上一次会话。

**期望**：能看到第 7 步的对话内容（验证 /clear 已工作，不在本修复范围被破坏）。

---

## 通过准则

9 步全部按"期望"行为发生，且：

- 第 5 步**未**看到 qwen 残留 = 核心回归修复成立。
- 第 7 步状态栏 ≡ API 实际模型 ID = §1.1 不变量成立。
- 第 8 步切换失败时 env + 状态栏不变 = §1.2 原子性 + 回滚守则成立。

任意一步偏离 → 标注偏离点 + 截图，回到 design 复盘。
