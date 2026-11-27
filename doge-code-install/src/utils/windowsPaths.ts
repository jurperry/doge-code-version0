import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import * as path from 'path'
import * as pathWin32 from 'path/win32'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { execSync_DEPRECATED } from './execSyncWrapper.js'
import { memoizeWithLRU } from './memoize.js'
import { getPlatform } from './platform.js'

/**
 * Check if a file or directory exists on Windows using the dir command
 * @param path - The path to check
 * @returns true if the path exists, false otherwise
 */
function checkPathExists(path: string): boolean {
  try {
    execSync_DEPRECATED(`dir "${path}"`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * Find an executable using where.exe on Windows
 * @param executable - The name of the executable to find
 * @returns The path to the executable or null if not found
 */
function findExecutable(executable: string): string | null {
  // For git, check common installation locations first
  if (executable === 'git') {
    const defaultLocations = [
      // check 64 bit before 32 bit
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
      // intentionally don't look for C:\Program Files\Git\mingw64\bin\git.exe
      // because that directory is the "raw" tools with no environment setup
    ]

    for (const location of defaultLocations) {
      if (checkPathExists(location)) {
        return location
      }
    }
  }

  // Fall back to where.exe
  try {
    const result = execSync_DEPRECATED(`where.exe ${executable}`, {
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim()

    // SECURITY: Filter out any results from the current directory
    // to prevent executing malicious git.bat/cmd/exe files
    const paths = result.split('\r\n').filter(Boolean)
    const cwd = getCwd().toLowerCase()

    for (const candidatePath of paths) {
      // Normalize and compare paths to ensure we're not in current directory
      const normalizedPath = path.resolve(candidatePath).toLowerCase()
      const pathDir = path.dirname(normalizedPath).toLowerCase()

      // Skip if the executable is in the current working directory
      if (pathDir === cwd || normalizedPath.startsWith(cwd + path.sep)) {
        logForDebugging(
          `Skipping potentially malicious executable in current directory: ${candidatePath}`,
        )
        continue
      }

      // Return the first valid path that's not in the current directory
      return candidatePath
    }

    return null
  } catch {
    return null
  }
}

/**
 * Read GitForWindows' InstallPath from the registry (HKLM or HKCU).
 * Returns null on any failure — reg.exe missing, key absent, parse hiccup.
 */
function queryGitInstallPathFromRegistry(hive: 'HKLM' | 'HKCU'): string | null {
  try {
    const out = execSync_DEPRECATED(
      `reg query "${hive}\\SOFTWARE\\GitForWindows" /v InstallPath`,
      { stdio: 'pipe', encoding: 'utf8' },
    )
    // Output line looks like: `    InstallPath    REG_SZ    C:\Program Files\Git`
    const match = out.match(/^\s*InstallPath\s+REG_SZ\s+(.+?)\s*$/m)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * Non-exiting sibling of findGitBashPath(): locate git-bash's bash.exe,
 * returning null instead of killing the process when it isn't there.
 * Probe order:
 *   1. CLAUDE_CODE_GIT_BASH_PATH env (invalid value is skipped with a log,
 *      not fatal — findGitBashPath keeps the strict exit semantics)
 *   2. Registry InstallPath (HKLM then HKCU) + \bin\bash.exe
 *   3. git on PATH → ../../bin/bash.exe
 *   4. Well-known install dirs (Program Files, Program Files (x86),
 *      %LocalAppData%\Programs\Git, scoop)
 *
 * Memoized per CLAUDE_CODE_GIT_BASH_PATH value so tests flipping the env
 * get a fresh probe; the registry/where.exe hits only run once per value.
 */
export const probeGitBashPath = memoize(
  (): string | null => {
    if (getPlatform() !== 'windows') return null

    const envPath = process.env.CLAUDE_CODE_GIT_BASH_PATH
    if (envPath) {
      if (checkPathExists(envPath)) {
        return envPath
      }
      logForDebugging(
        `CLAUDE_CODE_GIT_BASH_PATH "${envPath}" does not exist; probing other locations`,
      )
    }

    for (const hive of ['HKLM', 'HKCU'] as const) {
      const installPath = queryGitInstallPathFromRegistry(hive)
      if (installPath) {
        const bashPath = pathWin32.join(installPath, 'bin', 'bash.exe')
        if (checkPathExists(bashPath)) {
          return bashPath
        }
      }
    }

    const gitPath = findExecutable('git')
    if (gitPath) {
      const bashPath = pathWin32.join(gitPath, '..', '..', 'bin', 'bash.exe')
      if (checkPathExists(bashPath)) {
        return bashPath
      }
    }

    const candidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      process.env.LOCALAPPDATA
        ? pathWin32.join(
            process.env.LOCALAPPDATA,
            'Programs',
            'Git',
            'bin',
            'bash.exe',
          )
        : null,
      pathWin32.join(homedir(), 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
    ]
    for (const candidate of candidates) {
      if (candidate && checkPathExists(candidate)) {
        return candidate
      }
    }

    return null
  },
  () => process.env.CLAUDE_CODE_GIT_BASH_PATH ?? '',
)

/**
 * If Windows, set the SHELL environment variable to git-bash path.
 * This is used by BashTool and Shell.ts for user shell commands.
 * COMSPEC is left unchanged for system process execution.
 *
 * When git-bash is absent the historical behavior is a hard exit — except
 * when the user selected defaultShell: 'powershell', in which case the
 * model gets PowerShellTool instead of BashTool and the CLI must still
 * start. SHELL stays unset then; bash hooks fail gracefully per-hook.
 */
export function setShellIfWindows(): void {
  if (getPlatform() !== 'windows') return
  const gitBashPath = probeGitBashPath()
  if (gitBashPath) {
    process.env.SHELL = gitBashPath
    logForDebugging(`Using bash path: "${gitBashPath}"`)
    return
  }
  // Lazy require: windowsPaths is imported by very early/low-level modules;
  // pulling settings.ts in statically here risks import cycles.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { resolveDefaultShell } =
    require('./shell/resolveDefaultShell.js') as typeof import('./shell/resolveDefaultShell.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  if (resolveDefaultShell() === 'powershell') {
    logForDebugging(
      'git-bash not found; continuing without SHELL because defaultShell is powershell',
    )
    return
  }
  // Bash-default without git-bash: keep the original error + exit(1).
  findGitBashPath()
}

/**
 * Find the path where `bash.exe` included with git-bash exists, exiting the process if not found.
 */
export const findGitBashPath = memoize((): string => {
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    if (checkPathExists(process.env.CLAUDE_CODE_GIT_BASH_PATH)) {
      return process.env.CLAUDE_CODE_GIT_BASH_PATH
    }
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      `Claude Code was unable to find CLAUDE_CODE_GIT_BASH_PATH path "${process.env.CLAUDE_CODE_GIT_BASH_PATH}"`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  const gitPath = findExecutable('git')
  if (gitPath) {
    const bashPath = pathWin32.join(gitPath, '..', '..', 'bin', 'bash.exe')
    if (checkPathExists(bashPath)) {
      return bashPath
    }
  }

  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.error(
    'Claude Code on Windows requires git-bash (https://git-scm.com/downloads/win). If installed but not in PATH, set environment variable pointing to your bash.exe, similar to: CLAUDE_CODE_GIT_BASH_PATH=C:\\Program Files\\Git\\bin\\bash.exe',
  )
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
})

/** Convert a Windows path to a POSIX path using pure JS. */
export const windowsPathToPosixPath = memoizeWithLRU(
  (windowsPath: string): string => {
    // Handle UNC paths: \\server\share -> //server/share
    if (windowsPath.startsWith('\\\\')) {
      return windowsPath.replace(/\\/g, '/')
    }
    // Handle drive letter paths: C:\Users\foo -> /c/Users/foo
    const match = windowsPath.match(/^([A-Za-z]):[/\\]/)
    if (match) {
      const driveLetter = match[1]!.toLowerCase()
      return '/' + driveLetter + windowsPath.slice(2).replace(/\\/g, '/')
    }
    // Already POSIX or relative — just flip slashes
    return windowsPath.replace(/\\/g, '/')
  },
  (p: string) => p,
  500,
)

/** Convert a POSIX path to a Windows path using pure JS. */
export const posixPathToWindowsPath = memoizeWithLRU(
  (posixPath: string): string => {
    // Handle UNC paths: //server/share -> \\server\share
    if (posixPath.startsWith('//')) {
      return posixPath.replace(/\//g, '\\')
    }
    // Handle /cygdrive/c/... format
    const cygdriveMatch = posixPath.match(/^\/cygdrive\/([A-Za-z])(\/|$)/)
    if (cygdriveMatch) {
      const driveLetter = cygdriveMatch[1]!.toUpperCase()
      const rest = posixPath.slice(('/cygdrive/' + cygdriveMatch[1]).length)
      return driveLetter + ':' + (rest || '\\').replace(/\//g, '\\')
    }
    // Handle /c/... format (MSYS2/Git Bash)
    const driveMatch = posixPath.match(/^\/([A-Za-z])(\/|$)/)
    if (driveMatch) {
      const driveLetter = driveMatch[1]!.toUpperCase()
      const rest = posixPath.slice(2)
      return driveLetter + ':' + (rest || '\\').replace(/\//g, '\\')
    }
    // Already Windows or relative — just flip slashes
    return posixPath.replace(/\//g, '\\')
  },
  (p: string) => p,
  500,
)
