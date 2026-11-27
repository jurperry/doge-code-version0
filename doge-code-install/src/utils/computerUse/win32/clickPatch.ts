import type { CropRawPatchFn } from '@ant/computer-use-mcp'
import { runPowerShell } from './powerShell.js'

/** Decode the small JPEG patch using Windows' image decoder in memory. */
export const cropWindowsClickPatch: CropRawPatchFn = async (jpegBase64, { x, y, width, height }) => {
  const encoded = await runPowerShell(`
Add-Type -AssemblyName System.Drawing
$jpeg = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$stream = [System.IO.MemoryStream]::new($jpeg)
$bitmap = $null
try {
    $bitmap = [System.Drawing.Bitmap]::new($stream)
    $patch = New-Object byte[] (${width} * ${height} * 3)
    $index = 0
    for ($y = ${y}; $y -lt ${y + height}; $y++) {
        for ($x = ${x}; $x -lt ${x + width}; $x++) {
            $pixel = $bitmap.GetPixel($x, $y)
            $patch[$index++] = $pixel.R
            $patch[$index++] = $pixel.G
            $patch[$index++] = $pixel.B
        }
    }
    [Convert]::ToBase64String($patch)
} finally {
    if ($bitmap) { $bitmap.Dispose() }
    $stream.Dispose()
}
`, 5000, jpegBase64)
  return encoded ? Buffer.from(encoded, 'base64') : null
}
