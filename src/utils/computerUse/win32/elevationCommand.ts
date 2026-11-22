import { stopPermanentElevationBroker, verifyPermanentElevation } from './elevatedPowerShell.js'
import {
  disablePermanentElevation,
  enablePermanentElevation,
  getPermanentElevationStatus,
} from './permanentElevation.js'

export async function runComputerUseElevationCommand(args: string[]): Promise<void> {
  const action = args[0] ?? 'status'
  try {
    let status
    switch (action) {
      case 'status':
        status = getPermanentElevationStatus()
        break
      case 'enable':
        await enablePermanentElevation()
        await verifyPermanentElevation()
        status = getPermanentElevationStatus()
        break
      case 'stop':
        await stopPermanentElevationBroker()
        status = getPermanentElevationStatus()
        break
      case 'disable':
        status = await disablePermanentElevation()
        break
      default:
        throw new Error(`Unknown Computer Use elevation command: ${action}`)
    }
    // biome-ignore lint/suspicious/noConsole: internal CLI JSON response
    console.log(JSON.stringify({ ok: true, status }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const cancelled = message.includes('[CU_PERMANENT_ELEVATION_CANCELLED]')
    let status
    try { status = getPermanentElevationStatus() } catch {}
    // biome-ignore lint/suspicious/noConsole: internal CLI JSON response
    console.log(JSON.stringify({
      ok: false,
      code: cancelled ? 'cancelled' : 'failed',
      error: cancelled ? 'Windows elevation was cancelled.' : message,
      status,
    }))
    process.exitCode = 1
  }
}
