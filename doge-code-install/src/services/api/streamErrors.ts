import { APIError } from '@anthropic-ai/sdk'

/** HTTP 200 can still contain a provider error; keep its semantic status. */
export function streamAPIError(payload: any, headers?: Headers): APIError {
  const detail = payload?.response?.error ?? payload?.error ?? payload ?? {}
  const kind = `${detail.type ?? ''} ${detail.code ?? ''}`.toLowerCase()
  const explicit = Number(detail.status ?? detail.status_code ?? payload?.status)
  let status = Number.isInteger(explicit) && explicit >= 400 && explicit <= 599 ? explicit : 400
  if (!Number.isInteger(explicit) || explicit < 400 || explicit > 599) {
    if (/auth|api_key|unauthorized/.test(kind)) status = 401
    else if (/permission|forbidden|access_denied/.test(kind)) status = 403
    else if (/rate_limit|too_many_requests/.test(kind)) status = 429
    else if (/overload/.test(kind)) status = 529
    else if (/server_error|internal_error|api_error|service_unavailable/.test(kind)) status = 503
    else if (/timeout/.test(kind)) status = 408
  }
  return new APIError(status, undefined, typeof detail.message === 'string' ? detail.message : `Provider stream error: ${kind.trim() || 'invalid response'}`, headers ?? new Headers())
}
