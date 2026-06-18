# Sync current environment variables to claude-to-im config.env
# Usage: After running start_*.ps1, run this script to sync API config to claude-to-im

$configPath = "$env:USERPROFILE\.claude-to-im\config.env"

if (-not (Test-Path $configPath)) {
    Write-Host "Error: $configPath not found" -ForegroundColor Red
    Write-Host "Please ensure claude-to-im is installed first." -ForegroundColor Yellow
    exit 1
}

Write-Host "Syncing API configuration to claude-to-im..." -ForegroundColor Cyan

# Read existing config
$lines = Get-Content $configPath

# Determine which API key to use (only one should be set)
$useDogeKey = $false
$useAuthToken = $false

if ($env:DOGE_API_KEY -and $env:DOGE_API_KEY -ne "") {
    $useDogeKey = $true
}
if ($env:ANTHROPIC_AUTH_TOKEN -and $env:ANTHROPIC_AUTH_TOKEN -ne "") {
    $useAuthToken = $true
}

# Build new config
$newLines = @()
$foundApiSection = $false

foreach ($line in $lines) {
    # Detect API Configuration section
    if ($line -match '^#.*API Configuration') {
        $foundApiSection = $true
        $newLines += $line
        continue
    }

    # Handle API-related lines
    if ($line -match '^ANTHROPIC_BASE_URL=') {
        if ($env:ANTHROPIC_BASE_URL) {
            $newLines += "ANTHROPIC_BASE_URL=$env:ANTHROPIC_BASE_URL"
        } else {
            $newLines += $line
        }
    }
    elseif ($line -match '^DOGE_API_KEY=') {
        if ($useDogeKey) {
            $newLines += "DOGE_API_KEY=$env:DOGE_API_KEY"
        } elseif ($useAuthToken) {
            # Clear DOGE_API_KEY when using AUTH_TOKEN
            $newLines += "DOGE_API_KEY="
        } else {
            $newLines += $line
        }
    }
    elseif ($line -match '^ANTHROPIC_AUTH_TOKEN=') {
        if ($useAuthToken) {
            $newLines += "ANTHROPIC_AUTH_TOKEN=$env:ANTHROPIC_AUTH_TOKEN"
        } elseif ($useDogeKey) {
            # Clear AUTH_TOKEN when using DOGE_API_KEY
            $newLines += "ANTHROPIC_AUTH_TOKEN="
        } else {
            $newLines += $line
        }
    }
    elseif ($line -match '^ANTHROPIC_MODEL=') {
        if ($env:ANTHROPIC_MODEL) {
            $newLines += "ANTHROPIC_MODEL=$env:ANTHROPIC_MODEL"
        } else {
            $newLines += $line
        }
    }
    elseif ($line -match '^CLAUDE_CODE_COMPATIBLE_API_PROVIDER=') {
        if ($env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER) {
            $newLines += "CLAUDE_CODE_COMPATIBLE_API_PROVIDER=$env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER"
        } else {
            $newLines += $line
        }
    }
    elseif ($line -match '^CLAUDE_CODE_MODEL_CONTEXT_WINDOW=') {
        if ($env:CLAUDE_CODE_MODEL_CONTEXT_WINDOW) {
            $newLines += "CLAUDE_CODE_MODEL_CONTEXT_WINDOW=$env:CLAUDE_CODE_MODEL_CONTEXT_WINDOW"
        } else {
            $newLines += $line
        }
    }
    elseif ($line -match '^CTI_DEFAULT_MODEL=') {
        if ($env:ANTHROPIC_MODEL) {
            $newLines += "CTI_DEFAULT_MODEL=$env:ANTHROPIC_MODEL"
        } else {
            $newLines += $line
        }
    }
    else {
        $newLines += $line
    }
}

# Write back to config.env
$newLines | Set-Content $configPath -Encoding UTF8

Write-Host "✓ API configuration synced successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Updated values:" -ForegroundColor Cyan
Write-Host "  ANTHROPIC_BASE_URL: $env:ANTHROPIC_BASE_URL"

if ($useDogeKey) {
    $maskedKey = '***' + $env:DOGE_API_KEY.Substring([Math]::Max(0, $env:DOGE_API_KEY.Length - 4))
    Write-Host "  DOGE_API_KEY: $maskedKey" -ForegroundColor Green
    Write-Host "  ANTHROPIC_AUTH_TOKEN: (cleared)" -ForegroundColor DarkGray
} elseif ($useAuthToken) {
    $maskedToken = '***' + $env:ANTHROPIC_AUTH_TOKEN.Substring([Math]::Max(0, $env:ANTHROPIC_AUTH_TOKEN.Length - 4))
    Write-Host "  DOGE_API_KEY: (cleared)" -ForegroundColor DarkGray
    Write-Host "  ANTHROPIC_AUTH_TOKEN: $maskedToken" -ForegroundColor Green
} else {
    Write-Host "  DOGE_API_KEY: (not set)" -ForegroundColor Yellow
    Write-Host "  ANTHROPIC_AUTH_TOKEN: (not set)" -ForegroundColor Yellow
}

Write-Host "  ANTHROPIC_MODEL: $env:ANTHROPIC_MODEL"
Write-Host "  CLAUDE_CODE_COMPATIBLE_API_PROVIDER: $env:CLAUDE_CODE_COMPATIBLE_API_PROVIDER"
Write-Host "  CLAUDE_CODE_MODEL_CONTEXT_WINDOW: $env:CLAUDE_CODE_MODEL_CONTEXT_WINDOW"
Write-Host ""
Write-Host "Run '/claude-to-im restart' to apply changes." -ForegroundColor Yellow

