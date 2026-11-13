export function buildPortableAppLaunchBlock(pathExpression = '$target'): string {
  return `$cuLaunchExe = (Resolve-Path -LiteralPath ${pathExpression}).Path
$proc = Start-Process -FilePath $cuLaunchExe -WorkingDirectory (Split-Path -Parent $cuLaunchExe) -PassThru -ErrorAction SilentlyContinue
$launchPath = $cuLaunchExe`
}
