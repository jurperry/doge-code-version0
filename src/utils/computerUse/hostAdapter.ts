import type {
  ComputerUseHostAdapter,
  Logger,
} from '@ant/computer-use-mcp/types'
import { format } from 'util'
import { logForDebugging } from '../debug.js'
import { persistBinaryContent } from '../mcpOutputStorage.js'
import { COMPUTER_USE_MCP_SERVER_NAME } from './common.js'
import { createCliExecutor } from './executor.js'
import { getChicagoEnabled, getChicagoSubGates } from './gates.js'
import { requireComputerUseSwift } from './swiftLoader.js'
import { cropWindowsClickPatch } from './win32/clickPatch.js'

class DebugLogger implements Logger {
  silly(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'debug' })
  }
  debug(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'debug' })
  }
  info(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'info' })
  }
  warn(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'warn' })
  }
  error(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'error' })
  }
}

let cached: ComputerUseHostAdapter | undefined

/**
 * Process-lifetime singleton. Built once on first CU tool call; native modules
 * (both `@ant/computer-use-input` and `@ant/computer-use-swift`) are loaded
 * here via the executor factory, which throws on load failure — there is no
 * degraded mode.
 */
export function getComputerUseHostAdapter(): ComputerUseHostAdapter {
  if (cached) return cached
  cached = {
    serverName: COMPUTER_USE_MCP_SERVER_NAME,
    logger: new DebugLogger(),
    executor: createCliExecutor({
      getMouseAnimationEnabled: () => getChicagoSubGates().mouseAnimation,
      getHideBeforeActionEnabled: () => getChicagoSubGates().hideBeforeAction,
    }),
    ensureOsPermissions: async () => {
      if (process.platform === 'darwin') {
        const cu = requireComputerUseSwift()
        const accessibility = (cu as any).tcc.checkAccessibility()
        const screenRecording = (cu as any).tcc.checkScreenRecording()
        return accessibility && screenRecording
          ? { granted: true }
          : { granted: false, accessibility, screenRecording }
      }

      // Windows: no TCC system — always grant at this level.
      // UIPI/elevation checks happen per-operation in platforms/win32.ts
      // via ensureSendAccess() fallback. Blocking here would trigger the
      // macOS TCC panel in toolCalls.ts, which is useless on Windows.
      if (process.platform === 'win32') {
        return { granted: true }
      }

      // Linux: no permission system needed
      return { granted: true }
    },
    isDisabled: () => !getChicagoEnabled(),
    getSubGates: getChicagoSubGates,
    // cleanup.ts always unhides at turn end — no user preference to disable it.
    getAutoUnhideEnabled: () => true,
    saveImageToDisk: async (base64, mimeType, persistId) => {
      const result = await persistBinaryContent(
        Buffer.from(base64, 'base64'),
        mimeType,
        persistId,
      )
      if ('error' in result) throw new Error(result.error)
      return result.filepath
    },

    cropRawPatch: process.platform === 'win32' ? cropWindowsClickPatch : () => null,
  }
  return cached
}
