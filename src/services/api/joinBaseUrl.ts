/** Append an operation to the configured API root, preserving its query. */
export function joinBaseUrl(baseURL: string, operation: string): string {
  if (!baseURL?.trim()) throw new Error('Base URL is required for this API format')
  const url = new URL(baseURL)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${operation}`
  return url.href
}
