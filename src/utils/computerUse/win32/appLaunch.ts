export function buildPortableAppLaunchBlock(pathExpression = '$target'): string {
  return `$cuLaunchExe = (Resolve-Path -LiteralPath ${pathExpression}).Path
$proc = Start-CuApplication $cuLaunchExe (Split-Path -Parent $cuLaunchExe)
$launchPath = $cuLaunchExe`
}
export const START_CU_APPLICATION = `
function Start-CuApplication($file, $directory) {
    try {
        $startOptions = @{ FilePath = $file; PassThru = $true; ErrorAction = 'Stop' }
        if ($directory) { $startOptions.WorkingDirectory = $directory }
        Start-Process @startOptions
    } catch {
        for ($cause = $_.Exception; $cause; $cause = $cause.InnerException) {
            if ($cause -is [System.ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 1223) {
                throw 'Windows cancelled the launch. The user may have declined the UAC prompt. Ask before retrying.'
            }
        }
    }
}
`
