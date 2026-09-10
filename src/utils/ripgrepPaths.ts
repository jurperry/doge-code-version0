import * as path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)

/**
 * Candidate locations for the vendored ripgrep binary, in priority order.
 *
 * Running from a checkout, vendor/ripgrep sits next to this module (src/utils)
 * and that candidate resolves on real disk. Running a `bun build --compile`
 * executable, import.meta.url points into Bun's virtual mount (B:\~BUN\root\),
 * so the module-relative candidate is unreachable — the binary must instead
 * be staged next to the executable itself (scripts/build-cli.mjs copies it to
 * build/bin/vendor/ripgrep/<arch>/; the desktop shell ships the same layout as
 * resources/cli/vendor/ripgrep/). An env override covers unusual deployments.
 */
export function builtinRipgrepCandidates(opts?: {
  exePath?: string
  moduleDir?: string
  override?: string
}): string[] {
  const exePath = opts?.exePath ?? process.execPath
  const moduleDir = opts?.moduleDir ?? path.join(__filename, '../')
  const archDir =
    process.platform === 'win32'
      ? `${process.arch}-win32`
      : `${process.arch}-${process.platform}`
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const candidates: string[] = []
  const override = opts?.override ?? process.env.DOGE_RIPGREP_PATH
  if (override) candidates.push(path.resolve(override))
  candidates.push(
    path.resolve(path.dirname(exePath), 'vendor', 'ripgrep', archDir, binary),
  )
  candidates.push(path.resolve(moduleDir, 'vendor', 'ripgrep', archDir, binary))
  return candidates
}
