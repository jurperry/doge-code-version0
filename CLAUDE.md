# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is **Doge Code**, a fork of Claude Code that has been reconstructed from source maps and modified for custom API compatibility. It's not the official upstream repository but a "parallel universe" fork focused on:

- Supporting custom Anthropic-compatible API endpoints
- Adding OpenAI Chat Completions ↔ Anthropic Messages translation layer
- Adding Anthropic Responses API (/v1/responses) compatibility layer
- Custom API key and model list management
- Data isolation from original Claude Code (uses `~/.doge` instead of `~/.claude`)
- Enabling self-hosted, proxy-based, and custom model integration scenarios
- BUDDY feature support (enabled via bunfig.toml)

## Development Environment

**Runtime**: Bun 1.3.5+ and Node.js 24+
**Package Manager**: Bun
**TypeScript**: ESM modules with React JSX
**Configuration**: `bunfig.toml` enables BUDDY feature via compile-time defines
**Entry Points**: 
- `src/bootstrap-entry.ts` - Main CLI entry point (imports `src/entrypoints/cli.tsx`)
- `src/dev-entry.ts` - Development entry point with missing import detection
- `src/entrypoints/cli.tsx` - Primary CLI application logic
- `src/main.tsx` - Main application component (808KB, core UI logic)

## Common Development Commands

```bash
# Install dependencies
bun install

# Start the CLI in development mode
bun run dev

# Alias for development mode
bun run start

# Check version
bun run version

# Register as global command (after installation)
bun link
# Then run: doge

# Development workspace check (shows missing imports)
bun run dev:restore-check
```

## Project Structure

### Core Directories
- `src/` - Main source code
  - `assistant/` - Assistant mode (KAIROS feature)
  - `bootstrap/` - Bootstrap utilities
  - `bridge/` - Bridge functionality for remote sessions
  - `buddy/` - Buddy system components
  - `cli/` - CLI-specific logic
  - `commands/` - CLI command implementations
  - `components/` - React components for TUI
  - `constants/` - Application constants
  - `context/` - Context management
  - `coordinator/` - Coordinator mode
  - `entrypoints/` - Application entry points
  - `hooks/` - React hooks
  - `ink/` - Ink (React TUI) related utilities
  - `jobs/` - Background job management
  - `keybindings/` - Keyboard shortcut handling
  - `memdir/` - Memory directory management
  - `migrations/` - Configuration migrations
  - `moreright/` - Additional features
  - `native-ts/` - TypeScript native bindings
  - `outputStyles/` - Output formatting styles
  - `plugins/` - Plugin system
  - `proactive/` - Proactive features
  - `query/` - Query handling
  - `remote/` - Remote session support
  - `schemas/` - Data schemas and validation
  - `screens/` - TUI screen components
  - `server/` - Server-side logic
  - `services/` - Backend services (API clients, MCP, analytics)
    - `api/` - API client implementations
    - `analytics/` - Analytics and telemetry
    - `AgentSummary/` - Agent summary generation
  - `skills/` - Skill system
  - `ssh/` - SSH integration
  - `state/` - State management
  - `tasks/` - Task management
  - `tools/` - Tool implementations
  - `types/` - TypeScript type definitions
  - `upstreamproxy/` - Upstream proxy handling
  - `utils/` - Utilities and helpers
  - `vim/` - Vim mode support
  - `voice/` - Voice input support
- `vendor/` - Restored or compatibility code
- `shims/` - Local package shims for missing modules
  - `ant-claude-for-chrome-mcp/` - Chrome MCP shim
  - `ant-computer-use-input/` - Computer use input shim
  - `ant-computer-use-mcp/` - Computer use MCP shim
  - `ant-computer-use-swift/` - Swift computer use shim
  - `color-diff-napi/` - Color diff native addon shim
  - `modifiers-napi/` - Modifiers native addon shim
  - `url-handler-napi/` - URL handler native addon shim
- `needs/` - Files needed for restoration
  - `settings.json` - Example settings configuration
  - `skills/` - Skill definitions and templates
- `packages/` - Local packages

### Key Architecture Components

1. **API Compatibility Layer**: Three provider modes with protocol translation:
   - `anthropic`: Native Anthropic SDK `/messages` flow
   - `openai`: OpenAI Chat Completions compatibility (`/v1/chat/completions`)
     - Request translation: Anthropic Messages → OpenAI Chat format
     - Response translation: OpenAI SSE events → Anthropic stream events
     - Special handling for DeepSeek API (max_tokens capped at 8192)
   - `responses`: Anthropic Responses API compatibility (`/v1/responses`)
     - Request translation: Anthropic Messages → Responses format
     - Event translation: Responses events → Anthropic stream events
     - Supports custom gateway implementations

2. **Configuration Isolation**: Uses `~/.doge` directory instead of `~/.claude` to avoid conflicts with original Claude Code.
   - Global config: `~/.doge/.claude.json`
   - Prevents authentication, endpoint, and model configuration conflicts
   - Can be overridden with `CLAUDE_CONFIG_DIR` environment variable

3. **Custom API Support**: 
   - Environment variables: `DOGE_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `CLAUDE_CODE_COMPATIBLE_API_PROVIDER`
   - Custom API storage in `src/utils/customApiStorage.ts`
   - Provider detection in `src/utils/auth.ts`
   - Bypasses API key approval flow for custom providers
   - Reads from `customApiStorage` with environment variable fallbacks

4. **Bridge System**: Handles remote sessions and code execution bridges.

5. **Entry Points**:
   - `src/bootstrap-entry.ts` - Main CLI entry point (production)
   - `src/dev-entry.ts` - Development entry point with missing import detection
   - `src/entrypoints/cli.tsx` - Primary application logic
   - `src/main.tsx` - Main application component

6. **Native Shims**: Local package shims for missing native modules:
   - `color-diff-napi` - Color difference calculations
   - `modifiers-napi` - Keyboard modifier handling
   - `url-handler-napi` - URL protocol handling
   - Computer use MCP modules for browser and system interaction

## API Compatibility Details

### Provider Configuration
The system supports three API provider types configured via `CLAUDE_CODE_COMPATIBLE_API_PROVIDER`:
- `anthropic`: Default, uses Anthropic SDK with native `/messages` endpoint
- `openai`: OpenAI Chat Completions format (`/v1/chat/completions`)
- `responses`: Anthropic Responses API format (`/v1/responses`)

### Architecture Overview
The compatibility layer works by:
1. Internal logic continues to use Anthropic Messages format throughout the codebase
2. When a custom provider is selected, requests are translated to the target format at the API boundary
3. Streaming responses are converted back to Anthropic-style events for internal consumption
4. This allows the entire codebase to remain Anthropic-native while supporting multiple backends
5. Translation happens in dedicated adapter modules, keeping core logic clean

### Key Files for API Integration
- `src/services/api/claude.ts` (134KB) - Main API client with provider detection and routing
  - Imports `getGlobalCompatProvider()` from `client.ts` to avoid circular dependencies
  - Provider resolution: `customApiStorage.provider ?? getGlobalCompatProvider()`
  - Credentials: `customApiStorage.apiKey || process.env.DOGE_API_KEY || ''`
  - Base URL: `customApiStorage.baseURL || process.env.ANTHROPIC_BASE_URL || ''`
  - Supports provider-specific API key verification
  
- `src/services/api/openaiCompat.ts` (15KB) - OpenAI Chat Completions compatibility adapter
  - Handles `/v1/chat/completions` endpoint
  - Converts Anthropic Messages → OpenAI Chat format
  - Streams back OpenAI SSE events → Anthropic stream events
  - Includes DeepSeek-specific `max_tokens` limiting (8192 max)
  - Exports shared helpers: `joinBaseUrl()`, `contentToText()`, `toBlocks()`
  
- `src/services/api/responsesCompat.ts` (18KB) - Responses API compatibility adapter
  - Handles `/v1/responses` endpoint
  - Converts Anthropic Messages → Responses format
  - Translates Responses events back to Anthropic format
  - Event mapping:
    - `response.output_text.delta` → text content delta
    - `response.output_item.added` → new output item
    - `response.function_call_arguments.delta` → tool call arguments
    - `response.output_item.done` → item completion
    - `response.completed/incomplete/failed` → final status
    
- `src/services/api/client.ts` (17KB) - Provider configuration utilities
  - Exports `getGlobalCompatProvider()` function to resolve circular dependencies
  - Recognizes: `'anthropic'`, `'openai'`, `'responses'`
  - Fallback: Unknown values default to `'anthropic'`
  
- `src/utils/auth.ts` (68KB) - Authentication with custom API support
  - Bypasses API key approval flow for custom providers
  - Reads from `DOGE_API_KEY` environment variable
  - Detects custom providers via `customApiStorage` and environment variables
  - Skip approval conditions:
    - Custom provider is `'openai'` or `'responses'`
    - Base URL is not first-party Anthropic URL
  - Key source marked as `'DOGE_API_KEY'` for custom providers
  
- `src/utils/customApiStorage.ts` - Persistent storage for custom API configurations
  - Stores: `provider`, `apiKey`, `baseURL`, `model`
  - Provider type: `'anthropic' | 'openai' | 'responses'`
  
- `src/utils/config.ts` - Global configuration including custom API endpoint settings
  - `GlobalConfig.customApiEndpoint.provider` supports all three provider types

### Environment Variables for Testing

#### DeepSeek API Example (OpenAI format)
```powershell
# Clear old variables
Remove-Item Env:\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:\ANTHROPIC_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:\DOGE_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:\CLAUDE_CODE_MODEL_CONTEXT_WINDOW -ErrorAction SilentlyContinue

# Set DeepSeek configuration
$env:ANTHROPIC_BASE_URL = "https://api.deepseek.com"
$env:DOGE_API_KEY = "sk-your-api-key"
$env:ANTHROPIC_MODEL = "deepseek-chat"
$env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER = "openai"

# Optional: Override context window (DeepSeek is auto-detected as 128k)
# $env:CLAUDE_CODE_MODEL_CONTEXT_WINDOW = "128000"
```

#### Custom Responses API Example
```powershell
# Clear old variables
Remove-Item Env:\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:\ANTHROPIC_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:\DOGE_API_KEY -ErrorAction SilentlyContinue

# Set Responses API configuration
$env:ANTHROPIC_BASE_URL = "https://your-gateway.example"
$env:DOGE_API_KEY = "your-api-key"
$env:ANTHROPIC_MODEL = "your-model-name"
$env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER = "responses"
```

#### Native Anthropic API
```powershell
# Clear old variables
Remove-Item Env:\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:\ANTHROPIC_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:\DOGE_API_KEY -ErrorAction SilentlyContinue

# Set Anthropic configuration
$env:ANTHROPIC_BASE_URL = "https://api.anthropic.com"
$env:DOGE_API_KEY = "your-anthropic-key"
$env:ANTHROPIC_MODEL = "claude-opus-4-6"
$env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER = "anthropic"
```

#### Custom Proxy Example (Anthropic format)
```powershell
# Clear old variables
Remove-Item Env:\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:\ANTHROPIC_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:\DOGE_API_KEY -ErrorAction SilentlyContinue

# Set proxy configuration
$env:ANTHROPIC_BASE_URL = "https://yunyi.rdzhvip.com/claude"
$env:ANTHROPIC_AUTH_TOKEN = "your-auth-token"
$env:DOGE_API_KEY = ""
$env:ANTHROPIC_MODEL = "claude-opus-4-6"
$env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER = "anthropic"
```

### Quick Start Scripts
The repository includes PowerShell scripts for quickly testing different providers:
- `start_deepseek.ps1` - DeepSeek API (OpenAI format, max_tokens capped at 8192)
- `start_opus.ps1` - Anthropic Opus (native format)
- `start_opus0407.ps1` - Anthropic Opus via custom proxy endpoint
- `start_sonnet.ps1` - Anthropic Sonnet (native format)
- `start_gemini.ps1` - Google Gemini (OpenAI format)
- `start_glm.ps1` - GLM models (OpenAI format)
- `start_gjglm.ps1` - GLM models variant
- `start_codex.ps1` - Codex models
- `start_gpt54high.ps1` - GPT-5.4 high variant
- `start_gpt54pro.ps1` - GPT-5.4 pro variant

Each script:
1. Clears existing environment variables to prevent conflicts
2. Sets provider-specific `ANTHROPIC_BASE_URL`, `DOGE_API_KEY`, `ANTHROPIC_MODEL`
3. Configures `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` (anthropic/openai/responses)
4. Can be sourced before running `bun run dev` or `doge`

## Code Style & Conventions

- TypeScript-first with ESM imports
- React JSX with functional components (`react-jsx` transform)
- CamelCase for variables/functions, PascalCase for React components/classes
- Kebab-case for command folders (e.g., `src/commands/install-slack-app/`)
- Many files omit semicolons and use single quotes
- Imports should not be reordered when comments warn against it
- Prefer small, focused modules over broad utility dumps
- Match surrounding file style exactly
- Large files like `src/main.tsx` (808KB) contain core UI logic - handle with care

## Key Source Files

### Core Application Files
- `src/main.tsx` (808KB) - Main application component with core UI logic
- `src/query.ts` (70KB) - Query handling logic
- `src/QueryEngine.ts` (48KB) - Query engine implementation
- `src/commands.ts` (26KB) - Command definitions and routing
- `src/interactiveHelpers.tsx` (58KB) - Interactive UI helpers
- `src/dialogLaunchers.tsx` (23KB) - Dialog launching utilities

### API Layer (Critical for Multi-Provider Support)
- `src/services/api/claude.ts` (134KB) - Main API client with provider routing
- `src/services/api/openaiCompat.ts` (15KB) - OpenAI Chat Completions adapter
- `src/services/api/responsesCompat.ts` (18KB) - Responses API adapter
- `src/services/api/client.ts` (17KB) - Provider configuration utilities
- `src/services/api/errors.ts` (44KB) - Error handling
- `src/services/api/withRetry.ts` (29KB) - Retry logic

### Authentication & Configuration
- `src/utils/auth.ts` (68KB) - Authentication with custom API bypass logic
- `src/utils/customApiStorage.ts` - Persistent custom API configuration storage
- `src/utils/config.ts` - Global configuration management
- `src/utils/autoUpdater.ts` (19KB) - Auto-update functionality

### Utilities
- `src/utils/ansiToPng.ts` (215KB) - ANSI to PNG conversion
- `src/utils/attachments.ts` (131KB) - Attachment handling
- `src/utils/analyzeContext.ts` (44KB) - Context analysis

## Testing & Validation

No consolidated test suite exists. Validation approach:
- Boot CLI with `bun run dev`
- Test version output with `bun run version`
- Exercise specific commands/services/UI paths changed
- Place tests close to features they cover
- Use provided PowerShell scripts to test different API providers

## Restoration Notes

This is a reconstructed source tree, not pristine upstream. Key characteristics:
- Contains restoration fallbacks and shim behavior
- Some modules may be incomplete or have missing imports
- `dev-entry.ts` scans for missing relative imports on startup
- Prefer minimal, auditable changes and document restoration workarounds
- Two layers of history:
  1. Restoration artifacts from source map reconstruction
  2. Intentional Doge Code fork modifications

## Important Configuration Files

- `package.json` - Package configuration with `@doge-code/cli` name and `doge` command
- `tsconfig.json` - TypeScript configuration with `src/*` path alias and bundler resolution
- `bunfig.toml` - Bun configuration enabling BUDDY feature via compile-time defines
- `bun.lock` - Bun lockfile (142KB)
- `AGENTS.md` - Repository guidelines and structure
- `README.md` - Project overview and installation guide (Chinese, comprehensive fork documentation)
- `CLAUDE.md` - This file, guidance for Claude Code
- `debug_updates.md` - **Agent 功能补齐与修正日志汇总**（包含所有 bug 修复的详细记录）
- `start_*.ps1` - PowerShell scripts for testing different API providers (10 scripts total)
- `test-buddy-feature.ts` - BUDDY feature test script

## Development Workflow

1. **Initial Setup**:
   ```bash
   git clone <repository>
   cd doge-code
   bun install
   bun link
   ```

2. **Regular Updates** (source-level update workflow):
   ```bash
   git pull
   bun install
   bun link
   ```

3. **Running the CLI**:
   ```bash
   # Development mode
   bun run dev
   
   # After bun link
   doge
   
   # Check version
   bun run version
   ```

4. **Testing Different API Providers**: Use the provided PowerShell scripts:
   ```powershell
   # DeepSeek
   .\start_deepseek.ps1
   
   # Anthropic Opus
   .\start_opus.ps1
   
   # Anthropic Sonnet
   .\start_sonnet.ps1
   
   # Other providers
   .\start_gemini.ps1
   .\start_glm.ps1
   ```

## Key Modifications from Original Claude Code

### 1. Authentication Flow (`src/utils/auth.ts`)
- **Purpose**: Skip API key approval for custom OpenAI-compatible APIs
- **Detection**: Reads `customApiStorage` and `CLAUDE_CODE_COMPATIBLE_API_PROVIDER`
- **Bypass Conditions**: 
  - Custom provider is `'openai'` or `'responses'`
  - Base URL is not first-party Anthropic URL
- **Key Source**: Returns API key with source marked as `'DOGE_API_KEY'`

### 2. OpenAI Compatibility (`src/services/api/openaiCompat.ts`)
- **Path**: Uses standard `/v1/chat/completions` endpoint
- **max_tokens Handling**: 
  - Detects DeepSeek API via `ANTHROPIC_BASE_URL`
  - Automatically limits `max_tokens` to 8192 for DeepSeek
  - DeepSeek supports 128k context but only 8192 output tokens
- **Translation**: Converts Anthropic Messages ↔ OpenAI Chat format
- **Streaming**: Translates OpenAI SSE events back to Anthropic stream events

### 3. Responses API Compatibility (`src/services/api/responsesCompat.ts`)
- **Path**: Uses `/v1/responses` endpoint
- **Translation**: Converts Anthropic Messages → Responses format
- **Event Handling**: Translates Responses events back to Anthropic format
  - `response.output_text.delta`
  - `response.output_item.added`
  - `response.function_call_arguments.delta`
  - `response.output_item.done`
  - `response.completed/incomplete/failed`

### 4. Provider Detection (`src/services/api/client.ts`)
- **Export**: `getGlobalCompatProvider()` function to resolve circular dependencies
- **Recognition**: Supports `'anthropic'`, `'openai'`, `'responses'`
- **Fallback**: Unknown values default to `'anthropic'`

### 5. Main API Client (`src/services/api/claude.ts`)
- **Import**: Uses `getGlobalCompatProvider()` from `client.ts`
- **Provider Resolution**: `customApiStorage.provider ?? getGlobalCompatProvider()`
- **Credentials**: Reads from `customApiStorage` with environment variable fallbacks
  - API Key: `customApiStorage.apiKey || process.env.DOGE_API_KEY || ''`
  - Base URL: `customApiStorage.baseURL || process.env.ANTHROPIC_BASE_URL || ''`
- **Verification**: Supports provider-specific API key verification

### 6. Agent Model Selection Fallback (`src/utils/model/model.ts`)
- **Purpose**: Ensure Agent model selection falls back to user's main model when specific tier models are unavailable
- **Fixed Issue**: Previously, `Agent(model="haiku")` would use hardcoded `claude-haiku-4-5-20251001` even when user only configured `deepseek-chat`
- **Fallback Priority**:
  1. `ANTHROPIC_DEFAULT_*_MODEL` environment variables (highest priority)
  2. User's main model from `settings.model` or `ANTHROPIC_MODEL`
  3. Hardcoded defaults (last resort)
- **Functions Modified**: `getDefaultOpusModel()`, `getDefaultSonnetModel()`, `getDefaultHaikuModel()`
- **Configuration Examples**:
  ```json
  // Auto-fallback (recommended for single-model APIs)
  { "model": "deepseek-chat" }
  // All Agent tiers automatically use deepseek-chat
  
  // Force all tiers to use same model
  {
    "model": "claude-opus-4-6",
    "env": {
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-opus-4-6",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-opus-4-6"
    }
  }
  
  // Use different models per tier (multi-model APIs)
  {
    "model": "claude-opus-4-6",
    "env": {
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5-20251001"
    }
  }
  ```
- **Details**: See `debug_updates.md` Chapter 7 for complete documentation

## Notes for Contributors

- This is a fork with both restoration artifacts and intentional modifications
- Changes should maintain compatibility with the three API provider modes
- Configuration isolation (`~/.doge`) must be preserved
- Missing import detection in `dev-entry.ts` helps identify restoration gaps
- The goal is "run first, then maintain, then customize" rather than archaeological purity
- When adding new features, consider impact on all three provider modes
- Document any provider-specific workarounds or limitations
- Test with multiple providers when modifying API layer code
- Not a git repository - changes are tracked through file system only
- Large files (e.g., `src/main.tsx` at 808KB) require careful editing to avoid corruption
- Use chunked writes for files exceeding 50 lines when creating new content

## Troubleshooting

### Common Issues

**API Connection Failures**
- Verify `ANTHROPIC_BASE_URL` is set correctly for your provider
- Check `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` matches your endpoint format
- Ensure `DOGE_API_KEY` contains valid credentials
- For DeepSeek: max_tokens is auto-limited to 8192

**Configuration Conflicts**
- Clear old environment variables before switching providers (see `start_*.ps1` scripts)
- Ensure `~/.doge` directory is used, not `~/.claude`
- Check `customApiStorage` for persisted settings that may override env vars

**Build/Runtime Errors**
- Run `bun install` after pulling updates
- Run `bun link` to refresh global command registration
- Check for missing imports using `bun run dev:restore-check`
- Verify Bun version is 1.3.5+ and Node.js is 24+

**Provider-Specific Issues**
- **DeepSeek**: If getting "Invalid max_tokens" errors, check `openaiCompat.ts` has the 8192 limit logic
- **DeepSeek Context**: Fixed 2026-04-07 - context window corrected to 102,400 tokens (see `debug_updates.md`)
- **Responses API**: Event shape mismatches may require adjustments in `responsesCompat.ts`
- **OpenAI Format**: Tool calling may have compatibility differences

**Agent Model Selection Issues (Fixed 2026-04-08)**
- **Problem**: Agent would use hardcoded model names (e.g., `claude-sonnet-4-6`) even when user only configured one model
- **Symptom**: `Agent(model="haiku")` fails with "model not found" on single-model APIs
- **Solution**: Added fallback mechanism - all Agent tiers now automatically use user's main model when tier-specific models aren't configured
- **Configuration**: Set `ANTHROPIC_DEFAULT_*_MODEL` environment variables to override, or leave unset for automatic fallback
- **Details**: See `debug_updates.md` Chapter 7 for complete documentation

**Context Window Issues (Fixed 2026-04-07)**
- **Problem**: Third-party models (DeepSeek, GLM, Gemini) were incorrectly detected as having 200k context
- **Symptom**: Auto-compact triggers too late, causing API context length errors
- **Solution**: Added hardcoded context windows for common models + `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` env var
- **Details**: See `debug_updates.md` for complete documentation
- **Verification**: Check logs for `autocompact: effectiveWindow=` value matching your model's actual context

### Debug Workflow
1. Check environment variables: `echo $env:ANTHROPIC_BASE_URL`, `echo $env:DOGE_API_KEY`
2. Verify provider setting: `echo $env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER`
3. Test with minimal input after starting CLI
4. Check console output for detailed error messages
5. Review relevant adapter code (`openaiCompat.ts`, `responsesCompat.ts`, `claude.ts`)

## Project Status

**Current State**: Functional fork with multi-provider support
**Maintenance**: Active development, source-level updates via file system
**Stability**: Core features stable, experimental features (OpenAI/Responses compat) in iteration
**Documentation**: Comprehensive Chinese README, detailed change logs, inline code documentation

## Known Limitations

- Build/typecheck may have issues due to Bun type definitions
- Some TypeScript configurations may show deprecation warnings
- Responses API event shapes may vary across gateways
- Not all OpenAI Chat Completions features are fully supported
- Tool calling may have compatibility differences across providers
- Some native modules are shimmed and may have reduced functionality
- Not a git repository - source tree is maintained without version control
- Some restoration artifacts and fallback behaviors remain from source map reconstruction

## Development Notes

### BUDDY Feature
- Enabled via `bunfig.toml` compile-time defines
- Test script available: `test-buddy-feature.ts`
- Feature flag: `BUDDY = "true"` in both `[bundle.define]` and `[define]` sections

### Native Shims
Located in `shims/` directory, providing compatibility for missing native modules:
- `color-diff-napi/` - Color difference calculations
- `modifiers-napi/` - Keyboard modifier handling  
- `url-handler-napi/` - URL protocol handling
- `ant-claude-for-chrome-mcp/` - Chrome MCP integration
- `ant-computer-use-input/` - Computer use input handling
- `ant-computer-use-mcp/` - Computer use MCP server
- `ant-computer-use-swift/` - Swift-based computer use (macOS)

### Local Packages
- `packages/@ant/` - Internal Anthropic packages restored from source maps

### Environment Variable Priority
For API configuration, the resolution order is:
1. `customApiStorage` (persisted user configuration)
2. Environment variables (`DOGE_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`)
3. Default values (empty strings or Anthropic defaults)

For context window detection, the resolution order is:
1. `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` - Universal override (any user)
2. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` - Ant-only override
3. Hardcoded third-party model configurations (DeepSeek, GLM, Gemini, GPT-4)
4. `[1m]` suffix in model name
5. `modelCapabilities` API detection (first-party only)
6. Beta headers
7. Default: 200k

### Context Window Configuration (Added 2026-04-07)

**Problem**: Third-party models were incorrectly detected as having 200k context, causing auto-compact to trigger too late.

**Solution**: Two-layer approach for accurate context window detection:

#### Layer 1: Hardcoded Third-Party Models
The following models are automatically detected with correct context windows:

| Model Pattern | Context Window | Match Rule |
|--------------|----------------|------------|
| `deepseek-*` | 102.4k | Contains "deepseek" |
| `glm-4`, `glm4` | 128k | Contains "glm-4" or "glm4" |
| `gemini-1.5-*`, `gemini-2.0-*` | 1M | Contains "gemini-1.5" or "gemini-2.0" |
| `gpt-4-turbo`, `gpt-4o` | 128k | Contains "gpt-4-turbo" or "gpt-4o" |
| `gpt-3.5-turbo-16k` | 16k | Contains "gpt-3.5-turbo-16k" |
| `gpt-3.5-turbo` | 4k | Contains "gpt-3.5-turbo" |

#### Layer 2: Environment Variable Override
For models not in the hardcoded list, or to override hardcoded values:

```powershell
# Set custom context window (in tokens)
$env:CLAUDE_CODE_MODEL_CONTEXT_WINDOW = "128000"
```

**Auto-Compact Calculation**:
```
Effective Window = Context Window - 20k (output reserve)
Auto-Compact Threshold = Effective Window - 13k (buffer)
```

Example for DeepSeek (128k):
```
Effective Window = 128k - 20k = 108k
Auto-Compact Threshold = 108k - 13k = 95k
→ Auto-compact triggers when conversation exceeds 95k tokens
```

**Verification**: Check logs for `autocompact:` messages:
```
autocompact: tokens=95000 threshold=95000 effectiveWindow=108000
```

**Related Files**:
- `src/utils/context.ts` - Context window detection logic (modified)
- `src/services/compact/autoCompact.ts` - Auto-compact threshold calculation
- `debug_updates.md` - Detailed bug fix documentation and code changes

### Provider-Specific Behaviors
- **DeepSeek**: Automatically limits `max_tokens` to 8192 (supports 128k context, 8192 output)
- **Anthropic Native**: Uses official SDK with `/messages` endpoint
- **OpenAI Format**: Translates to `/v1/chat/completions` with bidirectional event conversion
- **Responses Format**: Translates to `/v1/responses` with custom event mapping