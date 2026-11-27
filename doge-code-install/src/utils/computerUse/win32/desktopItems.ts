import { runPowerShell } from './powerShell.js'
import type { InstalledApp } from '../platforms/types.js'

// Windows PowerShell's -Command transport can corrupt non-ASCII source text.
const localizedShortcutSuffix = Buffer.from(' - 快捷方式.lnk', 'utf8').toString('base64')

/** Resolve a literal Desktop item or an absolute shortcut to its executable.
 * The link itself is never executed and cannot supply launch arguments. */
export async function resolveDesktopApp(reference: string, signal?: AbortSignal): Promise<InstalledApp | undefined> {
  const input = Buffer.from(reference, 'utf8').toString('base64')
  const output = await runPowerShell(String.raw`
$ref = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}'))
$ref = $ref.Replace('/', '\')
if ($ref.StartsWith('Desktop\', [StringComparison]::OrdinalIgnoreCase)) {
    $relative = $ref.Substring(8)
    $parts = $relative.Split('\')
    foreach ($part in $parts) {
        if (!$part -or $part -in '.', '..' -or $part.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or $part -match '[ .]$') { return }
    }
    $leaf = $parts[-1]
    $root = [Environment]::GetFolderPath('DesktopDirectory')
    if (!$root) { return }
    $paths = @((Join-Path $root $relative))
    if ($leaf -notmatch '\.(lnk|exe)$') {
        $suffix = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${localizedShortcutSuffix}'))
        $paths = @("$($paths[0]).lnk", "$($paths[0]).exe", "$($paths[0]) - Shortcut.lnk", "$($paths[0])$suffix")
    }
    $items = @($paths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    if ($items.Count -ne 1) { return }
    $ref = $items[0]
} elseif ($ref -notmatch '^[A-Za-z]:\\.+\.lnk$' -or !(Test-Path -LiteralPath $ref -PathType Leaf)) { return }

$target = $ref
if ($ref.EndsWith('.lnk', [StringComparison]::OrdinalIgnoreCase)) {
    $shell = New-Object -ComObject WScript.Shell
    try { $link = $shell.CreateShortcut($ref) } catch { return }
    if ($link.Arguments -and $link.Arguments.Trim()) { return }
    $target = $link.TargetPath
}
if ($target -notmatch '^[A-Za-z]:\\.+\.exe$' -or !(Test-Path -LiteralPath $target -PathType Leaf)) { return }
try { $path = (Get-Item -LiteralPath $target).FullName } catch { return }
(ConvertTo-Json -Compress @{ bundleId = $path; path = $path; displayName = [IO.Path]::GetFileName($path) })
`, 8_000, undefined, signal)
  return output ? JSON.parse(output) as InstalledApp : undefined
}

